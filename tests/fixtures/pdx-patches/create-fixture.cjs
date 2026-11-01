"use strict";
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const yazl = require("yazl");
const {
  createAccountService,
} = require("../../../electron/account-service.cjs");
const { createPdxIntegrity } = require("../../../electron/pdx-integrity.cjs");
const {
  createPdxSignatureVerifier,
} = require("../../../electron/pdx-signature.cjs");
const {
  createSignatureFixture,
} = require("../pdx-signatures/create-fixture.cjs");

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
function integer(value) {
  const result = [value % 128];
  while ((value = Math.floor(value / 128))) result.unshift(128 | value % 128);
  return Buffer.from(result);
}
async function zip(entries, { compress = false } = {}) {
  const archive = new yazl.ZipFile();
  const pieces = [];
  const done = new Promise((resolve, reject) => {
    archive.outputStream.on("data", (bytes) => pieces.push(bytes));
    archive.outputStream.on("error", reject);
    archive.outputStream.on("end", () => resolve(Buffer.concat(pieces)));
  });
  for (const [name, bytes] of entries)
    archive.addBuffer(Buffer.from(bytes), name, {
      compress,
      mtime: new Date("2020-01-01T00:00:00Z"),
    });
  archive.end();
  return done;
}
function delta(source, target) {
  let prefix = 0,
    suffix = 0;
  while (
    prefix < Math.min(source.length, target.length) &&
    source[prefix] === target[prefix]
  )
    prefix++;
  while (
    suffix < Math.min(source.length, target.length) - prefix &&
    source[source.length - 1 - suffix] === target[target.length - 1 - suffix]
  )
    suffix++;
  const data = target.subarray(prefix, target.length - suffix);
  const instructions = Buffer.concat([
    ...(prefix ? [Buffer.from([19]), integer(prefix)] : []),
    ...(data.length ? [Buffer.from([1]), integer(data.length)] : []),
    ...(suffix ? [Buffer.from([19]), integer(suffix)] : []),
  ]);
  const addresses = Buffer.concat([
    ...(prefix ? [integer(0)] : []),
    ...(suffix ? [integer(source.length - suffix)] : []),
  ]);
  const window = Buffer.concat([
    integer(target.length),
    Buffer.from([0]),
    integer(data.length),
    integer(instructions.length),
    integer(addresses.length),
    data,
    instructions,
    addresses,
  ]);
  return Buffer.concat([
    Buffer.from([0xd6, 0xc3, 0xc4, 0, 0, 1]),
    integer(source.length),
    integer(0),
    integer(window.length),
    window,
  ]);
}
const manifest = (filename, bytes, unpacked = bytes.length) =>
  Buffer.from(
    `Name: Any__Any\nHash: sha256\n\n${filename},${bytes.length},${Buffer.from(digest(bytes), "hex").toString("base64url")}=,crw,${unpacked},zip\n`,
  );

