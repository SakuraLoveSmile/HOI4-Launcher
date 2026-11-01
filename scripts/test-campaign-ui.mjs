import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { once, EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { createLauncherService } = require("../electron/launcher-service.cjs");
const { createCampaignService } = require("../electron/campaigns.cjs");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "ironclad-campaign-ui-"));
const output = path.resolve("test-results/five-improvements"),
  origin = "http://127.0.0.1:4195";
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
  const deadline = Date.now() + 15000;
  while (!(await fn())) {
    if (Date.now() > deadline) throw new Error("Timed out");
    await new Promise((r) => setTimeout(r, 40));
  }
};
try {
  await fs.mkdir(output, { recursive: true });
  const game = path.join(root, "game"),
    user = path.join(root, "Paradox Interactive", "Hearts of Iron IV"),
    save = path.join(user, "save games", "China.hoi4"),
    mod = path.join(user, "mod", "alpha");
  const write = async (file, bytes) => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, bytes);
  };
  await write(path.join(game, "hoi4.exe"), "fixture never executed");
  await write(
    path.join(game, "launcher-settings.json"),
    '{"rawVersion":"1.19.4.0"}',
  );
  await write(save, "save-one");
  await write(path.join(mod, "events.txt"), "one");
  await write(
    path.join(user, "mod", "alpha.mod"),
    'name="Alpha"\npath="mod/alpha"\nversion="1"\n',
  );
  let launches = 0;
  const launcher = createLauncherService({
    settingsPath: path.join(root, "settings.json"),
    documentsPath: root,
    steamRoots: [],
    processProbe: async () => null,
    spawnProcess: () => {
      launches++;
      const child = new EventEmitter();
      child.pid = 123456789;
      child.unref = () => queueMicrotask(() => child.emit("exit", 0));
      queueMicrotask(() => child.emit("spawn"));
      return child;
    },
  });
  await launcher.saveSettings({
    gameDirectory: game,
    playsets: [
      {
        id: "default",
        name: "中国战役",
        modOrder: ["local:alpha.mod"],
        modIds: ["local:alpha.mod"],
      },
    ],
  });
  let campaigns = createCampaignService({
    storageDirectory: path.join(root, "campaigns"),
    launcher,
  });
  const api = {
    getState: () => launcher.getState(),
    getLaunchStatus: () => launcher.getLaunchStatus(),
    getModThumbnail: (id) => launcher.getModThumbnail(id),
    saveSettings: (p) => launcher.saveSettings(p),
    getNews: async () => ({ items: [], source: "fixture" }),
    getPdxStorageState: async () => ({ storage: {}, busy: false, job: null }),
    getSteamMissingMods: async () => ({ job: null, plan: null }),
    getCampaigns: () => campaigns.list(),
    getCampaignProgress: () => campaigns.getProgress(),
    cancelCampaignCheck: () => campaigns.cancel(),
    bindCampaign: (input) => campaigns.bind({ ...input, savePath: save }),
    updateCampaign: (id, p) => campaigns.update(id, p),
    reviewCampaign: (id) => campaigns.review(id),
    reviewContinueCampaign: () => campaigns.reviewCurrent(),
    acceptCampaignEnvironment: (id) => campaigns.acceptEnvironment(id),
    restoreCampaignConfiguration: (id) => campaigns.restoreConfiguration(id),
    backupCampaign: (id) => campaigns.backup(id),
    restoreCampaignBackup: (id, b) => campaigns.restoreBackup(id, b),
    openCampaignFolder: async () => true,
    launchGame: async (request) => {
      const selected = await campaigns.resolveContinue(
        request.campaignId,
        request.reviewId,
      );
      return launcher.launchGame({
        resume: true,
        saveFilename: selected.filename,
      });
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
      "4195",
      "--strictPort",
    ],
    {
      cwd: path.resolve("."),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  server.stdout.on("data", (b) => {
    serverLog += b;
  });
  server.stderr.on("data", (b) => {
    serverLog += b;
  });
  await until(async () => {
    if (server.exitCode !== null) throw new Error(serverLog);
    return serverLog.includes("127.0.0.1:4195");
  });
  browser = await chromium.launch({
    channel: process.env.TEST_BROWSER_CHANNEL || "msedge",
    headless: true,
  });
  page = await browser.newPage({
    viewport: { width: 1440, height: 980 },
    reducedMotion: "reduce",
  });
  page.on("pageerror", (e) => errors.push(e.message));
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
  const open = async () => {
    await page.goto(origin);
    await page.getByRole("button", { name: "战役档案", exact: true }).click();
    await page
      .getByRole("button", { name: "绑定本地存档", exact: true })
      .waitFor();
  };
  await open();
  await page.getByRole("button", { name: "绑定本地存档", exact: true }).click();
  await page.getByLabel("战役名称", { exact: true }).waitFor();
  check(
    (await campaigns.list()).campaigns[0].backups.length === 1,
    "binding a save creates a verified backup through the real service",
  );
  await page.getByLabel("战役名称", { exact: true }).fill("中国长期战役");
  await page.getByLabel("战役备注", { exact: true }).fill("1936：先发展工业");
  await page.getByRole("button", { name: "保存档案", exact: true }).click();
  await until(
    async () => (await campaigns.list()).campaigns[0].name === "中国长期战役",
  );
  campaigns = createCampaignService({
    storageDirectory: path.join(root, "campaigns"),
    launcher,
  });
  await open();
  check(
    (await page.getByLabel("战役备注", { exact: true }).inputValue()) ===
      "1936：先发展工业",
    "campaign notes and identity survive a service and page restart",
  );
  await write(path.join(mod, "events.txt"), "two");
  await page
    .getByRole("button", { name: "检查并继续战役", exact: true })
    .click();
  const review = page.getByRole("dialog", {
    name: "继续战役前检查",
    exact: true,
  });
  await review.waitFor();
  check(
    await review.getByText("模组内容变化", { exact: true }).isVisible(),
    "review identifies changed Mod bytes even though the version is unchanged",
  );
  check(launches === 0, "review never launches a game by itself");
  await page.screenshot({
    path: path.join(output, "campaign-review.png"),
    fullPage: true,
  });
  await review
    .getByRole("button", { name: "使用当前配置继续", exact: true })
    .click();
  await review.waitFor({ state: "hidden" });
  check(
    launches === 1,
    "explicit review confirmation sends one isolated launch",
  );
  check(
    JSON.parse(await fs.readFile(path.join(user, "continue_game.json"), "utf8"))
      .filename === "China.hoi4",
    "confirmed campaign selects the recorded save",
  );
  await open();
  await write(save, "save-two");
  await page.getByRole("button", { name: "恢复选中备份", exact: true }).click();
  const restore = page.getByRole("dialog", {
    name: "恢复存档备份",
    exact: true,
  });
  await restore.getByRole("button", { name: "确认", exact: true }).click();
  await restore.waitFor({ state: "hidden" });
  check(
    (await fs.readFile(save, "utf8")) === "save-one",
    "restore returns the original save through the UI",
  );
  check(
    (await campaigns.list()).campaigns[0].backups.length === 2,
    "restore retains the overwritten save as another backup",
  );
  const current = await launcher.getState();
  await launcher.saveSettings({
    playsets: current.settings.playsets.map((p) => ({ ...p, modIds: [] })),
  });
  await open();
  await page
    .getByRole("button", { name: "检查并继续战役", exact: true })
    .click();
  await review.waitFor();
  check(
    await review.getByText("停用或移除模组", { exact: true }).isVisible(),
    "enabled-membership changes are visible in the continue review",
  );
  await review
    .getByRole("button", { name: "恢复记录配置并重新检查", exact: true })
    .click();
  await until(
    async () => (await launcher.getState()).settings.playsets.length === 2,
  );
  check(
    (await launcher.getState()).settings.playsets[0].modIds.length === 0,
    "configuration restore preserves the original playset",
  );
  await until(
    async () =>
      !(await review
        .getByRole("button", { name: "恢复记录配置并重新检查", exact: true })
        .isDisabled()),
  );
  await review.getByRole("button", { name: "关闭对话框", exact: true }).click();
  await page.setViewportSize({ width: 1000, height: 900 });
  await page.screenshot({
    path: path.join(output, "campaign-compact.png"),
    fullPage: true,
  });
  check(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    "campaign workspace fits a 1000-pixel window",
  );
  check(errors.length === 0, "campaign workflows have no page exceptions");
  check(
    external.filter((url) => !url.includes("kaspersky-labs.com")).length === 0,
    "application makes no external requests",
  );
  await fs.writeFile(
    path.join(output, "campaign-ui.json"),
    JSON.stringify({ checks, errors, external, launches }, null, 2),
  );
  console.log(`${checks.length} campaign UI checks passed`);
} catch (error) {
  if (page)
    await page
      .screenshot({
        path: path.join(output, "campaign-failure.png"),
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
    path.basename(root).startsWith("ironclad-campaign-ui-")
  )
    await fs.rm(root, {
      recursive: true,
      force: true,
      maxRetries: 8,
      retryDelay: 75,
    });
}
