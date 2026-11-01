"use strict";

const { TextDecoder } = require("node:util");

const MERGE_LIMITS = Object.freeze({
  files: 200000,
  textBytes: 2 * 1024 * 1024,
  maxTextBytes: 8 * 1024 * 1024,
  lines: 40000,
  editDistance: 512,
  work: 4000000,
});
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const equal = (a, b) =>
  a === b ||
  (!!a &&
    !!b &&
    a.sha256.toLowerCase() === b.sha256.toLowerCase() &&
    a.bytes === b.bytes);

function validPath(value) {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 1024 ||
    /[\\\0-\x1f<>:"|?*]/.test(value) ||
    value
      .split("/")
      .some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          /[. ]$/.test(part) ||
          /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³]|CONIN\$|CONOUT\$|CLOCK\$)(?:\.|$)/i.test(
            part,
          ),
      )
  )
    throw new Error("模组比较包含不安全的相对文件路径。");
}

function validateTree(tree, paths) {
  if (
    !tree ||
    typeof tree !== "object" ||
    Array.isArray(tree) ||
    ![null, Object.prototype].includes(Object.getPrototypeOf(tree))
  )
    throw new Error("模组比较需要普通文件清单。");
  const keys = Object.keys(tree);
  const canonicalKeys = new Set(keys.map((key) => key.toLowerCase()));
  if (keys.length > MERGE_LIMITS.files)
    throw new Error("模组比较的文件数量超过限制。");
  for (const key of keys) {
    validPath(key);
    const value = tree[key];
    if (
      !value ||
      typeof value !== "object" ||
      !/^[a-f0-9]{64}$/i.test(value.sha256) ||
      !Number.isSafeInteger(value.bytes) ||
      value.bytes < 0
    )
      throw new Error("模组文件清单的大小或 SHA-256 无效。");
    const canonical = key.toLowerCase();
    if (paths.has(canonical) && paths.get(canonical) !== key)
      throw new Error("模组文件路径存在大小写冲突，请先明确处理重命名。");
    paths.set(canonical, key);
    const parts = key.split("/");
    while (parts.length > 1) {
      parts.pop();
      if (canonicalKeys.has(parts.join("/").toLowerCase()))
        throw new Error("模组文件清单中存在文件与目录冲突。");
    }
  }
}

function createMergePlan({
  base = {},
  local = {},
  upstream = {},
  baselineKnown = true,
} = {}) {
  if (typeof baselineKnown !== "boolean")
    throw new Error("模组合并基线状态无效。");
  const paths = new Map();
  for (const tree of [base, local, upstream]) validateTree(tree, paths);
  if (paths.size > MERGE_LIMITS.files)
    throw new Error("模组比较的文件数量超过限制。");
  const entries = [];
  const counts = {
    total: paths.size,
    unchanged: 0,
    "local-only": 0,
    "upstream-only": 0,
    same: 0,
    conflict: 0,
    localChanged: 0,
    upstreamChanged: 0,
    conflicts: 0,
  };
  const at = (tree, key) => (own(tree, key) ? tree[key] : null);
  for (const file of [...paths.values()].sort()) {
    const b = at(base, file),
      l = at(local, file),
      u = at(upstream, file);
    let localChanged = !equal(b, l),
      upstreamChanged = !equal(b, u);
    let status, suggested;
    if (!baselineKnown) {
      // A captured local copy is not proof that it was ever the author's version.
      upstreamChanged = !equal(l, u);
      localChanged = upstreamChanged;
      status = upstreamChanged ? "conflict" : "same";
      suggested = upstreamChanged ? "defer" : "local";
    } else if (!localChanged && !upstreamChanged) {
      status = "unchanged";
      suggested = "local";
    } else if (equal(l, u)) {
      status = "same";
      suggested = "local";
    } else if (!upstreamChanged) {
      status = "local-only";
      suggested = "local";
    } else if (!localChanged) {
      status = "upstream-only";
      suggested = "auto";
    } else {
      status = "conflict";
      suggested = "defer";
    }
    entries.push({
      path: file,
      status,
      localChanged,
      upstreamChanged,
      suggested,
      base: b,
      local: l,
      upstream: u,
    });
    counts[status]++;
    if (localChanged) counts.localChanged++;
    if (upstreamChanged) counts.upstreamChanged++;
    if (status === "conflict") counts.conflicts++;
  }
  return { entries, counts };
}

