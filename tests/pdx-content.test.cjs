"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { performance } = require("node:perf_hooks");
const { createPdxContentService } = require("../electron/pdx-content.cjs");
const { fixtureIntegrity } = require("../scripts/pdx-fixture-integrity.cjs");
const { version } = require("../package.json");

const archive = Buffer.from(`504b0506${"00".repeat(18)}`, "hex");
const digest = (data) => createHash("sha256").update(data).digest();
const metadata = (changes = {}) => ({
  result: "OK",
  modDetail: {
    modId: "157712",
    game: "hoi4",
    name: "6cca83a0-a6ec-11f1-92e5-affbeaa2abe2",
    displayName: "Fixture mod",
    os: "Any",
    arch: "Any",
    modVersion: "12",
    state: "published",
    updating: false,
    acl: "public",
    isRegionBlocked: false,
    requiredVersion: "1.19.*",
    ...changes,
  },
});
const manifest = (data = archive) =>
  `Name: Any__Any\nHash: sha256\n\nfixture.zip,${data.length},${digest(data).toString("base64")},crw,4096,zip\n`;
const plan = (data = archive) => ({
  modId: "157712",
  name: "6cca83a0-a6ec-11f1-92e5-affbeaa2abe2",
  title: "Fixture mod",
  revision: "12",
  platform: "Any__Any",
  filename: "fixture.zip",
  bytes: data.length,
  sha256: digest(data).toString("hex"),
  supportedVersion: "1.19.*",
  archiveUrl:
    "https://modscontent.paradox-interactive.com/hoi4/6cca83a0-a6ec-11f1-92e5-affbeaa2abe2/repo/Any__Any/12/complete/fixture.zip",
});
const json = (data, options = {}) =>
  new Response(JSON.stringify(data), options);
const code = (expected) => (error) => error.code === expected;
function queue(replies, options = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, ...init });
    assert.ok(replies.length, `Unexpected request: ${url}`);
    const next = replies.shift();
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next(url, init) : next;
  };
  return {
    service: createPdxContentService({
      integrity: fixtureIntegrity,
      fetchImpl,
      ...options,
    }),
    calls,
  };
}
async function temporary(t) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "ironclad-pdx-content-"),
  );
  t.after(() =>
    fs.rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    }),
  );
  return { root, destination: path.join(root, "download.zip") };
}
const missing = async (file) =>
  assert.rejects(fs.lstat(file), { code: "ENOENT" });

test("repair uses the signed complete archive's content-addressed file without altering its public plan", async (t) => {
  const { destination } = await temporary(t);
  const { service, calls } = queue([
    json(metadata()),
    new Response(manifest()),
    new Response(archive),
  ]);
  const resolved = await service.resolve({ modId: 157712, repair: true });
  assert.deepEqual(resolved, plan());
  await service.download(
    { ...resolved },
    { resolvedPlan: resolved, destination },
  );
  assert.deepEqual(await fs.readFile(destination), archive);
  assert.equal(calls.length, 3);
  assert.equal(
    calls[2].url,
    plan().archiveUrl.split("/12/complete/")[0] +
      `/files/${archive.length}_${digest(archive).toString("base64url")}=`,
  );
});

test("only an explicit files 404 falls back and cancels that body before complete download", async (t) => {
  const { destination } = await temporary(t);
  let cancelled = false;
  const absent = new Response(
    new ReadableStream({
      cancel() {
        cancelled = true;
      },
    }),
    { status: 404 },
  );
  const { service, calls } = queue([
    json(metadata()),
    new Response(manifest()),
    absent,
    () => {
      assert.equal(cancelled, true);
      return new Response(archive);
    },
  ]);
  const resolved = await service.resolve({ modId: 157712, repair: true });
  await service.download(resolved, { destination });
  assert.equal(calls[3].url, plan().archiveUrl);
  assert.deepEqual(await fs.readFile(destination), archive);
});

for (const [status, expected] of [
  [401, "ACCESS_DENIED"],
  [403, "ACCESS_DENIED"],
  [429, "RATE_LIMITED"],
  [500, "NETWORK_ERROR"],
  [302, "REDIRECT_NOT_ALLOWED"],
])
  test(`files HTTP ${status} cannot fall back to another source`, async (t) => {
    const { destination } = await temporary(t);
    const { service, calls } = queue([
      json(metadata()),
      new Response(manifest()),
      new Response(null, { status }),
    ]);
    const resolved = await service.resolve({ modId: 157712, repair: true });
    await assert.rejects(
      service.download(resolved, { destination }),
      code(expected),
    );
    assert.equal(calls.length, 3);
    await missing(destination);
  });

test("corrupt files data stops with a hash error without downloading a complete substitute", async (t) => {
  const { destination } = await temporary(t),
    corrupt = Buffer.from(archive);
  corrupt[0] ^= 1;
  const { service, calls } = queue([
    json(metadata()),
    new Response(manifest()),
    new Response(corrupt),
  ]);
  const resolved = await service.resolve({ modId: 157712, repair: true });
  await assert.rejects(
    service.download(resolved, { destination }),
    code("HASH_MISMATCH"),
  );
  assert.equal(calls.length, 3);
  await missing(destination);
});

