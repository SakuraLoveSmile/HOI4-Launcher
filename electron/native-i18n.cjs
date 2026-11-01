"use strict";

const english = Object.freeze(
  Object.assign(
    Object.create(null),
    require("../src/locales/en-backend-a.json"),
    require("../src/locales/en-backend-b.json"),
    require("../src/locales/en-backend-c.json"),
    require("../src/locales/en-part-a.json"),
    require("../src/locales/en-part-b.json"),
    require("../src/locales/en-shell.json"),
  ),
);
const languageInfo = require("../src/language-info.json");
const catalogs = Object.freeze({
  en: english,
  de: Object.freeze(
    Object.assign(Object.create(null), require("../src/locales/de.json")),
  ),
  es: Object.freeze(
    Object.assign(Object.create(null), require("../src/locales/es.json")),
  ),
  fr: Object.freeze(
    Object.assign(Object.create(null), require("../src/locales/fr.json")),
  ),
  ja: Object.freeze(
    Object.assign(Object.create(null), require("../src/locales/ja.json")),
  ),
  ko: Object.freeze(
    Object.assign(Object.create(null), require("../src/locales/ko.json")),
  ),
  pl: Object.freeze(
    Object.assign(Object.create(null), require("../src/locales/pl.json")),
  ),
  pt: Object.freeze(
    Object.assign(Object.create(null), require("../src/locales/pt.json")),
  ),
  ru: Object.freeze(
    Object.assign(Object.create(null), require("../src/locales/ru.json")),
  ),
  tr: Object.freeze(
    Object.assign(Object.create(null), require("../src/locales/tr.json")),
  ),
  "zh-hant": Object.freeze(
    Object.assign(Object.create(null), require("../src/locales/zh-hant.json")),
  ),
});

function createNativeI18n() {
  let language = "zh-hans";
  return {
    setLanguage(value) {
      // Missing preferences belong to older Chinese-only settings. Unavailable
      // launcher languages use English until their catalogs exist.
      language = !value
        ? "zh-hans"
        : languageInfo.some((item) => item.id === value)
          ? value
          : "en";
    },
    t(key) {
      // Call only for explicit application labels, never paths, user content
      // or exported data. No template matching or recursive translation.
      if (language === "zh-hans" || !Object.hasOwn(english, key)) return key;
      const catalog = catalogs[language];
      return Object.hasOwn(catalog, key) ? catalog[key] : english[key];
    },
  };
}

module.exports = { createNativeI18n };
