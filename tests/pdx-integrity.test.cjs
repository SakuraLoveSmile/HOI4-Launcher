"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createPdxIntegrity } = require("../electron/pdx-integrity.cjs");

const encoded = (value) => Buffer.from(JSON.stringify(value));
const metadata = (completeSize = "22") => ({
  version: "0.3",
  content: { versions: { 12: { completeSize } } },
});
function fixture(changes = {}) {
  const resources = new Map([
    ["_keys/public.gpg", Buffer.from("key")],
    ["repository.json", encoded(metadata())],
    ["repository.json.asc", Buffer.from("metadata signature")],
    ["12/complete/manifest", Buffer.from("manifest\r\n")],
    ["12/complete/manifest.asc", Buffer.from("manifest signature")],
  ]);
  const calls = [],
    verified = [],
    proof = { repositoryFingerprint: "fixture-only" };
  const verifier = {
    async verify(input) {
      verified.push(input);
      return proof;
    },
  };
  return {
    resources,
    calls,
    verified,
    proof,
    verifier,
    service: createPdxIntegrity({ verifier }),
    input: {
      revision: "12",
      lookupRevocation: async () => ({ status: 204, bytes: Buffer.alloc(0) }),
      loadResource: async (name, limit) => {
        calls.push({ name, limit });
        return resources.get(name);
      },
      ...changes,
    },
  };
}
test("integrity loads bounded exact resources and verifies original bytes before parsing", async () => {
  const f = fixture(),
    result = await f.service.getManifest(f.input);
  assert.equal(result.completeSize, 22);
  assert.deepEqual(result.manifest, f.resources.get("12/complete/manifest"));
  assert.equal(result.verification, f.proof);
  assert.deepEqual(
    f.calls.map((x) => x.name),
    [
      "_keys/public.gpg",
      "repository.json",
      "repository.json.asc",
      "12/complete/manifest",
      "12/complete/manifest.asc",
    ],
  );
  assert.deepEqual(
    f.calls.map((x) => x.limit),
    [65536, 2097152, 16384, 65536, 16384],
  );
  assert.equal(f.verified.length, 1);
  assert.deepEqual(f.verified[0].metadata, f.resources.get("repository.json"));
  assert.equal(f.verified[0].lookupRevocation, f.input.lookupRevocation);
});
test("signature failures take precedence over parsing untrusted metadata", async () => {
  const f = fixture(),
    failure = Object.assign(new Error("fixed verifier failure"), {
      code: "SIGNATURE_INVALID",
    });
  f.resources.set("repository.json", Buffer.from([255]));
  f.verifier.verify = async () => {
    throw failure;
  };
  await assert.rejects(
    f.service.getManifest(f.input),
    (error) => error === failure,
  );
});
test("signed parsing and the returned manifest use snapshots of resource buffers", async () => {
  const f = fixture();
  f.verifier.verify = async () => {
    f.resources.get("repository.json").fill(32);
    f.resources.get("12/complete/manifest").fill(32);
    return f.proof;
  };
  const result = await f.service.getManifest(f.input);
  assert.equal(result.completeSize, 22);
  assert.equal(result.manifest.toString(), "manifest\r\n");
});
test("integrity rejects missing revisions and unsupported signed repository formats", async () => {
  for (const data of [
    null,
    [],
    {},
    { version: "0.2", content: metadata().content },
    { version: "0.3", content: { versions: { 11: { completeSize: "22" } } } },
    { version: "0.3", content: { versions: [] } },
    ...[0, 22, "0", "01", "22\n", "9007199254740992", "-1", "1.2"].map(
      (completeSize) => metadata(completeSize),
    ),
  ]) {
    const f = fixture();
    f.resources.set("repository.json", encoded(data));
    await assert.rejects(f.service.getManifest(f.input), {
      code: "INVALID_METADATA",
    });
    assert.equal(f.verified.length, 1, "decode only after verification");
  }
});
test("each resolution obtains fresh key and signatures instead of trusting a previous result", async () => {
  const f = fixture();
  await f.service.getManifest(f.input);
  f.resources.set("_keys/public.gpg", Buffer.from("rotated key"));
  await f.service.getManifest(f.input);
  assert.equal(f.calls.length, 10);
  assert.equal(f.verified[1].repositoryKey.toString(), "rotated key");
});
test("invalid revision and missing callbacks are rejected before resource IO", async () => {
  for (const revision of [
    undefined,
    0,
    "0",
    "01",
    "12\n",
    "1/../../x",
    "9007199254740992",
  ]) {
    const f = fixture({ revision });
    await assert.rejects(f.service.getManifest(f.input), {
      code: "INVALID_METADATA",
    });
    assert.equal(f.calls.length, 0);
  }
  const f = fixture({ lookupRevocation: null });
  await assert.rejects(f.service.getManifest(f.input), {
    code: "INVALID_METADATA",
  });
  assert.equal(f.calls.length, 0);
});
test("non-byte, empty and oversized resources fail without invoking cryptography", async () => {
  for (const bytes of [
    undefined,
    "not bytes",
    Buffer.alloc(0),
    Buffer.alloc(65537),
  ]) {
    const f = fixture();
    f.resources.set("_keys/public.gpg", bytes);
    await assert.rejects(f.service.getManifest(f.input), {
      code: "INVALID_METADATA",
    });
    assert.equal(f.verified.length, 0);
  }
});

