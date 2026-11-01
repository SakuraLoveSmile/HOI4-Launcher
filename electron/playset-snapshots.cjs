"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { TextDecoder } = require("node:util");
const yauzl = require("yauzl");
const data = require("./managed-data.cjs");
const { parseDescriptor } = require("./mod-authoring.cjs");
const {
  normalizePdxPatchPath,
  pdxPatchPathKey,
} = require("./pdx-patch-path.cjs");
const {
  captureEnvironment,
  validateEnvironment,
  fingerprintMods,
  FINGERPRINT_LIMITS: LIMITS,
} = require("./launch-environment.cjs");

const MAX_JSON = 16 * 1024 ** 2,
  MAX_DESCRIPTOR = 1024 ** 2;
const clone = (v) => structuredClone(v);
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const digest = (v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const timestamp = (v) =>
  typeof v === "string" && v.length < 64 && Number.isFinite(Date.parse(v));
const sameStat = (a, b) =>
  a.dev === b.dev &&
  a.ino === b.ino &&
  a.size === b.size &&
  a.mtimeNs === b.mtimeNs &&
  a.ctimeNs === b.ctimeNs &&
  a.nlink === b.nlink &&
  a.birthtimeNs === b.birthtimeNs;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function failure(message = "组合快照损坏或内容发生变化，原始文件已保留。") {
  return new Error(message);
}
function id(v) {
  if (typeof v !== "string" || !data.UUID.test(v))
    throw failure("组合快照标识无效。");
  return v;
}
function title(v) {
  if (
    typeof v !== "string" ||
    !v.trim() ||
    v.trim().length > 128 ||
    /[\0-\x1f\x7f]/.test(v)
  )
    throw failure("组合快照名称须为 1 至 128 个普通字符。");
  return v.trim();
}
function aborted(signal) {
  if (signal?.aborted)
    throw Object.assign(failure("已取消组合快照操作，未完成内容已保留。"), {
      name: "AbortError",
      code: "ABORT_ERR",
    });
}
function relative(v) {
  try {
    const name = normalizePdxPatchPath(v);
    if (name !== v) throw failure();
    return name;
  } catch {
    throw failure("模组包含不安全路径或 Windows 路径冲突。");
  }
}
function namespace(seen, name, directory, explicit = true) {
  const parts = name.split("/");
  for (let i = 1; i <= parts.length; i++) {
    const current = parts.slice(0, i).join("/"),
      key = pdxPatchPathKey(current),
      leaf = i === parts.length;
    const type = !leaf || directory ? "directory" : "file",
      old = seen.get(key);
    if (
      old &&
      (old.name !== current ||
        old.type !== type ||
        (leaf && explicit && old.explicit))
    )
      throw failure("模组包含重复文件、大小写冲突或文件与目录冲突。");
    seen.set(key, {
      name: current,
      type,
      explicit: Boolean(old?.explicit || (leaf && explicit)),
    });
  }
}
function bound(bytes, entries) {
  if (
    !Number.isSafeInteger(bytes) ||
    bytes < 0 ||
    bytes > LIMITS.modBytes ||
    !Number.isSafeInteger(entries) ||
    entries < 0 ||
    entries > LIMITS.modEntries
  )
    throw failure("模组内容超过单项 20 GiB 或 100000 项上限。");
}
function totalBound(mods) {
  const totalBytes = mods.reduce((n, m) => n + m.bytes, 0),
    expandedBytes = mods.reduce((n, m) => n + m.expandedBytes, 0),
    totalEntries = mods.reduce((n, m) => n + m.entries, 0);
  if (
    totalBytes > LIMITS.totalBytes ||
    expandedBytes > LIMITS.totalBytes ||
    totalEntries > LIMITS.totalEntries
  )
    throw failure("组合内容超过总计 100 GiB 或 200000 项上限。");
  return totalBytes;
}
async function safeStat(filename) {
  await data.directory(path.dirname(filename));
  const stat = await fs.lstat(filename, { bigint: true });
  if (
    stat.isSymbolicLink() ||
    (!stat.isDirectory() && !stat.isFile()) ||
    (stat.isFile() && stat.nlink !== 1n)
  )
    throw failure("模组内容包含链接、硬链接或特殊文件。");
  return stat;
}
async function tree(root, signal) {
  const files = [],
    directories = [],
    observed = [],
    names = new Map();
  let bytes = 0,
    entries = 0;
  async function walk(filename, name) {
    aborted(signal);
    const stat = await safeStat(filename);
    if (++entries > LIMITS.modEntries) bound(bytes, entries);
    if (name) namespace(names, relative(name), stat.isDirectory());
    observed.push({ filename, stat });
    if (stat.isFile()) {
      if (stat.size > BigInt(4 * 1024 ** 3))
        throw failure("单文件超过本地项目可恢复的 4 GiB 上限。");
      bytes += Number(stat.size);
      bound(bytes, entries);
      files.push({ name, stat });
      return;
    }
    directories.push(name);
    const directory = await fs.opendir(filename);
    for await (const child of directory)
      await walk(
        path.join(filename, child.name),
        name ? `${name}/${child.name}` : child.name,
      );
  }
  await walk(root, "");
  for (const entry of observed) {
    aborted(signal);
    if (!sameStat(entry.stat, await safeStat(entry.filename)))
      throw failure("来源模组在扫描期间发生变化。");
  }
  return { files, directories, observed, bytes, entries, expandedBytes: bytes };
}
async function copyTree(source, destination, signal) {
  const before = await tree(source, signal);
  await data.directory(path.dirname(destination), true);
  await fs.mkdir(destination);
  for (const name of before.directories) {
    aborted(signal);
    if (name)
      await data.directory(path.join(destination, ...name.split("/")), true);
  }
  for (const entry of before.files) {
    aborted(signal);
    await data.copyFile(
      path.join(source, ...entry.name.split("/")),
      path.join(destination, ...entry.name.split("/")),
      LIMITS.modBytes,
      { signal },
    );
  }
  for (const entry of before.observed) {
    aborted(signal);
    if (!sameStat(entry.stat, await safeStat(entry.filename)))
      throw failure("来源模组在复制期间发生变化，未完成副本已保留。");
  }
  return before;
}
const crcTable = Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function crcUpdate(crc, bytes) {
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return crc >>> 0;
}
async function archive(source, destination, signal) {
  const before = await safeStat(source);
  if (!before.isFile()) throw failure("归档快照必须是普通 ZIP 文件。");
  bound(Number(before.size), 1);
  if (destination) {
    await data.directory(path.dirname(destination), true);
    await fs.mkdir(destination);
  }
  const zip = await yauzl.openPromise(source, {
    lazyEntries: true,
    autoClose: false,
    strictFileNames: true,
    validateEntrySizes: true,
  });
  zip.on("error", () => {});
  const names = new Map();
  let entries = 0,
    expandedBytes = 0;
  try {
    if (zip.entryCount > LIMITS.modEntries) bound(0, zip.entryCount);
    for await (const entry of zip.eachEntry()) {
      aborted(signal);
      const directory = entry.fileName.endsWith("/"),
        mode = entry.externalFileAttributes >>> 16,
        type = mode & 0xf000;
      if (
        (type && ![0x8000, 0x4000].includes(type)) ||
        (type === 0x4000 && !directory) ||
        entry.generalPurposeBitFlag & 1 ||
        ![0, 8].includes(entry.compressionMethod)
      )
        throw failure("ZIP 包含链接、特殊文件、加密内容或不支持的条目。");
      const name = relative(
        directory ? entry.fileName.slice(0, -1) : entry.fileName,
      );
      namespace(names, name, directory);
      bound(expandedBytes, names.size);
      if (
        !Number.isSafeInteger(entry.uncompressedSize) ||
        entry.uncompressedSize < 0 ||
        entry.uncompressedSize > 4 * 1024 ** 3 ||
        entry.uncompressedSize >
          Math.max(MAX_DESCRIPTOR, entry.compressedSize * 1000)
      )
        throw failure("ZIP 单文件大小或膨胀比例超过可恢复上限。");
      expandedBytes += entry.uncompressedSize;
      bound(expandedBytes, ++entries);
      const target = destination && path.join(destination, ...name.split("/"));
      if (directory) {
        if (entry.uncompressedSize) throw failure();
        if (target) await data.directory(target, true);
        continue;
      }
      let output,
        bytes = 0,
        crc = 0xffffffff;
      try {
        if (target) {
          await data.directory(path.dirname(target), true);
          output = await fs.open(target, "wx");
        }
        const stream = await zip.openReadStreamPromise(entry);
        for await (const chunk of stream) {
          aborted(signal);
          bytes += chunk.length;
          if (bytes > entry.uncompressedSize) throw failure();
          crc = crcUpdate(crc, chunk);
          if (output) await output.writeFile(chunk);
        }
        if (
          bytes !== entry.uncompressedSize ||
          (crc ^ 0xffffffff) >>> 0 !== entry.crc32
        )
          throw failure("ZIP 文件大小或 CRC 校验失败。");
        await output?.sync();
      } finally {
        await output?.close();
      }
    }
  } finally {
    zip.close();
  }
  if (!sameStat(before, await safeStat(source)))
    throw failure("ZIP 在读取期间发生变化。");
  return {
    bytes: Number(before.size),
    entries: Math.max(entries, names.size),
    expandedBytes,
  };
}
function decodeDescriptor(bytes) {
  if (bytes.length > MAX_DESCRIPTOR) throw failure("模组描述文件超过 1 MiB。");
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw failure("模组描述文件必须是 UTF-8 文本。");
  }
  if (/[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text))
    throw failure("模组描述文件包含不安全文本。");
  parseDescriptor(text);
  return text;
}

