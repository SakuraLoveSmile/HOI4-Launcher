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
const origin = "http://127.0.0.1:4187";
const output = path.resolve("test-results/playsets");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "ironclad-playsets-ui-"));
const errors = [],
  externalRequests = [],
  environmentRequests = [];
const checks = [];
let browser, page, server;
const check = (condition, message) => {
  assert.ok(condition, message);
  checks.push(message);
  console.log(`PASS ${message}`);
};
const until = async (predicate, message) => {
  const deadline = Date.now() + 10000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

try {
  await fs.mkdir(output, { recursive: true });
  const game = path.join(root, "game");
  const userData = path.join(root, "Paradox Interactive", "Hearts of Iron IV");
  const modDirectory = path.join(userData, "mod");
  const settingsPath = path.join(root, "settings.json");
  const write = async (file, data) => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, data);
  };
  await write(path.join(game, "hoi4.exe"), "Fixture only; never executable");
  await write(
    path.join(game, "launcher-settings.json"),
    '{"rawVersion":"1.19.4.0"}',
  );
  const names = {
    alpha: "Alpha 战役",
    beta: "Beta 图形",
    gamma: "Gamma 音乐",
    delta: "Delta 翻译",
  };
  const descriptors = new Map();
  for (const [key, name] of Object.entries(names)) {
    const content =
      `name="${name}"\npath="mod/${key}"\nsupported_version="1.19.*"\nversion="1.0"\n` +
      (key === "alpha"
        ? 'dependencies={"Beta 图形" "The Road to 56" "Kaiserreich"}\n'
        : "");
    const descriptor = path.join(modDirectory, `${key}.mod`);
    await write(descriptor, content);
    await write(
      path.join(modDirectory, key, "fixture.txt"),
      `${key} original content`,
    );
    descriptors.set(descriptor, content);
  }
  const options = {
    settingsPath,
    documentsPath: root,
    steamRoots: [],
    processProbe: async () => null,
    spawnProcess: () => {
      throw new Error("Playset UI tests must not launch a game");
    },
  };
  let launcher = createLauncherService(options);
  let failSave = false;
  await launcher.saveSettings({
    gameDirectory: game,
    activePlaysetId: "default",
    playsets: [
      {
        id: "default",
        name: "原版扩展",
        modOrder: ["local:alpha.mod", "local:beta.mod"],
        modIds: ["local:alpha.mod"],
        disabledDlcIds: [],
      },
      {
        id: "other",
        name: "另一战役",
        modOrder: [],
        modIds: [],
        disabledDlcIds: null,
      },
    ],
  });
  const api = {
    getState: () => launcher.getState(),
    getLaunchStatus: () => launcher.getLaunchStatus(),
    getModThumbnail: (id) => launcher.getModThumbnail(id),
    saveSettings: (patch) => {
      if (failSave) throw new Error("隔离测试：保存失败，请重试。");
      return launcher.saveSettings(patch);
    },
    getNews: async () => ({ items: [], source: "fixture" }),
    getPdxStorageState: async () => ({ storage: {}, busy: false, job: null }),
    getSteamMissingMods: async () => ({ job: null, plan: null }),
  };
  server = spawn(
    process.execPath,
    [
      "node_modules/vite/bin/vite.js",
      "preview",
      "--host",
      "127.0.0.1",
      "--port",
      "4187",
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
    return serverLog.includes("127.0.0.1:4187");
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

  const library = page.getByRole("region", { name: "已识别模组", exact: true });
  const members = page.getByRole("region", {
    name: "当前播放集模组",
    exact: true,
  });
  const selector = page.getByLabel("编辑模组播放集", { exact: true });
  const librarySearch = page.getByRole("textbox", {
    name: "搜索模组",
    exact: true,
  });
  const memberSearch = page.getByRole("textbox", {
    name: "搜索当前播放集",
    exact: true,
  });
  const active = async () => {
    const { settings } = await launcher.getState();
    return settings.playsets.find(
      (item) => item.id === settings.activePlaysetId,
    );
  };
  const settled = async () => {
    await until(
      async () => !(await selector.isDisabled()),
      "playset save settles",
    );
  };
  const openMods = async () => {
    await page.getByRole("button", { name: /^模组管理/ }).click();
    await members.waitFor();
    await settled();
  };
  const choose = async (id) => {
    await selector.selectOption(id);
    await until(
      async () => (await active()).id === id,
      "playset switch persists",
    );
    await settled();
  };
  const add = async (key) => {
    await library
      .getByRole("button", { name: `加入播放集 ${names[key]}`, exact: true })
      .click();
    await members.locator(`[data-mod-id="local:${key}.mod"]`).waitFor();
    await settled();
  };
  const order = () =>
    members
      .locator(".mod-row")
      .evaluateAll((rows) => rows.map((row) => row.dataset.modId));

  await page.goto(origin);
  check(
    (await page.getByText("依赖未启用", { exact: true }).count()) === 0,
    "overview does not report load-order references as disabled dependencies",
  );
  await openMods();
  check(
    (await library.locator(".mod-row").count()) === 4 &&
      (await members.locator(".mod-row").count()) === 2,
    "library and playset members appear together",
  );
  check(
    await library
      .getByRole("button", { name: `已在播放集 ${names.beta}`, exact: true })
      .isDisabled(),
    "disabled members cannot be added twice",
  );
  check(
    (await members
      .getByRole("switch", { name: `启用 ${names.beta}`, exact: true })
      .getAttribute("aria-checked")) === "false",
    "disabled member remains visible in playset",
  );
  check(
    (await page.getByText("依赖未启用", { exact: true }).count()) === 0,
    "disabled and absent load-order references do not create dependency warnings in either column",
  );
  await members.getByRole("button", { name: names.alpha, exact: true }).click();
  const detail = page.getByRole("dialog");
  check(
    (await detail.getByText("加载顺序参考", { exact: true }).isVisible()) &&
      (await detail
        .getByText("Beta 图形、The Road to 56、Kaiserreich", { exact: true })
        .isVisible()),
    "mod details preserve the author's load-order declarations",
  );
  check(
    (await detail
      .getByText(
        "此列表可能包含排序或兼容关系，不代表全部都必须启用。必需前置请核对作者说明。",
        { exact: true },
      )
      .isVisible()) && (await detail.locator(".inline-note").count()) === 0,
    "mod details explain declarations without presenting an unverified prerequisite warning",
  );
  await page.screenshot({
    path: path.join(output, "load-order-detail.png"),
    fullPage: true,
  });
  await detail.getByRole("button", { name: "关闭对话框", exact: true }).click();
  await detail.waitFor({ state: "hidden" });
  await members.getByRole("button", { name: names.beta, exact: true }).click();
  check(
    (await detail.getByText("未声明加载顺序", { exact: true }).isVisible()) &&
      (await detail.locator(".modal-description").count()) === 0,
    "empty declarations do not claim that a mod has no required prerequisites",
  );
  await detail.getByRole("button", { name: "关闭对话框", exact: true }).click();
  await detail.waitFor({ state: "hidden" });
  await librarySearch.fill("Gamma");
  check(
    (await library.locator(".mod-row").count()) === 1 &&
      (await members.locator(".mod-row").count()) === 2,
    "library search does not filter playset members",
  );
  await memberSearch.fill("Beta");
  check(
    (await library.locator(".mod-row").count()) === 1 &&
      (await members.locator(".mod-row").count()) === 1,
    "member search is independent from library search",
  );
  await librarySearch.fill("");
  await memberSearch.fill("");
  await add("gamma");
  check(
    (await active()).modIds.includes("local:gamma.mod"),
    "adding a mod enables and persists it",
  );
  await members
    .getByRole("switch", { name: `停用 ${names.gamma}`, exact: true })
    .click();
  await members
    .getByRole("switch", { name: `启用 ${names.gamma}`, exact: true })
    .waitFor();
  await settled();
  check(
    (await active()).modOrder.includes("local:gamma.mod") &&
      !(await active()).modIds.includes("local:gamma.mod"),
    "disabling retains membership and order on disk",
  );
  await members
    .getByRole("button", { name: `上移 ${names.beta}`, exact: true })
    .click();
  await until(
    async () => (await order())[0] === "local:beta.mod",
    "load order move",
  );
  await settled();
  assert.deepEqual((await active()).modOrder, [
    "local:beta.mod",
    "local:alpha.mod",
    "local:gamma.mod",
  ]);
  check(
    true,
    "moving a disabled member preserves all members and enabled subset",
  );

  const memberRow = (key) =>
    members.locator(`[data-mod-id="local:${key}.mod"]`);
  await memberRow("gamma").dragTo(memberRow("beta"), {
    sourcePosition: { x: 8, y: 12 },
    targetPosition: { x: 8, y: 12 },
  });
  await until(
    async () => (await order())[0] === "local:gamma.mod",
    "dragging the last member to the first position",
  );
  await settled();
  assert.deepEqual((await active()).modOrder, [
    "local:gamma.mod",
    "local:beta.mod",
    "local:alpha.mod",
  ]);
  assert.deepEqual((await active()).modIds, ["local:alpha.mod"]);
  check(
    true,
    "real row drag persists the full load order without enabling disabled members",
  );

  await memberSearch.fill("Beta");
  assert.deepEqual(await order(), ["local:beta.mod"]);
  await members
    .getByRole("button", { name: `上移 ${names.beta}`, exact: true })
    .click();
  await until(
    async () => (await active()).modOrder[0] === "local:beta.mod",
    "filtered arrow movement uses full load order",
  );
  await settled();
  assert.deepEqual((await active()).modOrder, [
    "local:beta.mod",
    "local:gamma.mod",
    "local:alpha.mod",
  ]);
  assert.deepEqual((await active()).modIds, ["local:alpha.mod"]);
  await memberSearch.fill("");
  assert.deepEqual(await order(), (await active()).modOrder);
  check(
    true,
    "arrow movement with one visible result reorders the full list and preserves hidden members",
  );

  await memberRow("gamma").dragTo(memberRow("alpha"), {
    sourcePosition: { x: 8, y: 12 },
    targetPosition: { x: 8, y: 12 },
  });
  await until(
    async () => (await order())[2] === "local:gamma.mod",
    "dragging a member downward",
  );
  await settled();
  assert.deepEqual((await active()).modOrder, [
    "local:beta.mod",
    "local:alpha.mod",
    "local:gamma.mod",
  ]);
  check(true, "downward drag places the member at the target position");

  const beforeDensity = await fs.readFile(settingsPath, "utf8");
  const ordinaryHeight = await memberRow("beta").evaluate(
    (row) => row.getBoundingClientRect().height,
  );
  const density = page.getByRole("button", { name: "简化显示", exact: true });
  await density.click();
  assert.equal(await density.getAttribute("aria-pressed"), "true");
  check(
    (await memberRow("beta").evaluate(
      (row) => row.getBoundingClientRect().height,
    )) < ordinaryHeight,
    "simplified display reduces member row height",
  );
  await density.click();
  assert.equal(await density.getAttribute("aria-pressed"), "false");
  assert.equal(await fs.readFile(settingsPath, "utf8"), beforeDensity);
  check(true, "display density toggles leave persisted playset data unchanged");

  await page
    .getByRole("button", { name: "复制当前播放集", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "播放集名称", exact: true })
    .fill("复制战役");
  await page.getByRole("button", { name: "创建播放集", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await settled();
  const copied = await active();
  check(
    copied.id !== "default" && copied.name === "复制战役",
    "copy creates and selects an independent playset",
  );
  assert.deepEqual(copied.modOrder, [
    "local:beta.mod",
    "local:alpha.mod",
    "local:gamma.mod",
  ]);
  assert.deepEqual(copied.modIds, ["local:alpha.mod"]);
  assert.deepEqual(copied.disabledDlcIds, []);
  check(true, "copy preserves disabled members, order and DLC selection");
  await choose("other");
  await until(
    async () => (await members.locator(".mod-row").count()) === 0,
    "empty other playset",
  );
  check(
    (await library.locator(".mod-row").count()) === 4,
    "empty playset keeps library available",
  );
  await add("delta");
  await choose(copied.id);
  assert.deepEqual((await active()).modOrder, copied.modOrder);
  check(true, "changes in another playset do not affect the copy");

  launcher = createLauncherService(options);
  await page.reload();
  await openMods();
  check(
    (await active()).id === copied.id,
    "selected playset survives service and page restart",
  );
  assert.deepEqual(await order(), copied.modOrder);
  check(
    (await members
      .getByRole("switch", { name: `启用 ${names.beta}`, exact: true })
      .getAttribute("aria-checked")) === "false",
    "member order and disabled state survive restart",
  );
  await choose("default");
  await members
    .getByRole("button", { name: `从播放集移除 ${names.gamma}`, exact: true })
    .click();
  await members
    .locator('[data-mod-id="local:gamma.mod"]')
    .waitFor({ state: "hidden" });
  await settled();
  check(
    !(await active()).modOrder.includes("local:gamma.mod"),
    "remove deletes only the selected playset membership",
  );
  check(
    await library
      .getByRole("button", { name: `加入播放集 ${names.gamma}`, exact: true })
      .isEnabled(),
    "removed member can be added from library again",
  );
  check(
    (await fs.readFile(
      path.join(modDirectory, "gamma", "fixture.txt"),
      "utf8",
    )) === "gamma original content",
    "removing a member keeps installed mod files",
  );
  const persisted = await fs.readFile(settingsPath, "utf8");
  failSave = true;
  await library
    .getByRole("button", { name: `加入播放集 ${names.delta}`, exact: true })
    .click();
  await page
    .getByRole("alert")
    .filter({ hasText: "隔离测试：保存失败，请重试。" })
    .waitFor();
  await settled();
  check(
    (await members.locator('[data-mod-id="local:delta.mod"]').count()) === 0,
    "failed save does not show a falsely added member",
  );
  check(
    (await fs.readFile(settingsPath, "utf8")) === persisted,
    "failed save preserves persisted settings",
  );
  failSave = false;
  await add("delta");
  check(
    (await active()).modOrder.includes("local:delta.mod"),
    "save can be retried successfully after a failure",
  );

  await page.getByRole("button", { name: "新建播放集", exact: true }).click();
  await page
    .getByRole("textbox", { name: "播放集名称", exact: true })
    .fill("新空集");
  await page.getByRole("button", { name: "创建播放集", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await settled();
  const created = await active();
  check(
    created.name === "新空集" && created.modOrder.length === 0,
    "new playset starts empty without copying implicitly",
  );
  await librarySearch.fill("Alpha");
  await library
    .getByRole("button", { name: "加入筛选结果", exact: true })
    .click();
  await members.locator('[data-mod-id="local:alpha.mod"]').waitFor();
  await settled();
  assert.deepEqual((await active()).modOrder, ["local:alpha.mod"]);
  check(true, "bulk add affects only matching library mods");
  await librarySearch.fill("");
  await add("beta");
  await members.getByRole("button", { name: "全部停用", exact: true }).click();
  await until(async () => (await active()).modIds.length === 0, "bulk disable");
  await settled();
  await memberSearch.fill("Beta");
  await members
    .getByRole("button", { name: "启用筛选结果", exact: true })
    .click();
  await until(
    async () => (await active()).modIds.length === 1,
    "filtered bulk enable",
  );
  await settled();
  assert.deepEqual((await active()).modIds, ["local:beta.mod"]);
  check(
    (await active()).modOrder.length === 2,
    "filtered bulk enable retains other disabled members",
  );
  await memberSearch.fill("");

  await page
    .getByRole("button", { name: "重命名当前播放集", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "播放集名称", exact: true })
    .fill("重命名战役");
  await page.getByRole("button", { name: "保存名称", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  check(
    (await active()).name === "重命名战役",
    "rename persists without changing membership",
  );
  await page.screenshot({
    path: path.join(output, "playsets-desktop.png"),
    fullPage: true,
    animations: "disabled",
  });
  await page.setViewportSize({ width: 1000, height: 740 });
  check(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    "1000px desktop has no horizontal overflow",
  );
  check(
    (await library.isVisible()) && (await members.isVisible()),
    "both playset panels remain available at minimum desktop size",
  );
  await page.screenshot({
    path: path.join(output, "playsets-compact.png"),
    fullPage: true,
    animations: "disabled",
  });

  await page
    .getByRole("button", { name: "删除当前播放集", exact: true })
    .click();
  await page.getByRole("button", { name: "删除播放集", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  const final = await launcher.getState();
  check(
    !final.settings.playsets.some((item) => item.id === created.id) &&
      final.settings.playsets.some(
        (item) => item.id === final.settings.activePlaysetId,
      ),
    "delete chooses an existing playset and preserves others",
  );
  for (const [file, content] of descriptors)
    assert.equal(await fs.readFile(file, "utf8"), content);
  check(
    true,
    "playset operations leave all original mod descriptors unchanged",
  );
  await assert.rejects(fs.stat(path.join(userData, "dlc_load.json")), {
    code: "ENOENT",
  });
  check(true, "editing playsets does not write game load configuration");
  assert.deepEqual(errors, []);
  assert.deepEqual(externalRequests, []);
  check(
    true,
    "no renderer errors or application requests outside the isolated server",
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
  console.log(`Playset UI: ${checks.length} checks passed`);
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
  // mkdtemp owns this exact directory; never remove a user-selected path.
  if (
    path.dirname(root) === os.tmpdir() &&
    path.basename(root).startsWith("ironclad-playsets-ui-")
  ) {
    await fs.rm(root, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 50,
    });
  }
}
