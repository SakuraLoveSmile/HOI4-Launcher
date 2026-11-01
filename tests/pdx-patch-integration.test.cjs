"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createPdxContentService } = require("../electron/pdx-content.cjs");
const { createPdxDownloads } = require("../electron/pdx-downloads.cjs");
const { createPdxInstallService } = require("../electron/pdx-install.cjs");
const { createPdxArchiveCache } = require("../electron/pdx-archive-cache.cjs");
const { fileResource } = require("../electron/pdx-repository.cjs");
const {
  createPatchFixture,
  digest,
} = require("./fixtures/pdx-patches/create-fixture.cjs");
async function until(predicate) {
  const deadline = Date.now() + 15000;
  while (!(await predicate())) {
    if (Date.now() > deadline)
      throw new Error("Patch integration did not settle");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "ironclad-patch-integration-"),
  );
  const data = await createPatchFixture({
    ...options,
    sessionPath: path.join(root, "account.session"),
  });
  const userDataPath = path.join(root, "user");
  await fs.mkdir(userDataPath);
  const installer = createPdxInstallService({
    storageDirectory: path.join(root, "installed"),
  });
  const installAttempts = [],
    install = installer.install;
  installer.install = (input) => {
    installAttempts.push({
      modId: input.plan.modId,
      revision: input.plan.revision,
    });
    return install(input);
  };
  const cache = createPdxArchiveCache({
    storageDirectory: path.join(root, "archives"),
  });
  const services = [];
  const content = () =>
    createPdxContentService({
      account: data.account,
      integrity: data.integrity(),
      fetchImpl: data.fetchImpl,
    });
  const serviceOptions = {
    storageDirectory: path.join(root, "downloads"),
    installer,
    archiveCache: cache,
    account: data.account,
    getUserDataPath: async () => userDataPath,
  };
  const open = () => {
    const service = createPdxDownloads({
      ...serviceOptions,
      content: content(),
    });
    services.push(service);
    return service;
  };
  const settled = async (service) => {
    await until(() => !service.isBusy());
    return service.getState();
  };
  const journal = async () =>
    JSON.parse(
      await fs.readFile(
        path.join(serviceOptions.storageDirectory, "downloads.json"),
        "utf8",
      ),
    );
  await data.login();
  async function seed(revision = "1") {
    data.controls.latest = revision;
    const service = open();
    await service.start({ modId: "123", authorization: "account" });
    const state = await settled(service);
    assert.equal(state.job.status, "succeeded", state.job.error);
    data.controls.latest = "2";
    return state.installations[0];
  }
  t.after(async () => {
    for (const service of services) service.dispose();
    await until(() => services.every((service) => !service.isBusy()));
    await data.account.logout();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("ironclad-patch-integration-"));
    await fs.rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  });
  return {
    root,
    data,
    userDataPath,
    installer,
    installAttempts,
    cache,
    content,
    options: serviceOptions,
    open,
    settled,
    journal,
    seed,
  };
}

async function pauseDelta(f) {
  const original = await f.seed();
  f.data.controls.hold = "2/1_to_2/1_to_2.zip";
  const service = f.open();
  await service.start({ modId: "123", authorization: "account" });
  await until(
    async () => (await service.getState()).job.progress?.receivedBytes === 64,
  );
  await service.pause();
  assert.equal((await f.settled(service)).job.status, "paused");
  const saved = await f.journal();
  const partialPath = path.join(
    f.options.storageDirectory,
    saved.staging.directory,
    "patch.zip",
  );
  const partialBytes = await fs.readFile(partialPath);
  assert.deepEqual(partialBytes, f.data.patch.subarray(0, 64));
  const descriptor = await fs.readFile(original.descriptorPath);
  service.dispose();
  return { original, saved, partialPath, partialBytes, descriptor };
}

