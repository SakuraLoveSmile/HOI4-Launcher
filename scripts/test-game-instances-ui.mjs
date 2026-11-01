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
const origin = "http://127.0.0.1:4197";
const output = path.resolve("test-results/game-instances");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "ironclad-instances-ui-"));
const checks = [],
  errors = [],
  externalRequests = [],
  environmentRequests = [];
let browser, page, server;
const check = (condition, message) => {
  assert.ok(condition, message);
  checks.push(message);
  console.log(`PASS ${message}`);
};
async function until(predicate, message) {
  const deadline = Date.now() + 10000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

try {
  await fs.mkdir(output, { recursive: true });
  const game = path.join(root, "当前版本");
  const oldGame = path.join(root, "旧版 1.12");
  const settingsPath = path.join(root, "app", "settings.json");
  const write = async (file, text) => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text);
  };
  for (const [directory, version] of [
    [game, "1.19.4"],
    [oldGame, "1.12.14"],
  ]) {
    await write(
      path.join(directory, "hoi4.exe"),
      "Fixture only; never execute",
    );
    await write(
      path.join(directory, "launcher-settings.json"),
      JSON.stringify({ rawVersion: version }),
    );
  }
  const userData = path.join(root, "Paradox Interactive", "Hearts of Iron IV");
  const defaultSave = path.join(userData, "save games", "default.hoi4");
  await write(defaultSave, "original default campaign");
  await write(
    path.join(userData, "mod", "alpha.mod"),
    'name="当前版本模组"\npath="mod/alpha"\nsupported_version="1.19.*"\n',
  );
  await write(
    path.join(userData, "mod", "alpha", "sentinel.txt"),
    "original mod content",
  );
  let running = false,
    cancelCreate = true,
    failSwitch = false;
  const options = {
    settingsPath,
    documentsPath: root,
    steamRoots: [],
    processProbe: async () => (running ? { pid: 12345 } : null),
    spawnProcess: () => {
      throw new Error("Instance UI tests must never launch a game");
    },
  };
  let launcher = createLauncherService(options);
  await launcher.saveSettings({
    gameDirectory: game,
    launchMode: "debug",
    gameOptions: { vsync: false },
    disabledDlcIds: ["dlc/default.dlc"],
    playsets: [
      { id: "default", name: "当前版本战役", modIds: ["local:alpha.mod"] },
    ],
  });
  const initial = await launcher.getState();
  const api = {
    getState: () => launcher.getState(),
    getLaunchStatus: () => launcher.getLaunchStatus(),
    getModThumbnail: (id) => launcher.getModThumbnail(id),
    saveSettings: (patch) => launcher.saveSettings(patch),
    createGameInstance: (input) =>
      cancelCreate
        ? null
        : launcher.createGameInstance({ ...input, gameDirectory: oldGame }),
    switchGameInstance: (id) => {
      if (failSwitch) throw new Error("隔离测试：切换失败，请重试。");
      return launcher.switchGameInstance(id);
    },
    renameGameInstance: (input) => launcher.renameGameInstance(input),
    removeGameInstance: (id) => launcher.removeGameInstance(id),
    getNews: async () => ({ items: [], source: "fixture" }),
    getPdxStorageState: async () => ({
      storage: { location: "隔离测试受管模组", isDefault: true },
      busy: false,
      job: null,
    }),
    getSteamMissingMods: async () => ({ job: null, plan: null }),
    getAccount: async () => ({ status: "signed-out", canRemember: false }),
    getDisplays: async () => [],
  };
  server = spawn(
    process.execPath,
    [
      "node_modules/vite/bin/vite.js",
      "preview",
      "--host",
      "127.0.0.1",
      "--port",
      "4197",
      "--strictPort",
    ],
    {
      cwd: path.resolve("."),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let serverLog = "";
  server.stdout.on("data", (data) => {
    serverLog += data;
  });
  server.stderr.on("data", (data) => {
    serverLog += data;
  });
  await until(async () => {
    if (server.exitCode !== null)
      throw new Error(`Preview server exited: ${serverLog}`);
    return serverLog.includes("127.0.0.1:4197");
  }, "preview server startup");
  browser = await chromium.launch({
    channel: process.env.TEST_BROWSER_CHANNEL || "msedge",
    headless: true,
  });
  page = await browser.newPage({
    viewport: { width: 1440, height: 980 },
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
    assert.ok(Object.hasOwn(api, method), `Unexpected fixture API: ${method}`);
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
  const panel = page.locator(".game-instances-panel");
  const selector = () => page.getByLabel("当前游戏版本", { exact: true });
  const state = () => launcher.getState();
  const settled = async () =>
    until(
      async () => !(await selector().isDisabled()),
      "instance mutation settles",
    );
  const openSettings = async () => {
    await page
      .locator("nav")
      .getByRole("button", { name: "设置", exact: true })
      .click();
    await panel.waitFor();
    await settled();
  };
  const select = async (id) => {
    await selector().selectOption(id);
    await until(
      async () => (await state()).settings.activeGameInstanceId === id,
      "instance selection persists",
    );
    await settled();
  };
  const add = async (name) => {
    await panel
      .getByRole("button", { name: "添加独立版本", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: "版本名称", exact: true })
      .fill(name);
    await page
      .getByRole("button", { name: "选择安装目录并添加", exact: true })
      .click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    await settled();
    return state();
  };

  await page.goto(origin);
  await selector().waitFor();
  check(
    (await selector().inputValue()) === "default",
    "home exposes the preserved default instance",
  );
  await openSettings();
  check(
    await panel
      .getByRole("button", { name: "移除版本", exact: true })
      .isDisabled(),
    "default instance cannot be removed",
  );
  await panel
    .getByRole("button", { name: "添加独立版本", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "版本名称", exact: true })
    .fill("旧版 1.12 历史战役");
  await page
    .getByRole("button", { name: "选择安装目录并添加", exact: true })
    .click();
  await until(
    async () =>
      !(await page
        .getByRole("button", { name: "选择安装目录并添加", exact: true })
        .isDisabled()),
    "cancelled native selection settles",
  );
  check(
    (await state()).settings.gameInstances.length === 1 &&
      (await page.getByRole("dialog").isVisible()),
    "cancelling the native directory picker preserves the form and existing instances",
  );
  cancelCreate = false;
  await page
    .getByRole("button", { name: "选择安装目录并添加", exact: true })
    .click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await settled();
  const old = await state(),
    oldId = old.settings.activeGameInstanceId;
  check(
    oldId !== "default" &&
      old.settings.gameDirectory === oldGame &&
      old.game.version === "1.12.14",
    "adding an old installation selects its detected version",
  );
  check(
    old.settings.playsets.length === 1 &&
      old.settings.playsets[0].modIds.length === 0 &&
      old.mods.length === 0,
    "old instance starts with an empty playset and separate local mod registration",
  );
  check(
    old.settings.launchMode === "normal" &&
      Object.keys(old.settings.gameOptions).length === 0 &&
      old.settings.disabledDlcIds === null,
    "new instance does not inherit pending settings or DLC choices",
  );
  check(
    old.paths.userData !== initial.paths.userData &&
      old.paths.userData.includes(oldId),
    "isolated storage uses a stable directory unique to the instance",
  );
  const oldSave = path.join(old.paths.userData, "save games", "old.hoi4");
  await write(oldSave, "old campaign sentinel");
  await launcher.saveSettings({ gameOptions: { vsync: true } });
  await panel.getByRole("button", { name: "重命名版本", exact: true }).click();
  await page
    .getByRole("textbox", { name: "版本名称", exact: true })
    .fill("旧版 1.12 专用模组战役");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "保存名称", exact: true })
    .click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await settled();
  check(
    (await state()).settings.gameInstances.find((item) => item.id === oldId)
      .name === "旧版 1.12 专用模组战役",
    "rename updates the instance without changing its identity or storage",
  );
  const beforeFailure = await fs.readFile(settingsPath, "utf8");
  failSwitch = true;
  await selector().selectOption("default");
  await page
    .getByRole("alert")
    .filter({ hasText: "隔离测试：切换失败，请重试。" })
    .waitFor();
  await settled();
  check(
    (await selector().inputValue()) === oldId &&
      (await fs.readFile(settingsPath, "utf8")) === beforeFailure,
    "failed switch retains the selected instance and persisted configuration",
  );
  failSwitch = false;
  await select("default");
  const restored = await state();
  assert.deepEqual(restored.settings.playsets, initial.settings.playsets);
  assert.deepEqual(restored.settings.gameOptions, initial.settings.gameOptions);
  assert.deepEqual(
    restored.settings.disabledDlcIds,
    initial.settings.disabledDlcIds,
  );
  check(
    restored.paths.userData === initial.paths.userData &&
      restored.settings.launchMode === "debug",
    "switching back restores the default playsets, DLC choices, options and original directory",
  );
  const independent = await add("独立大修版本"),
    independentId = independent.settings.activeGameInstanceId;
  check(
    independentId !== oldId &&
      independent.paths.userData !== old.paths.userData,
    "two instances of the same installed executable retain separate storage",
  );
  await assert.rejects(
    fs.stat(path.join(independent.paths.userData, "save games", "old.hoi4")),
    { code: "ENOENT" },
  );
  check(
    true,
    "a second independent instance cannot see the first instance save file",
  );
  await select(oldId);
  check(
    (await state()).settings.gameOptions.vsync === true,
    "old-instance settings return after switching through other instances",
  );
  launcher = createLauncherService(options);
  await page.reload();
  await selector().waitFor();
  await settled();
  check(
    (await selector().inputValue()) === oldId &&
      (await state()).settings.gameOptions.vsync === true,
    "service and renderer restart preserve the selected instance and its settings",
  );
  await openSettings();
  await panel.screenshot({
    path: path.join(output, "instances-zh-hans.png"),
    animations: "disabled",
  });
  await page.getByLabel("界面语言", { exact: true }).selectOption("en");
  await panel
    .getByRole("heading", { name: "Version isolation", exact: true })
    .waitFor();
  await panel.screenshot({
    path: path.join(output, "instances-en.png"),
    animations: "disabled",
  });
  check(
    (await panel.getByText("旧版 1.12 专用模组战役", { exact: true }).count()) >
      0,
    "English interface preserves the user's Chinese instance name",
  );
  await page
    .getByLabel("Interface language", { exact: true })
    .selectOption("zh-hans");
  await panel.getByRole("heading", { name: "版本隔离", exact: true }).waitFor();
  await settled();
  await page.setViewportSize({ width: 1000, height: 740 });
  check(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    "1000px settings page has no horizontal overflow",
  );
  await panel.screenshot({
    path: path.join(output, "instances-1000px.png"),
    animations: "disabled",
  });
  running = true;
  await page.getByRole("button", { name: "刷新资料", exact: true }).click();
  await until(
    async () => await selector().isDisabled(),
    "running-game guard appears",
  );
  check(
    (await panel
      .getByRole("button", { name: "添加独立版本", exact: true })
      .isDisabled()) &&
      (await panel
        .getByRole("button", { name: "移除版本", exact: true })
        .isDisabled()),
    "running game disables switching and instance management",
  );
  running = false;
  await page.getByRole("button", { name: "刷新资料", exact: true }).click();
  await settled();
  await panel.getByRole("button", { name: "移除版本", exact: true }).click();
  await page.getByRole("button", { name: "确认移除版本", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await settled();
  const removed = await state();
  check(
    removed.settings.activeGameInstanceId === "default" &&
      !removed.settings.gameInstances.some((item) => item.id === oldId),
    "removing the active instance switches back to the default version",
  );
  assert.equal(await fs.readFile(oldSave, "utf8"), "old campaign sentinel");
  assert.equal(
    await fs.readFile(defaultSave, "utf8"),
    "original default campaign",
  );
  assert.equal(
    await fs.readFile(path.join(oldGame, "hoi4.exe"), "utf8"),
    "Fixture only; never execute",
  );
  assert.equal(
    await fs.readFile(
      path.join(userData, "mod", "alpha", "sentinel.txt"),
      "utf8",
    ),
    "original mod content",
  );
  check(
    true,
    "removing an instance preserves its saves, original game installation and default content",
  );
  await assert.rejects(fs.stat(path.join(userData, "dlc_load.json")), {
    code: "ENOENT",
  });
  check(true, "browsing and managing instances never writes game launch files");
  assert.deepEqual(errors, []);
  assert.deepEqual(externalRequests, []);
  check(
    true,
    "no renderer errors, real game launches or external application requests",
  );
  await fs.writeFile(
    path.join(output, "results.json"),
    JSON.stringify(
      {
        checks,
        count: checks.length,
        errors,
        externalRequests,
        environmentRequests,
      },
      null,
      2,
    ),
  );
  console.log(`Version instance UI: ${checks.length} checks passed`);
} catch (error) {
  if (page)
    await page
      .screenshot({ path: path.join(output, "failure.png"), fullPage: true })
      .catch(() => {});
  await fs
    .writeFile(
      path.join(output, "failure.json"),
      JSON.stringify(
        {
          message: error.message,
          stack: error.stack,
          checks,
          errors,
          externalRequests,
        },
        null,
        2,
      ),
    )
    .catch(() => {});
  throw error;
} finally {
  await browser?.close();
  if (server && server.exitCode === null) {
    const exited = once(server, "exit");
    server.kill();
    await exited;
  }
  if (
    path.dirname(root) === os.tmpdir() &&
    path.basename(root).startsWith("ironclad-instances-ui-")
  )
    await fs.rm(root, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 50,
    });
}
