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
const { createModCoverageService } = require("../electron/mod-coverage.cjs");
const origin = "http://127.0.0.1:4197",
  output = path.resolve("test-results/five-improvements");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "ironclad-coverage-ui-"));
const checks = [],
  errors = [],
  external = [];
let browser,
  server,
  page,
  serverLog = "";
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
  const alpha = path.join(user, "mod", "alpha"),
    beta = path.join(user, "mod", "beta");
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
    'name="Alpha"\npath="mod/alpha"\nreplace_path="events"\ndependencies={"Author reference"}\n',
  );
  await write(
    path.join(user, "mod", "beta.mod"),
    'name="Beta"\npath="mod/beta"\n',
  );
  const script =
    '# <img src=x onerror="window.unsafeEvidence=true">\ncountry_event = {\n  id = shared.1\n  title = "country_event = { id = fake.2 }"\n}\n';
  await write(path.join(alpha, "events", "shared.txt"), script);
  await write(
    path.join(beta, "events", "shared.txt"),
    "country_event={\n id=shared.1\n}\n",
  );
  await write(
    path.join(alpha, "common", "national_focus", "alpha.txt"),
    "focus_tree={ focus={ id=SHARED_FOCUS } }",
  );
  await write(
    path.join(beta, "common", "national_focus", "beta.txt"),
    "focus_tree={ focus={ id=SHARED_FOCUS } }",
  );
  let launches = 0;
  const launcher = createLauncherService({
    settingsPath: path.join(root, "settings.json"),
    documentsPath: root,
    steamRoots: [],
    processProbe: async () => null,
    spawnProcess: () => {
      launches++;
      throw new Error("Must not launch game");
    },
  });
  await launcher.saveSettings({
    gameDirectory: game,
    playsets: [
      {
        id: "default",
        name: "覆盖证据夹具",
        modIds: ["local:alpha.mod", "local:beta.mod"],
        modOrder: ["local:alpha.mod", "local:beta.mod"],
        disabledDlcIds: [],
      },
    ],
  });
  const coverage = createModCoverageService({ launcher });
  let lastReport;
  const api = {
    getState: () => launcher.getState(),
    getLaunchStatus: () => launcher.getLaunchStatus(),
    getModThumbnail: (id) => launcher.getModThumbnail(id),
    saveSettings: (p) => launcher.saveSettings(p),
    getNews: async () => ({ items: [], source: "fixture" }),
    getPdxStorageState: async () => ({ storage: {}, busy: false, job: null }),
    getSteamMissingMods: async () => ({ job: null, plan: null }),
    scanModCoverage: async () => {
      lastReport = await coverage.scan();
      return lastReport;
    },
    getModCoverageProgress: () => coverage.getProgress(),
    cancelModCoverage: () => coverage.cancel(),
    readModCoverageEvidence: (r, e) => coverage.readEvidence(r, e),
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
  server.stdout.on("data", (b) => {
    serverLog += b;
  });
  server.stderr.on("data", (b) => {
    serverLog += b;
  });
  await until(() => {
    if (server.exitCode !== null) throw new Error(serverLog);
    return serverLog.includes("127.0.0.1:4197");
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
  await page.goto(origin);
  await page.getByRole("button", { name: /^模组管理/ }).click();
  await page.getByRole("button", { name: "覆盖检查", exact: true }).click();
  const manager = page.getByRole("dialog", {
    name: "跨 Mod 覆盖证据",
    exact: true,
  });
  await manager
    .getByRole("button", { name: "检查当前组合", exact: true })
    .click();
  await manager
    .getByRole("button", { name: "重新检查覆盖", exact: true })
    .waitFor();
  check(
    lastReport.counts.mods === 2 && !lastReport.partial,
    "real coverage scan inspects both enabled local Mods",
  );
  check(
    ["same-path", "replace-path", "event-id", "focus-id"].every((kind) =>
      lastReport.groups.some((g) => g.kind === kind),
    ),
    "all four kinds of evidence reach the interface",
  );
  check(
    !lastReport.groups.some(
      (g) => g.value === "fake.2" || g.value === "Author reference",
    ),
    "quoted event-like text and dependencies do not become evidence",
  );
  await manager
    .getByLabel("证据类型", { exact: true })
    .selectOption("event-id");
  await manager
    .getByRole("button", { name: "查看 Alpha 的文件证据", exact: true })
    .click();
  await manager.getByLabel("文件证据", { exact: true }).waitFor();
  check(
    (
      await manager.getByLabel("文件证据", { exact: true }).innerText()
    ).includes("shared.1"),
    "ID evidence opens its source excerpt",
  );
  check(
    await page.evaluate(
      () =>
        !window.unsafeEvidence &&
        !document.querySelector(".coverage-snippet img"),
    ),
    "script excerpts render as escaped text",
  );
  await manager
    .getByLabel("证据类型", { exact: true })
    .selectOption("same-path");
  await manager
    .getByRole("button", { name: "查看 Alpha 的文件证据", exact: true })
    .click();
  await manager.getByLabel("文件证据", { exact: true }).waitFor();
  check(
    (
      await manager.getByLabel("文件证据", { exact: true }).innerText()
    ).includes("<img"),
    "same-path evidence preserves literal source text",
  );
  await page.screenshot({
    path: path.join(output, "coverage-evidence.png"),
    fullPage: true,
  });
  await write(
    path.join(alpha, "events", "shared.txt"),
    script + "# external edit\n",
  );
  await manager
    .getByRole("button", { name: "查看 Alpha 的文件证据", exact: true })
    .click();
  await manager.getByRole("alert").waitFor();
  check(
    !(await manager.getByLabel("文件证据", { exact: true }).count()),
    "changed files reject stale excerpts and clear the old view",
  );
  await manager
    .getByRole("button", { name: "重新检查覆盖", exact: true })
    .click();
  await until(() => lastReport && !coverage.isBusy());
  await manager
    .getByRole("button", { name: "查看 Alpha 的文件证据", exact: true })
    .click();
  await manager.getByLabel("文件证据", { exact: true }).waitFor();
  check(true, "rescanning makes the updated file available for review");
  await page.setViewportSize({ width: 1000, height: 900 });
  check(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    "coverage dialog fits a 1000-pixel window",
  );
  await page.screenshot({
    path: path.join(output, "coverage-compact.png"),
    fullPage: true,
  });
  check(
    launches === 0 &&
      (
        await fs.readFile(path.join(beta, "events", "shared.txt"), "utf8")
      ).includes("shared.1"),
    "coverage never launches the game or changes Mod content",
  );
  const currentSettings = (await launcher.getState()).settings;
  await launcher.saveSettings({
    playsets: currentSettings.playsets.map((playset) => ({
      ...playset,
      modIds: [...playset.modIds, "workshop:999999"],
      modOrder: [...playset.modOrder, "workshop:999999"],
      modReferences: [
        ...playset.modReferences,
        {
          id: "workshop:999999",
          name: "Missing fixture",
          source: "workshop",
          remoteId: "999999",
        },
      ],
    })),
  });
  await manager
    .getByRole("button", { name: "重新检查覆盖", exact: true })
    .click();
  await manager
    .getByText("部分内容未完成检查，请结合下方说明审阅。", { exact: true })
    .waitFor();
  check(
    lastReport.partial &&
      lastReport.mods.some(
        (mod) => mod.id === "workshop:999999" && mod.status !== "complete",
      ),
    "missing enabled content remains explicitly outside the completed scan",
  );
  check(errors.length === 0, "coverage interface has no page exceptions");
  check(
    external.filter((u) => !u.includes("kaspersky-labs.com")).length === 0,
    "coverage makes no external requests",
  );
  await fs.writeFile(
    path.join(output, "coverage-ui.json"),
    JSON.stringify({ checks, errors, external }, null, 2),
  );
  console.log(`${checks.length} coverage UI checks passed`);
} catch (error) {
  if (page)
    await page
      .screenshot({
        path: path.join(output, "coverage-failure.png"),
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
    path.basename(root).startsWith("ironclad-coverage-ui-")
  )
    await fs.rm(root, {
      recursive: true,
      force: true,
      maxRetries: 8,
      retryDelay: 75,
    });
}
