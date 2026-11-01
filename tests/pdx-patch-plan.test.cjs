"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const {
  createPdxPatchPlan,
  parsePdxPatchOperations,
} = require("../electron/pdx-patch-plan.cjs");
const {
  normalizePdxPatchPath,
  pdxPatchPathKey,
} = require("../electron/pdx-patch-path.cjs");

// These tests inspect metadata plans only; no archive, link or target is created.
const digest = (text) => createHash("sha256").update(text).digest("hex");
const EMPTY_HASH = digest("");
const OLD_HASH = digest("old");
const NEW_HASH = digest("new");
const MAX_FILE = 5 * 1024 ** 3;
const MAX_TOTAL = 20 * 1024 ** 3;
const MAX_ENTRIES = 100000;
const MAX_OPERATIONS_BYTES = 8 * 1024 ** 2;
const file = (path, bytes = 3, sha256 = NEW_HASH) => ({
  path,
  type: "file",
  bytes,
  sha256,
});
const directory = (path) => ({
  path,
  type: "directory",
  bytes: 0,
  sha256: "",
});
const symlink = (path, target = "target") => ({
  path,
  type: "symlink",
  bytes: 0,
  sha256: digest(target),
});
const payload = (path, bytes = 3) => ({ path, bytes });
const rejectPlan = (input, code = "PATCH_INVALID", label) =>
  assert.throws(() => createPdxPatchPlan(input), { code }, label);
const rejectPath = (input, options) =>
  assert.throws(() => normalizePdxPatchPath(input, options), {
    code: "INVALID_MANIFEST",
  });

test("mixed c/d/k/n/p/s plans group deletes first and enumerate target directories", () => {
  const kept = file("assets/keep.bin", 4, OLD_HASH);
  const implicit = file("assets/implicit.bin", 7, OLD_HASH);
  const link = symlink("shortcut", "assets/deep/new.bin");
  const result = createPdxPatchPlan({
    operations: [
      "n: assets/deep/new.bin",
      "d: obsolete.bin",
      "c: assets/",
      "p: patched.bin",
      "d: retired/child.bin",
      "s: shortcut",
      "k: assets/keep.bin",
      "d: retired/",
      "c: empty/",
    ].join("\n"),
    targets: [
      file("assets/deep/new.bin"),
      kept,
      file("patched.bin", 6),
      link,
      implicit,
      directory("empty/"),
    ],
    sources: [
      kept,
      implicit,
      file("patched.bin", 2, OLD_HASH),
      file("obsolete.bin"),
      file("retired/child.bin"),
      directory("retired"),
    ],
    payloads: [
      payload("assets/deep/new.bin"),
      payload("patched.bin.vcdiff", 2),
      payload("shortcut", Buffer.byteLength("assets/deep/new.bin")),
    ],
  });

  assert.equal(result.operationCount, 9);
  assert.deepEqual(result.deletes, [
    { type: "d", path: "obsolete.bin", directoryPolicy: "empty-only" },
    { type: "d", path: "retired/child.bin", directoryPolicy: "empty-only" },
    { type: "d", path: "retired", directoryPolicy: "empty-only" },
  ]);
  assert.deepEqual(result.directories, [
    { type: "c", path: "assets", implicit: false },
    { type: "c", path: "empty", implicit: false },
    { type: "c", path: "assets/deep", implicit: true },
  ]);
  assert.deepEqual(
    result.actions.map(({ type, path, implicit }) => ({
      type,
      path,
      implicit,
    })),
    [
      { type: "n", path: "assets/deep/new.bin", implicit: false },
      { type: "p", path: "patched.bin", implicit: false },
      { type: "s", path: "shortcut", implicit: false },
      { type: "k", path: "assets/keep.bin", implicit: false },
      { type: "k", path: "assets/implicit.bin", implicit: true },
    ],
  );
  assert.deepEqual(result.actions[1].source, file("patched.bin", 2, OLD_HASH));
  assert.deepEqual(result.actions[2].target, link);
  assert.deepEqual(result.actions[3].source, kept);
  assert.deepEqual(result.actions[4].source, implicit);
});

