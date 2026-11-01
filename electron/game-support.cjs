"use strict";
const {
  diagnosticError,
  errorDiagnostic,
} = require("./diagnostic-message.cjs");

const fs = require("node:fs/promises");
const path = require("node:path");

const MAX_CONFIG_BYTES = 4 * 1024 * 1024;
const clone = (value) => JSON.parse(JSON.stringify(value));
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const forward = (value) => value.replace(/\\/g, "/");
const cleanString = (value, max = 4096) =>
  typeof value === "string" && value.length <= max && !/[\0-\x1f]/.test(value);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

// These defaults match the installed HOI4 layout, and remain usable before discovery.
const FALLBACK_LAYOUT = [
  {
    category: "Graphics",
    label: "Graphics",
    labelId: "ingameSettings.graphics",
    settings: [
      {
        name: "display_mode",
        type: "radio",
        label: "Display mode",
        default: "borderless_fullscreen",
        provider: "sdl",
        providerArgs: "displayMode",
        options: [
          { label: "Fullscreen", value: "fullscreen" },
          { label: "Borderless fullscreen", value: "borderless_fullscreen" },
          { label: "Windowed", value: "windowed" },
        ],
      },
      {
        name: "display_index",
        type: "select",
        label: "Display monitor",
        provider: "sdl",
        providerArgs: "displayIndex",
      },
      {
        name: "vsync",
        type: "toggle",
        label: "VSync",
        default: true,
        provider: "sdl",
        providerArgs: "vsync",
      },
      {
        name: "fullscreen_resolution",
        type: "select",
        label: "Fullscreen resolution",
        provider: "sdl",
        providerArgs: "fullscreenResolution",
      },
      {
        name: "windowed_resolution",
        type: "select",
        label: "Windowed resolution",
        provider: "sdl",
        providerArgs: "windowedResolution",
      },
      {
        name: "refreshRate",
        type: "select",
        label: "Refresh rate",
        provider: "sdl",
        providerArgs: "refreshRate",
      },
      {
        name: "renderer",
        type: "radio",
        label: "Renderer",
        default: "dx11",
        options: [
          { label: "DirectX 11", value: "dx11" },
          { label: "DirectX 9 (legacy)", value: "dx9_compat" },
          { label: "OpenGL", value: "opengl" },
        ],
      },
    ],
  },
  {
    category: "System",
    label: "System",
    labelId: "ingameSettings.system",
    settings: [
      {
        name: "language",
        type: "select",
        label: "Language",
        default: "l_english",
        provider: "lang",
        options: [
          ["English", "l_english"],
          ["Português do Brasil", "l_braz_por"],
          ["Deutsch", "l_german"],
          ["Français", "l_french"],
          ["Español", "l_spanish"],
          ["Polski", "l_polish"],
          ["Русский", "l_russian"],
          ["日本語", "l_japanese"],
          ["中文", "l_simp_chinese"],
          ["한국어", "l_korean"],
        ].map(([label, value]) => ({ label, value })),
      },
    ],
  },
];

async function readOptional(filename) {
  try {
    const stat = await fs.stat(filename);
    if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES)
      throw new Error("配置文件不是普通文件或超过 4 MB：" + filename);
    return await fs.readFile(filename, "utf8");
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(error.code)) return null;
    throw error;
  }
}

async function isFile(filename) {
  try {
    return (await fs.stat(filename)).isFile();
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(error.code)) return false;
    throw error;
  }
}

function within(root, filename) {
  if (!cleanString(filename) || !filename)
    throw new Error("配置中包含无效文件路径。");
  const target = path.resolve(root, filename);
  const relative = path.relative(path.resolve(root), target);
  if (
    relative === ".." ||
    relative.startsWith(".." + path.sep) ||
    path.isAbsolute(relative)
  )
    throw new Error("配置文件路径超出了游戏或用户目录。");
  return target;
}

function json(text, filename) {
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    throw diagnosticError("无法解析配置文件，请先修复或恢复备份：{0}", [
      filename,
    ]);
  }
}

