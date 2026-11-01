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
const { createCampaignService } = require("../electron/campaigns.cjs");
const {
  createGamePerformanceService,
} = require("../electron/game-performance.cjs");
const root = await fs.mkdtemp(
  path.join(os.tmpdir(), "ironclad-compact-home-ui-"),
);
const output = path.resolve("test-results/five-improvements"),
  origin = "http://127.0.0.1:4199";
let browser,
  server,
  page,
  serverLog = "";
const checks = [],
  errors = [],
  external = [];
const check = (value, label) => {
  assert.ok(value, label);
  checks.push(label);
  console.log("PASS " + label);
};
const until = async (fn) => {
  const deadline = Date.now() + 20000;
  while (!(await fn())) {
    if (Date.now() > deadline) throw new Error("Timed out");
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
};
try {
  await fs.mkdir(output, { recursive: true });
  const game = path.join(root, "game"),
    user = path.join(root, "Paradox Interactive", "Hearts of Iron IV");
  const write = async (filename, bytes) => {
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, bytes);
  };
  await write(path.join(game, "hoi4.exe"), "never executable fixture");
  await write(
    path.join(game, "launcher-settings.json"),
    '{"rawVersion":"1.19.4.0"}',
  );
  await write(
    path.join(user, "mod", "alpha.mod"),
    'name="Alpha"\npath="mod/alpha"\nversion="1"\n',
  );
  await write(
    path.join(user, "mod", "alpha", "events", "fixture.txt"),
    "fixture one",
  );
  await write(
    path.join(user, "save games", "China.hoi4"),
    "original campaign bytes",
  );
  await write(
    path.join(user, "save games", "Other.hoi4"),
    "other campaign bytes",
  );
  await write(
    path.join(user, "continue_game.json"),
    JSON.stringify({
      title: "China active save",
      filename: "cHINA.HOI4",
      is_remote: false,
    }),
  );
  let launches = 0;
  const options = {
    settingsPath: path.join(root, "settings.json"),
    documentsPath: root,
    steamRoots: [],
    processProbe: async () => null,
    spawnProcess: () => {
      launches++;
      throw new Error("Compact homepage verification must never launch a game");
    },
  };
  let launcher = createLauncherService(options);
  await launcher.saveSettings({
    gameDirectory: game,
    launcherPreferences: { closeOnLaunch: true, language: "zh-hans" },
    playsets: [
      { id: "default", name: "中国战役", modIds: ["local:alpha.mod"] },
      { id: "vanilla", name: "原版战役", modIds: [] },
    ],
  });
  let campaigns = createCampaignService({
    storageDirectory: path.join(root, "campaigns"),
    launcher,
  });
  const selected = await campaigns.bind({
    savePath: path.join(user, "save games", "China.hoi4"),
    name: "中国长期战役",
  });
  await campaigns.bind({
    savePath: path.join(user, "save games", "Other.hoi4"),
    name: "另一场战役",
  });
  const performance = createGamePerformanceService({
    storageDirectory: path.join(root, "statistics"),
    monitorPath: path.resolve("assets/game-performance-monitor.exe"),
    spawnProcess: () => {
      throw new Error("Isolated unavailable collector");
    },
  });
  for (const [instanceId, playsetName] of [
    ["default", "最近中国战役"],
    ["other-instance", "其他版本记录"],
  ]) {
    await performance.startSession({
      pid: 123456,
      launchedAt: new Date().toISOString(),
      executable: process.execPath,
      gameVersion: "1.19.4.0",
      instanceId,
      instanceName: instanceId,
      playsetId: "default",
      playsetName,
      modCount: 1,
      launchMode: "normal",
    });
  }
  let campaignReads = 0,
    performanceReads = 0,
    failCampaign = false,
    failPerformance = false;
  let pendingCampaign = null,
    holdCampaign = false;
  const api = {
    getState: () => launcher.getState(),
    getLaunchStatus: () => launcher.getLaunchStatus(),
    getModThumbnail: () => null,
    saveSettings: (patch) => launcher.saveSettings(patch),
    getNews: async () => ({ items: [], source: "fixture" }),
    getAccount: async () => ({
      status: "signed-out",
      account: null,
      canRemember: false,
    }),
    getDisplays: async () => [],
    getPdxStorageState: async () => ({ storage: {}, busy: false, job: null }),
    getSteamMissingMods: async () => ({ job: null, plan: null }),
    getCampaigns: async () => {
      campaignReads++;
      if (failCampaign)
        throw new Error("部分战役档案无法读取，原始文件已保留。");
      const result = await campaigns.list();
      if (holdCampaign) {
        holdCampaign = false;
        await new Promise((resolve) => {
          pendingCampaign = resolve;
        });
      }
      return result;
    },
    getGamePerformance: () => {
      performanceReads++;
      if (failPerformance) throw new Error("统计记录不存在或无法读取。");
      return performance.getState();
    },
    reviewCampaign: (id) => campaigns.review(id),
    getCampaignProgress: () => campaigns.getProgress(),
    cancelCampaignCheck: () => campaigns.cancel(),
    reviewContinueCampaign: () => campaigns.reviewCurrent(),
    launchGame: () => {
      launches++;
      throw new Error("No launch allowed");
    },
  };
  server = spawn(
    process.execPath,
    [
      "node_modules/vite/bin/vite.js",
      "preview",
      "--host",
      "127.0.0.1",
      "--port",
      "4199",
      "--strictPort",
    ],
    {
      cwd: path.resolve("."),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  server.stdout.on("data", (data) => {
    serverLog += data;
  });
  server.stderr.on("data", (data) => {
    serverLog += data;
  });
  await until(() => {
    if (server.exitCode !== null) throw new Error(serverLog);
    return serverLog.includes("127.0.0.1:4199");
  });
  browser = await chromium.launch({
    channel: process.env.TEST_BROWSER_CHANNEL || "msedge",
    headless: true,
  });
  page = await browser.newPage({
    viewport: { width: 1000, height: 900 },
    reducedMotion: "reduce",
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => {
    if (
      route
        .request()
        .url()
        .startsWith(origin + "/")
    )
      return route.continue();
    external.push(route.request().url());
    return route.abort();
  });
  await page.exposeBinding("fixtureInvoke", (_source, method, args) => {
    if (!Object.hasOwn(api, method)) throw new Error("Unknown method");
    return api[method](...args);
  });
  await page.addInitScript((methods) => {
    window.launcher = Object.fromEntries(
      methods.map((method) => [
        method,
        (...args) => window.fixtureInvoke(method, args),
      ]),
    );
  }, Object.keys(api));
  await page.goto(origin);
  await page.locator(".hero").waitFor();
  check(
    campaignReads === 0 && performanceReads === 0,
    "full homepage remains the default and does not fetch compact data",
  );
  await page
    .getByRole("button", { name: "切换到紧凑首页", exact: true })
    .click();
  await page.getByLabel("选择战役档案", { exact: true }).waitFor();
  await page.getByTitle("最近中国战役", { exact: true }).waitFor();
  check(
    (await page.getByLabel("选择战役档案", { exact: true }).inputValue()) ===
      selected.id,
    "compact homepage prefers the campaign matching the last local save",
  );
  check(
    !(await page.getByTitle("其他版本记录", { exact: true }).count()),
    "recent play is scoped to the current game instance",
  );
  check(
    await page
      .getByText("尚未核对实际 Mod 文件；继续前会完整检查。", { exact: true })
      .isVisible(),
    "configuration summary makes its file verification boundary explicit",
  );
  check(
    (await launcher.getState()).settings.launcherPreferences.closeOnLaunch ===
      true,
    "layout switching preserves close-on-launch preference",
  );
  const bounds = await page.locator(".compact-home-card").evaluateAll((cards) =>
    cards.map((card) => {
      const rect = card.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, right: rect.right };
    }),
  );
  check(
    bounds.length === 4 &&
      bounds.every(
        (rect) => rect.top >= 0 && rect.bottom <= 900 && rect.right <= 1000,
      ),
    "all four compact cards fit the first screen at 1000 by 900",
  );
  check(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    "compact homepage has no horizontal page overflow",
  );
  await page.screenshot({
    path: path.join(output, "compact-home.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "检查并继续", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "继续战役前检查",
    exact: true,
  });
  await dialog.waitFor();
  check(
    (await dialog.getByText("中国长期战役", { exact: true }).count()) === 1 &&
      launches === 0,
    "compact continue uses the existing complete review before launch",
  );
  await dialog.getByRole("button", { name: "关闭对话框", exact: true }).click();
  await page.getByLabel("当前播放集", { exact: true }).selectOption("vanilla");
  await page
    .locator(".compact-home-changes li")
    .filter({ hasText: "停用或移除模组" })
    .waitFor();
  check(
    (await launcher.getState()).settings.activePlaysetId === "vanilla",
    "compact playset switching persists and refreshes configuration changes",
  );
  await page
    .getByLabel("选择战役档案", { exact: true })
    .selectOption(
      (await campaigns.list()).campaigns.find((item) => item.id !== selected.id)
        .id,
    );
  check(
    (await page.getByLabel("选择战役档案", { exact: true }).inputValue()) !==
      selected.id,
    "campaign selector supports another bound campaign",
  );
  launcher = createLauncherService(options);
  campaigns = createCampaignService({
    storageDirectory: path.join(root, "campaigns"),
    launcher,
  });
  await page.reload();
  await page.getByLabel("选择战役档案", { exact: true }).waitFor();
  check(
    (await launcher.getState()).settings.launcherPreferences.homeLayout ===
      "compact" && !(await page.locator(".hero").count()),
    "compact preference survives renderer and service reopening",
  );
  failCampaign = true;
  await page.getByRole("button", { name: "刷新概览", exact: true }).click();
  await page
    .getByText("部分战役档案无法读取，原始文件已保留。", { exact: true })
    .waitFor();
  check(
    await page.getByTitle("最近中国战役", { exact: true }).isVisible(),
    "campaign read failure leaves recent-play results available",
  );
  check(
    await page
      .getByRole("button", { name: "继续游戏", exact: true })
      .isDisabled(),
    "failed campaign lookup cannot bypass campaign review through fallback continue",
  );
  failCampaign = false;
  failPerformance = true;
  await until(() =>
    page.getByRole("button", { name: "刷新概览", exact: true }).isEnabled(),
  );
  await page.getByRole("button", { name: "刷新概览", exact: true }).click();
  await page.getByText("统计记录不存在或无法读取。", { exact: true }).waitFor();
  check(
    await page.getByLabel("选择战役档案", { exact: true }).isVisible(),
    "statistics read failure leaves campaign results available",
  );
  failPerformance = false;
  await until(() =>
    page.getByRole("button", { name: "刷新概览", exact: true }).isEnabled(),
  );
  await page.getByRole("button", { name: "刷新概览", exact: true }).click();
  await page.getByTitle("最近中国战役", { exact: true }).waitFor();
  check(
    !(await page.getByRole("alert").count()),
    "independent read errors clear after successful refresh",
  );
  // An old request must not replace newer playset-specific results.
  holdCampaign = true;
  await until(() =>
    page.getByRole("button", { name: "刷新概览", exact: true }).isEnabled(),
  );
  await page.getByRole("button", { name: "刷新概览", exact: true }).click();
  await until(() => pendingCampaign !== null);
  await page.getByLabel("当前播放集", { exact: true }).selectOption("default");
  await page.getByText("配置选项暂无变化。", { exact: true }).waitFor();
  pendingCampaign();
  pendingCampaign = null;
  await page
    .getByRole("button", { name: "刷新概览", exact: true })
    .waitFor({ state: "visible" });
  await until(() =>
    page.getByRole("button", { name: "刷新概览", exact: true }).isEnabled(),
  );
  check(
    !(await page
      .locator(".compact-home-changes li")
      .filter({ hasText: "停用或移除模组" })
      .count()),
    "late previous-playset reads do not replace the current configuration summary",
  );
  const missingCampaign = (await campaigns.list()).campaigns.find(
    (item) => item.id !== selected.id,
  );
  await fs.unlink(path.join(user, "save games", "Other.hoi4"));
  await page
    .getByLabel("选择战役档案", { exact: true })
    .selectOption(missingCampaign.id);
  await page.getByRole("button", { name: "刷新概览", exact: true }).click();
  await page.getByText("存档文件缺失或不可读取。", { exact: true }).waitFor();
  check(
    await page
      .getByRole("button", { name: "检查并继续", exact: true })
      .isDisabled(),
    "a selected missing save cannot be continued",
  );
  await page
    .getByLabel("选择战役档案", { exact: true })
    .selectOption(selected.id);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByLabel("界面语言", { exact: true }).selectOption("en");
  await until(
    async () =>
      (await launcher.getState()).settings.launcherPreferences.language ===
      "en",
  );
  check(
    (await launcher.getState()).settings.launcherPreferences.homeLayout ===
      "compact",
    "changing interface language preserves homepage layout",
  );
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await page.locator(".compact-home").waitFor();
  check(
    (await page
      .locator(".compact-home-card h2")
      .evaluateAll(
        (titles) =>
          titles.length === 4 &&
          titles.every((title) => !/[\u3400-\u9fff]/.test(title.textContent)),
      )) &&
      (await page.getByTitle("最近中国战役", { exact: true }).isVisible()),
    "compact headings translate while user-provided names are retained",
  );
  await page.screenshot({
    path: path.join(output, "compact-home-en.png"),
    fullPage: true,
  });
  await page.locator(".home-layout-toolbar button").click();
  await page.locator(".hero").waitFor();
  check(
    (await launcher.getState()).settings.launcherPreferences.homeLayout ===
      "full",
    "full homepage can be restored without losing other preferences",
  );
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.locator(".language-panel select").selectOption("zh-hans");
  await page.getByRole("button", { name: "总览", exact: true }).click();
  await page
    .getByRole("button", { name: "切换到紧凑首页", exact: true })
    .click();
  const records = (await campaigns.list()).campaigns;
  for (const record of records)
    await fs.writeFile(
      path.join(root, "campaigns", "records", record.id + ".json"),
      "broken fixture record",
    );
  await until(() =>
    page.getByRole("button", { name: "刷新概览", exact: true }).isEnabled(),
  );
  await page.getByRole("button", { name: "刷新概览", exact: true }).click();
  await page
    .getByText("部分战役档案无法读取，原始文件已保留。", { exact: true })
    .waitFor();
  check(
    await page
      .getByRole("button", { name: "继续游戏", exact: true })
      .isDisabled(),
    "a partial successful scan with skipped corrupt records cannot bypass review",
  );
  await assert.rejects(campaigns.reviewCurrent(), /部分战役档案无法读取/);
  check(
    launches === 0,
    "full homepage fallback also rejects an incomplete campaign scan",
  );
  // Verify empty fallback against a separate preview profile without file access.
  const preview = await browser.newPage({
    viewport: { width: 1000, height: 900 },
  });
  await preview.route("**/*", (route) =>
    route
      .request()
      .url()
      .startsWith(origin + "/")
      ? route.continue()
      : route.abort(),
  );
  await preview.goto(origin);
  await preview
    .getByRole("button", { name: "切换到紧凑首页", exact: true })
    .click();
  await preview
    .getByText("绑定战役档案后可查看配置变化。", { exact: true })
    .waitFor();
  check(
    await preview
      .getByRole("button", { name: "继续游戏", exact: true })
      .isEnabled(),
    "unbound preview campaign uses the existing continue flow",
  );
  await preview.reload();
  check(
    await preview
      .getByRole("button", { name: "切换到完整首页", exact: true })
      .isVisible(),
    "browser preview also persists compact layout",
  );
  await preview.close();
  check(
    launches === 0 &&
      (await fs.readFile(
        path.join(user, "save games", "China.hoi4"),
        "utf8",
      )) === "original campaign bytes",
    "homepage verification never starts a game or changes fixture saves",
  );
  check(errors.length === 0, "compact workflows have no renderer exceptions");
  check(
    external.filter((url) => !url.includes("kaspersky-labs.com")).length === 0,
    "compact homepage makes no external requests",
  );
  await fs.writeFile(
    path.join(output, "compact-home-ui.json"),
    JSON.stringify({ checks, errors, external, launches }, null, 2),
  );
  console.log(`${checks.length} compact homepage UI checks passed`);
} catch (error) {
  if (errors.length) console.error("Renderer errors:", errors);
  await page
    ?.screenshot({
      path: path.join(output, "compact-home-failure.png"),
      fullPage: true,
    })
    .catch(() => {});
  throw error;
} finally {
  await browser?.close();
  if (server?.exitCode === null) {
    const exit = once(server, "exit");
    server.kill();
    await exit;
  }
  if (
    path.dirname(root) === os.tmpdir() &&
    path.basename(root).startsWith("ironclad-compact-home-ui-")
  )
    await fs.rm(root, {
      recursive: true,
      force: true,
      maxRetries: 8,
      retryDelay: 75,
    });
}
