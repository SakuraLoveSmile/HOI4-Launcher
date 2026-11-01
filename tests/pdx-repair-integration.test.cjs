"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createLauncherService } = require("../electron/launcher-service.cjs");
const { createPdxContentService } = require("../electron/pdx-content.cjs");
const { createPdxDownloads } = require("../electron/pdx-downloads.cjs");
const { createPdxInstallService } = require("../electron/pdx-install.cjs");
const { createPdxArchiveCache } = require("../electron/pdx-archive-cache.cjs");
const {
  createPdxSignedResumeFixture,
} = require("../scripts/pdx-signed-resume-fixture.cjs");

async function until(predicate, message) {
  const deadline = Date.now() + 10000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function fixture(
  t,
  { hold = false, filesAvailable = false, cache = false } = {},
) {
  const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "ironclad-repair-integration-"),
    ),
    storageDirectory = path.join(root, "downloads"),
    installationDirectory = path.join(root, "installations"),
    settingsPath = path.join(root, "settings.json"),
    sessionPath = path.join(root, "account-session.json");
  const data = await createPdxSignedResumeFixture({
      sessionPath,
      filesAvailable,
    }),
    services = [],
    accountRequests = [];
  const f = {
    root,
    data,
    services,
    storageDirectory,
    installationDirectory,
    accountRequests,
    latestRevision: "3",
    tamperSignature: false,
    logoutAtResource: null,
  };
  // Keep the real account service and its route/session checks. The fixture
  // models a newer latest version while exact historical lookups still return 3.
  const request = data.account.request.bind(data.account);
  const account = {
    ...data.account,
    request: async (input) => {
      accountRequests.push({ path: input.path, query: { ...input.query } });
      const result = await request(input);
      if (input.path !== "/mods") return result;
      return {
        ...result,
        modDetail: {
          ...result.modDetail,
          modVersion: input.query?.modVersion || f.latestRevision,
        },
      };
    },
  };
  const fetchImpl = async (url, options) => {
    // Every request is handled by the in-memory signed fixture; no global
    // fetch, actual account or external content request is available here.
    const response = await data.fetchImpl(url, options),
      grant = data.grants.find((item) => item.url === url);
    if (grant?.resource === f.logoutAtResource) {
      f.logoutAtResource = null;
      await account.logout();
    }
    if (f.tamperSignature && grant?.resource === "3/complete/manifest.asc") {
      const bytes = Buffer.from(await response.arrayBuffer());
      bytes[Math.floor(bytes.length / 2)] ^= 1;
      return new Response(bytes, { headers: response.headers });
    }
    if (
      !hold &&
      [200, 206].includes(response.status) &&
      (grant?.resource.endsWith(".zip") ||
        grant?.resource === data.fileResource)
    ) {
      // The reusable resume fixture holds its first archive prefix. Tests
      // unrelated to pause use the same verified bytes as one complete body.
      await response.body.cancel();
      const offset = Number(
        new Headers(options.headers)
          .get("Range")
          ?.match(/^bytes=(\d+)-$/)?.[1] || 0,
      );
      return new Response(data.bytes.subarray(offset), {
        status: offset ? 206 : 200,
        headers: response.headers,
      });
    }
    return response;
  };
  const content = () =>
    createPdxContentService({
      account,
      integrity: data.integrity(),
      fetchImpl,
    });
  const game = path.join(root, "game");
  await fs.mkdir(game);
  await fs.writeFile(
    path.join(game, "hoi4.exe"),
    "fixture only, never executed",
  );
  const launcher = createLauncherService({
    settingsPath,
    documentsPath: root,
    steamRoots: [],
    processProbe: async () => null,
    spawnProcess: () => {
      throw new Error("Repair integration must not start a process");
    },
  });
  await launcher.saveSettings({ gameDirectory: game });
  const initial = await launcher.getState(),
    playsets = initial.settings.playsets.map((playset) => ({
      ...playset,
      modIds: ["pdx:123"],
      modOrder: ["pdx:123"],
      modReferences: [
        {
          id: "pdx:123",
          source: "pdx",
          remoteId: "123",
          version: "3",
          name: "Resumable PDX fixture",
        },
      ],
    }));
  await launcher.saveSettings({ playsets });
  const userDataPath = (await launcher.getState()).paths.userData,
    installer = createPdxInstallService({
      storageDirectory: installationDirectory,
      validateUserDataPath: async (target) =>
        assert.equal(target, userDataPath),
    });
  const archiveCache = cache
    ? createPdxArchiveCache({ storageDirectory: path.join(root, "archives") })
    : undefined;
  Object.assign(f, {
    launcher,
    installer,
    userDataPath,
    playsets,
    archiveCache,
  });
  f.open = () => {
    const service = createPdxDownloads({
      storageDirectory,
      account,
      installer,
      archiveCache,
      content: content(),
      getUserDataPath: async () => userDataPath,
    });
    services.push(service);
    return service;
  };
  f.settled = async (service) => {
    await until(() => !service.isBusy(), "Repair operation did not settle");
    return service.getState();
  };
  f.journal = async () =>
    JSON.parse(
      await fs.readFile(path.join(storageDirectory, "downloads.json"), "utf8"),
    );
  f.seed = async () => {
    const login = await account.login({
      email: "repair-fixture@example.invalid",
      password: "repair-isolated-password",
      remember: false,
    });
    assert.equal(login.status, "signed-in");
    const plan = await content().resolve({
      modId: "123",
      revision: "3",
      expectedAccountId: login.account.id,
    });
    assert.equal(plan.revision, "3");
    // Seeding still uses the real signature verifier and installer. The known
    // in-memory archive avoids spending the fixture's first held transfer.
    const archivePath = path.join(root, "seed.zip");
    await fs.writeFile(archivePath, data.bytes);
    const installed = await installer.install({
      archivePath,
      plan,
      userDataPath,
    });
    const originalEvent = await fs.readFile(
      path.join(installed.contentPath, "events/fixture.txt"),
    );
    f.originalEvent = originalEvent;
    f.original = installed;
    return installed;
  };
  f.damage = async () => {
    const changed = Buffer.from(f.originalEvent);
    changed[0] ^= 1;
    await fs.writeFile(
      path.join(f.original.contentPath, "events/fixture.txt"),
      changed,
    );
    return changed;
  };
  f.counts = () => ({
    requests: data.requests.length,
    account: data.accountCalls.length,
    grants: data.grants.length,
    archives: data.requests.filter((item) => item.type === "archive").length,
    revocations: data.requests.filter((item) => item.type === "revocation")
      .length,
  });
  f.assertSurfaces = async (state) => {
    data.assertNoSecrets([
      state,
      await f.journal(),
      await installer.list({ includeDamaged: true }),
      await fs.readFile(
        path.join(installationDirectory, "installations.json"),
        "utf8",
      ),
    ]);
    const current = await launcher.getState();
    assert.deepEqual(current.settings.playsets, playsets);
    const mod = current.mods.find((item) => item.id === "pdx:123");
    assert.equal(mod?.available, true);
    assert.equal(mod.installedRevision, "3");
    assert.deepEqual(data.failures, []);
    await assert.rejects(fs.lstat(sessionPath), { code: "ENOENT" });
  };
  t.after(async () => {
    for (const service of services) service.dispose();
    await account.logout();
    await until(
      () => services.every((service) => !service.isBusy()),
      "Repair fixture did not dispose",
    );
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("ironclad-repair-integration-"));
    await fs.rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  });
  return f;
}

