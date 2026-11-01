"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createPdxRepository,
  isRepositoryResourcePath,
  fileResource,
} = require("../electron/pdx-repository.cjs");

const TIME = 1_800_000_000_000;
const REPOSITORY =
  "mods/hoi4/6cca83a0-a6ec-11f1-92e5-affbeaa2abe2/repo/Any__Any";
const ACCOUNT = "fixture-account";
const PREFIX = `/patch/repo/${REPOSITORY}`;
const code = (expected) => (error) => error.code === expected;
const grant = (changes = {}) => ({
  result: "OK",
  prepend: "https://protected-cdn.example.net/resource/manifest",
  append: "?signature=fixture-only",
  ttl: String(TIME / 1000 + 300),
  ...changes,
});

test("installation and delta grants bind exact source, target and filename", async () => {
  for (const fromRevision of ["-1", "11"]) {
    const { repository, calls } = fixture([grant(), grant(), grant()]);
    for (const filename of [
      "manifest",
      "manifest.asc",
      `${fromRevision}_to_12.zip`,
    ]) {
      await repository.urlFor({
        patch: { revision: "12", fromRevision, filename },
      });
      const resource = `${PREFIX}/12/${fromRevision}_to_12/${filename}`;
      assert.equal(calls.at(-1).path, resource);
      assert.equal(calls.at(-1).expectedAccountId, ACCOUNT);
      assert.equal(isRepositoryResourcePath(resource), true);
    }
  }
});

test("patch routes reject cross-version aliases, unsupported files and mixed request forms", async () => {
  const { repository, calls } = fixture([]);
  for (const patch of [
    { revision: "12", fromRevision: "12", filename: "manifest" },
    { revision: "12", fromRevision: "01", filename: "manifest" },
    { revision: "12", fromRevision: "-2", filename: "manifest" },
    { revision: "12", fromRevision: "11", filename: "-1_to_12.zip" },
    { revision: "12", fromRevision: "11", filename: "11_to_13.zip" },
    { revision: "12", fromRevision: "11", filename: "manifest", extra: true },
  ])
    await assert.rejects(repository.urlFor({ patch }), code("INVALID_INPUT"));
  const patch = { revision: "12", fromRevision: "11", filename: "manifest" };
  for (const extra of [
    { revision: "12" },
    { filename: "manifest" },
    { resource: "repository.json" },
    { file: { bytes: 1, sha256: "00".repeat(32) } },
  ])
    await assert.rejects(
      repository.urlFor({ patch, ...extra }),
      code("INVALID_INPUT"),
    );
  for (const resource of [
    "12/11_to_13/manifest",
    "12/12_to_12/manifest",
    "12/-2_to_12/manifest",
    "12/01_to_12/manifest",
    "12/11_to_12/other.zip",
    "12/11_to_12/%6danifest",
  ])
    assert.equal(isRepositoryResourcePath(`${PREFIX}/${resource}`), false);
  assert.equal(calls.length, 0);
});
function fixture(replies, changes = {}) {
  const calls = [];
  const account = {
    async request(input) {
      assert.equal(this, account);
      calls.push(input);
      assert.ok(replies.length, "Unexpected repository grant request");
      const reply = replies.shift();
      if (reply instanceof Error) throw reply;
      return typeof reply === "function" ? reply(input) : reply;
    },
  };
  const options = {
    account,
    expectedAccountId: ACCOUNT,
    repositoryPath: REPOSITORY,
    now: () => TIME,
    ...changes,
  };
  return { repository: createPdxRepository(options), calls, options };
}

test("content-addressed file grants use canonical padded Base64URL and separate account-bound resources", async () => {
  const sha256 = "ff".repeat(32),
    resource = `files/22_${"_".repeat(42)}8=`,
    { repository, calls } = fixture([
      grant(),
      grant({ append: "?sig=complete" }),
    ]);
  assert.equal(fileResource(22, sha256), resource);
  assert.equal(isRepositoryResourcePath(`${PREFIX}/${resource}`), true);
  await repository.urlFor({ file: { bytes: 22, sha256 } });
  await repository.urlFor({ revision: 12, filename: "fixture.zip" });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].path, `${PREFIX}/${resource}`);
  assert.equal(calls[0].expectedAccountId, ACCOUNT);
  assert.equal(calls[1].path, `${PREFIX}/12/complete/fixture.zip`);
});