test("operations accept LF, CRLF, final unterminated lines and normalized separators", () => {
  const expected = [
    { type: "c", path: "folder" },
    { type: "n", path: "folder/data.bin" },
  ];
  for (const input of [
    "c: folder/\nn: folder\\data.bin",
    "c: folder/\nn: folder\\data.bin\n",
    "c: folder\\\r\nn: folder\\data.bin\r\n",
    "\t c\u2003: folder/\nn: folder\\data.bin",
  ]) {
    const parsed = parsePdxPatchOperations(input);
    assert.deepEqual(parsed, expected);
    assert.deepEqual(parsePdxPatchOperations(Buffer.from(input)), expected);
    assert.ok(Object.isFrozen(parsed));
    assert.ok(parsed.every(Object.isFrozen));
  }
});

test("empty operations preserve only trusted target entries and do not copy surplus source files", () => {
  const empty = file("nested/empty", 0, EMPTY_HASH);
  for (const operations of ["", Buffer.alloc(0)]) {
    const result = createPdxPatchPlan({
      operations,
      targets: [empty, directory("unused")],
      sources: [empty, file("source-only.bin")],
    });
    assert.equal(result.operationCount, 0);
    assert.deepEqual(result.deletes, []);
    assert.deepEqual(result.actions, [
      {
        type: "k",
        path: empty.path,
        implicit: true,
        target: empty,
        source: empty,
      },
    ]);
    assert.deepEqual(
      result.directories.map(({ path }) => path),
      ["nested", "unused"],
    );
  }
  assert.deepEqual(createPdxPatchPlan({ operations: "", targets: [] }), {
    deletes: [],
    directories: [],
    actions: [],
    operationCount: 0,
  });
});

test("zero-byte new files retain the empty content digest and need a zero-byte payload", () => {
  const target = file("empty", 0, EMPTY_HASH);
  const result = createPdxPatchPlan({
    operations: "n: empty",
    targets: [target],
    payloads: [payload("empty", 0)],
  });
  assert.deepEqual(result.actions[0].target, target);
  assert.deepEqual(result.actions[0].payload, payload("empty", 0));
  rejectPlan(
    {
      operations: "n: empty",
      targets: [target],
      payloads: [payload("empty", 1)],
    },
    "HASH_MISMATCH",
  );
});

test("keep and implicit fill reject missing sources, changed sizes, digests and types", () => {
  for (const operations of ["k: kept", ""]) {
    for (const sources of [
      [],
      [file("kept", 4, NEW_HASH)],
      [file("kept", 3, OLD_HASH)],
      [directory("kept")],
      [symlink("kept")],
    ]) {
      rejectPlan(
        { operations, targets: [file("kept")], sources },
        "SOURCE_CHANGED",
      );
    }
  }
  const link = symlink("link");
  assert.equal(
    createPdxPatchPlan({
      operations: "k: link",
      targets: [link],
      sources: [link],
    }).actions[0].source.type,
    "symlink",
  );
});

test("p uses an old regular file or an explicit empty source for absent or directory sources", () => {
  const input = {
    operations: "p: changed",
    targets: [file("changed", 5)],
    payloads: [payload("changed.vcdiff", 1)],
  };
  const emptySource = {
    path: null,
    type: "file",
    bytes: 0,
    sha256: EMPTY_HASH,
  };
  for (const sources of [
    [],
    [directory("changed")],
    [file("changed/previous-child")],
  ]) {
    const result = createPdxPatchPlan({ ...input, sources });
    assert.deepEqual(result.actions[0].source, emptySource);
    assert.ok(Object.isFrozen(result.actions[0].source));
  }
  const old = file("changed", 2, OLD_HASH);
  assert.deepEqual(
    createPdxPatchPlan({ ...input, sources: [old] }).actions[0].source,
    old,
  );
  rejectPlan({ ...input, sources: [symlink("changed")] }, "PATCH_UNSUPPORTED");
});

