import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { createLauncherService } = require("../electron/launcher-service.cjs");
const localeCases = [
  { id: "de", locale: "de-DE", date: "2.1.2020" },
  { id: "es", locale: "es-ES", date: "2/1/2020" },
  { id: "fr", locale: "fr-FR", date: "02/01/2020" },
  { id: "ja", locale: "ja-JP", date: "2020/1/2" },
  { id: "ko", locale: "ko-KR", date: "2020. 1. 2." },
  { id: "pl", locale: "pl-PL", date: "2.01.2020" },
  { id: "pt", locale: "pt-BR", date: "02/01/2020" },
  { id: "ru", locale: "ru-RU", date: "02.01.2020" },
  { id: "tr", locale: "tr-TR", date: "02.01.2020" },
  { id: "zh-hant", locale: "zh-TW", date: "2020/1/2" },
];
const root = await fs.mkdtemp(path.join(os.tmpdir(), "ironclad-i18n-ui-"));
const output = path.resolve("test-results");
let browser, page, server;
const errors = [],
  externalRequests = [],
  environmentRequests = [],
  saves = [];
try {
  await fs.mkdir(output, { recursive: true });
  const game = path.join(root, "game"),
    user = path.join(root, "Paradox Interactive", "Hearts of Iron IV");
  const write = async (file, value) => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, value);
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
  await fs.mkdir(path.join(user, "mod", "fixture"));
  const options = {
    settingsPath: path.join(root, "settings.json"),
    documentsPath: root,
    steamRoots: [],
    processProbe: async () => null,
    spawnProcess: () => {
      throw new Error("Language tests must not launch a game");
    },
  };
  let launcher = createLauncherService(options),
    failSave = false;
  await launcher.saveSettings({
    gameDirectory: game,
    gameOptions: { language: "l_english" },
  });
  const initial = await launcher.getState();
  await launcher.saveSettings({
    playsets: initial.settings.playsets.map((playset) => ({
      ...playset,
      name: "总览",
      modOrder: ["local:fixture.mod"],
      modIds: ["local:fixture.mod"],
    })),
  });
  const original = (await launcher.getState()).settings;
  const api = {
    getState: () => launcher.getState(),
    getLaunchStatus: () => launcher.getLaunchStatus(),
    saveSettings: async (patch) => {
      saves.push(patch);
      if (failSave)
        throw new Error("配置文件已损坏，已保留原文件；请先检查或恢复配置。");
      return launcher.saveSettings(patch);
    },
    getNews: async () => ({
      source: "fixture",
      items: [
        {
          id: "1",
          date: "2020-01-02T00:00:00Z",
          title: "设置",
          excerpt: "远端原文 设置",
        },
      ],
    }),
    getAccount: async () => ({
      status: "signed-out",
      account: null,
      remembered: false,
      canRemember: true,
    }),
    getDisplays: async () => [
      {
        index: 0,
        name: "显示器",
        primary: true,
        resolutions: ["1920x1080"],
        refreshRatesByResolution: { "1920x1080": [60] },
      },
    ],
    getCachePlan: async () => ({ targets: [], warnings: [] }),
    listCacheBackups: async () => [],
    getPdxSubscriptions: async () => ({
      accountId: "fixture",
      items: [
        { modId: "123", title: "Paradox 模组 123", titleIsFallback: true },
        { modId: "124", title: "Paradox 模组 124" },
      ],
    }),
    getPdxDownloads: async () => ({
      job: {
        modId: "125",
        title: "Paradox 模组 125",
        titleIsFallback: true,
        status: "failed",
      },
      installations: [],
      bytesPerSecond: 0,
    }),
    searchModCatalog: async () => ({
      items: [],
      page: 0,
      totalCount: 0,
      totalPages: 0,
      source: "fixture",
      error: "Paradox Mods 暂不可用（HTTP 503）。 当前显示该查询的上次缓存。",
    }),
    getSteamState: async () => ({ connected: false, account: null, items: [] }),
  };
  server = spawn(
    process.execPath,
    [
      "node_modules/vite/bin/vite.js",
      "preview",
      "--host",
      "127.0.0.1",
      "--port",
      "4178",
      "--strictPort",
    ],
    {
      cwd: path.resolve("."),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let log = "";
  server.stdout.on("data", (data) => {
    log += data;
  });
  server.stderr.on("data", (data) => {
    log += data;
  });
  const deadline = Date.now() + 15000;
  while (!log.includes("127.0.0.1:4178")) {
    if (server.exitCode !== null || Date.now() > deadline) throw new Error(log);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  browser = await chromium.launch({
    channel: process.env.TEST_BROWSER_CHANNEL || "msedge",
    headless: true,
  });
  page = await browser.newPage({
    viewport: { width: 1320, height: 1050 },
    reducedMotion: "reduce",
  });
  const capture = async (name, language = "english") => {
    for (const height of [740, 820, 821, 900, 1050]) {
      await page.setViewportSize({ width: 1000, height });
      assert.deepEqual(
        await page.evaluate(() => {
          const clipped = [
            ...document.querySelectorAll(
              ".sidebar nav button, .sidebar-bottom",
            ),
          ]
            .filter((element) => {
              const bounds = element.getBoundingClientRect();
              return bounds.top < 36 || bounds.bottom > innerHeight;
            })
            .map((element) => element.textContent.trim());
          const decoration = document.querySelector(".sidebar-note-content");
          if (getComputedStyle(decoration).display !== "none") {
            const bounds = decoration.getBoundingClientRect();
            const reserved = decoration.parentElement.getBoundingClientRect();
            if (
              bounds.top < reserved.top - 0.5 ||
              bounds.bottom > reserved.bottom + 0.5
            )
              clipped.push("Sidebar decoration overlaps navigation or status");
          }
          return clipped;
        }),
        [],
        `${language}/${name}: navigation and status fit a ${height}px desktop height`,
      );
      if (height === 740 && name === "settings")
        await page.screenshot({
          path: path.join(output, `i18n-${language}-compact.png`),
          animations: "disabled",
        });
    }
    assert.equal(
      await page.evaluate(() => {
        const label = document.querySelector(".nav-caption-label");
        const context = document.querySelector(".nav-caption-context");
        return (
          getComputedStyle(context).display === "none" ||
          label.getBoundingClientRect().right + 6 <=
            context.getBoundingClientRect().left
        );
      }),
      true,
      `${name}: sidebar caption must not touch its context label`,
    );
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
      `${name}: minimum desktop width`,
    );
    await page.screenshot({
      path: path.join(output, `i18n-${language}-${name}.png`),
      fullPage: true,
      animations: "disabled",
    });
    await page.setViewportSize({ width: 1320, height: 1050 });
  };
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => {
    if (route.request().url().startsWith("http://127.0.0.1:4178/"))
      return route.continue();
    const url = new URL(route.request().url());
    if (
      url.hostname === "me.kis.v2.scr.kaspersky-labs.com" &&
      url.pathname.endsWith("/main.js")
    )
      environmentRequests.push(url.hostname);
    else externalRequests.push(url.href);
    return route.abort();
  });
  await page.exposeBinding("fixtureInvoke", (_source, method, args) => {
    assert.ok(Object.hasOwn(api, method), "Unexpected fixture API: " + method);
    return api[method](...args);
  });
  await page.addInitScript((names) => {
    window.launcher = Object.fromEntries(
      names.map((name) => [
        name,
        (...args) => window.fixtureInvoke(name, args),
      ]),
    );
  }, Object.keys(api));
  await page.goto("http://127.0.0.1:4178");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByLabel("界面语言", { exact: true }).selectOption("en");
  await page.getByRole("button", { name: "Settings", exact: true }).waitFor();
  assert.equal(await page.locator("html").getAttribute("lang"), "en-US");
  assert.match(await page.title(), /Hearts of Iron IV/);
  assert.equal(
    await page.getByLabel("Interface language", { exact: true }).inputValue(),
    "en",
  );
  await page
    .getByRole("heading", { name: "Game settings", exact: true })
    .waitFor();
  const display = page.getByLabel("Monitor", { exact: true });
  assert.match(
    await display.locator('option[value="0"]').innerText(),
    /显示器/,
  );
  assert.doesNotMatch(
    await display.locator('option[value="0"]').innerText(),
    /主显示器/,
  );
  await capture("settings");
  await page.getByRole("button", { name: /^Mod management/ }).click();
  await page
    .locator(".playset-library")
    .getByRole("button", { name: "设置", exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByLabel("Edit mod playset", { exact: true })
      .locator("option:checked")
      .innerText(),
    "总览",
  );
  await page
    .locator(".playset-library")
    .getByRole("button", { name: "设置", exact: true })
    .click();
  await page.getByRole("dialog", { name: "设置", exact: true }).waitFor();
  await capture("mod");
  assert.equal(
    await page
      .getByRole("dialog", { name: "设置", exact: true })
      .getByRole("heading")
      .innerText(),
    "设置",
  );
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "Discover mods", exact: true })
    .click();
  await page
    .getByText(
      /Paradox Mods is temporarily unavailable \(HTTP 503\)\. Showing the previous cached results for this query\./,
    )
    .waitFor();
  await page.getByText("Paradox mod 123", { exact: true }).waitFor();
  await page.getByText("Paradox 模组 124", { exact: true }).waitFor();
  await page.getByText("Paradox mod 125", { exact: true }).waitFor();
  await capture("pdx");
  await page
    .locator(".member-tabs")
    .getByRole("button", { name: "Steam Workshop", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Connect to Steam", exact: true })
    .waitFor();
  await capture("steam");
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await page.getByText("远端原文 设置", { exact: true }).waitFor();
  assert.equal(await page.locator(".news-card time").innerText(), "1/2/2020");
  await capture("overview");
  launcher = createLauncherService(options);
  await page.reload();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  assert.equal(
    await page.getByLabel("Interface language", { exact: true }).inputValue(),
    "en",
  );
  failSave = true;
  await page
    .getByLabel("Interface language", { exact: true })
    .selectOption("zh-hans");
  await page.getByRole("alert").waitFor();
  assert.equal(
    (await launcher.getState()).settings.launcherPreferences.language,
    "en",
  );
  assert.equal(
    await page.getByLabel("Interface language", { exact: true }).inputValue(),
    "en",
  );
  failSave = false;
  for (const language of localeCases) {
    const catalog = JSON.parse(
      await fs.readFile(
        path.resolve("src/locales", language.id + ".json"),
        "utf8",
      ),
    );
    const nav = (label) =>
      page.locator(".sidebar nav button").filter({ hasText: catalog[label] });
    await page.locator(".language-panel select").selectOption(language.id);
    await page.locator(`html[lang="${language.locale}"]`).waitFor();
    assert.equal(
      (await launcher.getState()).settings.launcherPreferences.language,
      language.id,
    );
    assert.equal(
      await page.getByLabel(catalog["界面语言"], { exact: true }).inputValue(),
      language.id,
    );
    await capture("settings", language.id);
    await nav("总览").click();
    await page.getByText("远端原文 设置", { exact: true }).waitFor();
    assert.equal(
      await page.locator(".news-card time").innerText(),
      language.date,
    );
    assert.equal(
      await page
        .getByLabel(catalog["当前模组播放集"], { exact: true })
        .locator("option:checked")
        .innerText(),
      "总览",
    );
    await capture("overview", language.id);
    await nav("模组管理").click();
    await page
      .locator(".playset-library")
      .getByRole("button", { name: "设置", exact: true })
      .click();
    await page.getByRole("dialog", { name: "设置", exact: true }).waitFor();
    await capture("mod", language.id);
    await page.keyboard.press("Escape");
    await nav("发现模组").click();
    await page
      .getByText(
        catalog[
          "Paradox Mods 暂不可用（HTTP {0}）。 当前显示该查询的上次缓存。"
        ].replace("{0}", "503"),
        { exact: true },
      )
      .waitFor();
    await page.getByText("Paradox 模组 124", { exact: true }).waitFor();
    await page
      .getByText(catalog["Paradox 模组 {0}"].replace("{0}", "123"), {
        exact: true,
      })
      .waitFor();
    await capture("pdx", language.id);
    await page
      .locator(".member-tabs")
      .getByRole("button", { name: catalog["Steam 创意工坊"], exact: true })
      .click();
    await page
      .getByRole("button", { name: catalog["连接 Steam"], exact: true })
      .waitFor();
    await capture("steam", language.id);
    launcher = createLauncherService(options);
    await page.reload();
    await page.locator(`html[lang="${language.locale}"]`).waitFor();
    await nav("设置").click();
    assert.equal(
      await page.locator(".language-panel select").inputValue(),
      language.id,
    );
    failSave = true;
    await page.locator(".language-panel select").selectOption("en");
    await page.getByRole("alert").waitFor();
    assert.equal(
      await page.locator("html").getAttribute("lang"),
      language.locale,
    );
    assert.equal(
      (await launcher.getState()).settings.launcherPreferences.language,
      language.id,
    );
    failSave = false;
  }
  await page.locator(".language-panel select").selectOption("zh-hans");
  await page.getByRole("button", { name: "设置", exact: true }).waitFor();
  assert.equal(await page.locator("html").getAttribute("lang"), "zh-CN");
  const final = (await launcher.getState()).settings;
  assert.deepEqual(final.playsets, original.playsets);
  assert.deepEqual(final.gameOptions, original.gameOptions);
  assert.equal(
    final.launcherPreferences.closeOnLaunch,
    original.launcherPreferences.closeOnLaunch,
  );
  assert.equal(final.launcherPreferences.language, "zh-hans");
  await assert.rejects(fs.stat(path.join(user, "dlc_load.json")), {
    code: "ENOENT",
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(externalRequests, []);
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  const report = {
    checkedAt: new Date().toISOString(),
    headlessBrowser: "Edge",
    realSettingsService: true,
    switchPersistsAcrossBackendAndPageReopen: true,
    failedSaveKeepsCurrentLanguage: true,
    userModAndPlaysetNamesPreserved: true,
    remoteNewsPreserved: true,
    gameLanguageAndGameFilesPreserved: true,
    nativeDisplayNamePreserved: true,
    generatedTitlesTranslateAndRealTitlesStayIntact: true,
    minimumDesktopWidth: 1000,
    minimumDesktopHeight: 740,
    desktopHeightsChecked: [740, 820, 821, 900, 1050],
    diagnosticTranslated: true,
    htmlLanguageTitleAndDatesUpdated: true,
    externalAppRequests: externalRequests.length,
    blockedEnvironmentScriptRequests: environmentRequests.length,
    electronExecuted: false,
    realGameDataUsed: false,
    languageWrites: saves.length,
    additionalLanguages: localeCases.map(({ id }) => id),
  };
  await fs.writeFile(
    path.join(output, "i18n-ui.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(
    JSON.stringify(
      { errors, body: await page?.locator("body").innerText() },
      null,
      2,
    ),
  );
  await page
    ?.screenshot({
      path: path.join(output, "i18n-ui-failure.png"),
      fullPage: true,
      animations: "disabled",
    })
    .catch(() => {});
  throw error;
} finally {
  await browser?.close();
  if (server && server.exitCode === null) {
    server.kill();
    await once(server, "exit");
  }
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith("ironclad-i18n-ui-"));
  await fs.rm(root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 50,
  });
}