test("file routes reject noncanonical hashes, aliases and path encoding", async () => {
  const resource = `files/22_${"_".repeat(42)}8=`;
  for (const invalid of [
    resource.replace("22_", "022_"),
    resource.replace("22_", "0_"),
    resource.replace("22_", "9007199254740992_"),
    resource.slice(0, -1),
    resource.replace("8=", "9="),
    resource.replace("8=", "8%3D"),
    resource.replace("_", "/"),
    resource + "/extra",
    resource + "?token=value",
    "12/" + resource,
    resource.replace("files/", "files//"),
    resource.replace("files/", "files/../"),
  ])
    assert.equal(
      isRepositoryResourcePath(`${PREFIX}/${invalid}`),
      false,
      invalid,
    );
  const { repository, calls } = fixture([]);
  for (const file of [
    null,
    {},
    { bytes: 0, sha256: "ff".repeat(32) },
    { bytes: 22, sha256: "FF".repeat(32) },
    { bytes: "22", sha256: "ff".repeat(32) },
    { bytes: 22, sha256: "ff".repeat(32), url: "https://invalid/" },
  ])
    await assert.rejects(repository.urlFor({ file }), code("INVALID_INPUT"));
  for (const other of [
    { revision: 12 },
    { filename: "fixture.zip" },
    { resource: "repository.json" },
  ])
    await assert.rejects(
      repository.urlFor({
        file: { bytes: 22, sha256: "ff".repeat(32) },
        ...other,
      }),
      code("INVALID_INPUT"),
    );
  assert.equal(calls.length, 0);
});

test("construction performs no request or clock IO and exposes only a resource getter", () => {
  let calls = 0;
  const repository = createPdxRepository({
    account: { request: () => calls++ },
    expectedAccountId: ACCOUNT,
    repositoryPath: REPOSITORY,
    now: () => assert.fail("The constructor must not read the clock"),
  });
  assert.equal(calls, 0);
  assert.deepEqual(Object.keys(repository), ["urlFor"]);
  assert.equal(JSON.stringify(repository), "{}");
  assert.ok(Object.isFrozen(repository));
});

test("requests the exact account-bound GET resource without a query or body", async () => {
  const { repository, calls } = fixture([grant()]);
  const controller = new AbortController();
  const result = await repository.urlFor({
    revision: 12,
    filename: "manifest",
    signal: controller.signal,
  });
  assert.equal(result, grant().prepend + grant().append);
  assert.deepEqual(calls, [
    {
      method: "GET",
      path: `${PREFIX}/12/complete/manifest`,
      expectedAccountId: ACCOUNT,
      signal: controller.signal,
    },
  ]);
  assert.ok(isRepositoryResourcePath(calls[0].path));
});

test("manifest and ZIP grants are distinct complete resources and revisions are pinned", async () => {
  const manifestGrant = grant({
    prepend: "https://one.example.net/arbitrary/manifest",
    append: "?sig=manifest",
  });
  const zipGrant = grant({
    prepend: "https://two.example.net/already/complete/file.zip",
    append: "?sig=zip",
  });
  const revisionGrant = grant({
    prepend: "https://three.example.net/previous.zip",
    append: "",
  });
  const { repository, calls } = fixture([
    manifestGrant,
    zipGrant,
    revisionGrant,
  ]);
  assert.equal(
    await repository.urlFor({ revision: "12", filename: "manifest" }),
    manifestGrant.prepend + manifestGrant.append,
  );
  assert.equal(
    await repository.urlFor({ revision: "12", filename: "file.zip" }),
    zipGrant.prepend + zipGrant.append,
  );
  assert.equal(
    await repository.urlFor({ revision: "11", filename: "file.zip" }),
    revisionGrant.prepend,
  );
  assert.deepEqual(
    calls.map((call) => call.path),
    [
      `${PREFIX}/12/complete/manifest`,
      `${PREFIX}/12/complete/file.zip`,
      `${PREFIX}/11/complete/file.zip`,
    ],
  );
});

