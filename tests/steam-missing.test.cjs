"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createSteamMissingService } = require("../electron/steam-missing.cjs");
const clone = (value) => JSON.parse(JSON.stringify(value));
async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("fixture did not settle");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
function result(id, patch = {}) {
  return {
    id,
    outcome: "submitted",
    subscription: "confirmed",
    downloadRequest: "accepted",
    observed: {
      id,
      subscribed: true,
      installed: false,
      needsUpdate: false,
      downloading: true,
      pending: false,
      downloadedBytes: 0,
      totalBytes: 10,
    },
    errorCode: null,
    error: null,
    ...patch,
  };
}
function wrappedHandle(handle, overrides) {
  return new Proxy(handle, {
    get(target, key) {
      if (Object.hasOwn(overrides, key)) return overrides[key];
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
async function fixture(t) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "ironclad-steam-missing-"),
  );
  const state = {
    game: { found: true },
    paths: { userData: path.join(root, "user") },
    mods: [{ id: "workshop:789", available: true }],
    settings: {
      gameDirectory: path.join(root, "game"),
      activePlaysetId: "p1",
      playsets: [
        {
          id: "p1",
          name: "测试预设",
          modOrder: [
            "workshop:123",
            "workshop:456",
            "workshop:789",
            "pdx:12",
            "local:missing",
          ],
          modIds: ["workshop:123"],
          modReferences: [
            {
              id: "workshop:123",
              name: "First",
              source: "workshop",
              remoteId: "999",
            },
            {
              id: "workshop:456",
              name: "Disabled",
              source: "workshop",
              remoteId: "456",
            },
          ],
        },
      ],
    },
  };
  const behavior = {
    connected: true,
    running: false,
    repairing: false,
    blocked: false,
    repair: async (input) => result(input.id),
  };
  const calls = [],
    services = [];
  const options = {
    storageDirectory: root,
    getLauncherState: async () => clone(state),
    isGameRunning: async () => behavior.running,
    assertOperationAllowed: async () => {
      if (behavior.blocked) throw new Error("fixture storage gate");
    },
    steam: {
      isRepairing: () => behavior.repairing,
      async call(method, input) {
        calls.push({ method, input });
        if (method === "getState")
          return {
            connected: behavior.connected,
            repairing: behavior.repairing,
            account: { steamId: "76561198000000000", name: "Fixture player" },
            items: [],
          };
        assert.equal(method, "repairItem");
        return behavior.repair(input);
      },
    },
  };
  const open = () => {
    const service = createSteamMissingService(options);
    services.push(service);
    return service;
  };
  const settle = async (service) => {
    await until(
      async () =>
        !["queued", "running", "cancelling"].includes(
          (await service.getState()).job?.status,
        ),
    );
    await until(() => !service.isBusy() || behavior.repairing);
    return (await service.getState()).job;
  };
  t.after(async () => {
    behavior.repairing = false;
    for (const service of services) service.dispose();
    await until(() => services.every((service) => !service.isBusy()));
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("ironclad-steam-missing-"));
    await fs.rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  });
  return {
    root,
    state,
    behavior,
    calls,
    options,
    open,
    settle,
    writes: () => calls.filter((call) => call.method === "repairItem"),
    journal: path.join(root, "missing-mods.json"),
  };
}

test("offline state and prepare never connect or write; plans derive canonical missing members including disabled entries", async (t) => {
  const f = await fixture(t),
    service = f.open();
  assert.deepEqual(await service.getState(), { job: null, plan: null });
  assert.equal(f.calls.length, 0);
  const plan = await service.prepare({ playsetId: "p1" });
  assert.deepEqual(plan.items, [
    { id: "123", name: "First", enabled: true },
    { id: "456", name: "Disabled", enabled: false },
  ]);
  assert.deepEqual(
    f.calls.map((call) => call.method),
    ["getState"],
  );
  plan.items[0].id = "999";
  assert.equal((await service.getState()).plan.items[0].id, "123");
  await assert.rejects(
    service.prepare({ playsetId: "p1", ids: ["999"] }),
    /预设/,
  );
  f.behavior.connected = false;
  await assert.rejects(service.prepare({ playsetId: "p1" }), /连接 Steam/);
  assert.equal(f.writes().length, 0);
});

