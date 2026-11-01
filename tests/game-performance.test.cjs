"use strict";

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { EventEmitter, once } = require("node:events");
const { spawn, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { createHash } = require("node:crypto");
const {
  createGamePerformanceService,
} = require("../electron/game-performance.cjs");
const {
  buildPerformanceMonitor,
} = require("../scripts/build-performance-monitor.cjs");

const execute = promisify(execFile);
const monitorPath = path.resolve(
  __dirname,
  "../assets/game-performance-monitor.exe",
);
const fixedNow = Date.parse("2026-10-30T04:00:00.000Z");
const temporaryRoots = [];
let replayPromise;

async function removeOwned(directory) {
  assert.equal(path.dirname(directory), os.tmpdir());
  assert.ok(path.basename(directory).startsWith("ironclad-performance-"));
  await fs.rm(directory, {
    recursive: true,
    force: true,
    maxRetries: 8,
    retryDelay: 75,
  });
}

after(async () => {
  for (const directory of temporaryRoots) await removeOwned(directory);
});

async function replayMonitor() {
  if (!replayPromise)
    replayPromise = (async () => {
      const directory = await fs.mkdtemp(
        path.join(os.tmpdir(), "ironclad-performance-replay-"),
      );
      temporaryRoots.push(directory);
      return buildPerformanceMonitor({
        outputPath: path.join(directory, "replay.exe"),
        additionalSources: [
          path.join(__dirname, "fixtures/performance/replay-monitor.cs"),
        ],
        mainType: "PerformanceMonitorReplayFixture",
        target: "exe",
      });
    })();
  return replayPromise;
}

async function fixture(t, overrides = {}) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "ironclad-performance-test-"),
  );
  t.after(() => removeOwned(root));
  const storage = path.join(root, "stats");
  const spawns = [];
  const options = {
    storageDirectory: storage,
    monitorPath,
    platform: "win32",
    now: () => fixedNow,
    spawnProcess: (command, args, spawnOptions) => {
      const child = new EventEmitter();
      child.unref = () => {
        child.unreferenced = true;
      };
      spawns.push({ command, args, options: spawnOptions, child });
      queueMicrotask(() => child.emit("spawn"));
      return child;
    },
    ...overrides,
  };
  const input = {
    pid: 123456,
    launchedAt: new Date(fixedNow).toISOString(),
    executable: process.execPath,
    gameVersion: "1.19.4.0",
    instanceId: "default",
    instanceName: "默认实例",
    playsetId: "fixture",
    playsetName: "隔离播放集",
    modCount: 12,
    launchMode: "normal",
  };
  const service = createGamePerformanceService(options);
  const directory = (id) => path.join(storage, "sessions", id);
  const json = async (file) => JSON.parse(await fs.readFile(file, "utf8"));
  const write = async (file, value) => {
    await fs.writeFile(
      file,
      typeof value === "string" ? value : JSON.stringify(value) + "\n",
      "utf8",
    );
  };
  return {
    root,
    storage,
    options,
    input,
    service,
    spawns,
    directory,
    json,
    write,
  };
}

