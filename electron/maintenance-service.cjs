"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const BACKUP_DIRECTORY = "ironclad-cache-backups";
const MAX_METADATA_BYTES = 1024 * 1024;
const MAX_TARGETS = 256;
const MAX_TREE_ENTRIES = 100000;
const MAX_TREE_DEPTH = 64;
const FALLBACK_TARGETS = [
  "cache",
  "shadercache",
  "naval_dist.cache",
  "naval_dist_checksum.cache",
];
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const locks = new Map();

function serial(root, callback) {
  const key = path.resolve(root).toLowerCase();
  const previous = locks.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(callback);
  locks.set(key, current);
  current
    .finally(() => {
      if (locks.get(key) === current) locks.delete(key);
    })
    .catch(() => {});
  return current;
}

function relativePath(value) {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 512 ||
    /[\x00-\x1f<>:"|?*]/.test(value)
  )
    throw new Error("缓存路径格式无效。");
  const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!normalized || normalized.startsWith("/") || path.isAbsolute(value))
    throw new Error("缓存路径必须位于游戏用户目录内。");
  const parts = normalized.split("/");
  if (
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        /[. ]$/.test(part) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
    )
  ) {
    throw new Error("缓存路径包含不安全的目录或文件名。");
  }
  return parts.join("/");
}

function protectedPath(relative) {
  const parts = relative.toLowerCase().split("/");
  return parts.some(
    (part) =>
      /^(save games|savegames|saves|saved games|accounts?|auth|tokens?|credentials|sessions?|secrets|ironclad-cache-backups|ironclad-backups)$/.test(
        part,
      ) ||
      /^launcher.*\.(?:sqlite|db)(?:[-.]|$)/.test(part) ||
      /^(?:(?:pdx_)?settings|usersettings)(?:[._-].*)?$/.test(part) ||
      /^(dlc_load|content_load|game_data|mods_registry|launcher-settings|launcher_settings|playset_config|playset_config_lock|playset_sync|mod_directory|userdir)\.(json|txt)$/.test(
        part,
      ) ||
      /^pops_(?:login|account|auth)/.test(part) ||
      /^playsets_backup(?:_|$)/.test(part) ||
      /(?:auth[_-]?token|refresh[_-]?token|login[_-]?token|credentials)/.test(
        part,
      ) ||
      part.includes(".ironclad-backup-") ||
      part.startsWith("ironclad-backup"),
  );
}

function classification(relative) {
  const lower = relative.toLowerCase();
  const base = lower.split("/")[0];
  const safe =
    ["cache", "shadercache"].includes(base) ||
    ["naval_dist.cache", "naval_dist_checksum.cache"].includes(lower);
  const labels = {
    cache: "游戏缓存",
    shadercache: "着色器缓存",
    "naval_dist.cache": "海军距离缓存",
    "naval_dist_checksum.cache": "海军距离校验缓存",
    mod: "模组描述文件与本地模组",
    "game rules": "自定义游戏规则",
    playlists: "自定义播放列表",
    "continue_game.json": "继续游戏记录",
    pops_filestorage: "云端文件本地副本",
    "pops_filestorage.index": "云端文件索引",
    map: "地图与编辑器资料",
    "buildings_nudger_markers.txt": "地图编辑器标记",
  };
  return {
    label: labels[lower] || labels[base] || relative,
    containsUserContent: !safe,
    selectedByDefault: safe,
  };
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return (
    relative !== "" &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== ".." &&
    !path.isAbsolute(relative)
  );
}