test("commit returns a reserved queued job, does not alter playsets, and consumes the plan once", async (t) => {
  const f = await fixture(t),
    service = f.open(),
    before = clone(f.state.settings);
  const plan = await service.prepare({ playsetId: "p1" });
  const first = service.commit(plan.id);
  assert.equal(service.isBusy(), true);
  await assert.rejects(service.commit(plan.id), /已有/);
  assert.equal((await first).status, "queued");
  const job = await f.settle(service);
  assert.equal(job.status, "completed");
  assert.equal(job.items[0].observed.installed, false);
  assert.deepEqual(
    f.writes().map(({ input }) => input),
    [
      { id: "123", expectedSteamId: plan.account.steamId },
      { id: "456", expectedSteamId: plan.account.steamId },
    ],
  );
  assert.deepEqual(f.state.settings, before);
  await assert.rejects(service.commit(plan.id), /失效或已提交/);
});

test("plans include all supported members instead of silently limiting a large preset to 500", async (t) => {
  const f = await fixture(t),
    service = f.open(),
    preset = f.state.settings.playsets[0];
  preset.modOrder = Array.from(
    { length: 10000 },
    (_, i) => `workshop:${i + 1}`,
  );
  preset.modIds = Array.from(
    { length: 10000 },
    (_, i) => `workshop:${i + 10001}`,
  );
  preset.modReferences = [];
  f.state.mods = [];
  const plan = await service.prepare({ playsetId: "p1" });
  assert.equal(plan.items.length, 20000);
  assert.equal(plan.items.at(-1).id, "20000");
  assert.equal(plan.items[9999].enabled, false);
  assert.equal(plan.items[10000].enabled, true);
  assert.equal(f.writes().length, 0);
});

for (const change of [
  "membership",
  "enabled",
  "game-directory",
  "user-directory",
]) {
  test(`commit rejects a changed ${change} without sending a write`, async (t) => {
    const f = await fixture(t),
      service = f.open(),
      plan = await service.prepare({ playsetId: "p1" });
    if (change === "membership")
      f.state.settings.playsets[0].modOrder.push("workshop:999");
    if (change === "enabled")
      f.state.settings.playsets[0].modIds.push("workshop:456");
    if (change === "game-directory")
      f.state.settings.gameDirectory = path.join(f.root, "other-game");
    if (change === "user-directory")
      f.state.paths.userData = path.join(f.root, "other-user");
    await assert.rejects(service.commit(plan.id), /变化/);
    assert.equal(f.writes().length, 0);
  });
}

test("files becoming available after review are skipped without changing the reviewed member list", async (t) => {
  const f = await fixture(t),
    service = f.open(),
    plan = await service.prepare({ playsetId: "p1" });
  f.state.mods.push({ id: "workshop:123", available: true });
  await service.commit(plan.id);
  const job = await f.settle(service);
  assert.equal(job.items[0].status, "skipped");
  assert.deepEqual(
    f.writes().map(({ input }) => input.id),
    ["456"],
  );
});

test("per-item confirmed failures stay visible and do not suppress the remaining items", async (t) => {
  const f = await fixture(t),
    service = f.open(),
    plan = await service.prepare({ playsetId: "p1" });
  f.behavior.repair = async ({ id }) =>
    result(
      id,
      id === "123"
        ? {
            outcome: "failed",
            downloadRequest: "rejected",
            errorCode: "DOWNLOAD_REJECTED",
            error: "下载请求未接受",
          }
        : {},
    );
  await service.commit(plan.id);
  const job = await f.settle(service);
  assert.equal(job.status, "partial");
  assert.equal(job.items[0].subscription, "confirmed");
  assert.equal(job.items[1].status, "submitted");
});

