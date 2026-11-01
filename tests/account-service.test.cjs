const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  createHash,
  createCipheriv,
  createDecipheriv,
  randomBytes,
} = require("node:crypto");
const { createAccountService } = require("../electron/account-service.cjs");

const email = "tester@example.invalid";
const password = "fixture-password-which-must-not-leak";
const access = "fixture-access-secret";
const renewal = "fixture-renewal-secret";
const sessionReply = (
  token = access,
  refreshToken = renewal,
  userid = "user-1",
) => ({
  session: { token, refresh_token: refreshToken, userid },
});
const accountReply = {
  account: { email, username: "Tester", password: "ignored", token: "ignored" },
};

test("provider account binding prevents writes after a user switches accounts", async (t) => {
  const f = await fixture(t, [sessionReply(), accountReply]);
  await f.service.login({ email, password });
  const before = f.calls.length;
  await assert.rejects(
    f.service.request({
      method: "POST",
      path: "/mods/installed",
      body: { mods: [{ id: "123" }] },
      expectedAccountId: "another-account",
    }),
    { code: "ACCOUNT_CHANGED" },
  );
  assert.equal(f.calls.length, before);
  await f.service.logout();
  await assert.rejects(
    f.service.request({
      method: "POST",
      path: "/mods/installed",
      body: { mods: [{ id: "123" }] },
      expectedAccountId: "user-1",
    }),
    { code: "ACCOUNT_CHANGED" },
  );
  assert.equal(f.calls.length, before);
});
const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

function queueFetch(replies) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, ...options });
    assert.ok(
      replies.length,
      `Unexpected request ${options.method} ${new URL(url).pathname}`,
    );
    const reply = replies.shift();
    if (reply instanceof Error) throw reply;
    return typeof reply === "function"
      ? reply(url, options)
      : jsonResponse(reply);
  };
  return { fetchImpl, calls };
}

async function fixture(t, replies = [], overrides = {}) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "ironclad-account-test-"),
  );
  t.after(() =>
    fs.rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    }),
  );
  const sessionPath = path.join(root, "account-session.json");
  const key = randomBytes(32);
  const encryption = {
    isEncryptionAvailable: () => true,
    encryptString(value) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const encrypted = Buffer.concat([
        cipher.update(value, "utf8"),
        cipher.final(),
      ]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
    },
    decryptString(value) {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        key,
        value.subarray(0, 12),
      );
      decipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([
        decipher.update(value.subarray(28)),
        decipher.final(),
      ]).toString("utf8");
    },
  };
  const queue = queueFetch(replies);
  const config = {
    sessionPath,
    ...encryption,
    fetchImpl: queue.fetchImpl,
    ...overrides,
  };
  return {
    root,
    sessionPath,
    ...encryption,
    ...queue,
    config,
    service: createAccountService(config),
  };
}

function assertNoSecrets(value, values = [password, access, renewal]) {
  const rendered = typeof value === "string" ? value : JSON.stringify(value);
  for (const secret of values)
    assert.ok(
      !rendered.includes(secret),
      "A secret escaped into public output",
    );
}

