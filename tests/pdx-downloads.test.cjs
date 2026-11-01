"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createHash, randomUUID } = require("node:crypto");
const FIXTURE_HASH = createHash("sha256").update("fixture zip").digest("hex");
const { createPdxDownloads } = require("../electron/pdx-downloads.cjs");

test("repair cannot select an external directory, revision or installation identity", async (t) => {
  const f = await fixture(t);
  for (const patch of [
    { userDataPath: f.root },
    { revision: "9" },
    { installationId: randomUUID() },
    { operation: "repair" },
  ])
    await assert.rejects(
      f.service.repair({ modId: "123", ...patch }),
      /修复参数无效/,
    );
  assert.deepEqual(f.calls, []);
});

test("a stale context-menu user directory cannot start a download or uninstall another instance", async (t) => {
  const f = await fixture(t);
  const otherInstance = path.join(f.root, "previous-instance");
  await assert.rejects(
    f.service.start({ modId: "123" }, otherInstance),
    /版本实例已变化/,
  );
  assert.equal(f.service.isBusy(), false);
  assert.equal(f.calls.includes("resolve"), false);
  await assert.rejects(
    f.service.uninstall("123", otherInstance),
    /版本实例已变化/,
  );
  assert.equal(
    f.calls.some((call) => Array.isArray(call) && call[0] === "uninstall"),
    false,
  );
  assert.equal(f.service.isBusy(), false);
  await f.service.start({ modId: "123" }, f.userDataPath);
  assert.equal((await f.finished()).job.status, "succeeded");
});

test("repair refuses installations belonging to another game user directory", async (t) => {
  const f = await fixture(t);
  f.options.installer.verify = async () => {
    throw new Error("must not validate foreign installation");
  };
  f.installations.push({
    modId: "123",
    revision: "1",
    installationId: randomUUID(),
    descriptorPath: path.join(f.root, "other-user", "mod", "pdx_123_1.mod"),
  });
  await assert.rejects(
    f.service.repair({ modId: "123" }),
    /未找到当前游戏目录/,
  );
  assert.deepEqual(f.calls, ["recover"]);
  assert.equal(f.service.isBusy(), false);
});

test("a running validation reserves the job gate and can be cancelled before network IO", async (t) => {
  const f = await fixture(t),
    installationId = randomUUID();
  f.installations.push({
    modId: "123",
    revision: "1",
    installationId,
    archiveSha256: FIXTURE_HASH,
    descriptorPath: path.join(f.userDataPath, "mod", "pdx_123_1.mod"),
  });
  let validating;
  const entered = new Promise((resolve) => {
    validating = resolve;
  });
  f.options.installer.verify = async (_id, { signal }) => {
    validating();
    await new Promise((_resolve, reject) =>
      signal.addEventListener(
        "abort",
        () =>
          reject(
            Object.assign(new Error("cancel fixture"), { name: "AbortError" }),
          ),
        { once: true },
      ),
    );
  };
  const queued = await f.service.repair({ modId: "123" });
  await entered;
  assert.equal(queued.operation, "repair");
  assert.equal((await f.service.getState()).job.status, "verifying");
  await assert.rejects(f.service.start({ modId: "456" }), /已有下载或安装任务/);
  await f.service.cancel();
  const result = await f.finished();
  assert.equal(result.job.status, "cancelled");
  assert.equal(result.installations[0].installationId, installationId);
  assert.deepEqual(f.calls, ["recover"]);
});

test("a changed installation after resolution prevents repair download and cannot resume", async (t) => {
  const f = await fixture(t),
    installationId = randomUUID();
  f.installations.push({
    modId: "123",
    revision: "1",
    installationId,
    archiveSha256: FIXTURE_HASH,
    descriptorPath: path.join(f.userDataPath, "mod", "pdx_123_1.mod"),
  });
  f.options.installer.verify = async () => ({
    status: "damaged",
    totalFiles: 1,
    checkedFiles: 1,
    changedFiles: 1,
    missingFiles: 0,
    extraFiles: 0,
    unsafeFiles: 0,
    issues: [],
    issuesTruncated: false,
  });
  const resolve = f.options.content.resolve;
  f.options.content.resolve = async (input) => {
    assert.equal(input.revision, "1");
    f.installations[0].installationId = randomUUID();
    return resolve(input);
  };
  await f.service.repair({ modId: "123" });
  const result = await f.finished();
  assert.equal(result.job.status, "failed");
  assert.equal(result.job.errorCode, "INSTALLATION_CHANGED");
  assert.equal(result.job.canResume, false);
  assert.deepEqual(f.calls, ["recover", "resolve"]);
});

