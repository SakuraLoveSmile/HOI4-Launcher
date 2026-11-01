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
const { createPdxFixture } = require("../scripts/pdx-fixture.cjs");

async function waitFor(predicate, message, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function fixture(t) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "ironclad-authorized-download-"),
  );
  const userData = path.join(root, "game-user"),
    jobs = path.join(root, "downloads");
  await fs.mkdir(userData);
  const contentFixture = createPdxFixture({
    revision: "7",
    title: "Authorized historical fixture",
  });
  const f = {
    root,
    userData,
    jobs,
    metadataTokens: [],
    cdnCalls: [],
    fetchFailures: [],
    streams: [],
    loginCount: 0,
    installCount: 0,
    expireRequests: false,
    hangArchive: true,
    currentToken: null,
  };
  const accountFetch = async (url, options) => {
    try {
      const address = new URL(url);
      assert.equal(address.origin, "https://api.paradox-interactive.com");
      if (
        address.pathname === "/accounts/sessions/launcher-v2" &&
        options.method === "PUT"
      ) {
        f.currentToken = `isolated-download-session-${++f.loginCount}`;
        // No refresh token: an authenticated 401 really expires this session.
        return Response.json({
          session: {
            token: f.currentToken,
            userid: "isolated-download-account",
          },
        });
      }
      assert.equal(options.method, "GET");
      const token = JSON.parse(options.headers.Authorization).session.token;
      assert.equal(token, f.currentToken);
      if (address.pathname === "/accountdetails") {
        if (f.expireRequests)
          return Response.json({ result: "Failure" }, { status: 401 });
        return Response.json({
          account: {
            email: "download@example.invalid",
            displayName: "Isolated download account",
          },
        });
      }
      if (address.pathname === "/mods") {
        assert.equal(address.searchParams.get("modId"), "123");
        assert.equal(address.searchParams.get("modVersion"), "7");
        f.metadataTokens.push(token);
        return contentFixture.fetchImpl(url, options);
      }
      throw new Error("Unexpected fixture account route: " + address.pathname);
    } catch (error) {
      f.fetchFailures.push(error.message);
      throw error;
    }
  };
  const cdnFetch = async (url, options) => {
    try {
      const address = new URL(url),
        headers = new Headers(options.headers);
      // Authenticated metadata must use account-service, never this raw fetch.
      assert.equal(
        address.origin,
        "https://modscontent.paradox-interactive.com",
      );
      assert.equal(options.method, "GET");
      assert.equal(options.credentials, "omit");
      assert.equal(options.redirect, "manual");
      assert.equal(headers.has("authorization"), false);
      assert.equal(headers.has("cookie"), false);
      f.cdnCalls.push({
        url,
        signal: options.signal,
        range: headers.get("range"),
      });
      if (address.pathname.endsWith(".zip") && f.hangArchive) {
        const stream = {
          signal: options.signal,
          cancelled: false,
          released: false,
          controller: null,
        };
        f.streams.push(stream);
        const body = new ReadableStream({
          start(controller) {
            stream.controller = controller;
            controller.enqueue(contentFixture.bytes.subarray(0, 16));
          },
          cancel() {
            stream.cancelled = true;
          },
        });
        stream.release = () => {
          if (stream.cancelled || stream.released) return;
          stream.released = true;
          stream.controller.enqueue(contentFixture.bytes.subarray(16));
          stream.controller.close();
        };
        // Intentionally ignore AbortSignal here: the real content reader must
        // cancel its pending read, not rely on the mock network completing.
        return new Response(body, {
          headers: { "Content-Length": String(contentFixture.bytes.length) },
        });
      }
      return contentFixture.fetchImpl(url, options);
    } catch (error) {
      f.fetchFailures.push(error.message);
      throw error;
    }
  };
  f.account = createAccountService({
    fetchImpl: accountFetch,
    sessionPath: path.join(root, "account-session.json"),
  });
  const content = createPdxContentService({
    integrity: require("../scripts/pdx-fixture-integrity.cjs").fixtureIntegrity,
    account: f.account,
    fetchImpl: cdnFetch,
    timeoutMs: 30_000,
  });
  f.installer = createPdxInstallService({
    storageDirectory: path.join(root, "installations"),
    isGameRunning: async () => false,
    validateUserDataPath: async (target) => assert.equal(target, userData),
  });
  f.downloads = createPdxDownloads({
    storageDirectory: jobs,
    account: f.account,
    content,
    installer: {
      ...f.installer,
      async install(input) {
        f.installCount++;
        return f.installer.install(input);
      },
    },
    getUserDataPath: async () => userData,
  });
  f.login = () =>
    f.account.login({
      email: "download@example.invalid",
      password: "isolated-download-password",
      remember: false,
    });
  f.start = () =>
    f.downloads.start({
      modId: "123",
      revision: "7",
      authorization: "account",
    });
  f.settled = async () => {
    await waitFor(
      () => !f.downloads.isBusy(),
      "Account invalidation did not stop the hanging CDN transfer promptly",
    );
    return f.downloads.getState();
  };
  f.hanging = async () => {
    await waitFor(async () => {
      const state = await f.downloads.getState();
      return (
        state.job?.status === "downloading" &&
        state.job.progress?.receivedBytes === 16
      );
    }, "Download did not reach the hanging CDN stream");
    assert.equal(f.streams.length, 1);
    assert.equal(f.streams[0].released, false);
    assert.equal(f.installCount, 0);
    return f.streams[0];
  };
  t.after(async () => {
    f.downloads.dispose();
    await f.account.logout();
    for (const stream of f.streams) stream.release();
    await waitFor(
      () => !f.downloads.isBusy(),
      "Fixture download did not dispose",
    );
    // Only the freshly created fixture may be recursively removed.
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("ironclad-authorized-download-"));
    await fs.rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  });
  return f;
}