async function statOptional(target) {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function rootInfo(userData, requireExists = false) {
  if (
    typeof userData !== "string" ||
    !path.isAbsolute(userData) ||
    /[\x00-\x1f]/.test(userData)
  )
    throw new Error("游戏用户目录无效。");
  const lexical = path.resolve(userData);
  const stat = await statOptional(lexical);
  if (!stat) {
    if (requireExists)
      throw new Error("游戏用户目录不存在，没有可清理或恢复的资料。");
    return { path: lexical, exists: false };
  }
  // Windows Documents can legitimately be redirected. Anchor all operations to
  // its resolved directory, then reject links anywhere underneath that anchor.
  const resolved = await fs.realpath(lexical);
  if (!(await fs.stat(resolved)).isDirectory())
    throw new Error("游戏用户目录不是文件夹。");
  return { path: resolved, exists: true };
}

async function assertSafePath(
  root,
  relative,
  { allowMissing = true, scanTree = false, checkProtected = true } = {},
) {
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("缓存操作目录已变化或成为目录联接，请刷新后重试。");
  }
  const actualRoot = await fs.realpath(root);
  if (
    path.resolve(actualRoot).toLowerCase() !== path.resolve(root).toLowerCase()
  ) {
    throw new Error("缓存操作目录指向了不同位置，请刷新后重试。");
  }
  const normalized = relativePath(relative);
  if (checkProtected && protectedPath(normalized))
    throw new Error(`已保护存档、账号、设置或备份路径：${normalized}`);
  const target = path.resolve(root, ...normalized.split("/"));
  if (!inside(root, target)) throw new Error("缓存目标越过了游戏用户目录。");
  const segments = normalized.split("/");
  let cursor = root;
  for (let index = 0; index < segments.length; index++) {
    cursor = path.join(cursor, segments[index]);
    const stat = await statOptional(cursor);
    if (!stat) {
      if (!allowMissing)
        throw new Error(`缓存目标已被移动或删除：${normalized}`);
      return { path: target, exists: false, kind: null };
    }
    if (stat.isSymbolicLink())
      throw new Error(`不操作符号链接或目录联接：${normalized}`);
    if (index < segments.length - 1 && !stat.isDirectory())
      throw new Error(`缓存路径的父级不是文件夹：${normalized}`);
    const actual = await fs.realpath(cursor);
    if (!inside(root, actual))
      throw new Error(`缓存路径指向游戏用户目录之外：${normalized}`);
  }
  const stat = await fs.lstat(target);
  if (!stat.isFile() && !stat.isDirectory())
    throw new Error(`不支持此缓存文件类型：${normalized}`);
  if (scanTree && stat.isDirectory()) {
    let entries = 0;
    const scan = async (folder, depth) => {
      if (depth > MAX_TREE_DEPTH)
        throw new Error(`缓存目录层级过深，请手动检查：${normalized}`);
      for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
        if (++entries > MAX_TREE_ENTRIES)
          throw new Error(
            `缓存目录超过 100000 个项目，请分批手动整理：${normalized}`,
          );
        const entryPath = path.join(folder, entry.name);
        const entryRelative = path
          .relative(root, entryPath)
          .replace(/\\/g, "/");
        relativePath(entryRelative);
        if (entry.isSymbolicLink())
          throw new Error(`缓存目录包含符号链接或目录联接：${entryRelative}`);
        if (checkProtected && protectedPath(entryRelative))
          throw new Error(`缓存目录包含受保护资料：${entryRelative}`);
        if (entry.isDirectory()) await scan(entryPath, depth + 1);
        else if (!entry.isFile())
          throw new Error(`缓存目录包含不支持的文件类型：${entryRelative}`);
      }
    };
    await scan(target, 0);
  }
  return {
    path: target,
    exists: true,
    kind: stat.isDirectory() ? "directory" : "file",
  };
}

function assertNoOverlap(targets) {
  const keys = targets.map((target) => target.relativePath.toLowerCase());
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      if (
        keys[i] === keys[j] ||
        keys[i].startsWith(`${keys[j]}/`) ||
        keys[j].startsWith(`${keys[i]}/`)
      ) {
        throw new Error("缓存目标存在重复或父子目录重叠，无法安全操作。");
      }
    }
  }
}

