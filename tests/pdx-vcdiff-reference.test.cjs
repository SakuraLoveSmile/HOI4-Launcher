"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { applyVcdiff } = require("../electron/pdx-vcdiff.cjs");

const fixtureDirectory = path.join(__dirname, "fixtures", "pdx-vcdiff");
const names = fs
  .readdirSync(fixtureDirectory)
  .filter((name) => /^reference-[a-z-]+\.json$/.test(name))
  .sort();
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

// Only deterministic data recipes are interpreted. Tests do not install, load
// or execute the encoder; its fixed outputs and origin hashes are in the JSON.
function bytesFor(recipe, source = Buffer.alloc(0)) {
  const pieces = [];
  for (const item of recipe) {
    let bytes;
    switch (item.type) {
      case "literal":
        bytes = Buffer.from(item.base64, "base64");
        break;
      case "source":
        assert.ok(
          item.offset >= 0 && item.offset + item.bytes <= source.length,
        );
        bytes = source.subarray(item.offset, item.offset + item.bytes);
        break;
      case "repeat":
        bytes = Buffer.alloc(item.bytes, item.byte);
        break;
      case "pattern": {
        const pattern = Buffer.from(item.hex, "hex");
        assert.ok(pattern.length > 0);
        bytes = Buffer.alloc(item.bytes);
        for (let i = 0; i < bytes.length; i++)
          bytes[i] = pattern[i % pattern.length];
        break;
      }
      case "xorshift32-high-byte": {
        let state = item.seed >>> 0;
        assert.notEqual(state, 0);
        bytes = Buffer.alloc(item.bytes);
        for (let i = 0; i < bytes.length; i++) {
          state = (state ^ (state << 13)) >>> 0;
          state = (state ^ (state >>> 17)) >>> 0;
          state = (state ^ (state << 5)) >>> 0;
          bytes[i] = state >>> 24;
        }
        break;
      }
      default:
        assert.fail(`Unknown fixture data recipe: ${item.type}`);
    }
    pieces.push(bytes);
  }
  return Buffer.concat(pieces);
}

function fixture(name) {
  const data = JSON.parse(
    fs.readFileSync(path.join(fixtureDirectory, name), "utf8"),
  );
  assert.equal(data.formatVersion, 1);
  assert.equal(data.origin.package, "@limrun/xdelta3-wasm");
  assert.equal(data.origin.version, "0.2.0");
  assert.equal(
    data.origin.packageSha256,
    "2d03fdbb3a4a4e71f10cb9acec5e6dea92d52361118e1bbae0ba329584bdc672",
  );
  assert.equal(
    data.origin.encoderJsSha256,
    "ef7ff8b4c56a89e6f2567c34e03194cea8bf5631c63bb609ad202e30a3161b5a",
  );
  const source = bytesFor(data.source.recipe);
  const target = bytesFor(data.target.recipe, source);
  const patch = Buffer.from(data.patch.base64, "base64");
  for (const [bytes, metadata] of [
    [source, data.source],
    [target, data.target],
    [patch, data.patch],
  ]) {
    assert.equal(bytes.length, metadata.bytes);
    assert.equal(hash(bytes), metadata.sha256);
    assert.ok(bytes.length < 1024 ** 2);
  }
  return { data, source, target, patch };
}

for (const name of names) {
  test(`reference encoder reconstructs every byte: ${name}`, async () => {
    const { data, source, target, patch } = fixture(name);
    const actual = Buffer.alloc(target.length);
    let written = 0;
    const progress = [];
    const reader = (bytes) => ({
      bytes: bytes.length,
      async read(offset, length) {
        assert.ok(Number.isSafeInteger(offset) && offset >= 0);
        assert.ok(Number.isSafeInteger(length) && length >= 0);
        assert.ok(offset + length <= bytes.length);
        return bytes.subarray(offset, offset + length);
      },
    });
    const result = await applyVcdiff({
      source: reader(source),
      patch: reader(patch),
      target: {
        async write(bytes) {
          assert.ok(written + bytes.length <= actual.length);
          actual.set(bytes, written);
          written += bytes.length;
        },
        async read(offset, length) {
          assert.ok(offset >= 0 && offset + length <= written);
          return actual.subarray(offset, offset + length);
        },
      },
      expectedSourceSha256: data.source.sha256,
      expectedTargetSha256: data.target.sha256,
      expectedTargetBytes: target.length,
      onProgress(value) {
        progress.push(value);
      },
    });
    assert.equal(written, target.length);
    assert.deepEqual(actual, target);
    assert.equal(hash(actual), data.target.sha256);
    assert.equal(result.bytes, target.length);
    assert.equal(result.sha256, data.target.sha256);
    assert.equal(result.windows, data.coverage.windows);
    assert.equal(progress.at(-1).bytesWritten, target.length);
  });
}

test("reference corpus exercises independent default-table and address-cache paths", () => {
  assert.ok(names.length >= 5);
  const modes = new Set();
  const types = new Set();
  const pairs = new Set();
  let sourceBytes = 0;
  let targetBytes = 0;
  let multiWindow = false;
  for (const name of names) {
    const { data } = fixture(name);
    sourceBytes += data.source.bytes;
    targetBytes += data.target.bytes;
    for (const mode of Object.keys(data.coverage.copyModeCounts))
      modes.add(+mode);
    for (const type of Object.keys(data.coverage.instructionTypeCounts))
      types.add(type);
    for (const opcode of data.coverage.pairedOpcodes) pairs.add(opcode);
    if (data.coverage.windows > 1) multiWindow = true;
  }
  assert.deepEqual([...types].sort(), ["ADD", "COPY", "RUN"]);
  assert.deepEqual([...modes].sort(), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.ok(pairs.size >= 4);
  assert.ok(multiWindow);
  assert.ok(sourceBytes < 1024 ** 2 && targetBytes < 1024 ** 2);
});