async function assertOriginal(f, state, original, text = "original event\n") {
  assert.equal(state.installations.length, 1);
  assert.equal(state.installations[0].installationId, original.installationId);
  assert.equal(
    f.installAttempts.length,
    1,
    "no replacement installation starts",
  );
  assert.equal(
    await fs.readFile(
      path.join(original.contentPath, "events/fixture.txt"),
      "utf8",
    ),
    text,
  );
}

test("signed empty operation patch survives pause and reopen with zero unpacked bytes", async (t) => {
  const f = await fixture(t, { variant: "unchanged" });
  const { original, saved } = await pauseDelta(f);
  assert.equal(saved.partial.transferPlan.unpackedBytes, 0);
  assert.equal(saved.partial.plan.sha256, saved.partial.sourcePlan.sha256);
  const before = f.data.requests.length;
  const service = f.open();
  assert.equal((await service.getState()).job.canResume, true);
  assert.equal(
    f.data.requests.length,
    before,
    "reopening does not request any resource",
  );
  await service.resume();
  const state = await f.settled(service);
  assert.equal(state.job.status, "succeeded", state.job.error);
  assert.equal(state.installations[0].revision, "2");
  assert.equal(state.installations[0].archiveSha256, digest(f.data.source));
  const bodyRequests = f.data.requests
    .slice(before)
    .filter((item) => item.resource.endsWith(".zip"));
  assert.deepEqual(
    bodyRequests.map(({ resource, range }) => ({ resource, range })),
    [{ resource: "2/1_to_2/1_to_2.zip", range: "bytes=64-" }],
  );
  for (const installed of [original, state.installations[0]])
    assert.equal(
      await fs.readFile(
        path.join(installed.contentPath, "events/fixture.txt"),
        "utf8",
      ),
      "original event\n",
    );
  const checked = await f.installer.verify("123", {
    userDataPath: f.userDataPath,
    installationId: state.installations[0].installationId,
  });
  assert.equal(checked.status, "intact");
  assert.deepEqual(await fs.readdir(f.options.storageDirectory), [
    "downloads.json",
  ]);
  f.data.assertNoSecrets([state, await f.journal()]);
});

test("signed delete-and-new patch replaces only the isolated target transaction", async (t) => {
  const f = await fixture(t, { variant: "replacement" }),
    original = await f.seed();
  assert.ok(f.data.patch.length < f.data.target.length);
  const before = f.data.requests.length,
    service = f.open();
  await service.start({ modId: "123", authorization: "account" });
  const state = await f.settled(service);
  assert.equal(state.job.status, "succeeded", state.job.error);
  assert.deepEqual(
    f.data.requests
      .slice(before)
      .filter((item) => item.resource.endsWith(".zip"))
      .map((item) => item.resource),
    ["2/1_to_2/1_to_2.zip"],
  );
  assert.equal(state.installations[0].archiveSha256, digest(f.data.target));
  assert.equal(
    await fs.readFile(
      path.join(original.contentPath, "events/fixture.txt"),
      "utf8",
    ),
    "original event\n",
  );
  assert.equal(
    await fs.readFile(
      path.join(state.installations[0].contentPath, "events/fixture.txt"),
      "utf8",
    ),
    "modified event\n",
  );
  assert.deepEqual(await fs.readdir(f.options.storageDirectory), [
    "downloads.json",
  ]);
});