async function readMetadataPaths(gameDirectory, warnings) {
  if (typeof gameDirectory !== "string" || !path.isAbsolute(gameDirectory))
    throw new Error("游戏安装目录无效。");
  const metadata = path.join(gameDirectory, "launcher-settings.json");
  try {
    const stat = await fs.stat(metadata);
    if (!stat.isFile() || stat.size > MAX_METADATA_BYTES)
      throw new Error("元数据过大或不是文件");
    const text = await fs.readFile(metadata, "utf8");
    if (Buffer.byteLength(text) > MAX_METADATA_BYTES)
      throw new Error("元数据过大");
    const value = JSON.parse(text.replace(/^\uFEFF/, ""));
    if (value.gameCachePaths === undefined) throw new Error("没有缓存清单");
    if (
      !Array.isArray(value.gameCachePaths) ||
      value.gameCachePaths.length > MAX_TARGETS
    )
      throw new Error("缓存清单格式不受支持");
    return value.gameCachePaths;
  } catch {
    warnings.push(
      "无法读取官方缓存清单，仅列出已知的游戏缓存；存档和配置不在清理范围内。",
    );
    return FALLBACK_TARGETS;
  }
}

async function getCachePlan({ gameDirectory, userData } = {}) {
  const warnings = [];
  const root = await rootInfo(userData);
  const metadataPaths = await readMetadataPaths(gameDirectory, warnings);
  const targets = [];
  for (const candidate of metadataPaths) {
    try {
      const relative = relativePath(candidate);
      if (protectedPath(relative))
        throw new Error(`已排除受保护资料：${relative}`);
      const info = root.exists
        ? await assertSafePath(root.path, relative, { scanTree: true })
        : { path: path.join(root.path, relative), exists: false };
      const target = {
        id: relative.toLowerCase(),
        relativePath: relative,
        ...classification(relative),
        path: info.path,
        exists: info.exists,
      };
      target.selectedByDefault = target.selectedByDefault && target.exists;
      if (targets.some((entry) => entry.id === target.id)) continue;
      targets.push(target);
    } catch (error) {
      warnings.push(error.message);
    }
  }
  // Keep the ancestor once, rather than offering two selections that would move
  // the same file twice. Explicit API selections are checked again on mutation.
  targets.sort(
    (a, b) =>
      a.relativePath.split("/").length - b.relativePath.split("/").length,
  );
  const disjoint = [];
  for (const target of targets) {
    if (disjoint.some((entry) => target.id.startsWith(`${entry.id}/`))) {
      warnings.push(`已合并与父目录重叠的缓存项目：${target.relativePath}`);
      continue;
    }
    disjoint.push(target);
  }
  return {
    targets: disjoint.map(({ relativePath: ignored, ...target }) => target),
    warnings: [...new Set(warnings)],
  };
}

function safeBackupId(id) {
  if (typeof id !== "string" || !UUID.test(id))
    throw new Error("缓存备份标识无效。");
  return id;
}

async function ensureStore(root, operations, create = false) {
  const info = await assertSafePath(root, BACKUP_DIRECTORY, {
    checkProtected: false,
  });
  if (!info.exists && create) await operations.mkdir(info.path);
  const verified = await assertSafePath(root, BACKUP_DIRECTORY, {
    checkProtected: false,
  });
  if (verified.exists && verified.kind !== "directory")
    throw new Error("缓存备份位置不是文件夹。");
  return verified;
}

async function writeManifest(directory, manifest, operations) {
  const destination = await assertSafePath(directory, "manifest.json", {
    checkProtected: false,
  });
  if (destination.exists && destination.kind !== "file") {
    throw new Error("缓存备份清单不是普通文件。");
  }
  const temp = path.join(directory, `manifest-${randomUUID()}.tmp`);
  try {
    await operations.writeFile(temp, JSON.stringify(manifest, null, 2), {
      flag: "wx",
    });
    await operations.rename(temp, path.join(directory, "manifest.json"));
  } finally {
    await fs.unlink(temp).catch(() => {});
  }
}

async function journal(directory, entry, operations) {
  const destination = await assertSafePath(directory, "journal.ndjson", {
    checkProtected: false,
  });
  if (destination.exists && destination.kind !== "file")
    throw new Error("缓存备份日志不是普通文件。");
  let previous = "";
  if (destination.exists) {
    if ((await fs.stat(destination.path)).size > MAX_METADATA_BYTES)
      throw new Error("缓存备份日志过大，无法安全更新。");
    previous = await fs.readFile(destination.path, "utf8");
  }
  const content = `${previous}${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`;
  if (Buffer.byteLength(content) > MAX_METADATA_BYTES)
    throw new Error("缓存备份日志过大，无法安全更新。");
  // Atomic replacement avoids appending into an untrusted hard-linked journal.
  const temp = path.join(directory, `journal-${randomUUID()}.tmp`);
  try {
    await operations.writeFile(temp, content, { flag: "wx" });
    await operations.rename(temp, destination.path);
  } finally {
    await fs.unlink(temp).catch(() => {});
  }
}

