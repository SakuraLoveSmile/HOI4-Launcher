"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const parser = require("@babel/parser");
const traverse = require("@babel/traverse").default;
const core = import("../src/i18n-core.mjs");
const slots = (value) =>
  [...value.matchAll(/\{\d+\}/g)].map((match) => match[0]).sort();

test("catalog entries preserve interpolation tokens and have nonempty translations", async () => {
  const directory = path.resolve(__dirname, "../src/locales");
  for (const name of await fs.readdir(directory)) {
    if (!name.endsWith(".json")) continue;
    const source = await fs.readFile(path.join(directory, name), "utf8");
    const properties = parser.parseExpression(source).properties;
    assert.equal(
      new Set(properties.map((property) => property.key.value)).size,
      properties.length,
      `${name}: duplicate keys`,
    );
    const catalog = JSON.parse(source);
    for (const [key, value] of Object.entries(catalog)) {
      assert.equal(typeof value, "string", `${name}: ${key}`);
      assert.ok(value.trim(), `${name}: empty translation for ${key}`);
      assert.deepEqual(
        slots(value),
        slots(key),
        `${name}: lost placeholder in ${key}`,
      );
      if (!["zh-hant.json", "ja.json"].includes(name))
        assert.equal(
          /[\u3400-\u9fff]/.test(value),
          false,
          `${name}: untranslated ${key}`,
        );
      if (name === "zh-hant.json")
        assert.doesNotMatch(
          value,
          /[后并里云于]/,
          `${name}: unresolved simplified form in ${key}`,
        );
    }
  }
});

test("every selectable language has a complete catalog and agrees with native labels", async () => {
  const {
    english,
    catalogs,
    languages,
    translatedTemplate,
    availableLanguage,
  } = await core;
  const { createNativeI18n } = require("../electron/native-i18n.cjs");
  assert.equal(
    new Set(languages.map((item) => item.id)).size,
    languages.length,
  );
  assert.deepEqual(
    languages.map((item) => item.id),
    [
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
    ],
  );
  for (const language of languages) {
    assert.equal(availableLanguage(language.id), language.id);
    const native = createNativeI18n();
    native.setLanguage(language.id);
    if (language.id !== "zh-hans")
      assert.deepEqual(
        Object.keys(catalogs[language.id]).sort(),
        Object.keys(english).sort(),
        language.id,
      );
    for (const key of Object.keys(english))
      assert.equal(
        native.t(key),
        translatedTemplate(language.id, key),
        `${language.id}: ${key}`,
      );
  }
  assert.equal(availableLanguage("unknown-locale"), "en");
});

test("non-English diagnostics interpolate once and preserve user-supplied names", async () => {
  const { catalogs, translate, translateMessage } = await core;
  const name = "设置 甲，但乙 {1} <img src=x>";
  for (const language of Object.keys(catalogs).filter((id) => id !== "en")) {
    const result = translate(language, "{0} 封面", { 0: name });
    assert.ok(result.includes(name), language);
    assert.equal(
      translateMessage(language, "用户自己的未知错误：" + name),
      "用户自己的未知错误：" + name,
    );
    assert.ok(
      translateMessage(language, "无法读取模组描述文件：" + name).includes(
        name,
      ),
    );
  }
  assert.equal(translate("zh-hant", "设置"), "設定");
  assert.equal(translate("zh-hant", "模组管理"), "模組管理");
  assert.equal(
    translate(
      "zh-hant",
      "只改变启动器界面，不修改游戏语言、模组名称或预设内容。",
    ),
    "只改變啟動器介面，不修改遊戲語言、模組名稱或預設內容。",
  );
});

test("rendered literal messages and accessible labels are covered and no Chinese JSX text bypasses localization", async () => {
  const { english } = await core;
  const directory = path.resolve(__dirname, "../src");
  for (const file of await fs.readdir(directory)) {
    if (!file.endsWith(".jsx")) continue;
    const ast = parser.parse(
      await fs.readFile(path.join(directory, file), "utf8"),
      { sourceType: "module", plugins: ["jsx"] },
    );
    const covered = (value) =>
      assert.ok(
        Object.hasOwn(english, value),
        `${file}: no English translation for ${value}`,
      );
    traverse(ast, {
      CallExpression(p) {
        if (
          p.node.callee.name === "t" &&
          p.node.arguments[0]?.type === "StringLiteral"
        )
          covered(p.node.arguments[0].value);
      },
      JSXAttribute(p) {
        if (p.parent.name.name !== "T" || p.node.name.name !== "id") return;
        const id =
          p.node.value.type === "JSXExpressionContainer"
            ? p.node.value.expression
            : p.node.value;
        assert.equal(
          id.type,
          "StringLiteral",
          `${file}: messages need a static id`,
        );
        covered(id.value);
      },
      JSXText(p) {
        assert.equal(
          /[\u3400-\u9fff]/.test(p.node.value),
          false,
          `${file}: unlocalized JSX text`,
        );
      },
    });
  }
});

test("unknown and prototype-like labels fall back safely without borrowing object properties", async () => {
  const { translate } = await core;
  for (const label of [
    "constructor",
    "toString",
    "__proto__",
    "Unrecognized hardware value",
    "用户自定义选项",
  ])
    assert.equal(translate("en", label), label);
  assert.equal(translate("en", undefined), "");
  assert.equal(translate("zh-hans", "设置"), "设置");
  assert.equal(translate("en", "设置"), "Settings");
});

