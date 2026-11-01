"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");
const { createPdxDownloads } = require("../electron/pdx-downloads.cjs");
const {
  identity,
  planKey,
  checkpointFile,
} = require("../electron/pdx-download-checkpoint.cjs");
const bytes = Buffer.from("verified fixture archive");
const digest = (data) => createHash("sha256").update(data).digest("hex");
const coded = (code) => Object.assign(new Error(code), { code });

async function until(check) {
  const deadline = Date.now() + 3000;
  while (!(await check())) {
    if (Date.now() > deadline)
      throw new Error("job did not reach expected phase");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
async function checkpoint(source, plan, count) {
  const file = await fs.lstat(source, { bigint: true });
  const record = (info) => ({
    dev: String(info.dev),
    ino: String(info.ino),
    birthtimeNs: String(info.birthtimeNs),
  });
  const ancestors = [];
  let directory = path.dirname(source);
  for (;;) {
    ancestors.unshift({
      path: directory,
      ...record(await fs.lstat(directory, { bigint: true })),
    });
    const parent = path.dirname(directory);
    if (directory === parent) break;
    directory = parent;
  }
  return {
    version: 1,
    planKey: planKey(plan),
    receivedBytes: count,
    prefixSha256: digest((await fs.readFile(source)).subarray(0, count)),
    etag: '"fixture-v1"',
    identity: { file: record(file), ancestors },
  };
}
async function fixture(t) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "ironclad-resume-jobs-"),
  );
  const storageDirectory = path.join(root, "downloads"),
    journal = path.join(storageDirectory, "downloads.json");
  const state = {
    userDataPath: path.join(root, "user"),
    complete: false,
    resolveHold: false,
    overrides: {},
  };
  const resolutions = [],
    transfers = [],
    installs = [],
    leases = [],
    services = [];
  const options = {
    storageDirectory,
    getUserDataPath: async () => state.userDataPath,
    account: {
      async bindSession({ signal }) {
        const controller = new AbortController();
        let failure;
        const cancel = () => {
          failure = "CANCELLED";
          controller.abort();
        };
        signal.addEventListener("abort", cancel, { once: true });
        const lease = {
          accountId: "account-private-fixture",
          signal: controller.signal,
          check() {
            if (failure) throw coded(failure);
          },
          invalidate() {
            failure = "ACCOUNT_CHANGED";
            controller.abort();
          },
          dispose() {
            lease.disposed = true;
            signal.removeEventListener("abort", cancel);
          },
        };
        leases.push(lease);
        return lease;
      },
    },
    content: {
      async resolve(input) {
        resolutions.push(input);
        if (state.resolveHold)
          await new Promise((resolve, reject) =>
            input.signal.addEventListener(
              "abort",
              () => reject(coded("CANCELLED")),
              { once: true },
            ),
          );
        return {
          modId: input.modId,
          revision: input.revision || "2",
          name: "fixture",
          platform: "Windows__default",
          filename: "content.zip",
          archiveUrl: `https://modscontent.paradox-interactive.com/hoi4/fixture/repo/Windows__default/${input.revision || "2"}/complete/content.zip`,
          bytes: bytes.length,
          sha256: digest(bytes),
          title: "Fixture",
          ...state.overrides,
        };
      },
      async download(plan, transfer) {
        transfers.push(transfer);
        const {
          destination,
          resume,
          signal,
          pauseSignal,
          onCheckpoint,
          onProgress,
        } = transfer;
        await fs.writeFile(destination, "", { flag: "wx" });
        await onCheckpoint(await checkpoint(destination, plan, 0));
        let count = 4;
        if (resume) {
          await checkpointFile(resume.source, resume.checkpoint);
          const data = await fs.readFile(resume.source);
          if (
            digest(data.subarray(0, resume.checkpoint.receivedBytes)) !==
            resume.checkpoint.prefixSha256
          )
            throw coded("SOURCE_CHANGED");
          count = resume.checkpoint.receivedBytes;
          await fs.appendFile(destination, data.subarray(0, count));
        } else await fs.appendFile(destination, bytes.subarray(0, count));
        if (state.beforeCheckpoint)
          await state.beforeCheckpoint({ plan, transfer, count });
        await onCheckpoint(await checkpoint(destination, plan, count));
        if (state.afterCheckpoint)
          await state.afterCheckpoint({ plan, transfer, count });
        onProgress({ receivedBytes: count, totalBytes: bytes.length });
        if (!state.complete)
          await new Promise((resolve, reject) => {
            const remove = () => {
              pauseSignal.removeEventListener("abort", pause);
              signal.removeEventListener("abort", cancel);
            };
            const pause = () => {
                remove();
                resolve();
              },
              cancel = () => {
                remove();
                reject(coded("CANCELLED"));
              };
            if (signal.aborted) cancel();
            else if (pauseSignal.aborted) pause();
            else {
              pauseSignal.addEventListener("abort", pause, { once: true });
              signal.addEventListener("abort", cancel, { once: true });
            }
          });
        signal.throwIfAborted();
        if (pauseSignal.aborted)
          return {
            paused: true,
            checkpoint: await checkpoint(destination, plan, count),
            bytes: count,
          };
        await fs.appendFile(destination, bytes.subarray(count));
        await onCheckpoint(await checkpoint(destination, plan, bytes.length));
        return {
          path: destination,
          bytes: bytes.length,
          sha256: digest(bytes),
        };
      },
    },
    installer: {
      recover: async () => {},
      list: async () => [],
      async install(input) {
        installs.push(input);
        if (state.installHold) await state.installHold;
        return { modId: input.plan.modId, revision: input.plan.revision };
      },
    },
  };
  const open = () => {
    const service = createPdxDownloads(options);
    services.push(service);
    return service;
  };
  const settled = async (service) => {
    await until(() => !service.isBusy());
    return service.getState();
  };
  const pause = async (service, authorization = "anonymous") => {
    await service.start({ modId: "123", authorization });
    await until(
      async () => (await service.getState()).job.progress?.receivedBytes === 4,
    );
    assert.equal((await service.pause()).status, "pausing");
    const result = await settled(service);
    assert.equal(result.job.status, "paused");
    return result;
  };
  const read = async () => JSON.parse(await fs.readFile(journal, "utf8"));
  t.after(async () => {
    for (const service of services) service.dispose();
    await until(() => services.every((service) => !service.isBusy()));
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("ironclad-resume-jobs-"));
    await fs.rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  });
  return {
    root,
    journal,
    storageDirectory,
    state,
    options,
    resolutions,
    transfers,
    installs,
    leases,
    open,
    pause,
    settled,
    read,
  };
}

