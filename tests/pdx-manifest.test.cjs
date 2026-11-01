"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { parsePdxManifest } = require("../electron/pdx-manifest.cjs");

const hash = (text) => createHash("sha256").update(text).digest();
const empty = hash("").toString("base64");
const digest = hash("payload").toString("base64");
const row = (name, bytes = 7, flags = "rw", sha = digest) =>
  `${name},${bytes},${sha},${flags}`;
const manifest = (...rows) =>
  `Name: Any__Any\nHash: sha256\n\n${rows.join("\n")}\n`;
const invalid = (input, options) =>
  assert.throws(() => parsePdxManifest(input, options), {
    code: "INVALID_MANIFEST",
    message: "模组下载清单格式不受支持。",
  });
const tooLarge = (input, options) =>
  assert.throws(() => parsePdxManifest(input, options), {
    code: "RESPONSE_TOO_LARGE",
    message: "模组下载清单或内容超过允许大小。",
  });

test("parses the existing signed real manifest fixture without changing its resource identity", () => {
  const input = fs.readFileSync(
    path.join(__dirname, "fixtures", "pdx-signatures", "manifest"),
  );
  const result = parsePdxManifest(input, { expectedName: "Any__Any" });
  assert.deepEqual(result, {
    name: "Any__Any",
    hashAlgorithm: "sha256",
    entries: [
      {
        path: "6cca83a0-a6ec-11f1-92e5-affbeaa2abe2.zip",
        type: "file",
        bytes: 606268882,
        sha256: Buffer.from(
          "Ogfp1QsraESzXj8m8BfCflxS7EGffBNTdwBRN7ada5k=",
          "base64",
        ).toString("hex"),
        flags: "crw",
        unpackedBytes: 998488439,
        compression: "zip",
      },
    ],
  });
});

test("accepts multiple file, empty-file, directory and link rows with LF or CRLF", () => {
  const linkHash = hash("../target").toString("base64url") + "=";
  const text = manifest(
    row("assets\\", 0, "d", ""),
    row("assets/empty", 0, "", empty),
    row("assets/data", 7, "xwr"),
    row("shortcut", 0, "srw", linkHash),
    `${row("archive.zip", 7, "crw")},12,zip`,
  );
  const expected = parsePdxManifest(text);
  assert.deepEqual(parsePdxManifest(text.replaceAll("\n", "\r\n")), expected);
  assert.deepEqual(
    expected.entries.map((entry) => entry.type),
    ["directory", "file", "file", "symlink", "file"],
  );
  assert.equal(expected.entries[0].path, "assets");
  assert.equal(expected.entries[0].sha256, "");
  assert.equal(expected.entries[1].sha256, hash("").toString("hex"));
  assert.equal(expected.entries[2].flags, "xwr");
  assert.equal(expected.entries[3].sha256, hash("../target").toString("hex"));
});

test("a directory may follow its already listed children without reordering entries", () => {
  const result = parsePdxManifest(
    manifest(row("a/child"), row("a", 0, "d", ""), row("a-/sibling")),
  );
  assert.deepEqual(
    result.entries.map((entry) => entry.path),
    ["a/child", "a", "a-/sibling"],
  );
});

test("CSV quoting supports commas and escaped quotes only where the field permits them", () => {
  const result = parsePdxManifest(
    manifest(`"folder,a/file,b","7","${digest}",rw`),
  );
  assert.equal(result.entries[0].path, "folder,a/file,b");
  invalid(manifest(`"bad""name",7,${digest},rw`));
  for (const text of [
    `"open,7,${digest},rw`,
    `bare"quote,7,${digest},rw`,
    `"closed" tail,7,${digest},rw`,
    `"cross\nline",7,${digest},rw`,
  ])
    invalid(manifest(text));
});

test("only compressed rows have six columns, and unknown compression is inert data", () => {
  const result = parsePdxManifest(
    manifest(
      `${row("file", 7, "rwcc")},16,new-codec`,
      `${row("link.zip", 0, "cs")},0,`,
    ),
  );
  assert.equal(result.entries[0].flags, "rwcc");
  assert.equal(result.entries[0].compression, "new-codec");
  assert.equal(result.entries[1].type, "symlink");
  assert.equal(result.entries[1].compression, "");
  for (const text of [
    row("file", 7, "crw"),
    `${row("file", 7, "crw")},12`,
    `${row("file")},12,zip`,
    `${row("file", 7, "crw")},12,zip,extra`,
    `${row("file", 7, "crw")},12,bad\tcodec`,
  ])
    invalid(manifest(text));
});

