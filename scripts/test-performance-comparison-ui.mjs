import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { createLauncherService } = require("../electron/launcher-service.cjs");
const {
  createGamePerformanceService,
} = require("../electron/game-performance.cjs");
const { captureEnvironment } = require("../electron/launch-environment.cjs");
const root = await fs.mkdtemp(
  path.join(os.tmpdir(), "ironclad-comparison-ui-"),
);
const output = path.resolve("test-results/five-improvements"),
  origin = "http://127.0.0.1:4198",
  GiB = 1024 ** 3;
let page,
  browser,
  server,
  serverLog = "";
const checks = [],
  errors = [],
  external = [];
const check = (condition, label) => {
  assert.ok(condition, label);
  checks.push(label);
  console.log("PASS " + label);
};
const until = async (fn) => {
  const deadline = Date.now() + 20000;
  while (!(await fn())) {
    if (Date.now() > deadline) throw new Error("Timed out");
    await new Promise((r) => setTimeout(r, 40));
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
  for (const name of ["alpha", "beta"]) {
    await write(
      path.join(user, "mod", name + ".mod"),
      `name="${name}"\npath="mod/${name}"\nversion="1"\n`,
    );
    await write(
      path.join(user, "mod", name, "events", "sample.txt"),
      "fixture",
    );
  }
  let launches = 0;
  const launcher = createLauncherService({
    settingsPath: path.join(root, "settings.json"),
    documentsPath: root,
    steamRoots: [],
    processProbe: async () => null,
    spawnProcess: () => {
      launches++;
      throw new Error("Comparison must never launch a game");
    },
  });
  await launcher.saveSettings({
    gameDirectory: game,
    playsets: [
      {
        id: "default",
        name: "Comparison fixture",
        modIds: ["local:alpha.mod", "local:beta.mod"],
        modOrder: ["local:alpha.mod", "local:beta.mod"],
      },
    ],
  });
  const stateA = await launcher.getState();
  stateA.dlc.items = [
    { id: "dlc/fixture.dlc", installed: true, enabled: true },
  ];
  stateA.gameOptions.values.vsync = false;
  const stateB = structuredClone(stateA);
  stateB.settings.playsets[0].modIds.reverse();
  stateB.settings.playsets[0].modOrder.reverse();
  stateB.gameOptions.values.vsync = true;
  stateB.dlc.items[0].enabled = false;
  stateB.mods[0].version = "2";
  const environmentA = captureEnvironment(stateA),
    environmentB = captureEnvironment(stateB);
  const storage = path.join(root, "statistics"),
    options = {
      storageDirectory: storage,
      monitorPath: path.resolve("assets/game-performance-monitor.exe"),
      spawnProcess: () => {
        const child = new EventEmitter();
        child.unref = () => {};
        queueMicrotask(() => child.emit("spawn"));
        return child;
      },
    };
  let performance = createGamePerformanceService(options);
  const seed = async (
    environment,
    index,
    name,
    cpu,
    memory,
    durationMs,
    gap,
  ) => {
    const startedAt = new Date(Date.UTC(2026, 9, 25 + index, 2)).toISOString();
    const record = await performance.startSession({
      pid: 123456,
      launchedAt: startedAt,
      executable: process.execPath,
      gameVersion: "1.19.4.0",
      instanceId: "default",
      instanceName: "Fixture installation",
      playsetId: "default",
      playsetName: name,
      modCount: 2,
      launchMode: "normal",
      ...(environment ? { environment } : {}),
    });
    const directory = path.join(storage, "sessions", record.id),
      summaryFile = path.join(directory, "summary.json");
    const summary = JSON.parse(await fs.readFile(summaryFile, "utf8"));
    const samples = [0, 5000, 10000, 15000, durationMs].map((elapsedMs, i) => ({
      elapsedMs,
      sampleNumber: i + 1,
      cpuPercent: gap && i === 2 ? null : cpu,
      memoryBytes: gap && i === 2 ? null : memory,
      privateMemoryBytes: gap && i === 2 ? null : memory + GiB,
    }));
    await write(
      summaryFile,
      JSON.stringify({
        ...summary,
        status: "completed",
        endedAt: new Date(Date.parse(startedAt) + durationMs).toISOString(),
        lastSampleAt: new Date(
          Date.parse(startedAt) + durationMs,
        ).toISOString(),
        durationMs,
        sampleCount: 5,
        cpuAveragePercent: cpu,
        cpuPeakPercent: cpu + 5,
        memoryAverageBytes: memory,
        memoryPeakBytes: memory + GiB / 2,
        privateMemoryAverageBytes: memory + GiB,
        privateMemoryPeakBytes: memory + 1.5 * GiB,
        logicalCpuCount: 16,
        samplingGapCount: gap ? 1 : 0,
      }),
    );
    await write(
      path.join(directory, "samples.jsonl"),
      [
        JSON.stringify({
          schemaVersion: 1,
          id: record.id,
          trendDownsampled: false,
        }),
        ...samples.map((point) => JSON.stringify(point)),
        "",
      ].join("\n"),
    );
    return record;
  };
  const recordA = await seed(
    environmentA,
    0,
    "Before configuration",
    20,
    3 * GiB,
    60000,
    false,
  );
  const recordB = await seed(
    environmentB,
    1,
    "After configuration",
    30,
    2 * GiB,
    30000,
    true,
  );
  const legacy = await seed(null, 2, "Legacy record", 10, GiB, 20000, false);
  await performance.setNotes(recordB.id, "B fixture note");
  const api = {
    getState: () => launcher.getState(),
    getLaunchStatus: () => launcher.getLaunchStatus(),
    getModThumbnail: () => null,
    saveSettings: (p) => launcher.saveSettings(p),
    getNews: async () => ({ items: [], source: "fixture" }),
    getPdxStorageState: async () => ({ storage: {}, busy: false, job: null }),
    getSteamMissingMods: async () => ({ job: null, plan: null }),
    getGamePerformance: () => performance.getState(),
    getGamePerformanceSession: (id) => performance.getSession(id),
    setGamePerformanceEnabled: (enabled) => performance.setEnabled(enabled),
    setGamePerformanceNotes: (id, notes) => performance.setNotes(id, notes),
    compareGamePerformance: (before, after) =>
      performance.compareSessions(before, after),
  };
  server = spawn(
    process.execPath,
    [
      "node_modules/vite/bin/vite.js",
      "preview",
      "--host",
      "127.0.0.1",
      "--port",
      "4198",
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
  await until(() => {
    if (server.exitCode !== null) throw new Error(serverLog);
    return serverLog.includes("127.0.0.1:4198");
  });
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
    await page.getByRole("button", { name: /^游戏统计/ }).click();
    await page.getByLabel("选择游玩记录", { exact: true }).waitFor();
  };
  await open();
  await page
    .getByLabel("选择游玩记录", { exact: true })
    .selectOption(recordA.id);
  await page
    .getByRole("heading", { name: "Before configuration", exact: true })
    .waitFor();
  const note =
    "Late campaign test\n<img src=x onerror='window.unsafeNote=true'>";
  await page.getByLabel("本次游玩备注", { exact: true }).fill(note);
  await page.getByRole("button", { name: "保存游玩备注", exact: true }).click();
  await until(
    async () => (await performance.getSession(recordA.id)).notes === note,
  );
  check(true, "notes persist through the actual statistics service");
  await page
    .getByLabel("对比另一条记录", { exact: true })
    .selectOption(recordB.id);
  const comparison = page.getByRole("region", {
    name: "两次游玩对比",
    exact: true,
  });
  await comparison.waitFor();
  check(
    (await comparison.innerText()).includes("+10 个百分点"),
    "CPU deltas use percentage points with the A-to-B direction",
  );
  check(
    (await comparison.innerText()).includes("−1 GiB"),
    "memory comparison preserves signed GiB differences",
  );
  for (const label of [
    "加载顺序变化",
    "模组版本变化",
    "DLC 选择变化",
    "游戏设置变化",
    "模组内容尚未核实",
  ])
    check(
      (await comparison.getByText(label, { exact: true }).count()) > 0,
      "configuration comparison includes " + label,
    );
  check(
    (await comparison.innerText()).includes("B fixture note"),
    "comparison shows the other session's saved note",
  );
  const cpuChart = page.locator(".performance-chart").filter({
    has: page.getByRole("heading", { name: "CPU 使用率趋势", exact: true }),
  });
  check(
    (await cpuChart.locator("polyline.comparison").count()) === 2,
    "the comparison CPU curve keeps its missing interval as two segments",
  );
  const memoryChart = page.locator(".performance-chart").filter({
    has: page.getByRole("heading", { name: "内存占用趋势", exact: true }),
  });
  check(
    (await memoryChart.locator("polyline.comparison").count()) === 4,
    "resident and private memory comparison curves both preserve gaps",
  );
  check(
    await page.evaluate(
      () =>
        !window.unsafeNote && !document.querySelector(".performance-notes img"),
    ),
    "notes render literally without executing HTML",
  );
  await page.screenshot({
    path: path.join(output, "performance-comparison.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1000, height: 900 });
  check(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    "comparison and notes fit a 1000-pixel window",
  );
  await page.screenshot({
    path: path.join(output, "performance-comparison-compact.png"),
    fullPage: true,
  });
  await page
    .getByLabel("对比另一条记录", { exact: true })
    .selectOption(legacy.id);
  await comparison
    .getByText("至少一条统计记录缺少可读取的完整启动配置，无法比较配置。", {
      exact: true,
    })
    .waitFor();
  check(
    true,
    "legacy records remain comparable for metrics while configuration is explicitly unknown",
  );
  performance = createGamePerformanceService(options);
  await open();
  await page
    .getByLabel("选择游玩记录", { exact: true })
    .selectOption(recordA.id);
  await until(
    async () =>
      (await page.getByLabel("本次游玩备注", { exact: true }).inputValue()) ===
      note,
  );
  check(
    true,
    "notes and immutable launch context survive service and page restart",
  );
  check(launches === 0, "comparison never starts the game");
  check(errors.length === 0, "comparison has no page exceptions");
  check(
    external.filter((url) => !url.includes("kaspersky-labs.com")).length === 0,
    "comparison makes no external requests",
  );
  await fs.writeFile(
    path.join(output, "performance-comparison-ui.json"),
    JSON.stringify({ checks, errors, external }, null, 2),
  );
  console.log(`${checks.length} performance comparison UI checks passed`);
} catch (error) {
  if (page)
    await page
      .screenshot({
        path: path.join(output, "performance-comparison-failure.png"),
        fullPage: true,
      })
      .catch(() => {});
  throw error;
} finally {
  await browser?.close();
  if (server?.exitCode === null) {
    const done = once(server, "exit");
    server.kill();
    await done;
  }
  if (
    path.dirname(root) === os.tmpdir() &&
    path.basename(root).startsWith("ironclad-comparison-ui-")
  )
    await fs.rm(root, {
      recursive: true,
      force: true,
      maxRetries: 8,
      retryDelay: 75,
    });
}