test("d plus n is permitted while repeated delete and unknown delete paths are rejected", () => {
  const result = createPdxPatchPlan({
    operations: "n: replaced\nd: replaced",
    targets: [file("replaced")],
    sources: [file("replaced", 2, OLD_HASH)],
    payloads: [payload("replaced")],
  });
  assert.deepEqual(
    result.deletes.map(({ path }) => path),
    ["replaced"],
  );
  assert.equal(result.actions[0].type, "n");
  rejectPlan({
    operations: "d: obsolete\nd: obsolete",
    targets: [],
    sources: [file("obsolete")],
  });
  rejectPlan({ operations: "d: unknown", targets: [] });
});

test("repeated directory creation is idempotent and implicit parents precede children", () => {
  const result = createPdxPatchPlan({
    operations: "c: a/deep\nc: a/deep/\nc: z",
    targets: [directory("a/deep/end"), directory("z")],
  });
  assert.deepEqual(result.directories, [
    { type: "c", path: "a", implicit: true },
    { type: "c", path: "z", implicit: false },
    { type: "c", path: "a/deep", implicit: false },
    { type: "c", path: "a/deep/end", implicit: true },
  ]);
  rejectPlan({ operations: "c: file", targets: [file("file")] });
  rejectPlan({ operations: "c: missing", targets: [] });
});

test("one target cannot have multiple producing operations", () => {
  const input = {
    targets: [file("data")],
    sources: [file("data")],
    payloads: [payload("data"), payload("data.vcdiff", 1)],
  };
  for (const operations of [
    "n: data\nn: data",
    "k: data\nk: data",
    "p: data\np: data",
    "n: data\np: data",
    "k: data\nn: data",
  ])
    rejectPlan({ ...input, operations });
  rejectPlan({
    operations: "s: link\ns: link",
    targets: [symlink("link")],
    payloads: [payload("link", 6)],
  });
});

test("payloads must pair exactly with n, p and s operations", () => {
  for (const [type, target, path] of [
    ["n", file("data"), "data"],
    ["p", file("data"), "data.vcdiff"],
    ["s", symlink("data"), "data"],
  ]) {
    rejectPlan({ operations: `${type}: data`, targets: [target] });
    rejectPlan({
      operations: `${type}: data`,
      targets: [target],
      payloads: [payload(`wrong/${path}`)],
    });
    rejectPlan(
      {
        operations: `${type}: data`,
        targets: [target],
        payloads: [payload(path), payload("unlisted")],
      },
      "PATCH_UNSUPPORTED",
    );
  }
  rejectPlan({
    operations: "",
    targets: [],
    payloads: [payload("operations")],
  });
  rejectPlan({
    operations: "n: data",
    targets: [file("data")],
    payloads: [payload("data"), payload("data")],
  });
  rejectPlan({
    operations: "p: data",
    targets: [file("data")],
    payloads: [payload("data.vcdiff", 0)],
  });
});

test("payload length mismatches and unsupported target operation types are rejected", () => {
  rejectPlan(
    {
      operations: "n: data",
      targets: [file("data")],
      payloads: [payload("data", 2)],
    },
    "HASH_MISMATCH",
  );
  for (const [type, target] of [
    ["n", symlink("data")],
    ["p", symlink("data")],
    ["s", file("data")],
    ["k", directory("data")],
    ["n", directory("data")],
  ])
    rejectPlan({ operations: `${type}: data`, targets: [target] });
  rejectPlan({ operations: "n: unknown", targets: [] });
});

test("symlink payload metadata is bounded independently of its zero-byte manifest entry", () => {
  const input = { operations: "s: link", targets: [symlink("link")] };
  assert.equal(
    createPdxPatchPlan({ ...input, payloads: [payload("link", 4096)] })
      .actions[0].payload.bytes,
    4096,
  );
  for (const bytes of [0, 4097])
    rejectPlan(
      { ...input, payloads: [payload("link", bytes)] },
      "PATCH_RESOURCE_LIMIT",
    );
});