test("healthy managed files validate locally without any provider or account request", async (t) => {
  const f = await fixture(t),
    original = await f.seed(),
    service = f.open();
  await service.ready();
  const before = f.counts();
  const queued = await service.repair({ modId: "123" });
  const state = await f.settled(service);
  assert.equal(queued.operation, "repair");
  assert.equal(queued.installationId, original.installationId);
  assert.equal(state.job.status, "succeeded", state.job.error);
  assert.equal(state.job.validation.status, "intact");
  assert.equal(state.job.validation.registrationIntact, true);
  assert.equal(state.job.revision, "3");
  assert.deepEqual(f.counts(), before);
  assert.deepEqual(await f.installer.list(), [original]);
  await f.assertSurfaces(state);
});

test("signed same-revision repair preserves modified content, registration and preset references", async (t) => {
  const f = await fixture(t, { filesAvailable: true }),
    original = await f.seed(),
    changed = await f.damage();
  const foreign = path.join(original.contentPath, "user-added.txt"),
    changedRegistration = '# user-edited registration\nname="Local edit"\n';
  await fs.writeFile(foreign, "preserve this user file");
  await fs.writeFile(original.descriptorPath, changedRegistration);
  f.latestRevision = "99";
  const before = f.counts(),
    service = f.open();
  await service.repair({ modId: "123", authorization: "account" });
  const state = await f.settled(service),
    repaired = state.job.installed;
  assert.equal(state.job.status, "succeeded", state.job.error);
  assert.equal(state.job.revision, "3");
  assert.equal(repaired.repair.repaired, true);
  assert.equal(repaired.repair.validation.changedFiles, 1);
  assert.equal(repaired.repair.validation.extraFiles, 1);
  assert.equal(repaired.repair.validation.registrationIntact, false);
  assert.equal(repaired.repair.retainedContentPath, original.contentPath);
  assert.notEqual(repaired.installationId, original.installationId);
  assert.notEqual(repaired.contentPath, original.contentPath);
  assert.equal(repaired.revision, "3");
  assert.deepEqual(
    await fs.readFile(path.join(repaired.contentPath, "events/fixture.txt")),
    f.originalEvent,
  );
  assert.deepEqual(
    await fs.readFile(path.join(original.contentPath, "events/fixture.txt")),
    changed,
  );
  assert.equal(await fs.readFile(foreign, "utf8"), "preserve this user file");
  assert.equal(
    await fs.readFile(repaired.repair.retainedDescriptorPath, "utf8"),
    changedRegistration,
  );
  await assert.rejects(
    fs.lstat(path.join(repaired.contentPath, "user-added.txt")),
    {
      code: "ENOENT",
    },
  );
  const validation = await f.installer.verify("123", {
    userDataPath: f.userDataPath,
    installationId: repaired.installationId,
  });
  assert.equal(validation.status, "intact");
  assert.equal(validation.registrationIntact, true);
  assert.equal(f.counts().archives - before.archives, 1);
  assert.equal(f.counts().grants - before.grants, 6);
  assert.equal(f.data.grants.at(-1).resource, f.data.fileResource);
  assert.equal(f.counts().revocations - before.revocations, 2);
  assert.ok(
    f.accountRequests
      .filter((item) => item.path === "/mods")
      .every((item) => item.query.modVersion === "3"),
  );
  await f.assertSurfaces(state);
});

