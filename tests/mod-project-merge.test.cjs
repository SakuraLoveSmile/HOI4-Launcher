"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const {
  createMergePlan,
  mergeTextBuffers,
  createTextMergeChunks,
  encodeMergeText,
  MERGE_LIMITS,
} = require("../electron/mod-project-merge.cjs");
const file = (value) => ({
  sha256: createHash("sha256").update(value).digest("hex"),
  bytes: Buffer.byteLength(value),
});
const merge = (base, local, upstream, extra = {}) =>
  mergeTextBuffers({
    base: base === null ? null : Buffer.from(base),
    local: local === null ? null : Buffer.from(local),
    upstream: upstream === null ? null : Buffer.from(upstream),
    ...extra,
  });

test("file plan distinguishes independent, identical, added and deleted changes", () => {
  const base = {
    unchanged: file("a"),
    local: file("b"),
    upstream: file("c"),
    same: file("d"),
    conflict: file("e"),
    deleted: file("f"),
  };
  const local = {
    ...base,
    local: file("B"),
    same: file("D"),
    conflict: file("E1"),
    added: file("new"),
  };
  const upstream = {
    ...base,
    upstream: file("C"),
    same: file("D"),
    conflict: file("E2"),
  };
  delete upstream.deleted;
  const plan = createMergePlan({ base, local, upstream });
  const entries = Object.fromEntries(
    plan.entries.map((entry) => [entry.path, entry]),
  );
  assert.equal(entries.unchanged.status, "unchanged");
  assert.equal(entries.local.status, "local-only");
  assert.equal(entries.added.status, "local-only");
  assert.equal(entries.upstream.status, "upstream-only");
  assert.equal(entries.deleted.status, "upstream-only");
  assert.equal(entries.deleted.upstream, null);
  assert.equal(entries.same.status, "same");
  assert.equal(entries.same.upstreamChanged, true);
  assert.equal(entries.conflict.status, "conflict");
  assert.equal(plan.counts.conflicts, 1);
  assert.equal(plan.counts.upstreamChanged, 4);
  assert.equal(plan.entries.length, 7);
});

test("an unknown baseline never recommends automatic upstream adoption", () => {
  const a = file("a"),
    b = file("b");
  const plan = createMergePlan({
    base: { unchanged: a, changed: a },
    local: { unchanged: a, changed: a, removed: a },
    upstream: { unchanged: a, changed: b, added: b },
    baselineKnown: false,
  });
  assert.equal(
    plan.entries.find((entry) => entry.path === "unchanged").status,
    "same",
  );
  for (const entry of plan.entries.filter(
    (item) => item.path !== "unchanged",
  )) {
    assert.equal(entry.status, "conflict");
    assert.equal(entry.upstreamChanged, true);
    assert.equal(entry.suggested, "defer");
  }
});

test("per-file comparison bases preserve deferred changes on later upstream updates", () => {
  const v1 = {
    "accept.txt": file("one"),
    "keep.txt": file("one"),
    "defer.txt": file("one"),
  };
  const v2 = Object.fromEntries(
    Object.keys(v1).map((key) => [key, file("two")]),
  );
  const mixedBase = { ...v2, "defer.txt": v1["defer.txt"] };
  const work = {
    "accept.txt": v2["accept.txt"],
    "keep.txt": file("my change"),
    "defer.txt": v1["defer.txt"],
  };
  const plan = createMergePlan({ base: mixedBase, local: work, upstream: v2 });
  assert.equal(
    plan.entries.find((entry) => entry.path === "accept.txt").status,
    "unchanged",
  );
  assert.equal(
    plan.entries.find((entry) => entry.path === "keep.txt").status,
    "local-only",
  );
  assert.equal(
    plan.entries.find((entry) => entry.path === "defer.txt").status,
    "upstream-only",
  );
});

test("unsafe paths, Windows aliases and ambiguous case-only renames fail before planning", () => {
  for (const unsafe of [
    "../a",
    "/a",
    "a\\b",
    "C:/a",
    "a/./b",
    "a//b",
    "a./b",
    "a /b",
    "NUL.txt",
    "a/COM1",
    "a\0b",
    "a:stream",
  ]) {
    assert.throws(
      () => createMergePlan({ local: { [unsafe]: file("a") } }),
      /路径/,
    );
  }
  assert.throws(
    () =>
      createMergePlan({
        base: { "events/Test.txt": file("a") },
        upstream: { "events/test.txt": file("a") },
      }),
    /大小写冲突/,
  );
  assert.throws(
    () => createMergePlan({ local: { a: file("a"), "a/b": file("b") } }),
    /文件与目录冲突/,
  );
  assert.throws(
    () => createMergePlan({ local: { A: file("a"), "a/b": file("b") } }),
    /文件与目录冲突/,
  );
  assert.throws(
    () => createMergePlan({ local: { a: { sha256: "bad", bytes: 2 } } }),
    /SHA-256/,
  );
  assert.throws(() => createMergePlan({ local: [] }), /普通文件清单/);
});

