"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { randomUUID } = require("node:crypto");
const gameSupport = require("./game-support.cjs");
const playsetTransfer = require("./playset-transfer.cjs");
const maintenance = require("./maintenance-service.cjs");
const modAuthoring = require("./mod-authoring.cjs");
const { createModThumbnails } = require("./mod-thumbnails.cjs");
const instances = require("./game-instances.cjs");
const modRemoval = require("./mod-removal.cjs");
const { captureEnvironment } = require("./launch-environment.cjs");

const execFileAsync = promisify(execFile);
const MANAGED_MARKER = "# Managed by IRONCLAD.\n";
const LAUNCHER_LANGUAGES = new Set([
  "en",
  "de",
  "es",
  "fr",
  "ja",
  "ko",
  "pl",
  "pt",
  "ru",
  "tr",
  "zh-hans",
  "zh-hant",
]);
const DEFAULT_SETTINGS = {
  schemaVersion: 2,
  gameDirectory: "",
  launchMode: "normal",
  playsets: [{ id: "default", name: "默认预设", modIds: [] }],
  activePlaysetId: "default",
  disabledDlcIds: null,
  gameOptions: {},
  modDisplayNames: {},
  launcherPreferences: { closeOnLaunch: false, language: "zh-hans" },
};

const clone = (value) => JSON.parse(JSON.stringify(value));
const forward = (value) => value.replace(/\\/g, "/");
const dlcKey = (value) => forward(value).toLowerCase();
const canonical = (value) => path.resolve(value).toLowerCase();
const quoted = (value) =>
  '"' +
  forward(value)
    .replace(/"/g, '\\"')
    .replace(/[\r\n]/g, "") +
  '"';
const isObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

async function exists(target, type = "any") {
  try {
    const stat = await fs.stat(target);
    return type === "file"
      ? stat.isFile()
      : type === "directory"
        ? stat.isDirectory()
        : true;
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return false;
    throw error;
  }
}

async function readOptional(target) {
  try {
    return await fs.readFile(target, "utf8");
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
    throw error;
  }
}

async function atomicWrite(target, text) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temp = target + ".tmp-" + randomUUID();
  try {
    await fs.writeFile(temp, text, { flag: "wx" });
    await fs.rename(temp, target);
  } finally {
    await fs.unlink(temp).catch(() => {});
  }
}

