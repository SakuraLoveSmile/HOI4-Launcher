"use strict";
const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { once } = require("node:events");
const assert = require("node:assert/strict");
const { createLauncherService } = require("../electron/launcher-service.cjs");
const { createModProjectService } = require("../electron/mod-projects.cjs");
const { createCampaignService } = require("../electron/campaigns.cjs");
const {
  createPlaysetSnapshotService,
} = require("../electron/playset-snapshots.cjs");
const { createModCoverageService } = require("../electron/mod-coverage.cjs");
const {
  createGamePerformanceService,
} = require("../electron/game-performance.cjs");
const { captureEnvironment } = require("../electron/launch-environment.cjs");
app.disableHardwareAcceleration();
app.on("window-all-closed", () => {});
let root, window;
const checks = [],
  errors = [],
  requests = [];
const output = path.resolve("test-results/five-improvements");
const check = (condition, label) => {
  assert.ok(condition, label);
  checks.push(label);
  console.log("PASS " + label);
};
const timeout = setTimeout(() => {
  console.error("Workflow desktop verification timed out");
  app.exit(1);
}, 45000);
app
  .whenReady()
  .then(async () => {
    root = path.resolve(process.argv[2] || "");
    assert.equal(path.dirname(root), os.tmpdir());
    assert.ok(path.basename(root).startsWith("ironclad-workflows-desktop-"));
    await fs.mkdir(path.join(root, "appdata"));
    app.setPath("userData", path.join(root, "appdata"));
    await fs.mkdir(output, { recursive: true });
    const user = path.join(root, "Paradox Interactive", "Hearts of Iron IV"),
      game = path.join(root, "game");
    const write = async (filename, bytes) => {
      await fs.mkdir(path.dirname(filename), { recursive: true });
      await fs.writeFile(filename, bytes);
    };
    await write(
      path.join(game, "hoi4.exe"),
      "isolated never executable fixture",
    );
    await write(
      path.join(game, "launcher-settings.json"),
      '{"rawVersion":"1.19.4.0"}',
    );
    for (const name of ["alpha", "beta"]) {
      await write(
        path.join(user, "mod", name + ".mod"),
        `name="${name}"\npath="mod/${name}"\n`,
      );
      await write(
        path.join(user, "mod", name, "descriptor.mod"),
        `name="${name}"\n`,
      );
      await write(
        path.join(user, "mod", name, "events", "shared.txt"),
        "country_event={ id=desktop.1 }\n",
      );
    }
    const savePath = path.join(user, "save games", "desktop.hoi4");
    await write(savePath, "isolated save fixture");
    let projects;
    const launcher = createLauncherService({
      settingsPath: path.join(root, "settings.json"),
      documentsPath: root,
      steamRoots: [],
      processProbe: async () => null,
      spawnProcess: () => {
        throw new Error("Desktop verification must never start a game");
      },
      getModProjects: async () =>
        projects ? (await projects.list()).projects : [],
      resolveProjectVersion: (id, version) =>
        projects.resolveVersion(id, version),
    });
    projects = createModProjectService({
      storageDirectory: path.join(root, "projects"),
      getUserDataPath: async () => user,
      isGameRunning: async () => false,
    });
    await launcher.saveSettings({
      gameDirectory: game,
      playsets: [
        {
          id: "default",
          name: "Hidden workflow fixture",
          modIds: ["local:alpha.mod", "local:beta.mod"],
        },
      ],
    });
    const campaigns = createCampaignService({
      storageDirectory: path.join(root, "campaigns"),
      launcher,
    });
    const snapshots = createPlaysetSnapshotService({
      storageDirectory: path.join(root, "snapshots"),
      launcher,
      projects,
    });
    const coverage = createModCoverageService({ launcher });
    const campaign = await campaigns.bind({
      savePath,
      name: "Hidden campaign",
      notes: "desktop fixture",
    });
    const performance = createGamePerformanceService({
      storageDirectory: path.join(root, "statistics"),
      monitorPath: path.resolve("assets/game-performance-monitor.exe"),
      spawnProcess: () => {
        throw new Error("Isolated unavailable collector fixture");
      },
    });
    const environment = captureEnvironment(await launcher.getState());
    const metadata = {
      pid: 123456,
      executable: process.execPath,
      gameVersion: "1.19.4.0",
      instanceId: "default",
      instanceName: "Fixture",
      playsetId: "default",
      playsetName: "Hidden statistics",
      modCount: 2,
      launchMode: "normal",
      environment,
    };
    const recordA = await performance.startSession({
      ...metadata,
      launchedAt: new Date(Date.now() - 2000).toISOString(),
    });
    const recordB = await performance.startSession({
      ...metadata,
      launchedAt: new Date(Date.now() - 1000).toISOString(),
    });
    const handle = (channel, task) =>
      ipcMain.handle(channel, async (event, ...args) => {
        assert.equal(event.sender, window.webContents);
        assert.equal(event.senderFrame, window.webContents.mainFrame);
        return task(...args);
      });
    handle("launcher:state", () => launcher.getState());
    handle("launcher:status", () => launcher.getLaunchStatus());
    handle("launcher:save", (patch) => launcher.saveSettings(patch));
    handle("performance:state", () => performance.getState());
    handle("performance:session", (id) => performance.getSession(id));
    handle("performance:notes", (id, notes) => performance.setNotes(id, notes));
    handle("performance:compare", (beforeId, afterId) =>
      performance.compareSessions(beforeId, afterId),
    );
    handle("mods:thumbnail", () => null);
    handle("news:state", () => ({ items: [], source: "fixture" }));
    handle("pdx-storage:state", () => ({
      storage: {},
      busy: false,
      job: null,
    }));
    handle("steam-missing:state", () => ({ job: null, plan: null }));
    handle("campaigns:state", () => campaigns.list());
    handle("campaigns:review", (id) => campaigns.review(id));
    handle("campaigns:progress", () => campaigns.getProgress());
    handle("snapshots:state", () => snapshots.list());
    handle("snapshots:create", (input) => snapshots.create(input));
    handle("snapshots:verify", (id) => snapshots.verify(id));
    handle("snapshots:progress", () => snapshots.getProgress());
    handle("coverage:scan", () => coverage.scan());
    handle("coverage:progress", () => coverage.getProgress());
    handle("coverage:evidence", (reportId, evidenceId) =>
      coverage.readEvidence(reportId, evidenceId),
    );
    window = new BrowserWindow({
      width: 1000,
      height: 900,
      show: false,
      skipTaskbar: true,
      webPreferences: {
        offscreen: true,
        preload: path.resolve("electron/preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    window.webContents.session.webRequest.onBeforeRequest(
      { urls: ["http://*/*", "https://*/*"] },
      (request, callback) => {
        requests.push(request.url);
        callback({ cancel: true });
      },
    );
    window.webContents.on("console-message", (event) => {
      if (event.level === "error") errors.push(event.message);
    });
    await window.loadFile(path.resolve("dist/index.html"));
    const result = await window.webContents.executeJavaScript(`(async () => {
    const campaigns = await window.launcher.getCampaigns();
    const review = await window.launcher.reviewCampaign(campaigns.campaigns[0].id);
    const saved = await window.launcher.createPlaysetSnapshot({name:'Hidden stable combination'});
    const verified = await window.launcher.verifyPlaysetSnapshot(saved.id);
    const report = await window.launcher.scanModCoverage();
    const evidence = report.groups.find(group=>group.kind==='event-id').evidence[0];
    const snippet = await window.launcher.readModCoverageEvidence(report.id,evidence.id);
    return { campaignId:review.campaign.id, changes:review.changes.length, backups:campaigns.campaigns[0].backups.length, modCount:saved.modCount, valid:verified.valid, evidence:snippet.text, coverageBusy:(await window.launcher.getModCoverageProgress()).busy };
  })()`);
    check(
      result.campaignId === campaign.id &&
        result.changes === 0 &&
        result.backups === 1,
      "production sandboxed preload reads campaign backups and environment reviews",
    );
    check(
      result.modCount === 2 && result.valid,
      "production preload captures and verifies real Mod bytes",
    );
    check(
      result.evidence.includes("desktop.1") && !result.coverageBusy,
      "production preload returns trusted coverage excerpts and responsive progress",
    );
    const statistics = await window.webContents
      .executeJavaScript(`(async () => {
      const result = await window.launcher.setGamePerformanceNotes('${recordA.id}', 'Hidden desktop note');
      const comparison = await window.launcher.compareGamePerformance('${recordA.id}', '${recordB.id}');
      return {notes:result.notes, version:result.environment.game.version, available:comparison.available, unverified:comparison.changes.filter(change=>change.kind==='unverified').length};
    })()`);
    check(
      statistics.notes === "Hidden desktop note" &&
        statistics.version === "1.19.4.0",
      "production preload persists statistics notes independently of collector summaries",
    );
    check(
      statistics.available && statistics.unverified === 2,
      "production preload compares full configuration while marking unverified Mod contents",
    );
    await window.webContents.executeJavaScript(`(async () => {
      const state = await window.launcher.getState();
      await window.launcher.saveSettings({launcherPreferences:{...state.settings.launcherPreferences,closeOnLaunch:true,homeLayout:'compact'}});
    })()`);
    const reloaded = once(window.webContents, "did-finish-load");
    window.webContents.reload();
    await reloaded;
    const waitFor = async (expression) => {
      const deadline = Date.now() + 10000;
      while (!(await window.webContents.executeJavaScript(expression))) {
        assert.ok(Date.now() < deadline, "desktop compact UI timed out");
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
    };
    await waitFor(
      "document.querySelectorAll('.compact-home-card').length === 4 && Boolean(document.querySelector('.compact-home-card select'))",
    );
    check(
      !(await window.webContents.executeJavaScript(
        "Boolean(document.querySelector('.hero'))",
      )) &&
        (await launcher.getState()).settings.launcherPreferences.homeLayout ===
          "compact",
      "production preload saves compact homepage and renders all four cards after reload",
    );
    await waitFor(
      "!document.querySelector('.home-layout-toolbar button').disabled",
    );
    await window.webContents.executeJavaScript(
      "document.querySelector('.home-layout-toolbar button').click()",
    );
    await waitFor("Boolean(document.querySelector('.hero'))");
    check(
      (await launcher.getState()).settings.launcherPreferences.homeLayout ===
        "full" &&
        (await launcher.getState()).settings.launcherPreferences
          .closeOnLaunch === true,
      "production homepage toggle restores full view and preserves other preferences",
    );
    check(!window.isVisible(), "verification remains offscreen throughout");
    check(
      (await fs.readFile(savePath, "utf8")) === "isolated save fixture",
      "desktop verification preserves original fixture saves",
    );
    check(requests.length === 0, "desktop workflows make no external requests");
    check(errors.length === 0, "desktop renderer has no console errors");
    await fs.writeFile(
      path.join(output, "workflows-desktop.json"),
      JSON.stringify({ checks, errors, requests }, null, 2),
    );
    console.log(`${checks.length} hidden desktop workflow checks passed`);
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    clearTimeout(timeout);
    window?.destroy();
    app.exit(process.exitCode || 0);
  });