test("repair capability binds all canonical plan fields and rejects malformed operation before IO", async (t) => {
  const { destination } = await temporary(t);
  const { service, calls } = queue([
    json(metadata()),
    new Response(manifest()),
  ]);
  for (const repair of [null, 1, "true", {}])
    await assert.rejects(
      service.resolve({ modId: 157712, repair }),
      code("INVALID_INPUT"),
    );
  const resolved = await service.resolve({ modId: 157712, repair: true });
  await assert.rejects(
    service.download(
      { ...resolved, sha256: "ff".repeat(32) },
      { resolvedPlan: resolved, destination },
    ),
    code("INVALID_PLAN"),
  );
  assert.equal(calls.length, 2);
  await missing(destination);
});

test("cancelling while discarding a files 404 prevents the complete fallback", async (t) => {
  const { destination } = await temporary(t),
    controller = new AbortController();
  const absent = new Response(
    new ReadableStream({
      cancel() {
        controller.abort();
      },
    }),
    { status: 404 },
  );
  const { service, calls } = queue([
    json(metadata()),
    new Response(manifest()),
    absent,
  ]);
  const resolved = await service.resolve({ modId: 157712, repair: true });
  await assert.rejects(
    service.download(resolved, { destination, signal: controller.signal }),
    code("CANCELLED"),
  );
  assert.equal(calls.length, 3);
  await missing(destination);
});