function publicTargets(root, targets) {
  return targets.map((target) => ({
    id: target.id,
    label: target.label,
    path: path.join(root, ...target.relativePath.split("/")),
    containsUserContent: target.containsUserContent,
  }));
}

async function preflightTargets(root, targets, allowMissing = false) {
  assertNoOverlap(targets);
  const checked = [];
  for (const target of targets) {
    const info = await assertSafePath(root, target.relativePath, {
      allowMissing,
      scanTree: true,
    });
    if (info.exists) checked.push({ ...target, kind: info.kind });
  }
  return checked;
}

async function rollbackMoves(root, directory, moved, operations) {
  let failed = false;
  for (const target of [...moved].reverse()) {
    try {
      const current = await assertSafePath(root, target.relativePath);
      if (current.exists) throw new Error("游戏重新创建了目标，不能覆盖。");
      const storedRelative = `data/${target.relativePath}`;
      const stored = await assertSafePath(directory, storedRelative, {
        allowMissing: false,
        scanTree: true,
      });
      await operations.mkdir(path.dirname(current.path), { recursive: true });
      await operations.rename(stored.path, current.path);
    } catch {
      failed = true;
    }
  }
  return !failed;
}

async function createBackup(root, targets, operations, extra = {}) {
  const prepared = await preflightTargets(root, targets);
  const store = await ensureStore(root, operations, true);
  const id = randomUUID();
  const directory = path.join(store.path, id);
  await operations.mkdir(directory);
  await operations.mkdir(path.join(directory, "data"));
  const manifest = {
    formatVersion: 1,
    id,
    createdAt: new Date().toISOString(),
    status: "prepared",
    operation: "clear",
    ...extra,
    targets: prepared,
    movedIds: [],
  };
  const moved = [];
  try {
    await writeManifest(directory, manifest, operations);
    for (const target of prepared) {
      const current = await assertSafePath(root, target.relativePath, {
        allowMissing: false,
        scanTree: true,
      });
      const destination = path.join(
        directory,
        "data",
        ...target.relativePath.split("/"),
      );
      await operations.mkdir(path.dirname(destination), { recursive: true });
      const existingDestination = await assertSafePath(
        directory,
        `data/${target.relativePath}`,
      );
      if (existingDestination.exists)
        throw new Error("缓存备份目标已存在，不能覆盖。");
      await journal(
        directory,
        { action: "move-to-backup", targetId: target.id, state: "pending" },
        operations,
      );
      await operations.rename(current.path, destination);
      moved.push(target);
      manifest.movedIds.push(target.id);
      await writeManifest(directory, manifest, operations);
      await journal(
        directory,
        { action: "move-to-backup", targetId: target.id, state: "done" },
        operations,
      );
    }
    manifest.status = "completed";
    await writeManifest(directory, manifest, operations);
    return { directory, manifest };
  } catch (error) {
    const recovered = await rollbackMoves(root, directory, moved, operations);
    if (recovered) {
      await fs.rm(directory, { recursive: true, force: true });
      throw new Error(
        "缓存备份未完成，已恢复原有文件。请检查文件占用或访问权限后重试。",
      );
    }
    manifest.status = "recovery-required";
    await writeManifest(directory, manifest, fs).catch(() => {});
    throw new Error(
      `缓存备份未完成，部分文件仍保留在备份 ${id} 中；当前新文件未被覆盖。请先检查该备份再继续。`,
    );
  }
}