test("cancelling an in-flight item remains responsive and stops the next item only", async (t) => {
  const f = await fixture(t),
    service = f.open(),
    plan = await service.prepare({ playsetId: "p1" });
  let release;
  f.behavior.repair = (input) =>
    new Promise((resolve) => {
      release = () => resolve(result(input.id));
    });
  await service.commit(plan.id);
  await until(() => f.writes().length === 1);
  assert.equal((await service.getState()).job.items[0].status, "checking");
  assert.equal((await service.cancel()).status, "cancelling");
  assert.equal(service.isBusy(), true);
  release();
  const job = await f.settle(service);
  assert.equal(job.status, "cancelled");
  assert.equal(job.items[0].status, "submitted");
  assert.equal(job.items[1].status, "cancelled");
  assert.equal(f.writes().length, 1);
});

for (const reason of [
  "ACCOUNT_CHANGED",
  "APP_CHANGED",
  "IDENTITY_UNAVAILABLE",
]) {
  test(`${reason} stops the batch and records the returned side-effect stages`, async (t) => {
    const f = await fixture(t),
      service = f.open(),
      plan = await service.prepare({ playsetId: "p1" });
    f.behavior.repair = async ({ id }) =>
      result(id, {
        outcome: "unknown",
        subscription: "unknown",
        downloadRequest: "not-requested",
        errorCode: reason,
        error: "身份变化",
      });
    await service.commit(plan.id);
    const job = await f.settle(service);
    assert.equal(job.status, "blocked");
    assert.equal(job.items[0].status, "unknown");
    assert.equal(job.items[1].status, "cancelled");
    assert.equal(f.writes().length, 1);
  });
}

test("RPC timeout is unknown, stops further writes, and keeps the launcher gate reserved while native work remains active", async (t) => {
  const f = await fixture(t),
    service = f.open(),
    plan = await service.prepare({ playsetId: "p1" });
  f.behavior.repair = async () => {
    f.behavior.repairing = true;
    throw new Error("private native failure");
  };
  await service.commit(plan.id);
  const job = await f.settle(service);
  assert.equal(job.status, "interrupted");
  assert.equal(job.items[0].status, "unknown");
  assert.equal(service.isBusy(), true);
  assert.doesNotMatch(JSON.stringify(job), /private native/);
  await assert.rejects(service.prepare({ playsetId: "p1" }), /已有/);
  f.behavior.repairing = false;
  // The terminal snapshot may still be syncing after the native reservation
  // ends. Both boundaries must finish before the launcher gate can reopen.
  await until(() => !service.isBusy());
  assert.equal(service.isBusy(), false);
  assert.equal(f.writes().length, 1);
});

test("restarting a durable in-flight boundary stays offline and never replays writes", async (t) => {
  const f = await fixture(t),
    service = f.open(),
    plan = await service.prepare({ playsetId: "p1" });
  let release;
  f.behavior.repair = (input) =>
    new Promise((resolve) => {
      release = () => resolve(result(input.id));
    });
  await service.commit(plan.id);
  await until(() => f.writes().length === 1);
  const boundary = await fs.readFile(f.journal, "utf8");
  const records = boundary
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(records.at(-1).state.status, "checking");
  service.dispose();
  release();
  await f.settle(service);
  await fs.writeFile(f.journal, boundary);
  const calls = f.calls.length,
    reopened = f.open(),
    recovered = await reopened.getState();
  assert.equal(recovered.plan, null);
  assert.equal(recovered.job.status, "interrupted");
  assert.equal(recovered.job.items[0].status, "unknown");
  assert.equal(recovered.job.items[1].status, "cancelled");
  assert.equal(f.calls.length, calls);
  assert.equal(reopened.isBusy(), false);
  await assert.rejects(reopened.commit(plan.id), /失效/);
});

test("the game and storage guards are rechecked between items", async (t) => {
  for (const gate of ["running", "blocked"]) {
    const f = await fixture(t),
      service = f.open(),
      plan = await service.prepare({ playsetId: "p1" });
    f.behavior.repair = async ({ id }) => {
      f.behavior[gate] = true;
      return result(id);
    };
    await service.commit(plan.id);
    const job = await f.settle(service);
    assert.equal(job.status, "blocked");
    assert.equal(f.writes().length, 1);
  }
});

