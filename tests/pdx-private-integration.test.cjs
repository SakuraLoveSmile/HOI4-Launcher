"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createAccountService } = require("../electron/account-service.cjs");
const { createPdxContentService } = require("../electron/pdx-content.cjs");
const { createPdxDownloads } = require("../electron/pdx-downloads.cjs");
const { createPdxInstallService } = require("../electron/pdx-install.cjs");
const { createPdxResumeFixture } = require("../scripts/pdx-resume-fixture.cjs");
const { createPdxIntegrity } = require("../electron/pdx-integrity.cjs");
const { createPdxSignatureVerifier } = require("../electron/pdx-signature.cjs");
const {
  createSignatureFixture,
} = require("./fixtures/pdx-signatures/create-fixture.cjs");
let signingFixture;

async function until(predicate, message) {
  const deadline = Date.now() + 5000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function fixture(t, { hold = false, denyResource } = {}) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "ironclad-private-pdx-"),
  );
  const userDataPath = path.join(root, "game-user"),
    storageDirectory = path.join(root, "downloads");
  await fs.mkdir(userDataPath);
  const data = createPdxResumeFixture(),
    repositoryPath = `mods/hoi4/${data.name}/repo/Any__Any`,
    resourcePrefix = `/patch/repo/${repositoryPath}/`,
    cdnOrigin = "https://authorized-downloads.example.invalid";
  data.metadata.modDetail.acl = "private";
  data.metadata.modDetail.repositoryPath = repositoryPath;
  const signing = await (signingFixture ??= createSignatureFixture());
  const signed = await signing.sign({
    metadata: Buffer.from(
      JSON.stringify({
        version: "0.3",
        content: {
          versions: { 3: { completeSize: String(data.bytes.length) } },
        },
      }),
    ),
    manifest: Buffer.from(data.manifest),
  });
  const signedResources = new Map([
    ["_keys/public.gpg", signed.repositoryKey],
    ["repository.json", signed.metadata],
    ["repository.json.asc", signed.metadataSignature],
    ["3/complete/manifest", signed.manifest],
    ["3/complete/manifest.asc", signed.manifestSignature],
  ]);
  const archiveResource = `3/complete/${data.name}.zip`;
  const integrity = () =>
    createPdxIntegrity({
      verifier: createPdxSignatureVerifier({
        rootKey: signing.rootKey,
        rootFingerprint: signing.rootFingerprint,
        now: () => signing.now,
      }),
    });
  const f = {
    root,
    storageDirectory,
    data,
    signedResources,
    requests: [],
    grants: [],
    streams: [],
    failures: [],
    secrets: ["private-fixture-password"],
    services: [],
    currentToken: undefined,
    loginCount: 0,
    grantCount: 0,
    hold,
    expireRequests: false,
  };
  const accountFetch = async (url, options) => {
    try {
      const address = new URL(url);
      assert.equal(address.origin, "https://api.paradox-interactive.com");
      if (address.pathname === "/accounts/sessions/launcher-v2") {
        assert.equal(options.method, "PUT");
        f.currentToken = `private-fixture-session-${++f.loginCount}`;
        f.secrets.push(f.currentToken);
        return Response.json({
          session: {
            token: f.currentToken,
            userid: "private-fixture-account",
          },
        });
      }
      assert.equal(options.method, "GET");
      assert.equal(options.body, undefined);
      const token = JSON.parse(options.headers.Authorization).session.token;
      assert.equal(token, f.currentToken);
      if (address.pathname === "/accountdetails") {
        if (f.expireRequests)
          return Response.json({ result: "Failure" }, { status: 401 });
        return Response.json({
          account: {
            email: "private@example.invalid",
            displayName: "Private fixture",
          },
        });
      }
      if (address.pathname === "/mods") {
        assert.equal(address.searchParams.get("modId"), "123");
        assert.equal(address.searchParams.get("modVersion"), "3");
        f.requests.push({ type: "metadata", token });
        return Response.json(data.metadata);
      }
      assert.ok(address.pathname.startsWith(resourcePrefix));
      assert.equal(address.search, "");
      const resource = address.pathname.slice(resourcePrefix.length);
      assert.ok(signedResources.has(resource) || resource === archiveResource);
      f.requests.push({
        type: "grant",
        resource,
        token,
        signal: options.signal,
      });
      if (resource.split("/").at(-1) === denyResource)
        return new Response("private-fixture-denied-body", { status: 403 });
      const signature = `private-fixture-grant-${++f.grantCount}`,
        prepend = `${cdnOrigin}/grant/${f.grantCount}/${resource}`,
        append = `?signature=${signature}`;
      f.secrets.push(signature, prepend, append);
      f.grants.push({ resource, url: prepend + append });
      return Response.json({
        result: "OK",
        ttl: String(Math.floor(Date.now() / 1000) + 3600),
        prepend,
        append,
      });
    } catch (error) {
      f.failures.push(error.message);
      throw error;
    }
  };
  const cdnFetch = async (url, options) => {
    try {
      const address = new URL(url),
        headers = new Headers(options.headers),
        grant = f.grants.find((value) => value.url === url);
      if (
        address.origin === "https://revocation-prod.paradox-interactive.com"
      ) {
        assert.equal(headers.has("Authorization"), false);
        assert.equal(headers.has("Cookie"), false);
        assert.equal(options.credentials, "omit");
        f.requests.push({ type: "revocation", url });
        return new Response(null, { status: 204 });
      }
      assert.equal(address.origin, cdnOrigin);
      assert.ok(grant, "every resource must use its own exact grant");
      assert.equal(options.method, "GET");
      assert.equal(options.credentials, "omit");
      assert.equal(options.redirect, "manual");
      assert.equal(headers.has("Authorization"), false);
      assert.equal(headers.has("Cookie"), false);
      if (signedResources.has(grant.resource)) {
        f.requests.push({
          type:
            grant.resource === "3/complete/manifest" ? "manifest" : "integrity",
          url,
        });
        return new Response(signedResources.get(grant.resource));
      }
      const range = headers.get("Range"),
        match = range?.match(/^bytes=(\d+)-$/);
      assert.ok(range === null || match);
      const offset = match ? Number(match[1]) : 0;
      f.requests.push({
        type: "archive",
        url,
        range,
        ifRange: headers.get("If-Range"),
      });
      const stream = { signal: options.signal, cancelled: false };
      const body = new ReadableStream({
        start(controller) {
          if (f.hold && !offset) {
            f.hold = false;
            f.streams.push(stream);
            controller.enqueue(data.bytes.subarray(0, 64 * 1024));
          } else {
            controller.enqueue(data.bytes.subarray(offset));
            controller.close();
          }
        },
        cancel() {
          stream.cancelled = true;
        },
      });
      return new Response(body, {
        status: offset ? 206 : 200,
        headers: {
          "Content-Length": String(data.bytes.length - offset),
          ETag: '"private-fixture-v1"',
          "Accept-Ranges": "bytes",
          ...(offset
            ? {
                "Content-Range": `bytes ${offset}-${data.bytes.length - 1}/${data.bytes.length}`,
              }
            : {}),
        },
      });
    } catch (error) {
      f.failures.push(error.message);
      throw error;
    }
  };
  f.account = createAccountService({
    fetchImpl: accountFetch,
    sessionPath: path.join(root, "account-session.json"),
  });
  f.installer = createPdxInstallService({
    storageDirectory: path.join(root, "installations"),
    isGameRunning: async () => false,
    validateUserDataPath: async (target) => assert.equal(target, userDataPath),
  });
  f.open = () => {
    // Reopening creates a fresh content service, so no in-memory grants survive.
    const service = createPdxDownloads({
      storageDirectory,
      account: f.account,
      content: createPdxContentService({
        integrity: integrity(),
        account: f.account,
        fetchImpl: cdnFetch,
      }),
      installer: f.installer,
      getUserDataPath: async () => userDataPath,
    });
    f.services.push(service);
    return service;
  };
  f.login = () =>
    f.account.login({
      email: "private@example.invalid",
      password: "private-fixture-password",
      remember: false,
    });
  f.start = (service) =>
    service.start({ modId: "123", revision: "3", authorization: "account" });
  f.settled = async (service) => {
    await until(() => !service.isBusy(), "Private download did not settle");
    return service.getState();
  };
  f.hanging = async (service) => {
    await until(
      async () =>
        (await service.getState()).job?.progress?.receivedBytes === 64 * 1024,
      "Private download did not reach its held prefix",
    );
    assert.equal(f.streams.length, 1);
    assert.deepEqual(await f.installer.list(), []);
    return f.streams[0];
  };
  f.journal = async () =>
    JSON.parse(
      await fs.readFile(path.join(storageDirectory, "downloads.json"), "utf8"),
    );
  f.assertPublicSurfaces = async (...values) => {
    const serialized = JSON.stringify([
      await f.journal(),
      await f.installer.list(),
      ...values,
    ]);
    for (const secret of [
      ...f.secrets,
      "private-fixture-account",
      cdnOrigin,
      "private-fixture-denied-body",
    ])
      assert.equal(
        serialized.includes(secret),
        false,
        "grants and credentials must stay out of journals and renderer state",
      );
    assert.doesNotMatch(
      serialized,
      /expectedAccountId|"prepend"|"append"|"session"|signature=/,
    );
    await assert.rejects(fs.lstat(path.join(root, "account-session.json")), {
      code: "ENOENT",
    });
    assert.deepEqual(f.failures, []);
  };
  t.after(async () => {
    for (const service of f.services) service.dispose();
    await f.account.logout();
    await until(
      () => f.services.every((service) => !service.isBusy()),
      "Private fixture did not dispose",
    );
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("ironclad-private-pdx-"));
    await fs.rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  });
  return f;
}