async function until(predicate, message, timeout = 12000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("Timed out: " + message);
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

async function replay(t, scenario) {
  const f = await fixture(t);
  const session = await f.service.startSession(f.input);
  await execute(await replayMonitor(), [f.directory(session.id), scenario], {
    windowsHide: true,
    timeout: 15000,
  });
  return { ...f, session, detail: await f.service.getSession(session.id) };
}

test("statistics reads default to enabled without creating storage or starting a collector", async (t) => {
  const f = await fixture(t);
  const state = await f.service.getState();
  assert.equal(state.enabled, true);
  assert.equal(state.supported, true);
  assert.equal(state.intervalMs, 5000);
  assert.deepEqual(state.sessions, []);
  assert.equal(state.notice, null);
  assert.equal(f.spawns.length, 0);
  await assert.rejects(fs.stat(f.storage), { code: "ENOENT" });
});

test("the opt-out persists and changes only future sessions without spawning or deleting history", async (t) => {
  const f = await fixture(t);
  const recording = await f.service.startSession(f.input);
  await f.service.setEnabled(false);
  assert.equal(await f.service.startSession(f.input), null);
  assert.equal(f.spawns.length, 1);
  assert.equal((await f.service.getSession(recording.id)).status, "recording");
  const reopened = createGamePerformanceService(f.options);
  assert.equal((await reopened.getState()).enabled, false);
  await assert.rejects(reopened.setEnabled("true"), /preference/);
  assert.equal((await reopened.getState()).enabled, false);
  await reopened.setEnabled(true);
  assert.equal((await reopened.getState()).sessions.length, 1);
  assert.equal(f.spawns.length, 1);
});

test("the collector receives only an owned configuration path and detached hidden launch options", async (t) => {
  const f = await fixture(t);
  const session = await f.service.startSession(f.input);
  assert.equal(session.status, "recording");
  assert.equal(session.cpuAveragePercent, null);
  assert.equal(session.memoryAverageBytes, null);
  const spawned = f.spawns[0];
  const sourceBytes = await fs.readFile(monitorPath);
  const hash = createHash("sha256").update(sourceBytes).digest("hex");
  assert.equal(
    spawned.command,
    path.join(f.storage, "monitors", hash + ".exe"),
  );
  assert.deepEqual(await fs.readFile(spawned.command), sourceBytes);
  assert.deepEqual(spawned.args, [
    path.join(f.directory(session.id), "session.json"),
  ]);
  assert.deepEqual(spawned.options, {
    detached: true,
    windowsHide: true,
    stdio: "ignore",
  });
  assert.equal(spawned.child.unreferenced, true);
  const config = await f.json(spawned.args[0]);
  assert.equal(config.pid, f.input.pid);
  assert.equal(config.intervalMs, 5000);
  assert.equal(config.executable, process.execPath);
  assert.equal(config.session.playsetName, "隔离播放集");
  assert.equal(Object.hasOwn(session, "executable"), false);
});

test("the persistent monitor cache is reused without rewriting an existing version", async (t) => {
  const f = await fixture(t);
  await f.service.startSession(f.input);
  const cached = f.spawns[0].command;
  const retained = new Date("2000-01-01T00:00:00.000Z");
  await fs.utimes(cached, retained, retained);
  const before = await fs.stat(cached);
  await f.service.startSession(f.input);
  const after = await fs.stat(cached);
  assert.equal(f.spawns[1].command, cached);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(after.ino, before.ino);
  assert.equal((await fs.readdir(path.join(f.storage, "monitors"))).length, 1);
});

test("a modified cached monitor is preserved and cannot be executed or repaired implicitly", async (t) => {
  const f = await fixture(t);
  await f.service.startSession(f.input);
  const cached = f.spawns[0].command;
  await fs.writeFile(cached, "changed monitor bytes");
  const failed = await f.service.startSession(f.input);
  assert.equal(failed.status, "unavailable");
  assert.equal(failed.failureReason, "monitor-cache-invalid");
  assert.equal(f.spawns.length, 1);
  assert.equal(await fs.readFile(cached, "utf8"), "changed monitor bytes");
});

test("a linked cached monitor is rejected without executing or overwriting either file", async (t) => {
  const f = await fixture(t);
  await f.service.startSession(f.input);
  const cached = f.spawns[0].command;
  const outside = path.join(f.root, "outside-monitor.exe");
  await fs.copyFile(monitorPath, outside);
  const original = await fs.readFile(outside);
  await fs.unlink(cached);
  await fs.link(outside, cached);
  const failed = await f.service.startSession(f.input);
  assert.equal(failed.status, "unavailable");
  assert.equal(failed.failureReason, "monitor-cache-invalid");
  assert.equal(f.spawns.length, 1);
  assert.deepEqual(await fs.readFile(outside), original);
  assert.equal((await fs.stat(cached)).nlink, 2);
});

test("collector spawn failure becomes an unavailable record and never affects another process", async (t) => {
  const f = await fixture(t, {
    spawnProcess: () => {
      const child = new EventEmitter();
      queueMicrotask(() =>
        child.emit(
          "error",
          Object.assign(new Error("fixture spawn failure"), { code: "EACCES" }),
        ),
      );
      return child;
    },
  });
  const session = await f.service.startSession(f.input);
  assert.equal(session.status, "unavailable");
  assert.equal(session.failureReason, "monitor-start-failed");
  assert.equal(session.sampleCount, 0);
  assert.equal(
    (await f.service.getState()).notice,
    "性能采集启动失败，本次游戏仍可正常运行。",
  );
  assert.equal((await f.service.getState()).sessions.length, 1);
});

test("missing collectors and unsupported platforms are reported without false performance values", async (t) => {
  const f = await fixture(t, {
    monitorPath: path.join(os.tmpdir(), "not-a-performance-monitor.exe"),
  });
  assert.equal((await f.service.getState()).supported, false);
  const session = await f.service.startSession(f.input);
  assert.equal(session.status, "unavailable");
  assert.equal(session.cpuPeakPercent, null);
  assert.equal(f.spawns.length, 0);
  const unsupported = createGamePerformanceService({
    ...f.options,
    platform: "linux",
  });
  assert.equal((await unsupported.getState()).supported, false);
});

test("invalid targets and renderer IDs cannot select paths outside session storage", async (t) => {
  const f = await fixture(t);
  for (const id of [
    "../settings.json",
    "..\\account.session",
    "",
    null,
    1,
    "constructor",
  ])
    assert.equal(await f.service.getSession(id), null);
  for (const input of [
    null,
    {},
    { ...f.input, pid: -1 },
    { ...f.input, executable: "relative.exe" },
    { ...f.input, modCount: Infinity },
  ])
    await assert.rejects(f.service.startSession(input));
  assert.equal(f.spawns.length, 0);
  await assert.rejects(fs.stat(f.storage), { code: "ENOENT" });
});

test("malformed preferences are preserved and do not silently re-enable collection", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(f.storage);
  const source = '{"schemaVersion":1,"enabled":';
  await f.write(path.join(f.storage, "settings.json"), source);
  assert.equal((await f.service.getState()).enabled, false);
  assert.equal(await f.service.startSession(f.input), null);
  assert.equal(
    await fs.readFile(path.join(f.storage, "settings.json"), "utf8"),
    source,
  );
});

