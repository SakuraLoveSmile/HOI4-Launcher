"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { EventEmitter } = require("node:events");
const { randomUUID } = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const {
  createGamePerformanceService,
} = require("../electron/game-performance.cjs");
const {
  captureEnvironment,
  compareEnvironments,
} = require("../electron/launch-environment.cjs");
const {
  buildPerformanceMonitor,
} = require("../scripts/build-performance-monitor.cjs");

const execute = promisify(execFile);
const fixedNow = Date.parse("2026-10-31T04:00:00.000Z");
const clone = (value) => structuredClone(value);
const samePath = (a, b) =>
  path.resolve(String(a)).toLowerCase() === path.resolve(b).toLowerCase();
function launchState() {
  return {
    settings: {
      gameDirectory: "C:\\fixture-game",
      activeGameInstanceId: "default",
      gameInstances: [{ id: "default", name: "默认实例" }],
      activePlaysetId: "fixture",
      launchMode: "normal",
      playsets: [
        {
          id: "fixture",
          name: "性能配置",
          modIds: ["workshop:123", "local:story.mod"],
          modOrder: ["workshop:123", "local:off.mod", "local:story.mod"],
          modReferences: [
            {
              id: "workshop:123",
              name: "Workshop author",
              source: "workshop",
              remoteId: "123",
            },
            {
              id: "local:story.mod",
              name: "Local author",
              source: "local",
              remoteId: null,
              version: "checkpoint-1",
            },
          ],
          disabledDlcIds: ["dlc-off"],
          unmappedDlcIds: [],
          origin: "local",
        },
      ],
    },
    game: { directory: "C:\\fixture-game", version: "1.19.4.0" },
    paths: { userData: "C:\\fixture-user" },
    dlc: {
      items: [
        { id: "dlc-a", installed: true, enabled: true },
        { id: "dlc-off", installed: true, enabled: false },
      ],
    },
    gameOptions: {
      values: { fullscreen: true, max_fps: 60, language: "l_simp_chinese" },
    },
    mods: [
      {
        id: "workshop:123",
        name: "Workshop",
        source: "workshop",
        remoteId: "123",
        version: "1.0",
        installedRevision: "7",
        available: true,
      },
      {
        id: "local:story.mod",
        name: "Story",
        source: "local",
        remoteId: null,
        version: "2",
        projectId: "fixture-project",
        projectVersion: "checkpoint-1",
        available: true,
      },
    ],
  };
}
function environment(state = launchState(), verified = false) {
  return captureEnvironment(
    state,
    verified
      ? {
          fingerprints: Object.fromEntries(
            state.mods.map((m, i) => [
              m.id,
              { status: "verified", digest: String(i + 1).repeat(64) },
            ]),
          ),
        }
      : {},
  );
}
async function fixture(t, overrides = {}) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "ironclad-performance-context-"),
  );
  t.after(async () => {
    assert.equal(path.dirname(root), os.tmpdir());
    assert.ok(path.basename(root).startsWith("ironclad-performance-context-"));
    await fs.rm(root, {
      recursive: true,
      force: true,
      maxRetries: 8,
      retryDelay: 75,
    });
  });
  const storage = path.join(root, "stats"),
    spawns = [];
  let clock = fixedNow;
  const options = {
    storageDirectory: storage,
    monitorPath: path.resolve(
      __dirname,
      "../assets/game-performance-monitor.exe",
    ),
    platform: "win32",
    now: () => clock,
    spawnProcess: (command, args, spawnOptions) => {
      const child = new EventEmitter();
      child.unref = () => {};
      spawns.push({ command, args, options: spawnOptions });
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
    playsetName: "性能配置",
    modCount: 2,
    launchMode: "normal",
  };
  const directory = (id) => path.join(storage, "sessions", id);
  const json = async (file) => JSON.parse(await fs.readFile(file, "utf8"));
  const write = async (file, value) => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(
      file,
      Buffer.isBuffer(value) || typeof value === "string"
        ? value
        : JSON.stringify(value) + "\n",
    );
    return file;
  };
  const make = () => createGamePerformanceService(options),
    service = make();
  const start = (value = environment()) =>
    service.startSession({
      ...input,
      ...(value === null ? {} : { environment: value }),
    });
  return {
    root,
    storage,
    options,
    input,
    spawns,
    directory,
    json,
    write,
    make,
    service,
    start,
    setNow: (value) => (clock = value),
  };
}
const annotation = (
  id,
  notes,
  updatedAt = new Date(fixedNow).toISOString(),
) => ({ schemaVersion: 1, id, notes, updatedAt });

