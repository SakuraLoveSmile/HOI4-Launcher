"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const { randomUUID } = require("node:crypto");
const { createPdxRelocation } = require("../electron/pdx-relocation.cjs");

const copy = (value) => structuredClone(value);
const busyError = /正在|等待|处理|迁移/;

function deferred(t) {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  t.after(() => resolve());
  return { promise, resolve };
}

async function promptly(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error("State lookup blocked behind an ongoing operation"),
            ),
          250,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function until(predicate) {
  const deadline = Date.now() + 1500;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error("Fixture operation did not settle");
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function fixture(t) {
  // These paths are deliberately unique, but no test writes or moves files.
  const root = path.join(
    os.tmpdir(),
    "ironclad-relocation-fixture-" + randomUUID(),
  );
  const f = {
    root,
    userData: path.join(root, "user-data"),
    target: path.join(root, "destination"),
    calls: [],
    running: false,
    otherBusy: false,
    readyHook: null,
    pathHook: null,
    storageHook: null,
    gameHook: null,
    planHook: null,
    cancelHook: null,
    moveHook: null,
    recoverHook: null,
    sequence: 0,
    plans: new Map(),
    storage: {
      contentRoot: path.join(root, "current"),
      recoveryRequired: false,
    },
  };
  const installer = {
    async getStorageState(input) {
      f.calls.push({ type: "read", input });
      const override = await f.storageHook?.(input);
      return copy(override ?? f.storage);
    },
    async planRelocation(input) {
      f.calls.push({ type: "plan", input });
      const plan = {
        planId: `plan-${++f.sequence}`,
        from: f.storage.contentRoot,
        to: path.join(
          input.targetParent ?? input.userDataPath,
          "ironclad-mods",
        ),
        bytes: 42,
        files: 2,
        conflicts: [],
      };
      const override = await f.planHook?.(input, plan);
      const result = override ?? plan;
      f.plans.set(result.planId, copy(result));
      return result;
    },
    async cancelRelocationPlan(planId) {
      f.calls.push({ type: "discard", planId });
      await f.cancelHook?.(planId);
      f.plans.delete(planId);
    },
    async relocate(input) {
      f.calls.push({ type: "move", input });
      input.signal.throwIfAborted();
      await f.moveHook?.(input);
      input.signal.throwIfAborted();
      f.storage.contentRoot = f.plans.get(input.planId).to;
      return { moved: true, contentRoot: f.storage.contentRoot };
    },
    async recover() {
      f.calls.push({ type: "recover" });
      const result = await f.recoverHook?.();
      f.storage.recoveryRequired = false;
      return result ?? { recovered: true };
    },
  };
  f.service = createPdxRelocation({
    installer,
    getUserDataPath: async () => {
      if (f.pathHook) return f.pathHook();
      return f.userData;
    },
    ready: async () => {
      f.calls.push({ type: "ready" });
      return await f.readyHook?.();
    },
    isGameRunning: async () => {
      await f.gameHook?.();
      return f.running;
    },
    isOtherBusy: () => f.otherBusy,
  });
  t.after(() => f.service.dispose());
  f.count = (type) => f.calls.filter((call) => call.type === type).length;
  f.prepare = () => f.service.prepare({ targetParent: f.target });
  f.finish = async () => {
    await until(() => !f.service.isBusy());
    return f.service.getState();
  };
  return f;
}

test("construction is inert and repeated reads initialize only once", async (t) => {
  const f = fixture(t);
  assert.deepEqual(f.calls, []);
  assert.equal(f.service.isBusy(), false);
  assert.equal(f.service.isBlocked(), false);
  const first = await f.service.getState();
  assert.equal(first.storage.userDataPath, f.userData);
  first.storage.contentRoot = "caller mutation";
  assert.equal(
    (await f.service.getState()).storage.contentRoot,
    f.storage.contentRoot,
  );
  assert.equal(f.count("ready"), 1);
  assert.equal(f.count("move"), 0);
});

test("startup recovery, cancelled cleanup and explicit recovery keep retained paths visible", async (t) => {
  const f = fixture(t);
  const startup = path.join(f.root, "startup-leftover");
  const copied = path.join(f.root, "modified-copy");
  const backup = path.join(f.root, "registration-backup");
  f.readyHook = async () => ({ retainedPaths: [startup] });
  assert.deepEqual((await f.service.getState()).retainedPaths, [startup]);
  const plan = await f.prepare();
  f.moveHook = async () => {
    throw Object.assign(new Error("aborted"), {
      name: "AbortError",
      retainedPaths: [copied, copied, "relative-path"],
    });
  };
  await f.service.commit(plan.planId);
  const state = await f.finish();
  assert.equal(state.job.status, "cancelled");
  assert.deepEqual(state.job.retainedPaths, [copied]);
  f.recoverHook = async () => ({ retainedPaths: [backup] });
  await f.service.recover();
  assert.deepEqual((await f.service.getState()).retainedPaths, [
    startup,
    backup,
  ]);
});

test("prepare only previews and null target selects the current user directory", async (t) => {
  const f = fixture(t);
  const plan = await f.service.prepare({ targetParent: null });
  assert.equal(plan.to, path.join(f.userData, "ironclad-mods"));
  assert.equal(f.count("move"), 0);
  assert.equal(f.count("recover"), 0);
  assert.equal(f.service.isBusy(), false);
  assert.equal(f.service.isBlocked(), false);
  assert.equal((await f.service.getState()).job, null);
});

test("invalid destinations fail without initializing or touching installer", async (t) => {
  const f = fixture(t);
  for (const targetParent of [
    undefined,
    "",
    "relative",
    {},
    f.target + "\0bad",
  ])
    await assert.rejects(f.service.prepare({ targetParent }), /目标目录/);
  assert.deepEqual(f.calls, []);
});

test("only the reviewed plan ID can commit once and caller mutations cannot change it", async (t) => {
  const f = fixture(t),
    plan = await f.prepare(),
    id = plan.planId;
  plan.planId = "tampered";
  plan.to = "tampered";
  for (const wrong of ["other", undefined, 1, "tampered"])
    await assert.rejects(f.service.commit(wrong), /预览已失效/);
  const queued = await f.service.commit(id);
  assert.equal(queued.status, "queued");
  assert.equal(queued.to, path.join(f.target, "ironclad-mods"));
  const state = await f.finish();
  assert.equal(state.job.status, "succeeded");
  assert.equal(state.storage.contentRoot, queued.to);
  assert.equal(f.count("move"), 1);
  await assert.rejects(f.service.commit(id), /预览已失效/);
  assert.equal(f.count("move"), 1);
});

test("commit binds to the prepared userData directory", async (t) => {
  const f = fixture(t),
    plan = await f.prepare();
  f.userData = path.join(f.root, "different-user-data");
  await assert.rejects(f.service.commit(plan.planId), /用户目录已变化/);
  assert.equal(f.count("move"), 0);
  assert.equal(f.service.isBusy(), false);
});

test("a userData change while planning invalidates and discards the new plan", async (t) => {
  const f = fixture(t),
    gate = deferred(t),
    reached = deferred(t);
  f.planHook = async () => {
    reached.resolve();
    await gate.promise;
  };
  const pending = f.prepare();
  await reached.promise;
  f.userData = path.join(f.root, "changed-user-data");
  gate.resolve();
  await assert.rejects(pending, /用户目录已变化/);
  assert.equal(f.count("discard"), 1);
  assert.equal(f.plans.size, 0);
  await assert.rejects(f.service.commit("plan-1"), /预览已失效/);
});

test("conflicts prevent commit while allowing the preview to be discarded", async (t) => {
  const f = fixture(t);
  f.planHook = (_input, plan) => ({
    ...plan,
    conflicts: ["existing foreign file"],
  });
  const plan = await f.prepare();
  await assert.rejects(f.service.commit(plan.planId), /冲突/);
  assert.equal(f.count("move"), 0);
  await f.service.discard();
  assert.equal(f.count("discard"), 1);
  await assert.rejects(f.service.commit(plan.planId), /预览已失效/);
});

test("game-running and other-operation guards reject preparation and submission", async (t) => {
  for (const key of ["running", "otherBusy"]) {
    const f = fixture(t);
    f[key] = true;
    await assert.rejects(f.prepare(), /退出游戏|其他模组操作/);
    assert.equal(f.count("plan"), 0);
    f[key] = false;
    const plan = await f.prepare();
    f[key] = true;
    await assert.rejects(
      f.service.commit(plan.planId),
      /退出游戏|其他模组操作/,
    );
    assert.equal(f.count("move"), 0);
    assert.equal(f.service.isBusy(), false);
  }
});

test("guard rechecks other work that starts during its asynchronous game probe", async (t) => {
  const f = fixture(t),
    gate = deferred(t),
    reached = deferred(t);
  f.gameHook = async () => {
    reached.resolve();
    await gate.promise;
  };
  const pending = f.prepare();
  await reached.promise;
  f.otherBusy = true;
  gate.resolve();
  await assert.rejects(pending, /其他模组操作/);
  assert.equal(f.count("plan"), 0);
});

test("prepare reserves synchronously, blocks launch, and rejects concurrent mutations", async (t) => {
  const f = fixture(t),
    gate = deferred(t),
    reached = deferred(t);
  f.planHook = async () => {
    reached.resolve();
    await gate.promise;
  };
  const pending = f.prepare();
  assert.equal(f.service.isBusy(), true);
  assert.equal(f.service.isBlocked(), true);
  await reached.promise;
  const state = await promptly(f.service.getState());
  assert.equal(state.busy, true);
  await assert.rejects(f.service.assertReady(), busyError);
  for (const operation of [
    () => f.prepare(),
    () => f.service.commit("plan-1"),
    () => f.service.discard(),
    () => f.service.recover(),
  ])
    await assert.rejects(operation(), busyError);
  gate.resolve();
  await pending;
  await f.service.assertReady();
});

test("commit reserves before an async guard and keeps status reads responsive", async (t) => {
  const f = fixture(t),
    plan = await f.prepare(),
    gate = deferred(t),
    reached = deferred(t);
  f.gameHook = async () => {
    reached.resolve();
    await gate.promise;
  };
  const pending = f.service.commit(plan.planId);
  assert.equal(f.service.isBusy(), true);
  assert.equal(f.service.isBlocked(), true);
  await reached.promise;
  assert.equal((await promptly(f.service.getState())).busy, true);
  await assert.rejects(f.service.assertReady(), busyError);
  await assert.rejects(f.service.commit(plan.planId), busyError);
  gate.resolve();
  await pending;
  assert.equal((await f.finish()).job.status, "succeeded");
});

test("moving jobs expose copied progress promptly and cancellation settles without replay", async (t) => {
  const f = fixture(t),
    plan = await f.prepare(),
    reached = deferred(t);
  f.moveHook = async ({ signal, onProgress }) => {
    onProgress({
      processedBytes: 20,
      totalBytes: 42,
      filesDone: 1,
      totalFiles: 2,
      cancellable: true,
    });
    reached.resolve();
    await new Promise((resolve) =>
      signal.addEventListener("abort", resolve, { once: true }),
    );
  };
  await f.service.commit(plan.planId);
  await reached.promise;
  const state = await promptly(f.service.getState());
  assert.equal(state.job.status, "moving");
  assert.equal(state.job.progress.processedBytes, 20);
  state.job.progress.processedBytes = 99;
  assert.equal(
    (await promptly(f.service.getState())).job.progress.processedBytes,
    20,
  );
  assert.equal((await f.service.cancel()).status, "cancelling");
  const done = await f.finish();
  assert.equal(done.job.status, "cancelled");
  assert.equal(done.recoveryRequired, false);
  assert.equal(f.count("move"), 1);
  await assert.rejects(f.service.commit(plan.planId), /预览已失效/);
});

test("committing registration cannot be cancelled", async (t) => {
  const f = fixture(t),
    plan = await f.prepare(),
    gate = deferred(t),
    reached = deferred(t);
  let moveSignal;
  f.moveHook = async ({ signal, onProgress }) => {
    moveSignal = signal;
    onProgress({
      processedBytes: 42,
      totalBytes: 42,
      filesDone: 2,
      totalFiles: 2,
      cancellable: false,
    });
    reached.resolve();
    await gate.promise;
  };
  await f.service.commit(plan.planId);
  await reached.promise;
  assert.equal((await promptly(f.service.getState())).job.status, "committing");
  await assert.rejects(f.service.cancel(), /切换模组注册信息/);
  assert.equal(moveSignal.aborted, false);
  gate.resolve();
  assert.equal((await f.finish()).job.status, "succeeded");
});

test("unknown initial recovery failure stays blocked across clean reads until explicit recovery", async (t) => {
  const f = fixture(t);
  f.readyHook = async () => {
    throw new Error("unknown interrupted transaction");
  };
  const state = await f.service.getState();
  assert.equal(state.recoveryRequired, true);
  assert.equal(f.service.isBlocked(), true);
  f.readyHook = null;
  assert.equal((await f.service.getState()).recoveryRequired, true);
  await assert.rejects(f.service.assertReady());
  await assert.rejects(f.prepare());
  assert.equal(f.count("recover"), 0);
  assert.equal((await f.service.recover()).recoveryRequired, false);
  await f.service.assertReady();
  const plan = await f.prepare();
  await f.service.commit(plan.planId);
  assert.equal((await f.finish()).job.status, "succeeded");
  assert.equal(f.count("move"), 1);
});

test("installer RECOVERY_REQUIRED blocks launch despite a clean storage reply until explicit recovery", async (t) => {
  const f = fixture(t),
    plan = await f.prepare();
  const { diagnosticError } = require("../electron/diagnostic-message.cjs");
  const { formatDiagnostic } = await import("../src/i18n-core.mjs");
  const failure = diagnosticError("{0} 迁移恢复记录已保留，请重试恢复：{1}", [
    "transaction rollback needs inspection",
    "设置，但 {1}",
  ]);
  f.moveHook = async () => {
    throw Object.assign(failure, {
      code: "RECOVERY_REQUIRED",
    });
  };
  await f.service.commit(plan.planId);
  const failed = await f.finish();
  assert.equal(failed.job.status, "failed");
  assert.deepEqual(failed.job.errorDiagnostic, failure.diagnostic);
  assert.equal(
    formatDiagnostic("en", failed.job.errorDiagnostic),
    "transaction rollback needs inspection The move recovery record has been kept. Retry recovery: 设置，但 {1}",
  );
  assert.equal((await f.service.getState()).recoveryRequired, true);
  assert.equal(f.service.isBlocked(), true);
  await assert.rejects(f.service.assertReady(), /恢复/);
  await assert.rejects(f.prepare(), /恢复/);
  assert.equal(f.count("move"), 1);
  assert.equal(f.count("recover"), 0);
  await f.service.recover();
  f.moveHook = null;
  const retry = await f.prepare();
  await f.service.commit(retry.planId);
  assert.equal((await f.finish()).job.status, "succeeded");
  assert.equal(f.count("move"), 2);
});

test("relocation metadata preserves the existing diagnostic length limit", async (t) => {
  const f = fixture(t),
    plan = await f.prepare();
  const { diagnosticError } = require("../electron/diagnostic-message.cjs");
  const { formatDiagnostic } = await import("../src/i18n-core.mjs");
  const failure = diagnosticError("{0} 迁移恢复记录已保留，请重试恢复：{1}", [
    "x".repeat(2500),
    "设置",
  ]);
  f.moveHook = async () => {
    throw failure;
  };
  await f.service.commit(plan.planId);
  const { job } = await f.finish();
  assert.equal(job.error.length, 2000);
  assert.equal(formatDiagnostic("en", job.errorDiagnostic), job.error);
  assert.deepEqual(job.errorDiagnostic, { kind: "literal", text: job.error });
});

test("failed explicit recovery cannot be cleared by read-only refresh and can be retried", async (t) => {
  const f = fixture(t);
  await f.service.getState();
  f.recoverHook = async () => {
    throw new Error("disk unavailable during recovery");
  };
  await assert.rejects(f.service.recover(), /disk unavailable/);
  assert.equal((await f.service.getState()).recoveryRequired, true);
  await assert.rejects(f.service.assertReady(), /恢复/);
  f.recoverHook = null;
  await f.service.recover();
  assert.equal(f.service.isBlocked(), false);
  await f.service.assertReady();
  assert.equal(f.count("move"), 0);
});

test("a disk-reported recovery requirement prevents planning and launch without replaying migration", async (t) => {
  const f = fixture(t);
  f.storage.recoveryRequired = true;
  assert.equal((await f.service.getState()).recoveryRequired, true);
  await assert.rejects(f.prepare(), /恢复/);
  await assert.rejects(f.service.assertReady(), /恢复/);
  assert.equal(f.count("plan"), 0);
  assert.equal(f.count("move"), 0);
  assert.equal(f.count("recover"), 0);
});

test("recover reserves synchronously and rejects other mutations while reads stay responsive", async (t) => {
  const f = fixture(t),
    gate = deferred(t),
    reached = deferred(t);
  await f.service.getState();
  f.recoverHook = async () => {
    reached.resolve();
    await gate.promise;
  };
  const pending = f.service.recover();
  assert.equal(f.service.isBusy(), true);
  await reached.promise;
  assert.equal((await promptly(f.service.getState())).busy, true);
  for (const operation of [
    () => f.prepare(),
    () => f.service.commit("plan-1"),
    () => f.service.discard(),
    () => f.service.recover(),
    () => f.service.assertReady(),
  ])
    await assert.rejects(operation(), busyError);
  gate.resolve();
  await pending;
});

test("concurrent state reads share one installer read", async (t) => {
  const f = fixture(t),
    gate = deferred(t),
    reached = deferred(t);
  await f.service.getState();
  const before = f.count("read");
  f.storageHook = async () => {
    reached.resolve();
    await gate.promise;
  };
  const first = f.service.getState();
  await reached.promise;
  const second = f.service.getState();
  assert.equal(f.count("read"), before + 1);
  gate.resolve();
  await Promise.all([first, second]);
  assert.equal(f.count("read"), before + 1);
});

test("discard reserves synchronously so prepare and other mutations cannot overlap cancellation", async (t) => {
  const f = fixture(t),
    plan = await f.prepare(),
    gate = deferred(t),
    reached = deferred(t);
  f.cancelHook = async () => {
    reached.resolve();
    await gate.promise;
  };
  const pending = f.service.discard();
  await reached.promise;
  assert.equal(
    f.service.isBusy(),
    true,
    "discard must reserve while installer cancellation is pending",
  );
  assert.equal((await promptly(f.service.getState())).busy, true);
  for (const operation of [
    () => f.prepare(),
    () => f.service.commit(plan.planId),
    () => f.service.discard(),
    () => f.service.recover(),
  ])
    await assert.rejects(operation(), busyError);
  gate.resolve();
  await pending;
  assert.equal(f.service.isBusy(), false);
});

test("a stale read cannot clear a forced recovery gate created by a concurrent failed migration", async (t) => {
  const f = fixture(t),
    gate = deferred(t),
    reached = deferred(t);
  await f.service.getState();
  let first = true;
  f.storageHook = async () => {
    if (!first) return;
    first = false;
    const oldStorage = copy(f.storage);
    reached.resolve();
    await gate.promise;
    return oldStorage;
  };
  const reading = f.service.getState();
  await reached.promise;
  const plan = await f.prepare();
  f.moveHook = async () => {
    throw Object.assign(new Error("transaction needs explicit recovery"), {
      code: "RECOVERY_REQUIRED",
    });
  };
  await f.service.commit(plan.planId);
  await until(() => !f.service.isBusy());
  assert.equal(f.service.isBlocked(), true);
  gate.resolve();
  assert.equal((await reading).recoveryRequired, true);
  await assert.rejects(f.service.assertReady(), /恢复/);
  assert.equal(f.count("move"), 1);
  assert.equal(f.count("recover"), 0);
});

test("late cancellable progress cannot overwrite cancelling status", async (t) => {
  const f = fixture(t),
    plan = await f.prepare(),
    reached = deferred(t),
    lateProgress = deferred(t),
    gate = deferred(t);
  f.moveHook = async ({ signal, onProgress }) => {
    reached.resolve();
    await new Promise((resolve) =>
      signal.addEventListener("abort", resolve, { once: true }),
    );
    onProgress({
      processedBytes: 30,
      totalBytes: 42,
      filesDone: 1,
      totalFiles: 2,
      cancellable: true,
    });
    lateProgress.resolve();
    await gate.promise;
  };
  await f.service.commit(plan.planId);
  await reached.promise;
  await f.service.cancel();
  await lateProgress.promise;
  assert.equal((await promptly(f.service.getState())).job.status, "cancelling");
  gate.resolve();
  assert.equal((await f.finish()).job.status, "cancelled");
});

test("assertReady rechecks a migration reservation created during its asynchronous read", async (t) => {
  const f = fixture(t),
    plan = await f.prepare(),
    readGate = deferred(t),
    readReached = deferred(t),
    moveGate = deferred(t),
    moveReached = deferred(t);
  let first = true;
  f.storageHook = async () => {
    if (!first) return;
    first = false;
    readReached.resolve();
    await readGate.promise;
  };
  f.moveHook = async () => {
    moveReached.resolve();
    await moveGate.promise;
  };
  const launching = f.service.assertReady();
  await readReached.promise;
  const committing = f.service.commit(plan.planId);
  await moveReached.promise;
  readGate.resolve();
  await assert.rejects(launching, busyError);
  moveGate.resolve();
  await committing;
  assert.equal((await f.finish()).job.status, "succeeded");
});

test("dispose cancels an active move and prevents every new operation", async (t) => {
  const f = fixture(t),
    plan = await f.prepare(),
    reached = deferred(t);
  let signal;
  f.moveHook = async (input) => {
    signal = input.signal;
    reached.resolve();
    await new Promise((resolve) =>
      signal.addEventListener("abort", resolve, { once: true }),
    );
  };
  await f.service.commit(plan.planId);
  await reached.promise;
  f.service.dispose();
  assert.equal(signal.aborted, true);
  for (const operation of [
    () => f.service.getState(),
    () => f.prepare(),
    () => f.service.commit(plan.planId),
    () => f.service.discard(),
    () => f.service.recover(),
    () => f.service.assertReady(),
    () => f.service.cancel(),
  ])
    await assert.rejects(operation(), /已关闭/);
  await until(() => !f.service.isBusy());
  assert.equal(f.count("move"), 1);
});

test("dispose during planning discards the in-flight plan instead of returning a usable review", async (t) => {
  const f = fixture(t),
    gate = deferred(t),
    reached = deferred(t);
  f.planHook = async () => {
    reached.resolve();
    await gate.promise;
  };
  const pending = f.prepare();
  await reached.promise;
  f.service.dispose();
  gate.resolve();
  await assert.rejects(pending, /已关闭|取消/);
  assert.equal(f.count("discard"), 1);
  assert.equal(f.plans.size, 0);
});

test("assertReady cannot permit launch when the service is disposed during its storage read", async (t) => {
  const f = fixture(t),
    gate = deferred(t),
    reached = deferred(t);
  await f.service.getState();
  f.storageHook = async () => {
    reached.resolve();
    await gate.promise;
  };
  const launching = f.service.assertReady();
  await reached.promise;
  f.service.dispose();
  gate.resolve();
  await assert.rejects(launching, /已关闭/);
});
