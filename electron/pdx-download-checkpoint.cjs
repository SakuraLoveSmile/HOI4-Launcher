"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");

const canonical = (value) => path.resolve(value).toLowerCase();
const object = (value) =>
  value && typeof value === "object" && !Array.isArray(value);
const hex = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const decimal = (value) =>
  typeof value === "string" && /^\d{1,40}$/.test(value);
const identity = (stat) => ({
  ino: stat.ino,
  dev: stat.dev,
  birthtimeMs: stat.birthtimeMs,
  size: stat.size,
  mtimeMs: stat.mtimeMs,
  ctimeMs: stat.ctimeMs,
});
const same = (stat, expected) =>
  expected &&
  !stat.isSymbolicLink() &&
  stat.ino === expected.ino &&
  stat.dev === expected.dev &&
  stat.birthtimeMs === expected.birthtimeMs;
const exact = (stat, expected) =>
  same(stat, expected) &&
  stat.isFile() &&
  stat.nlink === 1 &&
  stat.size === expected.size &&
  stat.mtimeMs === expected.mtimeMs &&
  stat.ctimeMs === expected.ctimeMs;
const sameBig = (stat, expected) =>
  expected &&
  ["dev", "ino", "birthtimeNs"].every(
    (key) => String(stat[key]) === expected[key],
  );
const stagingPath = (root, staging) =>
  object(staging) && /^download-[A-Za-z0-9]+$/.test(staging.directory)
    ? path.join(root, staging.directory)
    : null;