test("private complete ZIP uses independent account-bound grants and installs verified content", async (t) => {
  const f = await fixture(t),
    service = f.open();
  await f.login();
  await f.start(service);
  const state = await f.settled(service);
  assert.equal(state.job.status, "succeeded", state.job.error);
  assert.equal(state.job.authorization, "account");
  assert.equal(
    f.requests.filter((request) => request.type === "revocation").length,
    2,
  );
  assert.equal(
    f.requests.filter((request) => request.type === "integrity").length,
    4,
  );
  assert.equal(f.requests.at(-1).type, "archive");
  assert.deepEqual(
    f.grants.map((grant) => grant.resource),
    [...f.signedResources.keys(), `3/complete/${f.data.name}.zip`],
  );
  assert.notEqual(f.grants[0].url, f.grants[1].url);
  const records = await f.installer.list();
  assert.equal(records.length, 1);
  assert.equal(records[0].revision, "3");
  assert.match(
    await fs.readFile(records[0].descriptorPath, "utf8"),
    /Resumable PDX fixture/,
  );
  assert.deepEqual(await fs.readdir(f.storageDirectory), ["downloads.json"]);
  await f.assertPublicSurfaces(state);
});

test("private download pause, reopen and resume obtains fresh metadata and resource grants without persisting them", async (t) => {
  const f = await fixture(t, { hold: true }),
    first = f.open();
  await f.login();
  const queued = await f.start(first),
    stream = await f.hanging(first);
  await first.pause();
  const paused = await f.settled(first),
    journal = await f.journal();
  assert.equal(paused.job.status, "paused");
  assert.equal(paused.job.canResume, true);
  assert.equal(stream.cancelled, true);
  assert.equal(journal.partial.plan.access, "repository");
  assert.equal(journal.partial.checkpoint.receivedBytes, 64 * 1024);
  await f.assertPublicSurfaces(paused);
  first.dispose();
  const before = f.requests.length,
    second = f.open();
  assert.equal((await second.getState()).job.status, "paused");
  assert.equal(
    f.requests.length,
    before,
    "reopen must not contact the provider automatically",
  );
  await second.resume();
  const resumed = await f.settled(second);
  assert.equal(resumed.job.id, queued.id);
  assert.equal(resumed.job.status, "succeeded", resumed.job.error);
  assert.equal(
    f.requests.filter((request) => request.type === "metadata").length,
    2,
  );
  assert.deepEqual(
    f.grants.map((grant) => grant.resource),
    [
      ...f.signedResources.keys(),
      `3/complete/${f.data.name}.zip`,
      ...f.signedResources.keys(),
      `3/complete/${f.data.name}.zip`,
    ],
  );
  assert.equal(new Set(f.grants.map((grant) => grant.url)).size, 12);
  assert.equal(
    f.requests.filter((request) => request.type === "revocation").length,
    4,
  );
  const archives = f.requests.filter((request) => request.type === "archive");
  assert.deepEqual(
    archives.map((request) => request.range),
    [null, "bytes=65536-"],
  );
  assert.equal(archives[1].ifRange, '"private-fixture-v1"');
  assert.equal((await f.installer.list()).length, 1);
  assert.deepEqual(await fs.readdir(f.storageDirectory), ["downloads.json"]);
  await f.assertPublicSurfaces(paused, journal, resumed);
});