test("a recording with no heartbeat becomes stale without inventing its end time", async (t) => {
  let current = fixedNow;
  const f = await fixture(t, { now: () => current });
  const session = await f.service.startSession(f.input);
  current += 31000;
  const stale = await f.service.getSession(session.id);
  assert.equal(stale.status, "stale");
  assert.equal(stale.endedAt, null);
  assert.equal(stale.durationMs, 0);
  const disk = await f.json(path.join(f.directory(session.id), "summary.json"));
  assert.equal(disk.status, "recording");
});

test("corrupt summaries are omitted without overwriting their original bytes", async (t) => {
  const f = await fixture(t);
  const session = await f.service.startSession(f.input);
  const file = path.join(f.directory(session.id), "summary.json");
  const source = '{"schemaVersion":1,"id":';
  await f.write(file, source);
  assert.equal(await f.service.getSession(session.id), null);
  const state = await f.service.getState();
  assert.deepEqual(state.sessions, []);
  assert.equal(state.notice, "部分游戏统计记录无法读取，原始文件已保留。");
  assert.equal(await fs.readFile(file, "utf8"), source);
});

test("hard-linked records are rejected before their contents can be returned", async (t) => {
  const f = await fixture(t);
  const session = await f.service.startSession(f.input);
  const outside = path.join(f.root, "outside.json");
  const file = path.join(f.directory(session.id), "summary.json");
  await f.write(outside, { secretFixture: "must stay outside" });
  await fs.unlink(file);
  await fs.link(outside, file);
  assert.equal(await f.service.getSession(session.id), null);
  assert.equal((await f.service.getState()).sessions.length, 0);
  assert.deepEqual(await f.json(outside), {
    secretFixture: "must stay outside",
  });
});

test("history lists the latest 100 sessions while retaining older session files", async (t) => {
  const f = await fixture(t);
  let first;
  for (let index = 0; index < 102; index++) {
    const session = await f.service.startSession({
      ...f.input,
      launchedAt: new Date(fixedNow + index * 1000).toISOString(),
    });
    if (!first) first = session;
  }
  const state = await f.service.getState();
  assert.equal(state.sessions.length, 100);
  assert.equal(
    (await fs.readdir(path.join(f.storage, "sessions"))).length,
    102,
  );
  assert.equal((await f.service.getSession(first.id)).id, first.id);
  assert.equal(
    state.sessions.some((item) => item.id === first.id),
    false,
  );
  assert.ok(
    Date.parse(state.sessions[0].startedAt) >
      Date.parse(state.sessions[99].startedAt),
  );
});

