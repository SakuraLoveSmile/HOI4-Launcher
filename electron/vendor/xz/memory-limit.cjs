"use strict";

const { createHash } = require("node:crypto");

const PAGE_BYTES = 65536;
const MAX_MEMORY_BYTES = 64 * 1024 ** 2;
const UPSTREAM_BYTES = 12558;
const UPSTREAM_SHA256 =
  "eb37d130fd379597765e87a044b243fb6ac6d0870ea468374003b9d4c2bee0e4";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const invalid = () =>
  Object.assign(new Error("增量补丁解压内核无效。"), { code: "PATCH_INVALID" });
const resource = () =>
  Object.assign(new Error("增量补丁解压超过安全限制。"), {
    code: "PATCH_RESOURCE_LIMIT",
  });

function memoryBudget(bytes) {
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes % PAGE_BYTES !== 0)
    throw invalid();
  if (bytes < 2 * PAGE_BYTES || bytes > MAX_MEMORY_BYTES) throw resource();
  return bytes;
}

function readUnsigned(bytes, offset, end) {
  let value = 0;
  for (let index = 0; index < 5; index++) {
    if (offset >= end) throw invalid();
    const byte = bytes[offset++];
    value += (byte & 127) * 2 ** (7 * index);
    if (value > 0xffffffff) throw invalid();
    if (!(byte & 128)) {
      if (index > 0 && byte === 0) throw invalid();
      return { value, offset };
    }
  }
  throw invalid();
}

function unsigned(value) {
  const bytes = [];
  do {
    const next = value % 128;
    value = Math.floor(value / 128);
    bytes.push(next | (value > 0 ? 128 : 0));
  } while (value > 0);
  return Buffer.from(bytes);
}

// Only the pinned, unmodified upstream module is accepted. All sections except
// its single memory declaration remain byte-for-byte unchanged.
function limitMemory(upstream, maxMemoryBytes = MAX_MEMORY_BYTES) {
  memoryBudget(maxMemoryBytes);
  if (
    !Buffer.isBuffer(upstream) ||
    upstream.length !== UPSTREAM_BYTES ||
    digest(upstream) !== UPSTREAM_SHA256 ||
    upstream.subarray(0, 8).toString("hex") !== "0061736d01000000"
  )
    throw invalid();

  let offset = 8;
  let memory;
  const seen = new Set();
  while (offset < upstream.length) {
    const start = offset;
    const id = upstream[offset++];
    if (id > 12 || (id !== 0 && seen.has(id))) throw invalid();
    if (id !== 0) seen.add(id);
    const size = readUnsigned(upstream, offset, upstream.length);
    const end = size.offset + size.value;
    if (end > upstream.length) throw invalid();
    if (id === 5) {
      const count = readUnsigned(upstream, size.offset, end);
      const flags = readUnsigned(upstream, count.offset, end);
      const minimum = readUnsigned(upstream, flags.offset, end);
      if (
        memory ||
        count.value !== 1 ||
        flags.value !== 0 ||
        minimum.value !== 2 ||
        minimum.offset !== end
      )
        throw invalid();
      memory = { start, end, minimum: minimum.value };
    }
    offset = end;
  }
  if (!memory || offset !== upstream.length) throw invalid();
  const payload = Buffer.concat([
    Buffer.from([1, 1]), // one unshared wasm32 memory with an explicit maximum
    unsigned(memory.minimum),
    unsigned(maxMemoryBytes / PAGE_BYTES),
  ]);
  return Buffer.concat([
    upstream.subarray(0, memory.start),
    Buffer.from([5]),
    unsigned(payload.length),
    payload,
    upstream.subarray(memory.end),
  ]);
}

module.exports = {
  PAGE_BYTES,
  MAX_MEMORY_BYTES,
  UPSTREAM_BYTES,
  UPSTREAM_SHA256,
  memoryBudget,
  limitMemory,
};