test("interpolation preserves literal user values and never interprets HTML or nested placeholders", async () => {
  const { translate } = await core;
  const name = '设置 {1} <img src=x onerror="bad()"> &';
  assert.equal(translate("en", "{0} 封面", { 0: name }), name + " cover");
  assert.equal(
    translate("en", "{0} 封面", Object.create({ 0: "foreign" })),
    "{0} cover",
  );
});

test("application diagnostics translate while unknown text and long input remain intact", async () => {
  const { translateMessage } = await core;
  for (const message of [
    "尚无可继续的战役。",
    "目标目录已有其他内容，请选择空目录。",
    "未检测到可用的桌面显示器，请确认显示器已连接并处于活动状态。",
    "当前预设有 2 个模组不可用，请移除或重新安装后启动。",
    "已请求下载",
    "Steam 请求下载失败，请检查客户端连接后重试。",
    "Steam 官方新闻服务暂不可用（HTTP 503）。 当前显示上次缓存。",
    "Paradox Mods 暂不可用（HTTP 503）。 当前显示该查询的上次缓存。",
  ])
    assert.doesNotMatch(translateMessage("en", message), /[\u3400-\u9fff]/);
  const unknown = "未登记的远端原文 <script> {0}";
  assert.equal(translateMessage("en", unknown), unknown);
  const long = "无法读取" + "路".repeat(9000);
  assert.equal(translateMessage("en", long), long);
  assert.equal(
    translateMessage("zh-hans", "尚无可继续的战役。"),
    "尚无可继续的战役。",
  );
});

test("complete diagnostics preserve literal names and paths as interpolation values", async () => {
  const { translateMessage } = await core;
  assert.equal(
    translateMessage("en", "无法读取模组描述文件：设置，但总览.mod"),
    "Unable to read the mod descriptor: 设置，但总览.mod",
  );
  const file = "C:\\设置\\总览 {1}.json";
  const result = translateMessage(
    "en",
    `启动器配置文件损坏，已保留原文件。请先备份并移走该文件，再重启启动器：${file}`,
  );
  assert.match(result, /^The launcher configuration file is corrupted\./);
  assert.ok(result.endsWith(file));
});

test("broad composition templates require a recognized application diagnostic prefix", async () => {
  const { catalogs, translateMessage } = await core;
  for (const language of Object.keys(catalogs)) {
    assert.equal(
      translateMessage(language, "用户自定义错误甲，但乙"),
      "用户自定义错误甲，但乙",
    );
    assert.equal(
      translateMessage(language, "外部自定义操作失败。"),
      "外部自定义操作失败。",
    );
    assert.equal(
      translateMessage(language, "已收到外部自定义请求：甲，但乙"),
      "已收到外部自定义请求：甲，但乙",
    );
    if (language !== "zh-hant")
      assert.notEqual(
        translateMessage(language, "已订阅，但服务器原文 <script> {1}"),
        "已订阅，但服务器原文 <script> {1}",
      );
    assert.ok(
      translateMessage(language, "已订阅，但服务器原文 <script> {1}").includes(
        "服务器原文 <script> {1}",
      ),
    );
  }
  assert.match(
    translateMessage("zh-hant", "已订阅 安装恢复记录已保留，请先执行恢复。"),
    /安裝復原記錄已保留/,
  );
});

test("known game-setting validation messages translate without accepting arbitrary field names", async () => {
  const { catalogs, translateMessage } = await core;
  const messages = [
    "{0} 必须是开启或关闭。",
    "{0} 的选项不受当前游戏版本支持。",
    "{0} 的设置值无效。",
  ];
  for (const language of Object.keys(catalogs)) {
    for (const field of [
      "display_mode",
      "display_index",
      "vsync",
      "fullscreen_resolution",
      "windowed_resolution",
      "refreshRate",
      "renderer",
      "language",
    ]) {
      for (const key of messages)
        assert.equal(
          translateMessage(language, key.replace("{0}", field)),
          catalogs[language][key].replace("{0}", field),
        );
    }
    for (const key of messages) {
      for (const field of ["未知用户字段甲", "设置", "总览"]) {
        const unknown = key.replace("{0}", field);
        assert.equal(translateMessage(language, unknown), unknown);
      }
    }
  }
});

test("localized safety limits preserve numeric bounds across locale-specific grouping", async () => {
  const { catalogs } = await core;
  const keys = [
    "Paradox 预览图须为模组目录内不超过1,000,000字节的PNG/JPEG文件。",
    "ZIP 文件数量超过 100000 项。",
    "创意工坊页码须为 1 至 10000 的整数。",
    "发布内容超过100000个文件或200GB，请拆分模组。",
    "发布清单须包含 1 至 100000 个文件。",
    "官方数据库超过 1000 个预设，请分批导出 JSON 后导入。",
    "模组目录页码须为 0 至 10000 的整数。",
    "缓存目录超过 100000 个项目，请分批手动整理：{0}",
    "预设「{0}」超过 10000 个成员，无法导入。",
    "预设模组列表无效，最多支持 10000 个成员。",
    "预览图（模组内PNG/JPEG相对路径，最多1,000,000字节）",
  ];
  const numbers = (value) =>
    (
      value.replace(/\{\d+\}/g, "").match(/\d+(?:[.,\u00a0\u202f ]\d{3})*/g) ||
      []
    )
      .map((number) => number.replace(/[.,\u00a0\u202f ]/g, ""))
      .sort();
  for (const [language, catalog] of Object.entries(catalogs))
    for (const key of keys)
      assert.deepEqual(
        numbers(catalog[key]),
        numbers(key),
        `${language}: ${key}`,
      );
});
