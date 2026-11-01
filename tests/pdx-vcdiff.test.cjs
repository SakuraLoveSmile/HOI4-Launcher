"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { applyVcdiff } = require("../electron/pdx-vcdiff.cjs");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const b = (value) =>
  Buffer.isBuffer(value)
    ? value
    : typeof value === "string"
      ? Buffer.from(value)
      : Buffer.from(value || []);
const code = (expected) => (error) => error.code === expected;
function integer(value) {
  const bytes = [value % 128];
  while ((value = Math.floor(value / 128))) bytes.unshift(128 | value % 128);
  return b(bytes);
}
function window({
  length,
  data,
  instructions,
  addresses,
  sourceLength,
  sourceOffset = 0,
  targetSource = false,
  checksum,
  compressed = 0,
}) {
  const sections = [b(data), b(instructions), b(addresses)],
    parts = [
      integer(length),
      b([compressed]),
      ...sections.map((x) => integer(x.length)),
    ];
  if (checksum !== undefined) {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32BE(checksum);
    parts.push(bytes);
  }
  parts.push(...sections);
  const delta = Buffer.concat(parts),
    flag =
      (sourceLength === undefined ? 0 : targetSource ? 2 : 1) |
      (checksum === undefined ? 0 : 4);
  return Buffer.concat([
    b([flag]),
    ...(sourceLength === undefined
      ? []
      : [integer(sourceLength), integer(sourceOffset)]),
    integer(delta.length),
    delta,
  ]);
}
const patch = (windows, header = 0) =>
  Buffer.concat([
    b([0xd6, 0xc3, 0xc4, 0, header]),
    ...(header & 1 ? [b([2])] : []),
    ...windows,
  ]);
function fixture(source, delta, expected, options = {}) {
  source = b(source);
  expected = b(expected);
  const writes = [],
    reads = [];
  const input = {
    source: {
      bytes: source.length,
      async read(offset, length) {
        reads.push({ offset, length });
        return source.subarray(offset, offset + length);
      },
    },
    patch: {
      bytes: delta.length,
      async read(offset, length) {
        return delta.subarray(offset, offset + length);
      },
    },
    target: {
      async write(bytes) {
        writes.push(Buffer.from(bytes));
      },
      async read(offset, length) {
        return Buffer.concat(writes).subarray(offset, offset + length);
      },
    },
    expectedSourceSha256: digest(source),
    expectedTargetSha256: digest(expected),
    expectedTargetBytes: expected.length,
    ...options,
  };
  return {
    input,
    writes,
    reads,
    async run() {
      const result = await applyVcdiff(input);
      assert.deepEqual(Buffer.concat(writes), expected);
      assert.equal(result.bytes, expected.length);
      assert.equal(result.sha256, digest(expected));
      return result;
    },
  };
}

test("ADD, RUN and fixed-size ADD reconstruct exact target bytes", async () => {
  const f = fixture(
    "",
    patch([
      window({ length: 10, data: "hello!x", instructions: [1, 5, 2, 0, 4] }),
    ]),
    "hello!xxxx",
  );
  await f.run();
});

test("SELF source COPY and overlapping target COPY can cross the dictionary boundary", async () => {
  const f = fixture(
    "abcdef",
    patch([
      window({
        length: 12,
        sourceLength: 6,
        instructions: [19, 12],
        addresses: [0],
      }),
    ]),
    "abcdefabcdef",
  );
  await f.run();
});

test("overlapping target COPY expands a one-byte pattern with bounded blocks", async () => {
  const expected = Buffer.alloc(1024 * 1024, 97),
    copy = integer(expected.length - 1);
  const f = fixture(
    "",
    patch([
      window({
        length: expected.length,
        data: "a",
        instructions: b([2, 19, ...copy]),
        addresses: [0],
      }),
    ]),
    expected,
  );
  await f.run();
});

for (const period of [13, 70001]) {
  test(`overlapping COPY preserves period ${period} across 64 KiB blocks`, async () => {
    const pattern = Buffer.alloc(period);
    for (let i = 0; i < period; i++) pattern[i] = (i * 73 + (i >>> 8)) % 251;
    const expected = Buffer.alloc(600000);
    for (let offset = 0; offset < expected.length; offset += period)
      pattern.copy(expected, offset);
    await fixture(
      "",
      patch([
        window({
          length: expected.length,
          data: pattern,
          instructions: Buffer.concat([
            b([1]),
            integer(period),
            b([19]),
            integer(expected.length - period),
          ]),
          addresses: [0],
        }),
      ]),
      expected,
    ).run();
  });
}