async function rawMetadata(gameDirectory) {
  if (!gameDirectory) return {};
  const filename = path.join(gameDirectory, "launcher-settings.json");
  const content = await readOptional(filename);
  if (content === null) return {};
  const parsed = json(content, filename);
  if (!object(parsed)) throw new Error("游戏启动元数据格式无效。");
  return parsed;
}

function validatedArgs(args) {
  if (
    !Array.isArray(args) ||
    args.length > 64 ||
    args.some((arg) => !cleanString(arg, 2048))
  )
    throw new Error("游戏定义的启动参数无效。");
  return [...args];
}

async function readGameMetadata(gameDirectory) {
  const metadata = await rawMetadata(gameDirectory);
  const normalArgs =
    metadata.exeArgs === undefined ? [] : validatedArgs(metadata.exeArgs);
  const expected = path.resolve(gameDirectory || ".", "hoi4.exe").toLowerCase();
  if (
    metadata.exePath &&
    (!cleanString(metadata.exePath) ||
      path.resolve(gameDirectory, metadata.exePath).toLowerCase() !== expected)
  )
    throw new Error("游戏启动元数据指向了非 hoi4.exe 文件。");
  const debug =
    Array.isArray(metadata.alternativeExecutables) &&
    metadata.alternativeExecutables.find(
      (item) =>
        object(item) &&
        cleanString(item.exePath) &&
        path.resolve(gameDirectory, item.exePath).toLowerCase() === expected &&
        Array.isArray(item.exeArgs) &&
        item.exeArgs.some((arg) => /^-{1,2}debug(?:_mode)?$/.test(arg)),
    );
  return {
    version: cleanString(metadata.rawVersion, 200) ? metadata.rawVersion : null,
    displayVersion: cleanString(metadata.version, 300)
      ? metadata.version
      : null,
    normalArgs,
    debugArgs: debug ? validatedArgs(debug.exeArgs) : [...normalArgs, "-debug"],
  };
}