test("legacy sessions return explicit empty context and never compare as equal configurations", async (t) => {
  const f = await fixture(t),
    a = await f.start(null),
    b = await f.start(null),
    detail = await f.service.getSession(a.id);
  assert.equal(detail.environment, null);
  assert.equal(detail.notes, "");
  assert.equal(detail.notesUpdatedAt, null);
  assert.match(detail.contextNotice, /未保存完整启动配置/);
  const result = await f.service.compareSessions(a.id, b.id);
  assert.deepEqual(
    { ...result, notice: null },
    {
      beforeId: a.id,
      afterId: b.id,
      available: false,
      changes: [],
      notice: null,
    },
  );
  assert.match(result.notice, /无法比较配置/);
  const updated = await f.service.setNotes(a.id, "旧记录仍可添加备注");
  assert.equal(updated.notes, "旧记录仍可添加备注");
  assert.equal(updated.environment, null);
});

test("complete environments are immutable session-bound sidecars and survive reopening", async (t) => {
  const f = await fixture(t),
    original = environment(),
    session = await f.start(original),
    file = path.join(f.directory(session.id), "environment.json"),
    bytes = await fs.readFile(file),
    stat = await fs.stat(file);
  original.mods[0].name = "caller mutation";
  const detail = await f.service.getSession(session.id);
  assert.equal(detail.environment.mods[0].name, "Workshop");
  assert.equal(detail.contextNotice, null);
  assert.equal(detail.notes, "");
  assert.deepEqual(await f.json(file), {
    schemaVersion: 1,
    id: session.id,
    environment: detail.environment,
  });
  detail.environment.mods[0].name = "renderer mutation";
  await f.service.setNotes(session.id, "capture notes");
  const reopened = await f.make().getSession(session.id);
  assert.equal(reopened.environment.mods[0].name, "Workshop");
  assert.equal(reopened.notes, "capture notes");
  assert.deepEqual(await fs.readFile(file), bytes);
  assert.equal((await fs.stat(file)).ino, stat.ino);
  assert.equal((await fs.stat(file)).mtimeMs, stat.mtimeMs);
  const config = await f.json(
      path.join(f.directory(session.id), "session.json"),
    ),
    summary = await f.json(path.join(f.directory(session.id), "summary.json"));
  assert.equal(Object.hasOwn(config, "environment"), false);
  assert.equal(Object.hasOwn(config.session, "environment"), false);
  assert.equal(Object.hasOwn(summary, "environment"), false);
  assert.equal(Object.hasOwn(summary, "notes"), false);
});