function decodeText(buffer) {
  if (buffer === null) return null;
  let encoding = "utf8",
    bom = false,
    content = buffer;
  if (
    buffer.length >= 3 &&
    buffer.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))
  ) {
    bom = true;
    content = buffer.subarray(3);
  } else if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    encoding = "utf16le";
    bom = true;
    content = buffer.subarray(2);
  } else if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    encoding = "utf16be";
    bom = true;
    content = buffer.subarray(2);
  }
  if (encoding !== "utf8" && content.length % 2) return undefined;
  try {
    const text = new TextDecoder(
      encoding === "utf8"
        ? "utf-8"
        : encoding === "utf16be"
          ? "utf-16be"
          : "utf-16le",
      { fatal: true, ignoreBOM: true },
    ).decode(content);
    if (/[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) return undefined;
    return { text, encoding, bom };
  } catch {
    return undefined;
  }
}

function encodeMergeText(text, { encoding = "utf8", bom = false } = {}) {
  if (
    typeof text !== "string" ||
    !["utf8", "utf16le", "utf16be"].includes(encoding) ||
    typeof bom !== "boolean" ||
    text.length > MERGE_LIMITS.maxTextBytes ||
    /[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text) ||
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
      text,
    )
  )
    throw new Error("手工合并文本或编码无效。");
  const buffer = Buffer.from(text, encoding === "utf8" ? "utf8" : "utf16le");
  if (buffer.length > MERGE_LIMITS.maxTextBytes)
    throw new Error("手工合并文本超过大小限制。");
  if (encoding === "utf16be") buffer.swap16();
  return bom
    ? Buffer.concat([
        Buffer.from(
          encoding === "utf8"
            ? [0xef, 0xbb, 0xbf]
            : encoding === "utf16le"
              ? [0xff, 0xfe]
              : [0xfe, 0xff],
        ),
        buffer,
      ])
    : buffer;
}

function linesOf(text) {
  const lines = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "\r" && text[i] !== "\n") continue;
    if (text[i] === "\r" && text[i + 1] === "\n") i++;
    lines.push(text.slice(start, i + 1));
    start = i + 1;
    if (lines.length > MERGE_LIMITS.lines) return null;
  }
  if (start < text.length) lines.push(text.slice(start));
  return lines.length <= MERGE_LIMITS.lines ? lines : null;
}

// Bounded Myers diff. The trace has at most 513 x 1027 int32 entries and the
// work counter also includes matching runs, so near-identical large files are
// cheap without allowing adversarial quadratic comparisons.
function editsBetween(original, changed) {
  let prefix = 0;
  while (
    prefix < original.length &&
    prefix < changed.length &&
    original[prefix] === changed[prefix]
  )
    prefix++;
  let suffix = 0;
  while (
    suffix < original.length - prefix &&
    suffix < changed.length - prefix &&
    original[original.length - suffix - 1] ===
      changed[changed.length - suffix - 1]
  )
    suffix++;
  const a = original.slice(prefix, original.length - suffix);
  const b = changed.slice(prefix, changed.length - suffix);
  if (!a.length || !b.length)
    return a.length || b.length
      ? [{ start: prefix, end: prefix + a.length, lines: b }]
      : [];
  const limit = Math.min(a.length + b.length, MERGE_LIMITS.editDistance);
  const offset = limit + 1;
  const v = new Int32Array(2 * limit + 3).fill(-1);
  v[offset + 1] = 0;
  const trace = [];
  let work = 0,
    distance = -1;
  outer: for (let d = 0; d <= limit; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      if (++work > MERGE_LIMITS.work) return null;
      let x =
        k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])
          ? v[offset + k + 1]
          : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < a.length && y < b.length && a[x] === b[y]) {
        if (++work > MERGE_LIMITS.work) return null;
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= a.length && y >= b.length) {
        distance = d;
        break outer;
      }
    }
  }
  if (distance < 0) return null;
  const ops = [];
  let x = a.length,
    y = b.length;
  for (let d = distance; d >= 0; d--) {
    const previous = trace[d],
      k = x - y;
    const previousK =
      k === -d ||
      (k !== d && previous[offset + k - 1] < previous[offset + k + 1])
        ? k + 1
        : k - 1;
    const previousX = previous[offset + previousK];
    const previousY = previousX - previousK;
    while (x > previousX && y > previousY) {
      ops.push({ type: "equal" });
      x--;
      y--;
    }
    if (d === 0) break;
    if (x === previousX) {
      ops.push({ type: "insert", line: b[y - 1] });
      y--;
    } else {
      ops.push({ type: "delete" });
      x--;
    }
  }
  const edits = [];
  let position = prefix,
    active = null;
  for (const op of ops.reverse()) {
    if (op.type === "equal") {
      active = null;
      position++;
      continue;
    }
    if (!active) {
      active = { start: position, end: position, lines: [] };
      edits.push(active);
    }
    if (op.type === "delete") active.end = ++position;
    else active.lines.push(op.line);
  }
  return edits;
}