// Both Valve KeyValues and Paradox descriptors use quoted strings and braces.
// Keep assignment spans so workshop descriptors retain replace_path/dependencies.
function parseDocument(text) {
  const tokens = [];
  const re = /#[^\r\n]*|\/\/[^\r\n]*|"(?:\\.|[^"\\])*"|[{}=]|[^\s{}="#]+/g;
  for (const match of text.matchAll(re)) {
    if (match[0].startsWith("#") || match[0].startsWith("//")) continue;
    const raw = match[0];
    const value = raw.startsWith('"')
      ? raw.slice(1, -1).replace(/\\(["\\])/g, "$1")
      : raw;
    tokens.push({ value, start: match.index, end: match.index + raw.length });
  }
  const assignments = [];
  for (let i = 0; i < tokens.length; ) {
    const key = tokens[i++];
    if (["{", "}", "="].includes(key.value)) continue;
    if (tokens[i]?.value === "=") i++;
    const first = tokens[i++];
    if (!first) break;
    let end = first.end;
    let value = first.value;
    if (first.value === "{") {
      const block = [];
      let depth = 1;
      while (i < tokens.length && depth > 0) {
        const token = tokens[i++];
        end = token.end;
        if (token.value === "{") depth++;
        if (token.value === "}") depth--;
        if (depth > 0) block.push(token.value);
      }
      value = block;
    }
    assignments.push({ key: key.value, value, start: key.start, end });
  }
  return {
    assignments,
    get(key) {
      return assignments.findLast((item) => item.key === key)?.value;
    },
  };
}

function normalizeProfileSettings(input) {
  if (!isObject(input)) throw new Error("启动器设置格式无效。");
  input = { ...clone(DEFAULT_SETTINGS), ...input };
  const allowed = new Set([
    "schemaVersion",
    "gameDirectory",
    "launchMode",
    "playsets",
    "activePlaysetId",
    "disabledDlcIds",
    "gameOptions",
    "modDisplayNames",
    "launcherPreferences",
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key)))
    throw new Error("启动器设置包含不支持的字段。");
  if (
    typeof input.gameDirectory !== "string" ||
    input.gameDirectory.length > 4096 ||
    /[\0\r\n]/.test(input.gameDirectory)
  ) {
    throw new Error("游戏目录无效，请重新选择。");
  }
  if (input.gameDirectory && !path.isAbsolute(input.gameDirectory))
    throw new Error("请选择完整的游戏目录。");
  if (!["normal", "debug"].includes(input.launchMode))
    throw new Error("不支持的启动模式。");
  if (![1, 2].includes(input.schemaVersion))
    throw new Error("此配置来自更新版本，请使用对应的启动器。");
  if (
    !isObject(input.modDisplayNames) ||
    Object.keys(input.modDisplayNames).length > 10000
  )
    throw new Error("模组显示名称配置无效。");
  const modDisplayNames = Object.fromEntries(
    Object.entries(input.modDisplayNames).map(([id, value]) => {
      if (
        !id ||
        id.length > 4096 ||
        /[\0-\x1f]/.test(id) ||
        !isObject(value) ||
        Object.keys(value).some((key) => !["name", "kind"].includes(key)) ||
        typeof value.name !== "string" ||
        !value.name.trim() ||
        value.name.trim().length > 128 ||
        /[\0-\x1f]/.test(value.name) ||
        !["custom", "translated"].includes(value.kind)
      )
        throw new Error("模组显示名称须为 1 至 128 个字符。");
      return [id, { name: value.name.trim(), kind: value.kind }];
    }),
  );
  const normalizeDlc = (ids) => {
    if (ids === undefined || ids === null) return null;
    if (
      !Array.isArray(ids) ||
      ids.length > 2000 ||
      ids.some(
        (id) =>
          typeof id !== "string" ||
          !id ||
          id.length > 1024 ||
          /[\0\r\n]/.test(id),
      )
    ) {
      throw new Error("DLC 选择格式无效。");
    }
    return [...new Set(ids)];
  };
  if (
    !isObject(input.gameOptions) ||
    Object.keys(input.gameOptions).length > 100 ||
    Object.entries(input.gameOptions).some(
      ([key, value]) =>
        !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key) ||
        !["string", "number", "boolean"].includes(typeof value) ||
        (typeof value === "string" &&
          (value.length > 200 || /[\0\r\n]/.test(value))) ||
        (typeof value === "number" && !Number.isFinite(value)),
    )
  ) {
    throw new Error("游戏设置格式无效。");
  }
  if (
    !isObject(input.launcherPreferences) ||
    Object.keys(input.launcherPreferences).some(
      (key) => !["closeOnLaunch", "language", "homeLayout"].includes(key),
    ) ||
    typeof input.launcherPreferences.closeOnLaunch !== "boolean"
  )
    throw new Error("启动器偏好格式无效。");
  // Existing v1/v2 preferences have no launcher language. Keep their Chinese UI.
  const launcherLanguage = Object.hasOwn(input.launcherPreferences, "language")
    ? input.launcherPreferences.language
    : DEFAULT_SETTINGS.launcherPreferences.language;
  if (!LAUNCHER_LANGUAGES.has(launcherLanguage))
    throw new Error("启动器语言无效，请选择支持的语言。");
  if (
    Object.hasOwn(input.launcherPreferences, "homeLayout") &&
    !["full", "compact"].includes(input.launcherPreferences.homeLayout)
  )
    throw new Error("启动器偏好格式无效。");
  if (
    !Array.isArray(input.playsets) ||
    !input.playsets.length ||
    input.playsets.length > 100
  )
    throw new Error("请保留 1 至 100 个模组预设。");
  const ids = new Set();
  const playsets = input.playsets.map((playset) => {
    if (
      !isObject(playset) ||
      typeof playset.id !== "string" ||
      !playset.id ||
      playset.id.length > 120 ||
      ids.has(playset.id)
    ) {
      throw new Error("预设标识无效或重复。");
    }
    ids.add(playset.id);
    if (
      typeof playset.name !== "string" ||
      !playset.name.trim() ||
      playset.name.trim().length > 128
    )
      throw new Error("预设名称须为 1 至 128 个字符。");
    if (
      !Array.isArray(playset.modIds) ||
      playset.modIds.length > 10000 ||
      playset.modIds.some(
        (id) => typeof id !== "string" || !id || id.length > 4096,
      )
    ) {
      throw new Error("预设中的模组列表无效。");
    }
    const modOrder = playset.modOrder ?? playset.modIds;
    if (
      !Array.isArray(modOrder) ||
      modOrder.length > 10000 ||
      modOrder.some((id) => typeof id !== "string" || !id || id.length > 4096)
    )
      throw new Error("模组加载顺序无效。");
    const order = [...new Set([...modOrder, ...playset.modIds])];
    const enabled = new Set(playset.modIds);
    const references = playset.modReferences ?? [];
    if (
      !Array.isArray(references) ||
      references.length > 10000 ||
      references.some(
        (ref) =>
          !isObject(ref) ||
          typeof ref.id !== "string" ||
          !order.includes(ref.id) ||
          typeof ref.name !== "string" ||
          ref.name.length > 1024 ||
          !["local", "workshop", "pdx"].includes(ref.source) ||
          (ref.remoteId !== null && typeof ref.remoteId !== "string"),
      )
    )
      throw new Error("模组引用信息无效。");
    if (
      playset.origin !== undefined &&
      playset.origin !== null &&
      (typeof playset.origin !== "string" || playset.origin.length > 200)
    )
      throw new Error("预设来源信息无效。");
    const unmappedDlcIds = normalizeDlc(playset.unmappedDlcIds) ?? [];
    return {
      id: playset.id,
      name: playset.name.trim(),
      modIds: order.filter((id) => enabled.has(id)),
      modOrder: order,
      disabledDlcIds: normalizeDlc(playset.disabledDlcIds),
      modReferences: references.map(
        ({ id, name, source, remoteId, version }) => {
          if (
            version !== undefined &&
            (typeof version !== "string" ||
              version.length > 255 ||
              /[\0\r\n]/.test(version))
          )
            throw new Error("模组固定版本无效。");
          return {
            id,
            name,
            source,
            remoteId,
            ...(version === undefined ? {} : { version }),
          };
        },
      ),
      origin: playset.origin ?? null,
      unmappedDlcIds,
    };
  });
  if (
    typeof input.activePlaysetId !== "string" ||
    !ids.has(input.activePlaysetId)
  )
    throw new Error("当前模组预设不存在。");
  return {
    schemaVersion: 2,
    gameDirectory: input.gameDirectory.trim(),
    launchMode: input.launchMode,
    playsets,
    activePlaysetId: input.activePlaysetId,
    disabledDlcIds: normalizeDlc(input.disabledDlcIds),
    gameOptions: { ...input.gameOptions },
    modDisplayNames,
    launcherPreferences: {
      ...input.launcherPreferences,
      language: launcherLanguage,
    },
  };
}

function normalizeSettings(input) {
  return instances.normalizeSettings(input, normalizeProfileSettings);
}

function createLauncherService(options = {}) {
  if (!options.settingsPath || !options.documentsPath)
    throw new Error("缺少启动器配置目录。");
  const settingsPath = path.resolve(options.settingsPath);
  let userData = path.join(
    options.documentsPath,
    "Paradox Interactive",
    "Hearts of Iron IV",
  );
  const spawnProcess = options.spawnProcess || spawn;
  const thumbnails = createModThumbnails();
  let settings;
  let settingsProblem;
  let steamRootsPromise;
  let queue = Promise.resolve();
  let launchStatus = {
    running: false,
    pid: null,
    startedAt: null,
    lastExitCode: null,
  };

  async function resolveUserData() {
    userData = await resolveSettingsUserData(settings);
    return userData;
  }

  async function resolveSettingsUserData(selected) {
    const instance = selected.gameInstances.find(
      (item) => item.id === selected.activeGameInstanceId,
    );
    if (instance.isolated)
      return instances.resolveUserData(settingsPath, instance.id);
    return gameSupport.resolveUserDirectory(
      selected.gameDirectory,
      options.documentsPath,
    );
  }

  async function readLaunchStatus() {
    if (launchStatus.running && !launchStatus.external)
      return { ...launchStatus };
    if (options.processProbe) {
      const external = await options.processProbe();
      return external
        ? {
            running: true,
            pid: external.pid,
            startedAt: null,
            lastExitCode: null,
            external: true,
          }
        : { ...launchStatus, running: false };
    }
    // Injected spawns belong to isolated tests; never inspect the real game there.
    if (!options.spawnProcess && process.platform === "win32") {
      try {
        const { stdout } = await execFileAsync(
          "tasklist.exe",
          ["/FI", "IMAGENAME eq hoi4.exe", "/FO", "CSV", "/NH"],
          { windowsHide: true, timeout: 3000 },
        );
        const match = stdout.match(/"hoi4\.exe","(\d+)"/i);
        if (match)
          return {
            running: true,
            pid: Number(match[1]),
            startedAt: null,
            lastExitCode: null,
            external: true,
          };
      } catch {
        /* A transient process query must not break configuration browsing. */
      }
    }
    return { ...launchStatus, running: false };
  }

  function serialized(fn) {
    const next = queue.then(fn, fn);
    queue = next.catch(() => {});
    return next;
  }

  async function steamRoots() {
    if (!steamRootsPromise)
      steamRootsPromise = (async () => {
        let roots = options.steamRoots
          ? [...options.steamRoots]
          : [
              process.env["ProgramFiles(x86)"] &&
                path.join(process.env["ProgramFiles(x86)"], "Steam"),
              process.env.ProgramFiles &&
                path.join(process.env.ProgramFiles, "Steam"),
              process.env.LOCALAPPDATA &&
                path.join(process.env.LOCALAPPDATA, "Steam"),
            ].filter(Boolean);
        if (!options.steamRoots && process.platform === "win32") {
          try {
            const { stdout } = await execFileAsync(
              "reg.exe",
              ["query", "HKCU\\Software\\Valve\\Steam", "/v", "SteamPath"],
              { windowsHide: true, timeout: 3000 },
            );
            const registryPath = stdout
              .match(/SteamPath\s+REG_SZ\s+(.+)/i)?.[1]
              ?.trim();
            if (registryPath) roots.unshift(registryPath);
          } catch {
            /* Steam is optional; manual directory selection remains available. */
          }
        }
        const expanded = [];
        const seen = new Set();
        for (let index = 0; index < roots.length; index++) {
          const root = path.resolve(roots[index]);
          if (seen.has(canonical(root))) continue;
          seen.add(canonical(root));
          expanded.push(root);
          const libraries = await readOptional(
            path.join(root, "steamapps", "libraryfolders.vdf"),
          ).catch(() => null);
          if (libraries) {
            for (const match of libraries.matchAll(
              /"path"\s*"((?:\\.|[^"\\])*)"/g,
            )) {
              roots.push(match[1].replace(/\\(["\\])/g, "$1"));
            }
            // Pre-2021 Steam library files use numeric keys with a string value.
            for (const match of libraries.matchAll(
              /"\d+"\s*"([A-Za-z]:[^"\r\n]+)"/g,
            ))
              roots.push(match[1].replace(/\\\\/g, "\\"));
          }
        }
        return expanded;
      })();
    return steamRootsPromise;
  }

  async function findGame() {
    for (const root of await steamRoots()) {
      const manifest = await readOptional(
        path.join(root, "steamapps", "appmanifest_394360.acf"),
      ).catch(() => null);
      const installDir = manifest?.match(
        /"installdir"\s*"((?:\\.|[^"\\])*)"/,
      )?.[1];
      const candidates = [
        installDir &&
          path.join(
            root,
            "steamapps",
            "common",
            installDir.replace(/\\\\/g, "\\"),
          ),
        path.join(root, "steamapps", "common", "Hearts of Iron IV"),
      ].filter(Boolean);
      for (const candidate of candidates) {
        if (
          await exists(path.join(candidate, "hoi4.exe"), "file").catch(
            () => false,
          )
        )
          return candidate;
      }
    }
    return "";
  }

  async function loadSettings() {
    if (settings) return;
    const content = await readOptional(settingsPath);
    if (content !== null) {
      try {
        settings = normalizeSettings(
          JSON.parse(content.replace(/^\uFEFF/, "")),
        );
      } catch {
        settings = normalizeSettings(clone(DEFAULT_SETTINGS));
        settingsProblem =
          "启动器配置文件损坏，已保留原文件。请先备份并移走该文件，再重启启动器：" +
          settingsPath;
      }
    } else {
      settings = normalizeSettings(clone(DEFAULT_SETTINGS));
      settings.gameDirectory = await findGame();
      settings = normalizeSettings(settings);
      if (settings.gameDirectory)
        await atomicWrite(settingsPath, JSON.stringify(settings, null, 2));
    }
  }

  function ensureWritable() {
    if (settingsProblem) throw new Error(settingsProblem);
  }

  async function save(patch) {
    await loadSettings();
    ensureWritable();
    if (!isObject(patch)) throw new Error("启动器设置格式无效。");
    if (
      ["gameInstances", "activeGameInstanceId"].some((key) =>
        Object.hasOwn(patch, key),
      )
    )
      throw new Error("请通过版本实例操作修改版本配置。");
    const next = normalizeSettings({ ...settings, ...patch });
    if (
      next.gameDirectory !== settings.gameDirectory &&
      (await readLaunchStatus()).running
    )
      throw new Error("请先退出游戏，再切换版本实例或游戏目录。");
    if (
      Object.hasOwn(patch, "gameDirectory") &&
      next.gameDirectory &&
      !(await exists(path.join(next.gameDirectory, "hoi4.exe"), "file"))
    ) {
      throw new Error(
        "所选目录中没有 hoi4.exe，请选择钢铁雄心 IV 的安装目录。",
      );
    }
    if (
      Object.hasOwn(patch, "gameOptions") &&
      Object.keys(next.gameOptions).length
    ) {
      if (!next.gameDirectory)
        throw new Error("请先配置游戏目录，再修改游戏设置。");
      const targetUserData = await resolveSettingsUserData(next);
      await gameSupport.planGameOptions(
        next.gameDirectory,
        targetUserData,
        next.gameOptions,
      );
    }
    await atomicWrite(settingsPath, JSON.stringify(next, null, 2));
    settings = next;
    return clone(settings);
  }

  async function changeInstance(action, input) {
    await loadSettings();
    ensureWritable();
    if ((await readLaunchStatus()).running)
      throw new Error("请先退出游戏，再切换版本实例或游戏目录。");
    const next = normalizeSettings(instances.change(settings, action, input));
    if (
      action === "create" &&
      !(await exists(path.join(next.gameDirectory, "hoi4.exe"), "file"))
    )
      throw new Error(
        "所选目录中没有 hoi4.exe，请选择钢铁雄心 IV 的安装目录。",
      );
    // Resolve before committing, so an unsafe managed directory cannot become active.
    await resolveSettingsUserData(next);
    const previousSettings = settings;
    const previousUserData = userData;
    try {
      settings = next;
      // Validate the complete candidate scan before committing the selection.
      // Broken metadata in an old installation must not trap the UI on it.
      const result = await state();
      await atomicWrite(settingsPath, JSON.stringify(next, null, 2));
      return result;
    } catch (error) {
      settings = previousSettings;
      userData = previousUserData;
      await thumbnails.replace([]);
      throw error;
    }
  }

  async function scanMods(warnings, { includeProjects = true } = {}) {
    const found = new Map();
    const references =
      settings.playsets.find((item) => item.id === settings.activePlaysetId)
        ?.modReferences || [];
    const modDirectory = path.join(userData, "mod");
    let descriptors = [];
    try {
      descriptors = await fs.readdir(modDirectory, { withFileTypes: true });
    } catch (error) {
      if (error.code !== "ENOENT")
        warnings.push("无法读取本地模组目录，请检查文件访问权限。");
    }
    for (const entry of descriptors
      .filter(
        (item) => item.isFile() && item.name.toLowerCase().endsWith(".mod"),
      )
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const descriptorPath = path.join(modDirectory, entry.name);
      try {
        const content = await fs.readFile(descriptorPath, "utf8");
        // Fixed project registrations are generated only as launch outputs;
        // their library identity is the parent project, not another mod.
        if (content.startsWith("# Managed by IRONCLAD project version.\n"))
          continue;
        const document = parseDocument(content.replace(/^\uFEFF/, ""));
        const rawPath = document.get("path") || document.get("archive");
        const contentPath =
          typeof rawPath === "string" && rawPath
            ? path.resolve(userData, rawPath)
            : "";
        const remote = document.get("remote_file_id");
        const pdxMatch = entry.name.match(/^pdx_(\d+)(?:_(\d+))?\.mod$/i);
        const pdxId = pdxMatch?.[1] || null;
        const workshopId =
          (typeof remote === "string" && /^\d+$/.test(remote)
            ? remote
            : null) ||
          forward(contentPath).match(
            /\/workshop\/content\/394360\/(\d+)(?:\/|$)/,
          )?.[1] ||
          entry.name.match(/(?:^ugc_|^ironclad_ugc_)(\d+)\.mod$/i)?.[1];
        const id = pdxId
          ? "pdx:" + pdxId
          : workshopId
            ? "workshop:" + workshopId
            : "local:" + entry.name.toLowerCase();
        const managedDescriptor =
          !pdxId &&
          !!workshopId &&
          content.replace(/^\uFEFF/, "").startsWith(MANAGED_MARKER);
        const liveDescriptorPath =
          managedDescriptor && contentPath
            ? path.join(contentPath, "descriptor.mod")
            : "";
        const liveDescriptorText = liveDescriptorPath
          ? await readOptional(liveDescriptorPath)
          : null;
        const metadata =
          managedDescriptor && liveDescriptorText !== null
            ? parseDocument(liveDescriptorText.replace(/^\uFEFF/, ""))
            : document;
        const available =
          !!contentPath &&
          (await exists(contentPath)) &&
          (!managedDescriptor || liveDescriptorText !== null);
        const mod = {
          id,
          name:
            typeof metadata.get("name") === "string"
              ? metadata.get("name")
              : entry.name.slice(0, -4),
          source: pdxId ? "pdx" : workshopId ? "workshop" : "local",
          managedPdx: Boolean(
            pdxId &&
              /^# Managed by IRONCLAD PDX installer: [a-f0-9-]{36}\r?\n/.test(
                content,
              ),
          ),
          descriptorPath: managedDescriptor
            ? liveDescriptorPath
            : descriptorPath,
          contentPath,
          supportedVersion:
            typeof metadata.get("supported_version") === "string"
              ? metadata.get("supported_version")
              : "",
          tags: Array.isArray(metadata.get("tags"))
            ? metadata
                .get("tags")
                .filter((tag) => !["{", "}", "="].includes(tag))
            : [],
          dependencies: Array.isArray(metadata.get("dependencies"))
            ? metadata
                .get("dependencies")
                .filter((value) => !["{", "}", "="].includes(value))
            : [],
          remoteId: pdxId || workshopId || null,
          installedRevision: pdxMatch?.[2] || null,
          version:
            typeof metadata.get("version") === "string"
              ? metadata.get("version")
              : "",
          picture:
            typeof metadata.get("picture") === "string"
              ? metadata.get("picture")
              : "",
          available,
          localDescriptor: managedDescriptor ? undefined : descriptorPath,
          workshopId,
          managedDescriptorPath: managedDescriptor ? descriptorPath : undefined,
          descriptorText: managedDescriptor ? liveDescriptorText : undefined,
        };
        const previous = found.get(id);
        const pinned = references.find((ref) => ref.id === id)?.version;
        const pdxPriority = (candidate) =>
          pinned
            ? Number(candidate.installedRevision === pinned)
            : candidate.managedPdx
              ? 2
              : Number(!candidate.installedRevision);
        if (
          !previous ||
          (!previous.available && available) ||
          (pdxId && available && pdxPriority(mod) > pdxPriority(previous)) ||
          (previous.managedDescriptorPath && !managedDescriptor && available)
        )
          found.set(id, mod);
      } catch {
        warnings.push("无法读取模组描述文件：" + entry.name);
      }
    }
    const roots = [...(await steamRoots())];
    if (settings.gameDirectory) {
      const steamappsIndex = forward(settings.gameDirectory)
        .toLowerCase()
        .lastIndexOf("/steamapps/common/");
      if (steamappsIndex >= 0)
        roots.push(settings.gameDirectory.slice(0, steamappsIndex));
    }
    for (const root of [...new Set(roots.map((item) => path.resolve(item)))]) {
      const workshopDirectory = path.join(
        root,
        "steamapps",
        "workshop",
        "content",
        "394360",
      );
      let items = [];
      try {
        items = await fs.readdir(workshopDirectory, { withFileTypes: true });
      } catch (error) {
        if (error.code !== "ENOENT")
          warnings.push("无法读取 Steam 创意工坊目录。");
      }
      for (const item of items.filter(
        (entry) => entry.isDirectory() && /^\d+$/.test(entry.name),
      )) {
        const id = "workshop:" + item.name;
        if (found.get(id)?.available && !found.get(id).managedDescriptorPath)
          continue;
        const contentPath = path.join(workshopDirectory, item.name);
        const descriptorPath = path.join(contentPath, "descriptor.mod");
        try {
          const text = await readOptional(descriptorPath);
          if (text === null) continue;
          const document = parseDocument(text.replace(/^\uFEFF/, ""));
          found.set(id, {
            id,
            name:
              typeof document.get("name") === "string"
                ? document.get("name")
                : "Workshop " + item.name,
            source: "workshop",
            descriptorPath,
            contentPath,
            supportedVersion:
              typeof document.get("supported_version") === "string"
                ? document.get("supported_version")
                : "",
            tags: Array.isArray(document.get("tags"))
              ? document
                  .get("tags")
                  .filter((tag) => !["{", "}", "="].includes(tag))
              : [],
            dependencies: Array.isArray(document.get("dependencies"))
              ? document
                  .get("dependencies")
                  .filter((value) => !["{", "}", "="].includes(value))
              : [],
            remoteId: item.name,
            version:
              typeof document.get("version") === "string"
                ? document.get("version")
                : "",
            picture:
              typeof document.get("picture") === "string"
                ? document.get("picture")
                : "",
            available: true,
            workshopId: item.name,
            descriptorText: text,
            managedDescriptorPath: found.get(id)?.managedDescriptorPath,
          });
        } catch {
          warnings.push("无法读取创意工坊模组：" + item.name);
        }
      }
    }
    if (includeProjects && options.getModProjects) {
      const projects = await options.getModProjects();
      for (const project of projects) {
        if (canonical(project.userData) !== canonical(userData)) continue;
        const existing = [...found.values()].find(
          (mod) =>
            canonical(mod.localDescriptor || mod.descriptorPath) ===
            canonical(project.descriptorPath),
        );
        if (!existing) continue;
        found.delete(existing.id);
        const mod = {
          ...existing,
          id: project.modId,
          name: project.name,
          source: "local",
          remoteId: null,
          workshopId: undefined,
          projectId: project.id,
          projectSourceId:
            project.originModId ||
            project.originRef?.modId ||
            project.upstreamRef?.modId ||
            null,
          projectSnapshots: project.snapshots,
          projectVersion: null,
          available:
            existing.available &&
            canonical(existing.contentPath) === canonical(project.workPath),
        };
        const version = references.find(
          (ref) => ref.id === project.modId,
        )?.version;
        if (options.resolveProjectVersion) {
          try {
            const snapshot = await options.resolveProjectVersion(
              project.id,
              version || null,
            );
            mod.contentPath = snapshot.contentPath;
            mod.projectVersion = snapshot.snapshotId;
            mod.projectDescriptorText = snapshot.descriptorText;
            mod.projectVersionName = snapshot.name;
            const metadata = parseDocument(
              snapshot.descriptorText.replace(/^\uFEFF/, ""),
            );
            mod.supportedVersion = metadata.get("supported_version") || "";
            mod.dependencies = Array.isArray(metadata.get("dependencies"))
              ? metadata.get("dependencies")
              : [];
            mod.version = metadata.get("version") || "";
            mod.available = true;
          } catch (error) {
            mod.available = false;
            mod.projectError = error.message;
          }
        } else if (version) {
          mod.available = false;
          mod.projectError = "无法核实项目固定版本。";
        }
        found.set(mod.id, mod);
      }
    }
    return [...found.values()].sort((a, b) =>
      a.name.localeCompare(b.name, "zh-CN"),
    );
  }

  async function state({ includeProjects = true } = {}) {
    await loadSettings();
    const warnings = settingsProblem ? [settingsProblem] : [];
    const executable = settings.gameDirectory
      ? path.join(settings.gameDirectory, "hoi4.exe")
      : "";
    const found =
      !!executable && (await exists(executable, "file").catch(() => false));
    if (settings.gameDirectory && !found)
      warnings.push("游戏目录中的 hoi4.exe 不存在，请重新选择安装目录。");
    let launchBlockedReason = settingsProblem || "";
    let userDirectoryResolved = true;
    try {
      await resolveUserData();
    } catch (error) {
      userDirectoryResolved = false;
      // Never scan the previous instance if the new directory cannot be resolved.
      userData =
        settings.activeGameInstanceId === "default"
          ? path.join(
              options.documentsPath,
              "Paradox Interactive",
              "Hearts of Iron IV",
            )
          : path.join(
              path.dirname(settingsPath),
              "game-instances",
              settings.activeGameInstanceId,
              "user-data",
            );
      launchBlockedReason = error.message;
      warnings.push(error.message);
    }
    const metadata = found
      ? await gameSupport.readGameMetadata(settings.gameDirectory)
      : { version: null, displayVersion: null };
    const version = metadata.version;
    const mods = (
      userDirectoryResolved ? await scanMods(warnings, { includeProjects }) : []
    ).map(
      ({
        localDescriptor,
        workshopId,
        descriptorText,
        managedDescriptorPath,
        projectDescriptorText,
        ...mod
      }) => mod,
    );
    if (includeProjects) {
      const pictures = await thumbnails.replace(mods);
      for (const mod of mods) mod.picture = pictures.get(mod.id) || mod.picture;
    }
    const activePlayset = settings.playsets.find(
      (item) => item.id === settings.activePlaysetId,
    );
    if (activePlayset.unmappedDlcIds.length) {
      launchBlockedReason = `当前预设有 ${activePlayset.unmappedDlcIds.length} 个 DLC 无法匹配，请在 DLC 页面处理后启动。`;
      warnings.push(launchBlockedReason);
    }
    const mismatchedPins = activePlayset.modReferences.filter(
      (ref) =>
        ref.source === "pdx" &&
        ref.version &&
        activePlayset.modIds.includes(ref.id) &&
        mods.some(
          (mod) =>
            mod.id === ref.id &&
            mod.available &&
            mod.installedRevision !== ref.version,
        ),
    );
    if (mismatchedPins.length) {
      launchBlockedReason =
        "当前预设要求的 Paradox 模组版本未安装或无法核实：" +
        mismatchedPins.map((ref) => `${ref.name} (${ref.version})`).join("、");
      warnings.push(launchBlockedReason);
    }
    const selected = activePlayset.modIds;
    const duplicateProject = mods.find(
      (mod) =>
        selected.includes(mod.id) &&
        mod.projectSourceId &&
        selected.includes(mod.projectSourceId),
    );
    if (duplicateProject) {
      launchBlockedReason =
        "完整二改项目与其原版不能同时启用，请在播放集中选择其中一个。";
      warnings.push(launchBlockedReason);
    }
    const available = new Set(
      mods.filter((mod) => mod.available).map((mod) => mod.id),
    );
    const missing = selected.filter((id) => !available.has(id));
    if (missing.length)
      warnings.push(
        "当前预设有 " +
          missing.length +
          " 个模组不可用，请移除或重新安装后启动。",
      );
    for (const mod of mods) {
      const localRoot = canonical(path.join(userData, "mod")) + path.sep;
      mod.canEdit = Boolean(
        !mod.projectId &&
          mod.source !== "pdx" &&
          mod.available &&
          canonical(mod.contentPath).startsWith(localRoot) &&
          canonical(path.dirname(mod.descriptorPath)) ===
            canonical(path.join(userData, "mod")),
      );
      const supportedParts = mod.supportedVersion?.split(".");
      const installedParts = version?.split(".");
      mod.compatibility =
        !supportedParts?.length || !installedParts?.length
          ? "unknown"
          : supportedParts.every(
                (part, index) =>
                  part === "*" ||
                  part.toLowerCase() === "x" ||
                  part === installedParts[index],
              )
            ? "compatible"
            : "different";
      // Descriptor dependencies also express load order and optional compatibility.
      // Names alone cannot establish required items. Keep this legacy field empty
      // until prerequisites can be verified from a separate authoritative source.
      mod.missingDependencies = [];
    }
    // Keep descriptor metadata unchanged; aliases only affect presentation.
    for (const mod of mods) {
      mod.originalName = mod.name;
      const display = settings.modDisplayNames[mod.id];
      mod.displayNameKind = display?.kind || null;
      if (display) mod.name = display.name;
      mod.canDeleteLocal =
        userDirectoryResolved &&
        (await modRemoval.canRemoveLocalMod({ userData, mod, mods }));
      mod.canDelete =
        !mod.projectId &&
        (mod.source === "workshop" ||
          (mod.source === "pdx" && mod.managedPdx) ||
          mod.canDeleteLocal);
    }
    const dlc = userDirectoryResolved
      ? await gameSupport.readDlc(settings.gameDirectory, userData)
      : { items: [], disabledIds: [], warnings: [] };
    const disabledIds =
      activePlayset.disabledDlcIds ??
      settings.disabledDlcIds ??
      dlc.disabledIds;
    const disabled = new Set(disabledIds.map(dlcKey));
    dlc.items = dlc.items.map((item) => ({
      ...item,
      enabled: item.installed && !disabled.has(dlcKey(item.id)),
    }));
    dlc.disabledIds = disabledIds;
    warnings.push(...dlc.warnings);
    const gameOptions = userDirectoryResolved
      ? await gameSupport.readGameOptions(settings.gameDirectory, userData)
      : { layout: [], values: {}, warnings: [] };
    warnings.push(...gameOptions.warnings);
    gameOptions.persistedValues = { ...gameOptions.values };
    gameOptions.values = { ...gameOptions.values, ...settings.gameOptions };
    gameOptions.pending = { ...settings.gameOptions };
    const continueGame = userDirectoryResolved
      ? await gameSupport.readContinueGame(userData)
      : { available: false, reason: launchBlockedReason };
    return {
      settings: clone(settings),
      game: {
        found,
        directory: settings.gameDirectory,
        executable,
        version,
        displayVersion: metadata.displayVersion,
      },
      mods,
      dlc,
      gameOptions,
      continueGame,
      launchStatus: await readLaunchStatus(),
      launchBlockedReason,
      paths: { userData, settings: settingsPath },
      warnings,
    };
  }

  async function launch(request = {}) {
    await loadSettings();
    ensureWritable();
    if (
      !isObject(request) ||
      Object.keys(request).some(
        (key) => !["resume", "saveFilename"].includes(key),
      ) ||
      (request.resume !== undefined && typeof request.resume !== "boolean") ||
      (request.saveFilename !== undefined &&
        (!request.resume || typeof request.saveFilename !== "string"))
    )
      throw new Error("启动请求无效。");
    if ((await readLaunchStatus()).running)
      throw new Error("游戏仍在运行，请退出后再开始新的战役。");
    const executable = path.join(settings.gameDirectory, "hoi4.exe");
    if (!settings.gameDirectory || !(await exists(executable, "file")))
      throw new Error("尚未找到游戏，请先选择包含 hoi4.exe 的安装目录。");
    await resolveUserData();
    const metadata = await gameSupport.readGameMetadata(settings.gameDirectory);
    const args = [
      ...(settings.launchMode === "debug"
        ? metadata.debugArgs
        : metadata.normalArgs),
    ];
    if (
      settings.gameInstances.find(
        (item) => item.id === settings.activeGameInstanceId,
      ).isolated
    ) {
      if (args.some((arg) => /^-{1,2}userdir(?:=|$)/i.test(arg)))
        throw new Error(
          "此游戏的启动参数已指定用户目录，无法安全启用版本隔离。",
        );
      args.push("-userdir=" + forward(userData));
    }
    if (request.resume) args.push("--continuelastsave");
    if (request.saveFilename !== undefined) {
      const filename = require("./campaigns.cjs").campaignSaveName(
        request.saveFilename,
      );
      const target = path.resolve(userData, "save games", filename);
      const safe = require("./managed-data.cjs");
      if (!safe.inside(path.join(userData, "save games"), target))
        throw new Error("存档路径超出当前版本目录。");
      await safe.file(target, 4 * 1024 ** 3);
      await safe.read(
        path.join(userData, "continue_game.json"),
        64 * 1024,
        true,
      );
    } else if (request.resume) {
      const continuation = await gameSupport.readContinueGame(userData);
      if (!continuation.available)
        throw new Error(continuation.reason || "没有可继续的存档。");
    }
    const optionPlan = Object.keys(settings.gameOptions).length
      ? await gameSupport.planGameOptions(
          settings.gameDirectory,
          userData,
          settings.gameOptions,
        )
      : { writes: [] };
    const mods = await scanMods([]);
    const available = new Map(mods.map((mod) => [mod.id, mod]));
    const playset = settings.playsets.find(
      (item) => item.id === settings.activePlaysetId,
    );
    if (playset.unmappedDlcIds.length)
      throw new Error(
        "当前预设含无法匹配的 DLC，请先在 DLC 页面处理这些引用。",
      );
    const selected = playset.modIds.map((id) => available.get(id));
    if (selected.some((mod) => !mod?.available))
      throw new Error(
        "当前预设中有模组已移动或未安装，请刷新并移除不可用模组后重试。",
      );
    if (
      selected.some(
        (mod) =>
          mod.projectSourceId && playset.modIds.includes(mod.projectSourceId),
      )
    )
      throw new Error(
        "完整二改项目与其原版不能同时启用，请在播放集中选择其中一个。",
      );
    for (const ref of playset.modReferences) {
      if (
        ref.source === "pdx" &&
        ref.version &&
        playset.modIds.includes(ref.id) &&
        available.get(ref.id)?.installedRevision !== ref.version
      )
        throw new Error(
          `模组「${ref.name}」要求的 Paradox 版本 ${ref.version} 未安装或无法核实，请先安装该版本。`,
        );
    }
    const loadPath = path.join(userData, "dlc_load.json");
    const previous = await readOptional(loadPath);
    let load = { disabled_dlcs: [], enabled_mods: [] };
    if (previous !== null) {
      try {
        load = JSON.parse(previous.replace(/^\uFEFF/, ""));
        if (!isObject(load)) throw new Error();
      } catch {
        throw new Error(
          "dlc_load.json 格式无效。为保护现有设置，未做修改；请先修复或备份该文件。",
        );
      }
    }
    // Capture effective launch settings before writes. Statistics metadata must
    // never delay launch with a full content hash or make a valid launch fail.
    let performanceEnvironment = null;
    try {
      const dlc = await gameSupport.readDlc(settings.gameDirectory, userData);
      const disabled = new Set(
        (
          playset.disabledDlcIds ??
          settings.disabledDlcIds ??
          dlc.disabledIds
        ).map(dlcKey),
      );
      const optionValues =
        optionPlan.values ??
        (await gameSupport.readGameOptions(settings.gameDirectory, userData))
          .values;
      performanceEnvironment = captureEnvironment({
        settings: clone(settings),
        game: {
          version: metadata.version || null,
          directory: settings.gameDirectory,
        },
        paths: { userData },
        mods,
        dlc: {
          ...dlc,
          items: dlc.items.map((item) => ({
            ...item,
            enabled: item.installed && !disabled.has(dlcKey(item.id)),
          })),
        },
        gameOptions: { values: optionValues },
      });
    } catch {
      // The detail view marks absent context as unknown; the collector can still run.
    }
    const changedFiles = [];
    async function writeWithBackup(target, content) {
      const original = await readOptional(target);
      if (original === content) return;
      if (original !== null) {
        const backup =
          target +
          ".ironclad-backup-" +
          new Date().toISOString().replace(/[:.]/g, "-") +
          "-" +
          randomUUID().slice(0, 8);
        await fs.writeFile(backup, original, { flag: "wx" });
      }
      await atomicWrite(target, content);
      changedFiles.push({ target, previous: original });
    }
    try {
      if (request.saveFilename !== undefined) {
        await writeWithBackup(
          path.join(userData, "continue_game.json"),
          JSON.stringify(
            {
              filename: request.saveFilename,
              title: path.basename(request.saveFilename, ".hoi4"),
              is_remote: false,
            },
            null,
            2,
          ) + "\n",
        );
      }
      const enabledMods = [];
      for (const mod of selected) {
        let descriptor = mod.localDescriptor;
        if (mod.projectId && mod.projectDescriptorText !== undefined) {
          descriptor = path.join(
            userData,
            "mod",
            "ironclad_project_" + mod.projectId + "_pin.mod",
          );
          const original = await readOptional(descriptor);
          const marker = "# Managed by IRONCLAD project version.\n";
          if (original !== null && !original.startsWith(marker))
            throw new Error(
              "项目固定版本的注册文件被外部修改，请保留文件并重新检查。",
            );
          const source = mod.projectDescriptorText.replace(/^\uFEFF/, "");
          let content = source;
          for (const field of parseDocument(source)
            .assignments.filter((item) =>
              ["path", "archive", "remote_file_id", "pops_id"].includes(
                item.key,
              ),
            )
            .reverse())
            content = content.slice(0, field.start) + content.slice(field.end);
          await writeWithBackup(
            descriptor,
            marker +
              content.trim() +
              "\npath=" +
              quoted(mod.contentPath) +
              "\n",
          );
        }
        if (!descriptor) {
          descriptor =
            mod.managedDescriptorPath ||
            path.join(
              userData,
              "mod",
              "ironclad_ugc_" + mod.workshopId + ".mod",
            );
          let original = await readOptional(descriptor);
          if (original !== null && !original.startsWith(MANAGED_MARKER)) {
            descriptor = path.join(
              userData,
              "mod",
              "ironclad_ugc_" + mod.workshopId + "_" + randomUUID() + ".mod",
            );
            original = null;
          }
          const source = mod.descriptorText.replace(/^\uFEFF/, "");
          let content = source;
          for (const assignment of parseDocument(source)
            .assignments.filter((item) =>
              ["path", "archive", "remote_file_id"].includes(item.key),
            )
            .reverse()) {
            content =
              content.slice(0, assignment.start) +
              content.slice(assignment.end);
          }
          content =
            MANAGED_MARKER +
            content.trim() +
            "\npath=" +
            quoted(mod.contentPath) +
            "\nremote_file_id=" +
            quoted(mod.workshopId) +
            "\n";
          await writeWithBackup(descriptor, content);
        }
        enabledMods.push(forward(path.relative(userData, descriptor)));
      }
      for (const write of optionPlan.writes) {
        if (
          canonical(path.dirname(write.path)) !== canonical(userData) ||
          !["pdx_settings.txt", "pdx_settings.json", "settings.txt"].includes(
            path.basename(write.path),
          )
        )
          throw new Error("游戏设置写入路径不受支持。");
        await writeWithBackup(write.path, write.content);
      }
      const disabledDlcIds = playset.disabledDlcIds ?? settings.disabledDlcIds;
      await writeWithBackup(
        loadPath,
        JSON.stringify(
          {
            ...load,
            ...(disabledDlcIds === null
              ? {}
              : { disabled_dlcs: disabledDlcIds }),
            enabled_mods: enabledMods,
          },
          null,
          2,
        ),
      );
      const child = spawnProcess(executable, args, {
        cwd: settings.gameDirectory,
        detached: true,
        stdio: "ignore",
        windowsHide: false,
      });
      child.once("exit", (code) => {
        launchStatus = {
          ...launchStatus,
          running: false,
          lastExitCode: code ?? null,
        };
      });
      await new Promise((resolve, reject) => {
        child.once("spawn", () => {
          launchStatus = {
            running: true,
            pid: child.pid,
            startedAt: new Date().toISOString(),
            lastExitCode: null,
          };
          resolve();
        });
        child.once("error", reject);
      });
      child.unref();
      return {
        pid: child.pid,
        launchedAt: new Date().toISOString(),
        executable,
        closeOnLaunch: settings.launcherPreferences.closeOnLaunch,
        performanceContext: {
          ...(performanceEnvironment
            ? { environment: performanceEnvironment }
            : {}),
          gameVersion: metadata.version || "",
          instanceId: settings.activeGameInstanceId,
          instanceName:
            settings.gameInstances.find(
              (item) => item.id === settings.activeGameInstanceId,
            )?.name || "",
          playsetId: playset.id,
          playsetName: playset.name,
          modCount: playset.modIds.length,
          launchMode: settings.launchMode,
        },
      };
    } catch (error) {
      let restoreFailed = false;
      for (const entry of changedFiles.reverse()) {
        try {
          if (entry.previous === null) await fs.unlink(entry.target);
          else await atomicWrite(entry.target, entry.previous);
        } catch {
          restoreFailed = true;
        }
      }
      if (restoreFailed)
        throw new Error(
          "启动失败，且无法完整恢复配置。请检查游戏文档目录中的 dlc_load.json.ironclad-backup-* 备份。",
        );
      const detail = ["EACCES", "EPERM"].includes(error.code)
        ? "请检查文件访问权限。"
        : "请确认游戏安装完整、Steam 已运行，且游戏文件未被占用。";
      throw new Error("未能启动游戏，已恢复原有模组配置和游戏设置。" + detail);
    }
  }

  async function officialPlaysets() {
    await loadSettings();
    await resolveUserData();
    const mods = await scanMods([]);
    const dlc = await gameSupport.readDlc(settings.gameDirectory, userData);
    return playsetTransfer.readOfficialPlaysets({
      userData,
      mods,
      dlc: dlc.items,
    });
  }

  async function importOfficial(ids) {
    if (
      !Array.isArray(ids) ||
      !ids.length ||
      ids.length > 100 ||
      ids.some((id) => typeof id !== "string")
    )
      throw new Error("请选择要导入的官方预设。");
    const source = await officialPlaysets();
    const wanted = new Set(ids);
    const selected = source.playsets.filter((item) =>
      wanted.has(item.sourceId),
    );
    if (selected.length !== wanted.size)
      throw new Error("官方预设已发生变化，请刷新列表后重试。");
    const imported = selected.map((item) => ({
      ...item,
      id: "playset-" + randomUUID(),
      origin: "paradox:" + item.sourceId,
    }));
    const active = imported.find((item) => item.isActive) || imported[0];
    await save({
      playsets: [...settings.playsets, ...imported],
      activePlaysetId: active.id,
    });
    return {
      state: await state(),
      importedCount: imported.length,
      warnings: source.warnings,
    };
  }

  async function importDocument(text) {
    await loadSettings();
    await resolveUserData();
    const mods = await scanMods([]);
    const parsed = playsetTransfer.parsePlaysetDocument(text, { mods });
    const playset = {
      ...parsed,
      id: "playset-" + randomUUID(),
      origin: "file",
    };
    await save({
      playsets: [...settings.playsets, playset],
      activePlaysetId: playset.id,
    });
    return state();
  }

  async function exportDocument(id) {
    await loadSettings();
    await resolveUserData();
    const playset = settings.playsets.find((item) => item.id === id);
    if (!playset) throw new Error("找不到要导出的预设。");
    return playsetTransfer.serializePlayset({
      playset,
      mods: await scanMods([]),
    });
  }

  return {
    getState: () => serialized(state),
    // Main-process source adapter only. Avoid project-store reentrancy while
    // capturing a source or checking the selected game directory.
    getSourceState: () => state({ includeProjects: false }),
    getModThumbnail: (modId) => thumbnails.get(modId),
    detectGame: () =>
      serialized(async () => {
        await loadSettings();
        steamRootsPromise = undefined;
        const found = await findGame();
        if (found) await save({ gameDirectory: found });
        const result = await state();
        if (!found)
          result.warnings.push("未在 Steam 库中找到游戏，请手动选择安装目录。");
        return result;
      }),
    saveSettings: (patch) => serialized(() => save(patch)),
    createGameInstance: (input) =>
      serialized(() => changeInstance("create", input)),
    switchGameInstance: (id) => serialized(() => changeInstance("switch", id)),
    renameGameInstance: (input) =>
      serialized(() => changeInstance("rename", input)),
    removeGameInstance: (id) => serialized(() => changeInstance("remove", id)),
    setModDisplayName: (input) =>
      serialized(async () => {
        await loadSettings();
        ensureWritable();
        if (
          !isObject(input) ||
          Object.keys(input).some(
            (key) => !["modId", "name", "kind"].includes(key),
          )
        )
          throw new Error("模组显示名称配置无效。");
        await resolveUserData();
        if (!(await scanMods([])).some((mod) => mod.id === input.modId))
          throw new Error("未找到此模组，请刷新后重试。");
        await save({
          modDisplayNames: {
            ...settings.modDisplayNames,
            [input.modId]: { name: input.name, kind: input.kind },
          },
        });
        return state();
      }),
    resetModDisplayName: (id) =>
      serialized(async () => {
        await loadSettings();
        ensureWritable();
        if (typeof id !== "string" || !id || id.length > 4096)
          throw new Error("模组标识无效。");
        const next = { ...settings.modDisplayNames };
        delete next[id];
        await save({ modDisplayNames: next });
        return state();
      }),
    forgetMod: (id, expectedUserData) =>
      serialized(async () => {
        await loadSettings();
        await resolveUserData();
        if (canonical(userData) !== canonical(expectedUserData))
          throw new Error("版本实例已变化，请刷新模组列表。");
        await save({
          playsets: settings.playsets.map((playset) => ({
            ...playset,
            modIds: playset.modIds.filter((key) => key !== id),
            modOrder: playset.modOrder.filter((key) => key !== id),
            modReferences: playset.modReferences.filter((ref) => ref.id !== id),
          })),
        });
        return state();
      }),
    removeLocalMod: (id) =>
      serialized(async () => {
        await loadSettings();
        ensureWritable();
        await resolveUserData();
        if ((await readLaunchStatus()).running)
          throw new Error("请先退出游戏，再删除模组。");
        const mods = await scanMods([]);
        const mod = mods.find((item) => item.id === id);
        if (!mod) throw new Error("未找到此模组，请刷新后重试。");
        const next = normalizeSettings({
          ...settings,
          playsets: settings.playsets.map((playset) => ({
            ...playset,
            modIds: playset.modIds.filter((key) => key !== id),
            modOrder: playset.modOrder.filter((key) => key !== id),
            modReferences: playset.modReferences.filter((ref) => ref.id !== id),
          })),
        });
        const removed = await modRemoval.removeLocalMod({
          userData,
          mod,
          mods,
          commit: async () => {
            await atomicWrite(settingsPath, JSON.stringify(next, null, 2));
            settings = next;
          },
        });
        return { ...removed, state: await state() };
      }),
    launchGame: (request) => serialized(() => launch(request)),
    getLaunchStatus: readLaunchStatus,
    getOfficialPlaysets: () => serialized(officialPlaysets),
    importOfficialPlaysets: (ids) => serialized(() => importOfficial(ids)),
    importPlayset: (text) => serialized(() => importDocument(text)),
    exportPlayset: (id) => serialized(() => exportDocument(id)),
    getCachePlan: () =>
      serialized(async () => {
        await loadSettings();
        await resolveUserData();
        return maintenance.getCachePlan({
          gameDirectory: settings.gameDirectory,
          userData,
        });
      }),
    listCacheBackups: () =>
      serialized(async () => {
        await loadSettings();
        await resolveUserData();
        return maintenance.listCacheBackups({ userData });
      }),
    clearCache: (targetIds) =>
      serialized(async () => {
        await loadSettings();
        ensureWritable();
        await resolveUserData();
        if ((await readLaunchStatus()).running)
          throw new Error("请先退出游戏，再清理缓存。");
        return maintenance.backupAndClearCache({
          gameDirectory: settings.gameDirectory,
          userData,
          targetIds,
        });
      }),
    restoreCacheBackup: (id) =>
      serialized(async () => {
        await loadSettings();
        ensureWritable();
        await resolveUserData();
        if ((await readLaunchStatus()).running)
          throw new Error("请先退出游戏，再恢复缓存备份。");
        return maintenance.restoreCacheBackup({ userData, id });
      }),
    createLocalMod: (input) =>
      serialized(async () => {
        await loadSettings();
        ensureWritable();
        await resolveUserData();
        if ((await readLaunchStatus()).running)
          throw new Error("请先退出游戏，再创建本地模组。");
        const result = await modAuthoring.createLocalMod({ userData, input });
        return { mod: result, state: await state() };
      }),
    getLocalModMetadata: (id) =>
      serialized(async () => {
        await loadSettings();
        await resolveUserData();
        const mod = (await scanMods([])).find((item) => item.id === id);
        if (!mod) throw new Error("未找到此本地模组，请刷新后重试。");
        if (mod.projectId)
          throw new Error("本地项目的资料由项目管理，请在工作区编辑内容。");
        if (mod.source === "pdx")
          throw new Error(
            "已安装的 Paradox 模组由内容提供方管理，无法在此编辑。",
          );
        return modAuthoring.readLocalModMetadata({
          userData,
          descriptorPath: mod.localDescriptor || mod.descriptorPath,
        });
      }),
    updateLocalModMetadata: (id, input) =>
      serialized(async () => {
        await loadSettings();
        ensureWritable();
        await resolveUserData();
        if ((await readLaunchStatus()).running)
          throw new Error("请先退出游戏，再编辑本地模组资料。");
        const mod = (await scanMods([])).find((item) => item.id === id);
        if (!mod) throw new Error("未找到此本地模组，请刷新后重试。");
        if (mod.projectId)
          throw new Error("本地项目的资料由项目管理，请在工作区编辑内容。");
        if (mod.source === "pdx")
          throw new Error(
            "已安装的 Paradox 模组由内容提供方管理，无法在此编辑。",
          );
        const result = await modAuthoring.updateLocalModMetadata({
          userData,
          descriptorPath: mod.localDescriptor || mod.descriptorPath,
          input,
        });
        return { mod: result, state: await state() };
      }),
  };
}

module.exports = { createLauncherService };