async function fixture(t, additions = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ironclad-pdx-jobs-"));
  t.after(() =>
    fs.rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    }),
  );
  const calls = [],
    installations = [];
  const behavior = { running: false, fail: false, wait: false };
  const userDataPath = path.join(root, "game-user");
  const options = {
    storageDirectory: path.join(root, "jobs"),
    isGameRunning: async () => behavior.running,
    getUserDataPath: async () => userDataPath,
    content: {
      async resolve({ modId, revision, signal }) {
        calls.push("resolve");
        if (behavior.wait)
          await new Promise((resolve, reject) =>
            signal.addEventListener(
              "abort",
              () =>
                reject(
                  Object.assign(new Error("aborted"), { name: "AbortError" }),
                ),
              { once: true },
            ),
          );
        return {
          modId,
          revision: revision || "2",
          title: "Fixture",
          sha256: FIXTURE_HASH,
          name: "Fixture",
          platform: "Windows__default",
          filename: "content.zip",
          bytes: 11,
          archiveUrl: `https://modscontent.paradox-interactive.com/hoi4/Fixture/repo/Windows__default/${revision || "2"}/complete/content.zip`,
        };
      },
      async download(plan, { destination, bytesPerSecond, onProgress }) {
        calls.push(["download", bytesPerSecond]);
        if (behavior.fail) throw new Error("摘要不一致");
        await fs.writeFile(destination, "fixture zip", { flag: "wx" });
        onProgress({ receivedBytes: 11, totalBytes: 11, bytesPerSecond: 11 });
      },
    },
    installer: {
      recover: async () => {
        calls.push("recover");
      },
      list: async () => installations,
      async install({ plan, userDataPath: target }) {
        calls.push("install");
        const record = {
          modId: plan.modId,
          revision: plan.revision,
          archiveSha256: plan.sha256,
          descriptorPath: path.join(
            target,
            "mod",
            `pdx_${plan.modId}_${plan.revision}.mod`,
          ),
        };
        installations.push(record);
        return record;
      },
      async uninstall(modId) {
        calls.push(["uninstall", modId]);
        installations.splice(0);
      },
    },
  };
  Object.assign(options, additions);
  const service = createPdxDownloads(options);
  async function finished(target = service) {
    for (let i = 0; i < 100; i++) {
      if (!target.isBusy()) return target.getState();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("fixture did not finish");
  }
  return {
    root,
    service,
    calls,
    behavior,
    installations,
    options,
    finished,
    userDataPath,
  };
}

test("PDX jobs resolve, download, install, persist result and remove only their archive", async (t) => {
  const f = await fixture(t);
  const queued = await f.service.start({ modId: "123" });
  assert.equal(queued.status, "queued");
  assert.equal(queued.titleIsFallback, true);
  const state = await f.finished();
  assert.equal(state.job.status, "succeeded");
  assert.equal(state.job.title, "Fixture");
  assert.equal(Object.hasOwn(state.job, "titleIsFallback"), false);
  assert.equal(state.installations[0].revision, "2");
  assert.equal(state.job.progress.receivedBytes, 11);
  assert.deepEqual(await fs.readdir(f.options.storageDirectory), [
    "downloads.json",
  ]);
  const restarted = createPdxDownloads(f.options);
  assert.equal((await restarted.getState()).job.status, "succeeded");
});

test("completed downloads retain an independently verified original ZIP after staging cleanup", async (t) => {
  const {
    createPdxArchiveCache,
  } = require("../electron/pdx-archive-cache.cjs");
  const f = await fixture(t);
  const cache = createPdxArchiveCache({
    storageDirectory: path.join(f.root, "archives"),
  });
  let selected;
  f.options.archiveCache = {
    async put(plan, options) {
      selected = plan;
      return cache.put(plan, options);
    },
  };
  const service = createPdxDownloads(f.options);
  await service.start({ modId: "123" });
  assert.equal((await f.finished(service)).job.status, "succeeded");
  const lease = await createPdxArchiveCache({
    storageDirectory: path.join(f.root, "archives"),
  }).open(selected);
  assert.ok(lease);
  try {
    assert.equal((await lease.read(0, 11)).toString(), "fixture zip");
    assert.equal(lease.sha256, FIXTURE_HASH);
  } finally {
    await lease.close();
  }
  assert.deepEqual(await fs.readdir(f.options.storageDirectory), [
    "downloads.json",
  ]);
});

