"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const {
  MAX_MEMORY_BYTES,
  memoryBudget,
  limitMemory,
} = require("./vendor/xz/memory-limit.cjs");

const MAX_SECTION_BYTES = 64 * 1024 ** 2;
const BUFFER_BYTES = 65536;
const KINDS = new Set(["data", "instructions", "addresses"]);
const tick = () => new Promise((resolve) => setImmediate(resolve));
function failure(code = "PATCH_INVALID") {
  return Object.assign(
    new Error(
      code === "CANCELLED"
        ? "增量补丁解压已取消。"
        : code === "PATCH_RESOURCE_LIMIT"
          ? "增量补丁解压超过安全限制，请使用完整包。"
          : "增量补丁压缩内容无效，请使用完整包。",
    ),
    { code, ...(code === "CANCELLED" ? { name: "AbortError" } : {}) },
  );
}

async function createXzSections(options = {}) {
  let api;
  let stopped;
  let busy = false;
  const contexts = new Map();
  let signal;
  let maxMemoryBytes;
  let maxDecodedBytes;

  function disposeWith(error = failure()) {
    if (!stopped) stopped = error;
    try {
      signal?.removeEventListener("abort", onAbort);
    } catch {
      // Cleanup cannot replace a fixed decoder error with a caller exception.
    }
    if (api) {
      for (const context of contexts.values()) {
        try {
          api.destroy_context(context.pointer);
        } catch {
          // The entire isolated instance is discarded even after an OOM trap.
        }
      }
    }
    contexts.clear();
    api = undefined;
  }
  function onAbort() {
    disposeWith(failure("CANCELLED"));
  }
  function guard() {
    if (signal?.aborted) onAbort();
    if (stopped) throw stopped;
  }

  try {
    if (!options || typeof options !== "object" || Array.isArray(options))
      throw failure();
    maxMemoryBytes = options.maxMemoryBytes ?? MAX_MEMORY_BYTES;
    maxDecodedBytes = options.maxDecodedBytes ?? MAX_SECTION_BYTES;
    signal = options.signal;
    memoryBudget(maxMemoryBytes);
    if (
      !Number.isSafeInteger(maxDecodedBytes) ||
      maxDecodedBytes < 1 ||
      maxDecodedBytes > MAX_SECTION_BYTES
    )
      throw failure("PATCH_RESOURCE_LIMIT");
    if (
      signal !== undefined &&
      (!signal ||
        typeof signal.aborted !== "boolean" ||
        typeof signal.addEventListener !== "function" ||
        typeof signal.removeEventListener !== "function")
    )
      throw failure();
    guard();
    signal?.addEventListener("abort", onAbort, { once: true });
    const upstream = await fs.readFile(
      path.join(__dirname, "vendor", "xz", "xz-decompress.upstream.wasm"),
    );
    guard();
    const bytes = limitMemory(upstream, maxMemoryBytes);
    const module = await WebAssembly.compile(bytes);
    guard();
    if (WebAssembly.Module.imports(module).length !== 0) throw failure();
    const instance = await WebAssembly.instantiate(module, {});
    guard();
    api = instance.exports;
    for (const kind of KINDS) {
      guard();
      const pointer = api.create_context();
      if (!Number.isSafeInteger(pointer) || pointer <= 0)
        throw failure("PATCH_RESOURCE_LIMIT");
      contexts.set(kind, { pointer, ended: false });
      fields(contexts.get(kind));
    }
  } catch (error) {
    const safe = stopped || normalize(error);
    disposeWith(safe);
    throw safe;
  }

  function normalize(error) {
    if (
      ["PATCH_INVALID", "PATCH_RESOURCE_LIMIT", "CANCELLED"].includes(
        error?.code,
      )
    )
      return failure(error.code);
    return failure(
      error instanceof WebAssembly.RuntimeError || error instanceof RangeError
        ? "PATCH_RESOURCE_LIMIT"
        : "PATCH_INVALID",
    );
  }

  function fields(context) {
    const memory = api.memory.buffer;
    if (
      memory.byteLength > maxMemoryBytes ||
      context.pointer % 4 !== 0 ||
      context.pointer + 32 > memory.byteLength
    )
      throw failure("PATCH_RESOURCE_LIMIT");
    const values = new Uint32Array(memory, context.pointer, 8);
    if (values[7] === 0) throw failure("PATCH_RESOURCE_LIMIT");
    if (
      values[0] !== BUFFER_BYTES ||
      values[1] !== context.pointer + 32 ||
      values[1] + BUFFER_BYTES > memory.byteLength ||
      values[4] !== context.pointer + 32 + BUFFER_BYTES ||
      values[4] + BUFFER_BYTES > memory.byteLength ||
      values[2] > values[3] ||
      values[3] > BUFFER_BYTES ||
      values[5] > BUFFER_BYTES ||
      values[6] !== BUFFER_BYTES
    )
      throw failure();
    return values;
  }

  async function decode(kind, inputBuffer, expectedBytes) {
    try {
      guard();
      if (
        busy ||
        !KINDS.has(kind) ||
        !Buffer.isBuffer(inputBuffer) ||
        inputBuffer.length === 0 ||
        !Number.isSafeInteger(expectedBytes) ||
        expectedBytes < 1
      )
        throw failure();
      if (
        inputBuffer.length > MAX_SECTION_BYTES ||
        expectedBytes > maxDecodedBytes
      )
        throw failure("PATCH_RESOURCE_LIMIT");
      const context = contexts.get(kind);
      if (context.ended) throw failure();
      busy = true;
      // Snapshot before yielding: a caller cannot mutate a future input chunk.
      const input = Buffer.from(inputBuffer);
      const output = Buffer.allocUnsafe(expectedBytes);
      let position = 0;
      let written = 0;
      let iterations = 0;
      const maxIterations =
        Math.ceil(input.length / BUFFER_BYTES) +
        Math.ceil(expectedBytes / BUFFER_BYTES) +
        16;
      await tick();
      guard();
      while (position < input.length) {
        let view = fields(context);
        if (view[2] !== view[3] || view[5] !== 0) throw failure();
        const count = Math.min(BUFFER_BYTES, input.length - position);
        new Uint8Array(api.memory.buffer, view[1], count).set(
          input.subarray(position, position + count),
        );
        api.supply_input(context.pointer, count);
        position += count;
        let drain;
        do {
          guard();
          if (++iterations > maxIterations)
            throw failure("PATCH_RESOURCE_LIMIT");
          view = fields(context);
          const previous = view[2];
          const status = api.get_next_output(context.pointer);
          view = fields(context);
          if (status === 3 || status === 4)
            throw failure("PATCH_RESOURCE_LIMIT");
          if (status !== 0 && status !== 1) throw failure();
          const produced = view[5];
          if (produced > expectedBytes - written) throw failure();
          output.set(
            new Uint8Array(api.memory.buffer, view[4], produced),
            written,
          );
          written += produced;
          view[5] = 0;
          const consumed = view[2];
          const remaining = consumed < view[3];
          if (status === 1) {
            if (remaining || position !== input.length) throw failure();
            context.ended = true;
            drain = false;
          } else {
            if (consumed === previous && produced === 0 && remaining)
              throw failure();
            drain = remaining || produced === BUFFER_BYTES;
          }
          if (iterations % 4 === 0) {
            await tick();
            guard();
          }
        } while (drain);
      }
      guard();
      if (written !== expectedBytes) throw failure();
      return output;
    } catch (error) {
      const safe = stopped || normalize(error);
      disposeWith(safe);
      throw safe;
    } finally {
      busy = false;
    }
  }

  return Object.freeze({ decode, dispose: () => disposeWith() });
}

module.exports = { createXzSections };