test("HERE uses source segment length and current output position", async () => {
  await fixture(
    "abcdefgh",
    patch([
      window({
        length: 8,
        sourceLength: 8,
        instructions: [19, 4, 35, 4],
        addresses: [0, 12],
      }),
    ]),
    "abcdabcd",
  ).run();
});

test("all four NEAR cache modes and cache replacement resolve byte addresses", async () => {
  const source = "abcdefghijklmnopqrstuvwxyz",
    cases = [2, 3, 4, 5];
  for (const mode of cases) {
    const codes = [19, 1, 19, 1, 19, 1, 19, 1, 19 + mode * 16, 1],
      addresses = [1, 2, 3, 4, 0];
    await fixture(
      source,
      patch([
        window({ length: 5, sourceLength: 26, instructions: codes, addresses }),
      ]),
      "bcde" + source[mode - 1],
    ).run();
  }
  await fixture(
    source,
    patch([
      window({
        length: 6,
        sourceLength: 26,
        instructions: [19, 1, 19, 1, 19, 1, 19, 1, 19, 1, 51, 1],
        addresses: [1, 2, 3, 4, 5, 0],
      }),
    ]),
    "bcdeff",
  ).run();
});

test("all three SAME cache modes use byte indexes and update from decoded addresses", async () => {
  const source = Buffer.from(
    Array.from({ length: 800 }, (_, i) => 65 + (i % 26)),
  );
  for (let bucket = 0; bucket < 3; bucket++) {
    const address = bucket * 256 + 7,
      expected = b([source[address], source[address]]);
    await fixture(
      source,
      patch([
        window({
          length: 2,
          sourceLength: source.length,
          instructions: [19, 1, 19 + (6 + bucket) * 16, 1],
          addresses: b([...integer(address), 7]),
        }),
      ]),
      expected,
    ).run();
  }
});

test("paired default-table instructions cover ADD/COPY and COPY/ADD ranges", async () => {
  const source = "abcd";
  for (const [opcode, expected, data, addresses] of [
    [163, "xabcd", "x", [0]],
    [234, "wxyzabcdwx", "wxyz", [0]],
    [235, "xabcd", "x", [0]],
    [246, "wxyzabcd", "wxyz", [0]],
    [247, "abcdx", "x", [0]],
    [255, "abcdx", "x", [0]],
  ]) {
    // Uninitialized NEAR/SAME caches contain address zero; COPY from source
    // may continue into newly emitted bytes when its fixed length exceeds 4.
    await fixture(
      source,
      patch([
        window({
          length: expected.length,
          sourceLength: 4,
          instructions: [opcode],
          data,
          addresses,
        }),
      ]),
      expected,
    ).run();
  }
});

test("VCD_TARGET references an already written window and address caches reset", async () => {
  const first = window({ length: 4, data: "abcd", instructions: [5] });
  const second = window({
    length: 8,
    sourceLength: 4,
    sourceOffset: 0,
    targetSource: true,
    instructions: [19, 8],
    addresses: [0],
  });
  const result = await fixture(
    "",
    patch([first, second]),
    "abcdabcdabcd",
  ).run();
  assert.equal(result.windows, 2);
});

test("source segment offsets and 64-bit-safe VCDIFF integers do not truncate to uint32", async () => {
  const sourceBytes = 2 ** 32 + 20,
    sourceHash = digest("not actually allocated"),
    delta = patch([
      window({
        length: 1,
        sourceLength: 1,
        sourceOffset: 2 ** 32 + 10,
        instructions: [19, 1],
        addresses: [0],
      }),
    ]);
  // The configured hard archive bound is checked before a multi-gigabyte
  // fake source is read. A callback cannot use uint32 wrapping to evade it.
  const f = fixture("", delta, "x", {
    source: {
      bytes: sourceBytes,
      read() {
        throw new Error("must not read");
      },
    },
    expectedSourceSha256: sourceHash,
    limits: { maxArchiveBytes: 1024 },
  });
  await assert.rejects(f.run(), code("INVALID_INPUT"));
  assert.equal(f.writes.length, 0);
  await fixture(
    "xxabcdyy",
    patch([
      window({
        length: 4,
        sourceLength: 4,
        sourceOffset: 2,
        instructions: [20],
        addresses: [0],
      }),
    ]),
    "abcd",
  ).run();
});