test("pausing metadata aborts promptly, releases the lease and resumes with a new lease", async (t) => {
  const f = await fixture(t),
    service = f.open();
  f.state.resolveHold = true;
  await service.start({ modId: "123", authorization: "account" });
  await until(() => f.resolutions.length === 1);
  await service.pause();
  const paused = await f.settled(service);
  assert.equal(paused.job.status, "paused");
  assert.equal(paused.job.canResume, true);
  assert.equal(paused.job.canPause, false);
  assert.equal(f.leases[0].disposed, true);
  assert.equal(f.transfers.length, 0);
  assert.equal((await f.read()).partial.checkpoint, null);
  await assert.rejects(service.start({ modId: "456" }), /恢复或取消/);
  f.state.resolveHold = false;
  f.state.complete = true;
  await service.resume();
  assert.equal((await f.settled(service)).job.status, "succeeded");
  assert.equal(f.leases.length, 2);
  assert.equal(f.leases[1].disposed, true);
  assert.equal(f.resolutions[1].expectedAccountId, f.leases[1].accountId);
});

test("paused progress is durable and a resumed source is cleaned only after the new checkpoint is saved", async (t) => {
  const f = await fixture(t),
    service = f.open();
  await f.pause(service, "account");
  const saved = await f.read(),
    source = path.join(
      f.storageDirectory,
      saved.staging.directory,
      "content.zip",
    );
  assert.equal(saved.version, 2);
  assert.equal(saved.partial.checkpoint.receivedBytes, 4);
  f.state.complete = true;
  f.state.beforeCheckpoint = async ({ transfer }) => {
    assert.equal(transfer.resume.source, source);
    assert.equal(
      await fs.readFile(source, "utf8"),
      bytes.subarray(0, 4).toString(),
    );
    const intermediate = await f.read();
    assert.equal(
      intermediate.resumeSource.staging.directory,
      saved.staging.directory,
    );
    assert.equal(intermediate.partial.checkpoint.receivedBytes, 0);
  };
  f.state.afterCheckpoint = async ({ count }) => {
    const recorded = await f.read();
    assert.equal(recorded.partial.checkpoint.receivedBytes, count);
    await assert.rejects(fs.stat(source), { code: "ENOENT" });
  };
  const resumed = service.resume();
  await assert.rejects(service.resume(), /已有下载/);
  await resumed;
  assert.equal((await f.settled(service)).job.status, "succeeded");
  assert.equal(f.resolutions[1].revision, "2");
  assert.equal(f.leases.length, 2);
  assert.notEqual(f.transfers[1].destination, source);
  assert.deepEqual(await fs.readdir(f.storageDirectory), ["downloads.json"]);
  assert.equal(
    (await fs.readFile(f.journal, "utf8")).includes("account-private-fixture"),
    false,
  );
});