test("independent line edits merge without changing untouched lines or CRLF", () => {
  const result = merge(
    "first\r\nsecond\r\nthird",
    "FIRST\r\nsecond\r\nthird",
    "first\r\nsecond\r\nTHIRD",
  );
  assert.equal(result.status, "merged");
  assert.equal(result.buffer.toString(), "FIRST\r\nsecond\r\nTHIRD");
  assert.equal(result.mergedText, "FIRST\r\nsecond\r\nTHIRD");
});

test("insertions, deletions and edits at separate locations are combined", () => {
  const base = "a\nb\nc\nd\ne\n";
  const result = merge(
    base,
    "a\nc\nd\ne\nlocal\n",
    "upstream\na\nb\nc\nD\ne\n",
  );
  assert.equal(result.status, "merged");
  assert.equal(result.mergedText, "upstream\na\nc\nD\ne\nlocal\n");
});

test("same changes are not duplicated while additional disjoint changes survive", () => {
  const result = merge("a\nb\nc\nd\n", "A\nb\nC\nd\n", "A\nb\nc\nD\n");
  assert.equal(result.status, "merged");
  assert.equal(result.mergedText, "A\nb\nC\nD\n");
});

test("overlapping edits and ambiguous insertion boundaries remain reviewable conflicts", () => {
  for (const [base, local, upstream] of [
    ["a\nb\nc\n", "a\nLOCAL\nc\n", "a\nUPSTREAM\nc\n"],
    ["a\nb\n", "a\nlocal\nb\n", "a\nupstream\nb\n"],
    ["a\nb\n", "a\nB\n", "a\ninsert\nb\n"],
    ["a\nb\n", "a\n", "a\nB\n"],
  ]) {
    const result = merge(base, local, upstream);
    assert.equal(result.status, "conflict");
    assert.equal(result.buffer, undefined);
    assert.equal(result.localText, local);
    assert.equal(result.upstreamText, upstream);
  }
});

test("whole-file addition/deletion uses ancestry and does not invent an empty file", () => {
  assert.equal(merge("a", "a", null).buffer, null);
  assert.equal(merge("a", null, "a").buffer, null);
  assert.equal(merge("a", null, null).buffer, null);
  assert.equal(merge(null, null, "new").buffer.toString(), "new");
  assert.equal(merge(null, "same", "same").buffer.toString(), "same");
  assert.equal(merge(null, "local", "upstream").status, "conflict");
  assert.equal(merge("base", "changed", null).status, "conflict");
  assert.equal(merge("base", null, "changed").status, "conflict");
  assert.equal(merge(null, "", "").buffer.length, 0);
});

test("UTF-8 BOM and both UTF-16 byte orders survive disjoint edits", () => {
  for (const encoding of ["utf8", "utf16le", "utf16be"]) {
    const encode = (text) => encodeMergeText(text, { encoding, bom: true });
    const result = mergeTextBuffers({
      base: encode("名字\r\n中间\r\n末尾\r\n"),
      local: encode("我的名字\r\n中间\r\n末尾\r\n"),
      upstream: encode("名字\r\n中间\r\n新末尾\r\n"),
    });
    assert.equal(result.status, "merged");
    assert.equal(result.encoding, encoding);
    assert.equal(result.bom, true);
    assert.deepEqual(result.buffer, encode("我的名字\r\n中间\r\n新末尾\r\n"));
    assert.equal(result.baseText.startsWith("\uFEFF"), false);
  }
});

test("a branch's deliberate BOM change is preserved", () => {
  const result = mergeTextBuffers({
    base: encodeMergeText("a\nb\nc\n", { bom: true }),
    local: Buffer.from("A\nb\nc\n"),
    upstream: encodeMergeText("a\nb\nC\n", { bom: true }),
  });
  assert.equal(result.status, "merged");
  assert.equal(result.bom, false);
  assert.deepEqual(result.buffer, Buffer.from("A\nb\nC\n"));
});