test("a damaged index yields a bounded recovered history without replacing it", async (t) => {
  const f = await fixture(t);
  await f.service.startSession(f.input);
  const file = path.join(f.storage, "index.json");
  await f.write(file, "broken index");
  assert.equal((await f.service.getState()).sessions.length, 1);
  assert.equal(await fs.readFile(file, "utf8"), "broken index");
});

test("starting after index corruption preserves its exact bytes and retains both old and new sessions", async (t) => {
  const f = await fixture(t);
  const previous = await f.service.startSession(f.input);
  const file = path.join(f.storage, "index.json");
  const original = Buffer.concat([
    Buffer.from([0xff, 0x00]),
    Buffer.from('{"schemaVersion":1,"sessions":['),
  ]);
  await fs.writeFile(file, original);
  const current = await f.service.startSession({
    ...f.input,
    launchedAt: new Date(fixedNow + 1000).toISOString(),
  });
  const state = await f.service.getState();
  assert.equal(current.status, "recording");
  assert.deepEqual(
    new Set(state.sessions.map((item) => item.id)),
    new Set([previous.id, current.id]),
  );
  assert.equal((await f.service.getSession(previous.id)).id, previous.id);
  const hash = createHash("sha256").update(original).digest("hex");
  const backup = path.join(
    f.storage,
    "corrupt-backups",
    `index.json.${hash}.bak`,
  );
  assert.deepEqual(await fs.readFile(backup), original);
  assert.equal((await f.json(file)).sessions.length, 2);
  assert.equal(f.spawns.length, 2);
});

test("explicitly repairing malformed preferences backs up original bytes before replacing them", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(f.storage);
  const file = path.join(f.storage, "settings.json");
  const original = Buffer.concat([
    Buffer.from([0xfe, 0xff]),
    Buffer.from("broken preferences"),
  ]);
  await fs.writeFile(file, original);
  const state = await f.service.setEnabled(true);
  assert.equal(state.enabled, true);
  const hash = createHash("sha256").update(original).digest("hex");
  const backup = path.join(
    f.storage,
    "corrupt-backups",
    `settings.json.${hash}.bak`,
  );
  assert.deepEqual(await fs.readFile(backup), original);
  assert.deepEqual(await f.json(file), { schemaVersion: 1, enabled: true });
  assert.equal(state.notice, "部分游戏统计记录无法读取，原始文件已保留。");
  assert.equal(f.spawns.length, 0);
});

test("linked preferences are never overwritten when recovery is requested", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(f.storage);
  const outside = path.join(f.root, "outside-preferences.json");
  const original = Buffer.from("outside fixture preferences");
  await fs.writeFile(outside, original);
  await fs.link(outside, path.join(f.storage, "settings.json"));
  await assert.rejects(f.service.setEnabled(true), /Unsafe/);
  assert.deepEqual(await fs.readFile(outside), original);
  assert.equal((await fs.stat(outside)).nlink, 2);
});

test("an existing linked recovery backup blocks replacement of the damaged index", async (t) => {
  const f = await fixture(t);
  await f.service.startSession(f.input);
  const index = path.join(f.storage, "index.json");
  const original = Buffer.from("corrupt index fixture");
  await fs.writeFile(index, original);
  const hash = createHash("sha256").update(original).digest("hex");
  const backupDirectory = path.join(f.storage, "corrupt-backups");
  await fs.mkdir(backupDirectory);
  const outside = path.join(f.root, "outside-backup.bin");
  await fs.writeFile(outside, original);
  await fs.link(outside, path.join(backupDirectory, `index.json.${hash}.bak`));
  await assert.rejects(f.service.startSession(f.input), /Unsafe/);
  assert.deepEqual(await fs.readFile(index), original);
  assert.deepEqual(await fs.readFile(outside), original);
  assert.equal(f.spawns.length, 1);
});

