"use strict";

const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");

const LIMITS = Object.freeze({
  indexBytes: 64 * 1024 ** 2,
  entries: 100000,
  fileBytes: 4 * 1024 ** 3,
  totalBytes: 20 * 1024 ** 3,
  issues: 100,
});
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const object = (value) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const hash = (value) => createHash("sha256").update(value).digest("hex");
const canonical = (value) => path.resolve(value).toLowerCase();
const uuid = (value) =>
  typeof value === "string" &&
  value.length === 36 &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
    value,
  );
const sha256 = (value) =>
  typeof value === "string" &&
  value.length === 64 &&
  /^[a-f0-9]{64}$/.test(value);
const identity = (stat) => ({
  ino: stat.ino,
  dev: stat.dev,
  birthtimeMs: stat.birthtimeMs,
});
const same = (a, b) =>
  a &&
  b &&
  a.ino === b.ino &&
  a.dev === b.dev &&
  a.birthtimeMs === b.birthtimeMs;
const validIdentity = (value) =>
  object(value) &&
  ["ino", "dev", "birthtimeMs"].every(
    (key) => own(value, key) && Number.isFinite(value[key]) && value[key] >= 0,
  );
function failure(code = "INTEGRITY_INDEX_INVALID") {
  return Object.assign(
    new Error(
      code === "VALIDATION_LIMIT"
        ? "模组文件校验超过安全限制，已保留现有内容。"
        : code === "CONTENT_CHANGED"
          ? "模组文件在校验时发生变化，已保留现有内容。"
          : "模组文件校验基准无效，请重新获取可信完整包。",
    ),
    { code },
  );
}
function abort(signal) {
  if (signal?.aborted)
    throw Object.assign(new Error("模组文件校验已取消。"), {
      name: "AbortError",
      code: "CANCELLED",
    });
}
function exactKeys(value, keys) {
  if (
    !object(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !own(value, key)) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw failure();
}
function absolute(value) {
  if (
    typeof value !== "string" ||
    !path.isAbsolute(value) ||
    /[\0-\x1f\x7f]/.test(value)
  )
    throw failure();
  return path.resolve(value);
}
function relativeName(value) {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 1024 ||
    value.includes("\\") ||
    value.startsWith("/") ||
    /[\0-\x1f\x7f<>:"|?*]/.test(value)
  )
    throw failure();
  const parts = value.split("/");
  if (
    parts.length > 64 ||
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        part.length > 255 ||
        /[. ]$/.test(part) ||
        /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³]|CONIN\$|CONOUT\$|CLOCK\$)(?:\.|$)/i.test(
          part,
        ),
    )
  )
    throw failure();
  return value;
}
function binding(value) {
  if (
    !object(value) ||
    !own(value, "modId") ||
    typeof value.modId !== "string" ||
    !/^[1-9]\d{0,19}$/.test(value.modId) ||
    /\D/.test(value.modId) ||
    !own(value, "revision") ||
    typeof value.revision !== "string" ||
    !/^(?:0|[1-9]\d{0,19})$/.test(value.revision) ||
    /\D/.test(value.revision) ||
    !own(value, "archiveSha256") ||
    !sha256(value.archiveSha256)
  )
    throw failure();
  return {
    modId: value.modId,
    revision: value.revision,
    archiveSha256: value.archiveSha256,
  };
}
function validateReference(value) {
  exactKeys(value, ["version", "id", "sha256", "bytes"]);
  if (
    value.version !== 1 ||
    !uuid(value.id) ||
    !sha256(value.sha256) ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes < 1 ||
    value.bytes > LIMITS.indexBytes
  )
    throw failure();
  return {
    version: 1,
    id: value.id,
    sha256: value.sha256,
    bytes: value.bytes,
  };
}
function checkedEntries(files) {
  if (!Array.isArray(files) || !files.length || files.length > LIMITS.entries)
    throw failure("VALIDATION_LIMIT");
  const seen = new Set();
  let bytes = 0;
  const entries = files.map((entry) => {
    exactKeys(entry, ["relative", "bytes", "hash"]);
    const relative = relativeName(entry.relative),
      key = relative.toLowerCase();
    if (
      seen.has(key) ||
      !sha256(entry.hash) ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 0 ||
      entry.bytes > LIMITS.fileBytes
    )
      throw failure();
    seen.add(key);
    bytes += entry.bytes;
    if (bytes > LIMITS.totalBytes) throw failure("VALIDATION_LIMIT");
    return { relative, bytes: entry.bytes, hash: entry.hash };
  });
  for (const key of seen) {
    const parts = key.split("/");
    while (parts.length > 1) {
      parts.pop();
      if (seen.has(parts.join("/"))) throw failure();
    }
  }
  return entries.sort((a, b) =>
    a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0,
  );
}
function sourceSnapshot(input) {
  if (!object(input) || !own(input, "contentPath") || !own(input, "files"))
    throw failure();
  const selected = binding(input),
    contentPath = absolute(input.contentPath);
  if (
    !Array.isArray(input.files) ||
    !input.files.length ||
    input.files.length > LIMITS.entries
  )
    throw failure("VALIDATION_LIMIT");
  const files = input.files.map((file) => {
    if (
      !object(file) ||
      !own(file, "path") ||
      !own(file, "hash") ||
      !own(file, "identity") ||
      !sha256(file.hash) ||
      !validIdentity(file.identity)
    )
      throw failure();
    const target = absolute(file.path),
      relative = path.relative(contentPath, target).split(path.sep).join("/");
    relativeName(relative);
    return {
      path: target,
      relative,
      hash: file.hash,
      identity: identity(file.identity),
    };
  });
  checkedEntries(
    files.map((file) => ({
      relative: file.relative,
      bytes: 0,
      hash: file.hash,
    })),
  );
  return { ...selected, contentPath, files };
}
function recordSnapshot(value) {
  const selected = binding(value);
  if (
    !own(value, "contentPath") ||
    !own(value, "contentIdentity") ||
    !validIdentity(value.contentIdentity)
  )
    throw failure();
  return {
    ...selected,
    contentPath: absolute(value.contentPath),
    contentIdentity: identity(value.contentIdentity),
    integrity:
      value.integrity === undefined ? null : validateReference(value.integrity),
  };
}
async function optional(target) {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
async function lineage(directory, create = false) {
  const target = absolute(directory),
    parsed = path.parse(target);
  const parts = target
      .slice(parsed.root.length)
      .split(path.sep)
      .filter(Boolean),
    result = [];
  let current = parsed.root;
  for (const part of ["", ...parts]) {
    if (part) current = path.join(current, part);
    let stat = await optional(current);
    if (!stat && create) {
      try {
        await fs.mkdir(current);
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      stat = await fs.lstat(current);
    }
    if (
      !stat?.isDirectory() ||
      stat.isSymbolicLink() ||
      canonical(await fs.realpath(current)) !== canonical(current)
    )
      throw failure("CONTENT_CHANGED");
    result.push({ path: current, identity: identity(stat) });
  }
  return result;
}
async function assertLineage(entries) {
  for (const entry of entries) {
    const stat = await fs.lstat(entry.path);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      !same(stat, entry.identity) ||
      canonical(await fs.realpath(entry.path)) !== canonical(entry.path)
    )
      throw failure("CONTENT_CHANGED");
  }
}
async function digest(
  target,
  { expected, limit, signal, buffer, collect = false },
) {
  abort(signal);
  const parents = await lineage(path.dirname(target)),
    before = await fs.lstat(target);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    (expected && !same(before, expected)) ||
    before.size > limit
  )
    throw failure("CONTENT_CHANGED");
  const handle = await fs.open(
    target,
    constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
  );
  try {
    const opened = await handle.stat();
    if (
      !same(opened, before) ||
      opened.nlink !== 1 ||
      opened.size !== before.size
    )
      throw failure("CONTENT_CHANGED");
    await assertLineage(parents);
    const h = createHash("sha256"),
      chunks = [];
    let bytes = 0;
    while (true) {
      abort(signal);
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, limit - bytes + 1),
        null,
      );
      if (!bytesRead) break;
      bytes += bytesRead;
      if (bytes > limit) throw failure("CONTENT_CHANGED");
      h.update(buffer.subarray(0, bytesRead));
      if (collect) chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
    const after = await handle.stat(),
      atPath = await fs.lstat(target);
    if (
      !same(after, before) ||
      !same(atPath, before) ||
      !atPath.isFile() ||
      atPath.isSymbolicLink() ||
      after.nlink !== 1 ||
      atPath.nlink !== 1 ||
      bytes !== before.size ||
      after.size !== before.size ||
      atPath.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      atPath.mtimeMs !== before.mtimeMs ||
      atPath.ctimeMs !== before.ctimeMs
    )
      throw failure("CONTENT_CHANGED");
    await assertLineage(parents);
    abort(signal);
    return {
      hash: h.digest("hex"),
      bytes,
      stat: after,
      ...(collect ? { data: Buffer.concat(chunks, bytes) } : {}),
    };
  } finally {
    await handle.close();
  }
}
async function trustedEntries(source, signal, buffer) {
  const parents = await lineage(source.contentPath),
    entries = [];
  let total = 0;
  for (const file of source.files) {
    abort(signal);
    await assertLineage(parents);
    const result = await digest(file.path, {
      expected: file.identity,
      limit: Math.min(LIMITS.fileBytes, LIMITS.totalBytes - total),
      signal,
      buffer,
    });
    if (result.hash !== file.hash) throw failure("CONTENT_CHANGED");
    total += result.bytes;
    if (total > LIMITS.totalBytes) throw failure("VALIDATION_LIMIT");
    entries.push({
      relative: file.relative,
      bytes: result.bytes,
      hash: result.hash,
    });
  }
  await assertLineage(parents);
  return checkedEntries(entries);
}
function report(status = "intact", totalFiles = 0) {
  return {
    status,
    totalFiles,
    checkedFiles: 0,
    missingFiles: 0,
    changedFiles: 0,
    extraFiles: 0,
    unsafeFiles: 0,
    issues: [],
    issuesTruncated: false,
  };
}
const printedPath = (relative) =>
  relative.replace(/[\0-\x1f\x7f]/g, "�").slice(0, 1024);
