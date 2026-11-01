"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const FIELDS = [
  "gameDirectory",
  "launchMode",
  "playsets",
  "activePlaysetId",
  "disabledDlcIds",
  "gameOptions",
  "modDisplayNames",
];
const clone = (value) => JSON.parse(JSON.stringify(value));
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const profile = (value) =>
  Object.fromEntries(
    FIELDS.map((key) => [
      key,
      clone(key === "modDisplayNames" ? (value[key] ?? {}) : value[key]),
    ]),
  );
const validId = (value) =>
  value === "default" ||
  /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(value);

function name(value) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.trim().length > 128 ||
    /[\0-\x1f]/.test(value)
  )
    throw new Error("版本实例名称须为 1 至 128 个字符。");
  return value.trim();
}

function normalizeSettings(input, normalizeProfile) {
  if (!object(input)) throw new Error("启动器设置格式无效。");
  const { gameInstances, activeGameInstanceId, ...base } = input;
  if (input.schemaVersion === 3) base.schemaVersion = 2;
  const normalized = normalizeProfile(base);
  if (gameInstances === undefined) {
    if (input.schemaVersion === 3 || activeGameInstanceId !== undefined)
      throw new Error("版本实例配置无效。");
    return {
      ...normalized,
      schemaVersion: 3,
      activeGameInstanceId: "default",
      gameInstances: [
        {
          id: "default",
          name: "默认版本",
          isolated: false,
          ...profile(normalized),
        },
      ],
    };
  }
  if (
    input.schemaVersion !== 3 ||
    !Array.isArray(gameInstances) ||
    !gameInstances.length ||
    gameInstances.length > 50
  )
    throw new Error("请保留 1 至 50 个版本实例。");
  const seen = new Set();
  const result = gameInstances.map((item) => {
    if (
      !object(item) ||
      typeof item.id !== "string" ||
      !validId(item.id) ||
      seen.has(item.id) ||
      Object.keys(item).some(
        (key) => !["id", "name", "isolated", ...FIELDS].includes(key),
      ) ||
      item.isolated !== (item.id !== "default")
    )
      throw new Error("版本实例配置无效。");
    seen.add(item.id);
    const snapshot = normalizeProfile({ ...profile(item), schemaVersion: 2 });
    return {
      id: item.id,
      name: name(item.name),
      isolated: item.isolated,
      ...profile(snapshot),
    };
  });
  if (!seen.has("default") || !seen.has(activeGameInstanceId))
    throw new Error("当前版本实例不存在。");
  // The existing top-level fields remain the active profile for all services.
  return {
    ...normalized,
    schemaVersion: 3,
    activeGameInstanceId,
    gameInstances: result.map((item) =>
      item.id === activeGameInstanceId
        ? { ...item, ...profile(normalized) }
        : item,
    ),
  };
}

function change(settings, action, input) {
  const next = clone(settings);
  const id = object(input) ? input.id : input;
  const current = next.gameInstances.find((item) => item.id === id);
  if (action === "create") {
    if (
      !object(input) ||
      Object.keys(input).some((key) => !["name", "gameDirectory"].includes(key))
    )
      throw new Error("版本实例配置无效。");
    if (next.gameInstances.length >= 50)
      throw new Error("请保留 1 至 50 个版本实例。");
    const created = {
      id: randomUUID(),
      name: name(input.name),
      isolated: true,
      gameDirectory: input.gameDirectory,
      launchMode: "normal",
      playsets: [{ id: "default", name: "默认预设", modIds: [] }],
      activePlaysetId: "default",
      disabledDlcIds: null,
      gameOptions: {},
    };
    if (
      typeof created.gameDirectory !== "string" ||
      !path.isAbsolute(created.gameDirectory) ||
      /[\0-\x1f]/.test(created.gameDirectory)
    )
      throw new Error("游戏目录无效，请重新选择。");
    next.gameInstances.push(created);
    next.activeGameInstanceId = created.id;
    Object.assign(next, profile(created));
  } else {
    if (!current) throw new Error("当前版本实例不存在。");
    if (action === "switch") {
      next.activeGameInstanceId = id;
      Object.assign(next, profile(current));
    } else if (action === "rename") {
      if (Object.keys(input).some((key) => !["id", "name"].includes(key)))
        throw new Error("版本实例配置无效。");
      current.name = name(input.name);
    } else if (action === "remove") {
      if (id === "default") throw new Error("默认版本实例不能移除。");
      next.gameInstances = next.gameInstances.filter((item) => item.id !== id);
      if (next.activeGameInstanceId === id) {
        next.activeGameInstanceId = "default";
        Object.assign(
          next,
          profile(next.gameInstances.find((item) => item.id === "default")),
        );
      }
    } else throw new Error("版本实例配置无效。");
  }
  return next;
}

async function resolveUserData(settingsPath, id) {
  if (typeof id !== "string" || id === "default" || !validId(id))
    throw new Error("版本实例配置无效。");
  let target = path.dirname(settingsPath);
  for (const part of ["game-instances", id, "user-data"]) {
    target = path.join(target, part);
    try {
      const stat = await fs.lstat(target);
      if (stat.isSymbolicLink() || !stat.isDirectory())
        throw new Error("隔离目录包含链接或非目录项，请检查版本实例目录。");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return target;
}

module.exports = { normalizeSettings, change, resolveUserData };