test("signature resources each request their exact account-bound grant", async () => {
  const resources = [
    "repository.json",
    "repository.json.asc",
    "_keys/public.gpg",
  ];
  const responses = [...resources, "manifest.asc"].map((resource, index) =>
    grant({
      prepend: `https://signed.example.net/resource-${index}`,
      append: `?sig=${index}`,
    }),
  );
  const { repository, calls } = fixture([...responses]);
  const controller = new AbortController();
  for (const [index, resource] of resources.entries())
    assert.equal(
      await repository.urlFor({ resource, signal: controller.signal }),
      responses[index].prepend + responses[index].append,
    );
  assert.equal(
    await repository.urlFor({
      revision: "12",
      filename: "manifest.asc",
      signal: controller.signal,
    }),
    responses[3].prepend + responses[3].append,
  );
  assert.deepEqual(
    calls,
    [...resources, "12/complete/manifest.asc"].map((resource) => ({
      method: "GET",
      path: `${PREFIX}/${resource}`,
      expectedAccountId: ACCOUNT,
      signal: controller.signal,
    })),
  );
  for (const call of calls) assert.ok(isRepositoryResourcePath(call.path));
});

test("root and complete resources share the same two-entry LRU without reusing grants", async () => {
  const { repository, calls } = fixture(
    ["metadata", "signature", "manifest", "renewed-signature"].map((name) =>
      grant({ append: `?sig=${name}` }),
    ),
  );
  const metadata = await repository.urlFor({ resource: "repository.json" });
  await repository.urlFor({ resource: "repository.json.asc" });
  assert.equal(
    await repository.urlFor({ resource: "repository.json" }),
    metadata,
  );
  await repository.urlFor({ revision: 12, filename: "manifest.asc" });
  assert.equal(
    await repository.urlFor({ resource: "repository.json" }),
    metadata,
  );
  assert.match(
    await repository.urlFor({ resource: "repository.json.asc" }),
    /sig=renewed-signature$/,
  );
  assert.deepEqual(
    calls.map((call) => call.path),
    [
      `${PREFIX}/repository.json`,
      `${PREFIX}/repository.json.asc`,
      `${PREFIX}/12/complete/manifest.asc`,
      `${PREFIX}/repository.json.asc`,
    ],
  );
});

test("root-resource inputs reject aliases, arbitrary URLs and mixed complete-resource fields before IO", async () => {
  const { repository, calls } = fixture([]);
  for (const resource of [
    undefined,
    null,
    {},
    "",
    "manifest",
    "manifest.asc",
    "12/complete/manifest.asc",
    "https://signed.example.net/repository.json",
    "/repository.json",
    "repository.json?token=value",
    "repository.json#fragment",
    "repository.json\n",
    "Repository.json",
    "repository.json.asc/extra",
    "_keys/public.gpg/extra",
    "_keys//public.gpg",
    "_keys/../public.gpg",
    "_keys\\public.gpg",
    "_keys/%70ublic.gpg",
    "_keys/private.gpg",
    "repository.json.zip",
  ]) {
    await assert.rejects(
      repository.urlFor({ resource }),
      code("INVALID_INPUT"),
    );
  }
  for (const fields of [
    { revision: 12 },
    { filename: "manifest" },
    { revision: 12, filename: "manifest" },
    { revision: undefined },
    { filename: undefined },
  ])
    await assert.rejects(
      repository.urlFor({ resource: "repository.json", ...fields }),
      code("INVALID_INPUT"),
    );
  for (const signal of [null, {}, { aborted: false }])
    await assert.rejects(
      repository.urlFor({ resource: "repository.json", signal }),
      code("INVALID_INPUT"),
    );
  assert.equal(calls.length, 0);
});

test("root-resource cancellation rejects cached and pending grants without leaking late responses", async () => {
  let release;
  const { repository, calls } = fixture([
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
    grant({ append: "?sig=fresh" }),
  ]);
  const controller = new AbortController();
  const pending = repository.urlFor({
    resource: "_keys/public.gpg",
    signal: controller.signal,
  });
  controller.abort("fixture-secret");
  await assert.rejects(pending, code("CANCELLED"));
  release(grant({ append: "?sig=cancelled" }));
  await Promise.resolve();
  assert.match(
    await repository.urlFor({ resource: "_keys/public.gpg" }),
    /sig=fresh$/,
  );
  await assert.rejects(
    repository.urlFor({
      resource: "_keys/public.gpg",
      signal: controller.signal,
    }),
    code("CANCELLED"),
  );
  assert.equal(calls.length, 2);
});