test("a failed intent save prevents the native request and a corrupt journal remains untouched", async (t) => {
  const f = await fixture(t),
    service = f.open(),
    plan = await service.prepare({ playsetId: "p1" });
  const open = fs.open;
  t.mock.method(fs, "open", async (...args) => {
    if (args[0] === f.journal && args[1] === "r+")
      throw new Error("fixture intent save failure");
    return open(...args);
  });
  await service.commit(plan.id);
  assert.equal((await f.settle(service)).status, "interrupted");
  assert.equal(f.writes().length, 0);
  t.mock.restoreAll();
  await fs.writeFile(f.journal, "broken fixture");
  await assert.rejects(f.open().getState(), /记录无法读取/);
  assert.equal(await fs.readFile(f.journal, "utf8"), "broken fixture");
});

test("malformed worker receipts are unknown and cannot turn an incomplete transfer into installed content", async (t) => {
  const f = await fixture(t),
    service = f.open(),
    plan = await service.prepare({ playsetId: "p1" });
  f.behavior.repair = async () => result("999");
  await service.commit(plan.id);
  const job = await f.settle(service);
  assert.equal(job.status, "interrupted");
  assert.equal(job.items[0].status, "unknown");
  assert.equal(f.writes().length, 1);
});

test("v1 completed and interrupted journals remain readable without being rewritten or replayed", async (t) => {
  for (const status of ["completed", "running"]) {
    const f = await fixture(t);
    const legacy = {
      version: 1,
      job: {
        id: "legacy",
        status,
        items: [
          {
            id: "123",
            name: "旧记录",
            enabled: true,
            status: status === "running" ? "checking" : "submitted",
          },
        ],
      },
    };
    const bytes = JSON.stringify(legacy, null, 2);
    await fs.writeFile(f.journal, bytes);
    const job = (await f.open().getState()).job;
    assert.equal(
      job.status,
      status === "running" ? "interrupted" : "completed",
    );
    assert.equal(
      job.items[0].status,
      status === "running" ? "unknown" : "submitted",
    );
    assert.equal(await fs.readFile(f.journal, "utf8"), bytes);
    assert.equal(f.calls.length, 0);
  }
});

test("a partial final result append preserves the last durable intent, keeps the tail and never submits later items", async (t) => {
  const f = await fixture(t),
    service = f.open(),
    plan = await service.prepare({ playsetId: "p1" });
  const open = fs.open;
  t.mock.method(fs, "open", async (...args) => {
    const handle = await open(...args);
    if (args[0] !== f.journal || args[1] !== "r+") return handle;
    let partial = false;
    return wrappedHandle(handle, {
      write: async (buffer, offset, length, position) => {
        const event = JSON.parse(buffer.toString());
        if (event.state.status !== "submitted")
          return handle.write(buffer, offset, length, position);
        if (partial) throw new Error("fixture append interrupted");
        partial = true;
        return handle.write(buffer, offset, Math.floor(length / 2), position);
      },
    });
  });
  await service.commit(plan.id);
  const stopped = await f.settle(service);
  assert.equal(stopped.status, "interrupted");
  assert.equal(f.writes().length, 1);
  const incomplete = await fs.readFile(f.journal, "utf8");
  assert.equal(incomplete.endsWith("\n"), false);
  assert.equal(incomplete.split("\n").length, 3);
  t.mock.restoreAll();
  const calls = f.calls.length,
    recovered = await f.open().getState();
  assert.equal(recovered.job.status, "interrupted");
  assert.equal(recovered.job.items[0].status, "unknown");
  assert.equal(recovered.job.items[1].status, "cancelled");
  assert.match(recovered.job.error, /末尾/);
  assert.equal(await fs.readFile(f.journal, "utf8"), incomplete);
  assert.equal(f.calls.length, calls);
});

test("a failed intent fsync sends no native request and retains a conservatively unknown restart boundary", async (t) => {
  const f = await fixture(t),
    service = f.open(),
    plan = await service.prepare({ playsetId: "p1" });
  const open = fs.open;
  t.mock.method(fs, "open", async (...args) => {
    const handle = await open(...args);
    return args[0] === f.journal && args[1] === "r+"
      ? wrappedHandle(handle, {
          sync: async () => {
            throw new Error("fixture fsync failed");
          },
        })
      : handle;
  });
  await service.commit(plan.id);
  await f.settle(service);
  assert.equal(f.writes().length, 0);
  const boundary = await fs.readFile(f.journal, "utf8");
  t.mock.restoreAll();
  const job = (await f.open().getState()).job;
  assert.equal(job.items[0].status, "unknown");
  assert.equal(await fs.readFile(f.journal, "utf8"), boundary);
});

