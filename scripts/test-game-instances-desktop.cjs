"use strict";

const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert/strict");
const { createLauncherService } = require("../electron/launcher-service.cjs");

app.disableHardwareAcceleration();
app.on("window-all-closed", () => {});
const output = path.resolve(
  __dirname,
  "../test-results/game-instances-desktop.json",
);
const checks = [],
  errors = [],
  externalRequests = [],
  channels = [];
let root,
  window,
  finishing = false,
  gameLaunches = 0;
const timeout = setTimeout(() => {
  console.error("Hidden game-instance desktop validation timed out");
  void finish(1);
}, 30000);

async function evidence(passed, error) {
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(
    output,
    JSON.stringify(
      {
        passed,
        checks,
        count: checks.length,
        channels,
        errors,
        externalRequests,
        electron: process.versions.electron,
        node: process.versions.node,
        gameLaunches,
        realAccountUsed: false,
        realSteamUsed: false,
        realGameDataUsed: false,
        visibleWindow: window?.isVisible() || false,
        ...(error ? { error: error.message, stack: error.stack } : {}),
      },
      null,
      2,
    ),
  );
}

async function finish(code) {
  if (finishing) return;
  finishing = true;
  clearTimeout(timeout);
  window?.destroy();
  // Only this newly created, absolute fixture directly below the system temp
  // directory is eligible for recursive cleanup.
  if (
    root &&
    path.isAbsolute(root) &&
    path.dirname(path.resolve(root)) === path.resolve(os.tmpdir()) &&
    path.basename(root).startsWith("ironclad-instances-desktop-")
  ) {
    await fs
      .rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
      .catch((error) => {
        if (!["EBUSY", "EPERM"].includes(error.code)) throw error;
        console.log("Retained isolated runtime directory: " + root);
      });
  }
  app.exit(code);
}