async function createPatchFixture({ sessionPath, variant = "default" }) {
  assert.ok(
    ["default", "unchanged", "replacement", "installation-delta"].includes(
      variant,
    ),
  );
  const filler = Buffer.alloc(200000);
  for (let i = 0; i < filler.length; i++)
    filler[i] = (i * 73 + (i >>> 8)) % 251;
  const descriptor =
    'name="Patch integration fixture"\nversion="1.0"\nsupported_version="1.19.*"\n';
  const source = await zip([
    ["descriptor.mod", descriptor],
    ["data/unchanged.txt", filler],
    ["events/fixture.txt", "original event\n"],
  ]);
  const target =
    variant === "unchanged"
      ? source
      : await zip([
          ["descriptor.mod", descriptor],
          ["data/unchanged.txt", filler],
          ["events/fixture.txt", "modified event\n"],
        ]);
  const payload =
    variant === "unchanged"
      ? Buffer.alloc(0)
      : variant === "replacement"
        ? target
        : delta(source, target);
  const operations = Buffer.from(
    variant === "unchanged"
      ? ""
      : variant === "replacement"
        ? "d: Fixture.zip\nn: Fixture.zip\n"
        : "p: Fixture.zip\n",
  );
  const installationOperations = Buffer.from(
    variant === "installation-delta" ? "p: Fixture.zip\n" : "n: Fixture.zip\n",
  );
  const installationPayload =
    variant === "installation-delta" ? delta(Buffer.alloc(0), target) : target;
  const patch = await zip(
    [
      ["operations", operations],
      ...(variant === "unchanged"
        ? []
        : [
            [
              variant === "replacement" ? "Fixture.zip" : "Fixture.zip.vcdiff",
              payload,
            ],
          ]),
    ],
    { compress: variant === "replacement" },
  );
  const installation = await zip([
    ["operations", installationOperations],
    [
      variant === "installation-delta" ? "Fixture.zip.vcdiff" : "Fixture.zip",
      installationPayload,
    ],
  ]);
  const sizes = {
    1: {
      sizePacked: String(patch.length),
      sizeUnpacked: String(payload.length + operations.length),
    },
    "-1": {
      sizePacked: String(installation.length),
      sizeUnpacked: String(
        installationPayload.length + installationOperations.length,
      ),
    },
  };
  const metadata = Buffer.from(
    JSON.stringify({
      version: "0.3",
      content: {
        versions: {
          1: { completeSize: String(source.length) },
          2: { completeSize: String(target.length), patches: sizes },
        },
      },
    }),
  );
  const signing = await createSignatureFixture();
  const resources = new Map([
    ["1/complete/Fixture.zip", source],
    ["2/complete/Fixture.zip", target],
    ["2/1_to_2/1_to_2.zip", patch],
    ["2/-1_to_2/-1_to_2.zip", installation],
  ]);
  for (const [folder, body] of [
    ["1/complete", manifest("Fixture.zip", source)],
    ["2/complete", manifest("Fixture.zip", target)],
    [
      "2/1_to_2",
      manifest("1_to_2.zip", patch, payload.length + operations.length),
    ],
    [
      "2/-1_to_2",
      manifest(
        "-1_to_2.zip",
        installation,
        installationPayload.length + installationOperations.length,
      ),
    ],
  ]) {
    const signed = await signing.sign({ metadata, manifest: body });
    for (const [name, bytes] of [
      ["_keys/public.gpg", signed.repositoryKey],
      ["repository.json", metadata],
      ["repository.json.asc", signed.metadataSignature],
      [folder + "/manifest", body],
      [folder + "/manifest.asc", signed.manifestSignature],
    ])
      resources.set(name, bytes);
  }
  const repository = "mods/hoi4/Fixture/repo/Any__Any";
  const prefix = `/patch/repo/${repository}/`;
  const grants = [],
    grantRequests = [],
    requests = [];
  const token = "isolated-patch-session",
    accountId = "isolated-patch-account";
  const controls = {
    latest: "2",
    filesStatus: 404,
    statuses: new Map(),
    grantFailure: null,
    hold: null,
    held: false,
    cancelled: false,
    afterResource: null,
  };
  const details = (revision) => ({
    result: "OK",
    modDetail: {
      modId: "123",
      name: "Fixture",
      displayName: "Patch integration fixture",
      game: "hoi4",
      os: "Any",
      arch: "Any",
      modVersion: revision,
      state: "published",
      updating: false,
      acl: "private",
      repositoryPath: repository,
      isRegionBlocked: false,
    },
  });
  const account = createAccountService({
    sessionPath,
    fetchImpl: async (url, options) => {
      const parsed = new URL(url);
      assert.equal(parsed.origin, "https://api.paradox-interactive.com");
      if (parsed.pathname === "/accounts/sessions/launcher-v2")
        return Response.json({ session: { token, userid: accountId } });
      assert.equal(
        JSON.parse(options.headers.Authorization).session.token,
        token,
      );
      if (parsed.pathname === "/accountdetails")
        return Response.json({
          account: {
            displayName: "Patch fixture",
            email: "patch@example.invalid",
          },
        });
      if (parsed.pathname === "/mods")
        return Response.json(
          details(parsed.searchParams.get("modVersion") || controls.latest),
        );
      assert.ok(parsed.pathname.startsWith(prefix));
      const resource = parsed.pathname.slice(prefix.length);
      grantRequests.push(resource);
      if (controls.grantFailure === resource)
        return new Response(null, { status: 403 });
      const prepend = `https://patch-fixture.example.invalid/grants/${grants.length}`;
      const append = "?signature=isolated-" + grants.length;
      grants.push({ resource, url: prepend + append });
      return Response.json({
        result: "OK",
        prepend,
        append,
        ttl: String(Math.floor(Date.now() / 1000) + 3600),
      });
    },
  });
  const fetchImpl = async (url, options) => {
    const headers = new Headers(options.headers);
    assert.equal(headers.has("Authorization"), false);
    assert.equal(headers.has("Cookie"), false);
    assert.equal(options.credentials, "omit");
    assert.equal(options.redirect, "manual");
    if (
      new URL(url).origin === "https://revocation-prod.paradox-interactive.com"
    ) {
      requests.push({ resource: "revocation" });
      return new Response(null, { status: 204 });
    }
    const grant = grants.find((entry) => entry.url === url);
    assert.ok(grant, "Every content request has a separate account grant");
    const { resource } = grant;
    const range = headers.get("Range");
    requests.push({ resource, range });
    if (controls.afterResource) await controls.afterResource(resource);
    const status =
      controls.statuses.get(resource) ||
      (resource.startsWith("files/") ? controls.filesStatus : 200);
    if (status !== 200) return new Response(null, { status });
    const bytes = resource.startsWith("files/")
      ? target
      : resources.get(resource);
    assert.ok(bytes, "Unexpected resource " + resource);
    const offset = Number(range?.match(/^bytes=(\d+)-$/)?.[1] || 0);
    if (offset >= bytes.length && offset > 0)
      return new Response(null, { status: 416 });
    const responseHeaders = {
      "Content-Length": String(bytes.length - offset),
      ETag: '"' + digest(bytes) + '"',
    };
    if (offset)
      responseHeaders["Content-Range"] =
        `bytes ${offset}-${bytes.length - 1}/${bytes.length}`;
    if (controls.hold === resource && !controls.held && !range) {
      controls.held = true;
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(bytes.subarray(0, 64));
          options.signal.addEventListener(
            "abort",
            () => {
              controls.cancelled = true;
              try {
                controller.error(
                  Object.assign(new Error("Fixture aborted"), {
                    name: "AbortError",
                  }),
                );
              } catch {}
            },
            { once: true },
          );
        },
        cancel() {
          controls.cancelled = true;
        },
      });
      return new Response(stream, { headers: responseHeaders });
    }
    return new Response(bytes.subarray(offset), {
      status: offset ? 206 : 200,
      headers: responseHeaders,
    });
  };
  return {
    source,
    target,
    patch,
    installation,
    payload,
    resources,
    grants,
    grantRequests,
    requests,
    controls,
    account,
    fetchImpl,
    async resignDelta(bytes) {
      assert.ok(Buffer.isBuffer(bytes));
      assert.equal(bytes.length, patch.length);
      const body = manifest(
        "1_to_2.zip",
        bytes,
        payload.length + operations.length,
      );
      const signed = await signing.sign({ metadata, manifest: body });
      resources.set("2/1_to_2/1_to_2.zip", Buffer.from(bytes));
      resources.set("2/1_to_2/manifest", body);
      resources.set("2/1_to_2/manifest.asc", signed.manifestSignature);
    },
    integrity: () =>
      createPdxIntegrity({
        verifier: createPdxSignatureVerifier({
          rootKey: signing.rootKey,
          rootFingerprint: signing.rootFingerprint,
          now: () => signing.now,
        }),
      }),
    async login() {
      return account.login({
        email: "patch@example.invalid",
        password: "isolated-fake-password",
        remember: false,
      });
    },
    assertNoSecrets(value) {
      const text = JSON.stringify(value);
      for (const secret of [
        token,
        accountId,
        "patch-fixture.example.invalid",
        "signature=isolated-",
      ])
        assert.equal(text.includes(secret), false);
    },
  };
}
module.exports = { createPatchFixture, zip, delta, digest };