test("failed terminal snapshot replacement leaves complete item results recoverable from the old log", async (t) => {
  const f = await fixture(t),
    service = f.open(),
    plan = await service.prepare({ playsetId: "p1" });
  const rename = fs.rename;
  let replacements = 0;
  t.mock.method(fs, "rename", async (...args) => {
    if (args[1] === f.journal && ++replacements > 1)
      throw new Error("fixture terminal replace failed");
    return rename(...args);
  });
  await service.commit(plan.id);
  await f.settle(service);
  assert.equal(f.writes().length, 2);
  const log = await fs.readFile(f.journal, "utf8");
  assert.equal(log.trimEnd().split("\n").length, 5);
  t.mock.restoreAll();
  const calls = f.calls.length,
    recovered = (await f.open().getState()).job;
  assert.equal(recovered.status, "interrupted");
  assert.deepEqual(
    recovered.items.map((item) => item.status),
    ["submitted", "submitted"],
  );
  assert.equal(f.calls.length, calls);
  assert.equal(await fs.readFile(f.journal, "utf8"), log);
});

test("successful terminal compaction replaces the log atomically with one standalone snapshot", async (t) => {
  const f = await fixture(t),
    service = f.open(),
    plan = await service.prepare({ playsetId: "p1" });
  await service.commit(plan.id);
  await f.settle(service);
  const bytes = await fs.readFile(f.journal, "utf8"),
    snapshot = JSON.parse(bytes);
  assert.equal(snapshot.version, 2);
  assert.equal(snapshot.type, "snapshot");
  assert.equal(snapshot.job.status, "completed");
  assert.equal(bytes.trimEnd().split("\n").length, 1);
  const count = f.calls.length;
  assert.equal((await f.open().getState()).job.status, "completed");
  assert.equal(f.calls.length, count);
});

test("complete corrupt or foreign-task log records fail closed and leave the original bytes untouched", async (t) => {
  for (const suffix of [
    "broken record\n",
    JSON.stringify({
      version: 2,
      type: "item",
      jobId: "another-job",
      sequence: 1,
      index: 0,
      state: { status: "checking" },
    }) + "\n",
  ]) {
    const f = await fixture(t);
    const snapshot = {
      version: 2,
      type: "snapshot",
      job: {
        id: "fixture",
        status: "queued",
        items: [
          { id: "123", name: "Fixture", enabled: true, status: "pending" },
        ],
      },
    };
    const bytes = JSON.stringify(snapshot) + "\n" + suffix;
    await fs.writeFile(f.journal, bytes);
    await assert.rejects(f.open().getState(), /记录无法读取/);
    assert.equal(await fs.readFile(f.journal, "utf8"), bytes);
    assert.equal(f.calls.length, 0);
  }
});

test("a replaced journal is never appended to or overwritten after a native request", async (t) => {
  const f = await fixture(t),
    service = f.open(),
    plan = await service.prepare({ playsetId: "p1" });
  f.behavior.repair = async ({ id }) => {
    await fs.rename(f.journal, f.journal + ".owned");
    await fs.writeFile(f.journal, "external replacement must survive");
    return result(id);
  };
  await service.commit(plan.id);
  assert.equal((await f.settle(service)).status, "interrupted");
  assert.equal(f.writes().length, 1);
  assert.equal(
    await fs.readFile(f.journal, "utf8"),
    "external replacement must survive",
  );
  assert.equal(
    (await fs.readFile(f.journal + ".owned", "utf8")).trimEnd().split("\n")
      .length,
    2,
  );
});