test("cache reuses only the same logical resource and keeps at most two LRU entries", async () => {
  const replies = ["first", "second", "third", "fourth"].map((value) =>
    grant({ append: `?sig=${value}` }),
  );
  const { repository, calls } = fixture(replies);
  const request = (filename) => repository.urlFor({ revision: "12", filename });
  const manifest = await request("manifest");
  await request("first.zip");
  assert.equal(await request("manifest"), manifest);
  await request("second.zip");
  assert.equal(await request("manifest"), manifest);
  assert.match(await request("first.zip"), /sig=fourth$/);
  assert.equal(calls.length, 4);
});

test("exactly sixty seconds remains valid and one millisecond less refreshes", async () => {
  let time = TIME;
  const { repository, calls } = fixture(
    [
      grant({ ttl: String(TIME / 1000 + 120), append: "?sig=old" }),
      grant({ ttl: String(TIME / 1000 + 600), append: "?sig=new" }),
    ],
    { now: () => time },
  );
  const request = () =>
    repository.urlFor({ revision: 12, filename: "manifest" });
  assert.match(await request(), /sig=old$/);
  time += 60_000;
  assert.match(await request(), /sig=old$/);
  assert.equal(calls.length, 1);
  time++;
  assert.match(await request(), /sig=new$/);
  assert.equal(calls.length, 2);
});

test("fresh grants with less than sixty seconds fail without being cached", async () => {
  const { repository, calls } = fixture([
    grant({ ttl: String(TIME / 1000 + 59) }),
    grant({ ttl: String(TIME / 1000 + 60) }),
  ]);
  const request = () =>
    repository.urlFor({ revision: 12, filename: "manifest" });
  await assert.rejects(request(), code("INVALID_RESPONSE"));
  await request();
  assert.equal(calls.length, 2);
});

test("validity is checked after the network response rather than at request start", async () => {
  let time = TIME;
  const { repository } = fixture(
    [
      () => {
        time += 60_001;
        return grant({ ttl: String(TIME / 1000 + 120) });
      },
    ],
    { now: () => time },
  );
  await assert.rejects(
    repository.urlFor({ revision: 12, filename: "manifest" }),
    code("INVALID_RESPONSE"),
  );
});

test("the shared route predicate accepts only exact root and complete supported repository resources", () => {
  for (const platform of ["Any__Any", "Windows__x86_64"])
    for (const filename of ["manifest", "manifest.asc", "mod-1_2.3.zip"])
      assert.ok(
        isRepositoryResourcePath(
          `/patch/repo/mods/hoi4/safe-name/repo/${platform}/12/complete/${filename}`,
        ),
      );
  for (const platform of ["Any__Any", "Windows__x86_64"])
    for (const resource of [
      "repository.json",
      "repository.json.asc",
      "_keys/public.gpg",
    ])
      assert.ok(
        isRepositoryResourcePath(
          `/patch/repo/mods/hoi4/safe-name/repo/${platform}/${resource}`,
        ),
      );
  const invalid = [
    undefined,
    null,
    {},
    12,
    "",
    PREFIX,
    `${PREFIX}/repository.json?token=value`,
    `${PREFIX}/repository.json.asc#fragment`,
    `${PREFIX}/repository.json\n`,
    `${PREFIX}/repository.json.asc\r\n`,
    `${PREFIX}/_keys/public.gpg\n`,
    `${PREFIX}/_keys/public.gpg/extra`,
    `${PREFIX}/_keys//public.gpg`,
    `${PREFIX}/_keys\\public.gpg`,
    `${PREFIX}/_keys/%70ublic.gpg`,
    `${PREFIX}/_keys/private.gpg`,
    `${PREFIX}/12/complete/repository.json`,
    `${PREFIX}/12/complete/manifest.asc\n`,
    `${PREFIX}/12/complete/manifest.asc?token=value`,
    `/patch/repo/mods/stellaris/safe/repo/Any__Any/repository.json`,
    `/patch/repo/mods/hoi4/CON/repo/Any__Any/_keys/public.gpg`,
    `/patch/repo/mods/hoi4/safe/repo/Linux__Any/repository.json.asc`,
    `${PREFIX}/12/complete/manifest?token=value`,
    `${PREFIX}/12/complete/manifest#fragment`,
    `${PREFIX}/12/complete/manifest\n`,
    `${PREFIX}/12/complete/file.zip\n`,
    `${PREFIX}/12/complete/a%2Ezip`,
    `${PREFIX}/12/complete/../file.zip`,
    `${PREFIX}/12/partial/file.zip`,
    `${PREFIX}/12/complete/folder\\file.zip`,
    `${PREFIX}/12/complete/file.zip/extra`,
    `${PREFIX}/12/complete/CON.zip`,
    `${PREFIX}/12/complete/aux.backup.zip`,
    `${PREFIX}/12/complete/file..zip`,
    `${PREFIX}/12/complete/file.zip.`,
    `${PREFIX}/12/complete/file.zip `,
    `${PREFIX}/12/complete/a.zip:stream`,
    `${PREFIX}/0/complete/manifest`,
    `${PREFIX}/01/complete/manifest`,
    `${PREFIX}/1.0/complete/manifest`,
    `${PREFIX}/9007199254740992/complete/manifest`,
    `${PREFIX}/12\n/complete/manifest`,
    `/patch/repo/mods/stellaris/safe/repo/Any__Any/12/complete/manifest`,
    `/patch/repo/mods/hoi4/CON/repo/Any__Any/12/complete/manifest`,
    `/patch/repo/mods/hoi4/%73afe/repo/Any__Any/12/complete/manifest`,
    `/patch/repo/mods/hoi4/safe/repo/Linux__Any/12/complete/manifest`,
    `/patch/repo/mods/hoi4/safe/repo/Windows__../12/complete/manifest`,
    `/patch/repo/mods/hoi4/safe/repo/Any__Any\n/12/complete/manifest`,
  ];
  for (const input of invalid)
    assert.equal(isRepositoryResourcePath(input), false);
});