async function resolveUserDirectory(gameDirectory, documentsPath) {
  if (!cleanString(documentsPath) || !path.isAbsolute(documentsPath))
    throw new Error("无法确定 Windows 文档目录。");
  const fallback = path.join(
    documentsPath,
    "Paradox Interactive",
    "Hearts of Iron IV",
  );
  if (!gameDirectory) return fallback;
  const text = await readOptional(path.join(gameDirectory, "userdir.txt"));
  if (text === null || !text.replace(/^\uFEFF/, "").trim()) return fallback;
  let selected = text.replace(/^\uFEFF/, "").trim();
  if (selected.startsWith('"') && selected.endsWith('"'))
    selected = selected.slice(1, -1);
  if (
    !cleanString(selected) ||
    !selected ||
    /[<>"|?*]/.test(selected) ||
    /^[A-Za-z]:[^\\/]/.test(selected) ||
    /^[A-Za-z]:$/.test(selected)
  )
    throw new Error(
      "userdir.txt 中的用户目录无效，请填写单行绝对路径或相对游戏目录的路径。",
    );
  return path.resolve(gameDirectory, selected);
}

// A span-preserving parser for the assignments used by PDS settings and DLC files.
// Keeping exact scalar spans lets updates retain comments and unknown settings.
function parsePds(text) {
  const tokens = [];
  const expression =
    /\s+|#[^\r\n]*|\/\/[^\r\n]*|"(?:\\.|[^"\\])*"|[{}=]|[^\s{}="#]+/g;
  let end = 0;
  for (const match of text.matchAll(expression)) {
    if (match.index !== end)
      throw diagnosticError("PDS 配置包含无法识别的字符。");
    end = match.index + match[0].length;
    if (/^\s|^#|^\/\//.test(match[0])) continue;
    tokens.push({ raw: match[0], start: match.index, end });
  }
  if (end !== text.length) throw diagnosticError("PDS 配置包含未闭合字符串。");
  let index = 0;
  function atom(raw) {
    if (raw.startsWith('"'))
      return raw.slice(1, -1).replace(/\\(["\\])/g, "$1");
    if (raw === "yes") return true;
    if (raw === "no") return false;
    return raw;
  }
  function parseEntries(nested = false) {
    const entries = [];
    while (index < tokens.length) {
      if (tokens[index].raw === "}") {
        if (!nested) throw diagnosticError("PDS 配置括号不匹配。");
        return { entries, close: tokens[index++] };
      }
      const keyToken = tokens[index++];
      if (["{", "="].includes(keyToken.raw))
        throw diagnosticError("PDS 配置字段无效。");
      if (tokens[index]?.raw !== "=") {
        if (nested) {
          entries.push({
            key: null,
            value: atom(keyToken.raw),
            start: keyToken.start,
            end: keyToken.end,
            kind: "scalar",
          });
          continue;
        }
        throw diagnosticError("PDS 配置字段缺少等号。");
      }
      index++;
      const value = tokens[index++];
      if (!value || ["=", "}"].includes(value.raw))
        throw diagnosticError("PDS 配置字段缺少值。");
      const node = {
        key: String(atom(keyToken.raw)),
        start: keyToken.start,
        valueStart: value.start,
      };
      if (value.raw === "{") {
        const parsed = parseEntries(true);
        entries.push({
          ...node,
          kind: "block",
          children: parsed.entries,
          closeStart: parsed.close.start,
          valueEnd: parsed.close.end,
          end: parsed.close.end,
        });
      } else {
        entries.push({
          ...node,
          kind: "scalar",
          value: atom(value.raw),
          valueEnd: value.end,
          end: value.end,
        });
      }
    }
    if (nested) throw diagnosticError("PDS 配置存在未闭合的块。");
    return { entries };
  }
  return parseEntries().entries;
}

function nodeAt(entries, names) {
  let node;
  for (const name of names) {
    node = entries.findLast((entry) => entry.key === name);
    if (!node) return undefined;
    entries = node.children || [];
  }
  return node;
}

function scalarAt(entries, names) {
  const node = nodeAt(entries, names);
  return node?.kind === "scalar" ? node.value : undefined;
}

function putScalar(text, names, value) {
  const entries = parsePds(text);
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  let current = entries,
    parent = null;
  for (let depth = 0; depth < names.length; depth++) {
    const node = current.findLast((entry) => entry.key === names[depth]);
    if (!node) {
      const render = (remaining, indent) =>
        remaining.length === 1
          ? `${"\t".repeat(indent)}${JSON.stringify(remaining[0])}=${value}`
          : `${"\t".repeat(indent)}${JSON.stringify(remaining[0])}={${newline}${render(remaining.slice(1), indent + 1)}${newline}${"\t".repeat(indent)}}`;
      const addition = render(names.slice(depth), depth);
      if (!parent)
        return (
          text +
          (text && !text.endsWith("\n") ? newline : "") +
          addition +
          newline
        );
      return (
        text.slice(0, parent.closeStart) +
        newline +
        addition +
        newline +
        "\t".repeat(depth - 1) +
        text.slice(parent.closeStart)
      );
    }
    if (depth === names.length - 1) {
      if (node.kind !== "scalar")
        throw new Error("设置值不是标量，已取消修改以保留原文件。");
      return text.slice(0, node.valueStart) + value + text.slice(node.valueEnd);
    }
    if (node.kind !== "block")
      throw new Error("设置层级格式无效，已取消修改以保留原文件。");
    parent = node;
    current = node.children;
  }
  return text;
}

async function loadLayout(gameDirectory, metadata, warnings) {
  if (!gameDirectory) return clone(FALLBACK_LAYOUT);
  const filename = within(
    gameDirectory,
    metadata.ingameSettingsLayoutPath || "settings-layout.json",
  );
  const content = await readOptional(filename);
  if (content === null) {
    warnings.push("游戏未提供设置布局，使用 HOI4 标准设置项。");
    return clone(FALLBACK_LAYOUT);
  }
  const parsed = json(content, filename);
  const names = new Set();
  if (
    !Array.isArray(parsed) ||
    parsed.length > 30 ||
    parsed.some(
      (category) =>
        !object(category) ||
        !cleanString(category.category, 100) ||
        ["__proto__", "constructor", "prototype"].includes(category.category) ||
        !Array.isArray(category.settings) ||
        category.settings.length > 100 ||
        category.settings.some(
          (setting) =>
            !object(setting) ||
            !/^[A-Za-z][A-Za-z0-9_]{0,99}$/.test(setting.name) ||
            ["constructor", "prototype"].includes(setting.name) ||
            names.has(setting.name) ||
            !names.add(setting.name),
        ),
    )
  )
    throw new Error("游戏设置布局格式无效。");
  return parsed;
}

function settingsLocation(metadata, userData) {
  // Official launcher LFV0 defaults to text, regardless of ingameSettingsPath.
  const format = metadata.formatVersion ?? 0;
  if (![0, 1, 1.1, "0", "1", "1.1"].includes(format))
    throw new Error("暂不支持该游戏设置格式版本：" + format);
  return Number(format) === 0
    ? { filename: path.join(userData, "pdx_settings.txt"), format: "text" }
    : {
        filename: within(
          userData,
          metadata.ingameSettingsPath || "pdx_settings.json",
        ),
        format: "json",
      };
}

function legacyValues(entries) {
  const get = (...keys) => scalarAt(entries, keys);
  const values = {};
  const language = get("language");
  if (language !== undefined) values.language = language;
  const fullscreen = get("graphics", "fullScreen"),
    borderless = get("graphics", "borderless");
  if (fullscreen !== undefined || borderless !== undefined)
    values.display_mode =
      borderless === true
        ? "borderless_fullscreen"
        : fullscreen === true
          ? "fullscreen"
          : "windowed";
  for (const [name, source] of [
    ["vsync", "vsync"],
    ["display_index", "adapter"],
    ["refreshRate", "refreshRate"],
  ]) {
    const value = get("graphics", source);
    if (value !== undefined) values[name] = value;
  }
  const x = get("graphics", "size", "x"),
    y = get("graphics", "size", "y");
  if (x !== undefined && y !== undefined)
    values.fullscreen_resolution = values.windowed_resolution = `${x}x${y}`;
  return values;
}

async function optionSources(gameDirectory, userData, strict) {
  const warnings = [],
    sourcePaths = [];
  const metadata = await rawMetadata(gameDirectory);
  const layout = await loadLayout(gameDirectory, metadata, warnings);
  const location = settingsLocation(metadata, userData);
  const content = await readOptional(location.filename);
  let document = location.format === "text" ? [] : {};
  if (content !== null) {
    sourcePaths.push(location.filename);
    try {
      document =
        location.format === "text"
          ? parsePds(content)
          : json(content, location.filename);
      if (location.format === "json" && !object(document))
        throw diagnosticError("游戏设置 JSON 必须为对象。");
    } catch (error) {
      if (strict)
        throw diagnosticError("无法安全修改游戏设置，请修复该文件：{0}。{1}", [
          location.filename,
          errorDiagnostic(error),
        ]);
      warnings.push(
        "游戏设置无法解析，显示默认值；原文件未修改：" + location.filename,
      );
      document = location.format === "text" ? [] : {};
    }
  }
  let legacy = {};
  const legacyPath = path.join(userData, "settings.txt");
  const legacyText = await readOptional(legacyPath);
  if (legacyText !== null) {
    sourcePaths.push(legacyPath);
    try {
      legacy = legacyValues(parsePds(legacyText));
    } catch {
      warnings.push("旧版 settings.txt 无法解析，未使用其中的显示设置。");
    }
  }
  const values = {};
  for (const category of layout)
    for (const setting of category.settings) {
      let value;
      if (location.format === "text")
        value = scalarAt(document, [
          category.category,
          setting.name,
          setting.type === "toggle" ? "enabled" : "value",
        ]);
      else if (object(document[category.category]))
        value = document[category.category][setting.name];
      if (value === undefined) value = legacy[setting.name] ?? setting.default;
      if (value !== undefined)
        values[setting.name] =
          setting.type === "toggle" ? value : String(value);
    }
  return {
    metadata,
    layout,
    location,
    content,
    document,
    values,
    sourcePaths,
    warnings,
  };
}

async function readGameOptions(gameDirectory, userData) {
  const { layout, values, sourcePaths, warnings } = await optionSources(
    gameDirectory,
    userData,
    false,
  );
  return { layout, values, sourcePaths, warnings };
}

function normalizeOption(setting, value) {
  if (setting.type === "toggle") {
    if (typeof value !== "boolean")
      throw new Error(setting.name + " 必须是开启或关闭。");
    return value;
  }
  if (Array.isArray(setting.options) && setting.options.length) {
    const match = setting.options.find(
      (option) => object(option) && option.value === value,
    );
    if (!match) throw new Error(setting.name + " 的选项不受当前游戏版本支持。");
    return value;
  }
  const text =
    typeof value === "number" && Number.isFinite(value) ? String(value) : value;
  if (!cleanString(text, 100))
    throw new Error(setting.name + " 的设置值无效。");
  if (
    setting.name === "display_index" &&
    /^(0|[1-9]\d?)$/.test(text) &&
    Number(text) < 64
  )
    return text;
  if (["fullscreen_resolution", "windowed_resolution"].includes(setting.name)) {
    const match = /^(\d{3,5})x(\d{3,5})$/.exec(text);
    if (
      match &&
      Number(match[1]) >= 320 &&
      Number(match[1]) <= 32768 &&
      Number(match[2]) >= 200 &&
      Number(match[2]) <= 32768
    )
      return text;
  }
  if (
    setting.name === "refreshRate" &&
    /^\d{1,4}(?:\.\d{1,3})?$/.test(text) &&
    Number(text) >= 1 &&
    Number(text) <= 1000
  )
    return text;
  throw new Error(
    "不支持的设置值：" + setting.name + "。请从当前设备提供的选项中选择。",
  );
}

async function planGameOptions(gameDirectory, userData, patch) {
  if (!object(patch) || Object.keys(patch).length > 100)
    throw new Error("游戏设置修改格式无效。");
  const source = await optionSources(
    gameDirectory,
    userData,
    Object.keys(patch).length > 0,
  );
  const schema = new Map(
    source.layout.flatMap((category) =>
      category.settings.map((setting) => [
        setting.name,
        { setting, category: category.category },
      ]),
    ),
  );
  const normalized = {};
  for (const [name, value] of Object.entries(patch)) {
    const definition = schema.get(name);
    if (!definition) throw new Error("当前游戏版本不支持此设置：" + name);
    normalized[name] = normalizeOption(definition.setting, value);
  }
  if (!Object.keys(normalized).length)
    return { writes: [], values: source.values };
  let content;
  if (source.location.format === "text") {
    content = source.content || "";
    for (const [name, value] of Object.entries(normalized)) {
      const { category, setting } = schema.get(name);
      content = putScalar(
        content,
        [category, name, setting.type === "toggle" ? "enabled" : "value"],
        typeof value === "boolean"
          ? value
            ? "yes"
            : "no"
          : JSON.stringify(value),
      );
      if (!nodeAt(parsePds(content), [category, name, "version"]))
        content = putScalar(content, [category, name, "version"], "0");
    }
  } else {
    const document = clone(source.document);
    for (const [name, value] of Object.entries(normalized)) {
      const { category } = schema.get(name);
      if (own(document, category) && !object(document[category]))
        throw new Error("游戏设置分类格式无效：" + category);
      document[category] = { ...document[category], [name]: value };
    }
    if (source.content === null)
      document.formatVersion = Number(source.metadata.formatVersion ?? 1);
    content = JSON.stringify(document, null, 2) + "\n";
  }
  return {
    writes:
      content === source.content
        ? []
        : [{ path: source.location.filename, content }],
    values: { ...source.values, ...normalized },
  };
}

async function readDlc(gameDirectory, userData) {
  const warnings = [],
    disabledIds = [];
  const loadPath = path.join(userData, "dlc_load.json");
  const loadText = await readOptional(loadPath);
  if (loadText !== null) {
    try {
      const load = json(loadText, loadPath);
      if (
        !object(load) ||
        (load.disabled_dlcs !== undefined &&
          (!Array.isArray(load.disabled_dlcs) ||
            load.disabled_dlcs.some((id) => !cleanString(id))))
      )
        throw new Error("DLC 列表格式无效。");
      disabledIds.push(...(load.disabled_dlcs || []));
    } catch {
      warnings.push("无法读取 DLC 开关配置，原文件未修改。");
    }
  }
  const items = [];
  if (!gameDirectory) return { items, disabledIds, warnings };
  const descriptors = [];
  async function scan(directory, depth) {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes(error.code))
        warnings.push("无法读取 DLC 目录：" + directory);
      return;
    }
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".dlc"))
        descriptors.push(target);
      if (depth > 0 && entry.isDirectory()) await scan(target, depth - 1);
    }
  }
  await scan(gameDirectory, 0);
  await scan(path.join(gameDirectory, "dlc"), 4);
  const disabled = new Set(disabledIds.map((id) => forward(id).toLowerCase()));
  for (const filename of descriptors.sort()) {
    try {
      const document = parsePds(await readOptional(filename));
      const get = (name) => scalarAt(document, [name]);
      const id = forward(path.relative(gameDirectory, filename));
      const rawContentPath = get("path") || get("archive");
      const contentPath =
        typeof rawContentPath === "string"
          ? within(gameDirectory, rawContentPath)
          : filename;
      let installed;
      try {
        const contentStat = await fs.stat(contentPath);
        installed = contentStat.isFile() || contentStat.isDirectory();
      } catch (error) {
        if (["ENOENT", "ENOTDIR"].includes(error.code)) installed = false;
        else throw error;
      }
      const steamId = String(get("steam_id") || "");
      items.push({
        id,
        name:
          typeof get("name") === "string"
            ? get("name")
            : path.basename(filename, ".dlc"),
        path: filename,
        installed,
        enabled: installed && !disabled.has(id.toLowerCase()),
        steamId: /^\d+$/.test(steamId) ? steamId : null,
        popsId: cleanString(get("pops_id"), 300) ? get("pops_id") : null,
        category:
          typeof get("category") === "string" ? get("category") : "content",
      });
    } catch {
      warnings.push("无法读取 DLC 描述文件：" + path.basename(filename));
    }
  }
  items.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  return { items, disabledIds, warnings };
}

