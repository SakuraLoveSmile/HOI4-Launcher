import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { translate } from "../src/i18n-core.mjs";
const require = createRequire(import.meta.url);
const { createLauncherService } = require("../electron/launcher-service.cjs");
const {
  diagnostic,
  sequence,
  original,
  plainDiagnostic,
} = require("../electron/diagnostic-message.cjs");

// Real preload and UI; all named IPC responses are isolated fixtures. This
// verifies rendering and transport, not native Electron or real game execution.
const root = await fs.mkdtemp(
  path.join(os.tmpdir(), "ironclad-diagnostics-ui-"),
);
const output = path.resolve("test-results"),
  port = 4179;
const filePath = "C:\\用户\\设置，但总览 {1}\\pdx_settings.txt";
const retainedPath = "D:\\设置，但总览 {1}\\ironclad-tmp-界面语言";
const newsReason = "读取 Steam 官方新闻超时，请稍后重试。";
const parseReason = "PDS 配置存在未闭合的块。";
const moveReason = "迁移源文件在复制期间发生变化。";
const recoveryReason = "原注册文件丢失或被修改，无法自动恢复。";
const publishUnknown =
  "发布请求已发出，但结果尚未确认。已保留发布标识，请只查询状态，勿重复提交。";
const publishNetwork = "Paradox 发布请求未完成，请检查网络或账号状态。";
const nodes = {
  news: diagnostic("{0} 当前显示上次缓存。", [diagnostic(newsReason)]),
  game: diagnostic("无法安全修改游戏设置，请修复该文件：{0}。{1}", [
    filePath,
    diagnostic(parseReason),
  ]),
  mod: diagnostic("{0} 临时文件因权限或其他写入被保留，请检查：{1}", [
    diagnostic("{0} 已恢复修改前的描述文件。", [
      diagnostic("{0}失败，请检查模组目录的访问权限。", [
        diagnostic("更新模组"),
      ]),
    ]),
    retainedPath,
  ]),
  move: diagnostic("{0} 迁移恢复记录已保留，请重试恢复：{1}", [
    diagnostic(moveReason),
    diagnostic(recoveryReason),
  ]),
  publish: sequence([
    diagnostic(publishUnknown),
    " ",
    diagnostic(publishNetwork),
  ]),
};
for (const value of Object.values(nodes)) assert.ok(plainDiagnostic(value));
const envelope = (value) => ({
  __ironcladDiagnosticError: 1,
  message: original(value),
  diagnostic: value,
});
let browser, server;
const errors = [],
  externalRequests = [],
  environmentRequests = [],
  invocations = [],
  results = [];
