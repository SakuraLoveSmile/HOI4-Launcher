"use strict";

const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");

const FINGERPRINT_LIMITS = Object.freeze({
  modBytes: 20 * 1024 ** 3,
  modEntries: 100000,
  totalBytes: 100 * 1024 ** 3,
  totalEntries: 200000,
});
const MAX_MEMBERS = 10000;
const MAX_DOCUMENT_BYTES = 32 * 1024 ** 2;
const digestPattern = /^[a-f0-9]{64}$/;
const statuses = new Set(["not-recorded", "verified", "unavailable"]);
const sources = new Set(["local", "workshop", "pdx"]);
const clone = (value) => structuredClone(value);
const sha = (value) => createHash("sha256").update(value).digest("hex");
const sorted = (values) => [...values].sort();
const object = (value) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const stable = (value) =>
  JSON.stringify(value, function (_key, entry) {
    if (!object(entry)) return entry;
    return Object.fromEntries(
      Object.keys(entry)
        .sort()
        .map((key) => [key, entry[key]]),
    );
  });
const same = (left, right) => stable(left) === stable(right);

function invalid() {
  throw new Error("战役启动环境记录无效或超过允许大小。");
}
function keys(value, expected, optional = []) {
  if (!object(value)) invalid();
  const own = Reflect.ownKeys(value);
  if (
    own.length > expected.length + optional.length ||
    own.some(
      (key) =>
        typeof key !== "string" ||
        ![...expected, ...optional].includes(key) ||
        !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), "value"),
    ) ||
    expected.some((key) => !Object.hasOwn(value, key))
  )
    invalid();
}
function text(value, max = 4096, nullable = false) {
  if (nullable && value === null) return;
  if (typeof value !== "string" || value.length > max || value.includes("\0"))
    invalid();
}
function list(value, max = MAX_MEMBERS) {
  if (!Array.isArray(value) || value.length > max) invalid();
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index)) invalid();
    text(value[index]);
    if (!value[index]) invalid();
  }
  if (new Set(value).size !== value.length) invalid();
}
function options(value) {
  if (!object(value) || Object.keys(value).length > 100) invalid();
  for (const key of Object.keys(value)) {
    if (
      !/^[a-zA-Z_][a-zA-Z0-9_]{0,99}$/.test(key) ||
      !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), "value")
    )
      invalid();
    const entry = value[key];
    if (typeof entry === "string") text(entry, 1024);
    else if (
      typeof entry !== "boolean" &&
      !(typeof entry === "number" && Number.isFinite(entry))
    )
      invalid();
  }
}

function configuration(environment) {
  return {
    gameVersion: environment.game.version,
    mods: environment.mods.map(({ name, ...mod }) => mod),
    dlcIds: environment.dlcIds,
    gameOptions: environment.gameOptions,
    launchMode: environment.launchMode,
  };
}