for (const expected of [
  "ACCESS_DENIED",
  "REQUEST_FAILED",
  "SESSION_EXPIRED",
  "INVALID_RESPONSE",
])
  test(`a private files grant ${expected} cannot downgrade to anonymous or complete content`, async (t) => {
    const { destination } = await temporary(t),
      accountCalls = [];
    const repositoryPath = `mods/hoi4/${plan().name}/repo/Any__Any`;
    const account = {
      async request(input) {
        accountCalls.push(input.path);
        if (input.path === "/mods")
          return metadata({ acl: "private", repositoryPath });
        if (input.path.endsWith("/manifest"))
          return {
            prepend: "https://signed.example.com/manifest",
            append: "?signature=private",
            ttl: String(Math.floor(Date.now() / 1000) + 3600),
          };
        assert.match(input.path, /\/files\//);
        throw Object.assign(new Error("fixture-only secret"), {
          code: expected,
        });
      },
    };
    const { service, calls } = queue([new Response(manifest())], { account });
    const resolved = await service.resolve({
      modId: 157712,
      repair: true,
      expectedAccountId: "fixture-account",
    });
    await assert.rejects(
      service.download(resolved, { destination }),
      (error) =>
        error.code === expected &&
        !error.message.includes("fixture-only secret"),
    );
    assert.equal(calls.length, 1);
    assert.equal(accountCalls.length, 3);
    await missing(destination);
  });

test("canonical padded Base64URL manifest hashes support official CPatch encoding", async () => {
  const expected = "ff".repeat(32),
    original = digest(archive).toString("base64");
  const { service } = queue([
    json(metadata()),
    new Response(manifest().replace(original, "_".repeat(42) + "8=")),
  ]);
  const resolved = await service.resolve({ modId: 157712 });
  assert.equal(resolved.sha256, expected);
});

test("resolve derives a complete pinned plan from public metadata and CRLF manifest", async () => {
  const { service, calls } = queue([
    json(metadata()),
    new Response(manifest().replaceAll("\n", "\r\n")),
  ]);
  assert.deepEqual(await service.resolve({ modId: 157712 }), plan());
  assert.equal(
    calls[0].url,
    "https://api.paradox-interactive.com/mods?modId=157712",
  );
  assert.equal(
    calls[1].url,
    plan().archiveUrl.replace("fixture.zip", "manifest"),
  );
  for (const call of calls) {
    assert.equal(call.credentials, "omit");
    assert.equal(call.redirect, "manual");
    assert.equal(call.headers.Authorization, undefined);
    assert.equal(call.headers.Cookie, undefined);
    assert.equal(call.headers["User-Agent"], `IRONCLAD/${version}`);
  }
});

test("explicit revision is queried and must be the revision actually returned", async () => {
  const ok = queue([json(metadata()), new Response(manifest())]);
  await ok.service.resolve({ modId: "157712", revision: 12 });
  assert.match(ok.calls[0].url, /&modVersion=12$/);
  const mismatched = queue([json(metadata())]);
  await assert.rejects(
    mismatched.service.resolve({ modId: "157712", revision: "11" }),
    code("INVALID_METADATA"),
  );
  assert.equal(mismatched.calls.length, 1);
});

test("401 historical metadata is an explicit authorization error, with no fallback CDN request", async () => {
  const { service, calls } = queue([
    json({ result: "Failure" }, { status: 401 }),
  ]);
  await assert.rejects(
    service.resolve({ modId: "157712", revision: "11" }),
    code("ACCESS_DENIED"),
  );
  assert.equal(calls.length, 1);
});

test("resolve rejects malformed IDs before accessing the network", async () => {
  const { service, calls } = queue([]);
  for (const modId of [
    0,
    -1,
    1.5,
    NaN,
    Infinity,
    "",
    "01",
    "1?token=x",
    "../1",
    "9007199254740992",
    {},
  ])
    await assert.rejects(service.resolve({ modId }), code("INVALID_INPUT"));
  await assert.rejects(
    service.resolve({ modId: "1", revision: "latest" }),
    code("INVALID_INPUT"),
  );
  assert.equal(calls.length, 0);
});

test("resolve enforces matching HOI4 public published regional and platform metadata", async () => {
  for (const [changes, expected] of [
    [{ modId: "2" }, "INVALID_METADATA"],
    [{ game: "stellaris" }, "INVALID_METADATA"],
    [{ acl: "private" }, "ACCESS_DENIED"],
    [{ isRegionBlocked: true }, "REGION_BLOCKED"],
    [{ isRegionBlocked: undefined }, "REGION_BLOCKED"],
    [{ state: "publishing" }, "UNAVAILABLE"],
    [{ updating: true }, "UNAVAILABLE"],
    [{ os: "Linux" }, "UNAVAILABLE"],
    [{ actions: { canDownload: false } }, "UNAVAILABLE"],
    [{ name: "../outside" }, "INVALID_METADATA"],
    [{ arch: "Any/../../else" }, "INVALID_METADATA"],
    [{ modVersion: "12?x=y" }, "INVALID_METADATA"],
    [{ displayName: "" }, "INVALID_METADATA"],
  ]) {
    const { service, calls } = queue([json(metadata(changes))]);
    await assert.rejects(service.resolve({ modId: "157712" }), code(expected));
    assert.equal(calls.length, 1);
  }
});

test("manifest validation rejects traversal, ambiguous records, hashes and algorithms", async () => {
  const invalid = [
    manifest().replace("fixture.zip", "../fixture.zip"),
    manifest().replace("fixture.zip", "folder\\fixture.zip"),
    manifest().replace("fixture.zip", "https://example.com/file.zip"),
    manifest().replace("fixture.zip", "CON.zip"),
    manifest().replace("fixture.zip", "fixture.zip?x=1"),
    manifest().replace("sha256", "md5"),
    manifest().replace("Name: Any__Any", "Name: Windows__Any"),
    manifest() + manifest().split("\n")[3],
    manifest().replace(
      digest(archive).toString("base64"),
      "A".repeat(43) + "!",
    ),
    manifest().replace(
      digest(archive).toString("base64"),
      "A".repeat(42) + "B=",
    ),
    manifest().replace(",22,", ",-22,"),
    manifest().replace(",zip\n", ",tar\n"),
  ];
  for (const text of invalid) {
    const { service } = queue([json(metadata()), new Response(text)]);
    await assert.rejects(
      service.resolve({ modId: "157712" }),
      code("INVALID_MANIFEST"),
    );
  }
});

test("metadata and manifest enforce advertised and streamed response limits", async () => {
  const cases = [
    [new Response("{}", { headers: { "content-length": "2097153" } })],
    [new Response(" ".repeat(2097153))],
    [
      json(metadata()),
      new Response("", { headers: { "content-length": "65537" } }),
    ],
    [json(metadata()), new Response(" ".repeat(65537))],
  ];
  for (const replies of cases) {
    const { service } = queue(replies);
    await assert.rejects(
      service.resolve({ modId: "157712" }),
      code("RESPONSE_TOO_LARGE"),
    );
  }
  const { service } = queue([json(metadata()), new Response(manifest())], {
    maxArchiveBytes: 21,
  });
  await assert.rejects(
    service.resolve({ modId: "157712" }),
    code("RESPONSE_TOO_LARGE"),
  );
});

test("all redirects and unexpectedly followed foreign responses are rejected", async () => {
  const redirects = [
    new Response(null, {
      status: 302,
      headers: { location: "https://evil.invalid/private" },
    }),
    new Response(null, { status: 307, headers: { location: "/mods?modId=1" } }),
  ];
  const followed = json(metadata());
  Object.defineProperty(followed, "url", {
    value: "https://evil.invalid/private",
  });
  redirects.push(followed);
  for (const response of redirects) {
    const { service, calls } = queue([response]);
    await assert.rejects(
      service.resolve({ modId: "157712" }),
      code("REDIRECT_NOT_ALLOWED"),
    );
    assert.equal(calls.length, 1);
  }
});

test("download streams an archive into a new file and reports verified bytes", async (t) => {
  const { destination } = await temporary(t);
  const progress = [];
  const { service } = queue([
    new Response(archive, {
      headers: { "content-length": String(archive.length) },
    }),
  ]);
  const result = await service.download(plan(), {
    destination,
    onProgress: (p) => progress.push(p),
  });
  assert.deepEqual(result, {
    path: destination,
    bytes: archive.length,
    sha256: plan().sha256,
  });
  assert.deepEqual(await fs.readFile(destination), archive);
  assert.equal(progress[0].receivedBytes, 0);
  assert.equal(progress.at(-1).receivedBytes, archive.length);
  assert.ok(
    progress.every(
      (p) =>
        p.totalBytes === archive.length &&
        Number.isFinite(p.bytesPerSecond) &&
        p.bytesPerSecond >= 0,
    ),
  );
});

test("download never overwrites or removes an existing target", async (t) => {
  const { destination } = await temporary(t);
  await fs.writeFile(destination, "preserve this");
  const { service, calls } = queue([]);
  await assert.rejects(
    service.download(plan(), { destination }),
    code("DESTINATION_EXISTS"),
  );
  assert.equal(await fs.readFile(destination, "utf8"), "preserve this");
  assert.equal(calls.length, 0);
});

test("download revalidates every path, size and hash before creating a file", async (t) => {
  const { destination } = await temporary(t);
  const { service, calls } = queue([]);
  for (const changes of [
    { archiveUrl: "https://evil.invalid/file.zip" },
    { filename: "../fixture.zip" },
    { name: "../wrong" },
    { revision: "12/../11" },
    { bytes: -1 },
    { platform: "Any__Any/../../" },
    { sha256: "A".repeat(64) },
    { archiveUrl: plan().archiveUrl + "?token=secret" },
  ])
    await assert.rejects(
      service.download({ ...plan(), ...changes }, { destination }),
      code("INVALID_PLAN"),
    );
  await assert.rejects(
    service.download(plan(), { destination: "relative.zip" }),
    code("INVALID_INPUT"),
  );
  await assert.rejects(
    service.download(plan(), { destination, bytesPerSecond: -1 }),
    code("INVALID_INPUT"),
  );
  await missing(destination);
  assert.equal(calls.length, 0);
});

test("length mismatches, overflow and hash failures clean only the new file", async (t) => {
  const { destination } = await temporary(t);
  const cases = [
    [
      new Response(archive, { headers: { "content-length": "99" } }),
      "SIZE_MISMATCH",
    ],
    [new Response(archive.subarray(0, 8)), "SIZE_MISMATCH"],
    [
      new Response(Buffer.concat([archive, Buffer.from("extra")])),
      "SIZE_MISMATCH",
    ],
    [new Response(Buffer.alloc(archive.length)), "HASH_MISMATCH"],
    [
      new Response(null, {
        status: 302,
        headers: { location: "https://evil.invalid" },
      }),
      "REDIRECT_NOT_ALLOWED",
    ],
    [new Error("fixture secret must not leak"), "NETWORK_ERROR"],
  ];
  for (const [response, expected] of cases) {
    const { service } = queue([response]);
    await assert.rejects(
      service.download(plan(), { destination }),
      (error) => error.code === expected && !error.message.includes("secret"),
    );
    await missing(destination);
  }
});

test("cancellation during streaming removes the partial file", async (t) => {
  const { destination } = await temporary(t);
  const data = Buffer.alloc(200000, 7);
  const controller = new AbortController();
  const { service } = queue([new Response(data)]);
  await assert.rejects(
    service.download(plan(data), {
      destination,
      signal: controller.signal,
      onProgress(p) {
        if (p.receivedBytes > 0) controller.abort();
      },
    }),
    code("CANCELLED"),
  );
  await missing(destination);
});

test("an already aborted request neither creates a file nor requests content", async (t) => {
  const { destination } = await temporary(t);
  const controller = new AbortController();
  controller.abort();
  const { service, calls } = queue([]);
  await assert.rejects(
    service.resolve({ modId: 157712, signal: controller.signal }),
    code("CANCELLED"),
  );
  await assert.rejects(
    service.download(plan(), { destination, signal: controller.signal }),
    code("CANCELLED"),
  );
  assert.equal(calls.length, 0);
  await missing(destination);
});

test("timeouts cover pending headers, pending bodies and throttling", async (t) => {
  const { destination } = await temporary(t);
  const pending = () => new Promise(() => {});
  const header = queue([pending], { timeoutMs: 30 });
  await assert.rejects(
    header.service.resolve({ modId: "157712" }),
    code("TIMEOUT"),
  );
  const body = queue([new Response(new ReadableStream({ pull: pending }))], {
    timeoutMs: 30,
  });
  await assert.rejects(
    body.service.download(plan(), { destination }),
    code("TIMEOUT"),
  );
  await missing(destination);
  const throttled = queue([new Response(archive)], { timeoutMs: 30 });
  await assert.rejects(
    throttled.service.download(plan(), { destination, bytesPerSecond: 1 }),
    code("TIMEOUT"),
  );
  await missing(destination);
});

test("rate limiting delays the received byte budget and remains cancellable", async (t) => {
  const { destination } = await temporary(t);
  const { service } = queue([new Response(archive)]);
  const before = performance.now();
  await service.download(plan(), { destination, bytesPerSecond: 220 });
  assert.ok(performance.now() - before >= 90);
});

test("a replacement target is preserved when downloading fails", async (t) => {
  const { root, destination } = await temporary(t);
  const original = path.join(root, "original.zip");
  const { service } = queue([
    async () => {
      await fs.rename(destination, original);
      await fs.writeFile(destination, "replacement must survive");
      return new Response("wrong size");
    },
  ]);
  await assert.rejects(
    service.download(plan(), { destination }),
    code("DESTINATION_CHANGED"),
  );
  assert.equal(
    await fs.readFile(destination, "utf8"),
    "replacement must survive",
  );
  assert.ok((await fs.stat(original)).isFile());
});

test("a replacement target cannot be reported as the verified download", async (t) => {
  const { root, destination } = await temporary(t);
  const { service } = queue([
    async () => {
      await fs.rename(destination, path.join(root, "original.zip"));
      await fs.writeFile(destination, "replacement must survive");
      return new Response(archive);
    },
  ]);
  await assert.rejects(
    service.download(plan(), { destination }),
    code("DESTINATION_CHANGED"),
  );
  assert.equal(
    await fs.readFile(destination, "utf8"),
    "replacement must survive",
  );
});

test("observer failures do not corrupt a successful download", async (t) => {
  const { destination } = await temporary(t);
  const { service } = queue([new Response(archive)]);
  const result = await service.download(plan(), {
    destination,
    onProgress() {
      throw new Error("observer");
    },
  });
  assert.equal(result.sha256, plan().sha256);
});

test("service rejects unsafe settings", () => {
  for (const options of [
    { timeoutMs: 0 },
    { timeoutMs: Infinity },
    { maxArchiveBytes: 0 },
    { fetchImpl: null },
  ])
    assert.throws(
      () => createPdxContentService(options),
      code("INVALID_INPUT"),
    );
});

test("network error codes cannot masquerade as internal errors or leak messages", async (t) => {
  const { destination } = await temporary(t);
  const secret = "fixture response detail must not escape";
  const inherited = Object.assign(new Error(secret), { code: "toString" });
  const metadataRequest = queue([inherited]);
  await assert.rejects(
    metadataRequest.service.resolve({ modId: "157712" }),
    (error) =>
      error.code === "NETWORK_ERROR" && !error.message.includes(secret),
  );
  const brokenBody = new Response(
    new ReadableStream({
      start(controller) {
        controller.error(
          Object.assign(new Error(secret), { code: "UND_ERR_SOCKET" }),
        );
      },
    }),
  );
  const archiveRequest = queue([brokenBody]);
  await assert.rejects(
    archiveRequest.service.download(plan(), { destination }),
    (error) =>
      error.code === "NETWORK_ERROR" && !error.message.includes(secret),
  );
  await missing(destination);
});

test("synchronous cancellation inside fetch does not leave an unhandled rejection", async (t) => {
  const { destination } = await temporary(t);
  const controller = new AbortController();
  const { service } = queue([
    () => {
      controller.abort();
      return Promise.reject(new Error("cancelled network"));
    },
  ]);
  await assert.rejects(
    service.download(plan(), { destination, signal: controller.signal }),
    code("CANCELLED"),
  );
  await missing(destination);
});

test("configured accounts remain unused until an account is explicitly selected", async () => {
  const { service, calls } = queue(
    [json(metadata()), new Response(manifest())],
    {
      account: {
        request() {
          assert.fail("Anonymous metadata must not use the account");
        },
        bindSession() {
          assert.fail("The coordinator owns account binding");
        },
      },
    },
  );
  assert.deepEqual(
    await service.resolve({ modId: "157712", revision: "12" }),
    plan(),
  );
  assert.equal(calls.length, 2);
  assert.equal(
    calls[0].url,
    "https://api.paradox-interactive.com/mods?modId=157712&modVersion=12",
  );
});

test("authorized metadata uses the selected account and exact fixed revision while returning a credential-free plan", async () => {
  const accountCalls = [];
  const { service, calls } = queue([new Response(manifest())], {
    account: {
      request(input) {
        accountCalls.push(input);
        return {
          ...metadata(),
          token: "fixture-private-token",
          refreshToken: "fixture-private-refresh",
        };
      },
      bindSession() {
        assert.fail("The coordinator owns account binding");
      },
    },
  });
  const result = await service.resolve({
    modId: 157712,
    revision: 12,
    expectedAccountId: "selected-user",
  });
  assert.deepEqual(result, plan());
  assert.equal(accountCalls.length, 1);
  const { signal, ...request } = accountCalls[0];
  assert.deepEqual(request, {
    method: "GET",
    path: "/mods",
    query: { modId: "157712", modVersion: "12" },
    expectedAccountId: "selected-user",
  });
  assert.ok(signal instanceof AbortSignal);
  assert.equal(signal.aborted, false);
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    plan().archiveUrl.replace("fixture.zip", "manifest"),
  );
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(
    serialized,
    /fixture-private|selected-user|token|session|account/i,
  );
});