test("binary and invalid encodings never become lossy automatic text", () => {
  for (const bytes of [
    Buffer.from([0, 0, 3]),
    Buffer.from([0xc0, 0xaf]),
    Buffer.from([0xff, 0xfe, 0, 0xd8]),
    Buffer.from([0xfe, 0xff, 0]),
  ]) {
    const result = mergeTextBuffers({
      base: bytes,
      local: Buffer.concat([bytes, Buffer.from([1])]),
      upstream: Buffer.concat([bytes, Buffer.from([2])]),
    });
    assert.equal(result.status, "binary");
    assert.equal(result.buffer, undefined);
  }
  const oneSide = mergeTextBuffers({
    base: Buffer.from([0, 1]),
    local: Buffer.from([0, 1]),
    upstream: Buffer.from([0, 2]),
  });
  assert.equal(oneSide.status, "merged");
  assert.equal(oneSide.binary, true);
  assert.deepEqual(oneSide.buffer, Buffer.from([0, 2]));
  const encChange = mergeTextBuffers({
    base: Buffer.from("a\nb\n"),
    local: encodeMergeText("A\nb\n", { encoding: "utf16le", bom: true }),
    upstream: Buffer.from("a\nB\n"),
  });
  assert.equal(encChange.status, "binary");
  assert.equal(encChange.reason, "encoding-change");
});

test("manual text encoding refuses invalid Unicode and control bytes", () => {
  for (const text of ["\uD800", "\uDC00", "a\0b", "a\x07b"])
    assert.throws(() => encodeMergeText(text), /无效/);
  assert.deepEqual(encodeMergeText("🙂中文\n"), Buffer.from("🙂中文\n"));
  assert.throws(() => encodeMergeText("a", { encoding: "latin1" }), /无效/);
});

test("merge has explicit text, line and adversarial-diff limits", () => {
  assert.equal(
    merge("a", "long", "other", { maxBytes: 2 }).reason,
    "size-limit",
  );
  const many = "line\n".repeat(MERGE_LIMITS.lines + 1);
  assert.equal(
    merge(many, "local\n" + many, many + "upstream\n").reason,
    "line-limit",
  );
  const base = Array.from({ length: 700 }, (_, i) => `base${i}\n`).join("");
  const local = Array.from({ length: 700 }, (_, i) => `local${i}\n`).join("");
  const result = merge(base, local, base.replace("base699", "upstream699"));
  assert.equal(result.status, "conflict");
  assert.equal(result.reason, "merge-budget");
});

test("widely separated modifications in a large file use bounded near-linear matching", () => {
  const lines = Array.from({ length: 20000 }, (_, i) => `line ${i}\n`);
  const left = [...lines],
    right = [...lines],
    expected = [...lines];
  for (const i of [2, 10000, 19998]) left[i] = expected[i] = `local ${i}\n`;
  for (const i of [3, 11000, 19999]) right[i] = expected[i] = `upstream ${i}\n`;
  const result = merge(lines.join(""), left.join(""), right.join(""));
  assert.equal(result.status, "merged");
  assert.equal(result.mergedText, expected.join(""));
});

test("generated disjoint line replacements retain both versions across repeated inputs", () => {
  let seed = 4123;
  const next = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  for (let run = 0; run < 100; run++) {
    const base = Array.from({ length: 100 }, (_, i) => `original ${i}\n`);
    const local = [...base],
      upstream = [...base],
      expected = [...base];
    for (let j = 0; j < 15; j++) {
      const i = (next() % 50) * 2;
      local[i] = expected[i] = `local ${i}\n`;
    }
    for (let j = 0; j < 15; j++) {
      const i = (next() % 50) * 2 + 1;
      upstream[i] = expected[i] = `upstream ${i}\n`;
    }
    const result = merge(base.join(""), local.join(""), upstream.join(""));
    assert.equal(result.status, "merged", `run ${run}`);
    assert.equal(result.mergedText, expected.join(""), `run ${run}`);
  }
});

const chunked = (base, local, upstream, options = {}) =>
  createTextMergeChunks({
    base: base === null ? null : Buffer.from(base),
    local: local === null ? null : Buffer.from(local),
    upstream: upstream === null ? null : Buffer.from(upstream),
    ...options,
  });
const compose = (result, choice) =>
  result.chunks
    .map((chunk, index) => {
      const selected =
        typeof choice === "function" ? choice(chunk, index) : choice;
      if (!chunk.changed || selected === "auto") {
        assert.equal(
          typeof chunk.mergedText,
          "string",
          "automatic choice requires a conflict-free chunk",
        );
        return chunk.mergedText;
      }
      return selected === "local" ? chunk.localText : chunk.upstreamText;
    })
    .join("");