function validateEnvironment(value) {
  keys(value, [
    "schemaVersion",
    "game",
    "playset",
    "dlcIds",
    "gameOptions",
    "launchMode",
    "mods",
    "configurationId",
  ]);
  if (value.schemaVersion !== 1) invalid();
  keys(value.game, [
    "version",
    "directory",
    "instanceId",
    "instanceName",
    "userData",
  ]);
  text(value.game.version, 1024, true);
  for (const key of ["directory", "instanceId", "instanceName", "userData"])
    text(value.game[key]);
  const playset = value.playset;
  keys(playset, [
    "id",
    "name",
    "modIds",
    "modOrder",
    "modReferences",
    "disabledDlcIds",
    "unmappedDlcIds",
    "origin",
  ]);
  text(playset.id, 120);
  text(playset.name, 128);
  text(playset.origin, 200, true);
  list(playset.modIds);
  list(playset.modOrder);
  list(playset.unmappedDlcIds);
  if (playset.disabledDlcIds !== null) list(playset.disabledDlcIds);
  const enabled = new Set(playset.modIds);
  if (
    !same(
      playset.modOrder.filter((id) => enabled.has(id)),
      playset.modIds,
    )
  )
    invalid();
  if (
    !Array.isArray(playset.modReferences) ||
    playset.modReferences.length > MAX_MEMBERS
  )
    invalid();
  const references = new Set();
  for (const reference of playset.modReferences) {
    keys(reference, ["id", "name", "source", "remoteId"], ["version"]);
    text(reference.id);
    text(reference.name, 1024);
    text(reference.remoteId, 1024, true);
    if (Object.hasOwn(reference, "version")) text(reference.version, 1024);
    if (
      !sources.has(reference.source) ||
      !playset.modOrder.includes(reference.id) ||
      references.has(reference.id)
    )
      invalid();
    references.add(reference.id);
  }
  list(value.dlcIds);
  if (!same(value.dlcIds, sorted(value.dlcIds))) invalid();
  options(value.gameOptions);
  if (!["normal", "debug"].includes(value.launchMode)) invalid();
  if (!Array.isArray(value.mods) || value.mods.length > MAX_MEMBERS) invalid();
  for (const mod of value.mods) {
    keys(mod, [
      "id",
      "name",
      "source",
      "remoteId",
      "version",
      "revision",
      "projectId",
      "projectVersion",
      "available",
      "contentDigest",
      "contentStatus",
    ]);
    text(mod.id);
    text(mod.name, 1024);
    for (const key of [
      "remoteId",
      "version",
      "revision",
      "projectId",
      "projectVersion",
    ])
      text(mod[key], 1024, true);
    if (
      !sources.has(mod.source) ||
      typeof mod.available !== "boolean" ||
      !statuses.has(mod.contentStatus) ||
      (mod.contentStatus === "verified"
        ? !mod.available ||
          typeof mod.contentDigest !== "string" ||
          !digestPattern.test(mod.contentDigest)
        : mod.contentDigest !== null)
    )
      invalid();
  }
  if (
    !same(
      value.mods.map((mod) => mod.id),
      playset.modIds,
    )
  )
    invalid();
  if (
    typeof value.configurationId !== "string" ||
    !digestPattern.test(value.configurationId) ||
    value.configurationId !== sha(stable(configuration(value))) ||
    Buffer.byteLength(JSON.stringify(value)) > MAX_DOCUMENT_BYTES
  )
    invalid();
  return value;
}

function selected(state) {
  const playset = state.settings?.playsets?.find(
    (entry) => entry.id === state.settings.activePlaysetId,
  );
  if (!playset) throw new Error("当前播放集不存在，无法记录启动环境。");
  const enabled = new Set(playset.modIds);
  const order = [...new Set([...(playset.modOrder || []), ...playset.modIds])];
  const found = new Map((state.mods || []).map((mod) => [mod.id, mod]));
  const references = new Map(
    (playset.modReferences || []).map((reference) => [reference.id, reference]),
  );
  return {
    playset,
    mods: order
      .filter((id) => enabled.has(id))
      .map((id) => ({
        ...references.get(id),
        ...found.get(id),
        id,
        available: found.get(id)?.available === true,
      })),
  };
}