function sameEdit(a, b) {
  return (
    a.start === b.start &&
    a.end === b.end &&
    a.lines.length === b.lines.length &&
    a.lines.every((line, index) => line === b.lines[index])
  );
}
function overlaps(a, b) {
  if (a.start === a.end) return a.start >= b.start && a.start <= b.end;
  if (b.start === b.end) return b.start >= a.start && b.start <= a.end;
  return a.start < b.end && b.start < a.end;
}

function mergeTextBuffers({
  base,
  local,
  upstream,
  maxBytes = MERGE_LIMITS.textBytes,
} = {}) {
  if (
    [base, local, upstream].some(
      (value) => value !== null && !Buffer.isBuffer(value),
    )
  )
    throw new Error("三方合并需要文件内容或明确的缺失标记。");
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > MERGE_LIMITS.maxTextBytes
  )
    throw new Error("文本比较大小限制无效。");
  if ([base, local, upstream].some((value) => value && value.length > maxBytes))
    return { status: "binary", binary: true, reason: "size-limit" };
  const b = decodeText(base),
    l = decodeText(local),
    u = decodeText(upstream);
  const format = l || u || b || { encoding: "utf8", bom: false };
  const texts = {
    baseText: b?.text ?? null,
    localText: l?.text ?? null,
    upstreamText: u?.text ?? null,
    encoding: format.encoding,
    bom: format.bom,
    binary: b === undefined || l === undefined || u === undefined,
  };
  const byteEqual = (a, z) =>
    a === z || (a !== null && z !== null && a.equals(z));
  const merged = (buffer, source) => ({
    ...texts,
    status: "merged",
    buffer: buffer === null ? null : Buffer.from(buffer),
    mergedText: source?.text ?? null,
    encoding: source?.encoding ?? format.encoding,
    bom: source?.bom ?? format.bom,
  });
  if (byteEqual(local, upstream)) return merged(local, l);
  if (byteEqual(base, local)) return merged(upstream, u);
  if (byteEqual(base, upstream)) return merged(local, l);
  if (texts.binary)
    return { ...texts, status: "binary", reason: "unsupported-text" };
  if (base === null || local === null || upstream === null)
    return { ...texts, status: "conflict", reason: "add-or-delete" };
  if (new Set([b.encoding, l.encoding, u.encoding]).size !== 1)
    return {
      ...texts,
      status: "binary",
      binary: true,
      reason: "encoding-change",
    };
  const baseLines = linesOf(b.text),
    localLines = linesOf(l.text),
    upstreamLines = linesOf(u.text);
  if (!baseLines || !localLines || !upstreamLines)
    return { ...texts, status: "conflict", reason: "line-limit" };
  const localEdits = editsBetween(baseLines, localLines),
    upstreamEdits = editsBetween(baseLines, upstreamLines);
  if (!localEdits || !upstreamEdits)
    return { ...texts, status: "conflict", reason: "merge-budget" };
  const edits = [...localEdits];
  for (const incoming of upstreamEdits) {
    let duplicate = false;
    for (const existing of localEdits) {
      if (sameEdit(existing, incoming)) duplicate = true;
      else if (overlaps(existing, incoming))
        return { ...texts, status: "conflict", reason: "overlapping-edit" };
    }
    if (!duplicate) edits.push(incoming);
  }
  edits.sort((a, z) => a.start - z.start || a.end - z.end);
  const chunks = [];
  let position = 0;
  for (const edit of edits) {
    chunks.push(...baseLines.slice(position, edit.start), ...edit.lines);
    position = edit.end;
  }
  chunks.push(...baseLines.slice(position));
  const mergedText = chunks.join("");
  const bom = l.bom === b.bom ? u.bom : l.bom;
  const buffer = encodeMergeText(mergedText, { encoding: l.encoding, bom });
  if (buffer.length > maxBytes)
    return { ...texts, status: "conflict", reason: "result-size-limit" };
  return {
    ...texts,
    status: "merged",
    buffer,
    mergedText,
    encoding: l.encoding,
    bom,
  };
}