test(
  "the real replay collector can rewrite summaries repeatedly without losing environment or notes",
  { skip: process.platform !== "win32", timeout: 15000 },
  async (t) => {
    const f = await fixture(t),
      env = environment(),
      session = await f.start(env),
      directory = f.directory(session.id);
    await f.service.setNotes(session.id, "1939年 / 战争前\n固定配置\t观察CPU");
    const environmentBytes = await fs.readFile(
        path.join(directory, "environment.json"),
      ),
      annotationBytes = await fs.readFile(
        path.join(directory, "annotation.json"),
      );
    const replay = await buildPerformanceMonitor({
      outputPath: path.join(f.root, "replay.exe"),
      additionalSources: [
        path.join(__dirname, "fixtures/performance/replay-monitor.cs"),
      ],
      mainType: "PerformanceMonitorReplayFixture",
      target: "exe",
    });
    for (const scenario of ["first", "gap", "long-gap"]) {
      await execute(replay, [directory, scenario], {
        windowsHide: true,
        timeout: 10000,
      });
      const detail = await f.make().getSession(session.id);
      assert.equal(detail.status, "completed");
      assert.ok(detail.samples.length);
      assert.deepEqual(detail.environment, env);
      assert.equal(detail.notes, "1939年 / 战争前\n固定配置\t观察CPU");
      assert.equal(detail.contextNotice, null);
    }
    assert.deepEqual(
      await fs.readFile(path.join(directory, "environment.json")),
      environmentBytes,
    );
    assert.deepEqual(
      await fs.readFile(path.join(directory, "annotation.json")),
      annotationBytes,
    );
  },
);

test("summary polling never opens full configuration or annotation sidecars", async (t) => {
  const f = await fixture(t),
    session = await f.start();
  await f.service.setNotes(session.id, "detail only");
  const nativeOpen = fs.open;
  t.mock.method(fs, "open", async function (file, ...args) {
    assert.ok(
      !["environment.json", "annotation.json"].includes(path.basename(file)),
      "lightweight getState must not read context",
    );
    return nativeOpen.call(this, file, ...args);
  });
  const state = await f.service.getState();
  assert.equal(state.sessions.length, 1);
  assert.equal(Object.hasOwn(state.sessions[0], "environment"), false);
  assert.equal(Object.hasOwn(state.sessions[0], "notes"), false);
});

test("notes accept empty, Unicode, newlines and tabs with a strict 4000-character limit", async (t) => {
  const f = await fixture(t),
    session = await f.start();
  for (const notes of ["", "1939年\r\n配置A\t路线B", "中".repeat(4000)]) {
    f.setNow(fixedNow + notes.length);
    const detail = await f.service.setNotes(session.id, notes);
    assert.equal(detail.notes, notes);
    assert.equal(
      detail.notesUpdatedAt,
      new Date(fixedNow + notes.length).toISOString(),
    );
  }
  const file = path.join(f.directory(session.id), "annotation.json"),
    before = await fs.readFile(file);
  const controls = Array.from({ length: 32 }, (_, i) => i)
    .filter((i) => ![9, 10, 13].includes(i))
    .concat([0x7f, 0x85]);
  for (const notes of [
    "a".repeat(4001),
    null,
    12,
    {},
    ...controls.map((i) => "text" + String.fromCharCode(i)),
  ])
    await assert.rejects(f.service.setNotes(session.id, notes), /4000/);
  assert.deepEqual(await fs.readFile(file), before);
  assert.equal((await f.service.setNotes(session.id, "")).notes, "");
});

test("notes may only target valid existing sessions and arbitrary IDs never create directories", async (t) => {
  const f = await fixture(t),
    session = await f.start(),
    missing = randomUUID(),
    before = (await fs.readdir(path.join(f.storage, "sessions"))).sort();
  for (const id of [
    "../summary.json",
    f.directory(session.id),
    "",
    null,
    missing,
  ]) {
    await assert.rejects(f.service.setNotes(id, "notes"), /不存在或无法读取/);
    assert.equal(await f.service.getSession(id), null);
  }
  await assert.rejects(
    f.service.compareSessions("../environment.json", session.id),
    /不存在或无法读取/,
  );
  assert.equal(
    (await f.service.compareSessions(missing, session.id)).available,
    false,
  );
  assert.deepEqual(
    (await fs.readdir(path.join(f.storage, "sessions"))).sort(),
    before,
  );
  await f.write(
    path.join(f.directory(session.id), "summary.json"),
    "broken summary",
  );
  await assert.rejects(
    f.service.setNotes(session.id, "do not create"),
    /不存在或无法读取/,
  );
  await assert.rejects(
    fs.lstat(path.join(f.directory(session.id), "annotation.json")),
    { code: "ENOENT" },
  );
});