test("invalid constructor bindings and repository paths are rejected before IO", () => {
  const base = fixture([]).options;
  for (const changes of [
    { account: null },
    { account: {} },
    { expectedAccountId: undefined },
    { expectedAccountId: "" },
    { expectedAccountId: " " },
    { expectedAccountId: "a\nb" },
    { expectedAccountId: "a".repeat(201) },
    { now: 12 },
    ...[
      "",
      "mods/hoi4/safe/repo/Windows__Any/",
      "mods/hoi4/../repo/Any__Any",
      "mods/hoi4/safe/repo/Any__NUL",
      "mods/hoi4/safe/repo/Any__Any\n",
      `mods/hoi4/${"a".repeat(129)}/repo/Any__Any`,
    ].map((repositoryPath) => ({ repositoryPath })),
  ])
    assert.throws(
      () => createPdxRepository({ ...base, ...changes }),
      code("INVALID_INPUT"),
    );
  for (const value of [null, [], "input"])
    assert.throws(() => createPdxRepository(value), code("INVALID_INPUT"));
});

test("invalid filenames, revisions and signals never reach the account service", async () => {
  const { repository, calls } = fixture([]);
  for (const revision of [
    undefined,
    0,
    -1,
    NaN,
    Infinity,
    1.2,
    "01",
    "1\n",
    "1?x=y",
    "9007199254740992",
    {},
  ])
    await assert.rejects(
      repository.urlFor({ revision, filename: "manifest" }),
      code("INVALID_INPUT"),
    );
  for (const filename of [
    undefined,
    "",
    "Manifest",
    "file.ZIP",
    "../file.zip",
    "CON.zip",
    "LPT9.zip",
    "file..zip",
    "file.zip\n",
    "file.zip?x=y",
    "a/b.zip",
    "a\\b.zip",
    "a%2Ezip",
    "a".repeat(197) + ".zip",
  ])
    await assert.rejects(
      repository.urlFor({ revision: 12, filename }),
      code("INVALID_INPUT"),
    );
  for (const signal of [null, {}, { aborted: false }])
    await assert.rejects(
      repository.urlFor({ revision: 12, filename: "manifest", signal }),
      code("INVALID_INPUT"),
    );
  for (const input of [null, [], "input"])
    await assert.rejects(repository.urlFor(input), code("INVALID_INPUT"));
  assert.equal(calls.length, 0);
});

test("grants accept public HTTPS hosts, explicit port 443, empty append and missing result", async () => {
  const { repository } = fixture([
    grant({
      result: undefined,
      prepend: "https://protected-cdn.example.net:443/a.zip",
      append: "",
    }),
    grant({
      prepend: "https://different.example.org/private/manifest",
      append: "?sig=abc%2Fdef&expires=123",
    }),
  ]);
  assert.equal(
    await repository.urlFor({ revision: 12, filename: "a.zip" }),
    "https://protected-cdn.example.net:443/a.zip",
  );
  assert.equal(
    await repository.urlFor({ revision: 12, filename: "manifest" }),
    "https://different.example.org/private/manifest?sig=abc%2Fdef&expires=123",
  );
});

