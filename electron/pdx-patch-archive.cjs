"use strict";

const { createHash } = require("node:crypto");
const { Readable } = require("node:stream");
const { TextDecoder } = require("node:util");
const yauzl = require("yauzl");
const { applyVcdiff } = require("./pdx-vcdiff.cjs");
const {
  parsePdxPatchOperations,
  createPdxPatchPlan,
} = require("./pdx-patch-plan.cjs");

const BLOCK = 64 * 1024;
const MAX_BYTES = 5 * 1024 ** 3;
const MAX_OPERATIONS = 64 * 1024;
const MAX_ENTRIES = 8;
const MAX_TOTAL = MAX_BYTES + MAX_OPERATIONS;
const MAX_RATIO = 1000;
const SAFE = Symbol("patch-archive-error");
const MESSAGES = {
  INVALID_INPUT: "Paradox 下载参数无效。",
  PATCH_INVALID: "模组补丁归档无效，请使用完整包。",
  PATCH_UNSUPPORTED: "模组补丁操作不受支持，请使用完整包。",
  PATCH_RESOURCE_LIMIT: "模组补丁超过允许大小，请使用完整包。",
  HASH_MISMATCH: "下载文件校验失败，请重新下载。",
  CANCELLED: "模组下载已取消。",
  SOURCE_CHANGED: "续传源文件或所在目录已变化，请重新下载。",
  FILE_ERROR: "无法写入模组下载文件，请检查磁盘空间和目录权限。",
};
const failure = (code) =>
  Object.assign(new Error(MESSAGES[code]), {
    code,
    [SAFE]: true,
    ...(code === "CANCELLED" ? { name: "AbortError" } : {}),
  });
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const hashString = (value) =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const size = (value, maximum, zero = false) =>
  Number.isSafeInteger(value) && value >= (zero ? 0 : 1) && value <= maximum;
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++)
    value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value >>> 0;
});
function crcUpdate(crc, bytes) {
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return crc >>> 0;
}
function simpleName(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= 1024 &&
    value !== "." &&
    value !== ".." &&
    !/[\\/\0-\x1f\x7f<>:"|?*\ufffd]/.test(value) &&
    !/[. ]$/.test(value) &&
    !/^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³]|CONIN\$|CONOUT\$|CLOCK\$)(?:\.|$)/i.test(
      value,
    )
  );
}