test("rejects unknown flags, ambiguous directory types and invalid directory/link hashes or sizes", () => {
  for (const text of [
    row("file", 7, "R"),
    row("file", 7, "rwxz"),
    row("file", 7, "r w"),
    row("dir", 0, "ds", ""),
    `${row("dir", 0, "dc", "")},0,zip`,
    row("dir", 1, "d", ""),
    row("dir", 0, "d"),
    row("link", 1, "s"),
    row("link", 0, "s", ""),
    row("empty", 0, "rw", ""),
  ])
    invalid(manifest(text));
});

test("both padded SHA-256 alphabets are accepted, with canonical bits and exact length", () => {
  const bytes = Buffer.alloc(32, 0xff);
  for (const encoded of [
    bytes.toString("base64"),
    `${bytes.toString("base64url")}=`,
  ]) {
    const result = parsePdxManifest(manifest(row("file", 7, "r", encoded)));
    assert.equal(result.entries[0].sha256, bytes.toString("hex"));
  }
  for (const encoded of [
    empty.slice(0, -1),
    `${empty}=`,
    "0".repeat(64),
    "A".repeat(42) + "B=",
    "_" + "/".repeat(42) + "=",
    "A".repeat(42) + "%=",
    "",
  ])
    invalid(manifest(row("file", 7, "rw", encoded)));
});

test("headers are required, exact, unique and bound to the expected repository name", () => {
  invalid(manifest(row("file")), { expectedName: "Other__Any" });
  for (const text of [
    "",
    `Hash: sha256\n\n${row("file")}`,
    `Name: A\n\n${row("file")}`,
    `Name: A\nHash: SHA256\n\n${row("file")}`,
    `Name: A\nHash: sha1\n\n${row("file")}`,
    `Name: A\nHash: sha256\nHash: sha256\n\n${row("file")}`,
    `Name: A\nName: A\nHash: sha256\n\n${row("file")}`,
    `name: A\nHash: sha256\n\n${row("file")}`,
    `Name: A:B\nHash: sha256\n\n${row("file")}`,
    `Name: A\nHash: sha256\nUnknown: ignored\n\n${row("file")}`,
    `Name: A\nHash: sha256\n${row("file")}`,
  ])
    invalid(text);
  assert.deepEqual(parsePdxManifest("Name: A\nHash: sha256\n\n").entries, []);
  assert.equal(parsePdxManifest(" Hash : sha256\n Name : A\n\n").name, "A");
});

test("rejects Windows escapes, reserved names, special characters and path aliases", () => {
  for (const name of [
    "../outside",
    "a/../b",
    "a/./b",
    "/root",
    "\\root",
    "C:/root",
    "\\\\server\\share",
    "a//b",
    "a\\\\b",
    "",
    ".",
    "..",
    "file/",
    "file//",
    "file.",
    "file ",
    "a./b",
    "a /b",
    "a:b",
    "a?b",
    "a*b",
    "a|b",
    "a<b",
    "a>b",
    "a\tb",
    "a\0b",
    "a\rb",
    "a\ufffdb",
    "CON",
    "con.txt",
    "PRN",
    "aux.mod",
    "nul",
    "COM1.txt",
    "LPT9",
    "COM¹.mod",
    "LPT².txt",
    "CONIN$",
    "CONOUT$.txt",
    "CLOCK$",
    "x".repeat(256),
    Array(65).fill("a").join("/"),
    `${"中".repeat(200)}/${"字".repeat(200)}`,
  ])
    invalid(manifest(row(name)));
  invalid(manifest(row("dir//", 0, "d", "")));
  assert.equal(
    parsePdxManifest(manifest(row("合法目录/文件.mod"))).entries[0].path,
    "合法目录/文件.mod",
  );
});