test("grant URL validation rejects unsafe schemes, authorities, hosts and raw characters", async () => {
  const prepends = [
    "http://cdn.example.net/file.zip",
    "file:///tmp/file.zip",
    "//cdn.example.net/file.zip",
    "https:///cdn.example.net/file.zip",
    "https://localhost/file.zip",
    "https://a.localhost/file.zip",
    "https://cdn.local/file.zip",
    "https://cdn.internal/file.zip",
    "https://LOCALHOST./file.zip",
    "https://cdn.local./file.zip",
    "https://private-host/file.zip",
    "https://127.0.0.1/file.zip",
    "https://127.1/file.zip",
    "https://2130706433/file.zip",
    "https://0x7f000001/file.zip",
    "https://192.168.1.1/file.zip",
    "https://[::1]/file.zip",
    "https://[2001:db8::1]/file.zip",
    "https://cdn.example.net:444/file.zip",
    "https://user:password@cdn.example.net/file.zip",
    "https://@cdn.example.net/file.zip",
    "https://cdn.example.net/file.zip?",
    "https://cdn.example.net/file.zip?sig=secret",
    "https://cdn.example.net/file.zip#",
    "https://cdn.example.net/file.zip#secret",
    "https://cdn.example.net\\file.zip",
    "https://cdn.example.net/fi\nle.zip",
    "https://cdn.example.net/fi\tle.zip",
    "https://cdn.example.net/fi\0le.zip",
    "https://cdn.example.net/fi le.zip",
    "https://cdn.example.net/fi\u007fle.zip",
    "https://cdn.example.net/fi\u0085le.zip",
  ];
  for (const prepend of prepends) {
    const { repository } = fixture([grant({ prepend })]);
    await assert.rejects(
      repository.urlFor({ revision: 12, filename: "manifest" }),
      code("INVALID_RESPONSE"),
    );
  }
  for (const append of [
    "signature=value",
    "/other.zip",
    "#fragment",
    "?sig=a#fragment",
    "?sig=a\\b",
    "?sig=a\nb",
    "?sig=a b",
    "?sig=a\0b",
  ]) {
    const { repository } = fixture([grant({ append })]);
    await assert.rejects(
      repository.urlFor({ revision: 12, filename: "manifest" }),
      code("INVALID_RESPONSE"),
    );
  }
});

test("grant structure, part sizes and Unix-second TTL are bounded and fail closed", async () => {
  const invalid = [
    null,
    [],
    "response",
    {},
    grant({ result: "Failure" }),
    grant({ result: null }),
    grant({ prepend: "" }),
    grant({ prepend: 12 }),
    grant({ append: null }),
    grant({ append: undefined }),
    grant({ prepend: "https://cdn.example.net/" + "x".repeat(4096) }),
    grant({ append: "?" + "x".repeat(4096) }),
    ...[
      undefined,
      null,
      1800000300,
      "",
      "0",
      "-1",
      "01",
      "1.2",
      "1e10",
      "1800000300\n",
      " 1800000300",
      "9999999999999",
      "9".repeat(100),
      "secret-token",
    ].map((ttl) => grant({ ttl })),
  ];
  for (const reply of invalid) {
    const { repository } = fixture([reply]);
    await assert.rejects(
      repository.urlFor({ revision: 12, filename: "manifest" }),
      code("INVALID_RESPONSE"),
    );
  }
  const prepend =
    "https://cdn.example.net/" +
    "x".repeat(4096 - "https://cdn.example.net/".length);
  const append = "?" + "x".repeat(4095);
  const { repository } = fixture([grant({ prepend, append })]);
  assert.equal(
    (await repository.urlFor({ revision: 12, filename: "manifest" })).length,
    8192,
  );
});

