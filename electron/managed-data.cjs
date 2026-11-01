"use strict";

const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const samePath = (a, b) =>
  path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
function inside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return (
    relative !== "" &&
    !relative.startsWith(".." + path.sep) &&
    relative !== ".." &&
    !path.isAbsolute(relative)
  );
}
async function directory(target, create = false) {
  const absolute = path.resolve(target),
    parent = path.dirname(absolute);
  if (parent !== absolute) await directory(parent, create);
  let stat;
  try {
    stat = await fs.lstat(absolute);
  } catch (error) {
    if (!create || error.code !== "ENOENT") throw error;
    try {
      await fs.mkdir(absolute);
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
    stat = await fs.lstat(absolute);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("目录包含链接或已被替换，请检查后重试。");
  return absolute;
}
const identity = (a, b) =>
  a.dev === b.dev &&
  a.ino === b.ino &&
  a.size === b.size &&
  a.mtimeMs === b.mtimeMs &&
  a.ctimeMs === b.ctimeMs &&
  b.nlink === 1;
async function file(target, limit = 16 * 1024 ** 2) {
  await directory(path.dirname(target));
  const stat = await fs.lstat(target);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.size > limit
  )
    throw new Error("文件包含链接、类型不受支持或超过大小限制。");
  return stat;
}
async function read(target, limit, optional = false) {
  let handle;
  try {
    const before = await file(target, limit);
    handle = await fs.open(target, "r");
    if (!identity(before, await handle.stat()))
      throw new Error("文件在读取时发生变化，请重试。");
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (!result.bytesRead) throw new Error("文件读取不完整。");
      offset += result.bytesRead;
    }
    if (
      !identity(before, await handle.stat()) ||
      !identity(before, await file(target, limit))
    )
      throw new Error("文件在读取时发生变化，请重试。");
    return bytes;
  } catch (error) {
    if (optional && error.code === "ENOENT") return null;
    throw error;
  } finally {
    await handle?.close();
  }
}
async function atomic(target, bytes, expected) {
  await directory(path.dirname(target), true);
  const current = await read(target, 16 * 1024 ** 2, true);
  if (
    expected !== undefined &&
    !(current === null
      ? expected === null
      : Buffer.isBuffer(expected) && current.equals(expected))
  )
    throw new Error("记录已被外部修改，原文件已保留，请刷新后重试。");
  const temporary = path.join(path.dirname(target), ".write-" + randomUUID());
  const handle = await fs.open(temporary, "wx");
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (current === null) {
    // A reader's earlier absence check cannot authorize replacing a new file.
    await installExclusive(temporary, target);
    return;
  }
  const again = await read(target, 16 * 1024 ** 2, true);
  if (again === null || !current.equals(again))
    throw new Error("记录已被外部修改，暂存文件已保留。");
  const previous = path.join(path.dirname(target), ".previous-" + randomUUID());
  let moved = false;
  try {
    await directory(path.dirname(target));
    // Move the actual file first: external writes after the last read remain
    // recoverable, even when they arrive immediately before this rename.
    await fs.rename(target, previous);
    moved = true;
    const displaced = await read(previous, 16 * 1024 ** 2);
    if (!current.equals(displaced))
      throw new Error("记录已被外部修改，搬走的实际文件已保留。");
    await installExclusive(temporary, target);
  } catch (error) {
    if (moved) {
      // Retain .previous even after successful recovery. It is user content,
      // and an intervening writer may have changed it before the move.
      const recovery = path.join(
        path.dirname(target),
        ".recover-" + randomUUID(),
      );
      try {
        let occupied = false;
        try {
          await fs.lstat(target);
          occupied = true;
        } catch (statError) {
          if (statError.code !== "ENOENT") throw statError;
        }
        if (!occupied) {
          await copyFile(previous, recovery, 16 * 1024 ** 2);
          await installExclusive(recovery, target);
        }
      } catch {
        // Failed recovery must never remove evidence or replace a new target.
      }
    }
    throw Object.assign(
      new Error(
        "记录提交未完成；原文件或 .previous-* 保留文件及暂存内容均已保留。" +
          error.message,
        { cause: error },
      ),
      error.code ? { code: error.code } : {},
    );
  }
}

const sameContentFile = (a, b) =>
  a.dev === b.dev &&
  a.ino === b.ino &&
  a.birthtimeMs === b.birthtimeMs &&
  a.size === b.size &&
  a.mtimeMs === b.mtimeMs;