test("case and NFC aliases conflict even for implicitly created ancestors", () => {
  for (const [first, second] of [
    ["same", "same"],
    ["A", "a"],
    ["é", "e\u0301"],
    ["Dir/one", "dir/two"],
    ["é/one", "e\u0301/two"],
    ["A\\file", "A/file"],
  ]) {
    invalid(manifest(row(first), row(second)));
    invalid(manifest(row(second), row(first)));
  }
  invalid(manifest(row("folder/child"), row("Folder", 0, "d", "")));
  invalid(manifest(row("folder", 0, "d", ""), row("folder/", 0, "d", "")));
});

test("files and links cannot be ancestors, regardless of entry order or similar siblings", () => {
  for (const flags of ["rw", "s"]) {
    const ancestor = row("a", flags === "s" ? 0 : 7, flags);
    for (const rows of [
      [ancestor, row("a-/sibling"), row("a/b")],
      [row("a/b"), row("a-/sibling"), ancestor],
    ])
      invalid(manifest(...rows));
  }
});

test("numeric fields reject signs, fractions, exponents, leading zeros and unsafe integers", () => {
  for (const value of [
    "-1",
    "+1",
    "1.5",
    "1e3",
    "01",
    "",
    "9007199254740992",
    "999999999999999999999",
  ]) {
    invalid(manifest(row("file", value)));
    invalid(manifest(`${row("file", 7, "c")},${value},zip`));
  }
  assert.equal(
    parsePdxManifest(manifest(row("file", " 0 ", "", empty))).entries[0].bytes,
    0,
  );
});

test("input, line, entry, packed and expanded budgets fail closed at their own boundaries", () => {
  const input = manifest(row("one"), row("two"));
  assert.equal(
    parsePdxManifest(input, {
      maxBytes: Buffer.byteLength(input),
      maxEntries: 2,
      maxFileBytes: 7,
      maxTotalBytes: 14,
    }).entries.length,
    2,
  );
  tooLarge(input, { maxBytes: Buffer.byteLength(input) - 1 });
  tooLarge(input, { maxEntries: 1 });
  tooLarge(input, { maxEntries: 0 });
  tooLarge(input, { maxFileBytes: 6 });
  tooLarge(input, { maxTotalBytes: 13 });
  tooLarge(manifest(`${row("zip", 7, "c")},15,zip`), { maxFileBytes: 14 });
  tooLarge(manifest(`${row("a", 7, "c")},9,zip`, `${row("b", 7, "c")},9,zip`), {
    maxTotalBytes: 17,
  });
  tooLarge(`Name: ${"x".repeat(64 * 1024)}\nHash: sha256\n\n`);
  assert.equal(
    parsePdxManifest(manifest(row("dir", 0, "d", "")), {
      maxFileBytes: 0,
      maxTotalBytes: 0,
    }).entries.length,
    1,
  );
});

test("strict UTF-8, BOM and control checks do not silently repair corrupted input", () => {
  const text = manifest(row("file"));
  for (const input of [
    Buffer.concat([Buffer.from(text), Buffer.from([0xc0, 0xaf])]),
    Buffer.concat([Buffer.from(text), Buffer.from([0xe2, 0x82])]),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)]),
    `\ufeff${text}`,
    `${text}\ud800`,
    `${text}\udc00`,
    text.replace("Name", "Na\0me"),
  ])
    invalid(input);
  const valid = parsePdxManifest(manifest(row("emoji-😀")));
  assert.equal(valid.entries[0].path, "emoji-😀");
});

test("copies Buffer input and freezes the returned tree", () => {
  const input = Buffer.from(manifest(row("file")));
  const result = parsePdxManifest(input);
  input.fill(0);
  assert.equal(result.entries[0].path, "file");
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.entries));
  assert.ok(Object.isFrozen(result.entries[0]));
  assert.throws(() => result.entries.push({}), TypeError);
  assert.throws(() => {
    result.entries[0].bytes = 1;
  }, TypeError);
});

test("invalid input and limits always return fixed parser errors", () => {
  for (const input of [null, undefined, {}, [], new Uint8Array([1])])
    invalid(input);
  for (const options of [
    null,
    [],
    { maxBytes: 0 },
    { maxBytes: -1 },
    { maxBytes: NaN },
    { maxEntries: 1.5 },
    { maxFileBytes: Infinity },
    { maxTotalBytes: "100" },
    { expectedName: "" },
    { expectedName: 1 },
  ])
    invalid(manifest(row("file")), options);
});