test("authorized current metadata does not invent a revision query", async () => {
  let request;
  const { service } = queue([new Response(manifest())], {
    account: {
      request(input) {
        request = input;
        return metadata();
      },
    },
  });
  assert.deepEqual(
    await service.resolve({
      modId: "157712",
      expectedAccountId: "selected-user",
    }),
    plan(),
  );
  assert.deepEqual(request.query, { modId: "157712" });
});

test("account-authorized private content signs manifest and ZIP separately without exposing grants in plans", async (t) => {
  const { destination } = await temporary(t);
  const accountCalls = [];
  const repositoryPath = `mods/hoi4/${plan().name}/repo/Any__Any`;
  const { service, calls } = queue(
    [
      new Response(manifest()),
      new Response(archive, {
        headers: { "Content-Length": String(archive.length) },
      }),
    ],
    {
      account: {
        async request(input) {
          accountCalls.push(input);
          if (input.path === "/mods")
            return metadata({ acl: "private", repositoryPath });
          assert.equal(
            input.path.startsWith(`/patch/repo/${repositoryPath}/12/complete/`),
            true,
          );
          return {
            result: "OK",
            prepend: `https://signed.example.com/${input.path.split("/").at(-1)}`,
            append: `?Signature=fixture-signed-${accountCalls.length}`,
            ttl: String(Math.floor(Date.now() / 1000) + 3600),
          };
        },
      },
    },
  );
  const resolved = await service.resolve({
    modId: "157712",
    revision: "12",
    expectedAccountId: "selected-user",
  });
  assert.deepEqual(resolved, { ...plan(), access: "repository" });
  assert.doesNotMatch(
    JSON.stringify(resolved),
    /signed.example|Signature|selected-user/,
  );
  // The coordinator stores only this serializable canonical plan and passes
  // the original resolution as an ephemeral capability alongside it.
  const savedPlan = JSON.parse(JSON.stringify(resolved));
  await assert.rejects(
    service.download(savedPlan, { destination }),
    code("INVALID_PLAN"),
  );
  assert.equal(calls.length, 1);
  const result = await service.download(savedPlan, {
    destination,
    resolvedPlan: resolved,
  });
  assert.equal(result.sha256, plan().sha256);
  assert.deepEqual(await fs.readFile(destination), archive);
  assert.deepEqual(
    accountCalls.map((item) => item.path),
    [
      "/mods",
      `/patch/repo/${repositoryPath}/12/complete/manifest`,
      `/patch/repo/${repositoryPath}/12/complete/fixture.zip`,
    ],
  );
  for (const input of accountCalls) {
    assert.equal(input.expectedAccountId, "selected-user");
    assert.ok(input.signal instanceof AbortSignal);
  }
  assert.deepEqual(
    calls.map((item) => item.url),
    [
      "https://signed.example.com/manifest?Signature=fixture-signed-2",
      "https://signed.example.com/fixture.zip?Signature=fixture-signed-3",
    ],
  );
  for (const input of calls) {
    const headers = new Headers(input.headers);
    assert.equal(headers.has("authorization"), false);
    assert.equal(headers.has("cookie"), false);
    assert.equal(input.redirect, "manual");
    assert.equal(input.credentials, "omit");
  }
});