test("display downsampling preserves each metric's gap instead of reconnecting across missing measurements", async (t) => {
  const f = await fixture(t);
  const session = await f.service.startSession(f.input);
  const summaryFile = path.join(f.directory(session.id), "summary.json");
  const raw = await f.json(summaryFile);
  Object.assign(raw, {
    status: "completed",
    endedAt: new Date(fixedNow + 1201000).toISOString(),
    durationMs: 1201000,
    sampleCount: 1202,
    cpuAveragePercent: 40,
    cpuPeakPercent: 40,
    memoryAverageBytes: 100,
    memoryPeakBytes: 100,
    privateMemoryAverageBytes: 50,
    privateMemoryPeakBytes: 50,
    samplingGapCount: 3,
  });
  await f.write(summaryFile, raw);
  const before = await fs.readFile(summaryFile);
  const rows = [{ schemaVersion: 1, id: session.id, trendDownsampled: false }];
  for (let index = 0; index < 1202; index++)
    rows.push({
      elapsedMs: index * 1000,
      sampleNumber: index + 1,
      cpuPercent: index === 1 ? null : 40,
      memoryBytes: index === 501 ? null : 100,
      privateMemoryBytes: index === 999 ? null : 50,
    });
  await f.write(
    path.join(f.directory(session.id), "samples.jsonl"),
    rows.map((item) => JSON.stringify(item)).join("\n") + "\n",
  );
  const detail = await f.service.getSession(session.id);
  assert.equal(detail.samples.length, 602);
  assert.equal(detail.trendDownsampled, true);
  for (const key of ["cpuPercent", "memoryBytes", "privateMemoryBytes"])
    assert.ok(
      detail.samples.some((point) => point[key] === null),
      `${key} gap must remain visible`,
    );
  assert.equal(detail.cpuAveragePercent, 40);
  assert.equal(detail.memoryAverageBytes, 100);
  assert.equal(detail.privateMemoryAverageBytes, 50);
  assert.deepEqual(await fs.readFile(summaryFile), before);
});

test(
  "native CPU and memory summaries weight unequal sample intervals",
  { skip: process.platform !== "win32" },
  async (t) => {
    const { detail } = await replay(t, "weighted");
    assert.equal(detail.sampleCount, 3);
    assert.equal(detail.logicalCpuCount, 4);
    assert.equal(detail.cpuAveragePercent, 43.75);
    assert.equal(detail.cpuPeakPercent, 50);
    assert.equal(detail.memoryAverageBytes, 350);
    assert.equal(detail.memoryPeakBytes, 900);
    assert.equal(detail.privateMemoryAverageBytes, 175);
    assert.equal(detail.privateMemoryPeakBytes, 250);
    assert.equal(detail.samples[0].cpuPercent, null);
    assert.equal(detail.samples[1].cpuPercent, 25);
    assert.equal(detail.samples[2].cpuPercent, 50);
  },
);

test(
  "native first samples and unavailable measurements remain null",
  { skip: process.platform !== "win32" },
  async (t) => {
    const first = await replay(t, "first");
    assert.equal(first.detail.cpuAveragePercent, null);
    assert.equal(first.detail.cpuPeakPercent, null);
    assert.equal(first.detail.memoryAverageBytes, null);
    assert.equal(first.detail.memoryPeakBytes, 140);
    const gap = await replay(t, "gap");
    assert.equal(gap.detail.samplingGapCount, 1);
    assert.equal(gap.detail.cpuAveragePercent, 43.75);
    assert.equal(gap.detail.memoryAverageBytes, 350);
    assert.equal(gap.detail.privateMemoryAverageBytes, 190);
    assert.deepEqual(gap.detail.samples.at(-1), {
      elapsedMs: 6000,
      cpuPercent: null,
      memoryBytes: null,
      privateMemoryBytes: 250,
    });
  },
);

test(
  "native long-session compaction and displayed downsampling retain whole-session peaks and endpoints",
  { skip: process.platform !== "win32" },
  async (t) => {
    const { detail } = await replay(t, "long");
    assert.equal(detail.sampleCount, 10001);
    assert.equal(detail.cpuPeakPercent, 95);
    assert.equal(detail.memoryPeakBytes, 999999);
    assert.equal(detail.privateMemoryPeakBytes, 500000);
    assert.equal(detail.trendDownsampled, true);
    assert.ok(detail.samples.length <= 1200 && detail.samples.length > 500);
    assert.equal(detail.samples[0].elapsedMs, 1000);
    assert.equal(detail.samples.at(-1).elapsedMs, 50001000);
  },
);