try {
  await fs.mkdir(output, { recursive: true });
  const game = path.join(root, "game"),
    user = path.join(root, "Paradox Interactive", "Hearts of Iron IV");
  const write = async (file, content) => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  };
  await write(path.join(game, "hoi4.exe"), "Fixture only; never executable");
  await write(
    path.join(game, "launcher-settings.json"),
    '{"rawVersion":"1.19.4.0"}',
  );
  await write(
    path.join(user, "mod", "fixture.mod"),
    'name="设置"\npath="mod/fixture"\nsupported_version="1.19.*"\n',
  );
  await write(
    path.join(user, "mod", "fixture", "descriptor.mod"),
    'name="设置"\nversion="1.0"\nsupported_version="1.19.*"\n',
  );
  const launcher = createLauncherService({
    settingsPath: path.join(root, "settings.json"),
    documentsPath: root,
    steamRoots: [],
    processProbe: async () => null,
    spawnProcess: () => {
      throw new Error("Diagnostic UI tests must not launch a game");
    },
  });
  await launcher.saveSettings({ gameDirectory: game });
  const metadata = {
    name: "设置",
    folder: "fixture",
    version: "1.0",
    supportedVersion: "1.19.*",
    description: "远端原文 设置",
    tags: [],
  };
  const invoke = async (channel, args) => {
    invocations.push(channel);
    switch (channel) {
      case "launcher:state":
        return launcher.getState();
      case "launcher:status":
        return launcher.getLaunchStatus();
      case "launcher:save":
        return Object.hasOwn(args[0], "gameOptions")
          ? envelope(nodes.game)
          : launcher.saveSettings(args[0]);
      case "news:state":
        return {
          source: "cache",
          fetchedAt: "2020-01-02T00:00:00Z",
          error: original(nodes.news),
          errorDiagnostic: nodes.news,
          items: [
            {
              id: "1",
              date: "2020-01-02T00:00:00Z",
              title: "设置",
              excerpt: "远端原文 设置",
            },
          ],
        };
      case "pdx-storage:state":
        return {
          busy: false,
          recoveryRequired: false,
          error: null,
          storage: { location: "D:\\用户原文\\设置", isDefault: true },
          job: {
            id: "move-fixture",
            status: "failed",
            to: retainedPath,
            error: original(nodes.move),
            errorDiagnostic: nodes.move,
          },
        };
      case "pdx:state":
        return { job: null, installations: [], bytesPerSecond: 0 };
      case "pdx:subscriptions":
        return { accountId: null, items: [] };
      case "catalog:search":
        return {
          items: [],
          totalCount: 0,
          totalPages: 0,
          page: 0,
          source: "fixture",
        };
      case "account:state":
        return {
          status: "signed-out",
          account: null,
          remembered: false,
          canRemember: true,
        };
      case "system:displays":
        return [];
      case "maintenance:plan":
        return { targets: [], warnings: [] };
      case "maintenance:list":
        return [];
      case "steam:state":
        return { connected: false, account: null, items: [] };
      case "steam-missing:state":
        return { job: null, plan: null };
      case "mods:thumbnail":
        return null;
      case "mods:metadata":
        return metadata;
      case "mods:update-metadata":
        return envelope(nodes.mod);
      case "pdx-publish:draft":
        return {
          metadata,
          lastJob: {
            id: "publish-fixture",
            status: "pending",
            publicationName: "fixture-publication",
            error: original(nodes.publish),
            errorDiagnostic: nodes.publish,
          },
        };
      case "pdx-publish:cancel":
        return true;
      default:
        throw new Error("Unexpected fixture IPC: " + channel);
    }
  };
  const preload = await fs.readFile(
    path.resolve("electron/preload.cjs"),
    "utf8",
  );
  server = spawn(
    process.execPath,
    [
      "node_modules/vite/bin/vite.js",
      "preview",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--strictPort",
    ],
    {
      cwd: path.resolve("."),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let log = "";
  server.stdout.on("data", (value) => {
    log += value;
  });
  server.stderr.on("data", (value) => {
    log += value;
  });
  const deadline = Date.now() + 15000;
  while (!log.includes(`127.0.0.1:${port}`)) {
    if (server.exitCode !== null || Date.now() > deadline) throw new Error(log);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  browser = await chromium.launch({
    channel: process.env.TEST_BROWSER_CHANNEL || "msedge",
    headless: true,
  });
  for (const language of [
    { id: "en", locale: "en-US" },
    { id: "de", locale: "de-DE" },
    { id: "ja", locale: "ja-JP" },
  ]) {
    const settings = (await launcher.getState()).settings;
    await launcher.saveSettings({
      launcherPreferences: {
        ...settings.launcherPreferences,
        language: language.id,
      },
    });
    const page = await browser.newPage({
      viewport: { width: 1360, height: 1060 },
      reducedMotion: "reduce",
    });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/*", (route) => {
      if (route.request().url().startsWith(`http://127.0.0.1:${port}/`))
        return route.continue();
      const address = new URL(route.request().url());
      if (
        address.hostname === "me.kis.v2.scr.kaspersky-labs.com" &&
        address.pathname.endsWith("/main.js")
      )
        environmentRequests.push(address.hostname);
      else externalRequests.push(address.href);
      return route.abort();
    });
    await page.exposeBinding("fixtureInvoke", (_source, channel, args) =>
      invoke(channel, args),
    );
    await page.addInitScript({
      content: `(() => {
      const require = (name) => {
        if (name !== "electron") throw new Error("Unexpected preload dependency");
        return { contextBridge: { exposeInMainWorld: (name, api) => { window[name] = api; } },
          ipcRenderer: { invoke: (channel, ...args) => window.fixtureInvoke(channel, args) } };
      };
      ${preload}
    })();`,
    });
    await page.goto(`http://127.0.0.1:${port}`);
    await page.locator(`html[lang="${language.locale}"]`).waitFor();
    const t = (key, values) => translate(language.id, key, values);
    const expected = {
      news: t("{0} 当前显示上次缓存。", [t(newsReason)]),
      game: t("无法安全修改游戏设置，请修复该文件：{0}。{1}", [
        filePath,
        t(parseReason),
      ]),
      mod: t("{0} 临时文件因权限或其他写入被保留，请检查：{1}", [
        t("{0} 已恢复修改前的描述文件。", [
          t("{0}失败，请检查模组目录的访问权限。", [t("更新模组")]),
        ]),
        retainedPath,
      ]),
      move: t("{0} 迁移恢复记录已保留，请重试恢复：{1}", [
        t(moveReason),
        t(recoveryReason),
      ]),
      publish: t(publishUnknown) + " " + t(publishNetwork),
    };
    const nav = (key) =>
      page.locator(".sidebar nav button").filter({ hasText: t(key) });
    await page.getByText("远端原文 设置", { exact: true }).waitFor();
    assert.equal(await page.locator(".news-card h3").innerText(), "设置");
    assert.ok(
      (await page.locator(".news-panel .panel-footnote").innerText()).includes(
        expected.news,
      ),
    );
    await nav("设置").click();
    assert.equal(
      await page.locator(".pdx-storage .download-job .inline-note").innerText(),
      expected.move,
    );
    await page
      .getByLabel(t("游戏语言"), { exact: true })
      .selectOption("l_english");
    await page.locator(".toast.error").waitFor();
    assert.equal(
      await page.locator(".toast.error span").innerText(),
      expected.game,
    );
    assert.ok(
      (await page.locator(".toast.error span").innerText()).includes(filePath),
    );
    if (language.id === "en")
      await page.screenshot({
        path: path.join(output, "diagnostics-ui-settings.png"),
        fullPage: true,
      });
    await page.locator(".toast").getByRole("button").click();
    await nav("模组管理").click();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page
      .getByRole("button", { name: t("编辑资料"), exact: true })
      .click();
    await page
      .getByLabel(t("模组名称"), { exact: true })
      .fill("设置，但保留 {1}");
    await page
      .getByRole("button", { name: t("保存资料"), exact: true })
      .click();
    await page.locator(".toast.error").waitFor();
    assert.equal(
      await page.locator(".toast.error span").innerText(),
      expected.mod,
    );
    assert.equal(
      await page.getByLabel(t("模组名称"), { exact: true }).inputValue(),
      "设置，但保留 {1}",
    );
    if (language.id === "de")
      await page.screenshot({
        path: path.join(output, "diagnostics-ui-mod-editor.png"),
        fullPage: true,
      });
    await page.locator(".toast").getByRole("button").click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: t("取消"), exact: true })
      .click();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page
      .getByRole("button", { name: t("发布到 Paradox Mods"), exact: true })
      .click();
    await page.getByRole("dialog").waitFor();
    assert.equal(
      await page.locator(".publish-job .inline-note").innerText(),
      expected.publish,
    );
    if (language.id === "ja")
      await page.screenshot({
        path: path.join(output, "diagnostics-ui-publish.png"),
        fullPage: true,
      });
    results.push({
      language: language.id,
      scenarios: [
        "news-cache",
        "settings-toast",
        "mod-edit-toast",
        "relocation-job",
        "publish-pending",
      ],
      literalValuesPreserved: true,
    });
    await page.close();
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(externalRequests, []);
  assert.ok(
    invocations.includes("mods:update-metadata") &&
      invocations.includes("launcher:save"),
  );
  const report = {
    checkedAt: new Date().toISOString(),
    headlessBrowser: "Edge",
    realPreloadSourceUsed: true,
    ipcResponses:
      "isolated named-channel fixtures with serializable diagnostic envelopes",
    results,
    externalAppRequests: externalRequests.length,
    blockedEnvironmentScriptRequests: environmentRequests.length,
    electronExecuted: false,
    foregroundWindowsOpened: false,
    realGameAccountOrSdkUsed: false,
  };
  await fs.writeFile(
    path.join(output, "diagnostics-ui.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  if (server && server.exitCode === null) {
    server.kill();
    await once(server, "exit");
  }
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith("ironclad-diagnostics-ui-"));
  await fs.rm(root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}
