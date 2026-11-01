"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { getEventListeners } = require("node:events");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { createXzSections } = require("../electron/pdx-xz.cjs");
const {
  PAGE_BYTES,
  MAX_MEMORY_BYTES,
  UPSTREAM_SHA256,
  limitMemory,
} = require("../electron/vendor/xz/memory-limit.cjs");

// From the hash-verified 1081-byte official 1_to_3.zip. These are just two
// instruction sections, not its 561 MB source or target ZIP. Neither has EOF.
const FIRST = Buffer.from(
  "fd377a585a000000ff12d941020021010c0000008f98419c01000913ff9e5d04138380e120",
  "hex",
);
const LAST = Buffer.from("0200091383ba9b220413a49119", "hex");
const FIRST_OUTPUT = Buffer.from("13ff9e5d04138380e120", "hex");
const LAST_OUTPUT = Buffer.from("1383ba9b220413a49119", "hex");
const root = path.resolve(__dirname, "..");
const vendor = path.join(root, "electron", "vendor", "xz");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const runFile = promisify(execFile);

async function decoder(t, options) {
  const value = await createXzSections(options);
  t.after(() => value.dispose());
  return value;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dictionary(property) {
  const value = Buffer.from(FIRST);
  assert.equal(crc32(value.subarray(12, 20)), value.readUInt32LE(20));
  value[16] = property;
  value.writeUInt32LE(crc32(value.subarray(12, 20)), 20);
  return value;
}

// Valid XZ/LZMA2 uncompressed blocks using the fixture's no-check XZ header.
// They stop at a sync-flush boundary, as xdelta3 secondary compression does.
function uncompressed(bytes) {
  const blocks = [FIRST.subarray(0, 24)];
  for (let offset = 0; offset < bytes.length; offset += 65536) {
    const block = bytes.subarray(offset, offset + 65536);
    const size = block.length - 1;
    blocks.push(
      Buffer.from([offset === 0 ? 1 : 2, size >>> 8, size & 255]),
      block,
    );
  }
  return Buffer.concat(blocks);
}

test("offline vendoring reproduces the pinned original and bounded WASM assets", async () => {
  const { stdout } = await runFile(
    process.execPath,
    [path.join(root, "scripts", "vendor-xz-wasm.cjs"), "--check"],
    { timeout: 10000, windowsHide: true },
  );
  assert.equal(JSON.parse(stdout).checked, true);
  const upstream = await fs.readFile(
    path.join(vendor, "xz-decompress.upstream.wasm"),
  );
  const bounded = await fs.readFile(
    path.join(vendor, "xz-decompress.memory64m.wasm"),
  );
  const metadata = JSON.parse(
    await fs.readFile(path.join(vendor, "metadata.json"), "utf8"),
  );
  assert.equal(hash(upstream), UPSTREAM_SHA256);
  assert.equal(upstream.length, 12558);
  assert.deepEqual(limitMemory(upstream), bounded);
  assert.equal(hash(bounded), metadata.bounded.sha256);
  assert.equal(metadata.bounded.memoryMaximumBytes, MAX_MEMORY_BYTES);
});

test("WASM linear memory cannot grow past a lower hard maximum", async () => {
  const upstream = await fs.readFile(
    path.join(vendor, "xz-decompress.upstream.wasm"),
  );
  const maximum = 2 * 1024 ** 2;
  const { module, instance } = await WebAssembly.instantiate(
    limitMemory(upstream, maximum),
    {},
  );
  assert.deepEqual(WebAssembly.Module.imports(module), []);
  const memory = instance.exports.memory;
  assert.equal(memory.buffer.byteLength, 2 * PAGE_BYTES);
  memory.grow(maximum / PAGE_BYTES - 2);
  assert.equal(memory.buffer.byteLength, maximum);
  assert.throws(() => memory.grow(1), RangeError);
  assert.equal(memory.buffer.byteLength, maximum);
});

test("memory transformation rejects modified or truncated upstream bytes", async () => {
  const upstream = await fs.readFile(
    path.join(vendor, "xz-decompress.upstream.wasm"),
  );
  const modified = Buffer.from(upstream);
  modified[modified.length - 1] ^= 1;
  for (const value of [modified, upstream.subarray(0, -1), Buffer.alloc(0)])
    assert.throws(() => limitMemory(value), { code: "PATCH_INVALID" });
});

test("real separated sections preserve state for all three independent kinds", async (t) => {
  const value = await decoder(t);
  assert.deepEqual(Object.keys(value).sort(), ["decode", "dispose"]);
  assert.ok(Object.isFrozen(value));
  for (const kind of ["instructions", "data", "addresses"])
    assert.deepEqual(await value.decode(kind, FIRST, 10), FIRST_OUTPUT);
  for (const kind of ["addresses", "instructions", "data"])
    assert.deepEqual(await value.decode(kind, LAST, 10), LAST_OUTPUT);
});

test("independent patches do not share section state", async (t) => {
  const first = await decoder(t);
  const second = await decoder(t);
  await first.decode("instructions", FIRST, 10);
  await assert.rejects(second.decode("instructions", LAST, 10), {
    code: "PATCH_INVALID",
  });
  assert.deepEqual(await first.decode("instructions", LAST, 10), LAST_OUTPUT);
});

test("large sections cross internal input and output buffer boundaries", async (t) => {
  const value = await decoder(t);
  const expected = Buffer.alloc(310000);
  for (let index = 0; index < expected.length; index++)
    expected[index] = index % 251;
  const encoded = uncompressed(expected);
  assert.ok(encoded.length > 4 * 65536);
  assert.deepEqual(
    await value.decode("data", encoded, expected.length),
    expected,
  );
  assert.deepEqual(await value.decode("instructions", FIRST, 10), FIRST_OUTPUT);
});

test("compact compressed input drains multiple full output buffers", async (t) => {
  const value = await decoder(t);
  // Python's standard lzma.compress(b'A' * (8 * 65536), CHECK_NONE, preset=0).
  // The fixture is embedded so tests require neither Python nor network access.
  const input = Buffer.from(
    "/Td6WFoAAAD/EtlBAgAhAQwAAACPmEGc5///AI9dACDv+7/+o7Fe5fg/sqomVfhocEFwFQ+N/R5MG4pCtxn0aRhxrmYjiopNL6MN2X+m44wjEVPgWRjFdYrid/i2lH8MasDedElk4ulcU7IE2PdEDKtfDW1G6eXDdoi3llestk3haR1v+0uIEGxCy4g/XACP0E6vJiiUcR89jyThcJ6nI1/sKMuF0ZWYiiDw8n0AAAAAAaMBgIAgADQXVfioAAr8AgAAAAAAWVo=",
    "base64",
  );
  const result = await value.decode("data", input, 8 * 65536);
  assert.deepEqual(result, Buffer.alloc(8 * 65536, 0x41));
});

test("caller mutation after decode starts cannot alter later input chunks", async (t) => {
  const value = await decoder(t);
  const expected = Buffer.alloc(180000, 0x61);
  const input = uncompressed(expected);
  const pending = value.decode("data", input, expected.length);
  input.fill(0);
  assert.deepEqual(await pending, expected);
});

test("returned bytes remain independent of future WASM output", async (t) => {
  const value = await decoder(t);
  const first = await value.decode("instructions", FIRST, 10);
  await value.decode("instructions", LAST, 10);
  assert.deepEqual(first, FIRST_OUTPUT);
});

for (const expected of [9, 11]) {
  test(`wrong section output size ${expected} invalidates every kind`, async (t) => {
    const value = await decoder(t);
    await assert.rejects(value.decode("instructions", FIRST, expected), {
      code: "PATCH_INVALID",
    });
    await assert.rejects(value.decode("data", FIRST, 10), {
      code: "PATCH_INVALID",
    });
  });
}

for (const [name, input] of [
  ["truncated data", FIRST.subarray(0, -1)],
  ["truncated header", FIRST.subarray(0, 12)],
  ["continuation without source state", LAST],
  ["invalid magic", Buffer.alloc(37, 0x78)],
  [
    "damaged block header checksum",
    Buffer.concat([FIRST.subarray(0, 20), Buffer.alloc(4), FIRST.subarray(24)]),
  ],
]) {
  test(`${name} rejects without exposing input or allowing reuse`, async (t) => {
    const value = await decoder(t);
    await assert.rejects(value.decode("instructions", input, 10), (error) => {
      assert.equal(error.code, "PATCH_INVALID");
      assert.equal(error.message.includes(input.toString("hex")), false);
      return true;
    });
    await assert.rejects(value.decode("data", FIRST, 10), {
      code: "PATCH_INVALID",
    });
  });
}

test("invalid kinds, inputs and declared lengths fail closed", async (t) => {
  for (const [kind, input, expected] of [
    ["other", FIRST, 10],
    ["__proto__", FIRST, 10],
    ["data", new Uint8Array(FIRST), 10],
    ["data", Buffer.alloc(0), 10],
    ["data", FIRST, 0],
    ["data", FIRST, -1],
    ["data", FIRST, 0.5],
    ["data", FIRST, NaN],
    ["data", FIRST, Infinity],
  ]) {
    const value = await decoder(t);
    await assert.rejects(value.decode(kind, input, expected), {
      code: "PATCH_INVALID",
    });
  }
});

test("declared output limit is checked before decoding and invalidates reuse", async (t) => {
  const value = await decoder(t, { maxDecodedBytes: 9 });
  await assert.rejects(value.decode("instructions", FIRST, 10), {
    code: "PATCH_RESOURCE_LIMIT",
  });
  await assert.rejects(value.decode("data", FIRST, 1), {
    code: "PATCH_RESOURCE_LIMIT",
  });
});

test("encoded section limit is checked before any input copy", async (t) => {
  const value = await decoder(t);
  const oversized = Buffer.allocUnsafe(MAX_MEMORY_BYTES + 1);
  await assert.rejects(value.decode("data", oversized, 10), {
    code: "PATCH_RESOURCE_LIMIT",
  });
});

test("unsupported or insufficient memory budgets produce fixed safe errors", async () => {
  for (const maxMemoryBytes of [65536, 131072, 262144])
    await assert.rejects(createXzSections({ maxMemoryBytes }), {
      code: "PATCH_RESOURCE_LIMIT",
    });
  await assert.rejects(
    createXzSections({ maxMemoryBytes: MAX_MEMORY_BYTES + PAGE_BYTES }),
    { code: "PATCH_RESOURCE_LIMIT" },
  );
  for (const maxMemoryBytes of [0, 1, 4.5, NaN, "67108864"])
    await assert.rejects(createXzSections({ maxMemoryBytes }), {
      code: "PATCH_INVALID",
    });
});

test("a 32 MiB dictionary cannot escape the shared 4 MiB memory maximum", async (t) => {
  const value = await decoder(t, { maxMemoryBytes: 4 * 1024 ** 2 });
  await assert.rejects(value.decode("data", dictionary(26), 10), {
    code: "PATCH_RESOURCE_LIMIT",
  });
  await assert.rejects(value.decode("instructions", FIRST, 10), {
    code: "PATCH_RESOURCE_LIMIT",
  });
});

test("a 64 MiB dictionary cannot escape a lowered 32 MiB maximum", async (t) => {
  const value = await decoder(t, { maxMemoryBytes: 32 * 1024 ** 2 });
  await assert.rejects(value.decode("data", dictionary(28), 10), {
    code: "PATCH_RESOURCE_LIMIT",
  });
});

test("a malicious 3 GiB dictionary is rejected without allocating it", async (t) => {
  const value = await decoder(t);
  await assert.rejects(value.decode("data", dictionary(39), 10), {
    code: "PATCH_RESOURCE_LIMIT",
  });
});

test("an unsupported maximum dictionary property fails closed", async (t) => {
  const value = await decoder(t);
  await assert.rejects(value.decode("data", dictionary(40), 10), {
    code: "PATCH_INVALID",
  });
});

test("dictionary allocation failure under a small budget rejects reuse", async (t) => {
  const value = await decoder(t, { maxMemoryBytes: 1024 * 1024 });
  await assert.rejects(value.decode("instructions", FIRST, 10), {
    code: "PATCH_RESOURCE_LIMIT",
  });
  await assert.rejects(value.decode("addresses", FIRST, 10), {
    code: "PATCH_RESOURCE_LIMIT",
  });
});

test("an already aborted signal prevents decoder creation", async () => {
  await assert.rejects(createXzSections({ signal: AbortSignal.abort() }), {
    name: "AbortError",
    code: "CANCELLED",
  });
});

test("cancellation between sections clears the abort listener and forbids reuse", async (t) => {
  const controller = new AbortController();
  const value = await decoder(t, { signal: controller.signal });
  assert.equal(getEventListeners(controller.signal, "abort").length, 1);
  await value.decode("instructions", FIRST, 10);
  controller.abort();
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  await assert.rejects(value.decode("instructions", LAST, 10), {
    code: "CANCELLED",
  });
});

test("large decode yields to an in-flight cancellation before completing", async (t) => {
  const controller = new AbortController();
  const value = await decoder(t, { signal: controller.signal });
  const bytes = Buffer.alloc(4 * 1024 ** 2, 0x61);
  setImmediate(() => setImmediate(() => controller.abort()));
  await assert.rejects(
    value.decode("data", uncompressed(bytes), bytes.length),
    {
      code: "CANCELLED",
    },
  );
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  await assert.rejects(value.decode("data", FIRST, 10), { code: "CANCELLED" });
});

test("dispose is idempotent, removes listeners, and rejects further work", async () => {
  const controller = new AbortController();
  const value = await createXzSections({ signal: controller.signal });
  value.dispose();
  value.dispose();
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  await assert.rejects(value.decode("data", FIRST, 10), {
    code: "PATCH_INVALID",
  });
});

test("dispose during an active decode discards its partial output", async (t) => {
  const value = await decoder(t);
  const pending = value.decode("data", FIRST, 10);
  value.dispose();
  await assert.rejects(pending, { code: "PATCH_INVALID" });
});

test("concurrent decode calls reject and invalidate the isolated instance", async (t) => {
  const value = await decoder(t);
  const first = assert.rejects(value.decode("data", FIRST, 10), {
    code: "PATCH_INVALID",
  });
  await assert.rejects(value.decode("instructions", FIRST, 10), {
    code: "PATCH_INVALID",
  });
  await first;
});

test("malformed options fail with stable errors", async () => {
  for (const options of [null, [], 7, { signal: {} }, { signal: "secret" }])
    await assert.rejects(createXzSections(options), { code: "PATCH_INVALID" });
  for (const maxDecodedBytes of [0, -1, Infinity, MAX_MEMORY_BYTES + 1])
    await assert.rejects(createXzSections({ maxDecodedBytes }), {
      code: "PATCH_RESOURCE_LIMIT",
    });
});