function planSnapshot(value) {
  if (!object(value)) throw new Error("下载计划无效。");
  const result = Object.fromEntries(
    [
      "modId",
      "revision",
      "name",
      "platform",
      "filename",
      "archiveUrl",
      "bytes",
      "sha256",
      "access",
      "kind",
      "fromRevision",
      "unpackedBytes",
    ].map((key) => [key, value[key]]),
  );
  if (
    !/^[1-9]\d{0,19}$/.test(result.modId) ||
    !/^[1-9]\d{0,19}$/.test(result.revision) ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(result.name) ||
    !/^(Any|Windows)__[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(result.platform) ||
    typeof result.filename !== "string" ||
    !(result.kind === "patch"
      ? result.filename === `${result.fromRevision}_to_${result.revision}.zip`
      : /^[A-Za-z0-9][A-Za-z0-9._-]{0,195}\.zip$/.test(result.filename)) ||
    result.filename.includes("..") ||
    !Number.isSafeInteger(result.bytes) ||
    result.bytes < 1 ||
    !hex(result.sha256) ||
    (result.access !== undefined && result.access !== "repository") ||
    (result.kind !== undefined && result.kind !== "patch") ||
    (result.kind === "patch"
      ? !(
          typeof result.fromRevision === "string" &&
          (result.fromRevision === "-1" ||
            (/^[1-9]\d{0,15}$/.test(result.fromRevision) &&
              Number.isSafeInteger(Number(result.fromRevision)))) &&
          !/[\r\n]/.test(result.fromRevision) &&
          result.fromRevision !== result.revision &&
          Number.isSafeInteger(result.unpackedBytes) &&
          result.unpackedBytes >= 0 &&
          result.unpackedBytes <= 5 * 1024 ** 3 + 65536
        )
      : result.fromRevision !== undefined ||
        result.unpackedBytes !== undefined) ||
    result.archiveUrl !==
      `https://modscontent.paradox-interactive.com/hoi4/${result.name}/repo/${result.platform}/${result.revision}/${result.kind === "patch" ? `${result.fromRevision}_to_${result.revision}` : "complete"}/${result.filename}`
  )
    throw new Error("下载计划无效。");
  result.modId = String(result.modId);
  result.revision = String(result.revision);
  if (result.access === undefined) delete result.access;
  if (result.kind === undefined) {
    delete result.kind;
    delete result.fromRevision;
    delete result.unpackedBytes;
  }
  if (typeof value.title === "string") result.title = value.title.slice(0, 200);
  if (typeof value.supportedVersion === "string")
    result.supportedVersion = value.supportedVersion.slice(0, 80);
  return result;
}

function planKey(plan) {
  const value = planSnapshot(plan);
  return createHash("sha256")
    .update(
      JSON.stringify(
        Object.fromEntries(
          [
            "modId",
            "revision",
            "name",
            "platform",
            "filename",
            "archiveUrl",
            "bytes",
            "sha256",
            "access",
            "kind",
            "fromRevision",
            "unpackedBytes",
          ].map((key) => [key, value[key]]),
        ),
      ),
    )
    .digest("hex");
}

function checkedCheckpoint(value, plan, source) {
  if (
    !object(value) ||
    value.version !== 1 ||
    value.planKey !== planKey(plan) ||
    !Number.isSafeInteger(value.receivedBytes) ||
    value.receivedBytes < 0 ||
    value.receivedBytes > plan.bytes ||
    !hex(value.prefixSha256) ||
    (value.etag !== null &&
      (typeof value.etag !== "string" ||
        value.etag.length > 2048 ||
        /[\r\n\0]/.test(value.etag))) ||
    !object(value.identity) ||
    !object(value.identity.file) ||
    !["dev", "ino", "birthtimeNs"].every((key) =>
      decimal(value.identity.file[key]),
    ) ||
    !Array.isArray(value.identity.ancestors)
  )
    throw new Error("下载断点记录无效，请保留文件并取消当前任务后重新下载。");
  const chain = [];
  let current = path.dirname(source);
  for (;;) {
    chain.unshift(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (
    chain.length !== value.identity.ancestors.length ||
    value.identity.ancestors.some(
      (entry, index) =>
        !object(entry) ||
        typeof entry.path !== "string" ||
        !path.isAbsolute(entry.path) ||
        canonical(entry.path) !== canonical(chain[index]) ||
        !["dev", "ino", "birthtimeNs"].every((key) => decimal(entry[key])),
    )
  )
    throw new Error("下载断点路径无效，请保留文件并取消当前任务后重新下载。");
  return {
    version: 1,
    planKey: value.planKey,
    receivedBytes: value.receivedBytes,
    prefixSha256: value.prefixSha256,
    etag: value.etag,
    identity: {
      file: Object.fromEntries(
        ["dev", "ino", "birthtimeNs"].map((key) => [
          key,
          value.identity.file[key],
        ]),
      ),
      ancestors: value.identity.ancestors.map((entry) => ({
        path: path.resolve(entry.path),
        dev: entry.dev,
        ino: entry.ino,
        birthtimeNs: entry.birthtimeNs,
      })),
    },
  };
}

async function checkpointFile(source, checkpoint) {
  for (const ancestor of checkpoint.identity.ancestors) {
    const info = await fs.lstat(ancestor.path, { bigint: true });
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      !sameBig(info, ancestor) ||
      canonical(await fs.realpath(ancestor.path)) !== canonical(ancestor.path)
    )
      throw new Error("下载断点所在目录已被替换。");
  }
  const big = await fs.lstat(source, { bigint: true });
  if (
    !big.isFile() ||
    big.isSymbolicLink() ||
    big.nlink !== 1n ||
    !sameBig(big, checkpoint.identity.file) ||
    big.size < BigInt(checkpoint.receivedBytes)
  )
    throw new Error("下载断点文件已被替换或缩短。");
  return fs.lstat(source);
}

async function cleanStaging(root, realRoot, staging, partial, guard) {
  const directory = stagingPath(root, staging);
  if (!directory) return !staging;
  try {
    await guard();
    if (
      !same(await fs.lstat(directory), staging.identity) ||
      canonical(await fs.realpath(directory)) !==
        canonical(path.join(realRoot, staging.directory))
    )
      return false;
    const patch = partial?.transferPlan?.kind === "patch";
    const archive = path.join(directory, patch ? "patch.zip" : "content.zip");
    const artifacts = patch ? staging.artifacts || [] : [];
    if (
      !Array.isArray(artifacts) ||
      artifacts.length > 2 ||
      new Set(artifacts.map((item) => item?.name)).size !== artifacts.length
    )
      return false;
    async function stageGuard() {
      await guard();
      if (
        !same(await fs.lstat(directory), staging.identity) ||
        canonical(await fs.realpath(directory)) !==
          canonical(path.join(realRoot, staging.directory))
      )
        throw new Error("staging changed");
    }
    for (const item of artifacts) {
      if (
        !item ||
        !["content.zip", "patch-data.bin"].includes(item.name) ||
        !hex(item.sha256) ||
        !Number.isSafeInteger(item.bytes) ||
        item.bytes < 0 ||
        item.bytes > 5 * 1024 ** 3 ||
        item.identity?.size !== item.bytes
      )
        return false;
      await stageGuard();
      const file = path.join(directory, item.name);
      if (!exact(await fs.lstat(file), item.identity)) return false;
      const handle = await fs.open(file, "r");
      try {
        if (!exact(await handle.stat(), item.identity)) return false;
        const hash = createHash("sha256"),
          block = Buffer.alloc(65536);
        for (let offset = 0; offset < item.bytes; ) {
          await stageGuard();
          if (
            !exact(await fs.lstat(file), item.identity) ||
            !exact(await handle.stat(), item.identity)
          )
            return false;
          const { bytesRead } = await handle.read(
            block,
            0,
            Math.min(block.length, item.bytes - offset),
            offset,
          );
          if (!bytesRead) return false;
          hash.update(block.subarray(0, bytesRead));
          offset += bytesRead;
        }
        if (
          hash.digest("hex") !== item.sha256 ||
          !exact(await handle.stat(), item.identity)
        )
          return false;
      } finally {
        await handle.close();
      }
    }
    if (patch) {
      const names = await fs.readdir(directory);
      if (
        names.some(
          (name) =>
            name !== "patch.zip" &&
            !artifacts.some((item) => item.name === name),
        )
      )
        return false;
    }
    let info;
    try {
      info = await fs.lstat(archive);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (info) {
      if (!staging.archiveIdentity || !exact(info, staging.archiveIdentity))
        return false;
      if (partial?.checkpoint) {
        const cp = checkedCheckpoint(
          partial.checkpoint,
          partial.transferPlan || partial.plan,
          archive,
        );
        if (info.size !== cp.receivedBytes) return false; // Never truncate or delete an unknown tail.
        await checkpointFile(archive, cp);
        const handle = await fs.open(archive, "r");
        try {
          if (!sameBig(await handle.stat({ bigint: true }), cp.identity.file))
            return false;
          const hash = createHash("sha256"),
            buffer = Buffer.allocUnsafe(64 * 1024);
          let length = 0;
          while (length < info.size) {
            const { bytesRead } = await handle.read(
              buffer,
              0,
              Math.min(buffer.length, info.size - length),
              length,
            );
            if (!bytesRead) return false;
            hash.update(buffer.subarray(0, bytesRead));
            length += bytesRead;
          }
          if (
            hash.digest("hex") !== cp.prefixSha256 ||
            !exact(await handle.stat(), staging.archiveIdentity)
          )
            return false;
        } finally {
          await handle.close();
        }
      }
      await guard();
      if (
        !exact(await fs.lstat(archive), staging.archiveIdentity) ||
        canonical(await fs.realpath(archive)) !==
          canonical(
            path.join(
              realRoot,
              staging.directory,
              patch ? "patch.zip" : "content.zip",
            ),
          )
      )
        return false;
      await fs.unlink(archive);
    }
    for (const item of artifacts) {
      await stageGuard();
      const file = path.join(directory, item.name);
      if (!exact(await fs.lstat(file), item.identity)) return false;
      await fs.unlink(file);
    }
    await fs.rmdir(directory);
    return true;
  } catch (error) {
    if (error.code !== "ENOENT") return false;
    // A missing proven artifact must not hide a still-existing workspace.
    // Only an already-absent task directory counts as successful cleanup.
    try {
      await fs.lstat(directory);
      return false;
    } catch (directoryError) {
      return directoryError.code === "ENOENT";
    }
  }
}

module.exports = {
  identity,
  same,
  stagingPath,
  planSnapshot,
  planKey,
  checkedCheckpoint,
  checkpointFile,
  cleanStaging,
};
