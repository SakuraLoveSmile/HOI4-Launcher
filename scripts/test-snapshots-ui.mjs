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
  createPlaysetSnapshotService,
} = require("../electron/playset-snapshots.cjs");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "ironclad-snapshots-ui-")),
  output = path.resolve("test-results/five-improvements"),
  origin = "http://127.0.0.1:4196";
let browser,
  server,
  page,
  serverLog = "";
const checks = [],
  errors = [],
  external = [];
const check = (v, label) => {
  assert.ok(v, label);
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
    user = path.join(root, "Paradox Interactive", "Hearts of Iron IV"),
    local = path.join(user, "mod", "alpha"),
    workshop = path.join(
      root,
      "Steam",
      "steamapps",
      "workshop",
      "content",
      "394360",
      "123",
    );
  const write = async (file, bytes) => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, bytes);
  };
  await write(path.join(game, "hoi4.exe"), "never executable fixture");
  await write(
    path.join(game, "launcher-settings.json"),
    '{"rawVersion":"1.19.4.0"}',
  );
  await write(path.join(local, "events", "alpha.txt"), "local-original");
  await write(
    path.join(user, "mod", "alpha.mod"),
    'name="Local Alpha"\npath="mod/alpha"\nversion="1"\nreplace_path="events"\n',
  );
  await write(
    path.join(workshop, "descriptor.mod"),
    'name="Workshop Beta"\nversion="1"\nremote_file_id="123"\n',
  );
  await write(path.join(workshop, "events", "beta.txt"), "workshop-original");
  let projects;
  const launcher = createLauncherService({
    settingsPath: path.join(root, "settings.json"),
    documentsPath: root,
    steamRoots: [path.join(root, "Steam")],
    processProbe: async () => null,
    spawnProcess: () => {
      throw new Error("Snapshot UI must never launch game");
    },
    getModProjects: async () =>
      projects ? (await projects.list()).projects : [],
    resolveProjectVersion: (id, version) =>
      projects.resolveVersion(id, version),
  });
  projects = createModProjectService({
    storageDirectory: path.join(root, "projects"),
    getUserDataPath: async () =>
      (await launcher.getSourceState()).paths.userData,
    isGameRunning: async () => false,
  });
  await launcher.saveSettings({
    gameDirectory: game,
    playsets: [
      {
        id: "default",
        name: "稳定组合",
        modOrder: ["local:alpha.mod", "workshop:123"],
        modIds: ["local:alpha.mod", "workshop:123"],
        disabledDlcIds: [],
      },
    ],
  });
  const options = {
    storageDirectory: path.join(root, "snapshots"),
    launcher,
    projects,
  };
  let snapshots = createPlaysetSnapshotService(options);
  const api = {
    getState: () => launcher.getState(),
    getLaunchStatus: () => launcher.getLaunchStatus(),
    getModThumbnail: (id) => launcher.getModThumbnail(id),
    saveSettings: (p) => launcher.saveSettings(p),
    getNews: async () => ({ items: [], source: "fixture" }),
    getPdxStorageState: async () => ({ storage: {}, busy: false, job: null }),
    getSteamMissingMods: async () => ({ job: null, plan: null }),
    getPlaysetSnapshots: () => snapshots.list(),
    getPlaysetSnapshotProgress: () => snapshots.getProgress(),
    cancelPlaysetSnapshot: () => snapshots.cancel(),
    createPlaysetSnapshot: (p) => snapshots.create(p),
    verifyPlaysetSnapshot: (id) => snapshots.verify(id),
    restorePlaysetSnapshot: (id) => snapshots.restore(id),
    openPlaysetSnapshotFolder: async () => true,
  };
  server = spawn(
    process.execPath,
    [
      "node_modules/vite/bin/vite.js",
      "preview",
      "--host",
      "127.0.0.1",
      "--port",
      "4196",
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
    return serverLog.includes("127.0.0.1:4196");
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
    await page.getByRole("button", { name: /^模组管理/ }).click();
    await page.getByRole("button", { name: "组合快照", exact: true }).click();
    await page.getByRole("dialog", { name: "组合快照", exact: true }).waitFor();
  };
  await open();
  const manager = page.getByRole("dialog", { name: "组合快照", exact: true });
  await manager
    .getByLabel("快照名称", { exact: true })
    .fill("长期战役稳定开局");
  await manager
    .getByRole("button", { name: "保存当前组合", exact: true })
    .click();
  await manager
    .getByRole("button", { name: "恢复此组合", exact: true })
    .waitFor();
  const saved = (await snapshots.list()).snapshots[0];
  check(
    saved.modCount === 2,
    "snapshot captures both local and Workshop Mods through the real services",
  );
  check(
    (await projects.list()).projects.length === 0,
    "capturing a snapshot leaves the project library unchanged",
  );
  await manager
    .getByRole("button", { name: "校验保存文件", exact: true })
    .click();
  await manager
    .getByText("保存文件的摘要校验通过。", { exact: true })
    .waitFor();
  check(true, "snapshot integrity can be verified from the manager");
  await write(path.join(workshop, "events", "beta.txt"), "workshop-updated");
  await write(path.join(local, "events", "alpha.txt"), "local-edited");
  snapshots = createPlaysetSnapshotService(options);
  await open();
  check(
    (await snapshots.list()).snapshots[0].id === saved.id,
    "complete snapshots survive a service and window restart",
  );
  await page.screenshot({
    path: path.join(output, "snapshot-manager.png"),
    fullPage: true,
  });
  await manager
    .getByRole("button", { name: "恢复此组合", exact: true })
    .click();
  const restore = page.getByRole("dialog", {
    name: "恢复组合快照",
    exact: true,
  });
  await restore.waitFor();
  await restore
    .getByRole("button", { name: "恢复为独立播放集", exact: true })
    .click();
  await manager.waitFor();
  await until(
    async () => (await launcher.getState()).settings.playsets.length === 2,
  );
  const state = await launcher.getState(),
    active = state.settings.playsets.find(
      (p) => p.id === state.settings.activePlaysetId,
    ),
    restored = active.modIds.map((id) => state.mods.find((m) => m.id === id));
  check(
    active.modReferences.length === 2 &&
      active.modReferences.every((r) => r.source === "local" && r.version),
    "restored combination pins both independent local project versions",
  );
  check(
    (await fs.readFile(
      path.join(restored[0].contentPath, "events", "alpha.txt"),
      "utf8",
    )) === "local-original",
    "restored local Mod uses saved bytes",
  );
  check(
    (await fs.readFile(
      path.join(restored[1].contentPath, "events", "beta.txt"),
      "utf8",
    )) === "workshop-original",
    "Workshop updates cannot alter the restored fixed version",
  );
  check(
    (await fs.readFile(path.join(local, "events", "alpha.txt"), "utf8")) ===
      "local-edited" &&
      (await fs.readFile(path.join(workshop, "events", "beta.txt"), "utf8")) ===
        "workshop-updated",
    "restoring preserves current source files",
  );
  check(
    state.settings.playsets[0].modIds[0] === "local:alpha.mod",
    "restoring preserves the original playset",
  );
  await page.setViewportSize({ width: 1000, height: 900 });
  await page.screenshot({
    path: path.join(output, "snapshot-compact.png"),
    fullPage: true,
  });
  check(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    "snapshot manager fits a 1000-pixel window",
  );
  check(errors.length === 0, "snapshot workflows have no page exceptions");
  check(
    external.filter((u) => !u.includes("kaspersky-labs.com")).length === 0,
    "snapshot workflows make no external requests",
  );
  await fs.writeFile(
    path.join(output, "snapshot-ui.json"),
    JSON.stringify({ checks, errors, external }, null, 2),
  );
  console.log(`${checks.length} snapshot UI checks passed`);
} catch (error) {
  if (page)
    await page
      .screenshot({
        path: path.join(output, "snapshot-failure.png"),
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
    path.basename(root).startsWith("ironclad-snapshots-ui-")
  )
    await fs.rm(root, {
      recursive: true,
      force: true,
      maxRetries: 8,
      retryDelay: 75,
    });
}