test("signed repair caches exact original ZIP bytes across restart without retaining account grants", async (t) => {
  const f = await fixture(t, { filesAvailable: true, cache: true });
  await f.seed();
  await f.damage();
  const service = f.open();
  await service.repair({ modId: "123", authorization: "account" });
  const state = await f.settled(service);
  assert.equal(state.job.status, "succeeded");
  assert.equal(state.job.installed.repair.repaired, true);
  const verification = await f.installer.verify("123", {
    userDataPath: f.userDataPath,
    installationId: state.job.installed.installationId,
  });
  assert.equal(verification.status, "intact");
  const cache = createPdxArchiveCache({
    storageDirectory: path.join(f.root, "archives"),
  });
  const lease = await cache.open({
    modId: "123",
    revision: "3",
    bytes: f.data.bytes.length,
    sha256: f.original.archiveSha256,
  });
  assert.ok(lease);
  try {
    assert.deepEqual(await lease.read(0, f.data.bytes.length), f.data.bytes);
  } finally {
    await lease.close();
  }
  assert.deepEqual(await fs.readdir(path.join(f.root, "archives")), [
    `${f.original.archiveSha256}.zip`,
  ]);
  await f.assertSurfaces(state);
});

test("a legacy install obtains a signed ZIP baseline without replacing healthy content", async (t) => {
  const f = await fixture(t),
    original = await f.seed(),
    databasePath = path.join(f.installationDirectory, "installations.json"),
    database = JSON.parse(await fs.readFile(databasePath, "utf8"));
  delete database.records[0].integrity;
  await fs.writeFile(databasePath, JSON.stringify(database));
  const initial = await f.installer.verify("123", {
    userDataPath: f.userDataPath,
    installationId: original.installationId,
  });
  assert.equal(initial.status, "unverified");
  const before = f.counts(),
    service = f.open();
  await service.repair({ modId: "123", authorization: "account" });
  const state = await f.settled(service);
  assert.equal(state.job.status, "succeeded", state.job.error);
  assert.equal(state.job.installed.repair.repaired, false);
  assert.equal(state.job.validation.status, "intact");
  assert.equal(state.job.installed.installationId, original.installationId);
  assert.equal(state.job.installed.contentPath, original.contentPath);
  assert.equal(f.counts().archives - before.archives, 1);
  const updated = JSON.parse(await fs.readFile(databasePath, "utf8"));
  assert.equal(updated.records[0].integrity.version, 1);
  assert.equal(updated.retainedVersions.length, 0);
  const afterBaseline = f.counts();
  await service.repair({ modId: "123" });
  const verified = await f.settled(service);
  assert.equal(verified.job.validation.status, "intact");
  assert.deepEqual(f.counts(), afterBaseline);
  await f.assertSurfaces(verified);
});