test("typed entries and payloads are immutable snapshots rather than caller-owned references", () => {
  const source = file("kept", 3, OLD_HASH);
  const kept = { ...source };
  const added = file("new");
  const body = payload("new");
  const operations = Buffer.from("k: kept\nn: new");
  const targets = [kept, added];
  const sources = [source];
  const payloads = [body];
  const result = createPdxPatchPlan({ operations, targets, sources, payloads });
  source.path = "mutated-source";
  source.sha256 = NEW_HASH;
  kept.bytes = 99;
  added.path = "mutated-target";
  body.bytes = 99;
  targets.length = sources.length = payloads.length = 0;
  operations.fill(0);
  assert.deepEqual(result.actions[0].source, file("kept", 3, OLD_HASH));
  assert.deepEqual(result.actions[0].target, file("kept", 3, OLD_HASH));
  assert.deepEqual(result.actions[1].target, file("new"));
  assert.deepEqual(result.actions[1].payload, payload("new"));
  for (const value of [
    result,
    result.deletes,
    result.directories,
    result.actions,
    ...result.actions,
    ...result.actions.map(({ target }) => target),
    result.actions[0].source,
    result.actions[1].payload,
  ])
    assert.ok(Object.isFrozen(value));
  assert.throws(() => {
    result.actions[1].payload.bytes = 10;
  }, TypeError);
  assert.throws(() => {
    result.actions.push({});
  }, TypeError);
});

test("invalid operations encodings, grammar, empty rows and unknown types fail closed", () => {
  for (const input of [null, 1, [], new Uint8Array([110])])
    assert.throws(() => parsePdxPatchOperations(input), {
      code: "INVALID_INPUT",
    });
  for (const input of [
    Buffer.from([0xff]),
    Buffer.from([0xc0, 0xaf]),
    "n:data",
    "n: data: extra",
    "n: data\n\n",
    "\n",
    "# comment",
    "n: ",
    "n: data ",
    "n: \ud800",
  ])
    assert.throws(() => parsePdxPatchOperations(input), {
      code: "PATCH_INVALID",
    });
  for (const input of ["x: data", "N: data", "new: data", "\ufeffn: data"])
    assert.throws(() => parsePdxPatchOperations(input), {
      code: "PATCH_UNSUPPORTED",
    });
});

test("typed metadata rejects invalid arrays, types, byte sizes and noncanonical digests", () => {
  for (const input of [
    { operations: "", targets: null },
    { operations: "", targets: [], sources: {} },
    { operations: "", targets: [], payloads: {} },
    { operations: "", targets: [null] },
    { operations: "", targets: [{ ...file("data"), type: "pipe" }] },
    { operations: "", targets: [{ ...directory("dir"), bytes: 1 }] },
    { operations: "", targets: [{ ...directory("dir"), sha256: NEW_HASH }] },
    { operations: "", targets: [{ ...symlink("link"), bytes: 1 }] },
    { operations: "", targets: [{ ...symlink("link"), sha256: "" }] },
    { operations: "", targets: [], payloads: [null] },
  ])
    rejectPlan(input, "INVALID_INPUT");
  for (const bytes of [-1, 0.5, NaN, Infinity, "3", Number.MAX_SAFE_INTEGER]) {
    rejectPlan(
      { operations: "", targets: [file("data", bytes)] },
      "INVALID_INPUT",
    );
    rejectPlan(
      { operations: "", targets: [], payloads: [payload("data", bytes)] },
      "INVALID_INPUT",
    );
  }
  for (const sha256 of [
    "",
    "a".repeat(63),
    "g".repeat(64),
    "A".repeat(64),
    null,
  ])
    rejectPlan(
      { operations: "", targets: [file("data", 3, sha256)] },
      "INVALID_INPUT",
    );
});

test("target and source namespaces reject duplicate leaves, file parents and conflicting types", () => {
  const invalidTrees = [
    [file("same"), file("same")],
    [file("parent"), file("parent/child")],
    [file("parent/child"), file("parent")],
    [symlink("parent"), file("parent/child")],
    [directory("same"), file("same")],
    [directory("same/"), directory("same")],
  ];
  for (const entries of invalidTrees) {
    rejectPlan({ operations: "", targets: entries });
    rejectPlan({ operations: "", targets: [], sources: entries });
  }
  const valid = createPdxPatchPlan({
    operations: "",
    targets: [directory("parent/child"), directory("parent")],
  });
  assert.deepEqual(
    valid.directories.map(({ path }) => path),
    ["parent", "parent/child"],
  );
});

