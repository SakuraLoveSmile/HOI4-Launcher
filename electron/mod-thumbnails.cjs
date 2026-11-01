"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { Readable } = require("node:stream");
const yauzl = require("yauzl");
const {
  validatedCoverRaster,
  MAX_IMAGE_BYTES,
  crc32,
} = require("./raster-image.cjs");

const MAX_ZIP_BYTES = 20 * 1024 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 100000;
const MAX_ZIP_READ = 64 * 1024 * 1024;
const MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
};
const DEFAULT_PICTURES = Object.keys(MIME).map(
  (extension) => `thumbnail${extension}`,
);
const canonical = (value) =>
  process.platform === "win32"
    ? path.resolve(value).toLowerCase()
    : path.resolve(value);
const same = (left, right) =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.birthtimeNs === right.birthtimeNs;
const stable = (left, right) =>
  same(left, right) &&
  left.size === right.size &&
  left.mtimeNs === right.mtimeNs &&
  left.ctimeNs === right.ctimeNs;
const localPath = (value) =>
  typeof value === "string" &&
  path.isAbsolute(value) &&
  !/^(?:\\\\|\/\/)/.test(value) &&
  !/[\0-\x1f]/.test(value);

function relativeName(value, directory = false) {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 1024 ||
    /[\0-\x1f\x7f:<>"|?*]/.test(value)
  )
    return null;
  value = value.replace(/\\/g, "/");
  if (directory && value.endsWith("/")) value = value.slice(0, -1);
  const parts = value.split("/");
  if (
    parts.length > 32 ||
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        /[. ]$/.test(part) ||
        /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part),
    )
  )
    return null;
  return parts.join("/");
}

function pictureCandidates(value) {
  if (value === undefined || value === null || value === "")
    return DEFAULT_PICTURES;
  const picture = relativeName(value);
  if (!picture) return [];
  const extension = path.posix.extname(picture).toLowerCase();
  if (extension && !MIME[extension]) return [];
  return [
    ...new Set([
      picture,
      ...(!extension
        ? Object.keys(MIME).map((suffix) => picture + suffix)
        : []),
      ...DEFAULT_PICTURES,
    ]),
  ];
}

function directories(file) {
  const paths = [];
  for (let current = path.dirname(file); ; current = path.dirname(current)) {
    paths.unshift(current);
    if (path.dirname(current) === current) return paths;
  }
}
async function directoryInfo(directory) {
  const stat = await fs.lstat(directory, { bigint: true });
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    canonical(await fs.realpath(directory)) !== canonical(directory)
  )
    throw new Error("directory");
  return { path: directory, stat };
}
async function snapshot(file, maxBytes, directoryCache) {
  if (!localPath(file)) throw new Error("local path");
  file = path.resolve(file);
  const chain = [];
  for (const directory of directories(file)) {
    if (!directoryCache.has(directory))
      directoryCache.set(directory, directoryInfo(directory));
    chain.push(await directoryCache.get(directory));
  }
  const stat = await fs.lstat(file, { bigint: true });
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1n ||
    stat.size < 1n ||
    stat.size > BigInt(maxBytes) ||
    canonical(await fs.realpath(file)) !== canonical(file)
  )
    throw new Error("file");
  return { file, stat, chain };
}
async function verify(source, handle) {
  for (const before of source.chain)
    if (!same(before.stat, (await directoryInfo(before.path)).stat))
      throw new Error("changed directory");
  const current = await fs.lstat(source.file, { bigint: true });
  if (
    !current.isFile() ||
    current.isSymbolicLink() ||
    current.nlink !== 1n ||
    !stable(source.stat, current) ||
    canonical(await fs.realpath(source.file)) !== canonical(source.file)
  )
    throw new Error("changed file");
  if (handle) {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || !stable(source.stat, opened))
      throw new Error("changed handle");
  }
}