test("a tampered manifest signature stops repair before ZIP transfer or installation", async (t) => {
  const f = await fixture(t),
    original = await f.seed(),
    changed = await f.damage();
  f.tamperSignature = true;
  const before = f.counts(),
    service = f.open();
  await service.repair({ modId: "123", authorization: "account" });
  const state = await f.settled(service);
  assert.equal(state.job.status, "failed");
  assert.equal(state.job.errorCode, "SIGNATURE_INVALID");
  assert.equal(f.counts().archives, before.archives);
  assert.deepEqual(await f.installer.list(), [original]);
  assert.deepEqual(
    await fs.readFile(path.join(original.contentPath, "events/fixture.txt")),
    changed,
  );
  await f.assertSurfaces(state);
});

test("account invalidation during signed metadata loading cannot download or commit a repair", async (t) => {
  const f = await fixture(t),
    original = await f.seed(),
    changed = await f.damage();
  f.logoutAtResource = "_keys/public.gpg";
  const before = f.counts(),
    service = f.open();
  await service.repair({ modId: "123", authorization: "account" });
  const state = await f.settled(service);
  assert.notEqual(state.job.status, "succeeded");
  assert.equal(state.job.errorCode, "ACCOUNT_CHANGED");
  assert.equal(f.counts().archives, before.archives);
  assert.deepEqual(await f.installer.list(), [original]);
  assert.deepEqual(
    await fs.readFile(path.join(original.contentPath, "events/fixture.txt")),
    changed,
  );
  await f.assertSurfaces(state);
});