test("unlisted metadata returned anonymously uses the normal complete-package path", async () => {
  const { service, calls } = queue([
    json(metadata({ acl: "unlisted" })),
    new Response(manifest()),
  ]);
  assert.deepEqual(await service.resolve({ modId: "157712" }), plan());
  assert.equal(calls.length, 2);
});

for (const status of [401, 403]) {
  test(`a private content ${status} stops without retrying the unsigned URL or leaking signed response text`, async () => {
    const accountCalls = [];
    const repositoryPath = `mods/hoi4/${plan().name}/repo/Any__Any`;
    const { service, calls } = queue(
      [new Response("fixture-signature-must-not-leak", { status })],
      {
        account: {
          async request(input) {
            accountCalls.push(input);
            if (input.path === "/mods")
              return metadata({ acl: "private", repositoryPath });
            return {
              prepend: "https://signed.example.com/manifest",
              append: "?Signature=fixture-signature-must-not-leak",
              ttl: String(Math.floor(Date.now() / 1000) + 3600),
            };
          },
        },
      },
    );
    await assert.rejects(
      service.resolve({ modId: "157712", expectedAccountId: "selected-user" }),
      (error) => {
        assert.equal(error.code, "ACCESS_DENIED");
        assert.doesNotMatch(
          error.message,
          /匿名|fixture-signature|signed.example/,
        );
        return true;
      },
    );
    assert.equal(calls.length, 1);
    assert.equal(accountCalls.length, 2);
  });
}