test("window Adler32 checks known independent values before writing", async () => {
  await fixture(
    "",
    patch([
      window({
        length: 3,
        data: "abc",
        instructions: [4],
        checksum: 0x024d0127,
      }),
    ]),
    "abc",
  ).run();
  const f = fixture(
    "",
    patch([
      window({
        length: 3,
        data: "abc",
        instructions: [4],
        checksum: 0x024d0128,
      }),
    ]),
    "abc",
  );
  await assert.rejects(f.run(), code("HASH_MISMATCH"));
  assert.equal(f.writes.length, 0);
});

test("source and target hashes are mandatory and wrong source fails before target writes", async () => {
  const f = fixture(
    "abcd",
    patch([
      window({
        length: 4,
        sourceLength: 4,
        instructions: [20],
        addresses: [0],
      }),
    ]),
    "abcd",
    { expectedSourceSha256: "ff".repeat(32) },
  );
  await assert.rejects(f.run(), code("HASH_MISMATCH"));
  assert.equal(f.writes.length, 0);
  const wrong = fixture(
    "",
    patch([window({ length: 1, data: "x", instructions: [2] })]),
    "x",
    { expectedTargetSha256: "ff".repeat(32) },
  );
  await assert.rejects(wrong.run(), code("HASH_MISMATCH"));
});

test("target is re-read so a changed or ignored write cannot succeed", async () => {
  const f = fixture(
    "",
    patch([window({ length: 3, data: "abc", instructions: [4] })]),
    "abc",
  );
  f.input.target.read = async () => b("bad");
  await assert.rejects(f.run(), code("HASH_MISMATCH"));
});

test("mutable source data after its baseline hash cannot produce a verified target", async () => {
  const f = fixture(
    "abcd",
    patch([
      window({
        length: 4,
        sourceLength: 4,
        instructions: [20],
        addresses: [0],
      }),
    ]),
    "abcd",
  );
  let calls = 0;
  f.input.source.read = async () => (++calls === 1 ? b("abcd") : b("wxyz"));
  await assert.rejects(f.run(), code("HASH_MISMATCH"));
});

test("unsupported file features fail without target writes or source hashing", async () => {
  for (const bytes of [
    b([0xd6, 0xc3, 0xc4, 0, 2]),
    b([0xd6, 0xc3, 0xc4, 0, 1, 1]),
  ]) {
    const f = fixture("source", bytes, "x");
    await assert.rejects(f.run(), code("PATCH_UNSUPPORTED"));
    assert.equal(f.writes.length, 0);
    assert.equal(f.reads.length, 0);
  }
});

test("truncated headers, overlong integers, unknown flags and ambiguous dictionaries stop", async () => {
  const malformed = [
    b([0xd6, 0xc3]),
    b([0xd6, 0xc3, 0xc4, 1, 0]),
    b([0xd6, 0xc3, 0xc4, 0, 8]),
    b([0xd6, 0xc3, 0xc4, 0, 4, ...Array(9).fill(128)]),
    patch([b([8, 0])]),
    patch([b([3, 0])]),
  ];
  for (const bytes of malformed) {
    const f = fixture("", bytes, "x");
    await assert.rejects(f.run(), code("PATCH_INVALID"));
    assert.equal(f.writes.length, 0);
  }
});

test("window framing, instruction/data/address exhaustion and future COPY references are strict", async () => {
  const malformed = [
    window({ length: 3, data: "abc!", instructions: [4] }),
    window({ length: 3, data: "ab", instructions: [4] }),
    window({ length: 3, data: "abc", instructions: [4], addresses: [0] }),
    window({ length: 3, data: "abc", instructions: [4, 2] }),
    window({ length: 3, data: "abc", instructions: [2] }),
    window({ length: 1, instructions: [19, 1], addresses: [0] }),
    window({
      length: 1,
      sourceLength: 1,
      sourceOffset: 1,
      instructions: [19, 1],
      addresses: [0],
    }),
    window({ length: 1, instructions: [35, 1], addresses: [1] }),
    window({ length: 1, data: "x", instructions: [2], compressed: 1 }),
  ];
  for (const bytes of malformed) {
    const f = fixture("s", patch([bytes]), "abc");
    await assert.rejects(f.run(), code("PATCH_INVALID"));
    assert.equal(f.writes.length, 0);
  }
  const good = window({ length: 3, data: "abc", instructions: [4] });
  const f = fixture("", patch([good.subarray(0, -1)]), "abc");
  await assert.rejects(f.run(), code("PATCH_INVALID"));
});