test("signed installation p reconstructs without an old source after files 404", async (t) => {
  const f = await fixture(t, { variant: "installation-delta" }),
    original = await f.seed("2");
  const modified = path.join(original.contentPath, "events/fixture.txt");
  await fs.writeFile(modified, "player fixture change\n");
  const before = f.data.requests.length,
    service = f.open();
  await service.repair({ modId: "123", authorization: "account" });
  const state = await f.settled(service);
  assert.equal(state.job.status, "succeeded", state.job.error);
  assert.equal(state.job.installed.repair.repaired, true);
  const requests = f.data.requests.slice(before).map((item) => item.resource);
  assert.ok(requests.includes("2/-1_to_2/-1_to_2.zip"));
  assert.equal(requests.includes("2/complete/Fixture.zip"), false);
  assert.equal(
    requests.some((item) => item.startsWith("1/")),
    false,
  );
  assert.equal(await fs.readFile(modified, "utf8"), "player fixture change\n");
  assert.equal(
    await fs.readFile(
      path.join(state.installations[0].contentPath, "events/fixture.txt"),
      "utf8",
    ),
    "modified event\n",
  );
  assert.deepEqual(await fs.readdir(f.options.storageDirectory), [
    "downloads.json",
  ]);
  f.data.assertNoSecrets([state, await f.journal()]);
});

test("signed delta uses the exact cached original ZIP and transactionally installs the verified target", async (t) => {
  const f = await fixture(t),
    original = await f.seed();
  const before = f.data.requests.length;
  const service = f.open();
  await service.start({ modId: "123", authorization: "account" });
  const state = await f.settled(service);
  assert.equal(state.job.status, "succeeded", state.job.error);
  assert.equal(state.installations[0].revision, "2");
  assert.equal(state.installations[0].archiveSha256, digest(f.data.target));
  const requests = f.data.requests
    .slice(before)
    .filter((item) => item.resource.endsWith(".zip"));
  assert.deepEqual(
    requests.map((item) => item.resource),
    ["2/1_to_2/1_to_2.zip"],
  );
  assert.ok(f.data.patch.length < f.data.target.length / 50);
  assert.equal(
    await fs.readFile(
      path.join(state.installations[0].contentPath, "events/fixture.txt"),
      "utf8",
    ),
    "modified event\n",
  );
  assert.equal(
    await fs.readFile(
      path.join(original.contentPath, "events/fixture.txt"),
      "utf8",
    ),
    "original event\n",
  );
  const lease = await f.cache.open({
    modId: "123",
    revision: "2",
    bytes: f.data.target.length,
    sha256: digest(f.data.target),
  });
  assert.ok(lease);
  try {
    assert.deepEqual(await lease.read(0, f.data.target.length), f.data.target);
  } finally {
    await lease.close();
  }
  assert.deepEqual(await fs.readdir(f.options.storageDirectory), [
    "downloads.json",
  ]);
  f.data.assertNoSecrets([state, await f.journal()]);
});

test("files 404 repairs through the signed -1 installation patch and preserves modified old content", async (t) => {
  const f = await fixture(t),
    original = await f.seed("2");
  await fs.writeFile(
    path.join(original.contentPath, "events/fixture.txt"),
    "user modified event\n",
  );
  const before = f.data.requests.length;
  const service = f.open();
  await service.repair({ modId: "123", authorization: "account" });
  const state = await f.settled(service);
  assert.equal(state.job.status, "succeeded", state.job.error);
  assert.equal(state.job.installed.repair.repaired, true);
  const requested = f.data.requests.slice(before).map((item) => item.resource);
  assert.equal(requested.filter((item) => item.startsWith("files/")).length, 1);
  assert.ok(requested.includes("2/-1_to_2/manifest"));
  assert.ok(requested.includes("2/-1_to_2/-1_to_2.zip"));
  assert.equal(requested.includes("2/complete/Fixture.zip"), false);
  assert.equal(
    await fs.readFile(
      path.join(original.contentPath, "events/fixture.txt"),
      "utf8",
    ),
    "user modified event\n",
  );
  assert.deepEqual(await fs.readdir(f.options.storageDirectory), [
    "downloads.json",
  ]);
  f.data.assertNoSecrets([state, await f.journal()]);
});