app
  .whenReady()
  .then(async () => {
    root = await fs.mkdtemp(
      path.join(os.tmpdir(), "ironclad-instances-desktop-"),
    );
    const appData = path.join(root, "appdata");
    await fs.mkdir(appData);
    app.setPath("userData", appData);
    const game = path.join(root, "当前版本"),
      oldGame = path.join(root, "旧版 独立安装");
    const settingsPath = path.join(appData, "settings.json");
    const write = async (file, data) => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, data);
    };
    for (const [directory, version] of [
      [game, "1.19.4"],
      [oldGame, "1.12.14"],
    ]) {
      await write(
        path.join(directory, "hoi4.exe"),
        "Inert desktop fixture; never execute",
      );
      await write(
        path.join(directory, "launcher-settings.json"),
        JSON.stringify({ rawVersion: version }),
      );
    }
    const launcher = createLauncherService({
      settingsPath,
      documentsPath: root,
      steamRoots: [],
      processProbe: async () => null,
      spawnProcess: () => {
        gameLaunches++;
        throw new Error("Hidden desktop validation must never launch a game");
      },
    });
    await launcher.saveSettings({
      gameDirectory: game,
      gameOptions: { vsync: false },
      playsets: [{ id: "default", name: "默认原有战役", modIds: [] }],
    });
    const initial = await launcher.getState();
    const roundTrip = async (state) => {
      assert.deepEqual(
        JSON.parse(await fs.readFile(settingsPath, "utf8")),
        state.settings,
      );
      assert.deepEqual((await launcher.getState()).settings, state.settings);
    };
    const handle = (channel, callback) =>
      ipcMain.handle(channel, (event, ...args) => {
        assert.equal(event.sender, window.webContents);
        assert.equal(event.senderFrame, window.webContents.mainFrame);
        channels.push(channel);
        return callback(...args);
      });
    // Native selection is replaced by this fixed test-owned installation. The
    // renderer sends only the instance name, just like the production bridge.
    handle("instances:create", (input) => {
      assert.deepEqual(Object.keys(input), ["name"]);
      return launcher.createGameInstance({
        name: input.name,
        gameDirectory: oldGame,
      });
    });
    handle("instances:switch", (id) => launcher.switchGameInstance(id));
    handle("instances:rename", (input) => launcher.renameGameInstance(input));
    handle("instances:remove", (id) => launcher.removeGameInstance(id));
    window = new BrowserWindow({
      show: false,
      width: 800,
      height: 500,
      webPreferences: {
        preload: path.resolve(__dirname, "../electron/preload.cjs"),
        offscreen: true,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        partition: "ironclad-instances-desktop",
      },
    });
    window.webContents.on("preload-error", (_event, _filename, error) =>
      errors.push(error.message),
    );
    window.webContents.session.webRequest.onBeforeRequest(
      (details, callback) => {
        const allowed = /^(data|devtools):/.test(details.url);
        if (!allowed) externalRequests.push(details.url);
        callback({ cancel: !allowed });
      },
    );
    await window.loadURL(
      "data:text/html," +
        encodeURIComponent(
          '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'"><title>Hidden instance bridge fixture</title>',
        ),
    );
    const evalJS = (source) =>
      window.webContents.executeJavaScript(source, false);
    for (const method of [
      "createGameInstance",
      "switchGameInstance",
      "renameGameInstance",
      "removeGameInstance",
    ])
      assert.equal(
        await evalJS(`typeof window.launcher.${method}`),
        "function",
      );
    assert.equal(await evalJS("typeof window.require"), "undefined");
    assert.equal(await evalJS("typeof process"), "undefined");
    checks.push(
      "real sandboxed preload exposes the four named instance methods without Node access",
    );

    const created = await evalJS(
      'window.launcher.createGameInstance({name:"旧版 桌面实例"})',
    );
    const id = created.settings.activeGameInstanceId;
    assert.notEqual(id, "default");
    assert.equal(created.settings.gameDirectory, oldGame);
    assert.equal(created.game.version, "1.12.14");
    assert.notEqual(created.paths.userData, initial.paths.userData);
    assert.deepEqual(created.settings.gameOptions, {});
    await roundTrip(created);
    checks.push(
      "create IPC returns the newly selected isolated state matching persisted settings",
    );
    const save = path.join(
      created.paths.userData,
      "save games",
      "desktop.hoi4",
    );
    await write(save, "isolated desktop save sentinel");

    const renamed = await evalJS(
      `window.launcher.renameGameInstance(${JSON.stringify({ id, name: "重命名后的旧版本" })})`,
    );
    assert.equal(
      renamed.settings.gameInstances.find((item) => item.id === id).name,
      "重命名后的旧版本",
    );
    assert.equal(renamed.paths.userData, created.paths.userData);
    await roundTrip(renamed);
    checks.push(
      "rename IPC preserves instance identity and storage while persisting the name",
    );

    const switched = await evalJS(
      'window.launcher.switchGameInstance("default")',
    );
    assert.equal(switched.paths.userData, initial.paths.userData);
    assert.deepEqual(switched.settings.playsets, initial.settings.playsets);
    assert.deepEqual(
      switched.settings.gameOptions,
      initial.settings.gameOptions,
    );
    await roundTrip(switched);
    const switchedBack = await evalJS(
      `window.launcher.switchGameInstance(${JSON.stringify(id)})`,
    );
    assert.equal(switchedBack.paths.userData, created.paths.userData);
    await roundTrip(switchedBack);
    checks.push(
      "switch IPC restores each instance's settings and stable user directory",
    );

    const removed = await evalJS(
      `window.launcher.removeGameInstance(${JSON.stringify(id)})`,
    );
    assert.equal(removed.settings.activeGameInstanceId, "default");
    assert.equal(removed.settings.gameInstances.length, 1);
    assert.equal(
      await fs.readFile(save, "utf8"),
      "isolated desktop save sentinel",
    );
    assert.equal(
      await fs.readFile(path.join(oldGame, "hoi4.exe"), "utf8"),
      "Inert desktop fixture; never execute",
    );
    await roundTrip(removed);
    checks.push(
      "remove IPC returns to default and preserves the removed instance's save and installation",
    );

    const beforeInvalid = await fs.readFile(settingsPath, "utf8");
    const rejected = await evalJS(
      'window.launcher.removeGameInstance("default").then(()=>false,error=>error.message.includes("不能移除"))',
    );
    assert.equal(rejected, true);
    assert.equal(await fs.readFile(settingsPath, "utf8"), beforeInvalid);
    checks.push(
      "bridge rejects default-instance deletion without changing persisted settings",
    );
    assert.deepEqual(
      new Set(channels),
      new Set([
        "instances:create",
        "instances:switch",
        "instances:rename",
        "instances:remove",
      ]),
    );
    assert.deepEqual(errors, []);
    assert.deepEqual(externalRequests, []);
    assert.equal(window.isVisible(), false);
    assert.equal(gameLaunches, 0);
    checks.push(
      "hidden offscreen Electron completes without visible windows, network or game execution",
    );
    await evidence(true);
    console.log(
      `PASS hidden Electron instance bridge: ${checks.length} checks; Electron ${process.versions.electron}`,
    );
    await finish(0);
  })
  .catch(async (error) => {
    console.error(error);
    await evidence(false, error).catch(() => {});
    await finish(1);
  });
