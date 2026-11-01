"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");

const MAX_MEMBERS = 10000;
const MAX_PLAYSETS = 1000;
const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;
const MAX_DATABASE_BYTES = 256 * 1024 * 1024;
const isObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const validRemoteId = (value) =>
  typeof value === "string" && /^[1-9]\d{0,29}$/.test(value);
const cleanName = (value, fallback) =>
  typeof value === "string" && value.trim() ? value.trim() : fallback;
const forward = (value) => String(value || "").replace(/\\/g, "/");
const pathKey = (value) => forward(value).replace(/\/+$/, "").toLowerCase();

function validateName(value, label, maximum = 128) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > maximum ||
    /[\0\r\n]/.test(value)
  ) {
    throw new Error(
      `${label}须为 1 至 ${maximum} 个字符，且不能包含换行或空字符。`,
    );
  }
  return value.trim();
}

function sourceIdentity(mod = {}) {
  const id = typeof mod.id === "string" ? mod.id : "";
  const source = mod.source;
  const steamId =
    mod.steamId ||
    (id.startsWith("workshop:") ? id.slice(9) : null) ||
    (["workshop", "steam", "steam_workshop"].includes(source)
      ? mod.remoteId
      : null);
  const pdxId =
    mod.pdxId ||
    (id.startsWith("pdx:") ? id.slice(4) : null) ||
    (["pdx", "pdx_mods"].includes(source) ? mod.remoteId : null);
  if (validRemoteId(steamId))
    return { id: `workshop:${steamId}`, source: "workshop", remoteId: steamId };
  if (validRemoteId(pdxId))
    return { id: `pdx:${pdxId}`, source: "pdx", remoteId: pdxId };
  return { id, source: "local", remoteId: null };
}

function knownModMap(mods = []) {
  const result = new Map();
  for (const mod of mods) {
    if (!isObject(mod) || typeof mod.id !== "string") continue;
    result.set(mod.id, mod);
    const identity = sourceIdentity(mod);
    if (identity.id) result.set(identity.id, mod);
  }
  return result;
}

function parsePlaysetDocument(text, { mods = [] } = {}) {
  if (
    typeof text !== "string" ||
    Buffer.byteLength(text, "utf8") > MAX_DOCUMENT_BYTES
  ) {
    throw new Error("预设文件须为 UTF-8 JSON，且不能超过 8 MB。");
  }
  let document;
  try {
    document = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    throw new Error("预设 JSON 格式无效，请选择官方启动器导出的预设文件。");
  }
  if (!isObject(document) || document.game !== "hoi4")
    throw new Error("此预设不属于钢铁雄心 IV（game 必须为 hoi4）。");
  const name = validateName(document.name, "预设名称");
  if (!Array.isArray(document.mods) || document.mods.length > MAX_MEMBERS)
    throw new Error("预设模组列表无效，最多支持 10000 个成员。");
  const seen = new Set();
  const positions = new Set();
  const known = knownModMap(mods);
  const entries = document.mods
    .map((entry) => {
      if (!isObject(entry)) throw new Error("预设中包含格式无效的模组。");
      const displayName = validateName(entry.displayName, "模组名称", 1024);
      if (
        typeof entry.enabled !== "boolean" ||
        !Number.isSafeInteger(entry.position) ||
        entry.position < 0
      ) {
        throw new Error(`模组「${displayName}」的 enabled 或 position 无效。`);
      }
      if (positions.has(entry.position))
        throw new Error("预设包含重复的模组位置，请先修正加载顺序。");
      positions.add(entry.position);
      if (
        (Object.hasOwn(entry, "steamId") && !validRemoteId(entry.steamId)) ||
        (Object.hasOwn(entry, "pdxId") && !validRemoteId(entry.pdxId)) ||
        (!entry.steamId && !entry.pdxId)
      ) {
        throw new Error(
          `模组「${displayName}」缺少有效的数字 Steam 或 Paradox ID。`,
        );
      }
      if (
        Object.hasOwn(entry, "version") &&
        (typeof entry.version !== "string" ||
          entry.version.length > 255 ||
          /[\0\r\n]/.test(entry.version))
      ) {
        throw new Error(`模组「${displayName}」的版本格式无效。`);
      }
      // Official import gives a Steam identity precedence if both are present.
      const identity = sourceIdentity(entry);
      if (seen.has(identity.id))
        throw new Error(`预设包含重复模组：${displayName}。`);
      seen.add(identity.id);
      const installed = known.get(identity.id);
      return {
        ...identity,
        name: cleanName(installed?.name, displayName),
        enabled: entry.enabled,
        position: entry.position,
        ...(identity.source === "pdx" && entry.version
          ? { version: entry.version }
          : {}),
      };
    })
    .sort((a, b) => a.position - b.position);
  return {
    name,
    modOrder: entries.map((entry) => entry.id),
    modIds: entries.filter((entry) => entry.enabled).map((entry) => entry.id),
    disabledDlcIds: null,
    modReferences: entries.map(
      ({ enabled, position, ...reference }) => reference,
    ),
  };
}