async function backupAndClearCache({
  gameDirectory,
  userData,
  targetIds,
  fileOps,
} = {}) {
  if (
    !Array.isArray(targetIds) ||
    !targetIds.length ||
    targetIds.length > MAX_TARGETS ||
    targetIds.some((id) => typeof id !== "string") ||
    new Set(targetIds).size !== targetIds.length
  ) {
    throw new Error("请明确选择至少一个不重复的缓存项目。");
  }
  const root = await rootInfo(userData, true);
  return serial(root.path, async () => {
    const plan = await getCachePlan({ gameDirectory, userData: root.path });
    const targets = targetIds.map((id) => {
      const target = plan.targets.find((item) => item.id === id);
      if (!target || !target.exists)
        throw new Error(
          "所选缓存项目不存在、已变化或不安全，请刷新清单后重试。",
        );
      const relative = path
        .relative(root.path, target.path)
        .replace(/\\/g, "/");
      return {
        id,
        relativePath: relativePath(relative),
        ...classification(relative),
      };
    });
    const result = await createBackup(root.path, targets, {
      ...fs,
      ...fileOps,
    });
    return {
      id: result.manifest.id,
      createdAt: result.manifest.createdAt,
      targets: publicTargets(root.path, result.manifest.targets),
    };
  });
}

function validateManifest(value, id) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.formatVersion !== 1 ||
    value.id !== id ||
    typeof value.createdAt !== "string" ||
    !/^\d{4}-\d\d-\d\dT/.test(value.createdAt) ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    ![
      "prepared",
      "completed",
      "restoring",
      "restored",
      "recovery-required",
    ].includes(value.status) ||
    !Array.isArray(value.targets) ||
    !value.targets.length ||
    value.targets.length > MAX_TARGETS
  )
    throw new Error("缓存备份清单无效，未操作任何游戏文件。");
  const targets = value.targets.map((target) => {
    if (!target || typeof target !== "object" || Array.isArray(target))
      throw new Error("缓存备份目标无效。");
    const relative = relativePath(target.relativePath);
    if (
      protectedPath(relative) ||
      target.id !== relative.toLowerCase() ||
      !["file", "directory"].includes(target.kind)
    )
      throw new Error("缓存备份包含受保护或不一致的目标。");
    return {
      id: target.id,
      relativePath: relative,
      kind: target.kind,
      ...classification(relative),
    };
  });
  assertNoOverlap(targets);
  return {
    formatVersion: 1,
    id,
    createdAt: value.createdAt,
    status: value.status,
    operation:
      value.operation === "restore-displaced" ? "restore-displaced" : "clear",
    targets,
    movedIds: targets.map((target) => target.id),
    ...(typeof value.restoredAt === "string"
      ? { restoredAt: value.restoredAt }
      : {}),
    ...(UUID.test(value.displacedBackupId || "")
      ? { displacedBackupId: value.displacedBackupId }
      : {}),
  };
}

async function readManifest(root, id) {
  safeBackupId(id);
  const store = await ensureStore(root, fs);
  if (!store.exists) throw new Error("没有找到缓存备份。");
  const folder = await assertSafePath(store.path, id, {
    allowMissing: false,
    checkProtected: false,
  });
  if (folder.kind !== "directory") throw new Error("缓存备份不是文件夹。");
  const manifestFile = await assertSafePath(folder.path, "manifest.json", {
    allowMissing: false,
    checkProtected: false,
  });
  const stat = await fs.stat(manifestFile.path);
  if (!stat.isFile() || stat.size > MAX_METADATA_BYTES)
    throw new Error("缓存备份清单过大或不是文件。");
  let value;
  try {
    const contents = await fs.readFile(manifestFile.path, "utf8");
    if (Buffer.byteLength(contents) > MAX_METADATA_BYTES) throw new Error();
    value = JSON.parse(contents);
  } catch {
    throw new Error("缓存备份清单无法解析，未操作任何游戏文件。");
  }
  return { directory: folder.path, manifest: validateManifest(value, id) };
}