test("an interrupted restart stays offline until resume and shutdown preserves its checkpoint", async (t) => {
  const f = await fixture(t),
    service = f.open();
  await service.start({ modId: "123", authorization: "account" });
  await until(
    async () => (await service.getState()).job.progress?.receivedBytes === 4,
  );
  service.dispose();
  assert.equal((await f.settled(service)).job.status, "interrupted");
  assert.equal((await f.read()).partial.checkpoint.receivedBytes, 4);
  const reopened = f.open();
  assert.equal((await reopened.getState()).job.canResume, true);
  assert.equal(f.resolutions.length, 1);
  assert.equal(f.leases.length, 1);
  f.state.complete = true;
  await reopened.resume();
  assert.equal((await f.settled(reopened)).job.status, "succeeded");
  assert.equal(f.leases.length, 2);
});

test("account invalidation outranks pause and leaves a recoverable trusted checkpoint", async (t) => {
  const f = await fixture(t),
    service = f.open();
  await service.start({ modId: "123", authorization: "account" });
  await until(
    async () => (await service.getState()).job.progress?.receivedBytes === 4,
  );
  const pause = service.pause();
  f.leases[0].invalidate();
  await pause;
  const failed = await f.settled(service);
  assert.equal(failed.job.status, "failed");
  assert.equal(failed.job.errorCode, "ACCOUNT_CHANGED");
  assert.equal(failed.job.canResume, true);
  assert.equal(f.installs.length, 0);
  assert.equal(f.leases[0].disposed, true);
});

test("paused cancellation deletes only the registered archive and clears the new-start gate", async (t) => {
  const f = await fixture(t),
    service = f.open();
  await f.pause(service);
  await assert.rejects(service.resume({ source: "injected" }), /外部路径/);
  await assert.rejects(service.start({ modId: "456" }), /恢复或取消/);
  await service.cancel();
  assert.deepEqual(await fs.readdir(f.storageDirectory), ["downloads.json"]);
  assert.equal((await service.getState()).job.canResume, false);
  f.state.complete = true;
  await service.start({ modId: "456" });
  assert.equal((await f.settled(service)).job.status, "succeeded");
});