test("cache exhaustion and sanitized cache failures do not prevent a full-package installation", async (t) => {
  for (const cacheCode of ["CACHE_FULL", "CACHE_CHANGED", "EACCES"]) {
    const f = await fixture(t, {
      archiveCache: {
        async put() {
          throw Object.assign(new Error("private cache failure detail"), {
            code: cacheCode,
          });
        },
      },
    });
    await f.service.start({ modId: "123" });
    const state = await f.finished();
    assert.equal(state.job.status, "succeeded");
    assert.ok(f.calls.includes("install"));
    assert.equal(
      JSON.stringify(state).includes("private cache failure detail"),
      false,
    );
  }
});

function heldCache() {
  let entered;
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  let calls = 0;
  return {
    ready,
    async put(_plan, { signal }) {
      if (++calls > 1) return;
      entered();
      await new Promise((_resolve, reject) => {
        const cancel = () =>
          reject(
            Object.assign(new Error("cache cancelled"), { code: "CANCELLED" }),
          );
        if (signal.aborted) cancel();
        else signal.addEventListener("abort", cancel, { once: true });
      });
    },
  };
}

test("pausing during optional ZIP caching prevents install and resumes with a fresh plan", async (t) => {
  const cache = heldCache();
  const f = await fixture(t, { archiveCache: cache });
  await f.service.start({ modId: "123" });
  await cache.ready;
  assert.equal((await f.service.getState()).job.canPause, true);
  await f.service.pause();
  const paused = await f.finished();
  assert.equal(paused.job.status, "paused");
  assert.equal(paused.job.canResume, true);
  assert.equal(f.calls.includes("install"), false);
  await f.service.resume();
  const resumed = await f.finished();
  assert.equal(resumed.job.status, "succeeded");
  assert.equal(f.calls.filter((call) => call === "resolve").length, 2);
});

test("cancelling during ZIP caching prevents installation and clears known staging", async (t) => {
  const cache = heldCache();
  const f = await fixture(t, { archiveCache: cache });
  await f.service.start({ modId: "123" });
  await cache.ready;
  await f.service.cancel();
  const state = await f.finished();
  assert.equal(state.job.status, "cancelled");
  assert.equal(f.calls.includes("install"), false);
  assert.deepEqual(await fs.readdir(f.options.storageDirectory), [
    "downloads.json",
  ]);
});

function accountBinding() {
  const leases = [];
  return {
    leases,
    async bindSession({ signal }) {
      const controller = new AbortController();
      let reason,
        disposed = false;
      const cancel = () => {
        reason = "CANCELLED";
        controller.abort();
      };
      if (signal.aborted) cancel();
      else signal.addEventListener("abort", cancel, { once: true });
      const lease = {
        accountId: "account-fixture-identity",
        signal: controller.signal,
        check() {
          if (reason || disposed)
            throw Object.assign(new Error(reason || "disposed"), {
              code: reason || "CANCELLED",
            });
        },
        invalidate(code = "ACCOUNT_CHANGED") {
          reason = code;
          controller.abort();
        },
        dispose() {
          disposed = true;
          signal.removeEventListener("abort", cancel);
        },
        get disposed() {
          return disposed;
        },
      };
      leases.push(lease);
      return lease;
    },
  };
}

