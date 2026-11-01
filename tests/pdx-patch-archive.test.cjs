"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { getEventListeners } = require("node:events");
const yazl = require("yazl");
const { applyPdxPatchArchive } = require("../electron/pdx-patch-archive.cjs");

const FILENAME = "fixture-complete.zip";
const BLOCK = 65536;
const MAX_BYTES = 5 * 1024 ** 3;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const buffer = (bytes) => (Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
async function zipBytes(entries) {
  const zip = new yazl.ZipFile();
  const result = new Promise((resolve, reject) => {
    const chunks = [];
    zip.on("error", reject);
    zip.outputStream.on("data", (chunk) => chunks.push(chunk));
    zip.outputStream.once("error", reject);
    zip.outputStream.once("end", () => resolve(Buffer.concat(chunks)));
  });
  for (const item of entries) {
    if (item.directory) zip.addEmptyDirectory(item.name);
    else zip.addBuffer(buffer(item.bytes || ""), item.name, item.options);
  }
  zip.end();
  return result;
}
const operations = (text) => ({ name: "operations", bytes: text });
async function newPatch(bytes, text = `n: ${FILENAME}\n`, extra = []) {
  return zipBytes([operations(text), { name: FILENAME, bytes }, ...extra]);
}
function memory() {
  const pieces = [];
  let length = 0;
  const writes = [];
  const reads = [];
  return {
    writes,
    reads,
    get bytes() {
      return Buffer.concat(pieces);
    },
    get length() {
      return length;
    },
    async write(bytes) {
      assert.ok(Buffer.isBuffer(bytes));
      writes.push(bytes.length);
      pieces.push(Buffer.from(bytes));
      length += bytes.length;
    },
    async read(offset, amount) {
      reads.push({ offset, amount });
      return Buffer.concat(pieces).subarray(offset, offset + amount);
    },
  };
}
function harness(patch, target, source) {
  const output = memory();
  const scratch = memory();
  const patchReads = [];
  const sourceReads = [];
  const input = {
    patch: {
      bytes: patch.length,
      sha256: hash(patch),
      async read(offset, length) {
        patchReads.push({ offset, length });
        return patch.subarray(offset, offset + length);
      },
    },
    target: output,
    scratch,
    expectedTargetFilename: FILENAME,
    expectedTargetBytes: target.length,
    expectedTargetSha256: hash(target),
  };
  if (source !== undefined)
    input.source = {
      bytes: source.length,
      sha256: hash(source),
      async read(offset, length) {
        sourceReads.push({ offset, length });
        return source.subarray(offset, offset + length);
      },
    };
  return {
    input,
    output,
    scratch,
    patchReads,
    sourceReads,
    async run() {
      const result = await applyPdxPatchArchive(input);
      assert.deepEqual(output.bytes, target);
      assert.equal(result.bytes, target.length);
      assert.equal(result.sha256, hash(target));
      assert.ok(patchReads.every((read) => read.length <= BLOCK));
      return result;
    },
  };
}
function records(zip) {
  const end = zip.length - 22;
  assert.equal(zip.readUInt32LE(end), 0x06054b50);
  let offset = zip.readUInt32LE(end + 16);
  const count = zip.readUInt16LE(end + 10);
  const entries = [];
  for (let i = 0; i < count; i++) {
    assert.equal(zip.readUInt32LE(offset), 0x02014b50);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    entries.push({
      central: offset,
      local: zip.readUInt32LE(offset + 42),
      name: zip.subarray(offset + 46, offset + 46 + nameLength).toString(),
      nameLength,
      extraLength,
      extra: offset + 46 + nameLength,
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}
function changeEntry(zip, name, mutate) {
  const changed = Buffer.from(zip);
  const entry = records(changed).find((entry) => entry.name === name);
  assert.ok(entry);
  mutate(changed, entry);
  return changed;
}
function rename(zip, name, replacement) {
  return changeEntry(zip, name, (bytes, entry) => {
    const encoded = Buffer.from(replacement);
    assert.equal(encoded.length, entry.nameLength);
    encoded.copy(bytes, entry.central + 46);
    encoded.copy(bytes, entry.local + 30);
  });
}
function integer(value) {
  const bytes = [value % 128];
  while ((value = Math.floor(value / 128))) bytes.unshift(128 | value % 128);
  return Buffer.from(bytes);
}
function addPatch(target) {
  const codes = Buffer.concat([Buffer.from([1]), integer(target.length)]);
  const delta = Buffer.concat([
    integer(target.length),
    Buffer.from([0]),
    integer(target.length),
    integer(codes.length),
    integer(0),
    target,
    codes,
  ]);
  return Buffer.concat([
    Buffer.from("d6c3c4000000", "hex"),
    integer(delta.length),
    delta,
  ]);
}
async function patchFixture(target = Buffer.from("new target bytes")) {
  const delta = addPatch(target);
  const zip = await zipBytes([
    operations(`p: ${FILENAME}\n`),
    { name: `${FILENAME}.vcdiff`, bytes: delta },
  ]);
  return { target, delta, zip };
}
function dataRecipe(recipe, source = Buffer.alloc(0)) {
  return Buffer.concat(
    recipe.map((item) => {
      if (item.type === "source")
        return source.subarray(item.offset, item.offset + item.bytes);
      if (item.type === "literal") return Buffer.from(item.base64, "base64");
      assert.equal(item.type, "xorshift32-high-byte");
      let state = item.seed >>> 0;
      const bytes = Buffer.alloc(item.bytes);
      for (let i = 0; i < bytes.length; i++) {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        state >>>= 0;
        bytes[i] = state >>> 24;
      }
      return bytes;
    }),
  );
}

test("n extracts a complete ZIP, checks signed unpacked bytes, CRC and final reread", async () => {
  const target = await zipBytes([
    { name: "descriptor.mod", bytes: 'name="reference"\n' },
  ]);
  const patch = await newPatch(target);
  const f = harness(patch, target);
  f.input.patch.unpackedBytes =
    Buffer.byteLength(`n: ${FILENAME}\n`) + target.length;
  const phases = [];
  f.input.onProgress = (progress) => phases.push(progress.phase);
  const result = await f.run();
  assert.equal(result.operation, "n");
  assert.equal(result.windows, 0);
  assert.ok(f.output.reads.length > 0);
  assert.equal(f.scratch.length, 0);
  assert.ok(
    phases.includes("verifying-patch") && phases.includes("verifying-target"),
  );
});

for (const text of [
  `n: ${FILENAME}\n`,
  `n: ${FILENAME}\r\n`,
  `n: ${FILENAME}`,
  `n: ${FILENAME}\r`,
  `\t n\t: ${FILENAME}\n`,
]) {
  test(`operations ScanLines supports ${JSON.stringify(text)}`, async () => {
    const target = Buffer.from("inner ZIP byte container");
    await harness(await newPatch(target, text), target).run();
  });
}

test("k verifies source first and copies exact bytes without a payload", async () => {
  const target = Buffer.from("unchanged complete archive");
  const f = harness(
    await zipBytes([operations(`k: ${FILENAME}\n`)]),
    target,
    target,
  );
  assert.equal((await f.run()).operation, "k");
  assert.ok(f.sourceReads.length >= 2);
  assert.equal(f.scratch.length, 0);
});

test("p validates scratch before applying VCDIFF with an empty source", async () => {
  const { target, delta, zip } = await patchFixture();
  const f = harness(zip, target, Buffer.alloc(0));
  const result = await f.run();
  assert.equal(result.operation, "p");
  assert.equal(result.windows, 1);
  assert.deepEqual(f.scratch.bytes, delta);
  assert.ok(f.scratch.reads.length >= 2);
});

test("p applies a genuine independent WASM-encoder reference patch", async () => {
  const fixture = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "fixtures/pdx-vcdiff/reference-short-pairs.json"),
      "utf8",
    ),
  );
  const source = dataRecipe(fixture.source.recipe);
  const target = dataRecipe(fixture.target.recipe, source);
  const delta = Buffer.from(fixture.patch.base64, "base64");
  assert.equal(hash(source), fixture.source.sha256);
  assert.equal(hash(target), fixture.target.sha256);
  assert.equal(hash(delta), fixture.patch.sha256);
  const zip = await zipBytes([
    operations(`p: ${FILENAME}\n`),
    { name: `${FILENAME}.vcdiff`, bytes: delta },
  ]);
  const f = harness(zip, target, source);
  assert.equal((await f.run()).operation, "p");
});

test("stored and deflated payloads both stream through bounded reads", async () => {
  const target = Buffer.alloc(200000);
  for (let i = 0; i < target.length; i++)
    target[i] = (i * 31 + Math.floor(i / 251)) & 255;
  for (const compress of [false, true]) {
    const zip = await zipBytes([
      operations(`n: ${FILENAME}\n`),
      { name: FILENAME, bytes: target, options: { compress } },
    ]);
    const f = harness(zip, target);
    await f.run();
    assert.ok(f.output.writes.every((bytes) => bytes <= BLOCK));
  }
});

test("outer hash mismatch rejects before ZIP parsing or target writes", async () => {
  const target = Buffer.from("target");
  const f = harness(await newPatch(target), target);
  f.input.patch.sha256 = "0".repeat(64);
  await assert.rejects(applyPdxPatchArchive(f.input), {
    code: "HASH_MISMATCH",
  });
  assert.equal(f.output.length, 0);
  assert.equal(f.patchReads.length, 1);
});

test("signed unpacked-size mismatch rejects before reading operations data", async () => {
  const target = Buffer.from("target");
  const f = harness(await newPatch(target), target);
  f.input.patch.unpackedBytes = target.length;
  await assert.rejects(applyPdxPatchArchive(f.input), {
    code: "HASH_MISMATCH",
  });
  assert.equal(f.output.length, 0);
});

for (const damaged of ["operations", FILENAME]) {
  test(`CRC mismatch in ${damaged} rejects with fixed error`, async () => {
    const target = Buffer.from("target");
    const zip = changeEntry(await newPatch(target), damaged, (bytes, entry) => {
      bytes.writeUInt32LE(
        bytes.readUInt32LE(entry.central + 16) ^ 0x12345678,
        entry.central + 16,
      );
    });
    const f = harness(zip, target);
    await assert.rejects(applyPdxPatchArchive(f.input), {
      code: "HASH_MISMATCH",
    });
    if (damaged === "operations") assert.equal(f.output.length, 0);
  });
}

test("target metadata size and hash cannot be bypassed by a valid outer ZIP", async () => {
  const target = Buffer.from("target");
  const zip = await newPatch(target);
  for (const change of [
    { expectedTargetBytes: target.length + 1 },
    { expectedTargetSha256: "0".repeat(64) },
  ]) {
    const f = harness(zip, target);
    Object.assign(f.input, change);
    await assert.rejects(applyPdxPatchArchive(f.input), {
      code: "HASH_MISMATCH",
    });
  }
});

test("corrupted final target reread is detected for every operation", async () => {
  const target = Buffer.from("target");
  const p = await patchFixture(target);
  for (const [zip, source] of [
    [await newPatch(target), undefined],
    [await zipBytes([operations(`k: ${FILENAME}\n`)]), target],
    [p.zip, Buffer.alloc(0)],
  ]) {
    const f = harness(zip, target, source);
    f.input.target.read = async (offset, length) => Buffer.alloc(length, 0);
    await assert.rejects(applyPdxPatchArchive(f.input), {
      code: "HASH_MISMATCH",
    });
  }
});

test("corrupted scratch reread is detected before any delta target writes", async () => {
  const { target, zip } = await patchFixture();
  const f = harness(zip, target, Buffer.alloc(0));
  f.input.scratch.read = async (offset, length) => Buffer.alloc(length);
  await assert.rejects(applyPdxPatchArchive(f.input), {
    code: "HASH_MISMATCH",
  });
  assert.equal(f.output.length, 0);
});

test("wrong k source hash is detected before target writes", async () => {
  const source = Buffer.from("source");
  const f = harness(
    await zipBytes([operations(`k: ${FILENAME}\n`)]),
    source,
    source,
  );
  f.input.source.sha256 = "0".repeat(64);
  await assert.rejects(applyPdxPatchArchive(f.input), {
    code: "HASH_MISMATCH",
  });
  assert.equal(f.output.length, 0);
});

test("wrong p source hash is detected before target writes", async () => {
  const { target, zip } = await patchFixture();
  const f = harness(zip, target, Buffer.from("previous archive"));
  f.input.source.sha256 = "0".repeat(64);
  await assert.rejects(applyPdxPatchArchive(f.input), {
    code: "HASH_MISMATCH",
  });
  assert.equal(f.output.length, 0);
});

for (const text of [
  `c: ${FILENAME}\n`,
  `d: ${FILENAME}\n`,
  `s: ${FILENAME}\n`,
  `n: ${FILENAME}\nn: ${FILENAME}\n`,
  `n: ${FILENAME}\n\n`,
]) {
  test(`unsupported operations reject: ${JSON.stringify(text)}`, async () => {
    const target = Buffer.from("target");
    const f = harness(await newPatch(target, text), target);
    await assert.rejects(applyPdxPatchArchive(f.input), {
      code: "PATCH_UNSUPPORTED",
    });
    assert.equal(f.output.length, 0);
  });
}

for (const text of [
  `n:${FILENAME}\n`,
  `n: ${FILENAME}: extra\n`,
  `n: ../${FILENAME}\n`,
  `n: dir\\${FILENAME}\n`,
  `n: ${FILENAME.toUpperCase()}\n`,
  `n: ${FILENAME} \n`,
  `n: ${FILENAME}\r\r\n`,
  "\n",
  Buffer.from([0xff]),
]) {
  test(`malformed or mismatched operation path rejects: ${JSON.stringify(text)}`, async () => {
    const target = Buffer.from("target");
    const f = harness(await newPatch(target, text), target);
    await assert.rejects(applyPdxPatchArchive(f.input), {
      code: "PATCH_INVALID",
    });
    assert.equal(f.output.length, 0);
  });
}

test("UTF-8 BOM is not silently treated as official operation whitespace", async () => {
  const target = Buffer.from("target");
  const f = harness(await newPatch(target, `\ufeffn: ${FILENAME}\n`), target);
  await assert.rejects(applyPdxPatchArchive(f.input), {
    code: "PATCH_UNSUPPORTED",
  });
  assert.equal(f.output.length, 0);
});

for (const [name, entries] of [
  ["missing operations", [{ name: FILENAME, bytes: "target" }]],
  ["missing n payload", [operations(`n: ${FILENAME}\n`)]],
  ["missing p payload", [operations(`p: ${FILENAME}\n`)]],
  [
    "extra payload",
    [
      operations(`n: ${FILENAME}\n`),
      { name: FILENAME, bytes: "target" },
      { name: "extra.zip", bytes: "junk" },
    ],
  ],
  [
    "payload on k",
    [operations(`k: ${FILENAME}\n`), { name: FILENAME, bytes: "target" }],
  ],
  [
    "directory",
    [
      operations(`n: ${FILENAME}\n`),
      { name: FILENAME, bytes: "target" },
      { name: "folder", directory: true },
    ],
  ],
  [
    "duplicate operations",
    [
      operations(`n: ${FILENAME}\n`),
      operations(`n: ${FILENAME}\n`),
      { name: FILENAME, bytes: "target" },
    ],
  ],
  [
    "case-colliding operations",
    [
      operations(`n: ${FILENAME}\n`),
      { name: "OPERATIONS", bytes: `n: ${FILENAME}\n` },
      { name: FILENAME, bytes: "target" },
    ],
  ],
]) {
  test(`${name} rejects before writes`, async () => {
    const f = harness(
      await zipBytes(entries),
      Buffer.from("target"),
      Buffer.from("target"),
    );
    await assert.rejects(applyPdxPatchArchive(f.input), (error) =>
      ["PATCH_INVALID", "PATCH_UNSUPPORTED"].includes(error.code),
    );
    assert.equal(f.output.length, 0);
    assert.equal(f.scratch.length, 0);
  });
}

test("unsafe directory entry is rejected even when operations itself is invalid", async () => {
  const zip = rename(
    await zipBytes([
      operations("not an operation"),
      { name: "badname.zip", bytes: "junk" },
    ]),
    "badname.zip",
    "../evil.zip",
  );
  const f = harness(zip, Buffer.from("target"));
  await assert.rejects(applyPdxPatchArchive(f.input), {
    code: "PATCH_INVALID",
  });
  assert.equal(f.output.length, 0);
});

test("overlapping local data ranges reject before reading operations", async () => {
  const target = Buffer.from("target");
  const patch = await zipBytes([
    { ...operations(`n: ${FILENAME}\n`), options: { compress: false } },
    { name: FILENAME, bytes: target },
  ]);
  const zip = changeEntry(patch, "operations", (bytes, entry) => {
    const next = records(bytes).find((item) => item.name === FILENAME);
    const data =
      entry.local +
      30 +
      bytes.readUInt16LE(entry.local + 26) +
      bytes.readUInt16LE(entry.local + 28);
    const overlap = next.local - data + 1;
    bytes.writeUInt32LE(overlap, entry.central + 20);
    bytes.writeUInt32LE(overlap, entry.central + 24);
  });
  const f = harness(zip, target);
  await assert.rejects(applyPdxPatchArchive(f.input), {
    code: "PATCH_INVALID",
  });
  assert.equal(f.output.length, 0);
});

for (const [name, mutate] of [
  [
    "symbolic link",
    (bytes, entry) =>
      bytes.writeUInt32LE((0xa1ff * 65536) >>> 0, entry.central + 38),
  ],
  [
    "reparse attribute",
    (bytes, entry) =>
      bytes.writeUInt32LE(
        (bytes.readUInt32LE(entry.central + 38) | 0x400) >>> 0,
        entry.central + 38,
      ),
  ],
  [
    "traditional encryption",
    (bytes, entry) => {
      bytes.writeUInt16LE(
        bytes.readUInt16LE(entry.central + 8) | 1,
        entry.central + 8,
      );
    },
  ],
  [
    "unsupported method",
    (bytes, entry) => bytes.writeUInt16LE(12, entry.central + 10),
  ],
  [
    "local method mismatch",
    (bytes, entry) => bytes.writeUInt16LE(0, entry.local + 8),
  ],
  [
    "local flags mismatch",
    (bytes, entry) => bytes.writeUInt16LE(1, entry.local + 6),
  ],
  [
    "local filename mismatch",
    (bytes, entry) => {
      bytes[entry.local + 30] ^= 1;
    },
  ],
  [
    "hardlink extra",
    (bytes, entry) => {
      assert.ok(entry.extraLength >= 4);
      bytes.writeUInt16LE(0x000d, entry.extra);
    },
  ],
]) {
  test(`${name} is rejected before reading operation payload`, async () => {
    const target = Buffer.from("target");
    const zip = changeEntry(await newPatch(target), FILENAME, mutate);
    const f = harness(zip, target);
    await assert.rejects(applyPdxPatchArchive(f.input), {
      code: "PATCH_INVALID",
    });
    assert.equal(f.output.length, 0);
  });
}

test("compression ratio bomb is rejected before any target allocation/write", async () => {
  const target = Buffer.alloc(2 * 1024 ** 2);
  const f = harness(await newPatch(target), target);
  await assert.rejects(applyPdxPatchArchive(f.input), {
    code: "PATCH_RESOURCE_LIMIT",
  });
  assert.equal(f.output.length, 0);
});

test("entry and operations byte budgets are enforced", async () => {
  const target = Buffer.from("target");
  const tooMany = await newPatch(
    target,
    `n: ${FILENAME}\n`,
    Array.from({ length: 7 }, (_, i) => ({
      name: `extra${i}.zip`,
      bytes: "x",
    })),
  );
  const tooLong = await newPatch(target, Buffer.alloc(65537, 0x61));
  for (const zip of [tooMany, tooLong]) {
    const f = harness(zip, target);
    await assert.rejects(applyPdxPatchArchive(f.input), {
      code: "PATCH_RESOURCE_LIMIT",
    });
    assert.equal(f.output.length, 0);
  }
});

test("malformed ZIP remains a sanitized error after its outer hash verifies", async () => {
  const f = harness(
    Buffer.from("secret server response, not a ZIP"),
    Buffer.from("target"),
  );
  await assert.rejects(applyPdxPatchArchive(f.input), (error) => {
    assert.equal(error.code, "PATCH_INVALID");
    assert.equal(error.message.includes("secret"), false);
    return true;
  });
});

test("observers cannot alter metadata snapshots or verification outcomes", async () => {
  const target = Buffer.from("target");
  const f = harness(await newPatch(target), target);
  f.input.onProgress = () => {
    f.input.expectedTargetSha256 = "0".repeat(64);
    f.input.patch.sha256 = "0".repeat(64);
    throw new Error("secret observer error");
  };
  await f.run();
  const second = harness(await newPatch(target), target);
  second.input.onProgress = () =>
    Promise.reject(new Error("ignored observer rejection"));
  await second.run();
});

test("read and write failures never expose provider error messages", async () => {
  const target = Buffer.from("target");
  const zip = await newPatch(target);
  for (const [side, code] of [
    ["read", "PATCH_INVALID"],
    ["write", "FILE_ERROR"],
  ]) {
    const f = harness(zip, target);
    if (side === "read")
      f.input.patch.read = async () => {
        throw new Error("secret download URL");
      };
    else
      f.input.target.write = async () => {
        throw new Error("secret user path");
      };
    await assert.rejects(applyPdxPatchArchive(f.input), (error) => {
      assert.equal(error.code, code);
      assert.equal(error.message.includes("secret"), false);
      return true;
    });
  }
});

test("scratch write failures remain sanitized and leave the target empty", async () => {
  const { target, zip } = await patchFixture();
  const f = harness(zip, target, Buffer.alloc(0));
  f.input.scratch.write = async () => {
    throw new Error("secret scratch path");
  };
  await assert.rejects(applyPdxPatchArchive(f.input), (error) => {
    assert.equal(error.code, "FILE_ERROR");
    assert.equal(error.message.includes("secret"), false);
    return true;
  });
  assert.equal(f.output.length, 0);
});

test("short patch/source/scratch/target reads are rejected with fixed codes", async () => {
  const target = Buffer.from("target");
  const n = harness(await newPatch(target), target);
  n.input.patch.read = async () => Buffer.alloc(0);
  await assert.rejects(applyPdxPatchArchive(n.input), {
    code: "PATCH_INVALID",
  });
  const k = harness(
    await zipBytes([operations(`k: ${FILENAME}\n`)]),
    target,
    target,
  );
  k.input.source.read = async () => Buffer.alloc(0);
  await assert.rejects(applyPdxPatchArchive(k.input), {
    code: "SOURCE_CHANGED",
  });
  const p = await patchFixture(target);
  const delta = harness(p.zip, target, Buffer.alloc(0));
  delta.input.scratch.read = async () => Buffer.alloc(0);
  await assert.rejects(applyPdxPatchArchive(delta.input), {
    code: "FILE_ERROR",
  });
  const output = harness(await newPatch(target), target);
  output.input.target.read = async () => Buffer.alloc(0);
  await assert.rejects(applyPdxPatchArchive(output.input), {
    code: "FILE_ERROR",
  });
});

test("already cancelled work never reads a provider", async () => {
  const f = harness(
    await newPatch(Buffer.from("target")),
    Buffer.from("target"),
  );
  f.input.signal = AbortSignal.abort();
  await assert.rejects(applyPdxPatchArchive(f.input), { code: "CANCELLED" });
  assert.equal(f.patchReads.length, 0);
});

test(
  "pending provider reads can be cancelled without waiting for their promise",
  { timeout: 2000 },
  async () => {
    const f = harness(
      await newPatch(Buffer.from("target")),
      Buffer.from("target"),
    );
    const controller = new AbortController();
    f.input.signal = controller.signal;
    f.input.patch.read = async () => {
      setImmediate(() => controller.abort());
      return new Promise(() => {});
    };
    await assert.rejects(applyPdxPatchArchive(f.input), { code: "CANCELLED" });
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    assert.equal(f.output.length, 0);
  },
);

test("cancellation during streaming n extraction prevents subsequent writes", async () => {
  const target = Buffer.alloc(4 * BLOCK);
  for (let i = 0; i < target.length; i++)
    target[i] = (i * 31 + Math.floor(i / 251)) & 255;
  const f = harness(await newPatch(target), target);
  const controller = new AbortController();
  f.input.signal = controller.signal;
  f.input.onProgress = (progress) => {
    if (progress.phase === "extracting" && progress.bytesWritten > 0)
      controller.abort();
  };
  await assert.rejects(applyPdxPatchArchive(f.input), { code: "CANCELLED" });
  assert.ok(f.output.length > 0 && f.output.length <= BLOCK);
  const stoppedAt = f.output.length;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.output.length, stoppedAt);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("cancellation during k copy prevents subsequent writes", async () => {
  const target = Buffer.alloc(3 * BLOCK, 0x31);
  const f = harness(
    await zipBytes([operations(`k: ${FILENAME}\n`)]),
    target,
    target,
  );
  const controller = new AbortController();
  f.input.signal = controller.signal;
  f.input.onProgress = (progress) => {
    if (progress.phase === "copying" && progress.bytesWritten > 0)
      controller.abort();
  };
  await assert.rejects(applyPdxPatchArchive(f.input), { code: "CANCELLED" });
  assert.equal(f.output.length, BLOCK);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.output.length, BLOCK);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("cancellation during delta extraction never writes the target", async () => {
  const { target, zip } = await patchFixture();
  const f = harness(zip, target, Buffer.alloc(0));
  const controller = new AbortController();
  f.input.signal = controller.signal;
  const write = f.input.scratch.write.bind(f.input.scratch);
  f.input.scratch.write = async (bytes) => {
    await write(bytes);
    controller.abort();
  };
  await assert.rejects(applyPdxPatchArchive(f.input), { code: "CANCELLED" });
  assert.equal(f.output.length, 0);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("missing delta scratch fails before writing targets", async () => {
  const { target, zip } = await patchFixture();
  for (const missing of ["scratch"]) {
    const f = harness(zip, target, Buffer.alloc(0));
    delete f.input[missing];
    await assert.rejects(applyPdxPatchArchive(f.input), {
      code: "INVALID_INPUT",
    });
    assert.equal(f.output.length, 0);
  }
});

test("self-contained installation delta accepts no old source", async () => {
  const { target, zip } = await patchFixture();
  const f = harness(zip, target);
  assert.equal((await f.run()).operation, "p");
});

test("empty operations reuses only the verified unchanged source", async () => {
  const target = Buffer.from("unchanged ZIP bytes");
  const zip = await zipBytes([operations("")]);
  const f = harness(zip, target, target);
  f.input.patch.unpackedBytes = 0;
  assert.equal((await f.run()).implicitCopy, true);
  assert.ok(f.sourceReads.length >= 2);
  const bad = harness(zip, target, Buffer.from("different ZIP bytes"));
  await assert.rejects(bad.run(), { code: "HASH_MISMATCH" });
  assert.equal(bad.output.length, 0);
  const absent = harness(zip, target);
  await assert.rejects(absent.run(), { code: "INVALID_INPUT" });
});

test("delete plus new writes the empty staging target without touching old source", async () => {
  const target = Buffer.from("replacement ZIP bytes");
  for (const text of [
    `d: ${FILENAME}\nn: ${FILENAME}\n`,
    `n: ${FILENAME}\nd: ${FILENAME}\n`,
  ]) {
    const old = Buffer.from("old ZIP");
    const f = harness(await newPatch(target, text), target, old);
    assert.equal((await f.run()).operation, "n");
    assert.equal(old.toString(), "old ZIP");
    assert.equal(f.sourceReads.length, 0);
  }
});

test("input metadata is bounded before any provider read", async () => {
  const target = Buffer.from("target");
  const zip = await newPatch(target);
  for (const mutate of [
    (input) => {
      input.patch.bytes = MAX_BYTES + 1;
    },
    (input) => {
      input.expectedTargetBytes = MAX_BYTES + 1;
    },
    (input) => {
      input.expectedTargetFilename = "../target.zip";
    },
    (input) => {
      input.expectedTargetFilename = "CON.zip";
    },
    (input) => {
      input.expectedTargetFilename = "target.zip ";
    },
    (input) => {
      input.expectedTargetFilename = "target.bin";
    },
    (input) => {
      input.patch.sha256 = "invalid";
    },
    (input) => {
      input.patch.unpackedBytes = -1;
    },
    (input) => {
      input.signal = {};
    },
  ]) {
    const f = harness(zip, target);
    mutate(f.input);
    await assert.rejects(applyPdxPatchArchive(f.input), {
      code: "INVALID_INPUT",
    });
    assert.equal(f.patchReads.length, 0);
    assert.equal(f.output.length, 0);
  }
});
