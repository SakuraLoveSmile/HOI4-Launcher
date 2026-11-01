"use strict";

const {
  normalizePdxPatchPath,
  pdxPatchPathKey,
} = require("./pdx-patch-path.cjs");

const DEFAULTS = Object.freeze({
  maxBytes: 16 * 1024 * 1024,
  maxEntries: 100000,
  maxFileBytes: 5 * 1024 * 1024 * 1024,
  maxTotalBytes: 20 * 1024 * 1024 * 1024,
});
const MAX_LINE_BYTES = 64 * 1024;
const MESSAGES = Object.freeze({
  INVALID_MANIFEST: "模组下载清单格式不受支持。",
  RESPONSE_TOO_LARGE: "模组下载清单或内容超过允许大小。",
});

function failure(code = "INVALID_MANIFEST") {
  const error = new Error(MESSAGES[code]);
  error.code = code;
  return error;
}

function optionsOf(options) {
  if (!options || typeof options !== "object" || Array.isArray(options))
    throw failure();
  const limits = {};
  for (const [key, fallback] of Object.entries(DEFAULTS)) {
    const value = options[key] === undefined ? fallback : options[key];
    if (!Number.isSafeInteger(value) || value < (key === "maxBytes" ? 1 : 0))
      throw failure();
    limits[key] = value;
  }
  if (
    options.expectedName !== undefined &&
    (typeof options.expectedName !== "string" || !options.expectedName.length)
  )
    throw failure();
  return limits;
}

function snapshotText(input, maxBytes) {
  if (!Buffer.isBuffer(input) && typeof input !== "string") throw failure();
  if (typeof input === "string") {
    // Buffer.from replaces unpaired UTF-16 surrogates; reject them before encoding.
    for (const character of input) {
      const point = character.codePointAt(0);
      if (point >= 0xd800 && point <= 0xdfff) throw failure();
    }
  }
  if (
    (typeof input === "string"
      ? Buffer.byteLength(input, "utf8")
      : input.length) > maxBytes
  )
    throw failure("RESPONSE_TOO_LARGE");
  const bytes = Buffer.from(input);
  try {
    if (
      bytes.length >= 3 &&
      bytes[0] === 0xef &&
      bytes[1] === 0xbb &&
      bytes[2] === 0xbf
    )
      throw failure();
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw failure();
  }
}

function csvRow(line) {
  const fields = [];
  let index = 0;
  while (true) {
    let value = "";
    if (line[index] === '"') {
      index++;
      let closed = false;
      while (index < line.length) {
        const character = line[index++];
        if (character !== '"') value += character;
        else if (line[index] === '"') {
          value += '"';
          index++;
        } else {
          closed = true;
          break;
        }
      }
      if (!closed || (index < line.length && line[index] !== ","))
        throw failure();
    } else {
      const start = index;
      while (index < line.length && line[index] !== ",") {
        if (line[index] === '"') throw failure();
        index++;
      }
      value = line.slice(start, index);
    }
    fields.push(value);
    if (fields.length > 6) throw failure();
    if (index === line.length) return fields;
    index++;
  }
}

function sizeOf(text, maximum) {
  const value = text.trim();
  if (!/^(?:0|[1-9]\d{0,15})$/.test(value)) throw failure();
  const size = Number(value);
  if (!Number.isSafeInteger(size)) throw failure();
  if (size > maximum) throw failure("RESPONSE_TOO_LARGE");
  return size;
}

function digestOf(text) {
  const value = text.trim();
  // Retain the existing content service's support for either canonical alphabet.
  if (!/^(?:[A-Za-z0-9+/]{43}|[A-Za-z0-9_-]{43})=$/.test(value))
    throw failure();
  const digest = Buffer.from(
    value.replace(/-/g, "+").replace(/_/g, "/"),
    "base64",
  );
  if (
    digest.length !== 32 ||
    (digest.toString("base64") !== value &&
      `${digest.toString("base64url")}=` !== value)
  )
    throw failure();
  return digest.toString("hex");
}

