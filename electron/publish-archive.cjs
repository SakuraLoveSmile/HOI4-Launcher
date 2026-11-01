"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { Readable } = require("node:stream");
const yazl = require("yazl");
const yauzl = require("yauzl");

const MAX_ARCHIVE = 5 * 1024 ** 3;
const MAX_SOURCE = 200 * 1024 ** 3;
const MAX_FILES = 100000;
const identity = (s) => ({
  ino: s.ino,
  dev: s.dev,
  birthtimeMs: s.birthtimeMs,
});
const same = (a, b) =>
  Boolean(
    a &&
      b &&
      a.ino === b.ino &&
      a.dev === b.dev &&
      a.birthtimeMs === b.birthtimeMs,
  );
const canonical = (value) => path.resolve(value).toLowerCase();
const within = (root, value) => {
  const relative = path.relative(root, value);
  return (
    relative !== ".." &&
    !relative.startsWith(".." + path.sep) &&
    !path.isAbsolute(relative)
  );
};
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function cancelled(signal) {
  if (!signal?.aborted) return;
  const error = new Error("发布 ZIP 打包已取消，原快照保持不变。");
  error.name = "AbortError";
  throw error;
}
function absolute(value) {
  if (
    typeof value !== "string" ||
    !path.isAbsolute(value) ||
    /[\0-\x1f\x7f]/.test(value)
  )
    throw new Error("打包目录必须是有效的绝对路径。");
  return path.resolve(value);
}
async function optional(file) {
  try {
    return await fs.lstat(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
async function directoryChain(directory, create = false) {
  const target = absolute(directory),
    parsed = path.parse(target);
  let current = parsed.root;
  for (const part of target
    .slice(parsed.root.length)
    .split(path.sep)
    .filter(Boolean)) {
    current = path.join(current, part);
    let info = await optional(current);
    if (!info && create) {
      try {
        await fs.mkdir(current);
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      info = await fs.lstat(current);
    }
    if (
      !info?.isDirectory() ||
      info.isSymbolicLink() ||
      canonical(await fs.realpath(current)) !== canonical(current)
    )
      throw new Error("打包路径包含链接、目录联接或重定向。");
  }
}
function relativeName(value) {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 4096 ||
    value.startsWith("/") ||
    value.startsWith("\\") ||
    /[\0-\x1f\x7f<>:"|?*]/.test(value)
  )
    throw new Error("发布清单包含不安全的文件路径。");
  const parts = value.split(/[\\/]/);
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
    throw new Error("发布清单包含越界路径或 Windows 保留名称。");
  return parts.join("/");
}
function manifest(files) {
  if (!Array.isArray(files) || !files.length || files.length > MAX_FILES)
    throw new Error("发布清单须包含 1 至 100000 个文件。");
  const names = new Map();
  let total = 0;
  const normalized = files.map((file) => {
    if (!object(file)) throw new Error("发布文件清单无效。");
    const name = relativeName(file.relative);
    // fs.Stats uses Numbers by default; Windows file IDs can exceed 2^53.
    // Compare its opaque identity consistently and independently bind all bytes by SHA-256.
    if (
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      !Number.isInteger(file.targetIno) ||
      file.targetIno < 0 ||
      !Number.isInteger(file.targetDev) ||
      file.targetDev < 0 ||
      typeof file.hash !== "string" ||
      !/^[a-f0-9]{64}$/i.test(file.hash)
    )
      throw new Error("发布清单缺少文件身份、长度或 SHA-256。");
    total += file.size;
    if (total > MAX_SOURCE) throw new Error("发布源内容超过 200 GiB。");
    const parts = name.split("/");
    for (let index = 1; index <= parts.length; index++) {
      const prefix = parts.slice(0, index).join("/"),
        leaf = index === parts.length,
        key = prefix.toLowerCase(),
        prior = names.get(key);
      if (prior && (prior.name !== prefix || prior.file || leaf))
        throw new Error("发布清单包含重复、大小写冲突或文件目录冲突。");
      names.set(key, { name: prefix, file: leaf });
    }
    return {
      name,
      relative: name.split("/").join(path.sep),
      size: file.size,
      hash: file.hash.toLowerCase(),
      targetIno: file.targetIno,
      targetDev: file.targetDev,
    };
  });
  if (!normalized.some((file) => file.name.toLowerCase() === "descriptor.mod"))
    throw new Error("发布清单根目录缺少 descriptor.mod。");
  return { files: normalized, total };
}

function createPublishArchiveService({
  storageDirectory,
  maxArchiveBytes = MAX_ARCHIVE,
} = {}) {
  const storage = absolute(storageDirectory);
  if (
    !Number.isSafeInteger(maxArchiveBytes) ||
    maxArchiveBytes < 1 ||
    maxArchiveBytes > MAX_ARCHIVE
  )
    throw new Error("ZIP 大小限制须为不超过 5 GiB 的正整数。");
  async function createArchive({
    contentPath,
    files,
    signal,
    onProgress,
  } = {}) {
    const source = absolute(contentPath),
      plan = manifest(files);
    if (within(source, storage))
      throw new Error("ZIP 暂存目录不能位于要打包的内容目录内。");
    cancelled(signal);
    await directoryChain(source);
    const sourceIdentity = identity(await fs.lstat(source));
    const initialFiles = new Map(),
      initialDirectories = new Map();
    const expected = new Map(
      plan.files.map((file) => [file.name.toLowerCase(), file]),
    );
    const expectedDirectories = new Set([""]);
    for (const file of plan.files) {
      const parts = file.name.split("/");
      for (let depth = 1; depth < parts.length; depth++)
        expectedDirectories.add(parts.slice(0, depth).join("/").toLowerCase());
    }
    async function sourceGuard() {
      await directoryChain(source);
      if (!same(await fs.lstat(source), sourceIdentity))
        throw new Error("发布快照根目录在打包期间被替换。");
    }
    async function inspect(initial = false) {
      await sourceGuard();
      let count = 0;
      async function walk(directory, depth) {
        if (depth > 64) throw new Error("发布快照目录层级过深。");
        if (
          !expectedDirectories.has(
            path
              .relative(source, directory)
              .split(path.sep)
              .join("/")
              .toLowerCase(),
          )
        )
          throw new Error("发布快照出现清单以外的额外目录。");
        await directoryChain(directory);
        const dirInfo = await fs.lstat(directory),
          key = canonical(directory);
        if (initial) initialDirectories.set(key, identity(dirInfo));
        else if (!same(dirInfo, initialDirectories.get(key)))
          throw new Error("发布快照出现额外目录或目录被替换。");
        for (const entry of await fs.readdir(directory, {
          withFileTypes: true,
        })) {
          cancelled(signal);
          const filePath = path.join(directory, entry.name),
            name = relativeName(path.relative(source, filePath));
          const info = await fs.lstat(filePath);
          if (info.isSymbolicLink())
            throw new Error("发布快照不能包含链接或目录联接。");
          if (info.isDirectory()) {
            await walk(filePath, depth + 1);
            continue;
          }
          const reviewed = expected.get(name.toLowerCase());
          if (
            !reviewed ||
            reviewed.name !== name ||
            !info.isFile() ||
            info.nlink !== 1 ||
            info.ino !== reviewed.targetIno ||
            info.dev !== reviewed.targetDev ||
            info.size !== reviewed.size
          )
            throw new Error("发布快照文件已修改、被替换或出现额外内容。");
          if (initial)
            initialFiles.set(name, {
              ...identity(info),
              size: info.size,
              mtimeMs: info.mtimeMs,
              ctimeMs: info.ctimeMs,
            });
          else {
            const previous = initialFiles.get(name);
            if (
              !same(info, previous) ||
              info.mtimeMs !== previous.mtimeMs ||
              info.ctimeMs !== previous.ctimeMs
            )
              throw new Error("发布快照在打包期间发生变化。");
          }
          count++;
        }
      }
      await walk(source, 0);
      if (count !== plan.files.length)
        throw new Error("发布快照文件与已审阅清单不一致。");
      await sourceGuard();
    }
    await inspect(true);
    cancelled(signal);
    await directoryChain(storage, true);
    const storageIdentity = identity(await fs.lstat(storage));
    const directory = path.join(storage, "archive-" + randomUUID());
    await fs.mkdir(directory);
    const directoryIdentity = identity(await fs.lstat(directory)),
      archivePath = path.join(directory, "content.zip");
    const owner = { identity: null, bytes: 0, hash: sha(Buffer.alloc(0)) };
    async function outputGuard() {
      await directoryChain(directory);
      if (
        !same(await fs.lstat(storage), storageIdentity) ||
        !same(await fs.lstat(directory), directoryIdentity)
      )
        throw new Error("ZIP 暂存目录在打包期间被替换。");
    }
    async function outputDigest(ignoreSignal = false) {
      if (!ignoreSignal) cancelled(signal);
      await outputGuard();
      const before = await fs.lstat(archivePath);
      if (
        !before.isFile() ||
        before.isSymbolicLink() ||
        before.nlink !== 1 ||
        !same(before, owner.identity)
      )
        throw new Error("ZIP 产物已被替换或包含链接。");
      const handle = await fs.open(archivePath, "r");
      try {
        if (!same(await handle.stat(), before))
          throw new Error("ZIP 产物在校验时被替换。");
        const digest = createHash("sha256"),
          buffer = Buffer.allocUnsafe(1024 * 1024);
        let bytes = 0;
        while (true) {
          if (!ignoreSignal) cancelled(signal);
          const { bytesRead } = await handle.read(
            buffer,
            0,
            buffer.length,
            null,
          );
          if (!bytesRead) break;
          bytes += bytesRead;
          if (bytes >= maxArchiveBytes)
            throw new Error("ZIP 压缩结果必须严格小于允许的大小上限。");
          digest.update(buffer.subarray(0, bytesRead));
        }
        const after = await handle.stat();
        if (
          !same(after, before) ||
          after.size !== before.size ||
          after.mtimeMs !== before.mtimeMs ||
          after.ctimeMs !== before.ctimeMs
        )
          throw new Error("ZIP 产物在校验期间发生变化。");
        return { bytes, sha256: digest.digest("hex"), stat: after };
      } finally {
        await handle.close();
      }
    }
    async function cleanup() {
      let removed = false;
      try {
        await outputGuard();
        const file = await optional(archivePath);
        if (file) {
          if (!owner.identity || file.size !== owner.bytes)
            return { removed: false, retainedPath: directory };
          const verified = await outputDigest(true);
          if (verified.bytes !== owner.bytes || verified.sha256 !== owner.hash)
            return { removed: false, retainedPath: directory };
          await outputGuard();
          const current = await fs.lstat(archivePath);
          if (
            !same(current, owner.identity) ||
            current.nlink !== 1 ||
            current.size !== verified.bytes ||
            current.mtimeMs !== verified.stat.mtimeMs ||
            current.ctimeMs !== verified.stat.ctimeMs
          )
            return { removed: false, retainedPath: directory };
          await fs.unlink(archivePath);
        }
        await outputGuard();
        await fs.rmdir(directory);
        removed = true;
      } catch {
        try {
          await directoryChain(storage);
          if (
            same(await fs.lstat(storage), storageIdentity) &&
            !(await optional(directory))
          )
            removed = true;
        } catch {}
      }
      return { removed, retainedPath: removed ? null : directory };
    }
    let output,
      archive,
      writing,
      failure = null,
      processedBytes = 0,
      filesDone = 0;
    const streams = new Set(),
      pendingOpeners = new Set(),
      closes = new Set();
    const progress = async (stage) => {
      if (typeof onProgress === "function") {
        try {
          await onProgress({
            stage,
            processedBytes,
            totalBytes: plan.total,
            filesDone,
            fileCount: plan.files.length,
          });
        } catch {}
      }
    };
    function fail(error) {
      if (failure) return;
      failure = error;
      if (archive) {
        archive.errored = true;
        archive.outputStream.destroy(error);
      }
      for (const stream of streams) stream.destroy(error);
    }
    const abortHandler = () => {
      try {
        cancelled(signal);
      } catch (error) {
        fail(error);
      }
    };
    async function openSource(reviewed) {
      cancelled(signal);
      if (failure) throw failure;
      await sourceGuard();
      const filename = path.join(source, reviewed.relative);
      await directoryChain(path.dirname(filename));
      const before = await fs.lstat(filename),
        initial = initialFiles.get(reviewed.name);
      if (
        !before.isFile() ||
        before.isSymbolicLink() ||
        before.nlink !== 1 ||
        !same(before, initial) ||
        before.size !== reviewed.size ||
        before.mtimeMs !== initial.mtimeMs ||
        before.ctimeMs !== initial.ctimeMs
      )
        throw new Error("发布快照在懒读取前已修改或被替换。");
      const handle = await fs.open(filename, "r");
      let handedOff = false,
        closeResolve,
        closePromise;
      const closed = new Promise((resolve) => {
        closeResolve = resolve;
      });
      closes.add(closed);
      const close = () =>
        (closePromise ||= (async () => {
          try {
            await handle.close();
          } finally {
            closeResolve();
            closes.delete(closed);
          }
        })());
      try {
        if (failure) throw failure;
        cancelled(signal);
        await sourceGuard();
        const actual = await handle.stat();
        if (
          !same(actual, before) ||
          actual.size !== reviewed.size ||
          actual.nlink !== 1 ||
          !same(await fs.lstat(filename), before)
        )
          throw new Error("发布快照在打开时发生变化。");
        async function* chunks() {
          const digest = createHash("sha256"),
            buffer = Buffer.allocUnsafe(1024 * 1024);
          let bytes = 0;
          try {
            while (true) {
              cancelled(signal);
              if (failure) throw failure;
              await sourceGuard();
              const { bytesRead } = await handle.read(
                buffer,
                0,
                buffer.length,
                null,
              );
              if (!bytesRead) break;
              bytes += bytesRead;
              if (bytes > reviewed.size)
                throw new Error("发布文件在读取时增大。");
              const chunk = Buffer.from(buffer.subarray(0, bytesRead));
              digest.update(chunk);
              processedBytes += bytesRead;
              await progress("archiving");
              cancelled(signal);
              if (failure) throw failure;
              yield chunk;
            }
            const after = await handle.stat();
            await sourceGuard();
            await directoryChain(path.dirname(filename));
            const current = await fs.lstat(filename);
            if (
              bytes !== reviewed.size ||
              digest.digest("hex") !== reviewed.hash ||
              !same(after, before) ||
              after.size !== before.size ||
              after.mtimeMs !== before.mtimeMs ||
              after.ctimeMs !== before.ctimeMs ||
              after.nlink !== 1 ||
              !same(current, before) ||
              current.nlink !== 1
            )
              throw new Error("读入 ZIP 的内容与已审阅文件摘要或身份不一致。");
            filesDone++;
          } finally {
            await close();
          }
        }
        const stream = Readable.from(chunks(), {
          objectMode: false,
          highWaterMark: 64 * 1024,
        });
        streams.add(stream);
        stream.once("close", () => {
          streams.delete(stream);
          void close().catch(fail);
        });
        stream.on("error", fail);
        handedOff = true;
        return stream;
      } finally {
        if (!handedOff) await close();
      }
    }
    try {
      await outputGuard();
      output = await fs.open(archivePath, "wx");
      owner.identity = identity(await output.stat());
      await outputGuard();
      if (!same(await fs.lstat(archivePath), owner.identity))
        throw new Error("ZIP 输出文件被替换。");
      archive = new yazl.ZipFile();
      archive.on("error", fail);
      archive.outputStream.on("error", () => {});
      signal?.addEventListener("abort", abortHandler, { once: true });
      cancelled(signal);
      const digest = createHash("sha256");
      writing = (async () => {
        try {
          for await (const chunk of archive.outputStream) {
            cancelled(signal);
            await outputGuard();
            if (owner.bytes + chunk.length >= maxArchiveBytes)
              throw new Error(
                "ZIP 压缩结果必须严格小于允许的大小上限（默认 5 GiB）。",
              );
            let offset = 0;
            while (offset < chunk.length) {
              const { bytesWritten } = await output.write(
                chunk,
                offset,
                chunk.length - offset,
                null,
              );
              if (!bytesWritten) throw new Error("无法写入发布 ZIP。");
              digest.update(chunk.subarray(offset, offset + bytesWritten));
              owner.bytes += bytesWritten;
              offset += bytesWritten;
            }
          }
        } catch (error) {
          fail(error);
          throw error;
        } finally {
          owner.hash = digest.digest("hex");
        }
      })();
      // Attach immediately so a disk or cap failure cannot become an unhandled rejection.
      writing.catch(() => {});
      for (const reviewed of plan.files) {
        archive.addReadStreamLazy(
          reviewed.name,
          {
            size: reviewed.size,
            compressionLevel: 1,
            mode: 0o100644,
            mtime: new Date(initialFiles.get(reviewed.name).mtimeMs),
          },
          (callback) => {
            const pending = openSource(reviewed).then((stream) => {
              if (failure) {
                stream.destroy(failure);
                callback(failure);
              } else callback(null, stream);
            }, callback);
            pendingOpeners.add(pending);
            void pending
              .finally(() => pendingOpeners.delete(pending))
              .catch(fail);
          },
        );
      }
      archive.end();
      await writing;
      await Promise.allSettled([...pendingOpeners]);
      await Promise.allSettled([...closes]);
      if (failure) throw failure;
      await output.close();
      output = null;
      cancelled(signal);
      await progress("verifying");
      cancelled(signal);
      await inspect();
      const verified = await outputDigest();
      if (verified.bytes !== owner.bytes || verified.sha256 !== owner.hash)
        throw new Error("完成的 ZIP 与写入摘要不一致。");
      const zip = await yauzl.openPromise(archivePath, {
        autoClose: false,
        lazyEntries: true,
        strictFileNames: true,
        validateEntrySizes: true,
      });
      try {
        if (zip.entryCount !== plan.files.length)
          throw new Error("完成的 ZIP 文件清单不一致。");
        const seen = new Set();
        for await (const entry of zip.eachEntry()) {
          cancelled(signal);
          const file = expected.get(entry.fileName.toLowerCase());
          if (
            !file ||
            seen.has(entry.fileName) ||
            file.name !== entry.fileName ||
            file.size !== entry.uncompressedSize ||
            entry.compressionMethod !== 8
          )
            throw new Error("完成的 ZIP 目录结构与审阅清单不一致。");
          seen.add(entry.fileName);
        }
        if (seen.size !== plan.files.length)
          throw new Error("完成的 ZIP 存在文件缺失。");
      } finally {
        await new Promise((resolve) => {
          zip.once("close", resolve);
          zip.close();
        });
      }
      await outputGuard();
      await inspect();
      cancelled(signal);
      const last = await fs.lstat(archivePath);
      if (
        !same(last, owner.identity) ||
        last.size !== verified.bytes ||
        last.mtimeMs !== verified.stat.mtimeMs ||
        last.ctimeMs !== verified.stat.ctimeMs ||
        last.nlink !== 1
      )
        throw new Error("ZIP 在交付前被修改或替换。");
      return {
        path: archivePath,
        bytes: owner.bytes,
        sha256: owner.hash,
        cleanup,
      };
    } catch (error) {
      fail(error);
      if (writing) await writing.catch(() => {});
      await Promise.allSettled([...pendingOpeners]);
      await Promise.allSettled([...closes]);
      if (output) {
        await output.close().catch(() => {});
        output = null;
      }
      const result = await cleanup();
      if (!result.removed) {
        error.retainedPath = result.retainedPath;
        error.message +=
          " 临时 ZIP 或外来文件已保留，请检查：" + result.retainedPath;
      }
      throw error;
    } finally {
      signal?.removeEventListener("abort", abortHandler);
    }
  }
  return { createArchive };
}

module.exports = { createPublishArchiveService };