test("delta pause/reopen pins separate patch and complete identities and resumes exact Range after fresh signatures", async (t) => {
  const f = await fixture(t);
  await f.seed();
  f.data.controls.hold = "2/1_to_2/1_to_2.zip";
  let service = f.open();
  await service.start({ modId: "123", authorization: "account" });
  await until(
    async () => (await service.getState()).job.progress?.receivedBytes === 64,
  );
  await service.pause();
  const paused = await f.settled(service),
    journal = await f.journal();
  assert.equal(paused.job.status, "paused");
  assert.equal(journal.partial.plan.sha256, digest(f.data.target));
  assert.equal(journal.partial.transferPlan.sha256, digest(f.data.patch));
  assert.equal(journal.partial.sourcePlan.sha256, digest(f.data.source));
  assert.equal(
    journal.partial.checkpoint.prefixSha256,
    digest(f.data.patch.subarray(0, 64)),
  );
  assert.equal(journal.partial.checkpoint.receivedBytes, 64);
  await fs.access(
    path.join(
      f.options.storageDirectory,
      journal.staging.directory,
      "patch.zip",
    ),
  );
  service.dispose();
  const before = f.data.requests.length;
  service = f.open();
  assert.equal((await service.getState()).job.canResume, true);
  assert.equal(f.data.requests.length, before, "reopening is offline");
  await service.resume();
  const state = await f.settled(service);
  assert.equal(state.job.status, "succeeded", state.job.error);
  const requests = f.data.requests.slice(before);
  assert.ok(requests.some((item) => item.resource === "2/1_to_2/manifest.asc"));
  assert.ok(
    requests.some((item) => item.resource === "1/complete/manifest.asc"),
  );
  assert.equal(
    requests.find((item) => item.resource === "2/1_to_2/1_to_2.zip").range,
    "bytes=64-",
  );
  assert.deepEqual(await fs.readdir(f.options.storageDirectory), [
    "downloads.json",
  ]);
  f.data.assertNoSecrets([state, journal, await f.journal()]);
});

for (const cause of ["signature", "grant", "hash"]) {
  test(`selected delta ${cause} failure cannot downgrade to a complete ZIP or modify the old installation`, async (t) => {
    const f = await fixture(t),
      original = await f.seed();
    if (cause === "signature")
      f.data.resources.get("2/1_to_2/manifest.asc")[70] ^= 1;
    if (cause === "grant") f.data.controls.grantFailure = "2/1_to_2/1_to_2.zip";
    if (cause === "hash")
      f.data.resources.set(
        "2/1_to_2/1_to_2.zip",
        Buffer.alloc(f.data.patch.length, 31),
      );
    const before = f.data.requests.length;
    const service = f.open();
    await service.start({ modId: "123", authorization: "account" });
    const state = await f.settled(service);
    assert.equal(state.job.status, "failed");
    assert.equal(
      state.job.errorCode,
      {
        signature: "SIGNATURE_INVALID",
        grant: "ACCESS_DENIED",
        hash: "HASH_MISMATCH",
      }[cause],
    );
    assert.equal(
      state.installations[0].installationId,
      original.installationId,
    );
    assert.equal(
      f.data.requests
        .slice(before)
        .some((item) => item.resource === "2/complete/Fixture.zip"),
      false,
    );
    f.data.assertNoSecrets([state, await f.journal()]);
  });
}

test("a missing original cache uses an authorized complete download without requesting a delta", async (t) => {
  const f = await fixture(t);
  await f.seed();
  await fs.unlink(
    path.join(f.root, "archives", digest(f.data.source) + ".zip"),
  );
  const before = f.data.requests.length,
    service = f.open();
  await service.start({ modId: "123", authorization: "account" });
  assert.equal((await f.settled(service)).job.status, "succeeded");
  const bodies = f.data.requests
    .slice(before)
    .filter((item) => item.resource.endsWith(".zip"));
  assert.deepEqual(
    bodies.map((item) => item.resource),
    ["2/complete/Fixture.zip"],
  );
});