function captureEnvironment(state, { fingerprints = {} } = {}) {
  const selection = selected(state);
  const activeInstance = state.settings.gameInstances?.find(
    (entry) => entry.id === state.settings.activeGameInstanceId,
  );
  const playset = clone({
    ...selection.playset,
    modIds: selection.mods.map((mod) => mod.id),
    modOrder: selection.playset.modOrder || selection.playset.modIds,
    modReferences: selection.playset.modReferences || [],
    disabledDlcIds: selection.playset.disabledDlcIds ?? null,
    unmappedDlcIds: selection.playset.unmappedDlcIds || [],
    origin: selection.playset.origin ?? null,
  });
  const environment = {
    schemaVersion: 1,
    game: {
      version: state.game?.version ?? null,
      directory: state.game?.directory ?? state.settings.gameDirectory ?? "",
      instanceId: state.settings.activeGameInstanceId || "default",
      instanceName: activeInstance?.name || "",
      userData: state.paths?.userData || "",
    },
    playset,
    dlcIds: sorted([
      ...new Set(
        (state.dlc?.items || [])
          .filter((item) => item.installed === true && item.enabled === true)
          .map((item) => item.id),
      ),
    ]),
    gameOptions: clone(state.gameOptions?.values || {}),
    launchMode: state.settings.launchMode || "normal",
    mods: selection.mods.map((mod) => {
      const fingerprint = Object.hasOwn(fingerprints, mod.id)
        ? fingerprints[mod.id]
        : null;
      const verified = Boolean(
        mod.available &&
          fingerprint?.status === "verified" &&
          typeof fingerprint.digest === "string" &&
          digestPattern.test(fingerprint.digest),
      );
      return {
        id: mod.id,
        name: mod.name || mod.id,
        source: sources.has(mod.source) ? mod.source : "local",
        remoteId: mod.remoteId ?? null,
        version: mod.version ?? null,
        revision: mod.installedRevision ?? null,
        projectId: mod.projectId ?? null,
        projectVersion: mod.projectVersion ?? null,
        available: mod.available,
        contentDigest: verified ? fingerprint.digest : null,
        contentStatus: verified
          ? "verified"
          : fingerprint
            ? "unavailable"
            : "not-recorded",
      };
    }),
  };
  environment.configurationId = sha(stable(configuration(environment)));
  return validateEnvironment(environment);
}

function compareEnvironments(before, after) {
  validateEnvironment(before);
  validateEnvironment(after);
  const changes = [];
  const change = (kind, oldValue, newValue, extra = {}) => {
    if (!same(oldValue, newValue))
      changes.push({
        kind,
        ...extra,
        before: clone(oldValue),
        after: clone(newValue),
      });
  };
  change("game", before.game.version, after.game.version);
  const previous = new Map(before.mods.map((mod) => [mod.id, mod]));
  const current = new Map(after.mods.map((mod) => [mod.id, mod]));
  const version = (mod) => ({
    source: mod.source,
    remoteId: mod.remoteId,
    version: mod.version,
    revision: mod.revision,
    projectId: mod.projectId,
    projectVersion: mod.projectVersion,
  });
  for (const mod of before.mods) {
    if (!current.has(mod.id))
      changes.push({
        kind: "mods-removed",
        id: mod.id,
        name: mod.name,
        before: clone(mod),
      });
  }
  for (const mod of after.mods) {
    const old = previous.get(mod.id);
    const detail = { id: mod.id, name: mod.name };
    if (!old)
      changes.push({ kind: "mods-added", ...detail, after: clone(mod) });
    else {
      change("mod-version", version(old), version(mod), detail);
      if (old.contentStatus === "verified" && mod.contentStatus === "verified")
        change("mod-content", old.contentDigest, mod.contentDigest, detail);
    }
  }
  // Add/remove has its own evidence. Order describes only members present in both.
  change(
    "order",
    before.mods.filter((mod) => current.has(mod.id)).map((mod) => mod.id),
    after.mods.filter((mod) => previous.has(mod.id)).map((mod) => mod.id),
  );
  change("dlc", before.dlcIds, after.dlcIds);
  change("settings", before.gameOptions, after.gameOptions);
  change("mode", before.launchMode, after.launchMode);
  for (const id of new Set([...previous.keys(), ...current.keys()])) {
    const old = previous.get(id),
      next = current.get(id);
    if (
      (old && old.contentStatus !== "verified") ||
      (next && next.contentStatus !== "verified")
    )
      changes.push({
        kind: "unverified",
        id,
        name: next?.name || old.name,
        before: old?.contentStatus ?? null,
        after: next?.contentStatus ?? null,
      });
  }
  return changes;
}