test("separate text conflicts can choose a different side while keeping intervening content", () => {
  const base =
    "header\nfirst=base\n" +
    "unchanged context\n".repeat(20) +
    "second=base\nfooter";
  const local = base
    .replace("first=base", "first=local")
    .replace("second=base", "second=local");
  const upstream = base
    .replace("first=base", "first=upstream")
    .replace("second=base", "second=upstream");
  const result = chunked(base, local, upstream);
  assert.equal(result.status, "text");
  const changed = result.chunks.filter((c) => c.changed);
  assert.equal(changed.length, 2);
  assert.ok(changed.every((c) => c.conflict && c.mergedText === undefined));
  assert.equal(
    new Set(result.chunks.map((c) => c.id)).size,
    result.chunks.length,
  );
  assert.equal(
    compose(result, (c) =>
      c.localText.includes("first=local") ? "local" : "upstream",
    ),
    base
      .replace("first=base", "first=local")
      .replace("second=base", "second=upstream"),
  );
  assert.equal(compose(result, "local"), local);
  assert.equal(compose(result, "upstream"), upstream);
});

test("disjoint edits expose independently selectable regions and a complete automatic composition", () => {
  const base = "a\nb\nc\nd\ne\n";
  const local = "A\nb\nc\nd\ne\n",
    upstream = "a\nb\nc\nd\nE\n";
  const result = chunked(base, local, upstream);
  assert.equal(result.chunks.filter((c) => c.changed).length, 2);
  assert.ok(result.chunks.every((c) => !c.conflict));
  assert.equal(compose(result, "auto"), "A\nb\nc\nd\nE\n");
  assert.equal(compose(result, "local"), local);
  assert.equal(compose(result, "upstream"), upstream);
  assert.equal(result.chunks.map((c) => c.baseText).join(""), base);
});

test("overlap-connected edits form one coherent region, including transitive bridges", () => {
  const base = "head\na\nb\nc\nd\ne\ntail\n";
  const local = "head\nlocal-a\nb\nc\nlocal-d\ne\ntail\n";
  const upstream = "head\nupstream-region\ne\ntail\n";
  const result = chunked(base, local, upstream);
  const changes = result.chunks.filter((c) => c.changed);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].conflict, true);
  assert.equal(compose(result, "local"), local);
  assert.equal(compose(result, "upstream"), upstream);
  assert.equal(result.chunks.map((c) => c.baseText).join(""), base);
});

test("boundary insertions and deletions reconstruct either source without losing surrounding lines", () => {
  for (const [base, local, upstream] of [
    ["a\nb\nc\n", "start\na\nb\nc\n", "a\nb\nc\nend\n"],
    ["a\nb\nc\n", "a\nlocal\nb\nc\n", "a\nupstream\nb\nc\n"],
    ["a\nb\nc\n", "a\nc\n", "a\ninsert\nb\nc\n"],
    ["a\nb\nc\n", "a\nc\n", "a\nb\ninsert\nc\n"],
    ["a\nb\nc\n", "a\nB\nc\n", "a\ninsert\nb\nc\n"],
    ["a\nb\nc", "", "a\nB\nc"],
    ["", "local\n", "upstream\n"],
    ["a", "a\n", "a\nupstream"],
  ]) {
    const result = chunked(base, local, upstream);
    assert.equal(result.status, "text");
    assert.equal(compose(result, "local"), local);
    assert.equal(compose(result, "upstream"), upstream);
    assert.equal(result.chunks.map((c) => c.baseText).join(""), base);
  }
  const ambiguous = chunked("a\nb\nc\n", "a\nc\n", "a\nb\ninsert\nc\n");
  assert.equal(ambiguous.chunks.filter((c) => c.conflict).length, 1);
});

test("fragment text preserves CRLF, missing final newlines, UTF-8 BOM and UTF-16 order", () => {
  for (const encoding of ["utf8", "utf16le", "utf16be"]) {
    const encode = (text) => encodeMergeText(text, { encoding, bom: true });
    const result = createTextMergeChunks({
      base: encode("名字\r\n中间\r\n尾巴"),
      local: encode("本地名字\r\n中间\r\n本地尾巴"),
      upstream: encode("上游名字\r\n中间\r\n上游尾巴"),
    });
    assert.equal(result.status, "text");
    assert.equal(result.encoding, encoding);
    assert.equal(result.bom, true);
    assert.equal(
      result.chunks.some((c) => c.localText.includes("\uFEFF")),
      false,
    );
    const text = compose(result, (c) =>
      c.localText.includes("名字") ? "local" : "upstream",
    );
    assert.deepEqual(
      encodeMergeText(text, result),
      encode("本地名字\r\n中间\r\n上游尾巴"),
    );
  }
  const workingFormat = createTextMergeChunks({
    base: encodeMergeText("a\nb", { bom: true }),
    local: Buffer.from("A\nb"),
    upstream: encodeMergeText("a\nB", { bom: true }),
  });
  assert.equal(workingFormat.bom, false);
  assert.deepEqual(
    encodeMergeText(compose(workingFormat, "auto"), workingFormat),
    Buffer.from("A\nB"),
  );
});