test(
  "native repeated compaction retains missing samples without changing raw weighted summaries",
  { skip: process.platform !== "win32" },
  async (t) => {
    const { detail } = await replay(t, "long-gap");
    assert.equal(detail.sampleCount, 10001);
    assert.equal(detail.samplingGapCount, 1);
    assert.equal(detail.cpuPeakPercent, 95);
    assert.equal(detail.memoryPeakBytes, 999999);
    assert.equal(detail.privateMemoryPeakBytes, 500000);
    assert.ok(Math.abs(detail.cpuAveragePercent - 2.50925) < 1e-10);
    const expectedMemory = (6099.4666 * 50000000 - 2234 * 10000) / 49990000;
    assert.ok(Math.abs(detail.memoryAverageBytes - expectedMemory) < 1e-6);
    assert.equal(detail.privateMemoryAverageBytes, 150);
    for (const key of ["cpuPercent", "memoryBytes", "privateMemoryBytes"])
      assert.ok(
        detail.samples.some(
          (point) => point.elapsedMs > 1000 && point[key] === null,
        ),
        `${key} gap survives native and displayed compaction`,
      );
    assert.equal(detail.samples[0].elapsedMs, 1000);
    assert.equal(detail.samples.at(-1).elapsedMs, 50001000);
    assert.ok(detail.samples.length <= 1200);
  },
);

test(
  "a torn final append preserves complete prior samples and a corrupt complete line does not become data",
  { skip: process.platform !== "win32" },
  async (t) => {
    const f = await replay(t, "weighted");
    const file = path.join(f.directory(f.session.id), "samples.jsonl");
    const before = await fs.readFile(file, "utf8");
    await fs.appendFile(file, '{"elapsedMs":6000');
    assert.equal((await f.service.getSession(f.session.id)).samples.length, 3);
    assert.equal(
      (await f.service.getState()).notice,
      "部分游戏统计记录无法读取，原始文件已保留。",
    );
    await f.write(file, before + "bad complete line\n");
    const damaged = await f.service.getSession(f.session.id);
    assert.equal(damaged.cpuPeakPercent, 50);
    assert.deepEqual(damaged.samples, []);
  },
);

test("oversized trends are not read and invalid numbers cannot enter returned summaries", async (t) => {
  const f = await fixture(t);
  const session = await f.service.startSession(f.input);
  await fs.writeFile(
    path.join(f.directory(session.id), "samples.jsonl"),
    Buffer.alloc(2 * 1024 * 1024 + 1),
  );
  assert.deepEqual((await f.service.getSession(session.id)).samples, []);
  const file = path.join(f.directory(session.id), "summary.json");
  const value = await f.json(file);
  value.cpuPeakPercent = 101;
  await f.write(file, value);
  assert.equal(await f.service.getSession(session.id), null);
});

async function nodeTarget(t, milliseconds = 4500) {
  const launchedAt = new Date().toISOString();
  const child = spawn(
    process.execPath,
    [
      "-e",
      `const end = Date.now() + 800; while (Date.now() < end) {} setTimeout(() => {}, ${milliseconds - 800});`,
    ],
    { windowsHide: true, stdio: "ignore" },
  );
  const exited = once(child, "exit");
  await once(child, "spawn");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  });
  return { child, exited, launchedAt };
}

test(
  "the real collector survives its launcher process, records an isolated Node target, and finishes on exit",
  { skip: process.platform !== "win32", timeout: 20000 },
  async (t) => {
    const f = await fixture(t, { now: Date.now, sampleIntervalMs: 250 });
    const target = await nodeTarget(t);
    const portableSource = path.join(f.root, "portable-resource-monitor.exe");
    await fs.copyFile(monitorPath, portableSource);
    const result = await execute(
      process.execPath,
      [
        path.join(__dirname, "fixtures/performance/detached-parent.cjs"),
        path.resolve(__dirname, "../electron/game-performance.cjs"),
        f.storage,
        portableSource,
        String(target.child.pid),
        target.launchedAt,
        process.execPath,
      ],
      { windowsHide: true, timeout: 12000 },
    );
    const session = JSON.parse(result.stdout);
    assert.equal(session.status, "recording");
    await fs.unlink(portableSource);
    await assert.rejects(fs.stat(portableSource), { code: "ENOENT" });
    const first = await until(async () => {
      const record = await f.service.getSession(session.id);
      return record?.sampleCount >= 2 ? record : null;
    }, "real collector initial samples");
    const later = await until(async () => {
      const record = await f.service.getSession(session.id);
      return record?.sampleCount >= first.sampleCount + 2 ? record : null;
    }, "collector continues after the detached parent has exited");
    assert.equal(later.status, "recording");
    assert.ok(later.memoryPeakBytes > 0);
    assert.ok(later.logicalCpuCount >= 1);
    assert.match(later.processStartTicks, /^\d{15,20}$/);
    await target.exited;
    const completed = await until(async () => {
      const record = await f.service.getSession(session.id);
      return record?.status === "completed" ? record : null;
    }, "real collector completes after its target exits");
    assert.ok(completed.sampleCount >= 4);
    assert.ok(completed.durationMs >= 3500 && completed.durationMs < 8000);
    assert.ok(completed.cpuAveragePercent >= 0);
    assert.equal(completed.failureReason, null);
    assert.equal(completed.instanceName, "隔离实例");
  },
);

