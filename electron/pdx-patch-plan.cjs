"use strict";

const {
  normalizePdxPatchPath,
  pdxPatchPathKey,
} = require("./pdx-patch-path.cjs");
const MAX_FILE = 5 * 1024 ** 3;
const MAX_TOTAL = 20 * 1024 ** 3;
const MAX_ENTRIES = 100000;
const MAX_OPERATIONS_BYTES = 8 * 1024 ** 2;
const EMPTY_HASH =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const MESSAGES = {
  INVALID_INPUT: "Paradox 下载参数无效。",
  PATCH_INVALID: "模组补丁归档无效，请使用完整包。",
  PATCH_UNSUPPORTED: "模组补丁操作不受支持，请使用完整包。",
  PATCH_RESOURCE_LIMIT: "模组补丁超过允许大小，请使用完整包。",
  SOURCE_CHANGED: "续传源文件或所在目录已变化，请重新下载。",
  HASH_MISMATCH: "下载文件校验失败，请重新下载。",
};
const fail = (code) => Object.assign(new Error(MESSAGES[code]), { code });
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const hash = (value) =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const size = (value, max) =>
  Number.isSafeInteger(value) && value >= 0 && value <= max;
function safePath(value, directory = false) {
  try {
    return normalizePdxPatchPath(value, { directory });
  } catch {
    throw fail("PATCH_INVALID");
  }
}

// This parses metadata only. It cannot grant filesystem access or signature trust.
function parsePdxPatchOperations(input) {
  if (!Buffer.isBuffer(input) && typeof input !== "string")
    throw fail("INVALID_INPUT");
  if (
    (Buffer.isBuffer(input) ? input.length : Buffer.byteLength(input, "utf8")) >
    MAX_OPERATIONS_BYTES
  )
    throw fail("PATCH_RESOURCE_LIMIT");
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      Buffer.isBuffer(input) ? Buffer.from(input) : Buffer.from(input, "utf8"),
    );
  } catch {
    throw fail("PATCH_INVALID");
  }
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length > MAX_ENTRIES) throw fail("PATCH_RESOURCE_LIMIT");
  const operations = lines.map((raw) => {
    if (Buffer.byteLength(raw, "utf8") >= 65536)
      throw fail("PATCH_RESOURCE_LIMIT");
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const parts = line.split(": ");
    if (parts.length !== 2) throw fail("PATCH_INVALID");
    const type = parts[0].replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");
    if (!["c", "d", "k", "n", "p", "s"].includes(type))
      throw fail("PATCH_UNSUPPORTED");
    return Object.freeze({
      type,
      path: safePath(parts[1], type === "c" || type === "d"),
    });
  });
  return Object.freeze(operations);
}

function namespace(input) {
  if (!Array.isArray(input)) throw fail("INVALID_INPUT");
  if (input.length > MAX_ENTRIES) throw fail("PATCH_RESOURCE_LIMIT");
  const entries = [],
    nodes = new Map();
  let total = 0;
  for (const value of input) {
    if (
      !object(value) ||
      !["file", "directory", "symlink"].includes(value.type)
    )
      throw fail("INVALID_INPUT");
    const directory = value.type === "directory",
      name = safePath(value.path, directory);
    if (
      !size(value.bytes, MAX_FILE) ||
      (value.type !== "file" && value.bytes !== 0) ||
      (directory ? value.sha256 !== "" : !hash(value.sha256))
    )
      throw fail("INVALID_INPUT");
    total += value.bytes;
    if (total > MAX_TOTAL) throw fail("PATCH_RESOURCE_LIMIT");
    const entry = Object.freeze({
      path: name,
      type: value.type,
      bytes: value.bytes,
      sha256: value.sha256,
    });
    const parts = name.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const current = parts.slice(0, i).join("/"),
        key = pdxPatchPathKey(current),
        leaf = i === parts.length;
      const previous = nodes.get(key),
        kind = leaf ? value.type : "directory";
      if (
        previous &&
        (previous.path !== current ||
          previous.type !== kind ||
          (leaf && previous.explicit))
      )
        throw fail("PATCH_INVALID");
      nodes.set(
        key,
        Object.freeze({
          path: current,
          type: kind,
          explicit: Boolean(previous?.explicit || leaf),
          entry: leaf ? entry : previous?.entry,
        }),
      );
      if (nodes.size > MAX_ENTRIES) throw fail("PATCH_RESOURCE_LIMIT");
    }
    entries.push(entry);
  }
  function find(name) {
    const node = nodes.get(pdxPatchPathKey(name));
    if (node && node.path !== name) throw fail("PATCH_INVALID");
    return node;
  }
  return { entries, nodes, find };
}