// Preserve every unchanged region while exposing independently selectable
// connected edit regions. Insertions touching a replacement are deliberately
// grouped with it: choosing either side must never duplicate boundary lines.
function createTextMergeChunks({
  base,
  local,
  upstream,
  maxBytes = MERGE_LIMITS.textBytes,
} = {}) {
  if (
    [base, local, upstream].some(
      (value) => value !== null && !Buffer.isBuffer(value),
    )
  )
    throw new Error("三方合并需要文件内容或明确的缺失标记。");
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > MERGE_LIMITS.maxTextBytes
  )
    throw new Error("文本比较大小限制无效。");
  const unavailable = (status, reason, format = null) => ({
    status,
    reason,
    chunks: [],
    encoding: format?.encoding ?? null,
    bom: format?.bom ?? false,
  });
  if ([base, local, upstream].some((value) => value === null))
    return unavailable("unavailable", "add-or-delete");
  if ([base, local, upstream].some((value) => value.length > maxBytes))
    return unavailable("binary", "size-limit");
  const b = decodeText(base),
    l = decodeText(local),
    u = decodeText(upstream);
  if (!b || !l || !u) return unavailable("binary", "unsupported-text");
  if (new Set([b.encoding, l.encoding, u.encoding]).size !== 1)
    return unavailable("binary", "encoding-change");
  const baseLines = linesOf(b.text),
    localLines = linesOf(l.text),
    upstreamLines = linesOf(u.text);
  if (!baseLines || !localLines || !upstreamLines)
    return unavailable("unavailable", "line-limit", l);
  const localEdits = editsBetween(baseLines, localLines),
    upstreamEdits = editsBetween(baseLines, upstreamLines);
  if (!localEdits || !upstreamEdits)
    return unavailable("unavailable", "merge-budget", l);
  const edits = [
    ...localEdits.map((edit) => ({ ...edit, side: "local" })),
    ...upstreamEdits.map((edit) => ({ ...edit, side: "upstream" })),
  ].sort((a, z) => a.start - z.start || a.end - z.end);
  const groups = [];
  let group = null,
    work = 0;
  for (const edit of edits) {
    let connected = false;
    if (group)
      for (const member of group.edits) {
        if (++work > MERGE_LIMITS.work)
          return unavailable("unavailable", "merge-budget", l);
        if (overlaps(member, edit)) {
          connected = true;
          break;
        }
      }
    if (!connected) {
      group = { start: edit.start, end: edit.end, edits: [] };
      groups.push(group);
    }
    group.edits.push(edit);
    group.end = Math.max(group.end, edit.end);
  }
  const chunks = [];
  const unchanged = (text) =>
    chunks.push({
      id: `chunk-${chunks.length}`,
      changed: false,
      baseText: text,
      localText: text,
      upstreamText: text,
      mergedText: text,
      conflict: false,
    });
  const render = (region, side) => {
    const pieces = [];
    let position = region.start;
    for (const edit of region.edits) {
      if (edit.side !== side) continue;
      pieces.push(...baseLines.slice(position, edit.start), ...edit.lines);
      position = edit.end;
    }
    pieces.push(...baseLines.slice(position, region.end));
    return pieces.join("");
  };
  let position = 0;
  for (const region of groups) {
    if (region.start > position)
      unchanged(baseLines.slice(position, region.start).join(""));
    const baseText = baseLines.slice(region.start, region.end).join(""),
      localText = render(region, "local"),
      upstreamText = render(region, "upstream");
    let mergedText;
    if (localText === upstreamText) mergedText = localText;
    else if (localText === baseText) mergedText = upstreamText;
    else if (upstreamText === baseText) mergedText = localText;
    chunks.push({
      id: `chunk-${chunks.length}`,
      changed: true,
      baseText,
      localText,
      upstreamText,
      ...(mergedText === undefined ? {} : { mergedText }),
      conflict: mergedText === undefined,
    });
    position = region.end;
  }
  if (position < baseLines.length)
    unchanged(baseLines.slice(position).join(""));
  if (!chunks.length) unchanged(b.text);
  // Fragment selection concerns text. Keep the working file's format so manual
  // composition uses the same encoding/BOM rule as the project service.
  return { status: "text", chunks, encoding: l.encoding, bom: l.bom };
}

module.exports = {
  createMergePlan,
  mergeTextBuffers,
  createTextMergeChunks,
  encodeMergeText,
  MERGE_LIMITS,
};