test("a mutated private canonical plan cannot reuse the authorized resource capability", async (t) => {
  const { destination } = await temporary(t);
  const { service, calls } = queue([new Response(manifest())], {
    account: {
      async request(input) {
        if (input.path === "/mods")
          return metadata({
            acl: "private",
            repositoryPath: `mods/hoi4/${plan().name}/repo/Any__Any`,
          });
        return {
          prepend: "https://signed.example.com/manifest",
          append: "?Signature=fixture",
          ttl: String(Math.floor(Date.now() / 1000) + 3600),
        };
      },
    },
  });
  const resolved = await service.resolve({
    modId: "157712",
    expectedAccountId: "selected-user",
  });
  await assert.rejects(
    service.download(
      { ...resolved, sha256: "a".repeat(64) },
      { destination, resolvedPlan: resolved },
    ),
    code("INVALID_PLAN"),
  );
  const withoutAccess = { ...resolved };
  delete withoutAccess.access;
  await assert.rejects(
    service.download(withoutAccess, { destination, resolvedPlan: resolved }),
    code("INVALID_PLAN"),
  );
  assert.equal(calls.length, 1);
  await missing(destination);
});

test("authorized metadata retains all content eligibility and exact revision checks before CDN access", async () => {
  for (const [changes, expected] of [
    [{ modId: "2" }, "INVALID_METADATA"],
    [{ game: "stellaris" }, "INVALID_METADATA"],
    [{ modVersion: "11" }, "INVALID_METADATA"],
    [{ acl: "private" }, "INVALID_METADATA"],
    [{ isRegionBlocked: true }, "REGION_BLOCKED"],
    [{ isRegionBlocked: undefined }, "REGION_BLOCKED"],
    [{ state: "publishing" }, "UNAVAILABLE"],
    [{ updating: true }, "UNAVAILABLE"],
    [{ os: "Linux" }, "UNAVAILABLE"],
    [{ actions: { canDownload: false } }, "UNAVAILABLE"],
    [{ name: "../outside" }, "INVALID_METADATA"],
    [{ arch: "Any/../../else" }, "INVALID_METADATA"],
    [{ displayName: "" }, "INVALID_METADATA"],
  ]) {
    let accountCalls = 0;
    const { service, calls } = queue([], {
      account: {
        request() {
          accountCalls++;
          return metadata(changes);
        },
      },
    });
    await assert.rejects(
      service.resolve({
        modId: "157712",
        revision: "12",
        expectedAccountId: "selected-user",
      }),
      code(expected),
    );
    assert.equal(accountCalls, 1);
    assert.equal(calls.length, 0);
  }
});

