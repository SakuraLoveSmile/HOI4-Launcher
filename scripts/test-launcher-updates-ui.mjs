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
const root = await fs.mkdtemp(path.join(os.tmpdir(), "ironclad-update-ui-"));
const output = path.resolve("test-results/launcher-updates");
const origin = "http://127.0.0.1:4201";
const checks = [],
  errors = [],
  externalRequests = [],
  environmentRequests = [];
const calls = {
  checks: 0,
  downloads: 0,
  cancellations: 0,
  installs: 0,
  releases: 0,
  launches: 0,
};
let browser, page, server;
const check = (value, label) => {
  assert.ok(value, label);
  checks.push(label);
  console.log("PASS " + label);
};
const until = async (predicate, label) => {
  const deadline = Date.now() + 15000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("Timed out: " + label);
    await new Promise((resolve) => setTimeout(resolve, 35));
  }
};

try {
  await fs.mkdir(output, { recursive: true });
  const game = path.join(root, "game");
  await fs.mkdir(game, { recursive: true });
  await fs.writeFile(
    path.join(game, "hoi4.exe"),
    "Inert fixture; never execute",
  );
  await fs.writeFile(
    path.join(game, "launcher-settings.json"),
    '{"rawVersion":"1.19.4"}',
  );
  let running = false,
    failCheck = false,
    completeCheck = null,
    completeDownload = null;
  const release = {
    version: "99.0.0",
    notes:
      "更新说明原文 / Original release notes\nPreserve <b>literal HTML</b> and user paths C:/我的模组",
    canDownload: true,
    size: 10485760,
  };
  let update = {
    status: "idle",
    currentVersion: "0.27.0",
    canInstall: true,
    release: null,
    progress: null,
  };
  const launcher = createLauncherService({
    settingsPath: path.join(root, "app", "settings.json"),
    documentsPath: root,
    steamRoots: [],
    processProbe: async () => (running ? { pid: 12345 } : null),
    spawnProcess: () => {
      calls.launches++;
      throw new Error("Update UI verification must never launch a game");
    },
  });
  await launcher.saveSettings({ gameDirectory: game });
  const api = {
    getState: () => launcher.getState(),
    getLaunchStatus: () => launcher.getLaunchStatus(),
    getModThumbnail: () => null,
    saveSettings: (patch) => launcher.saveSettings(patch),
    getNews: async () => ({ items: [], source: "fixture" }),
    getPdxStorageState: async () => ({ storage: {}, busy: false, job: null }),
    getSteamMissingMods: async () => ({ job: null, plan: null }),
    getAccount: async () => ({ status: "signed-out", canRemember: false }),
    getDisplays: async () => [],
    getLauncherUpdate: async () => structuredClone(update),
    checkLauncherUpdate: async () => {
      calls.checks++;
      update = { ...update, status: "checking", error: null };
      if (failCheck) {
        update = {
          ...update,
          status: "error",
          error: "Fixture update service unavailable",
        };
        throw new Error(update.error);
      }
      await new Promise((resolve) => {
        completeCheck = resolve;
      });
      return structuredClone(update);
    },
    downloadLauncherUpdate: async () => {
      calls.downloads++;
      assert.ok(update.release?.canDownload);
      update = {
        ...update,
        status: "downloading",
        error: null,
        progress: { received: 2097152, total: release.size },
      };
      await new Promise((resolve) => {
        completeDownload = resolve;
      });
      return structuredClone(update);
    },
    cancelLauncherUpdate: async () => {
      calls.cancellations++;
      update = { ...update, status: "cancelled", progress: null };
      completeCheck?.();
      completeDownload?.();
      completeCheck = completeDownload = null;
      return structuredClone(update);
    },
    installLauncherUpdate: async () => {
      assert.equal(update.status, "ready");
      assert.equal(update.canInstall, true);
      assert.equal(running, false);
      calls.installs++;
      update = { ...update, status: "installing" };
      return structuredClone(update);
    },
    openLauncherReleases: async () => {
      calls.releases++;
      return true;
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
      "4201",
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
  await until(() => {
    if (server.exitCode !== null)
      throw new Error("Preview server failed: " + serverLog);
    return serverLog.includes("127.0.0.1:4201");
  }, "Vite preview startup");
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
    const url = route.request().url();
    if (url.startsWith(origin + "/")) return route.continue();
    if (new URL(url).hostname === "me.kis.v2.scr.kaspersky-labs.com")
      environmentRequests.push(url);
    else externalRequests.push(url);
    return route.abort();
  });
  await page.exposeBinding("fixtureInvoke", (_, method, args) => {
    assert.ok(
      Object.hasOwn(api, method),
      "Unexpected fixture method: " + method,
    );
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
  const panel = page.locator(".launcher-updates");
  const status = panel.getByRole("status");
  const button = (name) => panel.getByRole("button", { name, exact: true });
  const settings = async () => {
    await page.locator("nav .nav-item").last().click();
    await panel.waitFor();
    await panel.scrollIntoViewIfNeeded();
  };
  const expectStatus = (text) =>
    until(async () => (await status.textContent()).includes(text), text);
  const finishCheck = () => {
    update = {
      ...update,
      status: "available",
      release: structuredClone(release),
    };
    completeCheck?.();
    completeCheck = null;
  };
  const finishDownload = () => {
    update = {
      ...update,
      status: "ready",
      progress: { received: release.size, total: release.size },
    };
    completeDownload?.();
    completeDownload = null;
  };
  await settings();
  await expectStatus("检查 GitHub");
  check(
    calls.checks === 0 && calls.downloads === 0,
    "opening settings reads update status without automatically checking or downloading",
  );

  await button("检查更新").click();
  await expectStatus("正在检查");
  check(
    await button("检查更新").isDisabled(),
    "checking disables duplicate checks and exposes cancellation",
  );
  await button("取消").click();
  await expectStatus("已取消");
  check(
    calls.cancellations === 1,
    "checking can be cancelled through the update API",
  );
  await button("检查更新").click();
  await until(() => Boolean(completeCheck), "pending update check");
  finishCheck();
  await expectStatus("发现启动器新版本");
  check(
    await button("下载更新").isEnabled(),
    "a newer verifiable release enables download",
  );
  check(
    (await panel.locator(".launcher-update-notes").textContent()) ===
      release.notes &&
      (await panel.locator(".launcher-update-notes b").count()) === 0,
    "release notes preserve original text and render HTML literally",
  );

  await button("下载更新").click();
  await expectStatus("正在下载并校验");
  const progress = panel.getByRole("progressbar", {
    name: "更新下载进度",
    exact: true,
  });
  check(
    (await progress.getAttribute("value")) === "2097152" &&
      (await progress.getAttribute("max")) === String(release.size),
    "download progress uses transferred and total bytes",
  );
  await panel.screenshot({
    path: path.join(output, "update-downloading.png"),
    animations: "disabled",
  });
  await button("取消").click();
  await expectStatus("已取消");
  check(
    calls.cancellations === 2 && (await button("下载更新").isEnabled()),
    "cancelled downloads remain retryable without installing",
  );
  await button("下载更新").click();
  await expectStatus("正在下载并校验");
  await page.locator("nav .nav-item").first().click();
  await panel.waitFor({ state: "hidden" });
  finishDownload();
  await settings();
  await expectStatus("通过校验");
  check(
    calls.downloads === 2 && (await button("安装并重启").isEnabled()),
    "download continues after navigating away and returning restores verified ready state",
  );
  await panel.screenshot({
    path: path.join(output, "update-ready.png"),
    animations: "disabled",
  });

  await button("安装并重启").click();
  await page
    .getByRole("dialog", { name: "安装启动器更新", exact: true })
    .waitFor();
  check(
    calls.installs === 0,
    "installing requires a separate confirmation dialog",
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "取消", exact: true })
    .click();
  check(
    calls.installs === 0 && update.status === "ready",
    "cancelling confirmation preserves the verified update and does not invoke installation",
  );
  await button("安装并重启").click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "确认安装并重启", exact: true })
    .click();
  await expectStatus("正在退出并安装");
  check(
    calls.installs === 1 && calls.launches === 0,
    "confirmed installation invokes only the inert mock installer once",
  );

  update = { ...update, status: "ready", canInstall: false };
  await expectStatus("通过校验");
  await until(
    async () => (await panel.textContent()).includes("不支持原位更新"),
    "manual update hint",
  );
  check(
    await button("安装并重启").isDisabled(),
    "unsupported launch modes disable in-place installation and show manual replacement guidance",
  );
  update = { ...update, canInstall: true };
  running = true;
  await page.locator(".refresh-button").click();
  await until(
    async () => (await panel.textContent()).includes("请先退出游戏"),
    "game-running guard",
  );
  check(
    await button("安装并重启").isDisabled(),
    "a running game disables installation",
  );
  running = false;
  await page.locator(".refresh-button").click();
  await until(
    async () => !(await button("安装并重启").isDisabled()),
    "installation unblocks after game exits",
  );

  update = {
    ...update,
    status: "available",
    release: { ...release, canDownload: false },
  };
  await expectStatus("发现启动器新版本");
  check(
    (await button("下载更新").count()) === 0 &&
      (await panel.textContent()).includes("缺少可校验"),
    "releases without a verifiable package expose release-page guidance instead of download",
  );
  await button("打开 GitHub 发布页").click();
  check(
    calls.releases === 1,
    "the release-page button invokes the fixed backend action without browser network requests",
  );
  update = { ...update, status: "current", release: structuredClone(release) };
  await expectStatus("最新稳定版本");
  check(
    (await button("下载更新").count()) === 0,
    "the current-version status never offers a download even if release metadata remains present",
  );

  failCheck = true;
  await button("检查更新").click();
  await expectStatus("未完成");
  await until(
    async () =>
      (await panel.getByRole("alert").textContent()).includes(
        "Fixture update service unavailable",
      ),
    "action error is shown",
  );
  check(
    await button("检查更新").isEnabled(),
    "check errors remain visible and leave retry available",
  );
  failCheck = false;
  await button("检查更新").click();
  await until(() => Boolean(completeCheck), "retry check starts");
  finishCheck();
  await expectStatus("发现启动器新版本");
  check(
    (await panel.getByRole("alert").count()) === 0,
    "a successful retry clears the prior error",
  );

  await page.getByLabel("界面语言", { exact: true }).selectOption("en");
  await page.getByLabel("Interface language", { exact: true }).waitFor();
  await expectStatus("A new launcher version is available");
  await page.setViewportSize({ width: 1000, height: 740 });
  await panel.scrollIntoViewIfNeeded();
  check(
    (await button("Download update").isVisible()) &&
      (await button("Open GitHub releases").isVisible()),
    "update actions and state follow the selected English interface language",
  );
  check(
    (await panel.locator(".launcher-update-notes").textContent()) ===
      release.notes,
    "switching interface language preserves author-provided release notes",
  );
  check(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    "the update panel has no horizontal overflow at 1000px width",
  );
  check(
    await panel.locator(".launcher-update-actions").evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return [...element.querySelectorAll("button")].every((item) => {
        const rect = item.getBoundingClientRect();
        return rect.left >= bounds.left && rect.right <= bounds.right + 1;
      });
    }),
    "all update action buttons remain inside the panel at minimum window width",
  );
  await panel.screenshot({
    path: path.join(output, "update-english-1000px.png"),
    animations: "disabled",
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(externalRequests, []);
  check(
    calls.installs === 1 && calls.launches === 0,
    "verification performs no real update downloads, installation or game launch",
  );
  check(true, "no renderer errors or external application network requests");
  await fs.writeFile(
    path.join(output, "results.json"),
    JSON.stringify(
      {
        passed: true,
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
  console.log(`Launcher update UI: ${checks.length} checks passed`);
} catch (error) {
  await page
    ?.screenshot({ path: path.join(output, "failure.png"), fullPage: true })
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
    path.basename(root).startsWith("ironclad-update-ui-")
  ) {
    await fs.rm(root, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 50,
    });
  }
}