async function uploadInput(f, data = Buffer.from("fixture upload content")) {
  const filePath = path.join(f.root, "content.zip");
  await fs.writeFile(filePath, data);
  return {
    path: "/mods/content/hoi4/fixture-publication/content/content.zip",
    filePath,
    bytes: data.length,
    sha256: createHash("sha256").update(data).digest("hex"),
    expectedAccountId: "user-1",
  };
}
async function readUpload(options) {
  assert.equal(options.method, "PUT");
  assert.equal(options.duplex, "half");
  assert.equal(Buffer.isBuffer(options.body), false);
  const chunks = [];
  for await (const chunk of options.body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

test("large-file upload streams verified bytes with bounded receipts and progress", async (t) => {
  const data = Buffer.alloc(256 * 1024, 37),
    progress = [];
  const f = await fixture(t, [
    sessionReply(),
    accountReply,
    async (_url, options) => {
      assert.equal(options.headers["Content-Length"], String(data.length));
      assert.deepEqual(await readUpload(options), data);
      return jsonResponse({
        result: "OK",
        token: access,
        password,
        filename: "content.zip",
      });
    },
  ]);
  await f.service.login({ email, password });
  const result = await f.service.uploadFile({
    ...(await uploadInput(f, data)),
    onProgress: (value) => progress.push(value),
  });
  assert.deepEqual(result, { result: "OK", filename: "content.zip" });
  assertNoSecrets(result);
  assert.equal(progress.at(-1).processedBytes, data.length);
});

test("upload checks account and reviewed digest before sending any bytes", async (t) => {
  const f = await fixture(t, [sessionReply(), accountReply]);
  await f.service.login({ email, password });
  const input = await uploadInput(f);
  const before = f.calls.length;
  await assert.rejects(
    f.service.uploadFile({ ...input, sha256: "0".repeat(64) }),
    { code: "UPLOAD_SOURCE_CHANGED" },
  );
  await assert.rejects(
    f.service.uploadFile({ ...input, expectedAccountId: "other-user" }),
    { code: "ACCOUNT_CHANGED" },
  );
  await assert.rejects(
    f.service.uploadFile({
      ...input,
      path: "https://foreign.invalid/content.zip",
    }),
    { code: "REQUEST_NOT_ALLOWED" },
  );
  assert.equal(f.calls.length, before);
});

test("an expired upload session retries PUT once with a fresh stream and token", async (t) => {
  const bodies = [];
  const f = await fixture(t, [
    sessionReply(),
    accountReply,
    (_url, options) => {
      bodies.push(options.body);
      return jsonResponse({}, 401);
    },
    sessionReply("new-fixture-token", "rotated-fixture-renewal"),
    async (_url, options) => {
      bodies.push(options.body);
      assert.notEqual(bodies[0], bodies[1]);
      assert.equal(
        JSON.parse(options.headers.Authorization).session.token,
        "new-fixture-token",
      );
      await readUpload(options);
      return new Response(null, { status: 204 });
    },
  ]);
  await f.service.login({ email, password });
  assert.equal(await f.service.uploadFile(await uploadInput(f)), null);
  assert.equal(
    f.calls.filter((call) =>
      new URL(call.url).pathname.includes("/mods/content/"),
    ).length,
    2,
  );
});

test("upload cannot replay a file changed after a 401 receipt", async (t) => {
  let input;
  const f = await fixture(t, [
    sessionReply(),
    accountReply,
    async () => {
      await fs.writeFile(input.filePath, "changed upload content");
      return jsonResponse({}, 401);
    },
    sessionReply("new-fixture-token"),
  ]);
  await f.service.login({ email, password });
  input = await uploadInput(f);
  await assert.rejects(f.service.uploadFile(input), {
    code: "UPLOAD_SOURCE_CHANGED",
  });
  assert.equal(
    f.calls.filter((call) =>
      new URL(call.url).pathname.includes("/mods/content/"),
    ).length,
    1,
  );
});

test("cancelling a streaming upload aborts its body and never exposes secrets", async (t) => {
  const controller = new AbortController();
  const f = await fixture(t, [
    sessionReply(),
    accountReply,
    async (_url, options) => {
      for await (const chunk of options.body) {
        assert.ok(chunk.length);
        controller.abort();
        break;
      }
      return new Response(null, { status: 204 });
    },
  ]);
  await f.service.login({ email, password });
  await assert.rejects(
    f.service.uploadFile({
      ...(await uploadInput(f, Buffer.alloc(256 * 1024))),
      signal: controller.signal,
    }),
    (error) => {
      assert.equal(error.code, "CANCELLED");
      assertNoSecrets(error.message);
      return true;
    },
  );
});

test("upload timeouts are bounded and an early success cannot skip sending the file", async (t) => {
  const f = await fixture(
    t,
    [
      sessionReply(),
      accountReply,
      (_url, options) =>
        new Promise((resolve, reject) =>
          options.signal.addEventListener(
            "abort",
            () => reject(new Error("fixture timeout")),
            { once: true },
          ),
        ),
    ],
    { uploadTimeoutMs: 30 },
  );
  await f.service.login({ email, password });
  await assert.rejects(f.service.uploadFile(await uploadInput(f)), {
    code: "TIMEOUT",
  });
  const g = await fixture(t, [
    sessionReply(),
    accountReply,
    () => new Response(null, { status: 204 }),
  ]);
  await g.service.login({ email, password });
  await assert.rejects(g.service.uploadFile(await uploadInput(g)), {
    code: "UPLOAD_SOURCE_CHANGED",
  });
});

test("hardlinked upload sources and files at the 5 GiB boundary are rejected", async (t) => {
  const f = await fixture(t, [sessionReply(), accountReply]);
  await f.service.login({ email, password });
  const input = await uploadInput(f);
  await fs.link(input.filePath, path.join(f.root, "linked.zip"));
  await assert.rejects(f.service.uploadFile(input), {
    code: "UPLOAD_SOURCE_CHANGED",
  });
  await assert.rejects(
    f.service.uploadFile({ ...input, bytes: 5 * 1024 ** 3 }),
    { code: "UPLOAD_SOURCE_CHANGED" },
  );
  assert.equal(f.calls.length, 2);
});

test("initial state is signed out without making network requests", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.service.getAccount(), {
    status: "signed-out",
    account: null,
    remembered: false,
    canRemember: true,
    notice: null,
  });
  assert.equal(f.calls.length, 0);
});