test("account request failures retain actionable codes without provider secrets or anonymous fallback", async () => {
  for (const expected of [
    "NOT_SIGNED_IN",
    "SESSION_EXPIRED",
    "ACCOUNT_CHANGED",
    "ACCESS_DENIED",
    "CANCELLED",
    "TIMEOUT",
    "RATE_LIMITED",
    "NETWORK_ERROR",
    "SERVICE_ERROR",
    "INVALID_RESPONSE",
    "REQUEST_FAILED",
    "STORAGE_ERROR",
  ]) {
    const { service, calls } = queue([], {
      account: {
        request() {
          throw Object.assign(new Error("fixture-private-provider-response"), {
            code: expected,
          });
        },
      },
    });
    await assert.rejects(
      service.resolve({
        modId: "157712",
        revision: "12",
        expectedAccountId: "selected-user",
      }),
      (error) => {
        assert.equal(error.code, expected);
        assert.doesNotMatch(error.message, /fixture-private/);
        if (expected === "ACCESS_DENIED") {
          assert.match(error.message, /当前 Paradox 账号/);
          assert.doesNotMatch(error.message, /匿名/);
        }
        return true;
      },
    );
    assert.equal(calls.length, 0);
  }
  for (const providerCode of ["CUSTOM", "toString", "__proto__", undefined]) {
    const { service, calls } = queue([], {
      account: {
        request() {
          return Promise.reject(
            Object.assign(new Error("fixture-private-provider-response"), {
              code: providerCode,
            }),
          );
        },
      },
    });
    await assert.rejects(
      service.resolve({ modId: "157712", expectedAccountId: "selected-user" }),
      (error) =>
        error.code === "NETWORK_ERROR" &&
        !error.message.includes("fixture-private"),
    );
    assert.equal(calls.length, 0);
  }
});

for (const status of [401, 403]) {
  test(`CDN manifest ${status} after account metadata stops without authenticated retry`, async () => {
    let accountCalls = 0;
    const { service, calls } = queue(
      [new Response("fixture-private-CDN-response", { status })],
      {
        account: {
          request() {
            accountCalls++;
            return metadata();
          },
        },
      },
    );
    await assert.rejects(
      service.resolve({
        modId: "157712",
        revision: "12",
        expectedAccountId: "selected-user",
      }),
      (error) => {
        assert.equal(error.code, "ACCESS_DENIED");
        assert.match(error.message, /下载文件/);
        assert.doesNotMatch(error.message, /匿名|fixture-private/);
        return true;
      },
    );
    assert.equal(accountCalls, 1);
    assert.equal(calls.length, 1);
    assert.equal(
      new URL(calls[0].url).origin,
      "https://modscontent.paradox-interactive.com",
    );
    assert.equal(calls[0].credentials, "omit");
    assert.equal(calls[0].redirect, "manual");
    const headers = new Headers(calls[0].headers);
    assert.equal(headers.has("Authorization"), false);
    assert.equal(headers.has("Cookie"), false);
  });

  test(`CDN archive ${status} stays anonymous and removes only its new file`, async (t) => {
    const { destination } = await temporary(t);
    let accountCalls = 0;
    const { service, calls } = queue(
      [
        new Response(manifest()),
        new Response("fixture-private-CDN-response", { status }),
      ],
      {
        account: {
          request() {
            accountCalls++;
            return metadata();
          },
        },
      },
    );
    const result = await service.resolve({
      modId: "157712",
      revision: "12",
      expectedAccountId: "selected-user",
    });
    await assert.rejects(
      service.download(result, { destination }),
      (error) =>
        error.code === "ACCESS_DENIED" &&
        !/匿名|fixture-private/.test(error.message),
    );
    assert.equal(accountCalls, 1);
    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.equal(
        new URL(call.url).origin,
        "https://modscontent.paradox-interactive.com",
      );
      assert.equal(call.credentials, "omit");
      assert.equal(call.redirect, "manual");
      const headers = new Headers(call.headers);
      assert.equal(headers.has("Authorization"), false);
      assert.equal(headers.has("Cookie"), false);
    }
    await missing(destination);
  });
}