async function compareTree(record, entries, signal, onProgress, buffer) {
  const result = report("intact", entries.length),
    expected = new Map(
      entries.map((entry) => [entry.relative.toLowerCase(), entry]),
    ),
    seen = new Set(),
    issues = new Set(),
    files = [],
    directories = [];
  let scanned = 0,
    lastProgressAt = -Infinity;
  const add = (kind, relative) => {
    const key = kind + ":" + relative.toLowerCase();
    if (issues.has(key)) return;
    issues.add(key);
    result[
      kind === "missing"
        ? "missingFiles"
        : kind === "changed"
          ? "changedFiles"
          : kind === "extra"
            ? "extraFiles"
            : "unsafeFiles"
    ]++;
    result.status = "damaged";
    if (result.issues.length < LIMITS.issues)
      result.issues.push({ path: printedPath(relative), kind });
    else result.issuesTruncated = true;
  };
  const progress = async (force = false) => {
    abort(signal);
    const time = Date.now();
    if (onProgress && (force || time - lastProgressAt >= 100)) {
      lastProgressAt = time;
      await onProgress({
        ...result,
        issues: result.issues.map((issue) => ({ ...issue })),
      });
    }
    abort(signal);
  };
  abort(signal);
  let parents;
  try {
    const current = await optional(record.contentPath);
    if (!current) {
      // Validate the surviving ancestors so a missing leaf behind a junction
      // is not mistaken for an ordinary missing installation.
      let ancestor = path.dirname(record.contentPath);
      while (!(await optional(ancestor))) {
        abort(signal);
        const parent = path.dirname(ancestor);
        if (parent === ancestor) throw failure("CONTENT_CHANGED");
        ancestor = parent;
      }
      await lineage(ancestor);
      for (const entry of entries) add("missing", entry.relative);
      await progress(true);
      return result;
    }
    parents = await lineage(record.contentPath);
    if (
      !same(current, record.contentIdentity) ||
      !same(parents.at(-1).identity, record.contentIdentity)
    )
      throw failure("CONTENT_CHANGED");
  } catch (error) {
    if (error.name === "AbortError") throw error;
    add("unsafe", ".");
    await progress(true);
    return result;
  }
  async function walk(directory, relative) {
    abort(signal);
    await assertLineage(parents);
    const before = await fs.lstat(directory);
    if (!before.isDirectory() || before.isSymbolicLink())
      throw failure("CONTENT_CHANGED");
    const snapshot = { path: directory, relative, stat: before };
    directories.push(snapshot);
    const stream = await fs.opendir(directory);
    for await (const item of stream) {
      abort(signal);
      if (++scanned > LIMITS.entries) throw failure("VALIDATION_LIMIT");
      const rel = relative ? relative + "/" + item.name : item.name,
        target = path.join(directory, item.name),
        key = rel.toLowerCase();
      try {
        relativeName(rel);
      } catch {
        add("unsafe", rel);
        continue;
      }
      let stat;
      try {
        stat = await fs.lstat(target);
      } catch {
        add("unsafe", rel);
        continue;
      }
      if (
        stat.isSymbolicLink() ||
        (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))
      ) {
        if (expected.has(key)) seen.add(key);
        add("unsafe", rel);
        await progress();
        continue;
      }
      if (stat.isDirectory()) {
        if (expected.has(key)) {
          seen.add(key);
          add("changed", rel);
        }
        await walk(target, rel);
        continue;
      }
      const entry = expected.get(key);
      if (!entry) {
        add("extra", rel);
        await progress();
        continue;
      }
      if (seen.has(key)) {
        add("unsafe", rel);
        await progress();
        continue;
      }
      seen.add(key);
      result.checkedFiles++;
      if (stat.size !== entry.bytes) add("changed", rel);
      else {
        try {
          const current = await digest(target, {
            expected: identity(stat),
            limit: entry.bytes,
            signal,
            buffer,
          });
          if (current.hash !== entry.hash) add("changed", rel);
          files.push({ path: target, relative: rel, stat: current.stat });
        } catch (error) {
          if (error.name === "AbortError") throw error;
          add("unsafe", rel);
        }
      }
      await progress();
    }
  }
  try {
    await walk(record.contentPath, "");
  } catch (error) {
    if (error.name === "AbortError" || error.code === "VALIDATION_LIMIT")
      throw error;
    add("unsafe", ".");
  }
  for (const entry of entries)
    if (!seen.has(entry.relative.toLowerCase())) add("missing", entry.relative);
  await progress(true);
  // A file checked near the beginning must still belong to the same stable
  // tree when the operation finishes. Callbacks run before these final guards.
  try {
    await assertLineage(parents);
  } catch {
    add("unsafe", ".");
  }
  for (const entry of directories) {
    abort(signal);
    try {
      const current = await fs.lstat(entry.path);
      if (
        !same(current, entry.stat) ||
        !current.isDirectory() ||
        current.isSymbolicLink() ||
        current.mtimeMs !== entry.stat.mtimeMs ||
        current.ctimeMs !== entry.stat.ctimeMs
      )
        add("unsafe", entry.relative || ".");
    } catch {
      add("unsafe", entry.relative || ".");
    }
  }
  for (const entry of files) {
    abort(signal);
    try {
      const current = await fs.lstat(entry.path);
      if (
        !same(current, entry.stat) ||
        !current.isFile() ||
        current.isSymbolicLink() ||
        current.nlink !== 1 ||
        current.size !== entry.stat.size ||
        current.mtimeMs !== entry.stat.mtimeMs ||
        current.ctimeMs !== entry.stat.ctimeMs
      )
        add("unsafe", entry.relative);
    } catch {
      add("unsafe", entry.relative);
    }
  }
  abort(signal);
  return result;
}