test("configuration comparisons expose versions, order, DLC, settings, mode and unverified content", async (t) => {
  const f = await fixture(t),
    first = environment(),
    changed = launchState();
  changed.settings.playsets[0].modOrder.reverse();
  changed.mods[0].version = "1.1";
  changed.mods[0].installedRevision = "8";
  changed.mods[1].projectVersion = "checkpoint-2";
  changed.settings.playsets[0].modReferences[1].version = "checkpoint-2";
  changed.dlc.items[0].enabled = false;
  changed.gameOptions.values.fullscreen = false;
  changed.settings.launchMode = "debug";
  const second = environment(changed),
    a = await f.start(first),
    b = await f.start(second),
    result = await f.service.compareSessions(a.id, b.id);
  assert.equal(result.available, true);
  assert.equal(result.notice, null);
  assert.deepEqual(result.changes, compareEnvironments(first, second));
  for (const kind of [
    "mod-version",
    "order",
    "dlc",
    "settings",
    "mode",
    "unverified",
  ])
    assert.ok(
      result.changes.some((c) => c.kind === kind),
      kind,
    );
  const unknown = await f.service.compareSessions(a.id, a.id);
  assert.equal(unknown.available, true);
  assert.equal(unknown.changes.length, 2);
  assert.ok(unknown.changes.every((c) => c.kind === "unverified"));
});

test("equal verified configurations may return no changes while one absent environment makes comparison unavailable", async (t) => {
  const f = await fixture(t),
    env = environment(launchState(), true),
    a = await f.start(env),
    b = await f.start(env),
    legacy = await f.start(null);
  assert.deepEqual((await f.service.compareSessions(a.id, b.id)).changes, []);
  assert.equal(
    (await f.service.compareSessions(a.id, legacy.id)).available,
    false,
  );
  const before = await fs.readFile(
    path.join(f.directory(a.id), "environment.json"),
  );
  await f.service.compareSessions(a.id, b.id);
  assert.deepEqual(
    await fs.readFile(path.join(f.directory(a.id), "environment.json")),
    before,
  );
});

test("comparisons read configuration independently of corrupt or absent trends", async (t) => {
  const f = await fixture(t),
    env = environment(),
    a = await f.start(env),
    b = await f.start(env);
  await f.write(path.join(f.directory(a.id), "samples.jsonl"), "invalid trend");
  const detail = await f.service.getSession(a.id);
  assert.deepEqual(detail.samples, []);
  assert.deepEqual(detail.environment, env);
  const nativeOpen = fs.open;
  t.mock.method(fs, "open", async function (file, ...args) {
    assert.notEqual(path.basename(file), "samples.jsonl");
    return nativeOpen.call(this, file, ...args);
  });
  assert.equal((await f.service.compareSessions(a.id, b.id)).available, true);
});

test("corrupt annotation bytes are retained, visible as context notices and never overwritten", async (t) => {
  const f = await fixture(t),
    env = environment(),
    session = await f.start(env),
    file = await f.write(
      path.join(f.directory(session.id), "annotation.json"),
      "{ damaged annotation\n",
    ),
    before = await fs.readFile(file);
  const detail = await f.service.getSession(session.id);
  assert.deepEqual(detail.environment, env);
  assert.equal(detail.notes, "");
  assert.equal(detail.notesUpdatedAt, null);
  assert.match(detail.contextNotice, /统计备注无法读取/);
  assert.equal(detail.sampleCount, 0);
  await assert.rejects(
    f.service.setNotes(session.id, "replacement"),
    /原始文件已保留/,
  );
  assert.deepEqual(await fs.readFile(file), before);
  assert.match(
    (await f.make().getSession(session.id)).contextNotice,
    /统计备注无法读取/,
  );
});