test("account metadata cannot authorize a CDN redirect", async () => {
  let accountCalls = 0;
  const { service, calls } = queue(
    [
      new Response(null, {
        status: 302,
        headers: { location: "https://api.paradox-interactive.com/private" },
      }),
    ],
    {
      account: {
        request() {
          accountCalls++;
          return metadata();
        },
      },
    },
  );
  await assert.rejects(
    service.resolve({ modId: "157712", expectedAccountId: "selected-user" }),
    code("REDIRECT_NOT_ALLOWED"),
  );
  assert.equal(accountCalls, 1);
  assert.equal(calls.length, 1);
});

test("account metadata timeout aborts the account request and never starts CDN", async () => {
  let request;
  const { service, calls } = queue([], {
    timeoutMs: 30,
    account: {
      request(input) {
        request = input;
        return new Promise(() => {});
      },
    },
  });
  await assert.rejects(
    service.resolve({ modId: "157712", expectedAccountId: "selected-user" }),
    code("TIMEOUT"),
  );
  assert.equal(request.signal.aborted, true);
  assert.equal(calls.length, 0);
});

test("account metadata cancellation rejects promptly and ignores a late successful response", async () => {
  const controller = new AbortController();
  let request, finish;
  const { service, calls } = queue([], {
    account: {
      request(input) {
        request = input;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    },
  });
  const pending = service.resolve({
    modId: "157712",
    expectedAccountId: "selected-user",
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(pending, code("CANCELLED"));
  assert.equal(request.signal.aborted, true);
  finish(metadata());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 0);
});

test("already aborted account metadata never calls the account", async () => {
  const controller = new AbortController();
  controller.abort();
  const { service, calls } = queue([], {
    account: {
      request() {
        assert.fail("Cancelled operation must not access account");
      },
    },
  });
  await assert.rejects(
    service.resolve({
      modId: "157712",
      expectedAccountId: "selected-user",
      signal: controller.signal,
    }),
    code("CANCELLED"),
  );
  assert.equal(calls.length, 0);
});

test("synchronous account cancellation handles a rejected request without unhandled rejection", async () => {
  const controller = new AbortController();
  const { service, calls } = queue([], {
    account: {
      request() {
        controller.abort();
        return Promise.reject(new Error("fixture-private-cancelled-request"));
      },
    },
  });
  await assert.rejects(
    service.resolve({
      modId: "157712",
      expectedAccountId: "selected-user",
      signal: controller.signal,
    }),
    code("CANCELLED"),
  );
  assert.equal(calls.length, 0);
});

test("account selection and adapter are validated before any request", async () => {
  const { service, calls } = queue([], {
    account: {
      request() {
        assert.fail("Invalid input must not access account");
      },
    },
  });
  for (const expectedAccountId of [
    null,
    "",
    1,
    {},
    "x".repeat(201),
    "user\nprivate",
    "user\0private",
  ]) {
    await assert.rejects(
      service.resolve({ modId: "157712", expectedAccountId }),
      code("INVALID_INPUT"),
    );
  }
  assert.equal(calls.length, 0);
  for (const account of [null, {}, { request: true }]) {
    assert.throws(
      () => createPdxContentService({ account }),
      code("INVALID_INPUT"),
    );
  }
  const signedOut = queue([]);
  await assert.rejects(
    signedOut.service.resolve({
      modId: "157712",
      expectedAccountId: "selected-user",
    }),
    code("NOT_SIGNED_IN"),
  );
  assert.equal(signedOut.calls.length, 0);
});

test("raw fetch and stream failures cannot impersonate recognized content errors", async (t) => {
  const { destination } = await temporary(t);
  for (const providerCode of ["ACCESS_DENIED", "CANCELLED", "FILE_ERROR"]) {
    const privateError = () =>
      Object.assign(new Error("fixture-private-transport-response"), {
        code: providerCode,
      });
    const metadataRequest = queue([privateError()]);
    await assert.rejects(
      metadataRequest.service.resolve({ modId: "157712" }),
      (error) =>
        error.code === "NETWORK_ERROR" &&
        !error.message.includes("fixture-private"),
    );
    const brokenBody = new Response(
      new ReadableStream({
        start(controller) {
          controller.error(privateError());
        },
      }),
    );
    const archiveRequest = queue([brokenBody]);
    await assert.rejects(
      archiveRequest.service.download(plan(), { destination }),
      (error) =>
        error.code === "NETWORK_ERROR" &&
        !error.message.includes("fixture-private"),
    );
    await missing(destination);
  }
});