for (const scenario of ["logout", "same-account-login", "session-expired"]) {
  test(`${scenario} aborts a hanging real content transfer; only explicit reauthorization can install`, async (t) => {
    const f = await fixture(t);
    assert.equal((await f.login()).account.id, "isolated-download-account");
    const first = await f.start();
    const stream = await f.hanging();
    const firstToken = f.currentToken;
    assert.deepEqual(f.metadataTokens, [firstToken]);

    if (scenario === "logout") await f.account.logout();
    else if (scenario === "same-account-login") {
      assert.equal((await f.login()).account.id, "isolated-download-account");
      assert.notEqual(f.currentToken, firstToken);
    } else {
      f.expireRequests = true;
      await assert.rejects(
        f.account.request({
          path: "/accountdetails",
          expectedAccountId: "isolated-download-account",
        }),
        { code: "SESSION_EXPIRED" },
      );
    }

    assert.equal(
      stream.signal.aborted,
      true,
      "session invalidation must reach the CDN AbortSignal",
    );
    const stopped = await f.settled();
    assert.equal(stopped.job.id, first.id);
    assert.equal(stopped.job.status, "failed");
    assert.equal(
      stopped.job.errorCode,
      scenario === "session-expired" ? "SESSION_EXPIRED" : "ACCOUNT_CHANGED",
    );
    assert.match(
      stopped.job.error,
      scenario === "session-expired" ? /过期/ : /账号|会话/,
    );
    assert.equal(
      stream.cancelled,
      true,
      "hanging response body must be cancelled",
    );
    assert.equal(
      stream.released,
      false,
      "settling must not require a server response or timeout",
    );
    assert.equal(
      f.installCount,
      0,
      "the invalidated task must never reach installer.install",
    );
    assert.deepEqual(await f.installer.list(), []);
    assert.equal(stopped.job.canResume, true);
    assert.equal(stopped.job.canCancel, true);
    const interruptedJournal = JSON.parse(
      await fs.readFile(path.join(f.jobs, "downloads.json"), "utf8"),
    );
    assert.equal(interruptedJournal.partial.checkpoint.receivedBytes, 16);
    assert.equal(
      (
        await fs.stat(
          path.join(
            f.jobs,
            interruptedJournal.staging.directory,
            "content.zip",
          ),
        )
      ).size,
      16,
    );
    await assert.rejects(f.start(), /恢复或取消/);
    if (scenario !== "same-account-login")
      await assert.rejects(f.downloads.resume(), /登录|过期/);
    assert.deepEqual(f.fetchFailures, []);

    f.expireRequests = false;
    if (scenario !== "same-account-login") await f.login();
    const beforeRetry = await f.downloads.getState();
    assert.equal(beforeRetry.job.id, first.id);
    assert.equal(beforeRetry.job.status, "failed");
    assert.equal(
      f.metadataTokens.length,
      1,
      "a new session must not silently replay the old authorized task",
    );
    assert.equal(
      f.cdnCalls.filter((call) => call.url.endsWith(".zip")).length,
      1,
    );

    f.hangArchive = false;
    const retry = await f.downloads.resume();
    assert.equal(retry.id, first.id);
    const installed = await f.settled();
    assert.equal(installed.job.status, "succeeded", installed.job.error);
    assert.equal(installed.job.authorization, "account");
    assert.equal(installed.job.revision, "7");
    assert.equal(f.installCount, 1);
    assert.deepEqual(f.metadataTokens, [firstToken, f.currentToken]);
    assert.notEqual(f.currentToken, firstToken);
    const records = await f.installer.list();
    assert.equal(records.length, 1);
    assert.equal(records[0].revision, "7");
    assert.match(
      await fs.readFile(records[0].descriptorPath, "utf8"),
      /Authorized historical fixture/,
    );
    assert.equal(
      f.cdnCalls.filter((call) => call.url.endsWith("/manifest")).length,
      2,
    );
    assert.equal(
      f.cdnCalls.filter((call) => call.url.endsWith(".zip")).length,
      2,
    );
    assert.deepEqual(
      f.cdnCalls
        .filter((call) => call.url.endsWith(".zip"))
        .map((call) => call.range),
      [null, "bytes=16-"],
    );
    assert.deepEqual(await fs.readdir(f.jobs), ["downloads.json"]);
    const saved = await fs.readFile(
      path.join(f.jobs, "downloads.json"),
      "utf8",
    );
    for (const secret of [
      firstToken,
      f.currentToken,
      "isolated-download-account",
      "isolated-download-password",
    ])
      assert.equal(
        saved.includes(secret) ||
          JSON.stringify(interruptedJournal).includes(secret),
        false,
        "session details must not enter the download journal",
      );
    assert.deepEqual(f.fetchFailures, []);
  });
}