async function readContinueGame(userData) {
  const result = {
    available: false,
    title: "",
    description: "",
    date: "",
    filename: "",
    remote: false,
    reason: "尚无可继续的战役。",
  };
  const filename = path.join(userData, "continue_game.json");
  let text;
  try {
    text = await readOptional(filename);
  } catch {
    return { ...result, reason: "无法读取上次战役信息。" };
  }
  if (text === null) return result;
  try {
    const value = json(text, filename);
    if (
      !object(value) ||
      !cleanString(value.filename) ||
      !value.filename ||
      (value.is_remote !== undefined && typeof value.is_remote !== "boolean")
    )
      throw new Error();
    if (path.isAbsolute(value.filename) || /[<>"|?*]/.test(value.filename))
      throw new Error();
    const savePath = within(path.join(userData, "save games"), value.filename);
    Object.assign(result, {
      title:
        typeof value.title === "string"
          ? value.title.slice(0, 300)
          : path.basename(value.filename),
      description:
        typeof value.desc === "string" ? value.desc.slice(0, 1000) : "",
      date:
        typeof value.date === "string" ? value.date.trim().slice(0, 100) : "",
      filename: value.filename,
      remote: value.is_remote === true,
    });
    // Official --continuelastsave delegates cloud retrieval to the game/Steam.
    result.available = result.remote || (await isFile(savePath));
    result.reason = result.available
      ? ""
      : "上次战役的本地存档已移动或不存在。";
  } catch {
    result.reason = "上次战役信息无效，无法安全继续。";
  }
  return result;
}

module.exports = {
  readGameMetadata,
  resolveUserDirectory,
  readGameOptions,
  planGameOptions,
  readDlc,
  readContinueGame,
};