test("resource budgets reject expansion, decoded work, windows and application headers", async () => {
  const cases = [
    [
      patch([window({ length: 4, data: "x", instructions: [0, 4] })]),
      { maxWindowBytes: 3 },
    ],
    [
      patch([window({ length: 1, data: "x", instructions: [2] })]),
      { maxEncodedSectionBytes: 1 },
    ],
    [
      patch([window({ length: 2, data: "xy", instructions: [2, 2] })]),
      { maxInstructions: 1 },
    ],
    [
      patch([
        window({ length: 1, data: "x", instructions: [2] }),
        window({ length: 1, data: "y", instructions: [2] }),
      ]),
      { maxWindows: 1 },
    ],
    [b([0xd6, 0xc3, 0xc4, 0, 4, 2, 65, 66]), { maxApplicationHeaderBytes: 1 }],
  ];
  for (const [bytes, limits] of cases) {
    const f = fixture("", bytes, "xxxx", { limits });
    await assert.rejects(f.run(), code("PATCH_RESOURCE_LIMIT"));
  }
});

test("already cancelled and between-window cancellation never continue writes", async () => {
  const controller = new AbortController();
  controller.abort();
  const bytes = patch([window({ length: 1, data: "x", instructions: [2] })]);
  const f = fixture("", bytes, "x", { signal: controller.signal });
  await assert.rejects(f.run(), code("CANCELLED"));
  assert.equal(f.writes.length, 0);
  const later = new AbortController(),
    g = fixture(
      "",
      patch([
        window({ length: 1, data: "x", instructions: [2] }),
        window({ length: 1, data: "y", instructions: [2] }),
      ]),
      "xy",
      {
        signal: later.signal,
        onProgress() {
          later.abort();
        },
      },
    );
  await assert.rejects(g.run(), code("CANCELLED"));
  assert.equal(g.writes.length, 1);
});

test("observer failures are ignored and provider errors never leak text", async () => {
  await fixture(
    "",
    patch([window({ length: 1, data: "x", instructions: [2] })]),
    "x",
    {
      onProgress() {
        throw new Error("private-path");
      },
    },
  ).run();
  const f = fixture(
    "",
    patch([window({ length: 1, data: "x", instructions: [2] })]),
    "x",
  );
  f.input.target.write = async () => {
    throw new Error("private-path");
  };
  await assert.rejects(
    f.run(),
    (error) =>
      error.code === "FILE_ERROR" && !error.message.includes("private-path"),
  );
});

test("malformed callback reads and input limits are rejected safely", async () => {
  const delta = patch([window({ length: 1, data: "x", instructions: [2] })]);
  for (const options of [
    { expectedSourceSha256: null },
    { expectedTargetSha256: "AA".repeat(32) },
    { signal: {} },
    { limits: { maxWindows: 0 } },
    { limits: { unknown: 1 } },
    { limits: { maxWasmMemoryBytes: 65537 } },
  ])
    await assert.rejects(
      fixture("", delta, "x", options).run(),
      code("INVALID_INPUT"),
    );
  const f = fixture("", delta, "x");
  f.input.patch.read = async () => b([]);
  await assert.rejects(f.run(), code("PATCH_INVALID"));
  const g = fixture("source", delta, "x");
  g.input.source.read = async () => b([]);
  await assert.rejects(g.run(), code("SOURCE_CHANGED"));
});

test("real XZ/LZMA2 state continues across two independently framed VCDIFF windows", async () => {
  const xz = require("./fixtures/pdx-vcdiff/continuous-xz.json");
  const first = b(xz.firstHex.match(/../g).map((x) => parseInt(x, 16))),
    last = b(xz.lastHex.match(/../g).map((x) => parseInt(x, 16)));
  const windows = [
    window({
      length: 3,
      data: "abc",
      instructions: Buffer.concat([integer(2), first]),
      compressed: 2,
      checksum: xz.adler32[0],
    }),
    window({
      length: 3,
      data: "xyz",
      instructions: Buffer.concat([integer(2), last]),
      compressed: 2,
      checksum: xz.adler32[1],
    }),
  ];
  assert.equal(digest(Buffer.concat([first, last])), xz.combinedSha256);
  const result = await fixture("", patch(windows, 1), "abcxyz").run();
  assert.equal(result.windows, 2);
});
