"use strict";

const CHECK_LIMITS = Object.freeze({
  files: 20000,
  fileCharacters: 1024 * 1024,
  totalCharacters: 32 * 1024 * 1024,
  tokens: 100000,
  depth: 128,
  issues: 500,
  references: 50000,
});

// A deliberately small Clausewitz lexer. Comments and quoted strings are
// consumed as units so braces and event-like text inside them are never parsed.
function tokenize(text) {
  const tokens = [];
  let index = 0,
    line = 1;
  while (index < text.length) {
    const ch = text[index];
    if (/\s|\uFEFF/.test(ch)) {
      if (ch === "\r" || (ch === "\n" && text[index - 1] !== "\r")) line++;
      index++;
      continue;
    }
    if (ch === "#") {
      while (index < text.length && !"\r\n".includes(text[index])) index++;
      continue;
    }
    const startLine = line;
    if (ch === '"') {
      index++;
      let value = "",
        closed = false;
      while (index < text.length) {
        const next = text[index++];
        if (next === '"') {
          closed = true;
          break;
        }
        if (next === "\\" && index < text.length) {
          const escaped = text[index++];
          value +=
            escaped === '"' || escaped === "\\" ? escaped : "\\" + escaped;
          if (
            escaped === "\r" ||
            (escaped === "\n" && text[index - 2] !== "\r")
          )
            line++;
        } else {
          value += next;
          if (next === "\r" || (next === "\n" && text[index - 2] !== "\r"))
            line++;
        }
      }
      if (!closed) return { error: "unterminated-string", line: startLine };
      tokens.push({ kind: "atom", value, line: startLine, quoted: true });
    } else if ("{}=<>!?".includes(ch)) {
      index++;
      let value = ch;
      if (text[index] === "=" && "<>!?".includes(ch)) value += text[index++];
      tokens.push({ kind: value, value, line: startLine });
    } else {
      const start = index;
      while (index < text.length && !/[\s#{}=<>!?"\uFEFF]/.test(text[index]))
        index++;
      tokens.push({
        kind: "atom",
        value: text.slice(start, index),
        line: startLine,
      });
    }
    if (tokens.length > CHECK_LIMITS.tokens)
      return { error: "token-limit", line };
  }
  return { tokens };
}

function parse(text) {
  const lexed = tokenize(text);
  if (lexed.error) return lexed;
  const tokens = lexed.tokens;
  let index = 0;
  function block(depth, nested) {
    if (depth > CHECK_LIMITS.depth)
      throw { error: "depth-limit", line: tokens[index]?.line || 1 };
    const nodes = [],
      values = [];
    while (index < tokens.length) {
      const token = tokens[index++];
      if (token.kind === "}") {
        if (!nested) throw { error: "unexpected-brace", line: token.line };
        return { nodes, values };
      }
      if (token.kind === "{") {
        block(depth + 1, true);
        continue;
      }
      if (token.kind !== "atom") continue;
      if (tokens[index]?.kind !== "=") {
        values.push(token.value);
        continue;
      }
      index++;
      const value = tokens[index++];
      if (!value || value.kind === "}")
        throw { error: "missing-value", line: token.line };
      if (value.kind === "{") {
        const child = block(depth + 1, true);
        nodes.push({
          key: token.value,
          line: token.line,
          children: child.nodes,
          values: child.values,
          value: null,
        });
      } else if (value.kind === "atom") {
        nodes.push({
          key: token.value,
          line: token.line,
          value: value.value,
          quoted: value.quoted,
          children: null,
        });
      }
    }
    if (nested)
      throw { error: "unclosed-brace", line: tokens.at(-1)?.line || 1 };
    return { nodes, values };
  }
  try {
    return block(0, false);
  } catch (error) {
    return error;
  }
}

const GROUPS = [
  ["focus", "国策", /^common\/national_focus\//i],
  ["events", "事件", /^events\//i],
  ["localisation", "本地化", /^locali[sz]ation\//i],
  ["decisions", "决议", /^common\/decisions\//i],
  ["history", "历史与国家", /^history\//i],
  ["graphics", "图形与界面", /^(?:gfx|interface)\//i],
  ["map", "地图", /^map\//i],
  ["audio", "音频", /^(?:sound|music)\//i],
  ["scripts", "其他脚本", /^common\//i],
  ["metadata", "模组资料", /^(?:descriptor\.mod|[^/]+\.mod)$/i],
  ["other", "其他文件", /./],
];
const EVENT_KEYS = new Set([
  "country_event",
  "news_event",
  "state_event",
  "unit_leader_event",
  "operative_leader_event",
]);
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const eventIdentifier = (value) =>
  typeof value === "string" && /^(?:[A-Za-z_][A-Za-z0-9_]*\.)?\d+$/.test(value);
const childValue = (node, key) =>
  node.children?.find((child) => child.key === key && child.value !== null)
    ?.value;

function analyzeProjectFiles(files) {
  if (!Array.isArray(files)) throw new Error("HOI4 检查需要项目文件列表。");
  const issues = [],
    groups = GROUPS.map(([id, label]) => ({ id, label, paths: [], count: 0 }));
  const definitions = new Map(),
    focusDefinitions = new Map(),
    references = [],
    localisationReferences = [];
  const localisation = new Map(),
    localisationKeys = new Set();
  const boundedFiles = files.slice(0, CHECK_LIMITS.files);
  let total = 0,
    limited = files.length > CHECK_LIMITS.files;
  const issue = (value) => {
    if (issues.length < CHECK_LIMITS.issues) issues.push(value);
    else limited = true;
  };
  const define = (map, id, path, line) => {
    const previous = map.get(id);
    if (previous) previous.push({ path, line });
    else map.set(id, [{ path, line }]);
  };
  const addReference = (list, value) => {
    if (list.length < CHECK_LIMITS.references) list.push(value);
    else limited = true;
  };
  for (const file of boundedFiles) {
    if (!file || typeof file.path !== "string") continue;
    const filename = file.path.replace(/\\/g, "/");
    const groupIndex = GROUPS.findIndex(([, , pattern]) =>
      pattern.test(filename),
    );
    const group = groups[groupIndex < 0 ? groups.length - 1 : groupIndex];
    group.paths.push(filename);
    group.count++;
    if (typeof file.text !== "string") continue;
    if (
      file.text.length > CHECK_LIMITS.fileCharacters ||
      total + file.text.length > CHECK_LIMITS.totalCharacters
    ) {
      limited = true;
      continue;
    }
    total += file.text.length;
    if (/^locali[sz]ation\/.*\.ya?ml$/i.test(filename)) {
      let language = null;
      const lines = file.text.replace(/^\uFEFF/, "").split(/\r\n|\r|\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i],
          header = line.match(/^\s*(l_[A-Za-z_]+):\s*(?:#.*)?$/);
        if (header) {
          language = header[1];
          continue;
        }
        const key = line.match(/^\s*([^\s:#]+):\d*\s+"/);
        if (!language || !key) continue;
        localisationKeys.add(key[1]);
        const id = language + ":" + key[1];
        const previous = localisation.get(id);
        if (previous)
          issue({
            severity: "warning",
            code: "duplicate-localisation",
            path: filename,
            line: i + 1,
            message: `同一语言重复定义本地化键：${key[1]}（${language}）。`,
            relatedPaths: [previous.path],
          });
        else localisation.set(id, { path: filename, line: i + 1 });
      }
      continue;
    }
    if (!/\.txt$|(?:^|\/)descriptor\.mod$/i.test(filename)) continue;
    const parsed = parse(file.text);
    if (parsed.error) {
      const budget = parsed.error.endsWith("limit");
      if (budget) limited = true;
      issue({
        severity: budget ? "info" : "warning",
        code: budget ? "script-check-limit" : "script-structure",
        path: filename,
        line: parsed.line,
        message: budget
          ? "文件超过静态检查预算，尚未完成结构检查。"
          : "脚本存在未闭合的引号、花括号或缺少赋值内容，请检查对应行。",
      });
      continue;
    }
    const eventFile = /^events\//i.test(filename),
      focusFile = /^common\/national_focus\//i.test(filename);
    const descriptor = /(?:^|\/)descriptor\.mod$/i.test(filename);
    function walk(nodes, depth = 0, eventContext = false) {
      for (const node of nodes) {
        const isEvent = EVENT_KEYS.has(node.key);
        const isDefinition =
          eventFile && depth === 0 && isEvent && node.children;
        if (isEvent) {
          const id = node.value ?? childValue(node, "id");
          if (eventIdentifier(id)) {
            if (isDefinition) define(definitions, id, filename, node.line);
            else
              addReference(references, { id, path: filename, line: node.line });
          }
        }
        if (focusFile && node.key === "focus" && node.children) {
          const id = childValue(node, "id");
          if (id && IDENTIFIER.test(id)) {
            define(focusDefinitions, id, filename, node.line);
            addReference(localisationReferences, {
              id,
              path: filename,
              line: node.line,
            });
          }
        }
        if (
          (eventContext || isDefinition) &&
          ["title", "desc", "name"].includes(node.key) &&
          node.value &&
          IDENTIFIER.test(node.value)
        )
          addReference(localisationReferences, {
            id: node.value,
            path: filename,
            line: node.line,
          });
        if (
          descriptor &&
          depth === 0 &&
          node.key === "dependencies" &&
          node.children
        ) {
          for (const dependency of node.values || [])
            issue({
              severity: "info",
              code: "descriptor-dependency",
              path: filename,
              line: node.line,
              message: `此项目声明依赖模组：${dependency}。请在播放集中核对依赖及加载顺序。`,
            });
        }
        if (
          descriptor &&
          depth === 0 &&
          node.key === "replace_path" &&
          node.value
        ) {
          if (issues.length >= CHECK_LIMITS.issues) limited = true;
          else {
            const relatedPaths = [],
              prefix = node.value.replace(/\/$/, "") + "/";
            for (const item of boundedFiles) {
              if (
                typeof item?.path === "string" &&
                item.path.startsWith(prefix)
              )
                relatedPaths.push(item.path);
              if (relatedPaths.length === 100) break;
            }
            issue({
              severity: "warning",
              code: "descriptor-replace-path",
              path: filename,
              line: node.line,
              message: `此项目使用 replace_path：${node.value}。该目录的原版内容可能被整体替换，选择性合入时需检查配套文件。`,
              relatedPaths,
            });
          }
        }
        if (node.children)
          walk(node.children, depth + 1, eventContext || isDefinition);
      }
    }
    walk(parsed.nodes);
  }
  for (const [map, code, label] of [
    [definitions, "duplicate-event-id", "事件 ID"],
    [focusDefinitions, "duplicate-focus-id", "国策 ID"],
  ]) {
    for (const [id, entries] of map) {
      if (entries.length < 2) continue;
      issue({
        severity: "warning",
        code,
        path: entries[0].path,
        line: entries[0].line,
        message: `项目内存在重复${label}：${id}。请核对覆盖是否符合预期。`,
        relatedPaths: [...new Set(entries.slice(1).map((item) => item.path))],
      });
    }
  }
  const seen = new Set();
  for (const reference of references) {
    const key = reference.path + "\0" + reference.id;
    if (definitions.has(reference.id) || seen.has(key)) continue;
    seen.add(key);
    issue({
      severity: "info",
      code: "external-event-reference",
      path: reference.path,
      line: reference.line,
      message: `引用的事件 ${reference.id} 未在本项目找到；可能来自原版或依赖模组。`,
    });
  }
  seen.clear();
  for (const reference of localisationReferences) {
    const key = reference.path + "\0" + reference.id;
    if (localisationKeys.has(reference.id) || seen.has(key)) continue;
    seen.add(key);
    issue({
      severity: "info",
      code: "external-localisation-reference",
      path: reference.path,
      line: reference.line,
      message: `本地化键 ${reference.id} 未在本项目找到；可能来自原版或依赖模组。`,
    });
  }
  return {
    issues,
    groups: groups.filter((group) => group.count),
    limited,
    scope: "project-static-only",
  };
}

module.exports = { analyzeProjectFiles, CHECK_LIMITS };

// Reuse the project checker's lexer and grammar without inheriting its warnings
// or dependency interpretation. Lines identify the ID assignment itself.
function inspectModScript(filename, text) {
  const result = { events: [], focuses: [], replacePaths: [], limited: false };
  if (
    typeof filename !== "string" ||
    typeof text !== "string" ||
    text.length > CHECK_LIMITS.fileCharacters
  )
    return { ...result, limited: true, error: "text-limit" };
  const parsed = parse(text);
  if (parsed.error)
    return {
      ...result,
      limited: parsed.error.endsWith("limit"),
      error: parsed.error,
      line: parsed.line,
    };
  const eventFile = /^events\//i.test(filename),
    focusFile = /^common\/national_focus\//i.test(filename),
    descriptor = /(?:^|\/)[^/]+\.mod$/i.test(filename);
  const idNode = (node) =>
    node.children?.find((child) => child.key === "id" && child.value !== null);
  function walk(nodes, parent = null, depth = 0) {
    for (const node of nodes) {
      const identifier = idNode(node);
      if (
        eventFile &&
        depth === 0 &&
        EVENT_KEYS.has(node.key) &&
        node.children &&
        eventIdentifier(identifier?.value)
      )
        result.events.push({ id: identifier.value, line: identifier.line });
      if (
        focusFile &&
        ["focus", "shared_focus"].includes(node.key) &&
        node.children &&
        (depth === 0 || (depth === 1 && parent?.key === "focus_tree")) &&
        IDENTIFIER.test(identifier?.value || "")
      )
        result.focuses.push({ id: identifier.value, line: identifier.line });
      if (
        descriptor &&
        depth === 0 &&
        node.key === "replace_path" &&
        typeof node.value === "string"
      )
        result.replacePaths.push({ value: node.value, line: node.line });
      if (node.children) walk(node.children, node, depth + 1);
    }
  }
  walk(parsed.nodes);
  return result;
}

module.exports.inspectModScript = inspectModScript;