test("signed patch manifests bind exact from/to paths and advertised packed/unpacked sizes", async () => {
  for (const fromRevision of ["-1", "11"]) {
    const f = fixture({ fromRevision });
    f.resources.set(
      "repository.json",
      encoded({
        version: "0.3",
        content: {
          versions: {
            12: {
              completeSize: "22",
              patches: {
                [fromRevision]: { sizePacked: "15", sizeUnpacked: "40" },
              },
            },
          },
        },
      }),
    );
    f.resources.set(
      `12/${fromRevision}_to_12/manifest`,
      Buffer.from("patch manifest"),
    );
    f.resources.set(
      `12/${fromRevision}_to_12/manifest.asc`,
      Buffer.from("patch signature"),
    );
    const result = await f.service.getManifest(f.input);
    assert.equal(result.patchSize, 15);
    assert.equal(result.patchUnpackedSize, 40);
    assert.equal(result.completeSize, 22);
    assert.equal(result.manifest.toString(), "patch manifest");
    assert.equal(f.verified.length, 1);
    assert.deepEqual(
      f.calls.slice(-2).map((entry) => entry.name),
      [
        `12/${fromRevision}_to_12/manifest`,
        `12/${fromRevision}_to_12/manifest.asc`,
      ],
    );
  }
});

test("invalid patch source or signed patch sizing cannot select a different resource", async () => {
  for (const fromRevision of [
    "0",
    "01",
    "12",
    "-2",
    11,
    "11\n",
    "1/complete",
    "9007199254740992",
  ]) {
    const f = fixture({ fromRevision });
    await assert.rejects(f.service.getManifest(f.input), {
      code: "INVALID_METADATA",
    });
    assert.equal(f.calls.length, 0);
  }
  for (const row of [
    null,
    [],
    {},
    { sizePacked: "0", sizeUnpacked: "10" },
    { sizePacked: "15", sizeUnpacked: "10\n" },
  ]) {
    const f = fixture({ fromRevision: "11" });
    f.resources.set(
      "repository.json",
      encoded({
        version: "0.3",
        content: {
          versions: { 12: { completeSize: "22", patches: { 11: row } } },
        },
      }),
    );
    f.resources.set("12/11_to_12/manifest", Buffer.from("patch"));
    f.resources.set("12/11_to_12/manifest.asc", Buffer.from("signature"));
    await assert.rejects(f.service.getManifest(f.input), {
      code: "INVALID_METADATA",
    });
    assert.equal(
      f.verified.length,
      1,
      "verify before inspecting signed sizing",
    );
  }
});
