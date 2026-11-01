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
const origin = "http://127.0.0.1:4194";
const output = path.resolve("test-results/0.26.0");
const root = await fs.mkdtemp(
  path.join(os.tmpdir(), "ironclad-performance-ui-"),
);
const checks = [],
  errors = [],
  externalRequests = [],
  environmentRequests = [];
let browser, page, previewPage, server;
let releaseSlowDetail;
const GiB = 1024 ** 3;
const clone = (value) => structuredClone(value);
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
  const settingsPath = path.join(root, "settings.json");
  const enabledPath = path.join(root, "performance-fixture-enabled.json");
  const write = async (file, data) => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, data);
  };
  await write(path.join(game, "hoi4.exe"), "Fixture only; never executable");
  await write(
    path.join(game, "launcher-settings.json"),
    '{"rawVersion":"1.19.4.0"}',
  );
  await write(enabledPath, "true\n");
  let gameLaunches = 0;
  const launcher = createLauncherService({
    settingsPath,
    documentsPath: root,
    steamRoots: [],
    processProbe: async () => null,
    spawnProcess: () => {
      gameLaunches++;
      throw new Error("Statistics UI must not launch a real game");
    },
  });
  await launcher.saveSettings({ gameDirectory: game });
  const originalGameBytes = await fs.readFile(path.join(game, "hoi4.exe"));

  const current = {
    id: "11111111-1111-4111-8111-111111111111",
    status: "recording",
    startedAt: "2026-10-30T02:00:00.000Z",
    endedAt: null,
    lastSampleAt: "2026-10-30T03:01:05.000Z",
    durationMs: 3665000,
    sampleCount: 734,
    cpuAveragePercent: 12.5,
    cpuPeakPercent: 33.3,
    memoryAverageBytes: 2.5 * GiB,
    memoryPeakBytes: 4 * GiB,
    privateMemoryAverageBytes: 3.5 * GiB,
    privateMemoryPeakBytes: 5 * GiB,
    gameVersion: "1.19.4.0",
    instanceId: "default",
    instanceName: "Fixture installation",
    playsetId: "current",
    playsetName: "Current campaign",
    modCount: 12,
    logicalCpuCount: 16,
    samplingGapCount: 0,
    trendDownsampled: true,
    samples: [
      {
        elapsedMs: 0,
        cpuPercent: null,
        memoryBytes: 1 * GiB,
        privateMemoryBytes: 2 * GiB,
      },
      {
        elapsedMs: 5000,
        cpuPercent: 5,
        memoryBytes: 1.5 * GiB,
        privateMemoryBytes: 2.5 * GiB,
      },
      {
        elapsedMs: 10000,
        cpuPercent: 12.5,
        memoryBytes: 2 * GiB,
        privateMemoryBytes: 3 * GiB,
      },
      {
        elapsedMs: 30000,
        cpuPercent: 33.3,
        memoryBytes: 3 * GiB,
        privateMemoryBytes: 4 * GiB,
      },
      {
        elapsedMs: 900000,
        cpuPercent: 25,
        memoryBytes: 3.25 * GiB,
        privateMemoryBytes: 4.25 * GiB,
      },
      {
        elapsedMs: 1800000,
        cpuPercent: 12.5,
        memoryBytes: 4 * GiB,
        privateMemoryBytes: 5 * GiB,
      },
      {
        elapsedMs: 3665000,
        cpuPercent: 8,
        memoryBytes: 3 * GiB,
        privateMemoryBytes: 4 * GiB,
      },
    ],
  };
  const historical = {
    ...current,
    id: "22222222-2222-4222-8222-222222222222",
    status: "interrupted",
    startedAt: "2026-10-29T02:00:00.000Z",
    endedAt: "2026-10-29T02:00:20.000Z",
    durationMs: 20000,
    sampleCount: 3,
    cpuAveragePercent: 22.5,
    cpuPeakPercent: 30,
    memoryAverageBytes: 1 * GiB,
    memoryPeakBytes: 1.5 * GiB,
    playsetId: "history",
    playsetName: "Historical campaign",
    modCount: 3,
    samplingGapCount: 1,
    trendDownsampled: false,
    samples: [
      {
        elapsedMs: 0,
        cpuPercent: null,
        memoryBytes: 0.5 * GiB,
        privateMemoryBytes: 1 * GiB,
      },
      {
        elapsedMs: 5000,
        cpuPercent: 15,
        memoryBytes: 1 * GiB,
        privateMemoryBytes: 1.5 * GiB,
      },
      {
        elapsedMs: 10000,
        cpuPercent: null,
        memoryBytes: null,
        privateMemoryBytes: null,
      },
      {
        elapsedMs: 15000,
        cpuPercent: 30,
        memoryBytes: 1.5 * GiB,
        privateMemoryBytes: 2 * GiB,
      },
    ],
  };
  let mode = "normal",
    failRead = false,
    notice = null,
    slowNextId = null;
  let slowDetailStarted = false,
    slowDetailReturned = false;
  let performanceReads = 0,
    detailReads = 0;
  const sessions = () =>
    mode === "empty"
      ? []
      : mode === "no-samples"
        ? [
            {
              ...current,
              status: "unavailable",
              sampleCount: 0,
              cpuAveragePercent: null,
              cpuPeakPercent: null,
              memoryAverageBytes: null,
              memoryPeakBytes: null,
              privateMemoryAverageBytes: null,
              privateMemoryPeakBytes: null,
              samplingGapCount: 1,
              samples: [
                {
                  elapsedMs: 0,
                  cpuPercent: null,
                  memoryBytes: null,
                  privateMemoryBytes: null,
                },
              ],
            },
          ]
        : [current, historical];
  const state = async () => ({
    enabled: JSON.parse(await fs.readFile(enabledPath, "utf8")),
    supported: mode !== "unsupported",
    intervalMs: 5000,
    notice,
    sessions: sessions().map(({ samples, ...summary }) => clone(summary)),
  });
  const api = {
    getState: () => launcher.getState(),
    getLaunchStatus: () => launcher.getLaunchStatus(),
    getModThumbnail: () => null,
    saveSettings: (patch) => launcher.saveSettings(patch),
    getNews: async () => ({ items: [], source: "fixture" }),
    getPdxStorageState: async () => ({ storage: {}, busy: false, job: null }),
    getSteamMissingMods: async () => ({ job: null, plan: null }),
    getGamePerformance: async () => {
      performanceReads++;
      if (failRead) throw new Error("Fixture statistics read failure");
      return state();
    },
    getGamePerformanceSession: async (id) => {
      detailReads++;
      const captured = clone(sessions().find((item) => item.id === id) || null);
      if (slowNextId === id) {
        slowNextId = null;
        slowDetailStarted = true;
        await new Promise((resolve) => {
          releaseSlowDetail = resolve;
        });
        slowDetailReturned = true;
      }
      return captured;
    },
    setGamePerformanceEnabled: async (enabled) => {
      assert.equal(typeof enabled, "boolean");
      await fs.writeFile(enabledPath, JSON.stringify(enabled) + "\n");
      return state();
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
      "4194",
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
    return serverLog.includes("127.0.0.1:4194");
  }, "preview server startup");
  browser = await chromium.launch({
    channel: process.env.TEST_BROWSER_CHANNEL || "msedge",
    headless: true,
  });
  page = await browser.newPage({
    viewport: { width: 1440, height: 1040 },
    reducedMotion: "reduce",
  });
  const blockNetwork = async (target) => {
    target.on("pageerror", (error) => errors.push(error.message));
    await target.route("**/*", (route) => {
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
  };
  await blockNetwork(page);
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
  await page.goto(origin);
  await page.getByRole("button", { name: "游戏统计", exact: true }).click();
  const workspace = page.locator(".performance-workspace");
  const summary = page.locator(".performance-session");
  const selector = page.getByRole("combobox", {
    name: "选择游玩记录",
    exact: true,
  });
  const refresh = page.getByRole("button", { name: "刷新统计", exact: true });
  const cards = page.locator(".performance-metric");
  await summary
    .getByRole("heading", { name: current.playsetName, exact: true })
    .waitFor();
  check(
    (await page
      .getByRole("heading", { name: "游戏统计.", exact: true })
      .count()) === 1,
    "statistics page is reachable through the complete App navigation",
  );
  check(
    (await page
      .getByRole("img", { name: "CPU 使用率趋势", exact: true })
      .isVisible()) &&
      (await page
        .getByRole("img", { name: "内存占用趋势", exact: true })
        .isVisible()),
    "CPU and resident/private memory trends render in the full App",
  );
  check(
    (await cards.nth(0).locator("strong").innerText()) === "01:01:05" &&
      (await cards.nth(1).locator("strong").innerText()) === "12.5%" &&
      (await cards.nth(2).locator("strong").innerText()) === "4 GiB" &&
      (await cards.nth(3).locator("strong").innerText()) === "734",
    "summary preserves fixture duration, average CPU, peak resident memory and sample count",
  );
  check(
    (await cards.nth(1).locator("small").innerText()) === "峰值 33.3%" &&
      (await cards.nth(2).locator("small").innerText()) === "平均 2.5 GiB",
    "peak CPU and time-weighted average memory remain distinct summary values",
  );
  check(
    !/FPS|GPU|日期/.test(
      await cards.allTextContents().then((items) => items.join(" ")),
    ) &&
      (await page
        .getByText(
          "当前记录 CPU、内存和运行时长；FPS 与游戏日期推进速度尚未采集。",
          { exact: true },
        )
        .isVisible()),
    "unsupported FPS, GPU and simulation-speed values are not invented",
  );
  check(
    (await workspace
      .getByText("预览使用示例统计，不会采集本机进程。", { exact: true })
      .count()) === 0,
    "desktop fixture history is not mislabeled as browser preview data",
  );

  const hoverPoint = async (title, elapsedMs) => {
    const chart = page.getByRole("img", { name: title, exact: true });
    await chart.scrollIntoViewIfNeeded();
    const bounds = await chart.boundingBox();
    assert.ok(bounds);
    await chart.hover({
      position: {
        x: ((58 + (elapsedMs / current.durationMs) * 686) / 760) * bounds.width,
        y: bounds.height / 2,
      },
    });
  };
  await hoverPoint("CPU 使用率趋势", 1800000);
  const cpuInspection = page
    .locator(".performance-chart")
    .nth(0)
    .locator(".performance-inspection");
  await cpuInspection.waitFor();
  check(
    (await cpuInspection.innerText()).includes("00:30:00") &&
      (await cpuInspection.innerText()).includes("12.5%"),
    "hover inspects an actual CPU sample with its elapsed time",
  );
  await hoverPoint("内存占用趋势", 900000);
  const memoryInspection = page
    .locator(".performance-chart")
    .nth(1)
    .locator(".performance-inspection");
  await memoryInspection.waitFor();
  check(
    (await memoryInspection.innerText()).includes("3.25 GiB") &&
      (await memoryInspection.innerText()).includes("4.25 GiB"),
    "memory hover distinguishes resident memory from private committed memory",
  );
  await page.mouse.move(0, 0);
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        window.scrollTo(0, 0);
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      }),
  );
  await page.screenshot({
    path: path.join(output, "performance-ui-normal.png"),
    fullPage: true,
    animations: "disabled",
  });

  const toggle = page.getByRole("switch", {
    name: "自动记录后续游戏",
    exact: true,
  });
  await toggle.click();
  await until(
    async () =>
      (await toggle.getAttribute("aria-checked")) === "false" &&
      !(await toggle.isDisabled()),
    "recording preference settles",
  );
  check(
    JSON.parse(await fs.readFile(enabledPath, "utf8")) === false &&
      (await summary.getByText("正在记录", { exact: true }).isVisible()),
    "disabling future automatic recording preserves the already running session",
  );
  await page.reload();
  await page.getByRole("button", { name: "游戏统计", exact: true }).click();
  await summary
    .getByRole("heading", { name: current.playsetName, exact: true })
    .waitFor();
  check(
    (await toggle.getAttribute("aria-checked")) === "false",
    "future-recording preference survives renderer restart",
  );

  slowNextId = historical.id;
  await selector.selectOption(historical.id);
  await until(async () => slowDetailStarted, "deferred history detail starts");
  check(
    (await summary.count()) === 0,
    "switching history clears the previous session while the chosen detail is pending",
  );
  await selector.selectOption(current.id);
  await summary
    .getByRole("heading", { name: current.playsetName, exact: true })
    .waitFor();
  releaseSlowDetail();
  releaseSlowDetail = null;
  await until(async () => slowDetailReturned, "old deferred detail returns");
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  check(
    (await summary
      .getByRole("heading", { name: current.playsetName, exact: true })
      .isVisible()) && (await selector.inputValue()) === current.id,
    "an older slow detail response cannot overwrite a newer selected session",
  );

  await selector.selectOption(historical.id);
  await summary
    .getByRole("heading", { name: historical.playsetName, exact: true })
    .waitFor();
  check(
    (await summary.getByText("记录中断", { exact: true }).isVisible()) &&
      (await page
        .getByText("记录存在缺口或采集已停止；缺失区间不会被当作零占用。", {
          exact: true,
        })
        .isVisible()),
    "interrupted history explicitly identifies collection gaps",
  );
  const segments = page
    .locator(".performance-chart")
    .nth(0)
    .locator("polyline.performance-line");
  check(
    (await segments.count()) === 2,
    "null CPU samples split the trend instead of drawing a false zero or joining the gap",
  );
  check(
    (await cards.nth(0).locator("strong").innerText()) === "00:00:20",
    "history selection replaces the summary with the chosen session",
  );

  failRead = true;
  await refresh.click();
  await page
    .getByRole("alert")
    .getByText("无法读取游戏统计，请重试。", { exact: true })
    .waitFor();
  check(
    (await page
      .getByRole("heading", { name: "暂无游玩记录", exact: true })
      .count()) === 0,
    "a read failure shows an actionable error instead of claiming empty history",
  );
  failRead = false;
  await refresh.click();
  await page.getByRole("alert").waitFor({ state: "hidden" });
  check(
    await summary
      .getByRole("heading", { name: historical.playsetName, exact: true })
      .isVisible(),
    "statistics can recover from a read failure without losing the selected history",
  );

  notice = "部分游戏统计记录无法读取，原始文件已保留。";
  await refresh.click();
  await page.getByText(notice, { exact: true }).waitFor();
  check(
    true,
    "partial-record read notices remain visible without discarding readable history",
  );
  notice = null;
  mode = "no-samples";
  await refresh.click();
  await summary
    .getByRole("heading", { name: current.playsetName, exact: true })
    .waitFor();
  await until(
    async () =>
      (await page.getByText("暂无有效采样", { exact: true }).count()) === 2,
    "null-only charts finish loading",
  );
  check(
    (await cards.nth(1).locator("strong").innerText()) === "—" &&
      (await cards.nth(2).locator("strong").innerText()) === "—" &&
      (await page.locator('.performance-chart svg[role="img"]').count()) === 0,
    "unavailable metrics remain missing rather than being converted to zero-use charts",
  );
  check(
    !/NaN|Infinity/.test(await workspace.innerText()),
    "missing samples never render non-finite numbers",
  );

  mode = "unsupported";
  await refresh.click();
  await page
    .getByText("此系统暂不支持游戏性能采集。", { exact: true })
    .waitFor();
  check(
    await toggle.isDisabled(),
    "unsupported systems explain the limitation and disable future capture",
  );
  mode = "empty";
  await refresh.click();
  await page
    .getByRole("heading", { name: "暂无游玩记录", exact: true })
    .waitFor();
  check(
    (await summary.count()) === 0 &&
      (await page.locator(".performance-chart").count()) === 0 &&
      (await page
        .getByText(
          "启用自动记录后，从此启动器启动下一次游戏，统计会出现在这里。",
          { exact: true },
        )
        .isVisible()),
    "empty history has a truthful next-game instruction and no stale statistics",
  );

  mode = "normal";
  await launcher.saveSettings({
    launcherPreferences: { closeOnLaunch: false, language: "en" },
  });
  await page.reload();
  await page
    .getByRole("button", { name: "Game statistics", exact: true })
    .click();
  await summary
    .getByRole("heading", { name: current.playsetName, exact: true })
    .waitFor();
  check(
    (await page
      .getByRole("heading", {
        name: "Performance throughout your session",
        exact: true,
      })
      .isVisible()) &&
      (await page
        .getByRole("switch", {
          name: "Automatically record future games",
          exact: true,
        })
        .isVisible()) &&
      (await page
        .getByRole("img", { name: "CPU usage over time", exact: true })
        .isVisible()),
    "statistics navigation, controls and chart labels follow the English interface language",
  );
  check(
    !/[\u3400-\u9fff]/.test(await workspace.innerText()),
    "English statistics contain no untranslated Chinese interface strings",
  );
  await page.setViewportSize({ width: 1000, height: 900 });
  check(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    "1000px desktop has no horizontal overflow with longer English labels",
  );
  check(
    await workspace.evaluate((node) => node.scrollWidth <= node.clientWidth),
    "the statistics workspace fits the minimum-width desktop",
  );
  await page.screenshot({
    path: path.join(output, "performance-ui-compact.png"),
    fullPage: true,
    animations: "disabled",
  });

  previewPage = await browser.newPage({
    viewport: { width: 1320, height: 1000 },
    reducedMotion: "reduce",
  });
  await blockNetwork(previewPage);
  await previewPage.goto(origin);
  await previewPage
    .getByRole("button", { name: "游戏统计", exact: true })
    .click();
  await previewPage
    .getByText("预览使用示例统计，不会采集本机进程。", { exact: true })
    .waitFor();
  check(
    (await previewPage
      .getByText("界面预览 · 示例数据", { exact: true })
      .isVisible()) &&
      (await previewPage
        .locator('.performance-chart svg[role="img"]')
        .count()) === 2,
    "browser preview statistics are explicitly labeled as samples",
  );

  assert.deepEqual(errors, []);
  assert.deepEqual(externalRequests, []);
  assert.equal(gameLaunches, 0);
  assert.deepEqual(
    await fs.readFile(path.join(game, "hoi4.exe")),
    originalGameBytes,
  );
  await assert.rejects(fs.stat(path.join(userData, "dlc_load.json")), {
    code: "ENOENT",
  });
  check(
    true,
    "no renderer errors, outside application requests, real game launches or game-loadout writes",
  );
  const report = {
    count: checks.length,
    checks,
    errors,
    externalRequests,
    environmentRequests,
    performanceReads,
    detailReads,
    realGameLaunches: gameLaunches,
    port: 4194,
    statisticsSource:
      "Deterministic isolated fixture API; no native collector or real process",
    screenshots: ["performance-ui-normal.png", "performance-ui-compact.png"],
  };
  await fs.writeFile(
    path.join(output, "performance-ui.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(`Performance UI: ${checks.length} checks passed`);
} catch (error) {
  if (page)
    await page
      .screenshot({
        path: path.join(output, "performance-ui-failure.png"),
        fullPage: true,
      })
      .catch(() => {});
  await fs
    .writeFile(
      path.join(output, "performance-ui-failure.json"),
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
      ) + "\n",
    )
    .catch(() => {});
  throw error;
} finally {
  releaseSlowDetail?.();
  await browser?.close();
  if (server && server.exitCode === null) {
    const exited = once(server, "exit");
    server.kill();
    await exited;
  }
  if (
    path.dirname(root) === os.tmpdir() &&
    path.basename(root).startsWith("ironclad-performance-ui-")
  ) {
    await fs.rm(root, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 50,
    });
  }
}