test("a hard-linked journal stops appends and remains shared without being replaced", async (t) => {
  const f = await fixture(t),
    service = f.open(),
    plan = await service.prepare({ playsetId: "p1" });
  const alias = path.join(f.root, "shared-record.json");
  let boundary;
  f.behavior.repair = async ({ id }) => {
    await fs.link(f.journal, alias);
    boundary = await fs.readFile(f.journal, "utf8");
    return result(id);
  };
  await service.commit(plan.id);
  assert.equal((await f.settle(service)).status, "interrupted");
  assert.equal(f.writes().length, 1);
  assert.equal(await fs.readFile(f.journal, "utf8"), boundary);
  assert.equal(await fs.readFile(alias, "utf8"), boundary);
  await assert.rejects(f.open().getState(), /记录无法读取/);
});

test("a 20000-member Unicode plan writes bounded per-item records and has a linear worst-case journal size", async (t) => {
  const f = await fixture(t),
    service = f.open(),
    preset = f.state.settings.playsets[0];
  preset.modOrder = Array.from(
    { length: 10000 },
    (_, i) => `workshop:${i + 1}`,
  );
  preset.modIds = Array.from(
    { length: 10000 },
    (_, i) => `workshop:${i + 10001}`,
  );
  preset.modReferences = [];
  f.state.mods = Array.from({ length: 20000 }, (_, i) => ({
    id: `workshop:${i + 1}`,
    name: "模".repeat(160),
    available: false,
  }));
  const plan = await service.prepare({ playsetId: "p1" }),
    snapshots = [],
    events = [],
    open = fs.open;
  t.mock.method(fs, "open", async (...args) => {
    const handle = await open(...args);
    if (args[1] === "wx")
      return wrappedHandle(handle, {
        writeFile: async (bytes) => {
          snapshots.push(Buffer.byteLength(bytes));
          return handle.writeFile(bytes);
        },
      });
    if (args[0] === f.journal && args[1] === "r+")
      return wrappedHandle(handle, {
        write: async (bytes, ...rest) => {
          events.push({
            bytes: bytes.length,
            value: JSON.parse(bytes.toString()),
          });
          return handle.write(bytes, ...rest);
        },
      });
    return handle;
  });
  f.behavior.repair = async ({ id }) => {
    if (id === "2") await service.cancel();
    return result(id, {
      outcome: "failed",
      downloadRequest: "rejected",
      errorCode: "DOWNLOAD_REJECTED",
      error: "错".repeat(500),
    });
  };
  await service.commit(plan.id);
  const finished = await f.settle(service);
  assert.equal(finished.items.length, 20000);
  assert.equal(snapshots.length, 2);
  assert.equal(events.length, 4);
  assert.equal(f.writes().length, 2);
  for (const event of events) {
    assert.ok(event.bytes < 4096);
    assert.equal(Object.hasOwn(event.value.state, "name"), false);
    assert.equal(Object.hasOwn(event.value.state, "enabled"), false);
    assert.equal(Object.hasOwn(event.value, "job"), false);
  }
  const worst = clone(finished);
  worst.status = "partial";
  for (const item of worst.items) {
    item.status = "failed";
    item.error = "错".repeat(500);
    item.observed = clone(worst.items[0].observed);
  }
  const finalBytes = Buffer.byteLength(
    JSON.stringify({ version: 2, type: "snapshot", job: worst }) + "\n",
  );
  const maxEvent = Math.max(...events.map((event) => event.bytes)) + 16; // wider index/sequence at the supported limit
  const projectedBytes = snapshots[0] + 40000 * maxEvent + finalBytes;
  assert.ok(projectedBytes < 256 * 1024 * 1024);
  assert.ok(events.reduce((sum, event) => sum + event.bytes, 0) < 8192);
  t.diagnostic(
    `20,000 Unicode members: ${snapshots[0]} initial bytes, <=${maxEvent} bytes per event, <=${projectedBytes} total bytes including a worst-case final snapshot`,
  );
  const reloaded = (await f.open().getState()).job;
  assert.equal(reloaded.items.length, 20000);
  assert.equal(reloaded.items[0].error.length, 500);
  await fs.writeFile(
    f.journal,
    JSON.stringify({ version: 2, type: "snapshot", job: worst }) + "\n",
  );
  const worstReloaded = (await f.open().getState()).job;
  assert.equal(worstReloaded.items.length, 20000);
  assert.equal(worstReloaded.items.at(-1).name.length, 160);
  assert.equal(worstReloaded.items.at(-1).error.length, 500);
});