test("cancelling a source with an unknown tail preserves its bytes and reports its location after restart", async (t) => {
  const f = await fixture(t),
    service = f.open();
  await f.pause(service);
  const saved = await f.read(),
    directory = path.join(f.storageDirectory, saved.staging.directory),
    source = path.join(directory, "content.zip");
  await fs.appendFile(source, "unknown tail");
  const before = await fs.readFile(source);
  await service.cancel();
  const result = await f.open().getState();
  assert.equal(result.job.status, "cancelled");
  assert.ok(result.job.retainedDownloadDirectories.includes(directory));
  assert.deepEqual(await fs.readFile(source), before);
});

for (const change of [
  "hash",
  "name",
  "user-directory",
  "replace-source",
  "modify-prefix",
]) {
  test(`resume rejects ${change} and preserves the original fragment until explicit cancellation`, async (t) => {
    const f = await fixture(t),
      service = f.open();
    await f.pause(service);
    const saved = await f.read(),
      directory = path.join(f.storageDirectory, saved.staging.directory),
      source = path.join(directory, "content.zip");
    if (change === "hash") f.state.overrides.sha256 = "a".repeat(64);
    if (change === "name") {
      f.state.overrides.name = "changed";
      f.state.overrides.archiveUrl = saved.partial.plan.archiveUrl.replace(
        "/fixture/",
        "/changed/",
      );
    }
    if (change === "user-directory")
      f.state.userDataPath = path.join(f.root, "changed-user");
    if (change === "replace-source") {
      await fs.rename(source, source + ".original");
      await fs.writeFile(source, "replacement");
    }
    if (change === "modify-prefix") await fs.writeFile(source, "evil");
    const before = await fs.readFile(source);
    f.state.complete = true;
    if (change === "user-directory") {
      await assert.rejects(service.resume(), { code: "USER_DATA_CHANGED" });
      const otherInstance = await service.getState();
      assert.equal(otherInstance.job.status, "paused");
      assert.equal(otherInstance.job.canResume, true);
      assert.deepEqual(await f.read(), saved);
      assert.deepEqual(await fs.readFile(source), before);
      assert.equal(f.installs.length, 0);
      f.state.userDataPath = saved.partial.userDataPath;
      await service.resume();
      const resumed = await f.settled(service);
      assert.equal(resumed.job.status, "succeeded");
      assert.equal(f.installs.length, 1);
      return;
    } else await service.resume();
    const result = await f.settled(service);
    assert.equal(result.job.status, "failed");
    assert.equal(result.job.canResume, false);
    assert.equal(result.job.canCancel, true);
    assert.equal(f.installs.length, 0);
    assert.deepEqual(await fs.readFile(source), before);
    assert.ok(result.job.retainedDownloadDirectories.includes(directory));
    await assert.rejects(service.start({ modId: "456" }), /恢复或取消/);
    await service.cancel();
    if (["replace-source", "modify-prefix"].includes(change))
      assert.deepEqual(await fs.readFile(source), before);
  });
}

test("crash during prefix copying keeps the larger old checkpoint and retains the incomplete copy", async (t) => {
  const f = await fixture(t),
    first = f.open();
  await f.pause(first);
  first.dispose();
  const saved = await f.read(),
    originalSource = path.join(
      f.storageDirectory,
      saved.staging.directory,
      "content.zip",
    );
  const newDirectory = await fs.mkdtemp(
      path.join(f.storageDirectory, "download-"),
    ),
    newSource = path.join(newDirectory, "content.zip");
  await fs.writeFile(newSource, "");
  saved.resumeSource = { staging: saved.staging, partial: saved.partial };
  saved.staging = {
    directory: path.basename(newDirectory),
    identity: identity(await fs.lstat(newDirectory)),
    archiveIdentity: identity(await fs.lstat(newSource)),
  };
  saved.partial = {
    ...saved.partial,
    checkpoint: await checkpoint(newSource, saved.partial.plan, 0),
  };
  saved.job.status = "downloading";
  await fs.writeFile(f.journal, JSON.stringify(saved));
  const service = f.open();
  assert.equal((await service.getState()).job.status, "interrupted");
  assert.equal(f.resolutions.length, 1);
  f.state.complete = true;
  await service.resume();
  const result = await f.settled(service);
  assert.equal(result.job.status, "succeeded");
  assert.equal(f.transfers[1].resume.source, originalSource);
  assert.equal(f.transfers[1].resume.checkpoint.receivedBytes, 4);
  assert.ok(result.job.retainedDownloadDirectories.includes(newDirectory));
  assert.equal((await fs.stat(newSource)).size, 0);
});