test("account failures preserve only known codes and discard messages, causes and credentials", async () => {
  const sensitive =
    "fixture-password https://private.example.net/?sig=fixture-secret account-fixture";
  for (const inputCode of [
    "ACCOUNT_CHANGED",
    "SESSION_EXPIRED",
    "NOT_SIGNED_IN",
    "ACCESS_DENIED",
    "CANCELLED",
    "TIMEOUT",
    "RATE_LIMITED",
    "SERVICE_ERROR",
    "INVALID_RESPONSE",
    "REQUEST_FAILED",
    "REQUEST_NOT_ALLOWED",
    "STORAGE_ERROR",
    sensitive,
    undefined,
  ]) {
    const source = Object.assign(new Error(sensitive), {
      code: inputCode,
      cause: sensitive,
      token: sensitive,
    });
    const { repository } = fixture([source]);
    await assert.rejects(
      repository.urlFor({ revision: 12, filename: "manifest" }),
      (error) => {
        assert.equal(
          error.code,
          inputCode === sensitive || inputCode === undefined
            ? "NETWORK_ERROR"
            : inputCode,
        );
        assert.doesNotMatch(
          error.message + error.stack + JSON.stringify(error),
          /fixture-password|fixture-secret|account-fixture|private\.example/,
        );
        assert.equal(error.cause, undefined);
        assert.equal(error.token, undefined);
        assert.notEqual(error, source);
        return true;
      },
    );
  }
  const { repository } = fixture([
    () => {
      throw sensitive;
    },
  ]);
  await assert.rejects(
    repository.urlFor({ revision: 12, filename: "manifest" }),
    code("NETWORK_ERROR"),
  );
});

test("invalid grant errors do not include the grant or the URL parser input", async () => {
  const sensitive = "fixture-grant-secret";
  const { repository } = fixture([
    grant({ prepend: `https://[${sensitive}`, append: `?sig=${sensitive}` }),
  ]);
  await assert.rejects(
    repository.urlFor({ revision: 12, filename: "manifest" }),
    (error) => {
      assert.equal(error.code, "INVALID_RESPONSE");
      assert.doesNotMatch(
        error.message + error.stack + JSON.stringify(error),
        /fixture-grant-secret/,
      );
      assert.equal(error.cause, undefined);
      return true;
    },
  );
});

test("pre-aborted requests and cache reads cancel without requesting another grant", async () => {
  const { repository, calls } = fixture([grant()]);
  const controller = new AbortController();
  controller.abort("fixture-secret-reason");
  await assert.rejects(
    repository.urlFor({
      revision: 12,
      filename: "manifest",
      signal: controller.signal,
    }),
    code("CANCELLED"),
  );
  assert.equal(calls.length, 0);
  await repository.urlFor({ revision: 12, filename: "manifest" });
  await assert.rejects(
    repository.urlFor({
      revision: 12,
      filename: "manifest",
      signal: controller.signal,
    }),
    code("CANCELLED"),
  );
  assert.equal(calls.length, 1);
});

test("abort while waiting rejects promptly and a late response is not cached", async () => {
  let release;
  const { repository, calls } = fixture([
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
    grant({ append: "?sig=second" }),
  ]);
  const controller = new AbortController();
  const pending = repository.urlFor({
    revision: 12,
    filename: "manifest",
    signal: controller.signal,
  });
  controller.abort("fixture-secret-reason");
  await assert.rejects(pending, code("CANCELLED"));
  release(grant({ append: "?sig=cancelled" }));
  await Promise.resolve();
  assert.match(
    await repository.urlFor({ revision: 12, filename: "manifest" }),
    /sig=second$/,
  );
  assert.equal(calls.length, 2);
});

test("synchronous abort at the account boundary and AbortError are sanitized", async () => {
  const controller = new AbortController();
  const sync = fixture([
    () => {
      controller.abort();
      return grant();
    },
  ]);
  await assert.rejects(
    sync.repository.urlFor({
      revision: 12,
      filename: "manifest",
      signal: controller.signal,
    }),
    code("CANCELLED"),
  );
  const aborted = fixture([
    Object.assign(new Error("fixture-private-reason"), { name: "AbortError" }),
  ]);
  await assert.rejects(
    aborted.repository.urlFor({ revision: 12, filename: "manifest" }),
    code("CANCELLED"),
  );
});

test("invalid clocks produce safe input errors before requesting grants", async () => {
  for (const now of [
    () => NaN,
    () => Infinity,
    () => -1,
    () => "time",
    () => {
      throw new Error("fixture-clock-secret");
    },
  ]) {
    const { repository, calls } = fixture([], { now });
    await assert.rejects(
      repository.urlFor({ revision: 12, filename: "manifest" }),
      (error) => {
        assert.equal(error.code, "INVALID_INPUT");
        assert.doesNotMatch(
          error.message + error.stack,
          /fixture-clock-secret/,
        );
        return true;
      },
    );
    assert.equal(calls.length, 0);
  }
});
