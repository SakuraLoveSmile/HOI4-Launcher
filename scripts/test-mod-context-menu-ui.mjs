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
const origin = "http://127.0.0.1:4199";
const output = path.resolve("test-results/mod-context-menu");
const root = await fs.mkdtemp(
  path.join(os.tmpdir(), "ironclad-mod-context-ui-"),
);
const checks = [],
  errors = [],
  externalRequests = [],
  environmentRequests = [];
const calls = {
  copied: [],
  folders: [],
  pages: [],
  updates: [],
  lookups: [],
  deleted: [],
};
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
  const game = path.join(root, "game");
  const settingsPath = path.join(root, "app", "settings.json");
  const userData = path.join(root, "Paradox Interactive", "Hearts of Iron IV");
  const modRoot = path.join(userData, "mod"),
    steamRoot = path.join(root, "steam");
  const write = async (file, text) => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text);
  };
  await write(path.join(game, "hoi4.exe"), "Inert UI fixture; never execute");
  await write(
    path.join(game, "launcher-settings.json"),
    '{"rawVersion":"1.19.4"}',
  );
  const ids = {
    workshop: "workshop:1234567890",
    manual: "workshop:2234567890",
    local: "local:local.mod",
    dependent: "local:dependent.mod",
    deleting: "local:delete.mod",
    unsafe: "local:unsafe.mod",
    pdx: "pdx:456",
    project: "project:fixture-context",
  };
  const originalDescriptors = new Map();
  const registerLocal = async (
    filename,
    name,
    { content, extra = "", directory = userData } = {},
  ) => {
    const registration = path.join(directory, "mod", `${filename}.mod`);
    const target = content || path.join(directory, "mod", filename);
    const text = `name="${name}"\npath="${target.replaceAll("\\", "/")}"\nsupported_version="1.19.*"\n${extra}`;
    await write(registration, text);
    await write(path.join(target, "sentinel.txt"), `${name} original content`);
    originalDescriptors.set(registration, text);
    return { registration, target };
  };
  const local = await registerLocal("local", "Local Original");
  await registerLocal("dependent", "Dependent Original", {
    extra: 'dependencies={"Local Original"}\n',
  });
  const deleting = await registerLocal("delete", "Delete Candidate");
  const unsafe = await registerLocal("unsafe", "Unsafe External", {
    content: path.join(root, "external-mod"),
  });
  await registerLocal("pdx_456", "Unmanaged PDX");
  const project = await registerLocal("project", "Project Candidate");
  const workshopDescriptors = new Map();
  for (const [id, name] of [
    ["1234567890", "Workshop Original"],
    ["2234567890", "English Only Workshop"],
  ]) {
    const descriptor = path.join(
      steamRoot,
      "steamapps",
      "workshop",
      "content",
      "394360",
      id,
      "descriptor.mod",
    );
    const text = `name="${name}"\nsupported_version="1.19.*"\n`;
    await write(descriptor, text);
    workshopDescriptors.set(descriptor, text);
  }
  let running = false;
  const options = {
    settingsPath,
    documentsPath: root,
    steamRoots: [steamRoot],
    processProbe: async () => (running ? { pid: 13579 } : null),
    spawnProcess: () => {
      throw new Error("Context-menu UI tests must never start a game");
    },
    getModProjects: async () => [
      {
        id: "context-project",
        modId: ids.project,
        name: "Project Candidate",
        userData,
        descriptorPath: project.registration,
        workPath: project.target,
        snapshots: [],
      },
    ],
  };
  let launcher = createLauncherService(options);
  await launcher.saveSettings({
    gameDirectory: game,
    activePlaysetId: "default",
    playsets: [
      {
        id: "default",
        name: "当前战役",
        modIds: [
          ids.workshop,
          ids.manual,
          ids.local,
          ids.dependent,
          ids.deleting,
        ],
        modReferences: [
          {
            id: ids.deleting,
            name: "Delete Candidate",
            source: "local",
            remoteId: null,
          },
        ],
      },
      {
        id: "other",
        name: "另一战役",
        modIds: [ids.local, ids.deleting],
        modReferences: [
          {
            id: ids.deleting,
            name: "Delete Candidate",
            source: "local",
            remoteId: null,
          },
        ],
      },
    ],
  });
  const isolated = await launcher.createGameInstance({
    name: "另一独立版本",
    gameDirectory: game,
  });
  const isolatedId = isolated.settings.activeGameInstanceId;
  const isolatedDelete = await registerLocal(
    "delete",
    "Isolated Delete Candidate",
    { directory: isolated.paths.userData },
  );
  await launcher.saveSettings({
    playsets: [
      { id: "default", name: "独立战役", modIds: [ids.workshop, ids.deleting] },
    ],
  });
  await launcher.switchGameInstance("default");
  const readMod = async (id) => {
    const state = await launcher.getState();
    const mod = state.mods.find((item) => item.id === id);
    assert.ok(mod, `Unknown fixture mod: ${id}`);
    return { state, mod };
  };
  const api = {
    getState: () => launcher.getState(),
    getLaunchStatus: () => launcher.getLaunchStatus(),
    getModThumbnail: (id) => launcher.getModThumbnail(id),
    saveSettings: (patch) => launcher.saveSettings(patch),
    switchGameInstance: (id) => launcher.switchGameInstance(id),
    setModDisplayName: (input) => launcher.setModDisplayName(input),
    resetModDisplayName: (id) => launcher.resetModDisplayName(id),
    getLocalizedModName: async (id) => {
      const { mod } = await readMod(id);
      if (mod.source !== "workshop") return { name: null };
      calls.lookups.push({ id: mod.remoteId, language: "schinese" });
      return { name: id === ids.workshop ? "工坊已有中文标题" : null };
    },
    copyText: async (text) => {
      calls.copied.push(text);
      return true;
    },
    openModFolder: async (id) => {
      await readMod(id);
      calls.folders.push(id);
      return true;
    },
    openModPage: async (id) => {
      await readMod(id);
      calls.pages.push(id);
      return true;
    },
    updateMod: async (id) => {
      assert.equal(running, false);
      const { state, mod } = await readMod(id);
      assert.ok(["workshop", "pdx"].includes(mod.source));
      calls.updates.push({ id, source: mod.source, remoteId: mod.remoteId });
      return { state };
    },
    createModProject: async () => {
      throw new Error("Project creation is verified by the project UI suite");
    },
    deleteMod: async (id) => {
      assert.equal(running, false);
      const { mod } = await readMod(id);
      assert.equal(mod.source, "local");
      const result = await launcher.removeLocalMod(id);
      calls.deleted.push({ id, backupDirectory: result.backupDirectory });
      return result;
    },
    getNews: async () => ({ items: [], source: "fixture" }),
    getPdxStorageState: async () => ({
      storage: { location: "Isolated fixture", isDefault: true },
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
      "4199",
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
    return serverLog.includes("127.0.0.1:4199");
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
  const library = page.locator(".playset-library"),
    members = page.locator(".playset-members");
  const menu = page.getByRole("menu");
  const row = (id, member = false) =>
    (member ? members : library).locator(`[data-mod-id="${id}"]`);
  const state = () => launcher.getState();
  const modState = async (id) =>
    (await state()).mods.find((mod) => mod.id === id);
  const settled = async () =>
    until(
      async () =>
        !(await page
          .getByLabel("编辑模组播放集", { exact: true })
          .isDisabled()),
      "mutation settles",
    );
  const openMods = async () => {
    await page.locator("nav .nav-item").nth(1).click();
    await library.waitFor();
  };
  const openMenu = async (id, member = false) => {
    await row(id, member).scrollIntoViewIfNeeded();
    await row(id, member).focus();
    await row(id, member).click({
      button: "right",
      position: { x: 70, y: 20 },
    });
    await menu.waitFor();
    await until(
      async () => (await menu.boundingBox()).x > 0,
      "menu position settles",
    );
  };
  const closeMenu = async () => {
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "hidden" });
  };
  const chooseAction = async (label) => {
    await menu.getByRole("menuitem", { name: label, exact: true }).click();
  };
  const rename = async (id, name) => {
    await openMenu(id);
    await chooseAction("修改显示名称");
    await page
      .getByRole("textbox", { name: "显示名称", exact: true })
      .fill(name);
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "保存名称", exact: true })
      .click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    await settled();
  };
  const switchInstance = async (id) => {
    await page.locator("nav .nav-item").nth(0).click();
    await page.getByLabel("当前游戏版本", { exact: true }).selectOption(id);
    await until(
      async () => (await state()).settings.activeGameInstanceId === id,
      "instance switch",
    );
    await until(
      async () =>
        !(await page.getByLabel("当前游戏版本", { exact: true }).isDisabled()),
      "instance switch settles",
    );
    await openMods();
  };
  const withinViewport = async () =>
    menu.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return (
        rect.left >= 0 &&
        rect.top >= 0 &&
        rect.right <= innerWidth &&
        rect.bottom <= innerHeight
      );
    });

  await page.goto(origin);
  await openMods();
  await settled();
  const labels = [
    "修改显示名称",
    "汉化名称并记住",
    "恢复原名称",
    "复制模组 ID",
    "打开模组目录",
    "打开工坊页面",
    "更新模组",
    "创建二改项目",
    "移出当前播放集",
    "删除模组",
  ];
  for (const member of [false, true]) {
    await openMenu(ids.workshop, member);
    assert.deepEqual(
      await menu.getByRole("menuitem").allTextContents(),
      labels,
    );
    assert.match(await menu.locator("small").textContent(), /1234567890/);
    check(
      true,
      `${member ? "member" : "library"} right-click exposes all ten actions and the exact source ID`,
    );
    await closeMenu();
  }
  await row(ids.workshop).focus();
  await row(ids.workshop).press("ContextMenu");
  await menu.waitFor();
  assert.equal(
    await menu
      .getByRole("menuitem")
      .first()
      .evaluate((el) => el === document.activeElement),
    true,
  );
  await page.keyboard.press("ArrowDown");
  assert.equal(
    await menu
      .getByRole("menuitem", { name: "汉化名称并记住", exact: true })
      .evaluate((el) => el === document.activeElement),
    true,
  );
  await page.keyboard.press("ArrowUp");
  assert.equal(
    await menu
      .getByRole("menuitem")
      .first()
      .evaluate((el) => el === document.activeElement),
    true,
  );
  await closeMenu();
  check(
    await row(ids.workshop).evaluate((el) => el === document.activeElement),
    "ContextMenu key, arrow navigation and Escape restore focus to the originating row",
  );
  await row(ids.workshop, true).focus();
  await row(ids.workshop, true).press("Shift+F10");
  await menu.waitFor();
  await closeMenu();
  check(
    await row(ids.workshop, true).evaluate(
      (el) => el === document.activeElement,
    ),
    "Shift+F10 opens the member menu and restores focus after closing",
  );
  await row(ids.workshop).dispatchEvent("contextmenu", {
    clientX: 1438,
    clientY: 978,
    bubbles: true,
  });
  await menu.waitFor();
  await until(withinViewport, "bottom-right menu clamps inside viewport");
  check(
    true,
    "menu opened at the bottom-right edge remains fully inside the viewport",
  );
  await closeMenu();

  await rename(ids.local, "前线工具别名");
  check(
    (await modState(ids.local)).name === "前线工具别名" &&
      (await modState(ids.local)).originalName === "Local Original",
    "custom naming changes presentation while retaining the source name",
  );
  const search = page.getByRole("textbox", { name: "搜索模组", exact: true });
  await search.fill("前线工具别名");
  check(
    (await library.locator(".mod-row").count()) === 1 &&
      (await row(ids.local).isVisible()),
    "library search matches the remembered display name",
  );
  await search.fill("Local Original");
  check(
    (await library.locator(".mod-row").count()) === 1 &&
      (await row(ids.local).isVisible()),
    "source-name search still finds a mod after its display name changes",
  );
  await search.fill("1234567890");
  check(
    (await library.locator(".mod-row").count()) === 1 &&
      (await row(ids.workshop).isVisible()),
    "numeric source-ID search finds the matching Workshop registration",
  );
  assert.deepEqual((await modState(ids.dependent)).missingDependencies, []);
  assert.deepEqual((await modState(ids.dependent)).dependencies, [
    "Local Original",
  ]);
  check(
    true,
    "load-order declarations retain source names after a display alias is applied",
  );
  await search.fill("");
  launcher = createLauncherService(options);
  await page.reload();
  await openMods();
  check(
    await row(ids.local)
      .getByRole("button", { name: "前线工具别名", exact: true })
      .isVisible(),
    "custom display names survive service and renderer restart",
  );
  assert.equal(
    await fs.readFile(local.registration, "utf8"),
    originalDescriptors.get(local.registration),
  );
  check(
    true,
    "renaming leaves the registered mod descriptor byte-for-byte intact",
  );
  await rename(ids.workshop, "默认工坊别名");
  await switchInstance(isolatedId);
  check(
    (await modState(ids.workshop)).name === "Workshop Original",
    "a separate game instance starts without another instance's alias",
  );
  await rename(ids.workshop, "独立版专属名称");
  await switchInstance("default");
  check(
    (await modState(ids.workshop)).name === "默认工坊别名",
    "switching back restores the original instance's independent alias",
  );

  await openMenu(ids.workshop);
  await chooseAction("汉化名称并记住");
  const nameInput = page.getByRole("textbox", {
    name: "显示名称",
    exact: true,
  });
  await until(
    async () =>
      !(await nameInput.isDisabled()) &&
      (await nameInput.inputValue()) === "工坊已有中文标题",
    "Chinese Steam title prefills",
  );
  check(
    calls.lookups.at(-1).id === "1234567890" &&
      calls.lookups.at(-1).language === "schinese",
    "translation action reads an existing Chinese Steam title using the source ID",
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "保存名称", exact: true })
    .click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await settled();
  check(
    (await modState(ids.workshop)).name === "工坊已有中文标题" &&
      (await modState(ids.workshop)).displayNameKind === "translated",
    "reviewed Chinese titles persist as remembered translated display names",
  );
  await openMenu(ids.manual);
  await chooseAction("汉化名称并记住");
  await until(
    async () => !(await nameInput.isDisabled()),
    "no-title lookup settles",
  );
  check(
    (await nameInput.inputValue()) === "",
    "a mod without an existing Chinese title offers a blank editable name",
  );
  await nameInput.fill("手动记住的中文名");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "保存名称", exact: true })
    .click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await settled();
  launcher = createLauncherService(options);
  await page.reload();
  await openMods();
  check(
    (await modState(ids.manual)).name === "手动记住的中文名",
    "manually entered Chinese display names persist across restart",
  );
  await openMenu(ids.manual);
  await chooseAction("汉化名称并记住");
  await until(
    async () => !(await nameInput.isDisabled()),
    "remembered title lookup settles",
  );
  check(
    (await nameInput.inputValue()) === "手动记住的中文名",
    "a later lookup without a Chinese title retains the remembered manual name",
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "取消", exact: true })
    .click();
  await openMenu(ids.workshop);
  await chooseAction("恢复原名称");
  await menu.waitFor({ state: "hidden" });
  await settled();
  check(
    (await modState(ids.workshop)).name === "Workshop Original" &&
      (await modState(ids.workshop)).displayNameKind === null,
    "restore action removes the remembered alias and shows the source name",
  );

  for (const id of [ids.workshop, ids.local]) {
    await openMenu(id);
    await chooseAction("复制模组 ID");
    await menu.waitFor({ state: "hidden" });
    await settled();
  }
  assert.deepEqual(calls.copied, ["1234567890", ids.local]);
  check(true, "copy uses the exact numeric Workshop ID and full local ID");
  await openMenu(ids.local);
  await chooseAction("打开模组目录");
  await menu.waitFor({ state: "hidden" });
  await settled();
  for (const [id, label] of [
    [ids.workshop, "打开工坊页面"],
    [ids.pdx, "打开模组来源页"],
  ]) {
    await openMenu(id);
    await chooseAction(label);
    await menu.waitFor({ state: "hidden" });
    await settled();
  }
  assert.deepEqual(calls.folders, [ids.local]);
  assert.deepEqual(calls.pages, [ids.workshop, ids.pdx]);
  check(
    true,
    "folder and source-page actions route backend mod IDs without exposing arbitrary paths",
  );
  for (const id of [ids.workshop, ids.pdx]) {
    await openMenu(id);
    await chooseAction("更新模组");
    await menu.waitFor({ state: "hidden" });
    await settled();
  }
  assert.deepEqual(calls.updates, [
    { id: ids.workshop, source: "workshop", remoteId: "1234567890" },
    { id: ids.pdx, source: "pdx", remoteId: "456" },
  ]);
  check(
    true,
    "update actions identify the correct Workshop and Paradox source requests",
  );
  for (const id of [ids.unsafe, ids.project, ids.pdx]) {
    await openMenu(id);
    check(
      await menu
        .getByRole("menuitem", { name: "删除模组", exact: true })
        .isDisabled(),
      `unsafe or unmanaged deletion is disabled for ${id}`,
    );
    await closeMenu();
  }
  await openMenu(ids.local);
  check(
    (await menu
      .getByRole("menuitem", { name: "更新模组", exact: true })
      .isDisabled()) &&
      (await menu
        .getByRole("menuitem", { name: "打开工坊页面", exact: true })
        .isDisabled()),
    "local mods disable online update and Workshop-page actions",
  );
  check(
    !(await menu
      .getByRole("menuitem", { name: "创建二改项目", exact: true })
      .isDisabled()),
    "installed local mods allow independent project creation",
  );
  await closeMenu();
  await openMenu(ids.project);
  check(
    await menu
      .getByRole("menuitem", { name: "创建二改项目", exact: true })
      .isDisabled(),
    "existing projects cannot be copied through the original-mod creation entry",
  );
  await closeMenu();
  running = true;
  await page.locator(".refresh-button").click();
  await until(
    async () => (await state()).launchStatus.running,
    "running game state",
  );
  await openMenu(ids.workshop);
  check(
    (await menu
      .getByRole("menuitem", { name: "更新模组", exact: true })
      .isDisabled()) &&
      (await menu
        .getByRole("menuitem", { name: "删除模组", exact: true })
        .isDisabled()) &&
      (await menu
        .getByRole("menuitem", { name: "创建二改项目", exact: true })
        .isDisabled()),
    "a running game disables update, deletion and project creation actions",
  );
  await closeMenu();
  running = false;
  await page.locator(".refresh-button").click();
  await settled();

  await openMenu(ids.local, true);
  await chooseAction("移出当前播放集");
  await menu.waitFor({ state: "hidden" });
  await settled();
  const removedMember = (await state()).settings;
  check(
    !removedMember.playsets
      .find((item) => item.id === "default")
      .modOrder.includes(ids.local) &&
      removedMember.playsets
        .find((item) => item.id === "other")
        .modOrder.includes(ids.local),
    "remove-from-playset changes only the active playset membership",
  );
  check(
    (await row(ids.local).isVisible()) &&
      (await fs.readFile(path.join(local.target, "sentinel.txt"), "utf8")) ===
        "Local Original original content",
    "removing a member preserves its library registration and local files",
  );
  await openMenu(ids.deleting);
  await chooseAction("删除模组");
  check(
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "确认删除模组", exact: true })
      .isVisible(),
    "local deletion requires a separate confirmation dialog",
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "取消", exact: true })
    .click();
  check(
    calls.deleted.length === 0 && (await row(ids.deleting).isVisible()),
    "cancelling deletion leaves files and playset memberships intact",
  );
  await openMenu(ids.deleting);
  await chooseAction("删除模组");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "确认删除模组", exact: true })
    .click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await settled();
  const deletedState = await state(),
    recycle = calls.deleted[0].backupDirectory;
  check(
    !deletedState.mods.some((mod) => mod.id === ids.deleting) &&
      deletedState.settings.playsets.every(
        (item) =>
          !item.modOrder.includes(ids.deleting) &&
          !item.modIds.includes(ids.deleting) &&
          !item.modReferences.some((ref) => ref.id === ids.deleting),
      ),
    "confirmed local deletion removes the installed row and every current-instance playset reference",
  );
  check(
    (await fs.readFile(
      path.join(recycle, "content", "sentinel.txt"),
      "utf8",
    )) === "Delete Candidate original content" &&
      (await fs.readFile(path.join(recycle, "registration.mod"), "utf8")) ===
        originalDescriptors.get(deleting.registration),
    "real local deletion preserves exact mod content and registration in the recovery directory",
  );
  check(
    deletedState.settings.gameInstances
      .find((item) => item.id === isolatedId)
      .playsets[0].modIds.includes(ids.deleting) &&
      (await fs.readFile(
        path.join(isolatedDelete.target, "sentinel.txt"),
        "utf8",
      )) === "Isolated Delete Candidate original content",
    "deletion keeps another instance's same-ID membership and installed files",
  );

  if (await page.locator(".toast button").count())
    await page.locator(".toast button").click();
  await openMenu(ids.workshop);
  await page.screenshot({
    path: path.join(output, "context-zh-hans.png"),
    animations: "disabled",
  });
  check(
    await menu.isVisible(),
    "Chinese screenshot captures the open context menu without resizing the viewport",
  );
  await closeMenu();
  await page.locator("nav .nav-item").last().click();
  await page.getByLabel("界面语言", { exact: true }).selectOption("en");
  await page.getByLabel("Interface language", { exact: true }).waitFor();
  await openMods();
  if (await page.locator(".toast button").count())
    await page.locator(".toast button").click();
  await openMenu(ids.workshop);
  check(
    await menu
      .getByRole("menuitem", { name: "Copy mod ID", exact: true })
      .isVisible(),
    "context actions follow the selected English interface language",
  );
  await page.screenshot({
    path: path.join(output, "context-en.png"),
    animations: "disabled",
  });
  check(
    await menu.isVisible(),
    "English screenshot retains the open context menu",
  );
  await closeMenu();
  await page.setViewportSize({ width: 1000, height: 740 });
  await openMenu(ids.workshop);
  await until(withinViewport, "1000px menu fits viewport");
  check(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    "1000px workspace and its context menu have no horizontal overflow",
  );
  await page.screenshot({
    path: path.join(output, "context-1000px.png"),
    animations: "disabled",
  });
  check(
    await menu.isVisible(),
    "1000px screenshot retains the open context menu within its viewport",
  );
  await closeMenu();
  for (const [file, text] of workshopDescriptors)
    assert.equal(await fs.readFile(file, "utf8"), text);
  assert.equal(
    await fs.readFile(local.registration, "utf8"),
    originalDescriptors.get(local.registration),
  );
  assert.equal(
    await fs.readFile(path.join(unsafe.target, "sentinel.txt"), "utf8"),
    "Unsafe External original content",
  );
  await assert.rejects(fs.lstat(path.join(userData, "dlc_load.json")), {
    code: "ENOENT",
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(externalRequests, []);
  check(
    true,
    "no renderer errors, external application requests, source descriptor edits or real game launches",
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
        calls,
      },
      null,
      2,
    ),
  );
  console.log(`Mod context-menu UI: ${checks.length} checks passed`);
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
          calls,
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
    path.isAbsolute(root) &&
    path.dirname(path.resolve(root)) === path.resolve(os.tmpdir()) &&
    path.basename(root).startsWith("ironclad-mod-context-ui-")
  )
    await fs.rm(root, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 50,
    });
}