function abort(signal) {
  if (signal?.aborted)
    throw Object.assign(new Error("已取消模组内容校验。"), {
      name: "AbortError",
      code: "ABORT_ERR",
    });
}
function problem(message) {
  return Object.assign(new Error(message), { environmentFingerprint: true });
}
const canonical = (filename) => {
  const resolved = path.resolve(filename);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
};
const identity = (stat) => [stat.dev, stat.ino, stat.birthtimeNs];
const signature = (stat) => [
  ...identity(stat),
  stat.mode,
  stat.nlink,
  stat.size,
  stat.mtimeNs,
  stat.ctimeNs,
];
const equalParts = (a, b) =>
  a.length === b.length && a.every((part, i) => part === b[i]);
const sameIdentity = (a, b) => equalParts(identity(a), identity(b));
const unchanged = (a, b) => equalParts(signature(a), signature(b));

async function safeStat(filename, signal) {
  abort(signal);
  const stat = await fs.lstat(filename, { bigint: true });
  if (
    stat.isSymbolicLink() ||
    (!stat.isDirectory() && !stat.isFile()) ||
    (stat.isFile() && stat.nlink !== 1n)
  )
    throw problem("模组内容包含链接、硬链接或特殊文件，无法确认内容。");
  return stat;
}

async function pathChain(directory, signal) {
  const resolved = path.resolve(directory),
    root = path.parse(resolved).root;
  const chain = [];
  let current = root;
  for (const part of [
    "",
    ...resolved.slice(root.length).split(path.sep).filter(Boolean),
  ]) {
    if (part) current = path.join(current, part);
    const stat = await safeStat(current, signal);
    if (
      !stat.isDirectory() ||
      canonical(await fs.realpath(current)) !== canonical(current)
    )
      throw problem("模组路径包含链接、目录联接或重定向，无法确认内容。");
    chain.push({ path: current, stat });
  }
  return chain;
}

async function checkChain(chain, signal) {
  const current = await pathChain(chain.at(-1).path, signal);
  if (
    current.length !== chain.length ||
    current.some((entry, i) => !sameIdentity(entry.stat, chain[i].stat))
  )
    throw problem("模组路径在校验期间发生变化，请稍后重试。");
}

function reserve(stat, local, budget) {
  local.entries++;
  budget.entries++;
  if (stat.isFile()) {
    local.bytes += Number(stat.size);
    budget.bytes += Number(stat.size);
  }
  if (
    local.entries > FINGERPRINT_LIMITS.modEntries ||
    local.bytes > FINGERPRINT_LIMITS.modBytes ||
    budget.entries > FINGERPRINT_LIMITS.totalEntries ||
    budget.bytes > FINGERPRINT_LIMITS.totalBytes
  )
    throw problem("模组内容超过校验数量或大小上限，未确认内容。");
}

async function tree(root, signal, budget = null) {
  const entries = new Map(),
    local = { entries: 0, bytes: 0 };
  async function visit(filename, name) {
    abort(signal);
    if (name.length > 4096) throw problem("模组相对路径超过校验上限。");
    const stat = await safeStat(filename, signal);
    if (budget) reserve(stat, local, budget);
    else if (++local.entries > FINGERPRINT_LIMITS.modEntries)
      throw problem("模组内容在校验期间超过数量上限。");
    entries.set(name, { stat, directory: stat.isDirectory() });
    if (!stat.isDirectory()) return;
    if (canonical(await fs.realpath(filename)) !== canonical(filename))
      throw problem("模组目录存在链接或重定向，无法确认内容。");
    const directory = await fs.opendir(filename);
    for await (const child of directory) {
      await visit(
        path.join(filename, child.name),
        name ? `${name}/${child.name}` : child.name,
      );
    }
    if (!unchanged(stat, await safeStat(filename, signal)))
      throw problem("模组目录在校验期间发生变化，请稍后重试。");
  }
  await visit(root, "");
  return entries;
}