function serializePlayset({ playset, mods = [] } = {}) {
  if (!isObject(playset)) throw new Error("没有可导出的模组预设。");
  const name = validateName(playset.name, "预设名称");
  const order = playset.modOrder || playset.modIds;
  if (
    !Array.isArray(order) ||
    !Array.isArray(playset.modIds) ||
    order.length > MAX_MEMBERS ||
    order.some((id) => typeof id !== "string" || !id) ||
    new Set(order).size !== order.length ||
    playset.modIds.some((id) => !order.includes(id))
  )
    throw new Error("预设成员或加载顺序无效，无法导出。");
  const known = knownModMap(mods);
  const references = new Map(
    (playset.modReferences || [])
      .filter(isObject)
      .map((entry) => [entry.id, entry]),
  );
  const enabled = new Set(playset.modIds);
  const omittedLocalMods = [];
  const serialized = [];
  for (const id of order) {
    const mod = known.get(id);
    const reference = references.get(id);
    const identity = sourceIdentity({ ...reference, ...mod, id });
    const displayName = cleanName(mod?.name, cleanName(reference?.name, id));
    if (identity.source === "local") {
      if (/^(workshop|pdx):/.test(id))
        throw new Error(`模组「${displayName}」的远程 ID 无效，无法导出。`);
      omittedLocalMods.push({ id, name: displayName });
      continue;
    }
    if (identity.id !== id)
      throw new Error(`模组「${displayName}」的远程标识不一致，无法导出。`);
    serialized.push({
      displayName,
      [identity.source === "workshop" ? "steamId" : "pdxId"]: identity.remoteId,
      position: serialized.length,
      enabled: enabled.has(id),
      ...(identity.source === "pdx" && reference?.version
        ? { version: reference.version }
        : {}),
    });
  }
  const document = { game: "hoi4", name, mods: serialized };
  // Re-use the external validation boundary so programmatic data cannot export
  // a malformed official document (including names or pinned versions).
  parsePlaysetDocument(JSON.stringify(document));
  return { document, omittedLocalMods };
}

