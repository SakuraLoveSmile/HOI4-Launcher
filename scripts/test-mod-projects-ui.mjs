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
const { createModProjectService } = require("../electron/mod-projects.cjs");
const {
  createModProjectUpstream,
} = require("../electron/mod-project-upstream.cjs");
const {
  createModProjectController,
} = require("../electron/mod-project-controller.cjs");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "ironclad-project-ui-"));
const output = path.resolve("test-results/mod-projects");
const origin = "http://127.0.0.1:4193";
const checks = [],
  errors = [],
  externalRequests = [],
  environmentRequests = [];
let server, browser, page;
const check = (condition, message) => {
  assert.ok(condition, message);
  checks.push(message);
  console.log("PASS " + message);
};
const until = async (predicate, label) => {
  const deadline = Date.now() + 15000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("Timed out: " + label);
    await new Promise((r) => setTimeout(r, 30));
  }
};
try {
  await fs.mkdir(output, { recursive: true });
  const userData = path.join(root, "Paradox Interactive", "Hearts of Iron IV"),
    source = path.join(
      root,
      "Steam",
      "steamapps",
      "workshop",
      "content",
      "394360",
      "123",
    ),
    game = path.join(root, "game");
  const write = async (file, bytes) => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, bytes);
  };
  await write(path.join(game, "hoi4.exe"), "isolated, never executable");
  await write(
    path.join(game, "launcher-settings.json"),
    '{"rawVersion":"1.19.4.0"}',
  );
  const descriptor =
    'name="作者原版"\nversion="1"\nsupported_version="1.19.*"\nremote_file_id="123"\n';
  await write(path.join(source, "descriptor.mod"), descriptor);
  await write(
    path.join(source, "common/ideas/industry.txt"),
    "industry = {\n cost = 1\n # unchanged context\n build_cost = 2\n}\n",
  );
  await write(
    path.join(userData, "mod", "original.mod"),
    descriptor + `path="${source.replaceAll("\\", "/")}"\n`,
  );
  let projects;
  const launcher = createLauncherService({
    settingsPath: path.join(root, "settings.json"),
    documentsPath: root,
    steamRoots: [],
    processProbe: async () => null,
    spawnProcess: () => {
      throw new Error("No game launches in UI tests");
    },
    getModProjects: async () =>
      projects ? (await projects.list()).projects : [],
    resolveProjectVersion: (id, version) =>
      projects.resolveVersion(id, version),
  });
  await launcher.saveSettings({ gameDirectory: game });
  projects = createModProjectService({
    storageDirectory: path.join(root, "projects"),
    getUserDataPath: async () =>
      (await launcher.getSourceState()).paths.userData,
  });
  let updatedAt = 1;
  const upstream = createModProjectUpstream({
    projects,
    storageDirectory: path.join(root, "downloads"),
    getLauncherState: () => launcher.getSourceState(),
    steam: {
      call: async (method) => {
        assert.equal(method, "getItem");
        return {
          id: "123",
          name: "作者原版",
          installed: true,
          updatedAt,
          installation: { folder: source, timestamp: updatedAt },
          account: { steamId: "fixture" },
        };
      },
    },
  });
  const backupPath = path.join(root, "project-backup.zip");
  let nextOpen = null,
    opened = null;
  const controller = createModProjectController({
    projects,
    upstream,
    launcher,
    chooseOpen: async () => nextOpen,
    chooseSave: async () => backupPath,
    openPath: async (value) => {
      opened = value;
      return "";
    },
  });
  const api = {
    ...controller,
    getState: () => launcher.getState(),
    getLaunchStatus: () => launcher.getLaunchStatus(),
    getModThumbnail: (id) => launcher.getModThumbnail(id),
    saveSettings: (patch) => launcher.saveSettings(patch),
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
      "4193",
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
  await until(() => serverLog.includes("127.0.0.1:4193"), "Vite preview");
  browser = await chromium.launch({
    channel: process.env.TEST_BROWSER_CHANNEL || "msedge",
    headless: true,
  });
  page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: "reduce",
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => {
    const url = route.request().url();
    if (url.startsWith(origin + "/")) return route.continue();
    if (url.includes("kaspersky-labs.com")) environmentRequests.push(url);
    else externalRequests.push(url);
    return route.abort();
  });
  await page.exposeBinding("fixtureInvoke", (_, method, args) => {
    assert.ok(Object.hasOwn(api, method), method);
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
  const openProjectCreation = async (member = false) => {
    await page.locator("nav .nav-item").nth(1).click();
    const row = page.locator(
      `${member ? ".playset-members" : ".playset-library"} [data-mod-id="workshop:123"]`,
    );
    await row.click({ button: "right" });
    await page
      .getByRole("menuitem", { name: "创建二改项目", exact: true })
      .click();
    await page
      .getByRole("dialog", { name: "创建二改项目", exact: true })
      .waitFor();
  };
  await openProjectCreation();
  check(
    (await page.getByLabel("导入来源", { exact: true }).inputValue()) ===
      "installed" &&
      (await page.getByLabel("来源模组", { exact: true }).inputValue()) ===
        "workshop:123" &&
      (await page.getByLabel("项目名称", { exact: true }).inputValue()) ===
        "作者原版" &&
      !(await page
        .getByLabel("我确认这份来源尚未进行个人修改，可作为原版基线。", {
          exact: true,
        })
        .isChecked()),
    "library context entry preselects the clicked original and leaves baseline confirmation unchecked",
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "取消", exact: true })
    .click();
  check(
    (await projects.list()).projects.length === 0,
    "cancelling context creation leaves project storage empty",
  );
  await page.locator("nav .nav-item").nth(1).click();
  await page
    .getByRole("button", { name: "加入播放集 作者原版", exact: true })
    .click();
  await page.locator('.playset-members [data-mod-id="workshop:123"]').waitFor();
  await openProjectCreation(true);
  check(
    (await page.getByLabel("来源模组", { exact: true }).inputValue()) ===
      "workshop:123",
    "playset-member context entry preselects the same trusted source ID",
  );
  await page.screenshot({
    path: path.join(output, "context-create-project.png"),
    fullPage: true,
  });
  await page.getByLabel("项目名称", { exact: true }).fill("我的工业二改");
  await page
    .getByLabel("我确认这份来源尚未进行个人修改，可作为原版基线。", {
      exact: true,
    })
    .check();
  await page.getByRole("button", { name: "创建独立项目", exact: true }).click();
  await page
    .getByRole("heading", { name: "我的工业二改", exact: true })
    .waitFor();
  const project = (await projects.list()).projects[0];
  check(
    project.upstreamRef.modId === "workshop:123",
    "UI creates an independent fork with tracked origin",
  );
  await page.getByRole("button", { name: "打开工作区", exact: true }).click();
  await until(() => opened === project.workPath, "open workspace");
  await page
    .getByRole("button", { name: "在当前播放集中使用工作区", exact: true })
    .click();
  await until(
    async () =>
      (await launcher.getState()).settings.playsets[0].modIds.includes(
        project.modId,
      ),
    "playset membership",
  );
  check(true, "UI enables project in current playset");
  await page.getByRole("button", { name: "历史版本", exact: true }).click();
  await page.getByLabel("版本名称", { exact: true }).fill("稳定版一");
  await page.getByRole("button", { name: "保存检查点", exact: true }).click();
  await page.getByText(/稳定版一 ·/).waitFor();
  check(true, "UI saves named checkpoint");
  await write(
    path.join(project.workPath, "common/ideas/industry.txt"),
    "industry = {\n cost = 9\n # unchanged context\n build_cost = 6\n}\n",
  );
  await write(
    path.join(source, "common/ideas/industry.txt"),
    "industry = {\n cost = 3\n # unchanged context\n build_cost = 8\n}\n",
  );
  await write(
    path.join(source, "events/new.txt"),
    "country_event = { id = demo.1 immediate = { country_event = { id = demo.2 } } }\n",
  );
  updatedAt = 2;
  await page.getByRole("button", { name: "上游更新", exact: true }).click();
  await page.getByRole("button", { name: "获取上游候选", exact: true }).click();
  await until(
    async () => (await projects.get(project.id)).candidateSnapshotId,
    "candidate saved",
  );
  await page
    .getByRole("button", { name: "比较并准备合并", exact: true })
    .click();
  await page
    .getByRole("button", { name: "common/ideas/industry.txt", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("heading", { name: "我的版本", exact: true })
    .first()
    .waitFor();
  await page.screenshot({
    path: path.join(output, "three-way-diff.png"),
    fullPage: true,
  });
  await page.getByText("逐片段选择", { exact: true }).click();
  await page.getByLabel("片段 1", { exact: true }).selectOption("local");
  await page.getByLabel("片段 2", { exact: true }).selectOption("upstream");
  await page
    .getByRole("button", { name: "按片段选择生成结果", exact: true })
    .click();
  const composed = await page
    .getByLabel("手动合并结果", { exact: true })
    .inputValue();
  check(
    composed.includes("cost = 9") &&
      composed.includes("build_cost = 8") &&
      composed.includes("# unchanged context"),
    "fragment selection combines both conflict choices without losing unchanged context",
  );
  await page.screenshot({
    path: path.join(output, "fragment-merge.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "保存手动选择", exact: true }).click();
  await page
    .getByLabel("处理方式 events/new.txt", { exact: true })
    .selectOption("upstream");
  await page.getByRole("button", { name: "预览合并结果", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByText("所选结果的静态检查", { exact: true })
    .waitFor();
  check(
    (await page.getByRole("dialog").innerText()).includes("demo.2"),
    "merge preview reports missing event association before applying",
  );
  await page.screenshot({
    path: path.join(output, "merge-preview.png"),
    fullPage: true,
  });
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "确认", exact: true })
    .click();
  await until(async () => {
    try {
      return (
        await fs.readFile(path.join(project.workPath, "events/new.txt"), "utf8")
      ).includes("demo.1");
    } catch {
      return false;
    }
  }, "merge applied");
  check(
    (
      await fs.readFile(
        path.join(project.workPath, "common/ideas/industry.txt"),
        "utf8",
      )
    ).includes("cost = 9"),
    "selective merge retains personal balancing while adding upstream content",
  );
  check(
    (
      await fs.readFile(
        path.join(project.workPath, "common/ideas/industry.txt"),
        "utf8",
      )
    ).includes("build_cost = 8"),
    "fragment merge adopts the selected upstream region in the same file",
  );
  check(
    (
      await fs.readFile(path.join(source, "common/ideas/industry.txt"), "utf8")
    ).includes("cost = 3"),
    "source remains unchanged by merge",
  );
  await page.getByRole("button", { name: "历史版本", exact: true }).click();
  const stableRow = page
    .locator(".project-history>div")
    .filter({ hasText: "稳定版一" });
  await stableRow
    .getByRole("button", { name: "固定到当前播放集", exact: true })
    .click();
  await until(
    async () =>
      (await launcher.getState()).mods.find((mod) => mod.id === project.modId)
        .projectVersion,
    "pinned version",
  );
  check(true, "UI pins stable version without resetting editable workspace");
  await page.getByRole("button", { name: "备份本地项目", exact: true }).click();
  await until(async () => {
    try {
      return (await fs.stat(backupPath)).size > 0;
    } catch {
      return false;
    }
  }, "backup written");
  await until(
    async () =>
      !(await page
        .getByRole("button", { name: "备份本地项目", exact: true })
        .isDisabled()),
    "backup verified",
  );
  nextOpen = backupPath;
  await page.getByRole("button", { name: "创建二改项目", exact: true }).click();
  await page.getByLabel("导入来源", { exact: true }).selectOption("backup");
  await page.getByRole("button", { name: "创建独立项目", exact: true }).click();
  await until(
    async () => (await projects.list()).projects.length === 2,
    "backup imported",
  );
  check(true, "native backup roundtrip creates a second independent project");
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.locator(".project-detail .path-box").waitFor();
  await until(
    async () =>
      !(await page
        .getByRole("button", { name: "创建二改项目", exact: true })
        .isDisabled()),
    "import detail settles",
  );
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.screenshot({
    path: path.join(output, "projects-1000.png"),
    fullPage: true,
  });
  check(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    "project screen fits minimum desktop width",
  );
  check(errors.length === 0, "no browser runtime errors");
  check(externalRequests.length === 0, "no external application requests");
  await fs.writeFile(
    path.join(output, "ui-results.json"),
    JSON.stringify(
      { checks, errors, externalRequests, environmentRequests, passed: true },
      null,
      2,
    ),
  );
} catch (error) {
  await page
    ?.screenshot({ path: path.join(output, "failure.png"), fullPage: true })
    .catch(() => {});
  await fs.writeFile(
    path.join(output, "failure.json"),
    JSON.stringify(
      { message: error.message, stack: error.stack, checks, errors },
      null,
      2,
    ),
  );
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
    path.basename(root).startsWith("ironclad-project-ui-")
  )
    await fs.rm(root, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 50,
    });
}