function createPlaysetSnapshotService({
  storageDirectory,
  launcher,
  projects,
  isGameRunning = async () => false,
}) {
  const root = path.resolve(storageDirectory);
  let pending = Promise.resolve(),
    count = 0,
    phase = "idle",
    progress = null,
    canCancel = false,
    controller = null;
  const directoryFor = (value) => path.join(root, id(value));
  const modRoot = (directory, index) =>
    path.join(directory, "mods", String(index).padStart(5, "0"));
  const contentPath = (directory, index, kind) =>
    path.join(
      modRoot(directory, index),
      kind === "directory" ? "content" : "archive.zip",
    );
  const recordPath = (value) => path.join(directoryFor(value), "snapshot.json");
  const fresh = () =>
    launcher.getSourceState ? launcher.getSourceState() : launcher.getState();
  function setPhase(value, cancellable = false) {
    aborted(controller?.signal);
    phase = value;
    canCancel = cancellable;
    progress = null;
  }
  async function gameGuard() {
    if (await isGameRunning())
      throw failure("请先退出游戏，再创建或恢复组合快照。");
  }
  function stamp(state) {
    return data.sha256(
      JSON.stringify({
        settings: state.settings,
        version: state.game.version,
        userData: state.paths.userData,
        options: state.gameOptions.values,
        dlc: state.dlc?.items,
      }),
    );
  }
  async function unchanged(expected) {
    const state = await fresh();
    if (stamp(state) !== expected)
      throw failure("版本实例或配置在操作期间发生变化，请重新操作。");
    await gameGuard();
    return state;
  }
  function scoped(record, state) {
    if (
      record.instanceId !== state.settings.activeGameInstanceId ||
      !data.samePath(record.userData, state.paths.userData)
    )
      throw failure("组合快照属于其他版本实例，请先切回对应版本。");
  }
  function serial(mutates, fn) {
    count++;
    const task = pending.then(async () => {
      controller = new AbortController();
      phase = "checking";
      canCancel = true;
      try {
        if (mutates) await gameGuard();
        return await fn();
      } finally {
        phase = "idle";
        progress = null;
        canCancel = false;
        controller = null;
      }
    });
    pending = task.catch(() => {});
    return task.finally(() => {
      count--;
    });
  }
  async function json(filename, optional = false) {
    const bytes = await data.read(filename, MAX_JSON, optional);
    return bytes === null ? null : { value: JSON.parse(bytes), bytes };
  }
  async function saveJson(filename, value, previous = null) {
    const bytes = Buffer.from(JSON.stringify(value, null, 2) + "\n");
    if (bytes.length > MAX_JSON) throw failure("组合快照记录超过大小上限。");
    await data.atomic(filename, bytes, previous);
    return bytes;
  }
  function validate(record, value) {
    if (
      !object(record) ||
      record.schemaVersion !== 1 ||
      record.id !== value ||
      title(record.name) !== record.name ||
      !timestamp(record.createdAt) ||
      record.status !== "complete" ||
      !Array.isArray(record.mods) ||
      record.mods.length > 10000 ||
      typeof record.instanceId !== "string" ||
      !path.isAbsolute(record.userData || "")
    )
      throw failure();
    validateEnvironment(record.environment);
    if (
      record.environment.game.instanceId !== record.instanceId ||
      !data.samePath(record.environment.game.userData, record.userData) ||
      record.modCount !== record.mods.length ||
      record.mods.length !== record.environment.mods.length
    )
      throw failure();
    for (const [index, mod] of record.mods.entries()) {
      const env = record.environment.mods[index];
      if (
        !object(mod) ||
        mod.id !== env.id ||
        !["directory", "archive"].includes(mod.kind) ||
        !digest(mod.descriptorSha256) ||
        env.contentStatus !== "verified" ||
        !env.available
      )
        throw failure();
      bound(mod.bytes, mod.entries);
      bound(mod.expandedBytes, mod.entries);
    }
    if (record.totalBytes !== totalBound(record.mods)) throw failure();
    return record;
  }
  async function load(value) {
    id(value);
    const result = await json(recordPath(value));
    return { record: validate(result.value, value), bytes: result.bytes };
  }
  async function descriptor(mod) {
    if (mod.projectId) {
      const version = await projects.resolveVersion(
        mod.projectId,
        mod.projectVersion,
      );
      if (!data.samePath(version.contentPath, mod.contentPath))
        throw failure("二改项目固定版本已变化。");
      const bytes = Buffer.from(version.descriptorText, "utf8");
      decodeDescriptor(bytes);
      return bytes;
    }
    const bytes = await data.read(mod.descriptorPath, MAX_DESCRIPTOR);
    decodeDescriptor(bytes);
    return bytes;
  }
  function synthetic(record, directory) {
    return {
      settings: {
        activePlaysetId: record.environment.playset.id,
        playsets: [record.environment.playset],
      },
      mods: record.environment.mods.map((mod, index) => ({
        ...mod,
        contentPath: contentPath(directory, index, record.mods[index].kind),
      })),
    };
  }
  async function hashes(state, expected = null) {
    const result = await fingerprintMods(state, {
      signal: controller.signal,
      onProgress: (item) => {
        progress = {
          ...item,
          name: state.mods.find((m) => m.id === item.modId)?.name,
        };
      },
    });
    for (const [key, value] of Object.entries(result))
      if (
        value.status !== "verified" ||
        (expected && value.digest !== expected[key]?.digest)
      )
        throw failure("模组内容无法核验或在操作期间发生变化：" + key);
    return result;
  }
  async function verifyInner(value) {
    const loaded = await load(value),
      state = await launcher.getState();
    scoped(loaded.record, state);
    const directory = directoryFor(value);
    setPhase("verifying", true);
    const expected = Object.fromEntries(
      loaded.record.environment.mods.map((m) => [
        m.id,
        { digest: m.contentDigest },
      ]),
    );
    await hashes(synthetic(loaded.record, directory), expected);
    for (const [index, mod] of loaded.record.mods.entries()) {
      aborted(controller.signal);
      progress = {
        index: index + 1,
        total: loaded.record.modCount,
        name: loaded.record.environment.mods[index].name,
      };
      const bytes = await data.read(
        path.join(modRoot(directory, index), "descriptor.mod"),
        MAX_DESCRIPTOR,
      );
      decodeDescriptor(bytes);
      if (data.sha256(bytes) !== mod.descriptorSha256)
        throw failure("保存的模组描述文件摘要不匹配。");
      const measured =
        mod.kind === "directory"
          ? await tree(
              contentPath(directory, index, mod.kind),
              controller.signal,
            )
          : await archive(
              contentPath(directory, index, mod.kind),
              null,
              controller.signal,
            );
      if (
        measured.bytes !== mod.bytes ||
        measured.entries !== mod.entries ||
        measured.expandedBytes !== mod.expandedBytes
      )
        throw failure();
    }
    const latest = await data.read(recordPath(value), MAX_JSON);
    if (!latest.equals(loaded.bytes))
      throw failure("组合快照记录在校验期间被外部修改。");
    return loaded;
  }
  async function prepareProject(record, index, directory) {
    const mod = record.mods[index],
      parent = path.join(directory, "restore-work", randomUUID()),
      work = path.join(parent, "content");
    await data.directory(parent, true);
    if (mod.kind === "directory")
      await copyTree(contentPath(directory, index, mod.kind), work, null);
    else await archive(contentPath(directory, index, mod.kind), work, null);
    const sourceState = synthetic(record, directory);
    sourceState.settings.playsets = [
      { ...record.environment.playset, modIds: [mod.id], modOrder: [mod.id] },
    ];
    const expected = await fingerprintMods(sourceState);
    if (
      expected[mod.id]?.status !== "verified" ||
      expected[mod.id].digest !== record.environment.mods[index].contentDigest
    )
      throw failure("组合快照在准备项目时发生变化。");
    if (mod.kind === "directory") {
      const copiedState = clone(sourceState);
      copiedState.mods = copiedState.mods.map((item) =>
        item.id === mod.id ? { ...item, contentPath: work } : item,
      );
      const copied = await fingerprintMods(copiedState);
      if (
        copied[mod.id]?.status !== "verified" ||
        copied[mod.id].digest !== expected[mod.id].digest
      )
        throw failure("恢复副本与组合快照内容不一致。");
    }
    const external = await data.read(
      path.join(modRoot(directory, index), "descriptor.mod"),
      MAX_DESCRIPTOR,
    );
    if (data.sha256(external) !== mod.descriptorSha256) throw failure();
    decodeDescriptor(external);
    const embedded = path.join(work, "descriptor.mod");
    try {
      await data.file(embedded, MAX_DESCRIPTOR);
      await fs.rename(
        embedded,
        path.join(parent, "original-descriptor-" + randomUUID()),
      );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await data.atomic(embedded, external, null);
    const workState = clone(sourceState);
    workState.mods = workState.mods.map((item) =>
      item.id === mod.id ? { ...item, contentPath: work } : item,
    );
    const workProof = await fingerprintMods(workState);
    if (workProof[mod.id]?.status !== "verified")
      throw failure("恢复暂存内容无法核验。");
    return {
      work,
      text: external.toString("utf8"),
      check: async () => {
        const actual = await fingerprintMods(workState);
        if (
          actual[mod.id]?.status !== "verified" ||
          actual[mod.id].digest !== workProof[mod.id].digest
        )
          throw failure("恢复暂存内容在创建项目期间发生变化。");
      },
    };
  }
  return {
    isBusy: () => count > 0,
    getProgress: () => ({
      busy: count > 0,
      phase,
      progress: clone(progress),
      canCancel,
    }),
    cancel: () => {
      if (!canCancel || !controller || controller.signal.aborted) return false;
      controller.abort();
      return true;
    },
    list: async () => {
      const state = await launcher.getState(),
        snapshots = [],
        notices = [],
        retainedDirectories = [];
      try {
        await data.directory(root);
      } catch (error) {
        if (error.code === "ENOENT")
          return { snapshots, notices, retainedDirectories };
        throw error;
      }
      const entries = await fs.opendir(root);
      let seen = 0;
      for await (const entry of entries) {
        if (!data.UUID.test(entry.name)) continue;
        if (++seen > 500) throw failure("组合快照目录超过 500 项，请先整理。");
        try {
          const { record } = await load(entry.name);
          if (
            record.instanceId === state.settings.activeGameInstanceId &&
            data.samePath(record.userData, state.paths.userData)
          )
            snapshots.push(record);
        } catch {
          let header = null;
          try {
            header = (
              await json(
                path.join(directoryFor(entry.name), "capture.json"),
                true,
              )
            )?.value;
          } catch {}
          if (
            header &&
            (!object(header) ||
              typeof header.instanceId !== "string" ||
              typeof header.userData !== "string")
          )
            header = null;
          if (
            (header &&
              header.instanceId !== state.settings.activeGameInstanceId) ||
            (header &&
              !data.samePath(header.userData || "", state.paths.userData))
          )
            continue;
          try {
            await data.directory(directoryFor(entry.name));
            retainedDirectories.push({
              id: entry.name,
              path: directoryFor(entry.name),
              status: header ? "incomplete" : "unknown",
            });
          } catch {}
          notices.push(
            header
              ? "部分组合快照未完成或无法核验，原始目录已保留。"
              : "部分组合快照元数据无法读取，所属版本未知；目录已保留。",
          );
        }
      }
      return {
        snapshots: snapshots.sort((a, b) =>
          b.createdAt.localeCompare(a.createdAt),
        ),
        notices: [...new Set(notices)],
        retainedDirectories,
      };
    },
    create: (input) =>
      serial(true, async () => {
        if (!object(input) || Object.keys(input).some((k) => k !== "name"))
          throw failure("组合快照参数无效。");
        const name = title(input.name),
          state = await launcher.getState(),
          expectedStamp = stamp(state);
        if (!state.game.found) throw failure("请先选择有效的 HOI4 游戏目录。");
        const initial = captureEnvironment(state),
          sourceMods = initial.mods.map((m) =>
            state.mods.find((item) => item.id === m.id),
          );
        if (sourceMods.some((m) => !m?.available))
          throw failure("当前播放集存在缺失模组，无法创建完整组合快照。");
        for (const mod of sourceMods) {
          if (
            data.samePath(mod.contentPath, root) ||
            data.inside(mod.contentPath, root)
          )
            throw failure("组合快照目录不能位于来源模组内部。");
        }
        const value = randomUUID(),
          directory = directoryFor(value),
          createdAt = new Date().toISOString();
        await data.directory(root, true);
        await fs.mkdir(directory);
        await saveJson(path.join(directory, "capture.json"), {
          schemaVersion: 1,
          id: value,
          name,
          createdAt,
          instanceId: initial.game.instanceId,
          userData: initial.game.userData,
        });
        setPhase("checking", true);
        for (const [index, mod] of sourceMods.entries()) {
          progress = {
            index: index + 1,
            total: sourceMods.length,
            name: mod.name,
          };
          const source = await safeStat(mod.contentPath);
          if (source.isDirectory())
            await tree(mod.contentPath, controller.signal);
          else bound(Number(source.size), 1);
        }
        const before = await hashes(state),
          descriptors = [];
        for (const mod of sourceMods) {
          aborted(controller.signal);
          descriptors.push(await descriptor(mod));
        }
        const mods = [];
        setPhase("copying", true);
        for (const [index, mod] of sourceMods.entries()) {
          aborted(controller.signal);
          progress = {
            index: index + 1,
            total: sourceMods.length,
            name: mod.name,
          };
          const stat = await safeStat(mod.contentPath),
            kind = stat.isDirectory() ? "directory" : "archive",
            to = contentPath(directory, index, kind);
          await data.directory(modRoot(directory, index), true);
          let measured;
          if (kind === "directory")
            measured = await copyTree(mod.contentPath, to, controller.signal);
          else {
            measured = await archive(mod.contentPath, null, controller.signal);
            await data.copyFile(mod.contentPath, to, LIMITS.modBytes, {
              signal: controller.signal,
            });
          }
          await data.atomic(
            path.join(modRoot(directory, index), "descriptor.mod"),
            descriptors[index],
            null,
          );
          mods.push({
            id: mod.id,
            kind,
            bytes: measured.bytes,
            entries: measured.entries,
            expandedBytes: measured.expandedBytes,
            descriptorSha256: data.sha256(descriptors[index]),
          });
          totalBound(mods);
        }
        setPhase("verifying", true);
        await hashes(state, before);
        for (const [index, mod] of sourceMods.entries())
          if (
            data.sha256(await descriptor(mod)) !==
            data.sha256(descriptors[index])
          )
            throw failure("来源模组描述文件在复制期间发生变化。");
        const environment = captureEnvironment(state, { fingerprints: before }),
          record = {
            schemaVersion: 1,
            id: value,
            name,
            createdAt,
            instanceId: environment.game.instanceId,
            userData: environment.game.userData,
            status: "complete",
            environment,
            mods,
            modCount: mods.length,
            totalBytes: totalBound(mods),
          };
        await hashes(synthetic(record, directory), before);
        await unchanged(expectedStamp);
        validate(record, value);
        setPhase("committing");
        await saveJson(recordPath(value), record);
        return record;
      }),
    verify: (value) =>
      serial(false, async () => {
        const { record } = await verifyInner(value);
        return {
          valid: true,
          verifiedAt: new Date().toISOString(),
          snapshot: record,
          modCount: record.modCount,
          totalBytes: record.totalBytes,
        };
      }),
    restore: (value) =>
      serial(true, async () => {
        const { record, bytes } = await verifyInner(value),
          initial = await launcher.getState(),
          expectedStamp = stamp(initial),
          directory = directoryFor(value);
        scoped(record, initial);
        setPhase("restoring");
        const journalPath = path.join(directory, "restore.json"),
          old = await json(journalPath, true);
        let journal = old?.value,
          journalBytes = old?.bytes || null;
        if (journal) {
          if (
            !object(journal) ||
            journal.schemaVersion !== 1 ||
            journal.snapshotDigest !== data.sha256(bytes) ||
            !data.UUID.test(journal.restoreId || "") ||
            !data.UUID.test(journal.playsetId || "") ||
            journal.instanceId !== record.instanceId ||
            !data.samePath(journal.userData || "", record.userData)
          )
            throw failure("组合恢复日志无法核验，原始文件已保留。");
        } else {
          journal = {
            schemaVersion: 1,
            snapshotDigest: data.sha256(bytes),
            restoreId: randomUUID(),
            playsetId: randomUUID(),
            instanceId: record.instanceId,
            userData: record.userData,
          };
          journalBytes = await saveJson(journalPath, journal);
        }
        const restored = [];
        for (const [index, mod] of record.mods.entries()) {
          progress = {
            index: index + 1,
            total: record.modCount,
            name: record.environment.mods[index].name,
          };
          await unchanged(expectedStamp);
          const entryPath = path.join(
              directory,
              "restore",
              journal.restoreId,
              String(index).padStart(5, "0") + ".json",
            ),
            loaded = await json(entryPath, true);
          let entry = loaded?.value,
            entryBytes = loaded?.bytes || null;
          const originId =
            /^(?:local:[^\\/\0\r\n]+\.mod|(?:workshop|pdx):[1-9]\d{0,19})$/.test(
              mod.id,
            )
              ? mod.id
              : null;
          const projectName = (
            `[${journal.restoreId}-${index + 1}] ` +
            record.environment.mods[index].name.replace(/[\0-\x1f\x7f]/g, " ")
          ).slice(0, 120);
          if (!entry) {
            entry = {
              sourceId: mod.id,
              originId,
              name: projectName,
              projectId: null,
              version: null,
              digest: null,
              modId: null,
            };
            entryBytes = await saveJson(entryPath, entry);
          }
          if (
            !object(entry) ||
            entry.sourceId !== mod.id ||
            entry.originId !== originId ||
            entry.name !== projectName ||
            (entry.projectId === null
              ? entry.version !== null ||
                entry.digest !== null ||
                entry.modId !== null
              : !data.UUID.test(entry.projectId || "") ||
                !data.UUID.test(entry.version || "") ||
                !digest(entry.digest) ||
                entry.modId !== `local:ironclad_project_${entry.projectId}.mod`)
          )
            throw failure("组合恢复项目日志无法核验。");
          let project;
          if (entry.projectId) {
            id(entry.projectId);
            project = await projects.get(entry.projectId);
          } else {
            const candidates = (await projects.list()).projects.filter(
              (p) =>
                p.name === entry.name &&
                p.originModId === entry.originId &&
                data.samePath(p.userData, record.userData),
            );
            if (candidates.length > 1)
              throw failure("发现多个恢复候选项目，请保留现有内容并检查。");
            project = candidates[0];
            if (!project) {
              const source = await prepareProject(record, index, directory);
              project = await projects.create({
                sourcePath: source.work,
                name: entry.name,
                descriptorText: source.text,
                sourceModId: entry.originId,
                baselineKnown: false,
                upstreamRef: null,
                checkSource: async () => {
                  await unchanged(expectedStamp);
                  await source.check();
                },
              });
            }
          }
          if (
            project.name !== entry.name ||
            project.originModId !== entry.originId ||
            !data.samePath(project.userData, record.userData)
          )
            throw failure("已创建的恢复项目身份发生变化。");
          const version = entry.version || project.baseSnapshotId,
            resolved = await projects.resolveVersion(project.id, version);
          if (
            !digest(resolved.digest) ||
            (entry.digest && entry.digest !== resolved.digest) ||
            (entry.modId && entry.modId !== project.modId)
          )
            throw failure("已创建的恢复项目内容无法核验。");
          if (!entry.projectId) {
            entry = {
              ...entry,
              projectId: project.id,
              version,
              digest: resolved.digest,
              modId: project.modId,
            };
            await saveJson(entryPath, entry, entryBytes);
          }
          restored.push({
            id: project.modId,
            name: project.name,
            source: "local",
            remoteId: null,
            version,
          });
        }
        const latest = await unchanged(expectedStamp),
          mapping = new Map(record.mods.map((m, i) => [m.id, restored[i]])),
          env = record.environment;
        const playset = {
          ...clone(env.playset),
          id: journal.playsetId,
          name: (record.name + " · 快照恢复").slice(0, 128),
          modIds: env.playset.modIds.map((m) => mapping.get(m).id),
          modOrder: env.playset.modOrder.map((m) => mapping.get(m)?.id || m),
          modReferences: [
            ...env.playset.modReferences.filter((m) => !mapping.has(m.id)),
            ...restored,
          ],
          disabledDlcIds: (latest.dlc?.items || [])
            .filter((d) => !env.dlcIds.includes(d.id))
            .map((d) => d.id),
          unmappedDlcIds: [
            ...new Set([
              ...env.playset.unmappedDlcIds,
              ...env.dlcIds.filter(
                (d) =>
                  !(latest.dlc?.items || []).some(
                    (i) => i.id === d && i.installed,
                  ),
              ),
            ]),
          ],
        };
        const existing = latest.settings.playsets.find(
          (p) => p.id === playset.id,
        );
        if (existing && !same(existing, playset)) {
          journal.playsetId = randomUUID();
          playset.id = journal.playsetId;
          await saveJson(journalPath, journal, journalBytes);
        }
        const sets = latest.settings.playsets.some((p) => p.id === playset.id)
          ? latest.settings.playsets
          : [...latest.settings.playsets, playset];
        if (sets.length > 100) throw failure("播放集已达 100 项，请先整理。");
        const recordAgain = await data.read(recordPath(value), MAX_JSON);
        if (!recordAgain.equals(bytes))
          throw failure("组合快照记录在恢复期间被外部修改。");
        await unchanged(expectedStamp);
        setPhase("committing");
        const settings = await launcher.saveSettings({
          playsets: sets,
          activePlaysetId: playset.id,
          gameOptions: clone(env.gameOptions),
          launchMode: env.launchMode,
        });
        let state;
        try {
          state = await launcher.getState();
        } catch {
          state = { ...latest, settings };
        }
        return { state, snapshot: record, restoredPlaysetId: playset.id };
      }),
    resolveDirectory: async (value) => {
      const directory = directoryFor(value);
      await data.directory(directory);
      const state = await launcher.getState();
      try {
        const { record } = await load(value);
        scoped(record, state);
      } catch (error) {
        const header = await json(
          path.join(directory, "capture.json"),
          true,
        ).catch(() => null);
        if (header?.value) scoped(header.value, state);
        else if (error.message.includes("其他版本")) throw error;
      }
      return directory;
    },
  };
}

module.exports = { createPlaysetSnapshotService };