// Yauzl owns this reader, while this module exclusively owns the FileHandle.
// Closing the ZIP never closes or reuses a raw descriptor behind FileHandle.
class BoundedZipReader extends yauzl.RandomAccessReader {
  constructor(handle, size) {
    super();
    this.handle = handle;
    this.size = size;
    this.bytes = 0;
  }
  _readStreamForRange(start, end) {
    const reader = this;
    return Readable.from(
      (async function* () {
        if (
          !Number.isSafeInteger(start) ||
          !Number.isSafeInteger(end) ||
          start < 0 ||
          end < start ||
          end > reader.size
        )
          throw new Error("zip range");
        for (let at = start; at < end; ) {
          const length = Math.min(64 * 1024, end - at);
          if ((reader.bytes += length) > MAX_ZIP_READ)
            throw new Error("zip read limit");
          const buffer = Buffer.alloc(length);
          const { bytesRead } = await reader.handle.read(buffer, 0, length, at);
          if (!bytesRead) throw new Error("zip truncated");
          at += bytesRead;
          yield buffer.subarray(0, bytesRead);
        }
      })(),
    );
  }
}

async function readFile(source) {
  let handle;
  try {
    await verify(source);
    handle = await fs.open(source.file, "r");
    await verify(source, handle);
    const bytes = Buffer.alloc(Number(source.stat.size));
    for (let at = 0; at < bytes.length; ) {
      const { bytesRead } = await handle.read(
        bytes,
        at,
        Math.min(64 * 1024, bytes.length - at),
        at,
      );
      if (!bytesRead) throw new Error("truncated");
      at += bytesRead;
    }
    await verify(source, handle);
    return bytes;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function readZip(source, pictures) {
  let handle, zip, stream;
  try {
    await verify(source);
    handle = await fs.open(source.file, "r");
    await verify(source, handle);
    zip = await yauzl.fromRandomAccessReaderPromise(
      new BoundedZipReader(handle, Number(source.stat.size)),
      Number(source.stat.size),
      {
        autoClose: false,
        lazyEntries: true,
        strictFileNames: true,
        validateEntrySizes: true,
      },
    );
    zip.on("error", () => {});
    if (zip.entryCount > MAX_ZIP_ENTRIES) throw new Error("zip entries");
    const names = new Set();
    const wanted = new Map();
    pictures.forEach((name, index) => {
      if (!wanted.has(name.toLowerCase()))
        wanted.set(name.toLowerCase(), index);
    });
    let selected,
      priority = Infinity,
      totalNames = 0,
      count = 0;
    for await (const entry of zip.eachEntry()) {
      const directory = entry.fileName.endsWith("/"),
        name = relativeName(entry.fileName, directory),
        mode = (entry.externalFileAttributes >>> 16) & 0xf000;
      if (
        !name ||
        ++count > MAX_ZIP_ENTRIES ||
        (totalNames += entry.fileName.length) > 16 * 1024 * 1024 ||
        names.has(name.toLowerCase()) ||
        ![0, 0x8000, 0x4000].includes(mode) ||
        (mode === 0x4000 && !directory) ||
        entry.generalPurposeBitFlag & 0x41 ||
        ![0, 8].includes(entry.compressionMethod) ||
        !Number.isSafeInteger(entry.uncompressedSize) ||
        !Number.isSafeInteger(entry.compressedSize) ||
        entry.uncompressedSize < 0 ||
        entry.compressedSize < 0 ||
        entry.uncompressedSize > MAX_ZIP_BYTES
      )
        throw new Error("unsafe zip entry");
      names.add(name.toLowerCase());
      const rank = wanted.get(name.toLowerCase());
      if (rank !== undefined && rank < priority) {
        selected = entry;
        priority = rank;
      }
    }
    await verify(source, handle);
    if (!selected) return null;
    if (
      selected.fileName.endsWith("/") ||
      selected.uncompressedSize < 1 ||
      selected.uncompressedSize > MAX_IMAGE_BYTES ||
      selected.compressedSize > MAX_IMAGE_BYTES + 65536
    )
      throw new Error("image size");
    stream = await zip.openReadStreamPromise(selected);
    const buffers = [];
    let bytes = 0;
    for await (const chunk of stream) {
      bytes += chunk.length;
      if (bytes > MAX_IMAGE_BYTES || bytes > selected.uncompressedSize)
        throw new Error("image size");
      buffers.push(chunk);
    }
    await verify(source, handle);
    const result = Buffer.concat(buffers);
    if (bytes !== selected.uncompressedSize || crc32(result) !== selected.crc32)
      throw new Error("image checksum");
    return result;
  } finally {
    stream?.destroy();
    zip?.close();
    await handle?.close().catch(() => {});
  }
}

function createModThumbnails() {
  let records = new Map(),
    active = 0;
  const waiting = [];
  async function slot(work) {
    if (active >= 2) await new Promise((resolve) => waiting.push(resolve));
    else active++;
    try {
      return await work();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  }
  return {
    async replace(mods) {
      const next = new Map(),
        directoryCache = new Map();
      for (const mod of mods) {
        const pictures = pictureCandidates(mod.picture);
        if (
          !mod.available ||
          typeof mod.id !== "string" ||
          !pictures.length ||
          !localPath(mod.contentPath)
        )
          continue;
        try {
          const contentPath = path.resolve(mod.contentPath),
            stat = await fs.lstat(contentPath, { bigint: true });
          if (stat.isSymbolicLink()) continue;
          const archive = stat.isFile();
          if (!archive && !stat.isDirectory()) continue;
          let source, picture;
          if (archive) {
            source = await snapshot(contentPath, MAX_ZIP_BYTES, directoryCache);
            picture = pictures[0];
          } else {
            for (const candidate of pictures) {
              try {
                source = await snapshot(
                  path.join(contentPath, ...candidate.split("/")),
                  MAX_IMAGE_BYTES,
                  directoryCache,
                );
                picture = candidate;
                break;
              } catch {
                // Try only the bounded conventional candidates inside this mod.
              }
            }
            if (!source) continue;
          }
          const candidatesKey = JSON.stringify(pictures);
          const previous = records.get(mod.id);
          const unchanged =
            previous &&
            previous.picture === picture &&
            previous.candidatesKey === candidatesKey &&
            previous.archive === archive &&
            canonical(previous.source.file) === canonical(source.file) &&
            stable(previous.source.stat, source.stat) &&
            previous.source.chain.length === source.chain.length &&
            source.chain.every(
              (entry, index) =>
                canonical(entry.path) ===
                  canonical(previous.source.chain[index].path) &&
                same(entry.stat, previous.source.chain[index].stat),
            );
          // Background storage/status reads also scan the library. Preserve a
          // running read when that scan found the exact same source snapshot.
          next.set(
            mod.id,
            unchanged
              ? previous
              : {
                  source,
                  picture,
                  pictures,
                  candidatesKey,
                  archive,
                  pending: null,
                },
          );
        } catch {
          /* A broken or missing thumbnail must not affect the mod list. */
        }
      }
      records = next;
      return new Map([...records].map(([id, record]) => [id, record.picture]));
    },
    async get(modId) {
      if (typeof modId !== "string" || modId.length > 512) return null;
      const record = records.get(modId);
      if (!record) return null;
      if (!record.pending)
        record.pending = slot(async () => {
          if (records.get(modId) !== record) return null;
          try {
            const raw = record.archive
              ? await readZip(record.source, record.pictures)
              : await readFile(record.source);
            if (!raw) return null;
            const validated = validatedCoverRaster(raw);
            if (!validated || records.get(modId) !== record) return null;
            const { bytes, image } = validated;
            return {
              dataUrl: `data:${image.mime};base64,${bytes.toString("base64")}`,
              ...image,
            };
          } catch {
            return null;
          }
        });
      const pending = record.pending;
      try {
        const result = await pending;
        return result ? { ...result } : null;
      } finally {
        if (record.pending === pending) record.pending = null;
      }
    },
  };
}

module.exports = { createModThumbnails };