function entryOf(line, maxFileBytes) {
  const fields = csvRow(line);
  if (fields.length !== 4 && fields.length !== 6) throw failure();
  const flags = fields[3].trim();
  if (!/^[drwxcs]*$/.test(flags)) throw failure();
  const compressed = flags.includes("c");
  if (fields.length !== (compressed ? 6 : 4)) throw failure();
  const directory = flags.includes("d");
  const symlink = flags.includes("s");
  if (directory && (symlink || compressed)) throw failure();
  let entryPath;
  try {
    entryPath = normalizePdxPatchPath(fields[0], { directory });
  } catch {
    throw failure();
  }
  const bytes = sizeOf(fields[1], maxFileBytes);
  if ((directory || symlink) && bytes !== 0) throw failure();
  if (directory && fields[2].trim() !== "") throw failure();
  const entry = {
    path: entryPath,
    type: directory ? "directory" : symlink ? "symlink" : "file",
    bytes,
    sha256: directory ? "" : digestOf(fields[2]),
    flags,
  };
  if (compressed) {
    entry.unpackedBytes = sizeOf(fields[4], maxFileBytes);
    entry.compression = fields[5].trim();
    if (/[\x00-\x1f\x7f\ufffd]/u.test(entry.compression)) throw failure();
  }
  return Object.freeze(entry);
}

function validateTree(entries) {
  // A NUL separator keeps a complete subtree adjacent without constructing a
  // separate map entry for every implicit ancestor of every manifest path.
  const ordered = entries
    .map((entry) => ({
      entry,
      parts: entry.path.split("/"),
      keys: pdxPatchPathKey(entry.path).split("/"),
      order: pdxPatchPathKey(entry.path).replaceAll("/", "\0"),
    }))
    .sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0));
  for (let index = 1; index < ordered.length; index++) {
    const prior = ordered[index - 1];
    const current = ordered[index];
    let common = 0;
    while (
      common < prior.keys.length &&
      common < current.keys.length &&
      prior.keys[common] === current.keys[common]
    ) {
      if (prior.parts[common] !== current.parts[common]) throw failure();
      common++;
    }
    if (common === prior.keys.length) {
      if (common === current.keys.length || prior.entry.type !== "directory")
        throw failure();
    }
  }
}

function parsePdxManifest(input, options = {}) {
  const limits = optionsOf(options);
  const text = snapshotText(input, limits.maxBytes);
  const entries = [];
  const headers = new Map();
  let content = false;
  let packedTotal = 0;
  let unpackedTotal = 0;
  for (let line of text.split("\n")) {
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES)
      throw failure("RESPONSE_TOO_LARGE");
    if (/[\x00-\x08\x0b-\x1f\x7f]/u.test(line)) throw failure();
    if (!line.trim()) {
      content = true;
      continue;
    }
    if (!content) {
      const parts = line.split(":");
      if (parts.length !== 2) throw failure();
      const name = parts[0].trim();
      const value = parts[1].trim();
      if (
        !["Name", "Hash"].includes(name) ||
        headers.has(name) ||
        !value ||
        /[\x00-\x1f\x7f\ufffd]/u.test(value)
      )
        throw failure();
      headers.set(name, value);
      continue;
    }
    if (entries.length >= limits.maxEntries)
      throw failure("RESPONSE_TOO_LARGE");
    const entry = entryOf(line, limits.maxFileBytes);
    if (
      entry.bytes > limits.maxTotalBytes - packedTotal ||
      (entry.unpackedBytes ?? entry.bytes) >
        limits.maxTotalBytes - unpackedTotal
    )
      throw failure("RESPONSE_TOO_LARGE");
    packedTotal += entry.bytes;
    unpackedTotal += entry.unpackedBytes ?? entry.bytes;
    entries.push(entry);
  }
  if (
    !headers.has("Name") ||
    headers.get("Hash") !== "sha256" ||
    !content ||
    (options.expectedName !== undefined &&
      headers.get("Name") !== options.expectedName)
  )
    throw failure();
  validateTree(entries);
  return Object.freeze({
    name: headers.get("Name"),
    hashAlgorithm: "sha256",
    entries: Object.freeze(entries),
  });
}

module.exports = { parsePdxManifest };