async function installExclusive(staged, target) {
  if (samePath(staged, target)) throw new Error("暂存文件与目标不能相同。");
  await directory(path.dirname(target));
  const before = await file(staged, 4 * 1024 ** 3);
  const handle = await fs.open(
    staged,
    constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
  );
  try {
    if (!identity(before, await handle.stat()))
      throw new Error("暂存文件在安装前发生变化，文件已保留。");
    await directory(path.dirname(staged));
    await directory(path.dirname(target));
    // link is the no-replace commit: EEXIST preserves both the external target
    // and our verified staging file. A successful unlink leaves nlink === 1.
    await fs.link(staged, target);
    const source = await fs.lstat(staged),
      installed = await fs.lstat(target);
    if (
      !source.isFile() ||
      source.isSymbolicLink() ||
      !installed.isFile() ||
      installed.isSymbolicLink() ||
      source.nlink !== 2 ||
      installed.nlink !== 2 ||
      !sameContentFile(before, source) ||
      !sameContentFile(before, installed) ||
      !sameContentFile(before, await handle.stat())
    )
      throw new Error("文件在独占安装期间发生变化，两处文件均已保留。");
    await directory(path.dirname(staged));
    await directory(path.dirname(target));
    const ownStage = await fs.lstat(staged),
      ownTarget = await fs.lstat(target);
    if (
      ownStage.nlink !== 2 ||
      ownTarget.nlink !== 2 ||
      !sameContentFile(source, ownStage) ||
      !sameContentFile(installed, ownTarget) ||
      ownStage.ctimeMs !== source.ctimeMs ||
      ownTarget.ctimeMs !== installed.ctimeMs
    )
      throw new Error("文件在提交前发生变化，暂存文件与目标均已保留。");
    await fs.unlink(staged);
    const result = await file(target, 4 * 1024 ** 3);
    if (!sameContentFile(before, result))
      throw new Error("目标文件在安装完成时发生变化，请检查保留文件。");
  } finally {
    await handle.close();
  }
}
function checkCancellation(signal) {
  if (signal?.aborted)
    throw Object.assign(new Error("已取消文件复制或校验，未完成文件已保留。"), {
      name: "AbortError",
      code: "ABORT_ERR",
    });
}
async function copyFile(
  source,
  destination,
  limit = 4 * 1024 ** 3,
  { signal } = {},
) {
  checkCancellation(signal);
  const before = await file(source, limit);
  await directory(path.dirname(destination), true);
  let input, output;
  const hash = createHash("sha256"),
    buffer = Buffer.alloc(1024 * 1024);
  let offset = 0;
  try {
    input = await fs.open(source, "r");
    output = await fs.open(destination, "wx");
    if (!identity(before, await input.stat()))
      throw new Error("来源文件已变化，请重试。");
    while (offset < before.size) {
      checkCancellation(signal);
      const { bytesRead } = await input.read(
        buffer,
        0,
        Math.min(buffer.length, before.size - offset),
        offset,
      );
      if (!bytesRead) throw new Error("来源文件读取不完整。");
      hash.update(buffer.subarray(0, bytesRead));
      let written = 0;
      while (written < bytesRead)
        written += (await output.write(buffer, written, bytesRead - written))
          .bytesWritten;
      offset += bytesRead;
    }
    await output.sync();
    checkCancellation(signal);
    if (
      !identity(before, await input.stat()) ||
      !identity(before, await file(source, limit))
    )
      throw new Error("来源文件在复制时变化，暂存副本已保留，请重新操作。");
  } finally {
    await input?.close();
    await output?.close();
  }
  const result = { bytes: offset, sha256: hash.digest("hex") };
  if (
    (await digestFile(destination, limit, { signal })).sha256 !== result.sha256
  )
    throw new Error("复制后文件校验失败，原文件已保留。");
  return result;
}
async function digestFile(target, limit = 4 * 1024 ** 3, { signal } = {}) {
  checkCancellation(signal);
  const before = await file(target, limit),
    handle = await fs.open(target, "r");
  const hash = createHash("sha256"),
    buffer = Buffer.alloc(1024 * 1024);
  let offset = 0;
  try {
    if (!identity(before, await handle.stat())) throw new Error("文件已变化。");
    while (offset < before.size) {
      checkCancellation(signal);
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, before.size - offset),
        offset,
      );
      if (!bytesRead) throw new Error("文件读取不完整。");
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    checkCancellation(signal);
    if (
      !identity(before, await handle.stat()) ||
      !identity(before, await file(target, limit))
    )
      throw new Error("文件在校验时变化，请重试。");
    return { bytes: offset, sha256: hash.digest("hex") };
  } finally {
    await handle.close();
  }
}
module.exports = {
  UUID,
  sha256,
  samePath,
  inside,
  directory,
  file,
  read,
  atomic,
  installExclusive,
  copyFile,
  digestFile,
};
