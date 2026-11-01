"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createNativeI18n } = require("../electron/native-i18n.cjs");

test("native labels default to Chinese and language instances remain independent", () => {
  const first = createNativeI18n();
  const second = createNativeI18n();
  assert.equal(first.t("关闭启动器"), "关闭启动器");
  first.setLanguage("en");
  assert.equal(first.t("关闭启动器"), "Close launcher");
  assert.equal(second.t("关闭启动器"), "关闭启动器");
  first.setLanguage("zh-hans");
  assert.equal(first.t("关闭启动器"), "关闭启动器");
});

test("native labels use exact keys and preserve unknown strings without template matching", () => {
  const i18n = createNativeI18n();
  i18n.setLanguage("en");
  for (const value of [
    "constructor",
    "__proto__",
    "toString",
    "未登记的标签",
    "已自定义名称",
    "甲，但乙",
    "C:\\设置\\关闭启动器.json",
  ])
    assert.equal(i18n.t(value), value);
  assert.equal(i18n.t("模组操作进行中"), "Mod operation in progress");
});

test("unknown languages fall back to English and missing legacy preferences use Chinese", () => {
  const i18n = createNativeI18n();
  i18n.setLanguage("unknown-locale");
  assert.equal(i18n.t("继续等待"), "Keep waiting");
  i18n.setLanguage(undefined);
  assert.equal(i18n.t("继续等待"), "继续等待");
});