test(
  "the real collector rejects a different executable or creation window before collecting samples",
  { skip: process.platform !== "win32", timeout: 15000 },
  async (t) => {
    const f = await fixture(t, {
      spawnProcess: spawn,
      now: Date.now,
      sampleIntervalMs: 250,
    });
    const target = await nodeTarget(t, 6000);
    for (const input of [
      {
        ...f.input,
        pid: target.child.pid,
        launchedAt: target.launchedAt,
        executable: path.join(f.root, "different.exe"),
      },
      {
        ...f.input,
        pid: target.child.pid,
        launchedAt: "2000-01-01T00:00:00.000Z",
      },
    ]) {
      const session = await f.service.startSession(input);
      const rejected = await until(async () => {
        const record = await f.service.getSession(session.id);
        return record?.status === "unavailable" ? record : null;
      }, "identity mismatch rejected");
      assert.equal(rejected.failureReason, "identity-mismatch");
      assert.equal(rejected.sampleCount, 0);
      assert.equal(rejected.memoryPeakBytes, null);
      assert.ok(
        rejected.durationMs < 10000,
        "invalid old UTC metadata cannot inflate elapsed duration",
      );
    }
    assert.equal(target.child.exitCode, null);
  },
);

test(
  "a second native collector cannot replace an active collector's summary",
  { skip: process.platform !== "win32", timeout: 15000 },
  async (t) => {
    const f = await fixture(t, { spawnProcess: spawn, now: Date.now });
    const target = await nodeTarget(t, 12000);
    const session = await f.service.startSession({
      ...f.input,
      pid: target.child.pid,
      launchedAt: target.launchedAt,
    });
    await until(
      async () => (await f.service.getSession(session.id))?.sampleCount === 1,
      "first collector owns and samples its target",
    );
    const summaryFile = path.join(f.directory(session.id), "summary.json");
    const before = await fs.readFile(summaryFile);
    await assert.rejects(
      execute(
        monitorPath,
        [path.join(f.directory(session.id), "session.json")],
        { windowsHide: true, timeout: 3000 },
      ),
      { code: 1 },
    );
    assert.deepEqual(await fs.readFile(summaryFile), before);
    assert.equal((await f.service.getSession(session.id)).status, "recording");
    target.child.kill();
    await target.exited;
    await until(
      async () =>
        (await f.service.getSession(session.id))?.status === "completed",
      "original collector finishes after the target exits",
    );
  },
);

test(
  "the native collector refuses to append through a replacement hard link",
  { skip: process.platform !== "win32", timeout: 15000 },
  async (t) => {
    const f = await fixture(t, {
      spawnProcess: spawn,
      now: Date.now,
      sampleIntervalMs: 250,
    });
    const target = await nodeTarget(t, 6000);
    const session = await f.service.startSession({
      ...f.input,
      pid: target.child.pid,
      launchedAt: target.launchedAt,
    });
    await until(
      async () => (await f.service.getSession(session.id))?.sampleCount >= 2,
      "collector is sampling",
    );
    const outside = path.join(f.root, "outside.txt");
    await f.write(outside, "outside fixture must remain unchanged");
    const trend = path.join(f.directory(session.id), "samples.jsonl");
    await fs.unlink(trend);
    await fs.link(outside, trend);
    const interrupted = await until(async () => {
      const record = await f.service.getSession(session.id);
      return record?.status === "interrupted" ? record : null;
    }, "linked output stops collection");
    assert.equal(interrupted.failureReason, "storage-error");
    assert.equal(
      await fs.readFile(outside, "utf8"),
      "outside fixture must remain unchanged",
    );
  },
);