async function settled(service) {
  const deadline = Date.now() + 3000;
  while (service.isBusy()) {
    if (Date.now() > deadline) throw new Error("Download task did not settle");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return service.getState();
}

test("anonymous jobs never acquire or forward account identity", async (t) => {
  const f = await fixture(t),
    account = accountBinding();
  const resolve = f.options.content.resolve;
  f.options.content.resolve = (input) => {
    assert.equal(input.expectedAccountId, undefined);
    return resolve(input);
  };
  const service = createPdxDownloads({ ...f.options, account });
  await service.start({ modId: "123" });
  assert.equal((await settled(service)).job.authorization, "anonymous");
  assert.equal(account.leases.length, 0);
});

test("account changes during ZIP caching prevent installation and remain account errors", async (t) => {
  const f = await fixture(t),
    account = accountBinding();
  const service = createPdxDownloads({
    ...f.options,
    account,
    archiveCache: {
      async put(_plan, { signal }) {
        account.leases[0].invalidate();
        assert.equal(signal.aborted, true);
        throw Object.assign(new Error("cancel cache"), { code: "CANCELLED" });
      },
    },
  });
  await service.start({ modId: "123", authorization: "account" });
  const state = await settled(service);
  assert.equal(state.job.status, "failed");
  assert.equal(state.job.errorCode, "ACCOUNT_CHANGED");
  assert.equal(f.calls.includes("install"), false);
});

test("account jobs bind the complete pinned transfer and release identity without persisting it", async (t) => {
  const f = await fixture(t),
    account = accountBinding();
  const resolve = f.options.content.resolve,
    download = f.options.content.download,
    install = f.options.installer.install;
  f.options.content.resolve = (input) => {
    assert.equal(input.revision, "1");
    assert.equal(input.expectedAccountId, account.leases[0].accountId);
    assert.equal(input.signal instanceof AbortSignal, true);
    assert.equal(input.signal.aborted, false);
    return resolve(input);
  };
  f.options.content.download = (plan, options) => {
    assert.equal(options.signal, account.leases[0].signal);
    return download(plan, options);
  };
  f.options.installer.install = (input) => {
    assert.equal(input.signal, account.leases[0].signal);
    return install(input);
  };
  const service = createPdxDownloads({ ...f.options, account });
  await service.start({
    modId: "123",
    revision: "1",
    authorization: "account",
  });
  const state = await settled(service);
  assert.equal(state.job.status, "succeeded");
  assert.equal(state.job.authorization, "account");
  assert.equal(state.job.revision, "1");
  assert.equal(account.leases[0].disposed, true);
  const journal = await fs.readFile(
    path.join(f.options.storageDirectory, "downloads.json"),
    "utf8",
  );
  assert.equal(journal.includes(account.leases[0].accountId), false);
  assert.equal(/token|expectedAccountId|signal/.test(journal), false);
});

test("an unavailable account fails without falling back to anonymous content", async (t) => {
  const f = await fixture(t);
  const service = createPdxDownloads({
    ...f.options,
    account: {
      bindSession: async () => {
        throw Object.assign(new Error("请先登录"), { code: "NOT_SIGNED_IN" });
      },
    },
  });
  await assert.rejects(
    service.start({ modId: "123", authorization: "account" }),
    { code: "NOT_SIGNED_IN" },
  );
  assert.equal(service.isBusy(), false);
  assert.equal(f.calls.includes("resolve"), false);
  await assert.rejects(
    service.start({ modId: "123", authorization: "automatic" }),
    /下载/,
  );
  await assert.rejects(
    service.start({
      modId: "123",
      authorization: "account",
      expectedAccountId: "injected",
    }),
    /下载参数/,
  );
});

for (const stage of ["metadata", "transfer", "before-install"]) {
  test(`account invalidation at ${stage} prevents installation and remains actionable`, async (t) => {
    const f = await fixture(t),
      account = accountBinding();
    const resolve = f.options.content.resolve,
      download = f.options.content.download;
    let transferred = false;
    f.options.content.resolve = async (input) => {
      const result = await resolve(input);
      if (stage === "metadata") account.leases[0].invalidate();
      return result;
    };
    f.options.content.download = async (plan, options) => {
      await download(plan, options);
      transferred = true;
      if (stage === "transfer") {
        account.leases[0].invalidate();
        throw Object.assign(new Error("aborted transport"), {
          code: "CANCELLED",
        });
      }
    };
    const service = createPdxDownloads({
      ...f.options,
      account,
      assertOperationAllowed: async () => {
        if (stage === "before-install" && transferred)
          account.leases[0].invalidate("SESSION_EXPIRED");
      },
    });
    await service.start({
      modId: "123",
      revision: "1",
      authorization: "account",
    });
    const state = await settled(service);
    assert.equal(state.job.status, "failed");
    assert.equal(
      state.job.errorCode,
      stage === "before-install" ? "SESSION_EXPIRED" : "ACCOUNT_CHANGED",
    );
    assert.equal(f.calls.includes("install"), false);
    assert.equal(account.leases[0].disposed, true);
  });
}

test("user cancellation propagates to an account transfer and keeps cancellation semantics", async (t) => {
  const f = await fixture(t),
    account = accountBinding();
  f.behavior.wait = true;
  const service = createPdxDownloads({ ...f.options, account });
  await service.start({ modId: "123", authorization: "account" });
  await service.cancel();
  const state = await settled(service);
  assert.equal(state.job.status, "cancelled");
  assert.equal(account.leases[0].signal.aborted, true);
  assert.equal(account.leases[0].disposed, true);
  assert.equal(f.calls.includes("install"), false);
});

test("restarted account jobs require a new explicit action and a fresh binding", async (t) => {
  const f = await fixture(t),
    account = accountBinding();
  await f.service.ready();
  const journal = path.join(f.options.storageDirectory, "downloads.json");
  await fs.writeFile(
    journal,
    JSON.stringify({
      version: 1,
      bytesPerSecond: 0,
      job: {
        id: "interrupted",
        modId: "123",
        revision: "1",
        authorization: "account",
        status: "downloading",
      },
    }),
  );
  const service = createPdxDownloads({ ...f.options, account });
  assert.equal((await service.getState()).job.status, "interrupted");
  assert.equal(account.leases.length, 0);
  await service.start({
    modId: "123",
    revision: "1",
    authorization: "account",
  });
  assert.equal((await settled(service)).job.status, "succeeded");
  assert.equal(account.leases.length, 1);
});

test("account invalidation cannot overwrite a committed result or hide recovery failure", async (t) => {
  for (const recoveryRequired of [false, true]) {
    const f = await fixture(t),
      account = accountBinding();
    const install = f.options.installer.install;
    f.options.installer.install = async (input) => {
      account.leases[0].invalidate();
      if (recoveryRequired)
        throw Object.assign(new Error("恢复记录需处理"), {
          code: "RECOVERY_REQUIRED",
        });
      return install(input);
    };
    const service = createPdxDownloads({ ...f.options, account });
    await service.start({ modId: "123", authorization: "account" });
    const state = await settled(service);
    assert.equal(state.job.status, recoveryRequired ? "failed" : "succeeded");
    if (recoveryRequired)
      assert.equal(state.job.errorCode, "RECOVERY_REQUIRED");
  }
});

test("relocation gate blocks new downloads and uninstall before provider mutations", async (t) => {
  const f = await fixture(t);
  const guarded = createPdxDownloads({
    ...f.options,
    assertOperationAllowed: async () => {
      throw new Error("目录正在迁移");
    },
  });
  await assert.rejects(guarded.start({ modId: "123" }), /目录正在迁移/);
  await assert.rejects(guarded.uninstall("123"), /目录正在迁移/);
  assert.equal(f.calls.includes("resolve"), false);
  assert.equal(f.calls.some(Array.isArray), false);
  assert.equal(guarded.isBusy(), false);
});

test("a newly blocked storage gate prevents installation after the download completes", async (t) => {
  const f = await fixture(t);
  let blocked = false;
  const download = f.options.content.download;
  f.options.content.download = async (...args) => {
    await download(...args);
    blocked = true;
  };
  const guarded = createPdxDownloads({
    ...f.options,
    assertOperationAllowed: async () => {
      if (blocked) throw new Error("目录需要恢复");
    },
  });
  await guarded.start({ modId: "123" });
  for (let i = 0; guarded.isBusy() && i < 100; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal((await guarded.getState()).job.status, "failed");
  assert.equal(f.calls.includes("install"), false);
});

test("cancel interrupts metadata resolution and never reaches download or install", async (t) => {
  const f = await fixture(t);
  f.behavior.wait = true;
  await f.service.start({ modId: "123" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  await f.service.cancel();
  assert.equal((await f.finished()).job.status, "cancelled");
  assert.equal(f.calls.includes("install"), false);
  assert.equal(f.calls.some(Array.isArray), false);
});

test("one reserved job excludes concurrent starts, uninstall and preference changes", async (t) => {
  const f = await fixture(t);
  f.behavior.wait = true;
  const first = f.service.start({ modId: "123" });
  await assert.rejects(f.service.start({ modId: "456" }), /已有下载/);
  await first;
  await assert.rejects(f.service.uninstall("123"), /等待/);
  await assert.rejects(f.service.setLimit(1024), /下载结束/);
  await f.service.cancel();
  await f.finished();
});

test("failed downloads retain an existing installation and record actionable failure", async (t) => {
  const f = await fixture(t);
  f.behavior.fail = true;
  f.installations.push({
    modId: "123",
    revision: "1",
    descriptorPath: path.join(f.userDataPath, "mod", "old.mod"),
  });
  await f.service.start({ modId: "123" });
  const result = await f.finished();
  assert.equal(result.job.status, "failed");
  assert.match(result.job.error, /摘要/);
  assert.equal(result.installations[0].revision, "1");
});

test("already installed requested revision does not download again", async (t) => {
  const f = await fixture(t);
  f.installations.push({
    modId: "123",
    revision: "2",
    archiveSha256: FIXTURE_HASH,
    descriptorPath: path.join(f.userDataPath, "mod", "current.mod"),
  });
  await f.service.start({ modId: "123" });
  assert.match((await f.finished()).job.notice, /已是/);
  assert.equal(f.calls.includes("install"), false);
});

test("same revision in another game user directory is not mistaken for this installation", async (t) => {
  const f = await fixture(t);
  f.installations.push({
    modId: "123",
    revision: "2",
    descriptorPath: path.join(f.root, "another-user", "mod", "current.mod"),
  });
  await f.service.start({ modId: "123" });
  await f.finished();
  assert.equal(f.calls.includes("install"), true);
});

test("interrupted persisted jobs are reported, recovered and never automatically replayed", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(f.options.storageDirectory);
  await fs.writeFile(
    path.join(f.options.storageDirectory, "downloads.json"),
    JSON.stringify({
      version: 1,
      bytesPerSecond: 0,
      job: { id: "old", status: "installing" },
    }),
  );
  assert.equal((await f.service.getState()).job.status, "interrupted");
  assert.deepEqual(f.calls, ["recover"]);
});

test("limits persist, are applied to new downloads, and reject malformed values", async (t) => {
  const f = await fixture(t);
  for (const invalid of [-1, NaN, 0.1, "1024", 1024 ** 3 + 1])
    await assert.rejects(f.service.setLimit(invalid), /限速/);
  await f.service.setLimit(512 * 1024);
  await f.service.start({ modId: "123", revision: "3" });
  assert.equal((await f.finished()).job.revision, "3");
  assert.ok(
    f.calls.some((call) => Array.isArray(call) && call[1] === 512 * 1024),
  );
  assert.equal(
    (await createPdxDownloads(f.options).getState()).bytesPerSecond,
    512 * 1024,
  );
});

test("game guard and malformed renderer input prevent content operations", async (t) => {
  const f = await fixture(t);
  f.behavior.running = true;
  await assert.rejects(f.service.start({ modId: "123" }), /退出游戏/);
  await assert.rejects(f.service.uninstall("123"), /退出游戏/);
  for (const input of [
    { modId: "../123" },
    { modId: "123", url: "https://invalid/" },
    { modId: "123", revision: "bad" },
  ])
    await assert.rejects(f.service.start(input));
  assert.equal(f.calls.includes("resolve"), false);
  assert.equal(f.service.isBusy(), false);
});

test("corrupt journal fails without replacing it or contacting the network", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(f.options.storageDirectory);
  const journal = path.join(f.options.storageDirectory, "downloads.json");
  await fs.writeFile(journal, "invalid fixture");
  await assert.rejects(f.service.start({ modId: "123" }), /下载记录/);
  assert.equal(await fs.readFile(journal, "utf8"), "invalid fixture");
  assert.deepEqual(f.calls, []);
});

test("same revision with a changed upstream hash is rejected instead of reported current", async (t) => {
  const f = await fixture(t);
  f.installations.push({
    modId: "123",
    revision: "2",
    archiveSha256: "different",
    descriptorPath: path.join(f.userDataPath, "mod", "current.mod"),
  });
  await f.service.start({ modId: "123" });
  const result = await f.finished();
  assert.equal(result.job.status, "failed");
  assert.match(result.job.error, /摘要发生变化/);
});

test("cancel cannot mask an install failure requiring transaction recovery", async (t) => {
  const f = await fixture(t);
  f.options.installer.install = async () => {
    await f.service.cancel();
    throw Object.assign(new Error("安装恢复记录已保留，请先执行恢复。"), {
      name: "AbortError",
      code: "RECOVERY_REQUIRED",
    });
  };
  await f.service.start({ modId: "123" });
  const result = await f.finished();
  assert.equal(result.job.status, "failed");
  assert.match(result.job.error, /恢复记录/);
});

test("failed network download removes its empty task directory", async (t) => {
  const f = await fixture(t);
  f.behavior.fail = true;
  await f.service.start({ modId: "123" });
  await f.finished();
  assert.deepEqual(await fs.readdir(f.options.storageDirectory), [
    "downloads.json",
  ]);
});

test("restart preserves an interrupted archive with unknown ownership and reports its location", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(f.options.storageDirectory);
  const directory = await fs.mkdtemp(
    path.join(f.options.storageDirectory, "download-"),
  );
  const info = await fs.lstat(directory);
  await fs.writeFile(
    path.join(directory, "content.zip"),
    "unknown partial archive",
  );
  await fs.writeFile(
    path.join(f.options.storageDirectory, "downloads.json"),
    JSON.stringify({
      version: 1,
      bytesPerSecond: 0,
      job: { id: "old", status: "downloading" },
      staging: {
        directory: path.basename(directory),
        identity: {
          ino: info.ino,
          dev: info.dev,
          birthtimeMs: info.birthtimeMs,
        },
        archiveIdentity: null,
      },
    }),
  );
  const result = await f.service.getState();
  assert.equal(result.job.retainedDownloadDirectory, directory);
  assert.equal(
    await fs.readFile(path.join(directory, "content.zip"), "utf8"),
    "unknown partial archive",
  );
});

test("initial transaction recovery reserves the launcher gate and transient failures can retry", async (t) => {
  const f = await fixture(t);
  let attempts = 0;
  f.options.installer.recover = async () => {
    attempts++;
    if (attempts === 1) throw new Error("game running");
  };
  const first = f.service.ready();
  assert.equal(f.service.isBusy(), true);
  await assert.rejects(first, /game running/);
  assert.equal(f.service.isBusy(), false);
  await f.service.ready();
  assert.equal(attempts, 2);
});

test("progress remains readable while an installation is pending", async (t) => {
  const f = await fixture(t);
  let release, entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  f.options.installer.install = async () => {
    entered();
    await new Promise((resolve) => {
      release = resolve;
    });
    return { modId: "123", revision: "2" };
  };
  await f.service.start({ modId: "123" });
  await started;
  // A real installer's list is queued behind its current install.
  f.options.installer.list = async () => {
    throw new Error("must not wait on list during install");
  };
  const state = await f.service.getState();
  assert.equal(state.job.status, "installing");
  release();
  f.options.installer.list = async () => [];
  await f.finished();
});

test("changing game user directory during transfer aborts before installation", async (t) => {
  const f = await fixture(t);
  let reads = 0;
  const service = createPdxDownloads({
    ...f.options,
    getUserDataPath: async () =>
      ++reads === 1 ? f.userDataPath : path.join(f.root, "changed-user"),
  });
  await service.start({ modId: "123" });
  for (let i = 0; i < 100 && service.isBusy(); i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(service.isBusy(), false);
  assert.equal((await service.getState()).job.status, "failed");
  assert.match((await service.getState()).job.error, /目录.*变化/);
  assert.equal(f.calls.includes("install"), false);
});

test("a first-use limit save failure restores the persisted value loaded during initialization", async (t) => {
  const f = await fixture(t);
  await f.service.setLimit(512);
  const service = createPdxDownloads(f.options);
  const rename = fs.rename;
  let writes = 0;
  t.mock.method(fs, "rename", async (...args) => {
    if (++writes === 2)
      throw Object.assign(new Error("fixture save failure"), {
        code: "EACCES",
      });
    return rename(...args);
  });
  await assert.rejects(service.setLimit(1024), /无法保存/);
  assert.equal(service.isBusy(), false);
  assert.equal((await service.getState()).bytesPerSecond, 512);
  const journal = JSON.parse(
    await fs.readFile(
      path.join(f.options.storageDirectory, "downloads.json"),
      "utf8",
    ),
  );
  assert.equal(journal.bytesPerSecond, 512);
});