function createPdxFileIntegrity({ storageDirectory } = {}) {
  // Resolve configuration only. Construction creates no files or directories.
  const root = absolute(storageDirectory),
    indexRoot = path.join(root, "indexes");
  return Object.freeze({
    validateReference,
    async create(input = {}) {
      const source = sourceSnapshot(input),
        signal = input.signal,
        buffer = Buffer.allocUnsafe(1024 * 1024);
      const entries = await trustedEntries(source, signal, buffer),
        bytes = Buffer.from(
          JSON.stringify({ version: 1, ...binding(source), files: entries }),
        );
      if (bytes.length > LIMITS.indexBytes) throw failure("VALIDATION_LIMIT");
      abort(signal);
      const parents = await lineage(indexRoot, true),
        id = randomUUID(),
        target = path.join(indexRoot, id + ".json");
      await assertLineage(parents);
      const handle = await fs.open(target, "wx"),
        ownIdentity = identity(await handle.stat());
      try {
        await handle.writeFile(bytes);
        await handle.sync();
        abort(signal);
        await assertLineage(parents);
        const current = await fs.lstat(target);
        if (
          !same(current, ownIdentity) ||
          !current.isFile() ||
          current.isSymbolicLink() ||
          current.nlink !== 1
        )
          throw failure("CONTENT_CHANGED");
      } finally {
        await handle.close();
      }
      const check = await digest(target, {
        expected: ownIdentity,
        limit: bytes.length,
        signal,
        buffer,
      });
      if (check.hash !== hash(bytes)) throw failure("CONTENT_CHANGED");
      return { version: 1, id, sha256: check.hash, bytes: check.bytes };
    },
    async verify({ record, signal, onProgress } = {}) {
      abort(signal);
      let selected;
      try {
        selected = recordSnapshot(record);
      } catch {
        return { ...report("unverified"), baselineReason: "invalid-reference" };
      }
      if (!selected.integrity)
        return { ...report("unverified"), baselineReason: "missing-reference" };
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      let entries;
      try {
        const ref = selected.integrity,
          target = path.join(indexRoot, ref.id + ".json"),
          bytes = await digest(target, {
            limit: ref.bytes,
            signal,
            buffer,
            collect: true,
          });
        if (bytes.bytes !== ref.bytes || bytes.hash !== ref.sha256)
          throw failure();
        const index = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(bytes.data),
        );
        exactKeys(index, [
          "version",
          "modId",
          "revision",
          "archiveSha256",
          "files",
        ]);
        if (
          index.version !== 1 ||
          JSON.stringify(binding(index)) !== JSON.stringify(binding(selected))
        )
          throw failure();
        entries = checkedEntries(index.files);
      } catch (error) {
        if (error.name === "AbortError") throw error;
        return {
          ...report("unverified"),
          baselineReason:
            error.code === "ENOENT" ? "missing-index" : "invalid-index",
        };
      }
      return compareTree(selected, entries, signal, onProgress, buffer);
    },
    async compare({ record, contentPath, files, signal, onProgress } = {}) {
      const selected = recordSnapshot({ ...record, integrity: undefined }),
        source = sourceSnapshot({ ...binding(selected), contentPath, files }),
        buffer = Buffer.allocUnsafe(1024 * 1024),
        entries = await trustedEntries(source, signal, buffer);
      return compareTree(selected, entries, signal, onProgress, buffer);
    },
  });
}

module.exports = { createPdxFileIntegrity };