// This is deliberately a single-complete-ZIP byte container, not a general
// filesystem patcher. The upper layer supplies new empty, stable temporary
// target/scratch handles and owns their physical size checks, commit and cleanup.
async function applyPdxPatchArchive(input) {
  let zip;
  let reader;
  let activeStream;
  let signal;
  let abortPromise;
  let rejectAbort;
  let blocks = 0;
  let observer;
  let targetBytes;
  let operation;
  let written = 0;
  let phase = "verifying-patch";
  const check = () => {
    if (signal?.aborted) throw failure("CANCELLED");
  };
  const onAbort = () => {
    const error = failure("CANCELLED");
    rejectAbort?.(error);
    activeStream?.destroy(error);
    reader?.stop(error);
  };
  async function tick(force = false) {
    check();
    if (force || ++blocks % 16 === 0) {
      await new Promise((resolve) => setImmediate(resolve));
      check();
    }
  }
  function notify() {
    try {
      Promise.resolve(
        observer?.({
          phase,
          bytesWritten: written,
          totalBytes: targetBytes,
          ...(operation ? { operation } : {}),
        }),
      ).catch(() => {});
    } catch {
      // Progress observers cannot change the verification decision.
    }
  }
  async function exact(read, offset, length, maximum, code) {
    check();
    if (!size(offset, maximum, true) || !size(length, maximum - offset, true))
      throw failure(code);
    const result = Buffer.alloc(length);
    for (let at = 0; at < length; at += BLOCK) {
      const amount = Math.min(BLOCK, length - at);
      let piece;
      try {
        const pending = Promise.resolve(read(offset + at, amount));
        piece = await (abortPromise
          ? Promise.race([pending, abortPromise])
          : pending);
      } catch {
        check();
        throw failure(code);
      }
      check();
      if (!Buffer.isBuffer(piece) || piece.length !== amount)
        throw failure(code);
      piece.copy(result, at);
    }
    return result;
  }
  async function digest(read, bytes, code) {
    const hash = createHash("sha256");
    for (let offset = 0; offset < bytes; offset += BLOCK) {
      hash.update(
        await exact(read, offset, Math.min(BLOCK, bytes - offset), bytes, code),
      );
      await tick(offset === 0);
    }
    check();
    return hash.digest("hex");
  }

  try {
    if (
      !object(input) ||
      !object(input.patch) ||
      !size(input.patch.bytes, MAX_BYTES) ||
      !hashString(input.patch.sha256) ||
      typeof input.patch.read !== "function" ||
      (input.patch.unpackedBytes !== undefined &&
        !size(input.patch.unpackedBytes, MAX_TOTAL, true)) ||
      !object(input.target) ||
      typeof input.target.read !== "function" ||
      typeof input.target.write !== "function" ||
      !size(input.expectedTargetBytes, MAX_BYTES) ||
      !hashString(input.expectedTargetSha256) ||
      !simpleName(input.expectedTargetFilename) ||
      Buffer.byteLength(input.expectedTargetFilename, "utf8") > 255 ||
      !/\.zip$/i.test(input.expectedTargetFilename) ||
      (input.source !== undefined &&
        (!object(input.source) ||
          !size(input.source.bytes, MAX_BYTES, true) ||
          !hashString(input.source.sha256) ||
          typeof input.source.read !== "function")) ||
      (input.scratch !== undefined &&
        (!object(input.scratch) ||
          typeof input.scratch.read !== "function" ||
          typeof input.scratch.write !== "function")) ||
      (input.signal !== undefined && !(input.signal instanceof AbortSignal)) ||
      (input.onProgress !== undefined && typeof input.onProgress !== "function")
    )
      throw failure("INVALID_INPUT");
    signal = input.signal;
    observer = input.onProgress;
    targetBytes = input.expectedTargetBytes;
    const targetHash = input.expectedTargetSha256;
    const filename = input.expectedTargetFilename;
    const patchBytes = input.patch.bytes;
    const patchHash = input.patch.sha256;
    const unpackedBytes = input.patch.unpackedBytes;
    const patchRead = input.patch.read.bind(input.patch);
    const targetRead = input.target.read.bind(input.target);
    const targetWrite = input.target.write.bind(input.target);
    let source = input.source && {
      bytes: input.source.bytes,
      sha256: input.source.sha256,
      read: input.source.read.bind(input.source),
    };
    const scratch = input.scratch && {
      read: input.scratch.read.bind(input.scratch),
      write: input.scratch.write.bind(input.scratch),
    };
    check();
    if (signal) {
      abortPromise = new Promise((resolve, reject) => {
        rejectAbort = reject;
      });
      abortPromise.catch(() => {});
      signal.addEventListener("abort", onAbort, { once: true });
    }
    notify();
    if ((await digest(patchRead, patchBytes, "PATCH_INVALID")) !== patchHash)
      throw failure("HASH_MISMATCH");
    check();

    class LeaseReader extends yauzl.RandomAccessReader {
      constructor() {
        super();
        this.requested = 0;
        this.stopped = false;
        this.streams = new Set();
        this.on("error", () => {});
      }
      async range(offset, length) {
        check();
        if (this.stopped) throw failure("PATCH_INVALID");
        this.requested += length;
        if (this.requested > 2 * patchBytes + 1024 ** 2)
          throw failure("PATCH_RESOURCE_LIMIT");
        return exact(patchRead, offset, length, patchBytes, "PATCH_INVALID");
      }
      read(buffer, offset, length, position, callback) {
        this.range(position, length).then(
          (piece) => {
            piece.copy(buffer, offset);
            callback(null, length);
          },
          (error) => callback(error),
        );
      }
      _readStreamForRange(start, end) {
        const lease = this;
        const stream = Readable.from(
          (async function* () {
            if (
              !size(start, patchBytes, true) ||
              !size(end - start, patchBytes - start, true)
            )
              throw failure("PATCH_INVALID");
            for (let at = start; at < end; at += BLOCK) {
              yield await lease.range(at, Math.min(BLOCK, end - at));
              await tick();
            }
          })(),
          { objectMode: false },
        );
        this.streams.add(stream);
        stream.on("error", () => {});
        stream.once("close", () => this.streams.delete(stream));
        return stream;
      }
      stop(error) {
        this.stopped = true;
        for (const stream of this.streams) stream.destroy(error);
      }
    }
    reader = new LeaseReader();
    zip = await yauzl.fromRandomAccessReaderPromise(reader, patchBytes, {
      autoClose: false,
      lazyEntries: true,
      strictFileNames: true,
      decodeStrings: true,
      validateEntrySizes: true,
    });
    zip.on("error", () => {});
    if (!size(zip.entryCount, MAX_ENTRIES))
      throw failure(
        zip.entryCount > MAX_ENTRIES ? "PATCH_RESOURCE_LIMIT" : "PATCH_INVALID",
      );
    const directoryStart = zip.readEntryCursor;
    const entries = new Map();
    const keys = new Set();
    let total = 0;
    let compressedTotal = 0;
    let nameBytes = 0;
    for await (const entry of zip.eachEntry()) {
      check();
      const name = entry.fileName;
      const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
      if (
        !simpleName(name) ||
        keys.has(name.normalize("NFC").toLowerCase()) ||
        entries.size >= MAX_ENTRIES ||
        (nameBytes += Buffer.byteLength(name, "utf8")) > 8192 ||
        ![0, 0x8000].includes(mode) ||
        entry.externalFileAttributes & 0x410 ||
        (entry.extraFields || []).some((field) =>
          [0x000d, 0x5855, 0x756e].includes(field.id),
        ) ||
        entry.generalPurposeBitFlag & ~0x080e ||
        ![0, 8].includes(entry.compressionMethod)
      )
        throw failure("PATCH_INVALID");
      if (
        !size(entry.compressedSize, patchBytes, true) ||
        !size(entry.uncompressedSize, MAX_BYTES, true) ||
        entry.uncompressedSize >
          MAX_RATIO * Math.max(1, entry.compressedSize) ||
        (total += entry.uncompressedSize) > MAX_TOTAL ||
        (compressedTotal += entry.compressedSize) > patchBytes ||
        (name === "operations" &&
          !size(entry.uncompressedSize, MAX_OPERATIONS, true))
      )
        throw failure("PATCH_RESOURCE_LIMIT");
      keys.add(name.normalize("NFC").toLowerCase());
      entries.set(name, { entry });
      await tick();
    }
    if (entries.size !== zip.entryCount || !entries.has("operations"))
      throw failure("PATCH_INVALID");
    if (unpackedBytes !== undefined && total !== unpackedBytes)
      throw failure("HASH_MISMATCH");
    const ranges = [];
    for (const item of entries.values()) {
      check();
      const entry = item.entry;
      const local = await zip.readLocalFileHeaderPromise(entry);
      if (
        !Buffer.from(entry.fileName, "utf8").equals(local.fileName) ||
        local.compressionMethod !== entry.compressionMethod ||
        local.generalPurposeBitFlag !== entry.generalPurposeBitFlag ||
        !size(entry.relativeOffsetOfLocalHeader, directoryStart, true) ||
        !size(local.fileDataStart, directoryStart, true) ||
        entry.relativeOffsetOfLocalHeader + 30 > local.fileDataStart ||
        entry.compressedSize > directoryStart - local.fileDataStart
      )
        throw failure("PATCH_INVALID");
      item.start = local.fileDataStart;
      ranges.push([
        entry.relativeOffsetOfLocalHeader,
        item.start + entry.compressedSize,
      ]);
    }
    ranges.sort((a, b) => a[0] - b[0]);
    if (ranges.some((range, i) => i > 0 && range[0] < ranges[i - 1][1]))
      throw failure("PATCH_INVALID");

    async function consumeEntry(item, consume) {
      check();
      const entry = item.entry;
      const stream = await new Promise((resolve, reject) => {
        // yauzl 3.4.0's LowLevelPromise wrapper calls the wrong method; use
        // the correctly typed callback API over our validated local range.
        zip.openReadStreamLowLevel(
          item.start,
          entry.compressedSize,
          0,
          entry.compressedSize,
          entry.compressionMethod === 8,
          entry.uncompressedSize,
          (error, value) => (error ? reject(error) : resolve(value)),
        );
      });
      activeStream = stream;
      stream.on("error", () => {});
      let bytes = 0;
      let crc = 0xffffffff;
      const hash = createHash("sha256");
      try {
        for await (const value of stream) {
          check();
          if (!Buffer.isBuffer(value)) throw failure("PATCH_INVALID");
          for (let at = 0; at < value.length; at += BLOCK) {
            const piece = value.subarray(at, at + BLOCK);
            bytes += piece.length;
            if (bytes > entry.uncompressedSize || bytes > MAX_BYTES)
              throw failure("PATCH_RESOURCE_LIMIT");
            crc = crcUpdate(crc, piece);
            hash.update(piece);
            await consume(Buffer.from(piece));
            check();
            await tick();
          }
        }
        check();
        if (
          bytes !== entry.uncompressedSize ||
          (crc ^ 0xffffffff) >>> 0 !== entry.crc32
        )
          throw failure("HASH_MISMATCH");
        return { bytes, sha256: hash.digest("hex") };
      } finally {
        stream.destroy();
        activeStream = undefined;
      }
    }

    const lines = [];
    await consumeEntry(entries.get("operations"), async (piece) => {
      lines.push(piece);
    });
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        Buffer.concat(lines),
      );
    } catch {
      throw failure("PATCH_INVALID");
    }
    const tokens = text.split("\n");
    if (tokens.at(-1) === "") tokens.pop();
    if (
      tokens.length > 2 ||
      (tokens.length > 1 && tokens.some((line) => !line))
    )
      throw failure("PATCH_UNSUPPORTED");
    const parsed = parsePdxPatchOperations(text);
    if (parsed.some((item) => item.path !== filename))
      throw failure("PATCH_INVALID");
    const producers = parsed.filter((item) => item.type !== "d");
    if (
      producers.length > 1 ||
      parsed.filter((item) => item.type === "d").length > 1 ||
      producers.some((item) => !["n", "p", "k"].includes(item.type))
    )
      throw failure("PATCH_UNSUPPORTED");
    operation = producers[0]?.type || "k";
    const payloadName = operation === "n" ? filename : `${filename}.vcdiff`;
    if (
      operation === "k"
        ? entries.size !== 1
        : entries.size !== 2 || !entries.has(payloadName)
    )
      throw failure("PATCH_UNSUPPORTED");
    if (operation === "p" && !source)
      source = {
        bytes: 0,
        sha256: createHash("sha256").digest("hex"),
        read: async () => Buffer.alloc(0),
      };
    if (operation === "k" && !source) throw failure("INVALID_INPUT");
    if (operation === "p" && !scratch) throw failure("INVALID_INPUT");
    if (
      operation === "k" &&
      (source.bytes !== targetBytes || source.sha256 !== targetHash)
    )
      throw failure("HASH_MISMATCH");
    const plan = createPdxPatchPlan({
      operations: text,
      targets: [
        {
          path: filename,
          type: "file",
          bytes: targetBytes,
          sha256: targetHash,
        },
      ],
      sources: source
        ? [
            {
              path: filename,
              type: "file",
              bytes: source.bytes,
              sha256: source.sha256,
            },
          ]
        : [],
      payloads: [...entries.values()]
        .filter((item) => item.entry.fileName !== "operations")
        .map((item) => ({
          path: item.entry.fileName,
          bytes: item.entry.uncompressedSize,
        })),
    });
    if (
      plan.actions.length !== 1 ||
      plan.directories.length ||
      plan.actions[0].type !== operation
    )
      throw failure("PATCH_UNSUPPORTED");
    // The destination is a fresh target handle. A validated d applies to that
    // empty target, never to the installed version or the trusted source lease.

    const outputHash = createHash("sha256");
    async function append(bytes) {
      check();
      if (!Buffer.isBuffer(bytes) || bytes.length > targetBytes - written)
        throw failure("PATCH_RESOURCE_LIMIT");
      const stable = Buffer.from(bytes);
      outputHash.update(stable);
      try {
        await targetWrite(stable);
      } catch {
        check();
        throw failure("FILE_ERROR");
      }
      check();
      written += stable.length;
      notify();
    }
    let windows = 0;
    if (operation === "n") {
      phase = "extracting";
      const payload = entries.get(payloadName);
      if (payload.entry.uncompressedSize !== targetBytes)
        throw failure("HASH_MISMATCH");
      await consumeEntry(payload, append);
    } else if (operation === "k") {
      phase = "verifying-source";
      notify();
      if (
        source.bytes !== targetBytes ||
        (await digest(source.read, source.bytes, "SOURCE_CHANGED")) !==
          source.sha256
      )
        throw failure("HASH_MISMATCH");
      phase = "copying";
      for (let at = 0; at < source.bytes; at += BLOCK) {
        await append(
          await exact(
            source.read,
            at,
            Math.min(BLOCK, source.bytes - at),
            source.bytes,
            "SOURCE_CHANGED",
          ),
        );
        await tick();
      }
    } else {
      phase = "extracting-delta";
      notify();
      const payload = entries.get(payloadName);
      if (!payload.entry.uncompressedSize) throw failure("PATCH_INVALID");
      const staged = await consumeEntry(payload, async (piece) => {
        try {
          await scratch.write(piece);
        } catch {
          check();
          throw failure("FILE_ERROR");
        }
      });
      if (
        (await digest(scratch.read, staged.bytes, "FILE_ERROR")) !==
        staged.sha256
      )
        throw failure("HASH_MISMATCH");
      phase = "applying-delta";
      const result = await applyVcdiff({
        source: {
          bytes: source.bytes,
          read: (offset, length) =>
            exact(source.read, offset, length, source.bytes, "SOURCE_CHANGED"),
        },
        patch: {
          bytes: staged.bytes,
          read: (offset, length) =>
            exact(scratch.read, offset, length, staged.bytes, "FILE_ERROR"),
        },
        target: {
          write: append,
          read: (offset, length) =>
            exact(targetRead, offset, length, written, "FILE_ERROR"),
        },
        expectedSourceSha256: source.sha256,
        expectedTargetSha256: targetHash,
        expectedTargetBytes: targetBytes,
        signal,
      });
      windows = result.windows;
    }
    if (written !== targetBytes || outputHash.digest("hex") !== targetHash)
      throw failure("HASH_MISMATCH");
    phase = "verifying-target";
    notify();
    if ((await digest(targetRead, written, "FILE_ERROR")) !== targetHash)
      throw failure("HASH_MISMATCH");
    check();
    return {
      operation,
      bytes: written,
      sha256: targetHash,
      windows,
      ...(plan.actions[0].implicit ? { implicitCopy: true } : {}),
    };
  } catch (error) {
    check();
    if (error?.[SAFE]) throw error;
    if (Object.hasOwn(MESSAGES, error?.code || "")) throw failure(error.code);
    throw failure("PATCH_INVALID");
  } finally {
    signal?.removeEventListener("abort", onAbort);
    activeStream?.destroy();
    reader?.stop();
    zip?.close();
  }
}

module.exports = { applyPdxPatchArchive };