test("manual login uses public password protocol and exposes only account fields", async (t) => {
  const f = await fixture(t, [sessionReply(), accountReply]);
  const state = await f.service.login({ email, password });
  assert.deepEqual(state.account, {
    id: "user-1",
    email,
    displayName: "Tester",
  });
  assert.equal(state.status, "signed-in");
  assert.equal(state.remembered, false);
  assertNoSecrets(state);
  assert.equal(
    f.calls[0].url,
    "https://api.paradox-interactive.com/accounts/sessions/launcher-v2",
  );
  assert.equal(f.calls[0].method, "PUT");
  assert.equal(f.calls[0].body, undefined);
  assert.equal(f.calls[0].redirect, "error");
  assert.match(f.calls[0].headers["User-Agent"], /^IRONCLAD\//);
  assert.deepEqual(JSON.parse(f.calls[0].headers.Authorization), {
    hawk: {
      email,
      "sha256(password+salt)": createHash("sha256")
        .update(password + "64DC4DC6508F4A9D823179D4D99DB4EE")
        .digest("hex"),
    },
  });
  assert.deepEqual(JSON.parse(f.calls[1].headers.Authorization), {
    session: { token: access },
  });
  await assert.rejects(fs.stat(f.sessionPath), { code: "ENOENT" });
});

test("remembered session persists only encrypted refresh token and restores by renewal", async (t) => {
  const f = await fixture(t, [sessionReply(), accountReply]);
  assert.equal(
    (await f.service.login({ email, password, remember: true })).remembered,
    true,
  );
  const saved = await fs.readFile(f.sessionPath, "utf8");
  assertNoSecrets(saved, [password, access, renewal, email]);
  const envelope = JSON.parse(saved);
  assert.deepEqual(Object.keys(envelope).sort(), ["ciphertext", "version"]);
  const decrypted = JSON.parse(
    f.decryptString(Buffer.from(envelope.ciphertext, "base64")),
  );
  assert.deepEqual(Object.keys(decrypted).sort(), [
    "refreshToken",
    "storedAt",
    "version",
  ]);
  assert.equal(decrypted.refreshToken, renewal);
  const restored = queueFetch([
    sessionReply("renewed-access", "rotated-renewal"),
    accountReply,
  ]);
  const second = createAccountService({
    ...f.config,
    fetchImpl: restored.fetchImpl,
  });
  assert.equal((await second.getAccount()).status, "signed-in");
  assert.deepEqual(JSON.parse(restored.calls[0].headers.Authorization), {
    renewal: { token: renewal },
  });
  const rotated = JSON.parse(
    f.decryptString(
      Buffer.from(
        JSON.parse(await fs.readFile(f.sessionPath, "utf8")).ciphertext,
        "base64",
      ),
    ),
  );
  assert.equal(rotated.refreshToken, "rotated-renewal");
});

test("unavailable encryption allows memory login and does not persist plaintext", async (t) => {
  const f = await fixture(t, [sessionReply(), accountReply], {
    isEncryptionAvailable: () => false,
  });
  const state = await f.service.login({ email, password, remember: true });
  assert.equal(state.status, "signed-in");
  assert.equal(state.remembered, false);
  assert.equal(state.canRemember, false);
  assert.match(state.notice, /系统加密不可用/);
  await assert.rejects(fs.stat(f.sessionPath), { code: "ENOENT" });
});

test("encryption failure is sanitized and leaves only memory session", async (t) => {
  const f = await fixture(t, [sessionReply(), accountReply], {
    encryptString() {
      throw new Error(renewal);
    },
  });
  const state = await f.service.login({ email, password, remember: true });
  assert.equal(state.status, "signed-in");
  assert.equal(state.remembered, false);
  assertNoSecrets(state);
  await assert.rejects(fs.stat(f.sessionPath), { code: "ENOENT" });
});

test("invalid credentials never expose echoed response or request information", async (t) => {
  const f = await fixture(t, [
    () => jsonResponse({ message: password, token: access }, 401),
  ]);
  await assert.rejects(f.service.login({ email, password }), (error) => {
    assert.equal(error.code, "INVALID_CREDENTIALS");
    assertNoSecrets(`${error.stack} ${JSON.stringify(error)}`);
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.equal((await f.service.getAccount()).status, "signed-out");
});

test("unsafe network errors and account response extras are never returned", async (t) => {
  const f = await fixture(t, [
    new Error(`URL Authorization ${password} ${access} ${renewal}`),
  ]);
  await assert.rejects(f.service.login({ email, password }), (error) => {
    assert.equal(error.code, "NETWORK_ERROR");
    assertNoSecrets(error.stack);
    return true;
  });
});

test("401 renews exactly once, retries with new token and persists rotation", async (t) => {
  const f = await fixture(t, [
    sessionReply(),
    accountReply,
    () => jsonResponse({ error: access }, 401),
    sessionReply("next-access", "next-renewal"),
    accountReply,
  ]);
  await f.service.login({ email, password, remember: true });
  assert.equal((await f.service.getAccount()).status, "signed-in");
  assert.deepEqual(JSON.parse(f.calls[3].headers.Authorization), {
    renewal: { token: renewal },
  });
  assert.deepEqual(JSON.parse(f.calls[4].headers.Authorization), {
    session: { token: "next-access" },
  });
});

test("concurrent expired requests share one renewal", async (t) => {
  let renewals = 0;
  let signedIn = false;
  const f = await fixture(t, [], {
    fetchImpl: async (url, options) => {
      const auth = JSON.parse(options.headers.Authorization);
      if (auth.hawk) return jsonResponse(sessionReply());
      if (auth.renewal) {
        renewals += 1;
        await new Promise((resolve) => setImmediate(resolve));
        return jsonResponse(sessionReply("new-access", "new-renewal"));
      }
      if (!signedIn) {
        signedIn = true;
        return jsonResponse(accountReply);
      }
      if (auth.session.token === access) return jsonResponse({}, 401);
      return jsonResponse(accountReply);
    },
  });
  await f.service.login({ email, password });
  const result = await Promise.all([
    f.service.getAccount(),
    f.service.getAccount(),
  ]);
  assert.equal(renewals, 1);
  assert.ok(result.every((state) => state.status === "signed-in"));
});

test("expired refresh token clears local saved session", async (t) => {
  const f = await fixture(t, [
    sessionReply(),
    accountReply,
    () => jsonResponse({}, 401),
    () => jsonResponse({ message: renewal }, 401),
  ]);
  await f.service.login({ email, password, remember: true });
  await assert.rejects(f.service.getAccount(), { code: "SESSION_EXPIRED" });
  assert.equal((await f.service.getAccount()).status, "signed-out");
  await assert.rejects(fs.stat(f.sessionPath), { code: "ENOENT" });
});

test("renewal cannot silently switch account identity", async (t) => {
  const f = await fixture(t, [
    sessionReply(),
    accountReply,
    () => jsonResponse({}, 401),
    sessionReply("other-access", "other-refresh", "another-user"),
  ]);
  await f.service.login({ email, password });
  await assert.rejects(f.service.getAccount(), { code: "SESSION_EXPIRED" });
  assert.equal((await f.service.getAccount()).account, null);
});

test("temporary renewal network failure preserves saved refresh for retry", async (t) => {
  const f = await fixture(t, [
    sessionReply(),
    accountReply,
    () => jsonResponse({}, 401),
    new Error(renewal),
    () => jsonResponse({}, 401),
    sessionReply("retry-access", "retry-refresh"),
    accountReply,
  ]);
  await f.service.login({ email, password, remember: true });
  await assert.rejects(f.service.getAccount(), { code: "NETWORK_ERROR" });
  assert.ok((await fs.stat(f.sessionPath)).isFile());
  assert.equal((await f.service.getAccount()).status, "signed-in");
});

test("logout cancels pending login and late response cannot restore it", async (t) => {
  let resolveLogin;
  let started;
  const startedPromise = new Promise((resolve) => {
    started = resolve;
  });
  const f = await fixture(t, [
    () =>
      new Promise((resolve) => {
        resolveLogin = resolve;
        started();
      }),
  ]);
  const pending = f.service.login({ email, password, remember: true });
  const rejected = assert.rejects(pending, { code: "CANCELLED" });
  await startedPromise;
  assert.equal((await f.service.logout()).status, "signed-out");
  resolveLogin(jsonResponse(sessionReply()));
  await rejected;
  assert.equal((await f.service.getAccount()).status, "signed-out");
  assert.ok(f.calls[0].signal.aborted);
  await assert.rejects(fs.stat(f.sessionPath), { code: "ENOENT" });
});

test("cancelLogin and caller AbortSignal both abort requests", async (t) => {
  for (const cancelWithSignal of [false, true]) {
    let started;
    const startedPromise = new Promise((resolve) => {
      started = resolve;
    });
    const f = await fixture(t, [
      (url, options) =>
        new Promise((resolve, reject) => {
          options.signal.addEventListener(
            "abort",
            () => reject(new Error(password)),
            { once: true },
          );
          started();
        }),
    ]);
    const controller = new AbortController();
    const pending = f.service.login({
      email,
      password,
      signal: controller.signal,
    });
    const rejected = assert.rejects(pending, { code: "CANCELLED" });
    await startedPromise;
    if (cancelWithSignal) controller.abort();
    else await f.service.cancelLogin();
    await rejected;
    assert.equal((await f.service.getAccount()).status, "signed-out");
  }
});

test("failed account switch clears the previous remembered user", async (t) => {
  const f = await fixture(t, [
    sessionReply(),
    accountReply,
    () => jsonResponse({}, 401),
  ]);
  await f.service.login({ email, password, remember: true });
  await assert.rejects(
    f.service.login({ email: "other@example.invalid", password: "wrong" }),
    { code: "INVALID_CREDENTIALS" },
  );
  assert.equal((await f.service.getAccount()).account, null);
  await assert.rejects(fs.stat(f.sessionPath), { code: "ENOENT" });
});

test("corrupt or undecryptable saved data never reaches the network", async (t) => {
  for (const data of [
    "not JSON",
    JSON.stringify({ version: 1, ciphertext: "bad!" }),
    JSON.stringify({
      version: 1,
      ciphertext: Buffer.from(renewal).toString("base64"),
    }),
  ]) {
    const f = await fixture(t);
    await fs.writeFile(f.sessionPath, data);
    const state = await f.service.getAccount();
    assert.equal(state.status, "signed-out");
    assert.match(state.notice, /重新登录/);
    assertNoSecrets(state);
    assert.equal(f.calls.length, 0);
    await assert.rejects(fs.stat(f.sessionPath), { code: "ENOENT" });
  }
});

test("logout removes saved credentials without calling a fictitious revoke API", async (t) => {
  const f = await fixture(t, [sessionReply(), accountReply]);
  await f.service.login({ email, password, remember: true });
  assert.equal((await f.service.logout()).status, "signed-out");
  assert.equal(f.calls.length, 2);
  await assert.rejects(fs.stat(f.sessionPath), { code: "ENOENT" });
});

test("provider requests allow only fixed paths and cannot redirect credentials", async (t) => {
  const f = await fixture(t);
  for (const input of [
    { path: "https://example.invalid/steal" },
    { path: "//example.invalid/steal" },
    { method: "DELETE", path: "/accounts" },
    { path: "/mods?modId=123" },
    { path: "/profiles", query: { namespace: "private" } },
    { path: "/mods", query: { url: "https://example.invalid" } },
    { method: "PUT", path: "/mods/content/hoi4/mod/content/../secret" },
  ])
    await assert.rejects(f.service.request(input), {
      code: "REQUEST_NOT_ALLOWED",
    });
  assert.equal(f.calls.length, 0);
});

test("provider receives sanitized data and correct subscription version header", async (t) => {
  const f = await fixture(t, [
    sessionReply(),
    accountReply,
    {
      mods: [
        {
          id: "123",
          token: access,
          title: `echo ${access}`,
          nested: { refresh_token: renewal },
        },
      ],
    },
  ]);
  await f.service.login({ email, password });
  const result = await f.service.request({
    method: "POST",
    path: "/mods/installed",
    body: { mods: [{ id: "123" }] },
  });
  assertNoSecrets(result);
  assert.equal(result.mods[0].id, "123");
  assert.equal(result.mods[0].token, undefined);
  assert.equal(f.calls[2].headers["X-Accept-Version"], "2");
});

test("protected repository lookup is limited to exact HOI4 complete resources and binds the account", async (t) => {
  const resource =
    "/patch/repo/mods/hoi4/fixture_repo/repo/Any__Any/12/complete/manifest";
  const grant = {
    result: "OK",
    prepend: "https://signed.example.com/manifest",
    append: "?Signature=fixture-content-signature",
    ttl: String(Math.floor(Date.now() / 1000) + 3600),
  };
  const f = await fixture(t, [sessionReply(), accountReply, grant]);
  await f.service.login({ email, password });
  for (const input of [
    { path: resource, expectedAccountId: "other-account" },
    { path: resource.replace("hoi4", "stellaris") },
    { path: resource + "?token=bad" },
    { path: resource.replace("manifest", "../credential") },
    { path: resource.replace("manifest", "CON.zip") },
    { path: resource.replace("manifest", "nested%2ffile.zip") },
    { path: resource, query: { url: "https://evil.invalid" } },
    { path: resource, method: "POST", body: {} },
  ])
    await assert.rejects(f.service.request(input), {
      code: input.expectedAccountId ? "ACCOUNT_CHANGED" : "REQUEST_NOT_ALLOWED",
    });
  assert.equal(f.calls.length, 2);
  assert.deepEqual(
    await f.service.request({ path: resource, expectedAccountId: "user-1" }),
    grant,
  );
  assert.equal(
    f.calls[2].url,
    "https://api.paradox-interactive.com" + resource,
  );
  assert.equal(f.calls[2].method, "GET");
  assert.equal(
    JSON.parse(f.calls[2].headers.Authorization).session.token,
    access,
  );
  assert.equal(f.calls[2].redirect, "error");
  assert.equal(f.calls[2].body, undefined);
});

test("protected signature lookups allow only exact root resources and manifest signatures", async (t) => {
  const prefix = "/patch/repo/mods/hoi4/fixture_repo/repo/Any__Any/";
  const resources = [
    "repository.json",
    "repository.json.asc",
    "_keys/public.gpg",
    "12/complete/manifest.asc",
  ];
  const replies = resources.map((resource, index) => ({
    result: "OK",
    prepend: `https://signed.example.net/resource-${index}`,
    append: `?Signature=fixture-${index}`,
    ttl: String(Math.floor(Date.now() / 1000) + 3600),
  }));
  const f = await fixture(t, [sessionReply(), accountReply, ...replies]);
  await f.service.login({ email, password });
  for (const resource of resources) {
    const requestPath = prefix + resource;
    for (const input of [
      { path: requestPath, expectedAccountId: "other-account" },
      { path: requestPath, method: "POST", body: {} },
      { path: requestPath, method: "HEAD" },
      { path: requestPath, body: {} },
      { path: requestPath, query: { token: "fixture-secret" } },
      { path: requestPath + "?token=fixture-secret" },
      { path: requestPath + "#fragment" },
      { path: requestPath + "\n" },
    ])
      await assert.rejects(f.service.request(input), {
        code: input.expectedAccountId
          ? "ACCOUNT_CHANGED"
          : "REQUEST_NOT_ALLOWED",
      });
  }
  for (const suffix of [
    "_keys/private.gpg",
    "_keys/%70ublic.gpg",
    "_keys/../public.gpg",
    "_keys/public.gpg/extra",
    "12/complete/repository.json",
    "12/partial/manifest.asc",
  ])
    await assert.rejects(f.service.request({ path: prefix + suffix }), {
      code: "REQUEST_NOT_ALLOWED",
    });
  assert.equal(f.calls.length, 2);
  for (const [index, resource] of resources.entries()) {
    assert.deepEqual(
      await f.service.request({
        path: prefix + resource,
        expectedAccountId: "user-1",
        headers: {
          Cookie: "fixture-cookie",
          Authorization: "fixture-override",
        },
        credentials: "include",
      }),
      replies[index],
    );
    const call = f.calls[index + 2];
    assert.equal(
      call.url,
      "https://api.paradox-interactive.com" + prefix + resource,
    );
    assert.equal(call.method, "GET");
    assert.equal(call.body, undefined);
    assert.equal(call.redirect, "error");
    assert.equal(call.headers.Cookie, undefined);
    assert.equal(call.credentials, undefined);
    assert.equal(JSON.parse(call.headers.Authorization).session.token, access);
  }
});

test("redirects, invalid sessions, invalid JSON and oversized replies are safe failures", async (t) => {
  for (const response of [
    () => ({
      ok: true,
      redirected: true,
      status: 200,
      text: async () => password,
    }),
    { session: { refresh_token: renewal } },
    () => new Response("not JSON " + password),
    () => new Response("x".repeat(2 * 1024 * 1024 + 1)),
  ]) {
    const f = await fixture(t, [response]);
    await assert.rejects(f.service.login({ email, password }), (error) => {
      assert.equal(error.code, "INVALID_RESPONSE");
      assertNoSecrets(error.stack);
      return true;
    });
  }
});

test("invalid login input does not make a request", async (t) => {
  const f = await fixture(t);
  for (const input of [
    null,
    [],
    {},
    { email, password: "" },
    { email: "bad", password },
    { email, password, remember: "yes" },
    { email, password, signal: {} },
  ]) {
    await assert.rejects(f.service.login(input), { code: "INVALID_INPUT" });
  }
  assert.equal(f.calls.length, 0);
});

test("logout prevents a pending renewal from reviving saved credentials", async (t) => {
  let finish;
  let started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const f = await fixture(t, [
    sessionReply(),
    accountReply,
    () => jsonResponse({}, 401),
    () =>
      new Promise((resolve) => {
        finish = resolve;
        started();
      }),
  ]);
  await f.service.login({ email, password, remember: true });
  const pending = assert.rejects(f.service.getAccount(), { code: "CANCELLED" });
  await ready;
  await f.service.logout();
  finish(jsonResponse(sessionReply("late-access", "late-refresh")));
  await pending;
  assert.equal((await f.service.getAccount()).status, "signed-out");
  await assert.rejects(fs.stat(f.sessionPath), { code: "ENOENT" });
});

test("a second 401 after renewal expires instead of looping", async (t) => {
  const f = await fixture(t, [
    sessionReply(),
    accountReply,
    () => jsonResponse({}, 401),
    sessionReply("still-rejected", "next-refresh"),
    () => jsonResponse({}, 401),
  ]);
  await f.service.login({ email, password });
  await assert.rejects(f.service.getAccount(), { code: "SESSION_EXPIRED" });
  assert.equal(f.calls.length, 5);
  assert.equal((await f.service.getAccount()).status, "signed-out");
});

test("request timeout aborts the transport and returns a safe actionable error", async (t) => {
  const f = await fixture(
    t,
    [
      (url, options) =>
        new Promise((resolve, reject) => {
          const keepAlive = setTimeout(() => reject(new Error(password)), 1000);
          options.signal.addEventListener(
            "abort",
            () => {
              clearTimeout(keepAlive);
              reject(new Error(password));
            },
            { once: true },
          );
        }),
    ],
    { timeoutMs: 10 },
  );
  await assert.rejects(f.service.login({ email, password }), (error) => {
    assert.equal(error.code, "TIMEOUT");
    assertNoSecrets(error.stack);
    return true;
  });
  assert.equal((await f.service.getAccount()).status, "signed-out");
});

test("account IDs cannot echo a token or grow beyond a bounded identity field", async (t) => {
  const f = await fixture(t, [
    sessionReply(access, renewal, access),
    accountReply,
  ]);
  assertNoSecrets(await f.service.login({ email, password }));
  const oversized = await fixture(t, [
    sessionReply(access, renewal, "x".repeat(201)),
  ]);
  await assert.rejects(oversized.service.login({ email, password }), {
    code: "INVALID_RESPONSE",
  });
});

test("session binding returns only a synchronous main-process lease and dispose is local", async (t) => {
  const f = await fixture(t, [
    sessionReply(),
    accountReply,
    accountReply,
    accountReply,
    accountReply,
  ]);
  await f.service.login({ email, password });
  const external = new AbortController(),
    events = require("node:events");
  const lease = await f.service.bindSession({
    signal: external.signal,
    expectedAccountId: "user-1",
  });
  const other = await f.service.bindSession();
  assert.deepEqual(Object.keys(lease).sort(), [
    "accountId",
    "check",
    "dispose",
    "signal",
  ]);
  assert.equal(lease.accountId, "user-1");
  assert.equal(lease.check(), undefined);
  assertNoSecrets(lease);
  assert.equal(events.getEventListeners(external.signal, "abort").length, 1);
  lease.dispose();
  lease.dispose();
  assert.equal(lease.signal.aborted, true);
  assert.throws(lease.check, { code: "CANCELLED" });
  assert.equal(events.getEventListeners(external.signal, "abort").length, 0);
  assert.equal(other.signal.aborted, false);
  other.check();
  assert.equal((await f.service.getAccount()).status, "signed-in");
  other.dispose();
});

test("binding rejects signed-out, invalid and mismatched identities before authenticated traffic", async (t) => {
  const f = await fixture(t, [sessionReply(), accountReply]);
  await assert.rejects(f.service.bindSession(), { code: "NOT_SIGNED_IN" });
  for (const input of [
    { expectedAccountId: "" },
    { expectedAccountId: 123 },
    { expectedAccountId: "x".repeat(201) },
    { signal: {} },
  ])
    await assert.rejects(f.service.bindSession(input), {
      code: "INVALID_INPUT",
    });
  assert.equal(f.calls.length, 0);
  await f.service.login({ email, password });
  await assert.rejects(
    f.service.bindSession({ expectedAccountId: "wrong-account" }),
    { code: "ACCOUNT_CHANGED" },
  );
  assert.equal(f.calls.length, 2);
});

for (const action of [
  "logout",
  "same-account-login",
  "different-account-login",
  "failed-login",
]) {
  test(`a lease aborts immediately on ${action}`, async (t) => {
    const replies = [sessionReply(), accountReply, accountReply];
    if (action !== "logout")
      replies.push(
        action === "failed-login"
          ? () => jsonResponse({}, 401)
          : sessionReply(
              "new-access",
              "new-renewal",
              action === "same-account-login" ? "user-1" : "user-2",
            ),
      );
    if (!["logout", "failed-login"].includes(action))
      replies.push(accountReply);
    const f = await fixture(t, replies);
    await f.service.login({ email, password });
    const lease = await f.service.bindSession();
    const pending =
      action === "logout"
        ? f.service.logout()
        : f.service.login({ email, password });
    assert.equal(lease.signal.aborted, true);
    assert.throws(lease.check, { code: "ACCOUNT_CHANGED" });
    if (action === "failed-login")
      await assert.rejects(pending, { code: "INVALID_CREDENTIALS" });
    else await pending;
    assert.throws(lease.check, { code: "ACCOUNT_CHANGED" });
    lease.dispose();
  });
}

test("normal 401 token renewal keeps the lease usable across requests", async (t) => {
  const f = await fixture(t, [
    sessionReply(),
    accountReply,
    accountReply,
    () => jsonResponse({}, 401),
    sessionReply("renewed-access", "renewed-refresh"),
    { result: "OK" },
    { result: "OK" },
  ]);
  await f.service.login({ email, password });
  const lease = await f.service.bindSession();
  const input = {
    path: "/mods",
    query: { modId: "123", modVersion: "11" },
    signal: lease.signal,
    expectedAccountId: lease.accountId,
  };
  assert.deepEqual(await f.service.request(input), { result: "OK" });
  lease.check();
  assert.equal(lease.signal.aborted, false);
  assert.deepEqual(await f.service.request(input), { result: "OK" });
  lease.check();
  assert.equal(
    f.calls.filter((call) => JSON.parse(call.headers.Authorization).renewal)
      .length,
    1,
  );
  lease.dispose();
});

for (const expiry of [
  "no-refresh-token",
  "invalid-renewal",
  "renewal-changes-user",
  "second-401",
]) {
  test(`${expiry} expires all existing leases with a stable reason`, async (t) => {
    const replies = [
      sessionReply(access, expiry === "no-refresh-token" ? null : renewal),
      accountReply,
      accountReply,
      accountReply,
      () => jsonResponse({}, 401),
    ];
    if (expiry === "invalid-renewal") replies.push(() => jsonResponse({}, 401));
    if (expiry === "renewal-changes-user")
      replies.push(sessionReply("new", "next", "another-user"));
    if (expiry === "second-401")
      replies.push(sessionReply("new", "next"), () => jsonResponse({}, 401));
    const f = await fixture(t, replies);
    await f.service.login({ email, password });
    const first = await f.service.bindSession(),
      second = await f.service.bindSession();
    await assert.rejects(
      f.service.request({ path: "/mods", query: { modId: "123" } }),
      { code: "SESSION_EXPIRED" },
    );
    for (const lease of [first, second]) {
      assert.equal(lease.signal.aborted, true);
      assert.throws(lease.check, { code: "SESSION_EXPIRED" });
      lease.dispose();
    }
  });
}

test("expiration aborts a lease before pending credential deletion finishes", async (t) => {
  const f = await fixture(t, [
    sessionReply(access, null),
    accountReply,
    accountReply,
    () => jsonResponse({}, 401),
  ]);
  await f.service.login({ email, password });
  const lease = await f.service.bindSession();
  let finishDelete, started;
  const deleting = new Promise((resolve) => {
    started = resolve;
  });
  const unlink = fs.unlink,
    hook = t.mock.method(fs, "unlink", (file) =>
      file === f.sessionPath
        ? new Promise((resolve) => {
            finishDelete = resolve;
            started();
          })
        : unlink(file),
    );
  const pending = assert.rejects(
    f.service.request({ path: "/mods", query: { modId: "123" } }),
    { code: "SESSION_EXPIRED" },
  );
  try {
    await deleting;
    assert.equal(lease.signal.aborted, true);
    assert.throws(lease.check, { code: "SESSION_EXPIRED" });
    finishDelete();
    await pending;
  } finally {
    finishDelete?.();
    hook.mock.restore();
    lease.dispose();
  }
});

test("external cancellation releases only its lease while other requests remain usable", async (t) => {
  const f = await fixture(t, [
    sessionReply(),
    accountReply,
    accountReply,
    accountReply,
    { result: "OK" },
  ]);
  await f.service.login({ email, password });
  const external = new AbortController();
  const first = await f.service.bindSession({ signal: external.signal }),
    second = await f.service.bindSession();
  external.abort();
  assert.equal(first.signal.aborted, true);
  assert.throws(first.check, { code: "CANCELLED" });
  second.check();
  assert.deepEqual(
    await f.service.request({
      path: "/mods",
      query: { modId: "123" },
      signal: second.signal,
    }),
    { result: "OK" },
  );
  first.dispose();
  second.dispose();
});

test("cancelLogin is inert for a completed login and cancels an active replacement login", async (t) => {
  let started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const f = await fixture(t, [
    sessionReply(),
    accountReply,
    accountReply,
    (_url, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener(
          "abort",
          () => reject(new Error("fixture abort")),
          { once: true },
        );
        started();
      }),
  ]);
  await f.service.login({ email, password });
  const lease = await f.service.bindSession();
  await f.service.cancelLogin();
  lease.check();
  assert.equal(lease.signal.aborted, false);
  const replacement = assert.rejects(f.service.login({ email, password }), {
    code: "CANCELLED",
  });
  await ready;
  await f.service.cancelLogin();
  await replacement;
  assert.throws(lease.check, { code: "ACCOUNT_CHANGED" });
});

test("a remembered login can be bound through its normal refresh without exposing persistence data", async (t) => {
  const f = await fixture(t, [
    sessionReply("restored-access", "restored-refresh"),
    accountReply,
  ]);
  await fs.writeFile(
    f.sessionPath,
    JSON.stringify({
      version: 1,
      ciphertext: f
        .encryptString(JSON.stringify({ version: 1, refreshToken: renewal }))
        .toString("base64"),
    }),
  );
  const lease = await f.service.bindSession({ expectedAccountId: "user-1" });
  assert.equal(lease.accountId, "user-1");
  lease.check();
  assert.ok(JSON.parse(f.calls[0].headers.Authorization).renewal);
  assertNoSecrets(lease, ["restored-access", "restored-refresh", renewal]);
  const persisted = JSON.parse(await fs.readFile(f.sessionPath, "utf8"));
  assert.deepEqual(Object.keys(persisted).sort(), ["ciphertext", "version"]);
  lease.dispose();
});

for (const nextUser of ["user-1", "user-2"]) {
  test(`binding cannot adopt ${nextUser} after login changes during saved-session initialization`, async (t) => {
    let started, finish;
    const ready = new Promise((resolve) => {
      started = resolve;
    });
    const f = await fixture(t, [
      sessionReply("replacement-access", "replacement-refresh", nextUser),
      accountReply,
    ]);
    await fs.writeFile(
      f.sessionPath,
      JSON.stringify({
        version: 1,
        ciphertext: Buffer.from("fixture encrypted").toString("base64"),
      }),
    );
    const service = createAccountService({
      ...f.config,
      decryptString: () =>
        new Promise((resolve) => {
          finish = resolve;
          started();
        }),
    });
    const pending = assert.rejects(service.bindSession(), {
      code: "ACCOUNT_CHANGED",
    });
    await ready;
    const next = service.login({ email, password });
    await pending;
    assert.equal(f.calls.length, 0);
    finish(JSON.stringify({ version: 1, refreshToken: renewal }));
    assert.equal((await next).account.id, nextUser);
    assert.equal(f.calls.length, 2);
  });
}

test("external abort rejects a binding while saved-session decryption remains pending", async (t) => {
  let started, finish;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const f = await fixture(t);
  await fs.writeFile(
    f.sessionPath,
    JSON.stringify({
      version: 1,
      ciphertext: Buffer.from("fixture encrypted").toString("base64"),
    }),
  );
  const service = createAccountService({
    ...f.config,
    decryptString: () =>
      new Promise((resolve) => {
        finish = resolve;
        started();
      }),
  });
  const external = new AbortController(),
    pending = assert.rejects(service.bindSession({ signal: external.signal }), {
      code: "CANCELLED",
    });
  await ready;
  external.abort();
  await pending;
  assert.equal(f.calls.length, 0);
  finish(JSON.stringify({ version: 1, refreshToken: renewal }));
  await service.logout();
});

test("a late account-details reply cannot revive a binding after same-user login", async (t) => {
  let started, finish;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const f = await fixture(t, [
    sessionReply(),
    accountReply,
    () =>
      new Promise((resolve) => {
        finish = resolve;
        started();
      }),
    sessionReply("new-access", "new-refresh"),
    accountReply,
  ]);
  await f.service.login({ email, password });
  const pending = assert.rejects(f.service.bindSession(), {
    code: "ACCOUNT_CHANGED",
  });
  await ready;
  const login = f.service.login({ email, password });
  await pending;
  await login;
  finish(jsonResponse(accountReply));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.calls.length, 5);
});

test("a temporary renewal failure does not invalidate an established lease", async (t) => {
  const f = await fixture(t, [
    sessionReply(),
    accountReply,
    accountReply,
    () => jsonResponse({}, 401),
    new Error("transport unavailable"),
  ]);
  await f.service.login({ email, password });
  const lease = await f.service.bindSession();
  await assert.rejects(
    f.service.request({ path: "/mods", query: { modId: "123" } }),
    { code: "NETWORK_ERROR" },
  );
  lease.check();
  assert.equal(lease.signal.aborted, false);
  lease.dispose();
});