test("a complete-package checkpoint stays complete even when its delta source becomes available on reopen", async (t) => {
  const f = await fixture(t);
  await f.seed();
  await fs.unlink(
    path.join(f.root, "archives", digest(f.data.source) + ".zip"),
  );
  f.data.controls.hold = "2/complete/Fixture.zip";
  let service = f.open();
  await service.start({ modId: "123", authorization: "account" });
  await until(
    async () => (await service.getState()).job.progress?.receivedBytes === 64,
  );
  await service.pause();
  assert.equal((await f.settled(service)).job.status, "paused");
  const checkpoint = await f.journal();
  assert.equal(checkpoint.partial.transferPlan, undefined);
  await fs.writeFile(
    path.join(f.root, "archives", digest(f.data.source) + ".zip"),
    f.data.source,
    { flag: "wx" },
  );
  service.dispose();
  service = f.open();
  const before = f.data.requests.length;
  await service.resume();
  const state = await f.settled(service);
  assert.equal(state.job.status, "succeeded", state.job.error);
  const bodies = f.data.requests
    .slice(before)
    .filter((item) => item.resource.endsWith(".zip"));
  assert.deepEqual(bodies, [
    { resource: "2/complete/Fixture.zip", range: "bytes=64-" },
  ]);
});

test("repair probe 200 downloads the authorized files object directly without a patch or complete fallback", async (t) => {
  const f = await fixture(t),
    original = await f.seed("2");
  await fs.writeFile(
    path.join(original.contentPath, "events/fixture.txt"),
    "user modified event\n",
  );
  f.data.controls.filesStatus = 200;
  const resource = fileResource(f.data.target.length, digest(f.data.target));
  const before = f.data.requests.length,
    service = f.open();
  await service.repair({ modId: "123", authorization: "account" });
  const state = await f.settled(service);
  assert.equal(state.job.status, "succeeded", state.job.error);
  assert.equal(state.job.installed.repair.repaired, true);
  assert.notEqual(
    state.installations[0].installationId,
    original.installationId,
  );
  assert.equal(f.installAttempts.length, 2);
  const requests = f.data.requests.slice(before);
  assert.deepEqual(
    requests
      .filter((item) => item.resource.startsWith("files/"))
      .map((item) => item.resource),
    [resource, resource],
    "the probe and verified transfer use the same content address",
  );
  assert.equal(
    requests.some((item) => item.resource.includes("_to_")),
    false,
  );
  assert.equal(
    requests.some((item) => item.resource === "2/complete/Fixture.zip"),
    false,
  );
  assert.equal(
    await fs.readFile(
      path.join(original.contentPath, "events/fixture.txt"),
      "utf8",
    ),
    "user modified event\n",
  );
  assert.equal(
    await fs.readFile(
      path.join(state.installations[0].contentPath, "events/fixture.txt"),
      "utf8",
    ),
    "modified event\n",
  );
  assert.deepEqual(await fs.readdir(f.options.storageDirectory), [
    "downloads.json",
  ]);
  f.data.assertNoSecrets([state, await f.journal()]);
});