async function listCacheBackups({ userData } = {}) {
  const root = await rootInfo(userData);
  if (!root.exists) return [];
  const store = await ensureStore(root.path, fs);
  if (!store.exists) return [];
  const directories = await fs.readdir(store.path, { withFileTypes: true });
  const backups = [];
  for (const directory of directories.slice(0, 1000)) {
    if (
      !UUID.test(directory.name) ||
      directory.isSymbolicLink() ||
      !directory.isDirectory()
    )
      continue;
    try {
      const { manifest } = await readManifest(root.path, directory.name);
      backups.push({
        id: manifest.id,
        createdAt: manifest.createdAt,
        targets: publicTargets(root.path, manifest.targets),
        status: manifest.status,
      });
    } catch {
      // Do not trust corrupted manifests enough to offer a restore operation.
      backups.push({
        id: directory.name,
        createdAt: "",
        targets: [],
        status: "invalid",
      });
    }
  }
  return backups.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function restoreCacheBackup({ userData, id, fileOps } = {}) {
  safeBackupId(id);
  const root = await rootInfo(userData, true);
  return serial(root.path, async () => {
    const operations = { ...fs, ...fileOps };
    const { directory, manifest } = await readManifest(root.path, id);
    if (manifest.status !== "completed")
      throw new Error(
        "此备份已恢复或尚未完整完成，不能自动恢复。请先检查备份状态。",
      );
    for (const target of manifest.targets) {
      const payload = await assertSafePath(
        directory,
        `data/${target.relativePath}`,
        { allowMissing: false, scanTree: true },
      );
      if (payload.kind !== target.kind)
        throw new Error("缓存备份文件类型与清单不一致，未操作任何游戏文件。");
    }
    const current = await preflightTargets(root.path, manifest.targets, true);
    const displaced = current.length
      ? await createBackup(root.path, current, operations, {
          operation: "restore-displaced",
          restoreOf: id,
        })
      : null;
    const moved = [];
    try {
      manifest.status = "restoring";
      if (displaced) manifest.displacedBackupId = displaced.manifest.id;
      await writeManifest(directory, manifest, operations);
      for (const target of manifest.targets) {
        const destination = await assertSafePath(
          root.path,
          target.relativePath,
        );
        if (destination.exists)
          throw new Error("恢复目标已被重新创建，不能覆盖。");
        const payload = await assertSafePath(
          directory,
          `data/${target.relativePath}`,
          { allowMissing: false, scanTree: true },
        );
        await operations.mkdir(path.dirname(destination.path), {
          recursive: true,
        });
        await journal(
          directory,
          { action: "restore", targetId: target.id, state: "pending" },
          operations,
        );
        await operations.rename(payload.path, destination.path);
        moved.push(target);
        await journal(
          directory,
          { action: "restore", targetId: target.id, state: "done" },
          operations,
        );
      }
      manifest.status = "restored";
      manifest.restoredAt = new Date().toISOString();
      await writeManifest(directory, manifest, operations);
      return { id, restored: true };
    } catch {
      let recovered = true;
      for (const target of [...moved].reverse()) {
        try {
          const currentTarget = await assertSafePath(
            root.path,
            target.relativePath,
            { allowMissing: false, scanTree: true },
          );
          const destination = await assertSafePath(
            directory,
            `data/${target.relativePath}`,
          );
          if (destination.exists) throw new Error("原备份位置已被占用。");
          await operations.mkdir(path.dirname(destination.path), {
            recursive: true,
          });
          await operations.rename(currentTarget.path, destination.path);
        } catch {
          recovered = false;
        }
      }
      if (displaced) {
        const recoveredCurrent = await rollbackMoves(
          root.path,
          displaced.directory,
          displaced.manifest.targets,
          operations,
        );
        recovered = recoveredCurrent && recovered;
        displaced.manifest.status = recoveredCurrent
          ? "restored"
          : "recovery-required";
        await writeManifest(displaced.directory, displaced.manifest, fs).catch(
          () => {
            recovered = false;
          },
        );
      }
      manifest.status = recovered ? "completed" : "recovery-required";
      delete manifest.restoredAt;
      await writeManifest(directory, manifest, fs).catch(() => {
        recovered = false;
      });
      if (recovered)
        throw new Error(
          "恢复未完成，已回退到恢复前状态；原备份和当前文件均已保留。请检查文件占用后重试。",
        );
      throw new Error(
        `恢复未完成，文件仍保留在原位置或备份 ${id}${displaced ? `、${displaced.manifest.id}` : ""} 中，未覆盖冲突文件。请先检查这些备份。`,
      );
    }
  });
}

module.exports = {
  getCachePlan,
  backupAndClearCache,
  listCacheBackups,
  restoreCacheBackup,
};