test("private resume rechecks detached signatures before sending Range or installing a held fragment", async (t) => {
  const f = await fixture(t, { hold: true }),
    first = f.open();
  await f.login();
  await f.start(first);
  await f.hanging(first);
  await first.pause();
  assert.equal((await f.settled(first)).job.status, "paused");
  first.dispose();
  f.signedResources.set(
    "3/complete/manifest.asc",
    Buffer.from("tampered signature"),
  );
  const second = f.open();
  await second.getState();
  await second.resume();
  const failed = await f.settled(second);
  assert.equal(failed.job.status, "failed");
  assert.equal(failed.job.errorCode, "SIGNATURE_INVALID");
  assert.equal(
    f.requests.filter((request) => request.type === "archive").length,
    1,
  );
  assert.deepEqual(await f.installer.list(), []);
  assert.equal((await f.journal()).partial.checkpoint.receivedBytes, 65536);
  await f.assertPublicSurfaces(failed);
});

for (const scenario of ["logout", "same-account-login", "session-expired"]) {
  test(`private ${scenario} cancels a held signed transfer and requires explicit fresh authorization`, async (t) => {
    const f = await fixture(t, { hold: true }),
      service = f.open();
    await f.login();
    const firstToken = f.currentToken;
    await f.start(service);
    const stream = await f.hanging(service);
    if (scenario === "logout") await f.account.logout();
    else if (scenario === "same-account-login") await f.login();
    else {
      f.expireRequests = true;
      await assert.rejects(
        f.account.request({
          path: "/accountdetails",
          expectedAccountId: "private-fixture-account",
        }),
        { code: "SESSION_EXPIRED" },
      );
    }
    const stopped = await f.settled(service),
      journal = await f.journal();
    assert.equal(stopped.job.status, "failed");
    assert.equal(
      stopped.job.errorCode,
      scenario === "session-expired" ? "SESSION_EXPIRED" : "ACCOUNT_CHANGED",
    );
    assert.equal(stream.signal.aborted, true);
    assert.equal(stream.cancelled, true);
    assert.deepEqual(await f.installer.list(), []);
    assert.equal(journal.partial.plan.access, "repository");
    assert.equal(journal.partial.checkpoint.receivedBytes, 64 * 1024);
    assert.equal(f.grants.length, 6);
    await f.assertPublicSurfaces(stopped, journal);
    f.expireRequests = false;
    if (scenario !== "same-account-login") await f.login();
    assert.notEqual(f.currentToken, firstToken);
    assert.equal(
      f.grants.length,
      6,
      "a new login must not silently replay a private task",
    );
    await service.resume();
    const resumed = await f.settled(service);
    assert.equal(resumed.job.status, "succeeded", resumed.job.error);
    assert.deepEqual(
      f.requests
        .filter((request) => request.type === "metadata")
        .map((request) => request.token),
      [firstToken, f.currentToken],
    );
    assert.equal(f.grants.length, 12);
    assert.equal(new Set(f.grants.map((grant) => grant.url)).size, 12);
    assert.equal((await f.installer.list()).length, 1);
    await f.assertPublicSurfaces(stopped, journal, resumed);
  });
}

for (const resource of ["manifest", "archive"]) {
  test(`private ${resource} grant denial stops without unsigned fallback or secret-bearing errors`, async (t) => {
    const data = createPdxResumeFixture(),
      f = await fixture(t, {
        denyResource: resource === "manifest" ? "manifest" : `${data.name}.zip`,
      }),
      service = f.open();
    await f.login();
    await f.start(service);
    const state = await f.settled(service);
    assert.equal(state.job.status, "failed");
    assert.equal(state.job.errorCode, "ACCESS_DENIED");
    assert.equal(
      f.requests.filter((request) => request.type === "metadata").length,
      1,
    );
    assert.equal(
      f.requests.filter((request) => request.type === "archive").length,
      0,
    );
    assert.equal(
      f.requests.filter((request) => request.type === "grant").length,
      resource === "manifest" ? 4 : 6,
    );
    assert.deepEqual(await f.installer.list(), []);
    await f.assertPublicSurfaces(state);
  });
}