test("corrupt environments preserve metrics and notes and make comparisons unavailable", async (t) => {
  const f = await fixture(t),
    a = await f.start(),
    b = await f.start();
  await f.service.setNotes(a.id, "retained notes");
  const file = await f.write(
      path.join(f.directory(a.id), "environment.json"),
      "{ damaged environment\n",
    ),
    before = await fs.readFile(file),
    detail = await f.service.getSession(a.id);
  assert.equal(detail.environment, null);
  assert.equal(detail.notes, "retained notes");
  assert.equal(detail.sampleCount, 0);
  assert.match(detail.contextNotice, /启动配置记录无法读取/);
  assert.equal((await f.service.compareSessions(a.id, b.id)).available, false);
  assert.equal(
    (await f.service.setNotes(a.id, "new notes")).notes,
    "new notes",
  );
  assert.deepEqual(await fs.readFile(file), before);
});

test("two corrupt sidecars preserve metrics and yield separate diagnostic lines", async (t) => {
  const f = await fixture(t),
    session = await f.start(),
    directory = f.directory(session.id);
  const summaryFile = path.join(directory, "summary.json"),
    initial = await f.json(summaryFile);
  await f.write(summaryFile, {
    ...initial,
    status: "completed",
    endedAt: new Date(fixedNow + 1000).toISOString(),
    lastSampleAt: new Date(fixedNow + 1000).toISOString(),
    durationMs: 1000,
    sampleCount: 1,
    cpuAveragePercent: 25,
    cpuPeakPercent: 25,
    memoryAverageBytes: 4096,
    memoryPeakBytes: 4096,
  });
  await f.write(
    path.join(directory, "samples.jsonl"),
    JSON.stringify({
      schemaVersion: 1,
      id: session.id,
      trendDownsampled: false,
    }) +
      "\n" +
      JSON.stringify({
        sampleNumber: 1,
        elapsedMs: 1000,
        cpuPercent: 25,
        memoryBytes: 4096,
        privateMemoryBytes: null,
      }) +
      "\n",
  );
  const envFile = await f.write(
      path.join(directory, "environment.json"),
      "broken environment",
    ),
    notesFile = await f.write(
      path.join(directory, "annotation.json"),
      "broken notes",
    );
  const detail = await f.service.getSession(session.id);
  assert.equal(detail.cpuAveragePercent, 25);
  assert.equal(detail.memoryPeakBytes, 4096);
  assert.equal(detail.samples.length, 1);
  assert.equal(detail.samples[0].cpuPercent, 25);
  assert.equal(detail.environment, null);
  assert.equal(detail.notes, "");
  assert.deepEqual(detail.contextNotice.split("\n"), [
    "启动配置记录无法读取，原始文件已保留。",
    "统计备注无法读取，原始文件已保留。",
  ]);
  assert.equal(await fs.readFile(envFile, "utf8"), "broken environment");
  assert.equal(await fs.readFile(notesFile, "utf8"), "broken notes");
});

