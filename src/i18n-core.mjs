import englishA from "./locales/en-part-a.json" with { type: "json" };
import englishB from "./locales/en-part-b.json" with { type: "json" };
import backendA from "./locales/en-backend-a.json" with { type: "json" };
import backendB from "./locales/en-backend-b.json" with { type: "json" };
import backendC from "./locales/en-backend-c.json" with { type: "json" };
import englishShell from "./locales/en-shell.json" with { type: "json" };
import german from "./locales/de.json" with { type: "json" };
import spanish from "./locales/es.json" with { type: "json" };
import french from "./locales/fr.json" with { type: "json" };
import japanese from "./locales/ja.json" with { type: "json" };
import korean from "./locales/ko.json" with { type: "json" };
import polish from "./locales/pl.json" with { type: "json" };
import portuguese from "./locales/pt.json" with { type: "json" };
import russian from "./locales/ru.json" with { type: "json" };
import turkish from "./locales/tr.json" with { type: "json" };
import traditional from "./locales/zh-hant.json" with { type: "json" };
import languageInfo from "./language-info.json" with { type: "json" };

export const languages = Object.freeze(
  languageInfo.map((item) => Object.freeze(item)),
);
export const english = Object.freeze(
  Object.assign(
    Object.create(null),
    backendA,
    backendB,
    backendC,
    englishA,
    englishB,
    englishShell,
  ),
);
const freezeCatalog = (value) =>
  Object.freeze(Object.assign(Object.create(null), value));
export const catalogs = Object.freeze({
  en: english,
  de: freezeCatalog(german),
  es: freezeCatalog(spanish),
  fr: freezeCatalog(french),
  ja: freezeCatalog(japanese),
  ko: freezeCatalog(korean),
  pl: freezeCatalog(polish),
  pt: freezeCatalog(portuguese),
  ru: freezeCatalog(russian),
  tr: freezeCatalog(turkish),
  "zh-hant": freezeCatalog(traditional),
});
export const availableLanguage = (language) =>
  languages.some((item) => item.id === language) ? language : "en";
const token = /\{(\d+)\}/g;
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const templates = Object.keys(english)
  // Steam's three fixed success notices have exact entries. Its bare "已"
  // template is too broad to recognize unknown diagnostics safely.
  .filter((key) => /\{\d+\}/.test(key) && key !== "已{0}")
  .sort((a, b) => b.length - a.length)
  .map((key) => {
    const indices = [];
    let start = 0,
      expression = "^";
    for (const match of key.matchAll(token)) {
      expression += escape(key.slice(start, match.index)) + "([\\s\\S]*?)";
      indices.push(match[1]);
      start = match.index + match[0].length;
    }
    return {
      key,
      indices,
      requiresKnownPrefix: /^\{\d+\}/.test(key),
      pattern: new RegExp(expression + escape(key.slice(start)) + "$"),
    };
  });
const fixedStartTemplates = templates.filter(
  (template) => !template.requiresKnownPrefix,
);
const knownDiagnosticPrefix = (value) =>
  Object.hasOwn(english, value) ||
  fixedStartTemplates.some((template) => template.pattern.test(value));
const settingNames = new Set([
  "display_mode",
  "display_index",
  "vsync",
  "fullscreen_resolution",
  "windowed_resolution",
  "refreshRate",
  "renderer",
  "language",
]);
const settingDiagnostics = new Set([
  "{0} 必须是开启或关闭。",
  "{0} 的选项不受当前游戏版本支持。",
  "{0} 的设置值无效。",
]);
export function translatedTemplate(language, key) {
  if (typeof key !== "string") return "";
  if (language === "zh-hans" || !Object.hasOwn(english, key)) return key;
  const catalog = Object.hasOwn(catalogs, language)
    ? catalogs[language]
    : english;
  return Object.hasOwn(catalog, key) ? catalog[key] : english[key];
}
export function translate(language, key, values = {}) {
  return translatedTemplate(language, key).replace(token, (match, index) =>
    Object.hasOwn(values, index) ? String(values[index] ?? "") : match,
  );
}
// Explicit diagnostic trees carry application provenance. Literal values,
// including user paths that look like message keys, are never reinterpreted.
export function formatDiagnostic(language, input, fallback = "") {
  let nodes = 0,
    characters = 0;
  const text = (value) => {
    if (typeof value !== "string" || (characters += value.length) > 8192)
      throw new Error();
    return value;
  };
  function visit(value, depth = 0) {
    if (++nodes > 128 || depth > 8) throw new Error();
    if (typeof value === "string") return text(value);
    if (typeof value === "number" && Number.isFinite(value))
      return String(value);
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error();
    if (value.kind === "literal") return text(value.text);
    if (
      value.kind === "message" &&
      typeof value.key === "string" &&
      Object.hasOwn(english, value.key)
    ) {
      const key = text(value.key),
        values = value.values === undefined ? [] : value.values;
      if (!Array.isArray(values) || values.length > 64) throw new Error();
      return translate(
        language,
        key,
        values.map((part) => visit(part, depth + 1)),
      );
    }
    if (
      value.kind === "sequence" &&
      Array.isArray(value.parts) &&
      value.parts.length <= 64
    )
      return value.parts.map((part) => visit(part, depth + 1)).join("");
    throw new Error();
  }
  try {
    if (!input || typeof input !== "object" || Array.isArray(input))
      return fallback;
    return visit(input);
  } catch {
    return fallback;
  }
}
// Only call this at application-owned diagnostic boundaries. Names, paths,
// descriptions and remote content remain explicit rich-message values.
export function translateMessage(language, value) {
  if (
    typeof value !== "string" ||
    language === "zh-hans" ||
    value.length > 8192
  )
    return value;
  if (Object.hasOwn(english, value)) return translatedTemplate(language, value);
  for (const template of templates) {
    const match = template.pattern.exec(value);
    if (!match) continue;
    // Broad suffix/composition templates must not recognize arbitrary remote
    // text merely because it contains words such as "but". Check the source
    // prefix without translating or recursively interpreting captured values.
    if (settingDiagnostics.has(template.key)) {
      if (!settingNames.has(match[1])) continue;
    } else if (
      template.requiresKnownPrefix &&
      !knownDiagnosticPrefix(match[1])
    ) {
      continue;
    }
    const values = Object.fromEntries(
      template.indices.map((index, i) => [index, match[i + 1]]),
    );
    return translate(language, template.key, values);
  }
  return value;
}
