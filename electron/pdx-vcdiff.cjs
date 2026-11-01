"use strict";

const { createHash } = require("node:crypto");
const { setImmediate: yieldTurn } = require("node:timers/promises");

const BLOCK = 64 * 1024;
const GIB = 1024 ** 3;
const HARD_LIMITS = Object.freeze({
  maxArchiveBytes: 5 * GIB,
  maxPatchBytes: 5 * GIB,
  maxWindowBytes: 64 * 1024 ** 2,
  maxEncodedSectionBytes: 64 * 1024 ** 2,
  maxDecodedSectionBytes: 64 * 1024 ** 2,
  maxWindows: 100000,
  maxInstructions: 10000000,
  maxApplicationHeaderBytes: 64 * 1024,
  maxWasmMemoryBytes: 64 * 1024 ** 2,
});
const SAFE = Symbol("vcdiff-error");
const MESSAGES = {
  INVALID_INPUT: "Paradox 下载参数无效。",
  PATCH_INVALID: "模组下载清单格式不受支持。",
  PATCH_UNSUPPORTED: "模组下载清单格式不受支持。",
  PATCH_RESOURCE_LIMIT: "模组信息或下载文件超过允许大小。",
  HASH_MISMATCH: "下载文件校验失败，请重新下载。",
  CANCELLED: "模组下载已取消。",
  SOURCE_CHANGED: "续传源文件或所在目录已变化，请重新下载。",
  FILE_ERROR: "无法写入模组下载文件，请检查磁盘空间和目录权限。",
};
const failure = (code) =>
  Object.assign(new Error(MESSAGES[code]), { code, [SAFE]: true });
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const hashString = (value) =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const size = (value, maximum, zero = false) =>
  Number.isSafeInteger(value) && value >= (zero ? 0 : 1) && value <= maximum;

// RFC 3284 default code table. A custom table is rejected before target IO.
function defaultTable() {
  const table = [[{ type: "run", size: 0 }], [{ type: "add", size: 0 }]];
  for (let length = 1; length <= 17; length++)
    table.push([{ type: "add", size: length }]);
  for (let mode = 0; mode < 9; mode++) {
    table.push([{ type: "copy", size: 0, mode }]);
    for (let length = 4; length <= 18; length++)
      table.push([{ type: "copy", size: length, mode }]);
  }
  for (let mode = 0; mode < 6; mode++)
    for (let add = 1; add <= 4; add++)
      for (let copy = 4; copy <= 6; copy++)
        table.push([
          { type: "add", size: add },
          { type: "copy", size: copy, mode },
        ]);
  for (let mode = 6; mode < 9; mode++)
    for (let add = 1; add <= 4; add++)
      table.push([
        { type: "add", size: add },
        { type: "copy", size: 4, mode },
      ]);
  for (let mode = 0; mode < 9; mode++)
    table.push([
      { type: "copy", size: 4, mode },
      { type: "add", size: 1 },
    ]);
  return table;
}
const TABLE = defaultTable();

function cursor(bytes) {
  let position = 0;
  return {
    get position() {
      return position;
    },
    get remaining() {
      return bytes.length - position;
    },
    byte() {
      if (position >= bytes.length) throw failure("PATCH_INVALID");
      return bytes[position++];
    },
    integer() {
      let result = 0;
      for (let i = 0; i < 8; i++) {
        const value = this.byte();
        if (
          result > Math.floor((Number.MAX_SAFE_INTEGER - (value & 127)) / 128)
        )
          throw failure("PATCH_INVALID");
        result = result * 128 + (value & 127);
        if (!(value & 128)) return result;
      }
      throw failure("PATCH_INVALID");
    },
    take(length) {
      if (!size(length, this.remaining, true)) throw failure("PATCH_INVALID");
      const result = bytes.subarray(position, position + length);
      position += length;
      return result;
    },
  };
}

async function adler32(bytes, tick) {
  let a = 1,
    b = 0;
  for (let start = 0; start < bytes.length; start += 5552) {
    const end = Math.min(bytes.length, start + 5552);
    for (let i = start; i < end; i++) {
      a += bytes[i];
      b += a;
    }
    a %= 65521;
    b %= 65521;
    if (start % (5552 * 128) === 0) await tick(true);
  }
  return ((b << 16) | a) >>> 0;
}

