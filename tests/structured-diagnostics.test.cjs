"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  diagnostic,
  diagnosticError,
  errorDiagnostic,
  plainDiagnostic,
  original,
  sequence,
} = require("../electron/diagnostic-message.cjs");
const core = import("../src/i18n-core.mjs");

test("known nested diagnostics translate in every selectable language while preserving ambiguous literals", async () => {
  const { formatDiagnostic, translate, languages } = await core;
  const literal = "C:\\用户\\设置，但 {1}\\pdx_settings.txt";
  const error = diagnosticError(
    "无法安全修改游戏设置，请修复该文件：{0}。{1}",
    [literal, errorDiagnostic(diagnosticError("PDS 配置存在未闭合的块。"))],
  );
  assert.equal(original(error.diagnostic), error.message);
  for (const { id } of languages) {
    const rendered = formatDiagnostic(id, error.diagnostic, error.message);
    assert.ok(rendered.includes(literal), id);
    assert.ok(rendered.includes(translate(id, "PDS 配置存在未闭合的块。")), id);
  }
  const rendered = formatDiagnostic("en", error.diagnostic);
  assert.match(rendered, /Unable to change game settings safely/);
  assert.doesNotMatch(rendered.replace(literal, ""), /[\u3400-\u9fff]/);
});

test("metadata capacity fallback preserves the legacy diagnostic instead of causing a new failure", async () => {
  const { formatDiagnostic } = await core;
  const literal = "C:\\用户\\" + "大".repeat(9000);
  const error = diagnosticError("无法解析配置文件，请先修复或恢复备份：{0}", [
    literal,
  ]);
  assert.equal(
    error.message,
    "无法解析配置文件，请先修复或恢复备份：" + literal,
  );
  assert.equal(error.diagnostic, undefined);
  const outer = diagnosticError(
    "无法安全修改游戏设置，请修复该文件：{0}。{1}",
    ["file", errorDiagnostic(error)],
  );
  assert.ok(outer.message.includes(literal));
  assert.equal(outer.diagnostic, undefined);
  assert.equal(
    formatDiagnostic("en", outer.diagnostic, outer.message),
    outer.message,
  );
});

test("raw errors that resemble known messages remain literal when embedded alongside application messages", async () => {
  const { formatDiagnostic } = await core;
  const raw = new Error("PDS 配置存在未闭合的块。");
  const input = sequence([errorDiagnostic(raw), " ", diagnostic("设置")]);
  assert.equal(formatDiagnostic("en", input), raw.message + " Settings");
  assert.equal(original(input), raw.message + " 设置");
});

test("diagnostic normalization strips unrelated objects and remains detached from subsequent mutations", () => {
  const values = ["设置"],
    input = {
      kind: "message",
      key: "{0} 封面",
      values,
      cause: "private",
      token: "private",
    };
  const result = plainDiagnostic(input);
  values[0] = "changed";
  assert.equal(result.values[0], "设置");
  assert.equal(JSON.stringify(result).includes("private"), false);
  assert.equal(
    plainDiagnostic({ kind: "message", key: "__proto__", values: [] }),
    null,
  );
  assert.equal(diagnostic("not an application key"), null);
});
