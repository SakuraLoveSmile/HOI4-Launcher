"use strict";
const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert/strict");
const { createLauncherService } = require("../electron/launcher-service.cjs");
const { createModProjectService } = require("../electron/mod-projects.cjs");
const {
  createModProjectUpstream,
} = require("../electron/mod-project-upstream.cjs");
const {
  createModProjectController,
} = require("../electron/mod-project-controller.cjs");
app.disableHardwareAcceleration();
app.on("window-all-closed", () => {});
let root, window;
const output = path.resolve(__dirname, "../test-results/mod-projects");
const timeout = setTimeout(() => {
  console.error("Project desktop test timed out");
  app.exit(1);
}, 45000);
const checks = [];
async function finish(code) {
  clearTimeout(timeout);
  window?.destroy();
  if (
    root &&
    path.dirname(root) === os.tmpdir() &&
    path.basename(root).startsWith("ironclad-project-desktop-")
  )
    await fs
      .rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
      .catch((error) => {
        // Chromium may retain its own SQLite handle until app.exit. Retain this
        // isolated directory rather than turning a verified flow into a hang.
        if (!["EBUSY", "EPERM"].includes(error.code)) throw error;
        console.log("Retained isolated runtime directory: " + root);
      });
  app.exit(code);
}
app
  .whenReady()
  .then(async () => {
    root = await fs.mkdtemp(
      path.join(os.tmpdir(), "ironclad-project-desktop-"),
    );
    const appData = path.join(root, "appdata");
    await fs.mkdir(appData);
    app.setPath("userData", appData);
    const game = path.join(root, "game"),
      userData = path.join(root, "Paradox Interactive", "Hearts of Iron IV"),
      source = path.join(userData, "mod", "source");
    const write = async (file, data) => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, data);
    };
    await write(path.join(game, "hoi4.exe"), "never execute");
    await write(
      path.join(game, "launcher-settings.json"),
      '{"rawVersion":"1.19.4.0"}',
    );
    const descriptor = 'name="Desktop source"\nsupported_version="1.19.*"\n';
    await write(path.join(source, "descriptor.mod"), descriptor);
    await write(path.join(source, "common/ideas/a.txt"), "value = 1\n");
    await write(
      path.join(userData, "mod", "source.mod"),
      descriptor + `path="${source.replaceAll("\\", "/")}"\n`,
    );
    let projects;
    const launcher = createLauncherService({
      settingsPath: path.join(appData, "settings.json"),
      documentsPath: root,
      steamRoots: [],
      processProbe: async () => null,
      spawnProcess: () => {
        throw new Error("Test must never launch game");
      },
      getModProjects: async () =>
        projects ? (await projects.list()).projects : [],
      resolveProjectVersion: (id, version) =>
        projects.resolveVersion(id, version),
    });
    await launcher.saveSettings({ gameDirectory: game });
    projects = createModProjectService({
      storageDirectory: path.join(appData, "projects"),
      getUserDataPath: async () =>
        (await launcher.getSourceState()).paths.userData,
    });
    const upstream = createModProjectUpstream({
      projects,
      getLauncherState: () => launcher.getSourceState(),
      storageDirectory: path.join(appData, "downloads"),
    });
    const controller = createModProjectController({
      projects,
      upstream,
      launcher,
      chooseOpen: async () => null,
      chooseSave: async () => null,
      openPath: async () => "",
    });
    for (const [method, callback] of Object.entries(controller))
      ipcMain.handle(
        `projects:${method.replace(/[A-Z]/g, (letter) => "-" + letter.toLowerCase())}`,
        (_event, ...args) => callback(...args),
      );
    ipcMain.handle("launcher:state", () => launcher.getState());
    ipcMain.handle("launcher:status", () => launcher.getLaunchStatus());
    ipcMain.handle("mods:thumbnail", (_event, id) =>
      launcher.getModThumbnail(id),
    );
    ipcMain.handle("news:state", () => ({ items: [], source: "fixture" }));
    ipcMain.handle("pdx-storage:state", () => ({
      storage: {},
      busy: false,
      job: null,
    }));
    const errors = [];
    window = new BrowserWindow({
      show: false,
      width: 1320,
      height: 900,
      webPreferences: {
        preload: path.resolve(__dirname, "../electron/preload.cjs"),
        offscreen: true,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    window.webContents.on("preload-error", (_event, _file, error) =>
      errors.push(error.message),
    );
    window.webContents.session.webRequest.onBeforeRequest((details, callback) =>
      callback({ cancel: !/^(file|data|devtools):/.test(details.url) }),
    );
    await window.loadFile(path.resolve(__dirname, "../dist/index.html"));
    const evalJS = (code) => window.webContents.executeJavaScript(code, false);
    assert.equal(
      await evalJS("typeof window.launcher.previewModProjectMerge"),
      "function",
    );
    assert.equal(await evalJS("typeof window.require"), "undefined");
    checks.push(
      "real sandboxed preload exposes project methods without Node access",
    );
    const created = await evalJS(
      'window.launcher.createModProject({modId:"local:source.mod",name:"Desktop fork",baselineKnown:true})',
    );
    assert.equal(created.upstreamRef, null);
    checks.push("native IPC creates an independent local project");
    await evalJS(
      `window.launcher.checkpointModProject(${JSON.stringify(created.id)},"Desktop stable")`,
    );
    const listed = await evalJS("window.launcher.getModProjects()");
    const snapshot = listed.projects[0].snapshots.find(
      (item) => item.name === "Desktop stable",
    );
    assert.ok(snapshot);
    await evalJS(
      `window.launcher.pinModProject(${JSON.stringify(created.id)},${JSON.stringify(snapshot.id)})`,
    );
    const state = await launcher.getState();
    assert.equal(
      state.mods.find((mod) => mod.id === created.modId).projectVersion,
      snapshot.id,
    );
    checks.push("native IPC checkpoint and playset pin survive serialization");
    await evalJS(
      'Array.from(document.querySelectorAll("button")).find(b=>b.textContent.trim()==="本地项目").click()',
    );
    const deadline = Date.now() + 10000;
    while (
      !(await evalJS(
        'document.querySelector(".project-detail .path-box") !== null',
      ))
    ) {
      if (Date.now() > deadline) throw new Error("Project panel did not load");
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(window.isVisible(), false);
    assert.deepEqual(errors, []);
    checks.push(
      "project panel renders in hidden Electron without preload errors or visible window",
    );
    await fs.mkdir(output, { recursive: true });
    await fs.writeFile(
      path.join(output, "desktop.png"),
      (await window.webContents.capturePage()).toPNG(),
    );
    await fs.writeFile(
      path.join(output, "desktop-results.json"),
      JSON.stringify(
        {
          passed: true,
          checks,
          electron: process.versions.electron,
          node: process.versions.node,
          errors,
        },
        null,
        2,
      ),
    );
    console.log(checks.join("\n"));
    await finish(0);
  })
  .catch(async (error) => {
    console.error(error);
    await finish(1);
  });