test("sidecars reject foreign session binding, unknown fields, schema versions and invalid UTF-8", async (t) => {
  const f = await fixture(t),
    session = await f.start(),
    directory = f.directory(session.id),
    env = environment();
  for (const value of [
    { schemaVersion: 1, id: randomUUID(), environment: env },
    { schemaVersion: 2, id: session.id, environment: env },
    { schemaVersion: 1, id: session.id, environment: env, extra: true },
    Buffer.from([0xc3, 0x28]),
  ]) {
    await f.write(path.join(directory, "environment.json"), value);
    const detail = await f.service.getSession(session.id);
    assert.equal(detail.environment, null);
    assert.match(detail.contextNotice, /原始文件已保留/);
  }
  await f.write(path.join(directory, "environment.json"), {
    schemaVersion: 1,
    id: session.id,
    environment: env,
  });
  for (const value of [
    { ...annotation(session.id, "notes"), extra: true },
    annotation(randomUUID(), "notes"),
    { ...annotation(session.id, "notes"), schemaVersion: 2 },
    annotation(session.id, "bad\0text"),
    { ...annotation(session.id, "notes"), updatedAt: "yesterday" },
    Buffer.from([0xc3, 0x28]),
  ]) {
    await f.write(path.join(directory, "annotation.json"), value);
    const before = await fs.readFile(path.join(directory, "annotation.json"));
    assert.match(
      (await f.service.getSession(session.id)).contextNotice,
      /统计备注无法读取/,
    );
    await assert.rejects(
      f.service.setNotes(session.id, "new"),
      /原始文件已保留/,
    );
    assert.deepEqual(
      await fs.readFile(path.join(directory, "annotation.json")),
      before,
    );
  }
});

test("sidecar size limits are checked before oversized contents are opened", async (t) => {
  const f = await fixture(t),
    session = await f.start(),
    directory = f.directory(session.id),
    target = path.join(directory, "environment.json"),
    nativeLstat = fs.lstat,
    nativeOpen = fs.open;
  t.mock.method(fs, "lstat", async function (file, ...args) {
    const stat = await nativeLstat.call(this, file, ...args);
    if (samePath(file, target))
      Object.defineProperty(stat, "size", { value: 32 * 1024 ** 2 + 1 });
    return stat;
  });
  t.mock.method(fs, "open", async function (file, ...args) {
    assert.ok(
      !samePath(file, target),
      "oversized environment must not be opened",
    );
    return nativeOpen.call(this, file, ...args);
  });
  await f.write(
    path.join(directory, "annotation.json"),
    " ".repeat(64 * 1024 + 1),
  );
  const detail = await f.service.getSession(session.id);
  assert.equal(detail.environment, null);
  assert.match(detail.contextNotice, /启动配置记录无法读取/);
  assert.match(detail.contextNotice, /统计备注无法读取/);
  await assert.rejects(f.service.setNotes(session.id, "new"), /原始文件已保留/);
});

test("hardlinked sidecars cannot be read or overwritten and leave outside files intact", async (t) => {
  const f = await fixture(t),
    session = await f.start(),
    directory = f.directory(session.id),
    outsideEnv = path.join(f.root, "outside-env.json"),
    outsideNotes = await f.write(
      path.join(f.root, "outside-notes.json"),
      annotation(session.id, "outside notes"),
    );
  await fs.rename(path.join(directory, "environment.json"), outsideEnv);
  await fs.link(outsideEnv, path.join(directory, "environment.json"));
  await fs.link(outsideNotes, path.join(directory, "annotation.json"));
  const beforeEnv = await fs.readFile(outsideEnv),
    beforeNotes = await fs.readFile(outsideNotes),
    detail = await f.service.getSession(session.id);
  assert.equal(detail.environment, null);
  assert.equal(detail.notes, "");
  assert.match(detail.contextNotice, /启动配置记录无法读取/);
  assert.match(detail.contextNotice, /统计备注无法读取/);
  await assert.rejects(f.service.setNotes(session.id, "new"), /原始文件已保留/);
  assert.deepEqual(await fs.readFile(outsideEnv), beforeEnv);
  assert.deepEqual(await fs.readFile(outsideNotes), beforeNotes);
});

test("junction session directories never authorize writes through the redirected path", async (t) => {
  const f = await fixture(t),
    session = await f.start();
  await f.service.setNotes(session.id, "original");
  const directory = f.directory(session.id),
    outside = path.join(f.root, "outside-session");
  await fs.rename(directory, outside);
  await fs.symlink(outside, directory, "junction");
  const file = path.join(outside, "annotation.json"),
    before = await fs.readFile(file);
  assert.equal(await f.service.getSession(session.id), null);
  await assert.rejects(
    f.service.setNotes(session.id, "outside overwrite"),
    /不存在或无法读取/,
  );
  assert.deepEqual(await fs.readFile(file), before);
});