for (const [cause, status, code] of [
  ["403", 403, "ACCESS_DENIED"],
  ["429", 429, "RATE_LIMITED"],
  ["5xx", 503, "NETWORK_ERROR"],
  ["redirect", 302, "REDIRECT_NOT_ALLOWED"],
  ["grant failure", null, "ACCESS_DENIED"],
]) {
  test(`repair probe ${cause} stops without requesting a patch or complete fallback`, async (t) => {
    const f = await fixture(t),
      original = await f.seed("2");
    await fs.writeFile(
      path.join(original.contentPath, "events/fixture.txt"),
      "user modified event\n",
    );
    const descriptor = await fs.readFile(original.descriptorPath);
    const resource = fileResource(f.data.target.length, digest(f.data.target));
    if (status === null) f.data.controls.grantFailure = resource;
    else f.data.controls.filesStatus = status;
    const before = f.data.requests.length,
      grantsBefore = f.data.grantRequests.length,
      service = f.open();
    await service.repair({ modId: "123", authorization: "account" });
    const state = await f.settled(service);
    assert.equal(state.job.status, "failed");
    assert.equal(state.job.errorCode, code);
    await assertOriginal(f, state, original, "user modified event\n");
    assert.deepEqual(await fs.readFile(original.descriptorPath), descriptor);
    assert.ok(f.data.grantRequests.slice(grantsBefore).includes(resource));
    const requests = f.data.requests.slice(before);
    assert.equal(
      requests.filter((item) => item.resource.startsWith("files/")).length,
      status === null ? 0 : 1,
    );
    assert.equal(
      requests.some((item) => item.resource.includes("_to_")),
      false,
    );
    assert.equal(
      requests.some((item) => item.resource === "2/complete/Fixture.zip"),
      false,
    );
    assert.deepEqual(await fs.readdir(f.options.storageDirectory), [
      "downloads.json",
    ]);
    f.data.assertNoSecrets([state, await f.journal()]);
  });
}

for (const cause of [
  "invalid patch signature",
  "new signed patch",
  "invalid source signature",
  "missing source cache",
  "corrupt source cache",
]) {
  test(`reopened delta with ${cause} preserves the old installation and pinned fragment`, async (t) => {
    const f = await fixture(t),
      paused = await pauseDelta(f);
    const sourcePath = path.join(
      f.root,
      "archives",
      digest(f.data.source) + ".zip",
    );
    if (cause === "invalid patch signature")
      f.data.resources.get("2/1_to_2/manifest.asc")[70] ^= 1;
    else if (cause === "new signed patch") {
      const changed = Buffer.from(f.data.patch);
      changed[0] ^= 1;
      await f.data.resignDelta(changed);
    } else if (cause === "invalid source signature")
      f.data.resources.get("1/complete/manifest.asc")[70] ^= 1;
    else if (cause === "missing source cache") await fs.unlink(sourcePath);
    else {
      const changed = Buffer.from(f.data.source);
      changed[0] ^= 1;
      await fs.writeFile(sourcePath, changed);
    }
    const before = f.data.requests.length,
      service = f.open();
    assert.equal((await service.getState()).job.canResume, true);
    assert.equal(f.data.requests.length, before, "reopening remains offline");
    await service.resume();
    const state = await f.settled(service),
      saved = await f.journal();
    assert.equal(state.job.status, "failed");
    assert.equal(
      state.job.errorCode,
      cause.includes("signature")
        ? "SIGNATURE_INVALID"
        : cause === "new signed patch"
          ? "PLAN_CHANGED"
          : "SOURCE_CHANGED",
    );
    await assertOriginal(f, state, paused.original);
    assert.deepEqual(
      await fs.readFile(paused.original.descriptorPath),
      paused.descriptor,
    );
    assert.deepEqual(
      await fs.readFile(paused.partialPath),
      paused.partialBytes,
    );
    assert.deepEqual(saved.partial.checkpoint, paused.saved.partial.checkpoint);
    assert.equal(saved.staging.directory, paused.saved.staging.directory);
    assert.deepEqual(
      saved.partial.transferPlan,
      paused.saved.partial.transferPlan,
    );
    assert.equal(
      f.data.requests
        .slice(before)
        .some((item) => item.resource.endsWith(".zip")),
      false,
      "no replacement delta, source ZIP or complete ZIP starts after revalidation fails",
    );
    if (cause.includes("cache") || cause === "new signed patch") {
      assert.equal(state.job.canResume, false);
      assert.ok(
        state.job.retainedDownloadDirectories.includes(
          path.dirname(paused.partialPath),
        ),
      );
    }
    f.data.assertNoSecrets([state, saved]);
  });
}