for (const filesAvailable of [false, true])
  test(`repair pause and reopen reverify signatures before exact Range resume via ${filesAvailable ? "files" : "complete fallback"}`, async (t) => {
    const f = await fixture(t, { hold: true, filesAvailable }),
      original = await f.seed();
    await f.damage();
    const before = f.counts(),
      first = f.open(),
      queued = await first.repair({ modId: "123", authorization: "account" });
    await until(
      async () =>
        (await first.getState()).job?.progress?.receivedBytes === 64 * 1024,
      "Repair did not reach its held prefix",
    );
    await first.pause();
    const paused = await f.settled(first),
      journal = await f.journal();
    assert.equal(paused.job.status, "paused", paused.job.error);
    assert.equal(paused.job.canResume, true);
    assert.equal(paused.job.operation, "repair");
    assert.equal(paused.job.installationId, original.installationId);
    assert.equal(journal.job.operation, "repair");
    assert.equal(journal.job.installationId, original.installationId);
    assert.equal(journal.partial.checkpoint.receivedBytes, 64 * 1024);
    assert.equal(journal.partial.plan.revision, "3");
    assert.equal(f.data.heldCancelled, true);
    await f.assertSurfaces(paused);
    first.dispose();
    const beforeReopen = f.counts(),
      second = f.open(),
      reopened = await second.getState();
    assert.equal(reopened.job.status, "paused");
    assert.equal(reopened.job.operation, "repair");
    assert.equal(reopened.job.installationId, original.installationId);
    assert.deepEqual(f.counts(), beforeReopen);
    await second.resume();
    const state = await f.settled(second);
    assert.equal(state.job.status, "succeeded", state.job.error);
    assert.equal(state.job.id, queued.id);
    assert.equal(state.job.operation, "repair");
    assert.equal(state.job.installationId, original.installationId);
    assert.equal(state.job.installed.repair.repaired, true);
    assert.equal(state.job.installed.revision, "3");
    assert.notEqual(
      state.job.installed.installationId,
      original.installationId,
    );
    assert.equal(f.counts().grants - before.grants, filesAvailable ? 12 : 14);
    const archiveGrants = f.data.grants
      .slice(before.grants)
      .filter(
        (item) =>
          item.resource === f.data.fileResource ||
          item.resource.endsWith(".zip"),
      );
    assert.deepEqual(
      archiveGrants.map((item) => item.resource),
      filesAvailable
        ? [f.data.fileResource, f.data.fileResource]
        : [
            f.data.fileResource,
            `3/complete/${f.data.name}.zip`,
            f.data.fileResource,
            `3/complete/${f.data.name}.zip`,
          ],
    );
    assert.equal(f.counts().revocations - before.revocations, 4);
    const archives = f.data.requests.filter((item) => item.type === "archive");
    assert.equal(archives.length - before.archives, 2);
    assert.equal(archives[0].range, null);
    assert.equal(archives[1].range, "bytes=65536-");
    assert.equal(archives[1].ifRange, '"resume-fixture-v1"');
    assert.deepEqual(
      await fs.readFile(
        path.join(state.job.installed.contentPath, "events/fixture.txt"),
      ),
      f.originalEvent,
    );
    await f.assertSurfaces(state);
  });

test("repair resume rejects a newly tampered signature and retains its trusted fragment", async (t) => {
  const f = await fixture(t, { hold: true }),
    original = await f.seed(),
    changed = await f.damage(),
    first = f.open();
  await first.repair({ modId: "123", authorization: "account" });
  await until(
    async () =>
      (await first.getState()).job?.progress?.receivedBytes === 64 * 1024,
    "Repair did not reach its held prefix",
  );
  await first.pause();
  assert.equal((await f.settled(first)).job.status, "paused");
  first.dispose();
  f.tamperSignature = true;
  const before = f.counts(),
    second = f.open();
  await second.getState();
  assert.deepEqual(f.counts(), before);
  await second.resume();
  const state = await f.settled(second),
    journal = await f.journal();
  assert.equal(state.job.status, "failed");
  assert.equal(state.job.errorCode, "SIGNATURE_INVALID");
  assert.equal(state.job.operation, "repair");
  assert.equal(state.job.installationId, original.installationId);
  assert.equal(f.counts().archives, before.archives);
  assert.equal(journal.partial.checkpoint.receivedBytes, 64 * 1024);
  assert.equal(state.job.canResume, true);
  assert.deepEqual(await f.installer.list(), [original]);
  assert.deepEqual(
    await fs.readFile(path.join(original.contentPath, "events/fixture.txt")),
    changed,
  );
  await f.assertSurfaces(state);
});