test("annotation installation failures restore previous bytes and preserve recovery files", async (t) => {
  const f = await fixture(t),
    session = await f.start();
  await f.service.setNotes(session.id, "old notes");
  const directory = f.directory(session.id),
    file = path.join(directory, "annotation.json"),
    before = await fs.readFile(file),
    nativeLink = fs.link;
  let failed = false;
  t.mock.method(fs, "link", async function (source, target, ...args) {
    if (
      !failed &&
      samePath(target, file) &&
      path.basename(source).startsWith(".write-")
    ) {
      failed = true;
      throw Object.assign(Error("fixture installation denied"), {
        code: "EACCES",
      });
    }
    return nativeLink.call(this, source, target, ...args);
  });
  await assert.rejects(
    f.service.setNotes(session.id, "requested notes"),
    /未保存/,
  );
  assert.deepEqual(await fs.readFile(file), before);
  const previous = (await fs.readdir(directory)).filter((n) =>
    n.startsWith(".previous-"),
  );
  assert.equal(previous.length, 1);
  assert.deepEqual(
    await fs.readFile(path.join(directory, previous[0])),
    before,
  );
  assert.equal((await f.service.getSession(session.id)).notes, "old notes");
});

test("external annotation edits while a new value is staged fail CAS without overwriting them", async (t) => {
  const f = await fixture(t),
    session = await f.start();
  await f.service.setNotes(session.id, "old notes");
  const directory = f.directory(session.id),
    file = path.join(directory, "annotation.json"),
    external = Buffer.from(
      JSON.stringify(annotation(session.id, "external edit")) + "\n",
    ),
    nativeOpen = fs.open;
  let changed = false;
  t.mock.method(fs, "open", async function (target, ...args) {
    if (
      !changed &&
      samePath(path.dirname(target), directory) &&
      path.basename(target).startsWith(".write-") &&
      args[0] === "wx"
    ) {
      changed = true;
      await fs.writeFile(file, external);
    }
    return nativeOpen.call(this, target, ...args);
  });
  await assert.rejects(
    f.service.setNotes(session.id, "requested edit"),
    /未保存/,
  );
  assert.equal(changed, true);
  assert.deepEqual(await fs.readFile(file), external);
});

test("an external write immediately before displacement is recovered and retained instead of replaced", async (t) => {
  const f = await fixture(t),
    session = await f.start();
  await f.service.setNotes(session.id, "old notes");
  const directory = f.directory(session.id),
    file = path.join(directory, "annotation.json"),
    external = Buffer.from(
      JSON.stringify(annotation(session.id, "last-moment external")) + "\n",
    ),
    nativeRename = fs.rename;
  let changed = false;
  t.mock.method(fs, "rename", async function (source, target, ...args) {
    if (
      !changed &&
      samePath(source, file) &&
      path.basename(target).startsWith(".previous-")
    ) {
      changed = true;
      await fs.writeFile(file, external);
    }
    return nativeRename.call(this, source, target, ...args);
  });
  await assert.rejects(
    f.service.setNotes(session.id, "requested edit"),
    /未保存/,
  );
  assert.equal(changed, true);
  assert.deepEqual(await fs.readFile(file), external);
  const previous = (await fs.readdir(directory)).find((n) =>
    n.startsWith(".previous-"),
  );
  assert.deepEqual(await fs.readFile(path.join(directory, previous)), external);
});