test("checkpoint persistence failure preserves the old source and its durable resume record", async (t) => {
  const f = await fixture(t),
    service = f.open();
  await f.pause(service);
  const saved = await f.read(),
    source = path.join(
      f.storageDirectory,
      saved.staging.directory,
      "content.zip",
    );
  const rename = fs.rename;
  let fail = false;
  t.mock.method(fs, "rename", async (...args) => {
    if (fail && args[1] === f.journal) throw coded("EACCES");
    return rename(...args);
  });
  f.state.beforeCheckpoint = async () => {
    fail = true;
  };
  f.state.complete = true;
  await service.resume();
  const result = await f.settled(service);
  fail = false;
  assert.equal(result.job.status, "failed");
  assert.equal(result.job.errorCode, "CHECKPOINT_ERROR");
  assert.deepEqual(await fs.readFile(source), bytes.subarray(0, 4));
  const disk = await f.read();
  assert.equal(disk.resumeSource.partial.checkpoint.receivedBytes, 4);
  assert.equal(disk.resumeSource.staging.directory, saved.staging.directory);
  f.state.beforeCheckpoint = null;
  const reopened = f.open();
  await reopened.resume();
  assert.equal((await f.settled(reopened)).job.status, "succeeded");
});

for (const action of ["resume", "cancel"]) {
  test(`restart can ${action} when saving stops immediately after selecting an old source over an uncheckpointed copy`, async (t) => {
    const f = await fixture(t),
      first = f.open();
    await f.pause(first);
    first.dispose();
    const saved = await f.read(),
      originalDirectory = saved.staging.directory;
    const source = path.join(
      f.storageDirectory,
      originalDirectory,
      "content.zip",
    );
    const copyDirectory = await fs.mkdtemp(
      path.join(f.storageDirectory, "download-"),
    );
    const copySource = path.join(copyDirectory, "content.zip");
    await fs.writeFile(copySource, "copy did not reach its first checkpoint");
    saved.resumeSource = { staging: saved.staging, partial: saved.partial };
    saved.staging = {
      directory: path.basename(copyDirectory),
      identity: identity(await fs.lstat(copyDirectory)),
      archiveIdentity: null,
    };
    saved.partial = { ...saved.partial, checkpoint: null };
    saved.job.status = "downloading";
    await fs.writeFile(f.journal, JSON.stringify(saved));

    const service = f.open(),
      rename = fs.rename;
    let stopSaving = false,
      selected;
    t.mock.method(fs, "rename", async (...args) => {
      if (args[1] !== f.journal) return rename(...args);
      if (stopSaving) throw coded("EACCES");
      const next = JSON.parse(await fs.readFile(args[0], "utf8"));
      await rename(...args);
      if (next.staging?.directory === originalDirectory) {
        selected = next;
        stopSaving = true;
      }
    });
    await service.resume();
    await f.settled(service);
    assert.ok(
      selected,
      "test must stop at the source-selection journal boundary",
    );
    assert.equal(selected.resumeSource, null);
    assert.equal(selected.partial.checkpoint.receivedBytes, 4);
    assert.ok(selected.job.retainedDownloadDirectories.includes(copyDirectory));
    assert.deepEqual(await f.read(), selected);
    assert.deepEqual(await fs.readFile(source), bytes.subarray(0, 4));
    assert.equal(
      await fs.readFile(copySource, "utf8"),
      "copy did not reach its first checkpoint",
    );

    // The saved state is exactly the crash boundary, without any later repair.
    t.mock.restoreAll();
    service.dispose();
    const reopened = f.open();
    const recovered = await reopened.getState();
    assert.equal(recovered.job.status, "interrupted");
    assert.equal(recovered.job.canResume, true);
    assert.equal(recovered.job.canCancel, true);
    if (action === "resume") {
      f.state.complete = true;
      await reopened.resume();
      assert.equal((await f.settled(reopened)).job.status, "succeeded");
      assert.equal(f.transfers.at(-1).resume.source, source);
    } else {
      await reopened.cancel();
      assert.equal((await reopened.getState()).job.status, "cancelled");
    }
    assert.equal(
      await fs.readFile(copySource, "utf8"),
      "copy did not reach its first checkpoint",
    );
  });
}