test("case, NFC and Windows uppercase aliases cannot coexist in any metadata namespace", () => {
  const aliases = [
    ["Data", "data"],
    ["Caf\u00e9", "Cafe\u0301"],
    ["\u03c3.txt", "\u03c2.txt"],
    ["s.txt", "\u017f.txt"],
    ["I.txt", "\u0131.txt"],
  ];
  for (const [a, b] of aliases) {
    assert.equal(pdxPatchPathKey(a), pdxPatchPathKey(b));
    rejectPlan({ operations: "", targets: [directory(a), directory(b)] });
    rejectPlan({
      operations: "",
      targets: [],
      sources: [directory(a), directory(b)],
    });
    rejectPlan({
      operations: "",
      targets: [],
      payloads: [payload(a), payload(b)],
    });
    rejectPlan({
      operations: "",
      targets: [directory(`${a}/one`), directory(`${b}/two`)],
    });
  }
  rejectPlan({
    operations: "n: data",
    targets: [file("Data")],
    payloads: [payload("data")],
  });
  rejectPlan({
    operations: "",
    targets: [file("data")],
    sources: [file("Data")],
  });
});

test("Windows path escapes, device names and isolated UTF-16 surrogates are rejected everywhere", () => {
  const names = [
    "../outside",
    "/root",
    "\\root",
    "C:\\outside",
    "\\\\server\\share",
    "a/../b",
    "a/./b",
    "a//b",
    ".",
    "..",
    "a:stream",
    "a?",
    "a*",
    "a<",
    "a|",
    "a.",
    "a ",
    "a\0b",
    "a\nb",
    "a\u007fb",
    "\ufffd",
    "\ud800",
    "\udc00",
    "CON",
    "nul.txt",
    "COM1.cfg",
    "LPT\u00b9.log",
    "CONIN$",
    "CONOUT$.txt",
    "CLOCK$",
    "NUL .txt",
    "COM1 .cfg",
    "LPT\u00b9 .log",
    "folder/aux .zip",
  ];
  for (const name of names) {
    rejectPath(name);
    rejectPlan({ operations: "", targets: [directory(name)] });
    rejectPlan({ operations: "", targets: [], sources: [directory(name)] });
    rejectPlan({ operations: "", targets: [], payloads: [payload(name)] });
  }
  for (const name of [
    "COM10",
    "conifer",
    "nulled",
    "space name",
    "emoji-\ud83d\ude80",
  ])
    assert.equal(normalizePdxPatchPath(name), name);
  assert.equal(normalizePdxPatchPath("folder\\child"), "folder/child");
  assert.equal(
    normalizePdxPatchPath("folder\\", { directory: true }),
    "folder",
  );
  rejectPath("folder/");
});

test("path component, total byte and depth limits include the accepted boundary", () => {
  const component = "x".repeat(255);
  assert.equal(normalizePdxPatchPath(component), component);
  rejectPath("x".repeat(256));
  const multibyte = "\u00e9".repeat(127) + "x";
  assert.equal(Buffer.byteLength(multibyte), 255);
  assert.equal(normalizePdxPatchPath(multibyte), multibyte);
  rejectPath("\u00e9".repeat(128));
  const exactPath = [
    component,
    component,
    component,
    "x".repeat(254),
    "x",
  ].join("/");
  assert.equal(Buffer.byteLength(exactPath), 1024);
  assert.equal(normalizePdxPatchPath(exactPath), exactPath);
  rejectPath(exactPath + "x");
  assert.equal(
    normalizePdxPatchPath(Array(64).fill("x").join("/")).split("/").length,
    64,
  );
  rejectPath(Array(65).fill("x").join("/"));
});