test("a new external target appearing after displacement wins without losing the old annotation", async (t) => {
  const f = await fixture(t),
    session = await f.start();
  await f.service.setNotes(session.id, "old notes");
  const directory = f.directory(session.id),
    file = path.join(directory, "annotation.json"),
    before = await fs.readFile(file),
    external = Buffer.from(
      JSON.stringify(annotation(session.id, "new external target")) + "\n",
    ),
    nativeRename = fs.rename;
  let changed = false;
  t.mock.method(fs, "rename", async function (source, target, ...args) {
    const result = await nativeRename.call(this, source, target, ...args);
    if (
      !changed &&
      samePath(source, file) &&
      path.basename(target).startsWith(".previous-")
    ) {
      changed = true;
      await fs.writeFile(file, external);
    }
    return result;
  });
  await assert.rejects(
    f.service.setNotes(session.id, "requested edit"),
    /未保存/,
  );
  assert.deepEqual(await fs.readFile(file), external);
  const previous = (await fs.readdir(directory)).find((n) =>
    n.startsWith(".previous-"),
  );
  assert.deepEqual(await fs.readFile(path.join(directory, previous)), before);
});

test("an externally created first annotation is never overwritten by exclusive publication", async (t) => {
  const f = await fixture(t),
    session = await f.start(),
    file = path.join(f.directory(session.id), "annotation.json"),
    external = Buffer.from(
      JSON.stringify(annotation(session.id, "external first")) + "\n",
    ),
    nativeLink = fs.link;
  let created = false;
  t.mock.method(fs, "link", async function (source, target, ...args) {
    if (!created && samePath(target, file)) {
      created = true;
      await fs.writeFile(file, external);
    }
    return nativeLink.call(this, source, target, ...args);
  });
  await assert.rejects(
    f.service.setNotes(session.id, "requested first"),
    /未保存/,
  );
  assert.deepEqual(await fs.readFile(file), external);
});

test("detail reads and further writes wait for annotation commits in the existing statistics queue", async (t) => {
  const f = await fixture(t),
    session = await f.start();
  await f.service.setNotes(session.id, "old");
  const file = path.join(f.directory(session.id), "annotation.json"),
    nativeRename = fs.rename;
  let entered,
    release,
    blocked = false,
    readFinished = false;
  const ready = new Promise((r) => (entered = r)),
    gate = new Promise((r) => (release = r));
  t.mock.method(fs, "rename", async function (source, target, ...args) {
    const result = await nativeRename.call(this, source, target, ...args);
    if (
      !blocked &&
      samePath(source, file) &&
      path.basename(target).startsWith(".previous-")
    ) {
      blocked = true;
      entered();
      await gate;
    }
    return result;
  });
  const update = f.service.setNotes(session.id, "committed");
  await ready;
  const detail = f.service.getSession(session.id).then((value) => {
    readFinished = true;
    return value;
  });
  const preference = f.service.setEnabled(false);
  await new Promise((r) => setImmediate(r));
  assert.equal(readFinished, false);
  release();
  assert.equal((await update).notes, "committed");
  assert.equal((await detail).notes, "committed");
  assert.equal((await preference).enabled, false);
});

test("invalid complete environments fail before creating a session and collection failures retain valid context", async (t) => {
  const f = await fixture(t),
    invalid = environment();
  invalid.configurationId = "a".repeat(64);
  await assert.rejects(f.start(invalid), /启动环境记录无效/);
  await assert.rejects(fs.lstat(f.storage), { code: "ENOENT" });
  const failed = await fixture(t, {
      spawnProcess: () => {
        const child = new EventEmitter();
        child.unref = () => {};
        queueMicrotask(() =>
          child.emit("error", Error("fixture collector failed")),
        );
        return child;
      },
    }),
    env = environment(),
    session = await failed.start(env),
    detail = await failed.service.getSession(session.id);
  assert.equal(detail.status, "unavailable");
  assert.equal(detail.failureReason, "monitor-start-failed");
  assert.deepEqual(detail.environment, env);
  assert.equal(detail.contextNotice, null);
  assert.equal(
    (
      await failed.service.setNotes(
        session.id,
        "collector failed but context retained",
      )
    ).notes,
    "collector failed but context retained",
  );
});