async function fingerprint(target) {
  try {
    const stat = await fs.stat(target, { bigint: true });
    if (!stat.isFile()) throw new Error("官方预设数据库路径不是文件。");
    if (stat.size > BigInt(MAX_DATABASE_BYTES))
      throw new Error(
        "官方预设数据库或 WAL 超过 256 MB，请先使用官方启动器整理数据库。",
      );
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function makeSnapshot(source, destination) {
  const rollbackInProgress = async () => {
    try {
      return (await fs.stat(`${source}-journal`)).size > 0;
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  };
  if (await rollbackInProgress()) {
    const error = new Error(
      "官方启动器正在写入预设数据库，请完成保存后重试导入。",
    );
    error.snapshotChanged = true;
    throw error;
  }
  const beforeDb = await fingerprint(source);
  if (!beforeDb) return false;
  const beforeWal = await fingerprint(`${source}-wal`);
  await fs.copyFile(source, destination);
  if (beforeWal) await fs.copyFile(`${source}-wal`, `${destination}-wal`);
  const afterDb = await fingerprint(source);
  const afterWal = await fingerprint(`${source}-wal`);
  if (
    beforeDb !== afterDb ||
    beforeWal !== afterWal ||
    (await rollbackInProgress())
  ) {
    const error = new Error("官方启动器正在更新预设数据库，请稍后重试导入。");
    error.snapshotChanged = true;
    throw error;
  }
  return true;
}

function sqlColumns(db, table) {
  return new Set(
    db
      .prepare(`PRAGMA table_info("${table}")`)
      .all()
      .map((column) => column.name),
  );
}

function sqlField(columns, alias, field, fallback = "NULL") {
  return columns.has(field) ? `${alias}."${field}"` : fallback;
}

function localIdentity(row, mods, warnings) {
  const registry = forward(row.gameRegistryId);
  const descriptor = registry.toLowerCase().endsWith(".mod")
    ? path.posix.basename(registry).toLowerCase()
    : null;
  const direct = descriptor
    ? mods.find((mod) => mod.id === `local:${descriptor}`)
    : null;
  const matches = direct
    ? [direct]
    : mods.filter((mod) => {
        if (sourceIdentity(mod).source !== "local") return false;
        return (
          (row.dirPath && pathKey(mod.contentPath) === pathKey(row.dirPath)) ||
          (row.archivePath &&
            pathKey(mod.contentPath) === pathKey(row.archivePath)) ||
          (registry &&
            mod.descriptorPath &&
            pathKey(mod.descriptorPath).endsWith(`/${pathKey(registry)}`))
        );
      });
  if (matches.length === 1)
    return { id: matches[0].id, source: "local", remoteId: null };
  if (descriptor)
    return { id: `local:${descriptor}`, source: "local", remoteId: null };
  const suffix = createHash("sha256")
    .update(String(row.memberId))
    .digest("hex")
    .slice(0, 20);
  warnings.push(
    `本地模组「${cleanName(row.displayName, cleanName(row.name, "未知模组"))}」缺少可匹配的描述文件，已保留为缺失项。`,
  );
  return {
    id: `local:unresolved-${suffix}.mod`,
    source: "local",
    remoteId: null,
  };
}

function databaseModIdentity(row, mods, warnings) {
  // A PDX upload can retain remote_file_id from its original Steam descriptor.
  // The registry's explicit source is authoritative; JSON exchange has a
  // separate, intentionally Steam-first rule for entries with both IDs.
  if (["pdx", "pdx_mods"].includes(row.source) && validRemoteId(row.pdxId))
    return { id: `pdx:${row.pdxId}`, source: "pdx", remoteId: row.pdxId };
  if (validRemoteId(row.steamId))
    return {
      id: `workshop:${row.steamId}`,
      source: "workshop",
      remoteId: row.steamId,
    };
  if (validRemoteId(row.pdxId))
    return { id: `pdx:${row.pdxId}`, source: "pdx", remoteId: row.pdxId };
  const ugc = forward(row.gameRegistryId).match(/(?:^|\/)ugc_(\d+)\.mod$/i);
  if (ugc && validRemoteId(ugc[1]))
    return { id: `workshop:${ugc[1]}`, source: "workshop", remoteId: ugc[1] };
  if (
    ["steam", "workshop", "steam_workshop", "pdx", "pdx_mods"].includes(
      row.source,
    )
  ) {
    warnings.push(
      `模组「${cleanName(row.displayName, cleanName(row.name, "未知模组"))}」的官方远程 ID 无效，已保留为缺失本地项。`,
    );
  }
  return localIdentity(row, mods, warnings);
}

function readSnapshot(db, { mods, dlc }) {
  const warnings = [];
  const playsetColumns = sqlColumns(db, "playsets");
  const memberColumns = sqlColumns(db, "playsets_mods");
  const modColumns = sqlColumns(db, "mods");
  if (
    !playsetColumns.has("id") ||
    !playsetColumns.has("name") ||
    !memberColumns.has("playsetId") ||
    !memberColumns.has("modId") ||
    !modColumns.has("id")
  ) {
    throw new Error(
      "官方预设数据库结构不受支持，请改用官方启动器导出的 JSON 文件。",
    );
  }
  const checks = db.prepare("PRAGMA quick_check").all();
  if (
    !checks.length ||
    checks.some((entry) => Object.values(entry)[0] !== "ok")
  ) {
    throw new Error(
      "官方预设数据库完整性检查失败，原文件未修改。请先在官方启动器中检查预设。",
    );
  }
  const playsetRows = db
    .prepare(
      `SELECT p.id, p.name, ${sqlField(playsetColumns, "p", "isActive", "0")} AS isActive,
    ${sqlField(playsetColumns, "p", "loadOrder", "'custom'")} AS loadOrder
    FROM playsets p WHERE COALESCE(${sqlField(playsetColumns, "p", "isRemoved", "0")}, 0) = 0
    ORDER BY p.id LIMIT ${MAX_PLAYSETS + 1}`,
    )
    .all();
  if (playsetRows.length > MAX_PLAYSETS)
    throw new Error("官方数据库超过 1000 个预设，请分批导出 JSON 后导入。");
  const rowFields = [
    "steamId",
    "pdxId",
    "gameRegistryId",
    "name",
    "displayName",
    "dirPath",
    "archivePath",
    "source",
    "version",
    "keepLatest",
  ];
  const membersQuery = db.prepare(`SELECT pm.modId AS memberId,
    ${sqlField(memberColumns, "pm", "position", "NULL")} AS position,
    ${sqlField(memberColumns, "pm", "enabled", "1")} AS enabled,
    ${rowFields.map((field) => `${sqlField(modColumns, "m", field)} AS "${field}"`).join(",")}
    FROM playsets_mods pm LEFT JOIN mods m ON m.id = pm.modId
    WHERE pm.playsetId = ? ORDER BY ${sqlField(memberColumns, "pm", "position", "pm.modId")}, pm.modId
    LIMIT ${MAX_MEMBERS + 1}`);
  const dlcColumns = sqlColumns(db, "playsets_dlcs");
  const dlcQuery = ["playsetId", "dlcId", "enabled"].every((field) =>
    dlcColumns.has(field),
  )
    ? db.prepare(
        "SELECT dlcId, enabled FROM playsets_dlcs WHERE playsetId = ? LIMIT 10001",
      )
    : null;
  const known = knownModMap(mods);
  const dlcById = new Map();
  for (const item of dlc) {
    if (!item || typeof item.id !== "string") continue;
    dlcById.set(item.id, item.id);
    if (item.popsId) dlcById.set(item.popsId, item.id);
  }
  const playsets = playsetRows.map((row) => {
    const name = validateName(row.name, "官方预设名称");
    if (typeof row.id !== "string" || !row.id || row.id.length > 255)
      throw new Error("官方预设包含无效标识，无法导入。");
    const memberRows = membersQuery.all(row.id);
    if (memberRows.length > MAX_MEMBERS)
      throw new Error(`预设「${name}」超过 10000 个成员，无法导入。`);
    const identities = new Set();
    const entries = memberRows.map((member) => {
      const identity = databaseModIdentity(member, mods, warnings);
      if (identities.has(identity.id))
        throw new Error(
          `官方预设「${name}」包含重复模组，无法无损导入，请先在官方启动器修复。`,
        );
      identities.add(identity.id);
      const installed = known.get(identity.id);
      const displayName = cleanName(
        installed?.name,
        cleanName(member.displayName, cleanName(member.name, identity.id)),
      );
      return {
        ...identity,
        name: displayName,
        enabled: member.enabled !== 0,
        ...(identity.source === "pdx" &&
        member.keepLatest === 0 &&
        typeof member.version === "string" &&
        member.version
          ? { version: member.version }
          : {}),
      };
    });
    const dlcRows = dlcQuery?.all(row.id) || [];
    if (dlcRows.length > 10000)
      throw new Error(`预设「${name}」的 DLC 配置数量无效。`);
    const disabled = dlcRows.filter((entry) => entry.enabled === 0);
    const unmappedDlcIds = disabled
      .filter((entry) => !dlcById.has(entry.dlcId))
      .map((entry) => String(entry.dlcId));
    if (unmappedDlcIds.length)
      warnings.push(
        `预设「${name}」有 ${unmappedDlcIds.length} 个停用 DLC 无法映射，已保留现有游戏 DLC 状态，请检查 DLC 列表。`,
      );
    return {
      sourceId: row.id,
      name,
      isActive: row.isActive === 1,
      modOrder: entries.map((entry) => entry.id),
      modIds: entries.filter((entry) => entry.enabled).map((entry) => entry.id),
      disabledDlcIds:
        dlcRows.length && !unmappedDlcIds.length
          ? [...new Set(disabled.map((entry) => dlcById.get(entry.dlcId)))]
          : null,
      unmappedDlcIds,
      modReferences: entries.map(({ enabled, ...reference }) => reference),
    };
  });
  return { playsets, warnings: [...new Set(warnings)] };
}

async function readOfficialPlaysets({ userData, mods = [], dlc = [] } = {}) {
  if (typeof userData !== "string" || !path.isAbsolute(userData))
    throw new Error("缺少有效的游戏用户目录，无法导入官方预设。");
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require("node:sqlite"));
  } catch {
    throw new Error(
      "当前桌面运行时不支持 SQLite，请升级启动器后再导入官方预设，或使用 JSON 文件导入。",
    );
  }
  const source = path.join(userData, "launcher-v2.sqlite");
  if (!(await fingerprint(source)))
    return {
      playsets: [],
      warnings: ["此游戏用户目录中没有官方启动器预设数据库。"],
    };
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    const snapshotRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ironclad-playsets-"),
    );
    const snapshot = path.join(snapshotRoot, "launcher-v2.sqlite");
    let db;
    try {
      if (!(await makeSnapshot(source, snapshot)))
        throw new Error("官方预设数据库已被移动，请刷新后重试。");
      db = new DatabaseSync(snapshot, { readOnly: true });
      db.exec("PRAGMA query_only = ON; BEGIN;");
      const result = readSnapshot(db, { mods, dlc });
      db.exec("COMMIT;");
      return result;
    } catch (error) {
      lastError = error;
      const transient =
        error.snapshotChanged ||
        ["SQLITE_BUSY", "SQLITE_LOCKED", "ENOENT"].includes(error.code) ||
        /database is locked|database disk image is malformed/i.test(
          error.message,
        );
      if (!transient || attempt === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 60 * (attempt + 1)));
    } finally {
      db?.close();
      if (
        path.dirname(snapshotRoot) === os.tmpdir() &&
        path.basename(snapshotRoot).startsWith("ironclad-playsets-")
      ) {
        await fs.rm(snapshotRoot, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 50,
        });
      }
    }
  }
  if (lastError?.snapshotChanged) throw lastError;
  if (
    lastError?.message &&
    !lastError.code &&
    !/^SQLite|database|no such|unable to/i.test(lastError.message)
  )
    throw lastError;
  throw new Error(
    "无法读取官方预设数据库，原文件未修改。请关闭官方启动器后重试，或使用它导出的 JSON 预设。",
  );
}

module.exports = {
  readOfficialPlaysets,
  parsePlaysetDocument,
  serializePlayset,
};