for (const cause of ["cancel", "logout", "same-account relogin"]) {
  test(`delta ${cause} during transfer cannot begin installation or modify the old version`, async (t) => {
    const f = await fixture(t),
      original = await f.seed();
    const descriptor = await fs.readFile(original.descriptorPath);
    f.data.controls.hold = "2/1_to_2/1_to_2.zip";
    const service = f.open(),
      before = f.data.requests.length;
    await service.start({ modId: "123", authorization: "account" });
    await until(
      async () => (await service.getState()).job.progress?.receivedBytes === 64,
    );
    if (cause === "cancel") await service.cancel();
    else if (cause === "logout") await f.data.account.logout();
    else await f.data.login();
    const state = await f.settled(service),
      saved = await f.journal();
    assert.equal(state.job.status, cause === "cancel" ? "cancelled" : "failed");
    assert.equal(
      state.job.errorCode,
      cause === "cancel" ? "CANCELLED" : "ACCOUNT_CHANGED",
    );
    await assertOriginal(f, state, original);
    assert.deepEqual(await fs.readFile(original.descriptorPath), descriptor);
    assert.equal(
      f.data.controls.cancelled,
      true,
      "the held content body is cancelled",
    );
    assert.equal(
      f.data.requests
        .slice(before)
        .some((item) => item.resource === "2/complete/Fixture.zip"),
      false,
    );
    if (cause === "cancel") {
      assert.equal(saved.partial, null);
      assert.deepEqual(await fs.readdir(f.options.storageDirectory), [
        "downloads.json",
      ]);
    } else {
      assert.equal(saved.partial.checkpoint.receivedBytes, 64);
      assert.deepEqual(
        await fs.readFile(
          path.join(
            f.options.storageDirectory,
            saved.staging.directory,
            "patch.zip",
          ),
        ),
        f.data.patch.subarray(0, 64),
      );
    }
    f.data.assertNoSecrets([state, saved]);
  });
}

for (const cause of ["cancel", "logout"]) {
  test(`${cause} after verified delta reconstruction still prevents installation`, async (t) => {
    const f = await fixture(t),
      original = await f.seed();
    const descriptor = await fs.readFile(original.descriptorPath);
    let reconstructed = false,
      service;
    f.options.archiveCache = {
      open: f.cache.open,
      async put(plan, options) {
        assert.equal(plan.revision, "2");
        assert.deepEqual(await fs.readFile(options.sourcePath), f.data.target);
        const result = await f.cache.put(plan, options);
        reconstructed = true;
        if (cause === "cancel") await service.cancel();
        else await f.data.account.logout();
        return result;
      },
    };
    service = f.open();
    await service.start({ modId: "123", authorization: "account" });
    const state = await f.settled(service),
      saved = await f.journal();
    assert.equal(reconstructed, true);
    assert.equal(state.job.status, cause === "cancel" ? "cancelled" : "failed");
    assert.equal(
      state.job.errorCode,
      cause === "cancel" ? "CANCELLED" : "ACCOUNT_CHANGED",
    );
    await assertOriginal(f, state, original);
    assert.deepEqual(await fs.readFile(original.descriptorPath), descriptor);
    if (cause === "cancel") {
      assert.equal(saved.partial, null);
      assert.deepEqual(await fs.readdir(f.options.storageDirectory), [
        "downloads.json",
      ]);
    } else {
      assert.equal(saved.partial.checkpoint.receivedBytes, f.data.patch.length);
      assert.deepEqual(
        saved.staging.artifacts.map((item) => item.name).sort(),
        ["content.zip", "patch-data.bin"],
      );
      for (const artifact of saved.staging.artifacts) {
        const file = path.join(
          f.options.storageDirectory,
          saved.staging.directory,
          artifact.name,
        );
        const bytes = await fs.readFile(file);
        assert.equal(bytes.length, artifact.bytes);
        assert.equal(digest(bytes), artifact.sha256);
      }
    }
    f.data.assertNoSecrets([state, saved]);
  });
}