test("identical edits and empty existing files remain directly composable", () => {
  const same = chunked("a\nb\nc\n", "a\nB\nc\n", "a\nB\nc\n");
  assert.equal(same.chunks.filter((c) => c.changed).length, 1);
  assert.equal(compose(same, "auto"), "a\nB\nc\n");
  const empty = chunked("", "", "");
  assert.equal(empty.status, "text");
  assert.equal(empty.chunks.length, 1);
  assert.equal(empty.chunks[0].changed, false);
  assert.equal(compose(empty, "auto"), "");
});

test("whole-file absence and unsupported encoding never invent selectable text", () => {
  for (const values of [
    [null, "a", "b"],
    ["a", null, "b"],
    ["a", "b", null],
  ]) {
    const result = chunked(...values);
    assert.equal(result.status, "unavailable");
    assert.equal(result.reason, "add-or-delete");
    assert.deepEqual(result.chunks, []);
  }
  for (const bytes of [
    Buffer.from([0, 1]),
    Buffer.from([0xc0, 0xaf]),
    Buffer.from([0xff, 0xfe, 0, 0xd8]),
  ]) {
    const result = createTextMergeChunks({
      base: bytes,
      local: bytes,
      upstream: bytes,
    });
    assert.equal(result.status, "binary");
    assert.deepEqual(result.chunks, []);
  }
  const changedEncoding = createTextMergeChunks({
    base: Buffer.from("a"),
    local: encodeMergeText("a", { encoding: "utf16le", bom: true }),
    upstream: Buffer.from("a"),
  });
  assert.equal(changedEncoding.status, "binary");
  assert.equal(changedEncoding.reason, "encoding-change");
});

test("fragment selection has the same bounded text, line and adversarial-diff limits", () => {
  assert.equal(
    chunked("a", "long", "other", { maxBytes: 2 }).reason,
    "size-limit",
  );
  const many = "line\n".repeat(MERGE_LIMITS.lines + 1);
  const lineLimited = chunked(many, many, many);
  assert.equal(lineLimited.status, "unavailable");
  assert.equal(lineLimited.reason, "line-limit");
  const base = Array.from({ length: 700 }, (_, i) => `base${i}\n`).join("");
  const local = Array.from({ length: 700 }, (_, i) => `local${i}\n`).join("");
  const diffLimited = chunked(
    base,
    local,
    base.replace("base699", "upstream699"),
  );
  assert.equal(diffLimited.status, "unavailable");
  assert.equal(diffLimited.reason, "merge-budget");
  assert.deepEqual(diffLimited.chunks, []);
  assert.throws(() => chunked("a", "b", "c", { maxBytes: 0 }), /限制无效/);
  assert.throws(
    () =>
      createTextMergeChunks({
        base: "a",
        local: Buffer.from("a"),
        upstream: Buffer.from("a"),
      }),
    /文件内容/,
  );
});

test("generated mixed edits preserve all three original texts under per-side composition", () => {
  let seed = 27641;
  const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  for (let run = 0; run < 120; run++) {
    const baseLines = Array.from({ length: 50 }, (_, i) => `original ${i}\n`);
    const change = (side) =>
      baseLines
        .flatMap((line, i) => {
          const kind = next() % 12;
          if (kind === 0) return [];
          if (kind === 1) return [`${side} replacement ${i}\n`];
          if (kind === 2) return [`${side} insertion ${i}\n`, line];
          return [line];
        })
        .join("");
    const base = baseLines.join(""),
      local = change("local"),
      upstream = change("upstream"),
      result = chunked(base, local, upstream);
    assert.equal(result.status, "text", `run ${run}`);
    assert.equal(
      result.chunks.map((c) => c.baseText).join(""),
      base,
      `base run ${run}`,
    );
    assert.equal(compose(result, "local"), local, `local run ${run}`);
    assert.equal(compose(result, "upstream"), upstream, `upstream run ${run}`);
  }
});