async function applyVcdiff(input) {
  let secondary;
  const signal = input?.signal;
  const check = () => {
    if (signal?.aborted) throw failure("CANCELLED");
  };
  let steps = 0;
  async function tick(force = false) {
    check();
    if (force || ++steps % 1024 === 0) {
      await yieldTurn();
      check();
    }
  }
  const notify = (progress) => {
    try {
      Promise.resolve(input.onProgress?.(progress)).catch(() => {});
    } catch {
      /* Observers cannot change decoding. */
    }
  };
  try {
    if (
      !object(input) ||
      !object(input.source) ||
      !object(input.patch) ||
      !object(input.target) ||
      typeof input.source.read !== "function" ||
      typeof input.patch.read !== "function" ||
      typeof input.target.read !== "function" ||
      typeof input.target.write !== "function" ||
      !hashString(input.expectedSourceSha256) ||
      !hashString(input.expectedTargetSha256) ||
      (signal !== undefined && !(signal instanceof AbortSignal)) ||
      (input.onProgress !== undefined &&
        typeof input.onProgress !== "function") ||
      (input.limits !== undefined && !object(input.limits))
    )
      throw failure("INVALID_INPUT");
    const limits = { ...HARD_LIMITS };
    for (const [key, value] of Object.entries(input.limits || {})) {
      if (!Object.hasOwn(limits, key) || !size(value, limits[key]))
        throw failure("INVALID_INPUT");
      limits[key] = value;
    }
    if (limits.maxWasmMemoryBytes % BLOCK) throw failure("INVALID_INPUT");
    const sourceBytes = input.source.bytes,
      patchBytes = input.patch.bytes,
      targetBytes = input.expectedTargetBytes;
    if (
      !size(sourceBytes, limits.maxArchiveBytes, true) ||
      !size(patchBytes, limits.maxPatchBytes) ||
      !size(targetBytes, limits.maxArchiveBytes)
    )
      throw failure("INVALID_INPUT");
    const sourceRead = input.source.read.bind(input.source),
      patchRead = input.patch.read.bind(input.patch),
      targetRead = input.target.read.bind(input.target),
      targetWrite = input.target.write.bind(input.target),
      sourceHash = input.expectedSourceSha256,
      targetHash = input.expectedTargetSha256;
    async function exact(read, offset, length, maximum, code) {
      check();
      if (!size(offset, maximum, true) || !size(length, maximum - offset, true))
        throw failure(code);
      const result = Buffer.alloc(length);
      for (let position = 0; position < length; position += BLOCK) {
        const amount = Math.min(BLOCK, length - position);
        const piece = await read(offset + position, amount);
        check();
        if (!Buffer.isBuffer(piece) || piece.length !== amount)
          throw failure(code);
        piece.copy(result, position);
        if (position && position % (BLOCK * 16) === 0) await tick(true);
      }
      return result;
    }
    let position = 0,
      cached = Buffer.alloc(0),
      cacheStart = 0;
    async function byte() {
      check();
      if (position >= patchBytes) throw failure("PATCH_INVALID");
      if (position < cacheStart || position >= cacheStart + cached.length) {
        cacheStart = position;
        cached = await exact(
          patchRead,
          position,
          Math.min(BLOCK, patchBytes - position),
          patchBytes,
          "PATCH_INVALID",
        );
      }
      return cached[position++ - cacheStart];
    }
    async function integer() {
      let result = 0;
      for (let i = 0; i < 8; i++) {
        const value = await byte();
        if (
          result > Math.floor((Number.MAX_SAFE_INTEGER - (value & 127)) / 128)
        )
          throw failure("PATCH_INVALID");
        result = result * 128 + (value & 127);
        if (!(value & 128)) return result;
      }
      throw failure("PATCH_INVALID");
    }
    async function take(length) {
      if (!size(length, patchBytes - position, true))
        throw failure("PATCH_INVALID");
      const result = await exact(
        patchRead,
        position,
        length,
        patchBytes,
        "PATCH_INVALID",
      );
      position += length;
      return result;
    }
    if (
      (await byte()) !== 0xd6 ||
      (await byte()) !== 0xc3 ||
      (await byte()) !== 0xc4 ||
      (await byte()) !== 0
    )
      throw failure("PATCH_INVALID");
    const header = await byte();
    if (header & ~7) throw failure("PATCH_INVALID");
    let compressor = null;
    if (header & 1) {
      compressor = await byte();
      if (compressor !== 2) throw failure("PATCH_UNSUPPORTED");
    }
    if (header & 2) throw failure("PATCH_UNSUPPORTED");
    if (header & 4) {
      const length = await integer();
      if (!size(length, limits.maxApplicationHeaderBytes, true))
        throw failure("PATCH_RESOURCE_LIMIT");
      await take(length);
    }
    const sourceDigest = createHash("sha256");
    for (let offset = 0; offset < sourceBytes; offset += BLOCK) {
      sourceDigest.update(
        await exact(
          sourceRead,
          offset,
          Math.min(BLOCK, sourceBytes - offset),
          sourceBytes,
          "SOURCE_CHANGED",
        ),
      );
      if (offset % (BLOCK * 16) === 0) await tick(true);
    }
    if (sourceDigest.digest("hex") !== sourceHash)
      throw failure("HASH_MISMATCH");
    check();
    let written = 0,
      windows = 0,
      instructions = 0;
    const digest = createHash("sha256");
    while (position < patchBytes) {
      await tick(true);
      if (++windows > limits.maxWindows) throw failure("PATCH_RESOURCE_LIMIT");
      const indicator = await byte();
      if (indicator & ~7 || (indicator & 3) === 3)
        throw failure("PATCH_INVALID");
      let segmentLength = 0,
        segmentOffset = 0;
      if (indicator & 3) {
        segmentLength = await integer();
        segmentOffset = await integer();
        const available = indicator & 1 ? sourceBytes : written;
        if (
          !size(segmentOffset, available, true) ||
          !size(segmentLength, available - segmentOffset, true)
        )
          throw failure("PATCH_INVALID");
      }
      const deltaLength = await integer(),
        deltaEnd = position + deltaLength;
      if (!Number.isSafeInteger(deltaEnd) || deltaEnd > patchBytes)
        throw failure("PATCH_INVALID");
      const length = await integer();
      if (
        !size(length, limits.maxWindowBytes, true) ||
        length > targetBytes - written
      )
        throw failure("PATCH_RESOURCE_LIMIT");
      const deltaIndicator = await byte();
      if (deltaIndicator & ~7) throw failure("PATCH_INVALID");
      if (deltaIndicator && compressor === null) throw failure("PATCH_INVALID");
      const lengths = [await integer(), await integer(), await integer()];
      if (
        !size(
          lengths.reduce((a, b) => a + b, 0),
          limits.maxEncodedSectionBytes,
          true,
        )
      )
        throw failure("PATCH_RESOURCE_LIMIT");
      let checksum;
      if (indicator & 4) checksum = (await take(4)).readUInt32BE();
      if (position + lengths.reduce((a, b) => a + b, 0) !== deltaEnd)
        throw failure("PATCH_INVALID");
      const sections = [],
        names = ["data", "instructions", "addresses"];
      let decodedBytes = 0;
      for (let section = 0; section < 3; section++) {
        let bytes = await take(lengths[section]);
        if (deltaIndicator & (1 << section)) {
          const encoded = cursor(bytes),
            expected = encoded.integer();
          if (!size(expected, limits.maxDecodedSectionBytes - decodedBytes))
            throw failure("PATCH_RESOURCE_LIMIT");
          if (!secondary)
            secondary = await require("./pdx-xz.cjs").createXzSections({
              signal,
              maxMemoryBytes: limits.maxWasmMemoryBytes,
              maxDecodedBytes: limits.maxDecodedSectionBytes,
            });
          bytes = await secondary.decode(
            names[section],
            encoded.take(encoded.remaining),
            expected,
          );
          if (!Buffer.isBuffer(bytes) || bytes.length !== expected)
            throw failure("PATCH_INVALID");
        }
        decodedBytes += bytes.length;
        if (decodedBytes > limits.maxDecodedSectionBytes)
          throw failure("PATCH_RESOURCE_LIMIT");
        sections.push(cursor(bytes));
      }
      if (position !== deltaEnd) throw failure("PATCH_INVALID");
      const [data, codes, addresses] = sections,
        window = Buffer.alloc(length),
        near = [0, 0, 0, 0],
        same = Array(768).fill(0);
      let nextNear = 0,
        output = 0;
      async function copy(address, count) {
        if (
          !Number.isSafeInteger(address) ||
          address < 0 ||
          address >= segmentLength + output
        )
          throw failure("PATCH_INVALID");
        while (count > 0 && address < segmentLength) {
          const amount = Math.min(count, segmentLength - address, BLOCK);
          const content = await exact(
            indicator & 1 ? sourceRead : targetRead,
            segmentOffset + address,
            amount,
            indicator & 1 ? sourceBytes : written,
            "SOURCE_CHANGED",
          );
          content.copy(window, output);
          address += amount;
          output += amount;
          count -= amount;
          await tick();
        }
        if (!count) return;
        const local = address - segmentLength;
        if (local < 0 || local >= output) throw failure("PATCH_INVALID");
        const start = output,
          distance = output - local;
        let amount = Math.min(count, distance);
        window.copy(window, output, local, local + amount);
        output += amount;
        count -= amount;
        while (count) {
          const sourceStart = start + ((output - start) % distance);
          amount = Math.min(count, output - sourceStart, BLOCK);
          window.copy(window, output, sourceStart, sourceStart + amount);
          output += amount;
          count -= amount;
          await tick();
        }
      }
      while (codes.remaining) {
        const entry = TABLE[codes.byte()];
        for (const instruction of entry) {
          if (++instructions > limits.maxInstructions)
            throw failure("PATCH_RESOURCE_LIMIT");
          await tick();
          const count = instruction.size || codes.integer();
          if (!size(count, length - output)) throw failure("PATCH_INVALID");
          if (instruction.type === "add") {
            data.take(count).copy(window, output);
            output += count;
          } else if (instruction.type === "run") {
            window.fill(data.byte(), output, output + count);
            output += count;
          } else {
            const here = segmentLength + output;
            let address;
            if (instruction.mode === 0) address = addresses.integer();
            else if (instruction.mode === 1)
              address = here - addresses.integer();
            else if (instruction.mode <= 5)
              address = near[instruction.mode - 2] + addresses.integer();
            else
              address = same[(instruction.mode - 6) * 256 + addresses.byte()];
            if (
              !Number.isSafeInteger(address) ||
              address < 0 ||
              address >= here
            )
              throw failure("PATCH_INVALID");
            near[nextNear] = address;
            nextNear = (nextNear + 1) % 4;
            same[address % 768] = address;
            await copy(address, count);
          }
        }
      }
      if (output !== length || data.remaining || addresses.remaining)
        throw failure("PATCH_INVALID");
      if (checksum !== undefined && (await adler32(window, tick)) !== checksum)
        throw failure("HASH_MISMATCH");
      check();
      digest.update(window);
      await targetWrite(window);
      check();
      written += length;
      notify({ bytesWritten: written, totalBytes: targetBytes, windows });
    }
    if (written !== targetBytes || digest.digest("hex") !== targetHash)
      throw failure("HASH_MISMATCH");
    const finalDigest = createHash("sha256");
    for (let offset = 0; offset < written; offset += BLOCK) {
      finalDigest.update(
        await exact(
          targetRead,
          offset,
          Math.min(BLOCK, written - offset),
          written,
          "SOURCE_CHANGED",
        ),
      );
      if (offset % (BLOCK * 16) === 0) await tick(true);
    }
    if (finalDigest.digest("hex") !== targetHash)
      throw failure("HASH_MISMATCH");
    check();
    return { bytes: written, sha256: targetHash, windows };
  } catch (error) {
    check();
    if (error?.[SAFE]) throw error;
    if (
      ["PATCH_INVALID", "PATCH_RESOURCE_LIMIT", "CANCELLED"].includes(
        error?.code,
      )
    )
      throw failure(error.code);
    throw failure("FILE_ERROR");
  } finally {
    secondary?.dispose();
  }
}

module.exports = { applyVcdiff };