async function fileDigest(filename, expected, chain, signal, buffer) {
  abort(signal);
  await checkChain(chain, signal);
  const fileChain = await pathChain(path.dirname(filename), signal);
  if (
    chain.some(
      (entry, i) =>
        !fileChain[i] || !sameIdentity(entry.stat, fileChain[i].stat),
    )
  )
    throw problem("模组路径在校验期间发生变化，请稍后重试。");
  const handle = await fs.open(
    filename,
    constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
  );
  try {
    if (!unchanged(expected, await handle.stat({ bigint: true })))
      throw problem("模组文件在校验前发生变化，请重试。");
    const hash = createHash("sha256");
    let bytes = 0;
    for (;;) {
      abort(signal);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      abort(signal);
      if (!bytesRead) break;
      bytes += bytesRead;
      if (bytes > Number(expected.size))
        throw problem("模组文件在校验期间增长，请稍后重试。");
      hash.update(buffer.subarray(0, bytesRead));
    }
    if (
      bytes !== Number(expected.size) ||
      !unchanged(expected, await handle.stat({ bigint: true })) ||
      !unchanged(expected, await safeStat(filename, signal))
    )
      throw problem("模组文件在校验期间发生变化，请稍后重试。");
    await checkChain(fileChain, signal);
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

async function fingerprintMod(mod, signal, budget, buffer) {
  if (
    !mod.available ||
    typeof mod.contentPath !== "string" ||
    !path.isAbsolute(mod.contentPath) ||
    mod.contentPath.length > 4096 ||
    mod.contentPath.includes("\0")
  )
    throw problem("模组内容缺失或没有可读取的本地路径。");
  const target = path.resolve(mod.contentPath);
  const parents = await pathChain(path.dirname(target), signal);
  const stat = await safeStat(target, signal);
  if (stat.isFile()) {
    reserve(stat, { entries: 0, bytes: 0 }, budget);
    return fileDigest(target, stat, parents, signal, buffer);
  }
  const before = await tree(target, signal, budget);
  const hash = createHash("sha256").update("IRONCLAD-mod-tree-v1\0");
  for (const name of sorted(before.keys())) {
    const entry = before.get(name);
    if (entry.directory)
      hash.update(JSON.stringify(["directory", name]) + "\n");
    else {
      const digest = await fileDigest(
        path.join(target, ...name.split("/")),
        entry.stat,
        parents,
        signal,
        buffer,
      );
      hash.update(
        JSON.stringify(["file", name, Number(entry.stat.size), digest]) + "\n",
      );
    }
  }
  const after = await tree(target, signal);
  if (
    before.size !== after.size ||
    [...before].some(([name, entry]) => {
      const next = after.get(name);
      return (
        !next ||
        next.directory !== entry.directory ||
        !unchanged(entry.stat, next.stat)
      );
    })
  )
    throw problem("模组文件树在校验期间发生变化，请稍后重试。");
  await checkChain(parents, signal);
  abort(signal);
  return hash.digest("hex");
}

async function fingerprintMods(state, { signal, onProgress } = {}) {
  abort(signal);
  const { mods } = selected(state);
  if (mods.length > MAX_MEMBERS)
    throw new Error("启用模组数量超过内容校验上限。");
  const budget = { entries: 0, bytes: 0 },
    result = [];
  const buffer = Buffer.allocUnsafe(1024 ** 2);
  for (const [index, mod] of mods.entries()) {
    abort(signal);
    onProgress?.({ modId: mod.id, index: index + 1, total: mods.length });
    try {
      const digest = await fingerprintMod(mod, signal, budget, buffer);
      result.push([mod.id, { digest, status: "verified" }]);
    } catch (error) {
      abort(signal);
      if (error.name === "AbortError") throw error;
      result.push([
        mod.id,
        {
          digest: null,
          status: "unavailable",
          reason: error.environmentFingerprint
            ? error.message
            : "模组文件缺失、不可读取或校验期间发生变化。",
        },
      ]);
    }
  }
  abort(signal);
  return Object.fromEntries(result);
}

module.exports = {
  captureEnvironment,
  compareEnvironments,
  fingerprintMods,
  validateEnvironment,
  FINGERPRINT_LIMITS,
};