function createPdxPatchPlan({
  operations,
  targets,
  sources = [],
  payloads = [],
} = {}) {
  const parsed = parsePdxPatchOperations(operations),
    target = namespace(targets),
    source = namespace(sources);
  if (!Array.isArray(payloads)) throw fail("INVALID_INPUT");
  if (payloads.length > MAX_ENTRIES) throw fail("PATCH_RESOURCE_LIMIT");
  const payloadMap = new Map(),
    payloadKeys = new Set();
  let payloadBytes = 0;
  for (const value of payloads) {
    if (!object(value) || !size(value.bytes, MAX_FILE))
      throw fail("INVALID_INPUT");
    const name = safePath(value.path),
      key = pdxPatchPathKey(name);
    if (name === "operations" || payloadKeys.has(key))
      throw fail("PATCH_INVALID");
    payloadKeys.add(key);
    payloadMap.set(name, Object.freeze({ path: name, bytes: value.bytes }));
    if ((payloadBytes += value.bytes) > MAX_TOTAL)
      throw fail("PATCH_RESOURCE_LIMIT");
  }
  const deletes = [],
    actions = [],
    writers = new Set(),
    deleted = new Set(),
    usedPayloads = new Set(),
    explicitDirectories = new Set();
  function oldFor(entry) {
    const old = source.find(entry.path)?.entry;
    if (!old || old.type !== entry.type) throw fail("SOURCE_CHANGED");
    return old;
  }
  function unchanged(entry) {
    const old = oldFor(entry);
    if (old.bytes !== entry.bytes || old.sha256 !== entry.sha256)
      throw fail("SOURCE_CHANGED");
    return old;
  }
  for (const operation of parsed) {
    const { type, path: name } = operation;
    if (type === "d") {
      const old = source.find(name) || target.find(name);
      if (!old || deleted.has(name)) throw fail("PATCH_INVALID");
      deleted.add(name);
      deletes.push(
        Object.freeze({ type, path: name, directoryPolicy: "empty-only" }),
      );
      continue;
    }
    const node = target.find(name);
    if (!node) throw fail("PATCH_INVALID");
    if (type === "c") {
      if (node.type !== "directory") throw fail("PATCH_INVALID");
      explicitDirectories.add(name);
      continue; // All required directories are enumerated once below.
    }
    const entry = node.entry;
    if (
      !entry ||
      entry.type === "directory" ||
      writers.has(name) ||
      ((type === "n" || type === "p") && entry.type !== "file") ||
      (type === "s" && entry.type !== "symlink")
    )
      throw fail("PATCH_INVALID");
    writers.add(name);
    const action = { type, path: name, implicit: false, target: entry };
    if (type === "k") action.source = unchanged(entry);
    if (type === "p") {
      const old = source.find(entry.path)?.entry;
      if (old?.type === "symlink") throw fail("PATCH_UNSUPPORTED");
      action.source =
        old?.type === "file"
          ? old
          : Object.freeze({
              path: null,
              type: "file",
              bytes: 0,
              sha256: EMPTY_HASH,
            });
    }
    if (["n", "p", "s"].includes(type)) {
      const payloadName = type === "p" ? name + ".vcdiff" : name;
      const payload = payloadMap.get(payloadName);
      if (!payload) throw fail("PATCH_INVALID");
      if (type === "n" && payload.bytes !== entry.bytes)
        throw fail("HASH_MISMATCH");
      if (type === "p" && payload.bytes === 0) throw fail("PATCH_INVALID");
      if (type === "s" && (payload.bytes === 0 || payload.bytes > 4096))
        throw fail("PATCH_RESOURCE_LIMIT");
      action.payload = payload;
      usedPayloads.add(payloadName);
    }
    actions.push(Object.freeze(action));
  }
  for (const entry of target.entries) {
    if (entry.type === "directory" || writers.has(entry.path)) continue;
    actions.push(
      Object.freeze({
        type: "k",
        path: entry.path,
        implicit: true,
        target: entry,
        source: unchanged(entry),
      }),
    );
  }
  if (usedPayloads.size !== payloadMap.size) throw fail("PATCH_UNSUPPORTED");
  const directories = [...target.nodes.values()]
    .filter((node) => node.type === "directory")
    .map((node) =>
      Object.freeze({
        type: "c",
        path: node.path,
        implicit: !explicitDirectories.has(node.path),
      }),
    );
  directories.sort(
    (a, b) =>
      a.path.split("/").length - b.path.split("/").length ||
      a.path.localeCompare(b.path, "en"),
  );
  return Object.freeze({
    deletes: Object.freeze(deletes),
    directories: Object.freeze(directories),
    actions: Object.freeze(actions),
    operationCount: parsed.length,
  });
}

module.exports = { parsePdxPatchOperations, createPdxPatchPlan };