test("operations enforce byte, scanner-line and entry-count limits before planning", () => {
  const longType = " ".repeat(65531) + "c: a";
  assert.equal(Buffer.byteLength(longType), 65535);
  assert.deepEqual(parsePdxPatchOperations(longType), [
    { type: "c", path: "a" },
  ]);
  assert.throws(() => parsePdxPatchOperations(" " + longType), {
    code: "PATCH_RESOURCE_LIMIT",
  });
  const component = "x".repeat(255);
  const longPath = [component, component, component, "x".repeat(252)].join("/");
  const exactBytes = Buffer.from(`c: ${longPath}\n`.repeat(8192));
  assert.equal(exactBytes.length, MAX_OPERATIONS_BYTES);
  assert.equal(parsePdxPatchOperations(exactBytes).length, 8192);
  assert.throws(
    () =>
      parsePdxPatchOperations(Buffer.concat([exactBytes, Buffer.from("\n")])),
    { code: "PATCH_RESOURCE_LIMIT" },
  );
  assert.equal(
    parsePdxPatchOperations("c: a\n".repeat(MAX_ENTRIES)).length,
    MAX_ENTRIES,
  );
  assert.throws(
    () => parsePdxPatchOperations("c: a\n".repeat(MAX_ENTRIES + 1)),
    { code: "PATCH_RESOURCE_LIMIT" },
  );
});

test("file and aggregate size budgets are metadata limits without allocating content", () => {
  const names = ["a", "b", "c", "d"];
  const targets = names.map((name) => file(name, MAX_FILE));
  const payloads = names.map((name) => payload(name, MAX_FILE));
  const operations = names.map((name) => `n: ${name}`).join("\n");
  assert.equal(
    targets.reduce((sum, entry) => sum + entry.bytes, 0),
    MAX_TOTAL,
  );
  assert.equal(
    createPdxPatchPlan({ operations, targets, payloads }).actions.length,
    4,
  );
  rejectPlan(
    { operations: "", targets: [file("too-large", MAX_FILE + 1)] },
    "INVALID_INPUT",
  );
  rejectPlan(
    {
      operations: "",
      targets: [],
      payloads: [payload("too-large", MAX_FILE + 1)],
    },
    "INVALID_INPUT",
  );
  rejectPlan(
    { operations, targets: [...targets, file("extra", 1)], payloads },
    "PATCH_RESOURCE_LIMIT",
  );
  rejectPlan(
    { operations: "", targets: [], sources: [...targets, file("extra", 1)] },
    "PATCH_RESOURCE_LIMIT",
  );
  rejectPlan(
    {
      operations: "",
      targets: [],
      payloads: [...payloads, payload("extra", 1)],
    },
    "PATCH_RESOURCE_LIMIT",
  );
});

test("entry budgets count implicit parents and reject excess metadata arrays", () => {
  const excessive = Array(MAX_ENTRIES + 1).fill(null);
  rejectPlan({ operations: "", targets: excessive }, "PATCH_RESOURCE_LIMIT");
  rejectPlan(
    { operations: "", targets: [], sources: excessive },
    "PATCH_RESOURCE_LIMIT",
  );
  rejectPlan(
    { operations: "", targets: [], payloads: excessive },
    "PATCH_RESOURCE_LIMIT",
  );
  const children = Array.from({ length: MAX_ENTRIES }, (_, i) =>
    directory(`root/d${i}`),
  );
  rejectPlan({ operations: "", targets: children }, "PATCH_RESOURCE_LIMIT");
});

test(
  "plans a broad namespace at the entry limit with one directory record per path",
  { timeout: 15000 },
  () => {
    const targets = Array.from({ length: MAX_ENTRIES }, (_, i) =>
      directory(`d${i}`),
    );
    const operations = targets.map(({ path }) => `c: ${path}`).join("\n");
    const result = createPdxPatchPlan({ operations, targets });
    assert.equal(result.operationCount, MAX_ENTRIES);
    assert.equal(result.directories.length, MAX_ENTRIES);
    assert.equal(result.actions.length, 0);
    assert.equal(result.deletes.length, 0);
    assert.ok(
      result.directories.every(
        (entry) => !entry.implicit && Object.isFrozen(entry),
      ),
    );
    assert.equal(
      new Set(result.directories.map(({ path }) => path)).size,
      MAX_ENTRIES,
    );
  },
);