test("installation cannot be paused and its status stays readable without waiting for installer.list", async (t) => {
  const f = await fixture(t),
    service = f.open();
  f.state.complete = true;
  let release;
  f.state.installHold = new Promise((resolve) => {
    release = resolve;
  });
  await service.start({ modId: "123" });
  await until(() => f.installs.length === 1);
  f.options.installer.list = async () => {
    throw new Error("do not queue behind install");
  };
  assert.equal((await service.getState()).job.status, "installing");
  assert.equal((await service.getState()).job.canPause, false);
  await assert.rejects(service.pause(), /无法暂停/);
  f.options.installer.list = async () => [];
  release();
  assert.equal((await f.settled(service)).job.status, "succeeded");
});

test("an invalid v2 checkpoint leaves the journal and archive untouched and stays offline", async (t) => {
  const f = await fixture(t),
    first = f.open();
  await f.pause(first);
  first.dispose();
  const saved = await f.read(),
    source = path.join(
      f.storageDirectory,
      saved.staging.directory,
      "content.zip",
    );
  saved.partial.checkpoint.identity.ancestors[0].path = f.root;
  const malformed = JSON.stringify(saved);
  await fs.writeFile(f.journal, malformed);
  await assert.rejects(f.open().ready(), /下载记录/);
  assert.equal(await fs.readFile(f.journal, "utf8"), malformed);
  assert.deepEqual(await fs.readFile(source), bytes.subarray(0, 4));
  assert.equal(f.resolutions.length, 1);
});

test("a retryable transport failure resumes the saved bytes after fresh metadata authorization", async (t) => {
  const f = await fixture(t),
    service = f.open();
  f.state.afterCheckpoint = async () => {
    throw coded("DOWNLOAD_FAILED");
  };
  await service.start({ modId: "123", authorization: "account" });
  const failed = await f.settled(service);
  assert.equal(failed.job.status, "failed");
  assert.equal(failed.job.canResume, true);
  const saved = await f.read();
  assert.equal(saved.partial.checkpoint.receivedBytes, 4);
  assert.equal(f.installs.length, 0);
  f.state.afterCheckpoint = null;
  f.state.complete = true;
  await service.resume();
  assert.equal((await f.settled(service)).job.status, "succeeded");
  assert.equal(f.leases.length, 2);
  assert.equal(f.resolutions[1].revision, "2");
});

test("a package hash failure blocks resuming and leaves its checkpoint available for safe explicit cancellation", async (t) => {
  const f = await fixture(t),
    service = f.open();
  f.state.afterCheckpoint = async () => {
    throw coded("HASH_MISMATCH");
  };
  await service.start({ modId: "123" });
  const failed = await f.settled(service);
  assert.equal(failed.job.status, "failed");
  assert.equal(failed.job.canResume, false);
  assert.equal(failed.job.canCancel, true);
  const saved = await f.read(),
    source = path.join(
      f.storageDirectory,
      saved.staging.directory,
      "content.zip",
    );
  assert.deepEqual(await fs.readFile(source), bytes.subarray(0, 4));
  await assert.rejects(service.resume(), /没有可恢复/);
  await service.cancel();
  await assert.rejects(fs.stat(source), { code: "ENOENT" });
});
