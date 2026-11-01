"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { randomUUID } = require("node:crypto");

// The actual entry point is evaluated, but every effectful dependency is replaced.
// Application filesystem operations and native windows are mocked; the
// diagnostic helper only builds ZIP bytes in memory from fixture data.
const mainPath = path.resolve(__dirname, "../electron/main.cjs");
const mainSource = fs.readFileSync(mainPath, "utf8");

function gate(t) {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  t.after(() => resolve());
  return { promise, resolve };
}

async function until(predicate) {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error("Main-process fixture did not reach expected state");
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function fixture(t) {
  const root = path.join(os.tmpdir(), "ironclad-main-fixture-" + randomUUID());
  const f = {
    root,
    logEvents: [],
    calls: [],
    hooks: {},
    configs: {},
    handlers: new Map(),
    flags: {
      relocationBusy: false,
      recovery: false,
      downloadsBusy: false,
      steamMissingBusy: false,
      projectsBusy: false,
      projectUpstreamBusy: false,
      steamPublishing: false,
      pdxPublishing: false,
      gameRunning: false,
    },
    userData: path.join(root, "hoi4-user-data"),
    gameFound: true,
    settings: { playsets: [], launcherPreferences: { language: "zh-hans" } },
    projects: [],
    mods: [],
  };
  const call = async (name, args, fallback) => {
    f.calls.push({ name, args });
    if (f.hooks[name]) return f.hooks[name](...args);
    return typeof fallback === "function" ? fallback(...args) : fallback;
  };
  const method =
    (name, fallback = null) =>
    (...args) =>
      call(name, args, fallback);
  const launcher = {
    getState: method("launcher.getState", () => ({
      game: { found: f.gameFound },
      paths: { userData: f.userData },
      mods: f.mods,
      settings: f.settings,
      dlc: { items: [] },
    })),
    getSourceState: method("launcher.getSourceState", () => ({
      game: { found: f.gameFound },
      paths: { userData: f.userData },
      mods: f.mods,
      settings: f.settings,
      dlc: { items: [] },
    })),
    getLaunchStatus: method("launcher.getLaunchStatus", () => ({
      running: f.flags.gameRunning,
    })),
    detectGame: method("launcher.detectGame", { found: true }),
    createGameInstance: method("launcher.createGameInstance", {
      created: true,
    }),
    switchGameInstance: method("launcher.switchGameInstance", {
      switched: true,
    }),
    renameGameInstance: method("launcher.renameGameInstance", {
      renamed: true,
    }),
    removeGameInstance: method("launcher.removeGameInstance", {
      removed: true,
    }),
    saveSettings: method("launcher.saveSettings", (patch) => {
      f.settings = { ...f.settings, ...patch };
      return f.settings;
    }),
    launchGame: method("launcher.launchGame", {
      launched: true,
      closeOnLaunch: false,
      pid: 43210,
      launchedAt: "2026-10-30T00:00:00.000Z",
      executable: path.join(root, "game", "hoi4.exe"),
      performanceContext: {
        gameVersion: "1.19.4.0",
        instanceId: "default",
        instanceName: "Default",
        playsetId: "campaign",
        playsetName: "Campaign",
        modCount: 3,
        launchMode: "normal",
      },
    }),
    getCachePlan: method("launcher.getCachePlan", []),
    listCacheBackups: method("launcher.listCacheBackups", []),
    clearCache: method("launcher.clearCache", { cleared: true }),
    restoreCacheBackup: method("launcher.restoreCacheBackup", {
      restored: true,
    }),
    createLocalMod: method("launcher.createLocalMod"),
    getLocalModMetadata: method("launcher.getLocalModMetadata"),
    getModThumbnail: method("launcher.getModThumbnail", { dataUrl: "fixture" }),
    setModDisplayName: method("launcher.setModDisplayName"),
    resetModDisplayName: method("launcher.resetModDisplayName"),
    removeLocalMod: method("launcher.removeLocalMod", {
      state: { settings: {} },
    }),
    forgetMod: method("launcher.forgetMod", { settings: {} }),
    updateLocalModMetadata: method("launcher.updateLocalModMetadata"),
    getOfficialPlaysets: method("launcher.getOfficialPlaysets", []),
    importOfficialPlaysets: method("launcher.importOfficialPlaysets"),
    importPlayset: method("launcher.importPlayset"),
    exportPlayset: method("launcher.exportPlayset"),
  };
  function publisher(name) {
    return {
      isPublishing: () =>
        f.flags[name === "pdxPublisher" ? "pdxPublishing" : "steamPublishing"],
      ...Object.fromEntries(
        [
          "getDraft",
          "prepare",
          "commit",
          "cancel",
          "getStatus",
          "refreshStatus",
          "recordStatus",
        ].map((operation) => [
          operation,
          method(`${name}.${operation}`, (value) => ({ value })),
        ]),
      ),
    };
  }
  const relocation = {
    isBusy: () => f.flags.relocationBusy,
    isBlocked: () => f.flags.relocationBusy || f.flags.recovery,
    assertReady: method("relocation.assertReady", () => {
      if (f.flags.relocationBusy || f.flags.recovery)
        throw new Error("目录迁移或恢复尚未完成");
    }),
    getState: method("relocation.getState", () => ({
      busy: f.flags.relocationBusy,
      recoveryRequired: f.flags.recovery,
    })),
    prepare: method("relocation.prepare", (input) => ({
      planId: "reviewed-plan",
      ...input,
    })),
    commit: method("relocation.commit", (planId) => ({
      planId,
      status: "queued",
    })),
    discard: method("relocation.discard", true),
    cancel: method("relocation.cancel", { status: "cancelling" }),
    recover: method("relocation.recover", { recoveryRequired: false }),
    dispose: method("relocation.dispose"),
  };
  // This adapter exercises the supplied guard exactly as the real downloads
  // service contract requires; download internals are tested in their own suite.
  const guardedDownload =
    (name) =>
    async (...args) => {
      f.configs.downloads.assertOperationAllowed();
      return call(
        name,
        args,
        name === "downloads.uninstall" ? { removed: true } : { accepted: true },
      );
    };
  const downloads = {
    ready: method("downloads.ready"),
    isBusy: () => f.flags.downloadsBusy,
    start: guardedDownload("downloads.start"),
    resume: guardedDownload("downloads.resume"),
    pause: method("downloads.pause"),
    uninstall: guardedDownload("downloads.uninstall"),
    getState: method("downloads.getState", { jobs: [] }),
    cancel: method("downloads.cancel"),
    setLimit: method("downloads.setLimit"),
    dispose: method("downloads.dispose"),
  };
  const steamMissing = {
    isBusy: () => f.flags.steamMissingBusy,
    getState: method("steamMissing.getState", { job: null, plan: null }),
    prepare: async (input) => {
      await f.configs.steamMissing.assertOperationAllowed();
      return call("steamMissing.prepare", [input], {
        id: "reviewed-steam-plan",
      });
    },
    commit: async (planId) => {
      await f.configs.steamMissing.assertOperationAllowed();
      return call("steamMissing.commit", [planId], { status: "queued" });
    },
    cancel: method("steamMissing.cancel"),
    dispose: method("steamMissing.dispose"),
  };
  const projects = {
    isBusy: () => f.flags.projectsBusy,
    list: method("projects.list", () => ({
      projects: f.projects,
      busy: f.flags.projectsBusy,
    })),
    get: method("projects.get", (id) => ({
      id,
      name: "Fixture project",
      workPath: path.join(root, "project-work"),
      userData: f.userData,
      modId: "local:fixture-project.mod",
      upstreamRef: null,
    })),
    ...Object.fromEntries(
      [
        "create",
        "captureCandidate",
        "setUpstream",
        "inspect",
        "checkpoint",
        "restore",
        "prepareMerge",
        "previewMerge",
        "readMergeFile",
        "applyMerge",
        "exportProject",
        "importProject",
        "resolveVersion",
      ].map((name) => [name, method("projects." + name)]),
    ),
  };
  const projectUpstream = {
    isBusy: () => f.flags.projectUpstreamBusy,
    getState: method("projectUpstream.getState", { job: null }),
    sourceForMod: method("projectUpstream.sourceForMod", (id) => ({
      sourcePath: path.join(root, "original-content"),
      upstreamRef: {
        provider: "pdx",
        remoteId: "123",
        modId: id,
        revision: "2",
      },
      checkSource: method("projectUpstream.checkSource"),
    })),
    check: method("projectUpstream.check"),
    start: method("projectUpstream.start"),
    cancel: method("projectUpstream.cancel", { job: null }),
  };
  const app = new EventEmitter();
  f.app = app;
  Object.assign(app, {
    setName: () => {},
    requestSingleInstanceLock: () => true,
    getPath: (name) => path.join(root, name),
    getVersion: () => "fixture",
    quit: () => {
      f.quitRequested = true;
      f.quitCount = (f.quitCount || 0) + 1;
    },
    whenReady: () => ({
      then: (callback) => {
        f.boot = Promise.resolve().then(callback);
        return f.boot;
      },
    }),
  });
  class FakeWindow extends EventEmitter {
    constructor(options) {
      super();
      f.window = this;
      this.options = options;
      this.title = options.title;
      this.closed = false;
      this.closeEvents = [];
      this.webContents = new EventEmitter();
      this.webContents.mainFrame = {};
      this.webContents.session = { setPermissionRequestHandler: () => {} };
      this.webContents.setWindowOpenHandler = () => {};
    }
    loadFile(file) {
      f.loadedFile = file;
    }
    setTitle(title) {
      this.title = title;
    }
    show() {
      f.showRequested = true;
    }
    close() {
      const event = {
        prevented: false,
        preventDefault() {
          this.prevented = true;
        },
      };
      this.closeEvents.push(event);
      this.emit("close", event);
      if (!event.prevented) {
        this.closed = true;
        this.emit("closed");
      }
    }
    isMinimized() {
      return false;
    }
    isMaximized() {
      return false;
    }
    restore() {}
    focus() {}
    minimize() {}
    maximize() {}
    unmaximize() {}
  }
  const fakeElectron = {
    app,
    BrowserWindow: FakeWindow,
    ipcMain: {
      handle: (name, handler) => {
        assert.equal(f.handlers.has(name), false, "IPC names must be unique");
        f.handlers.set(name, handler);
      },
    },
    dialog: {
      showOpenDialog: method("dialog.open", {
        canceled: false,
        filePaths: [path.join(root, "selected-directory")],
      }),
      showSaveDialog: method("dialog.save", { canceled: true }),
      showMessageBox: method("dialog.message", { response: 0 }),
    },
    clipboard: {
      writeText: () => {
        throw new Error("Unexpected real clipboard request");
      },
    },
    shell: {
      openExternal: method("shell.external"),
      openPath: method("shell.path", ""),
    },
    safeStorage: {
      encryptString: () => {
        throw new Error("Unexpected credential access");
      },
      decryptString: () => {
        throw new Error("Unexpected credential access");
      },
      isEncryptionAvailable: () => false,
    },
    utilityProcess: {
      fork: () => {
        throw new Error("Native worker spawning is forbidden in this fixture");
      },
    },
  };
  const factories = {
    "./launcher-updater.cjs": {
      createLauncherUpdater: (config) => {
        f.configs.updater = config;
        return {
          getState: method("updater.getState", {
            status: "ready",
            canInstall: true,
          }),
          check: method("updater.check"),
          download: method("updater.download"),
          cancel: method("updater.cancel"),
          install: async () => {
            await config.beforeInstall();
            return call("updater.install", [], { started: true });
          },
          dispose: method("updater.dispose"),
        };
      },
    },
    "./mod-coverage.cjs": {
      createModCoverageService: (config) => {
        f.configs.coverage = config;
        return Object.fromEntries([
          ["isBusy", () => f.flags.coverageBusy || false],
          ...["scan", "getProgress", "cancel", "readEvidence"].map((name) => [
            name,
            method("coverage." + name),
          ]),
        ]);
      },
    },
    "./playset-snapshots.cjs": {
      createPlaysetSnapshotService: (config) => {
        f.configs.snapshots = config;
        return Object.fromEntries([
          ["isBusy", () => f.flags.snapshotsBusy || false],
          ...[
            "list",
            "getProgress",
            "cancel",
            "create",
            "verify",
            "restore",
            "resolveDirectory",
          ].map((name) => [name, method("snapshots." + name)]),
        ]);
      },
    },
    "./campaigns.cjs": {
      createCampaignService: (config) => {
        f.configs.campaigns = config;
        return Object.fromEntries([
          ["isBusy", () => f.flags.campaignsBusy || false],
          ...[
            "list",
            "getProgress",
            "cancel",
            "bind",
            "update",
            "review",
            "reviewCurrent",
            "resolveContinue",
            "acceptEnvironment",
            "restoreConfiguration",
            "backup",
            "restoreBackup",
            "resolveSave",
          ].map((name) => [name, method("campaigns." + name)]),
        ]);
      },
    },
    "./game-performance.cjs": {
      createGamePerformanceService: (config) => {
        f.configs.performance = config;
        return {
          getState: method("performance.getState", {
            enabled: true,
            supported: true,
            intervalMs: 5000,
            sessions: [],
            notice: null,
          }),
          getSession: method("performance.getSession"),
          setEnabled: method("performance.setEnabled"),
          setNotes: method("performance.setNotes"),
          compareSessions: method("performance.compareSessions"),
          startSession: method("performance.startSession", {
            id: "fixture-session",
            status: "recording",
          }),
        };
      },
    },
    "./diagnostic-message.cjs": require("../electron/diagnostic-message.cjs"),
    "./native-i18n.cjs": require("../electron/native-i18n.cjs"),
    "./diagnostics-archive.cjs": require("../electron/diagnostics-archive.cjs"),
    "./diagnostics-log.cjs": {
      sanitizeDiagnosticEvent: require("../electron/diagnostics-log.cjs")
        .sanitizeDiagnosticEvent,
      createDiagnosticsLog: (config) => {
        f.configs.diagnostics = config;
        return {
          record: (event) => {
            f.logEvents.push({ ...event });
            return true;
          },
          snapshot: method("diagnostics.snapshot", () => ({
            schemaVersion: 1,
            directory: config.storageDirectory,
            limits: { maxFileBytes: 2097152, maxFiles: 3, maxPending: 64 },
            status: {
              available: true,
              reason: null,
              closed: false,
              droppedEvents: 0,
              writeFailures: 0,
              issues: [],
            },
            files: [],
          })),
          close: method("diagnostics.close", { available: true, closed: true }),
        };
      },
    },
    "./launcher-service.cjs": {
      createLauncherService: (config) => {
        f.configs.launcher = config;
        return launcher;
      },
    },
    "./display-service.cjs": {
      createDisplayService: () => ({
        getDisplays: method("display.getDisplays", []),
      }),
    },
    "./news-service.cjs": {
      createNewsService: () => ({
        getNews: method("news.getNews", { items: [] }),
      }),
    },
    "./mod-catalog.cjs": {
      createModCatalogService: () => ({
        search: method("catalog.search", { items: [] }),
      }),
    },
    "./account-service.cjs": {
      createAccountService: () =>
        Object.fromEntries(
          ["getAccount", "login", "logout", "cancelLogin"].map((name) => [
            name,
            method("account." + name),
          ]),
        ),
    },
    "./steam-worker-client.cjs": {
      createSteamWorkerClient: (config) => {
        f.configs.steam = config;
        return {
          call: method("steam.call"),
          disconnect: method("steam.disconnect"),
          dispose: method("steam.dispose"),
        };
      },
    },
    "./steam-missing.cjs": {
      createSteamMissingService: (config) => {
        f.configs.steamMissing = config;
        return steamMissing;
      },
    },
    "./mod-projects.cjs": {
      createModProjectService: (config) => {
        f.configs.projects = config;
        return projects;
      },
    },
    "./mod-project-upstream.cjs": {
      createModProjectUpstream: (config) => {
        f.configs.projectUpstream = config;
        return projectUpstream;
      },
      verifyManagedProjectSource: method("projects.verifySource"),
    },
    "./mod-project-controller.cjs": {
      // The controller has no filesystem/native effects of its own. Using it
      // here exercises the actual named IPC boundary with only mock delegates.
      createModProjectController: (config) => {
        f.configs.projectController = config;
        return require("../electron/mod-project-controller.cjs").createModProjectController(
          config,
        );
      },
    },
    "./publish-service.cjs": {
      createPublishService: (config) => {
        const name =
          config.provider === "pdx" ? "pdxPublisher" : "steamPublisher";
        f.configs[name] = config;
        return publisher(name);
      },
    },
    "./pdx-content.cjs": {
      createPdxContentService: (config) => {
        f.configs.content = config;
        return {};
      },
    },
    "./pdx-install.cjs": {
      createPdxInstallService: (config) => {
        f.configs.installer = config;
        return { recover: method("installer.recover") };
      },
    },
    "./pdx-downloads.cjs": {
      createPdxDownloads: (config) => {
        f.configs.downloads = config;
        return downloads;
      },
    },
    "./pdx-archive-cache.cjs": {
      createPdxArchiveCache: (config) => {
        f.configs.archiveCache = config;
        return { put: method("archiveCache.put") };
      },
    },
    "./pdx-relocation.cjs": {
      createPdxRelocation: (config) => {
        f.configs.relocation = config;
        return relocation;
      },
    },
    "./pdx-subscriptions.cjs": {
      createPdxSubscriptions: () =>
        Object.fromEntries(
          ["getState", "subscribe", "unsubscribe"].map((name) => [
            name,
            method("subscriptions." + name),
          ]),
        ),
    },
    "./pdx-publisher.cjs": {
      createPdxPublisher: () => ({ dispose: method("pdxBackend.dispose") }),
    },
    "./publish-archive.cjs": {
      createPublishArchiveService: () => ({
        createArchive: method("archives.createArchive"),
      }),
    },
  };
  const context = vm.createContext({
    require(name) {
      if (name === "electron") return fakeElectron;
      if (name === "node:path") return path;
      if (name === "node:fs/promises")
        return new Proxy(
          {},
          {
            get:
              (_object, operation) =>
              (...args) => {
                const name = "fs." + String(operation);
                if (Object.hasOwn(f.hooks, name)) return call(name, args);
                throw new Error(
                  "Filesystem operation forbidden: " + String(operation),
                );
              },
          },
        );
      if (Object.hasOwn(factories, name)) return factories[name];
      throw new Error("Unmocked main dependency: " + name);
    },
    __dirname: path.dirname(mainPath),
    process: {
      versions: { electron: "fixture", node: "fixture" },
      platform: "win32",
      arch: "x64",
    },
    console,
    setTimeout: () => {
      throw new Error("Unexpected application timer");
    },
  });
  new vm.Script(mainSource, { filename: mainPath }).runInContext(context);
  await f.boot;
  f.count = (name) => f.calls.filter((item) => item.name === name).length;
  f.invokeAs = (name, event, ...args) => {
    const handler = f.handlers.get(name);
    assert.ok(handler, "Missing actual main IPC handler: " + name);
    return handler(event, ...args);
  };
  f.invoke = (name, ...args) =>
    f.invokeAs(
      name,
      {
        sender: f.window.webContents,
        senderFrame: f.window.webContents.mainFrame,
      },
      ...args,
    );
  t.after(() => app.emit("will-quit"));
  return f;
}

test("launcher update install guards file tasks and the running game before requesting exit", async (t) => {
  const f = await fixture(t);
  for (const flag of [
    "gameRunning",
    "downloadsBusy",
    "projectsBusy",
    "projectUpstreamBusy",
    "steamPublishing",
    "pdxPublishing",
    "steamMissingBusy",
    "relocationBusy",
    "campaignsBusy",
    "snapshotsBusy",
    "coverageBusy",
  ]) {
    f.flags[flag] = true;
    await assert.rejects(f.invoke("update:install"));
    assert.equal(f.count("updater.install"), 0, flag);
    assert.equal(f.quitRequested, undefined, flag);
    f.flags[flag] = false;
  }
  await f.invoke("update:install");
  assert.equal(f.count("updater.install"), 1);
  assert.equal(f.quitRequested, true);
});

test("launcher update install failure permits retry without quitting", async (t) => {
  const f = await fixture(t);
  f.hooks["updater.install"] = () => {
    throw new Error("helper failed");
  };
  await assert.rejects(f.invoke("update:install"), /helper failed/);
  assert.equal(f.quitRequested, undefined);
  await f.invoke("launcher:save", { test: true });
  delete f.hooks["updater.install"];
  await f.invoke("update:install");
  assert.equal(f.quitRequested, true);
});

test("launcher update reserves the exit gate while preparing and rejects in-flight mutations", async (t) => {
  const f = await fixture(t);
  const pendingSave = gate(t);
  f.hooks["launcher.saveSettings"] = () => pendingSave.promise;
  const saving = f.invoke("launcher:save", { test: true });
  await until(() => f.count("launcher.saveSettings") === 1);
  await assert.rejects(f.invoke("update:install"), /其他操作/);
  assert.equal(f.count("updater.install"), 0);
  pendingSave.resolve({ launcherPreferences: {} });
  await saving;
  const pendingInstall = gate(t);
  f.hooks["updater.install"] = () => pendingInstall.promise;
  const installing = f.invoke("update:install");
  await until(() => f.count("updater.install") === 1);
  await assert.rejects(
    f.invoke("launcher:save", { test: true }),
    /正在安装启动器更新/,
  );
  await assert.rejects(f.invoke("launcher:launch"), /正在安装启动器更新/);
  await assert.rejects(f.invoke("update:install"), /正在安装启动器更新/);
  const eventsBefore = f.logEvents.length;
  await f.invoke("update:state");
  assert.equal(
    f.logEvents.length,
    eventsBefore,
    "polling updates does not fill diagnostics logs",
  );
  pendingInstall.resolve({ started: true });
  await installing;
  assert.equal(f.quitRequested, true);
});

test("launcher updates use only the fixed repository release page and cancel on exit", async (t) => {
  const f = await fixture(t);
  await f.invoke("update:releases", "https://untrusted.invalid");
  assert.deepEqual(
    f.calls.find((entry) => entry.name === "shell.external").args,
    ["https://github.com/SakuraLoveSmile/HOI4-Launcher/releases"],
  );
  f.app.emit("will-quit");
  assert.equal(f.count("updater.dispose"), 1);
});

const guardedOperations = [
  ["launcher:detect", [], "launcher.detectGame"],
  [
    "launcher:save",
    [{ gameDirectory: "fixture-path" }],
    "launcher.saveSettings",
  ],
  ["launcher:choose", [], "dialog.open"],
  ["instances:create", [{ name: "旧版本" }], "launcher.createGameInstance"],
  ["instances:switch", ["default"], "launcher.switchGameInstance"],
  [
    "instances:rename",
    [{ id: "default", name: "默认" }],
    "launcher.renameGameInstance",
  ],
  ["instances:remove", ["old-version"], "launcher.removeGameInstance"],
  ["mods:update", ["workshop:123"], "steam.call"],
  ["mods:delete", ["workshop:123"], "launcher.forgetMod"],
  ["maintenance:clear", [["shader-cache"]], "launcher.clearCache"],
  ["maintenance:restore", ["backup-1"], "launcher.restoreCacheBackup"],
  ["publish:prepare", [{ modId: "local:fixture" }], "steamPublisher.prepare"],
  ["publish:commit", ["plan-1"], "steamPublisher.commit"],
  ["pdx-publish:prepare", [{ modId: "local:fixture" }], "pdxPublisher.prepare"],
  ["pdx-publish:commit", ["plan-1"], "pdxPublisher.commit"],
  ["steam-missing:prepare", [{ playsetId: "default" }], "steamMissing.prepare"],
  ["steam-missing:commit", ["reviewed-plan"], "steamMissing.commit"],
];

test("campaign binding accepts only native-selected saves and reserves the operation during the picker", async (t) => {
  const f = await fixture(t),
    picker = gate(t);
  await assert.rejects(
    f.invoke("campaigns:bind", { savePath: "renderer-selected.hoi4" }),
    /参数无效/,
  );
  assert.equal(f.count("dialog.open"), 0);
  f.hooks["dialog.open"] = () => picker.promise;
  const pending = f.invoke("campaigns:bind", {
    name: "Campaign",
    notes: "Notes",
  });
  await until(() => f.count("dialog.open") === 1);
  await assert.rejects(f.invoke("launcher:launch", {}), /文件/);
  await assert.rejects(
    f.invoke("launcher:save", { launchMode: "debug" }),
    /处理文件/,
  );
  picker.resolve({
    canceled: false,
    filePaths: [path.join(f.userData, "save games", "selected.hoi4")],
  });
  await pending;
  assert.equal(
    f.calls.find((c) => c.name === "campaigns.bind").args[0].savePath,
    path.join(f.userData, "save games", "selected.hoi4"),
  );
});

test("a campaign continue resolves a reviewed identity and never accepts a renderer save path", async (t) => {
  const f = await fixture(t);
  f.hooks["campaigns.resolveContinue"] = async () => ({
    filename: "reviewed.hoi4",
  });
  await assert.rejects(
    f.invoke("launcher:launch", {
      saveFilename: "injected.hoi4",
      resume: true,
    }),
    /无效/,
  );
  await f.invoke("launcher:launch", {
    campaignId: "campaign",
    reviewId: "review",
  });
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(
        f.calls.find((c) => c.name === "launcher.launchGame").args[0],
      ),
    ),
    { resume: true, saveFilename: "reviewed.hoi4" },
  );
});

test("campaign checks exclude launches and configuration changes while cancellation stays available", async (t) => {
  const f = await fixture(t);
  f.flags.campaignsBusy = true;
  await assert.rejects(f.invoke("launcher:launch", {}), /战役档案/);
  await assert.rejects(
    f.invoke("launcher:save", { activePlaysetId: "other" }),
    /检查配置/,
  );
  await assert.rejects(f.invoke("instances:switch", "other"), /战役档案/);
  await f.invoke("campaigns:progress");
  await f.invoke("campaigns:cancel");
  assert.equal(f.count("campaigns.getProgress"), 1);
  assert.equal(f.count("campaigns.cancel"), 1);
});

test("snapshot creation reserves game and file operations until its promise settles", async (t) => {
  const f = await fixture(t),
    copying = gate(t);
  f.hooks["snapshots.create"] = () => copying.promise;
  const pending = f.invoke("snapshots:create", { name: "Stable combination" });
  await until(() => f.count("snapshots.create") === 1);
  await assert.rejects(f.invoke("launcher:launch", {}), /文件/);
  await assert.rejects(
    f.invoke("launcher:save", { launchMode: "debug" }),
    /处理文件/,
  );
  await assert.rejects(f.invoke("campaigns:backup", "campaign"), /文件/);
  await f.invoke("snapshots:progress");
  await f.invoke("snapshots:cancel");
  copying.resolve({ id: "snapshot" });
  await pending;
  assert.equal(f.count("snapshots.getProgress"), 1);
  assert.equal(f.count("snapshots.cancel"), 1);
  await f.invoke("launcher:save", { launchMode: "debug" });
  assert.equal(f.count("launcher.saveSettings"), 1);
});

test("snapshot work blocks reverse instance switches and folder requests resolve only recorded IDs", async (t) => {
  const f = await fixture(t);
  f.flags.snapshotsBusy = true;
  await assert.rejects(f.invoke("instances:switch", "other"), /组合快照/);
  await assert.rejects(f.invoke("launcher:launch", {}), /组合快照/);
  f.flags.snapshotsBusy = false;
  f.hooks["snapshots.resolveDirectory"] = async (id) => {
    assert.equal(id, "known-snapshot");
    return path.join(f.root, "snapshots", "known-snapshot");
  };
  await f.invoke("snapshots:folder", "known-snapshot");
  assert.equal(
    f.calls.find((c) => c.name === "shell.path").args[0],
    path.join(f.root, "snapshots", "known-snapshot"),
  );
});

test("download IPC shares the active account service with its content provider without exposing credentials", async (t) => {
  const f = await fixture(t);
  assert.ok(f.configs.downloads.account);
  assert.equal(f.configs.content.account, f.configs.downloads.account);
  assert.equal(typeof f.configs.downloads.archiveCache.put, "function");
  assert.equal(
    path.basename(f.configs.archiveCache.storageDirectory),
    "archives",
  );
  assert.equal(f.handlers.has("pdx:archive-cache"), false);
  await f.configs.downloads.account.logout();
  assert.equal(f.count("account.logout"), 1);
  const input = { modId: "123", revision: "1", authorization: "account" };
  await f.invoke("pdx:download", input);
  assert.equal(
    f.calls.find((call) => call.name === "downloads.start").args[0],
    input,
  );
  assert.equal(f.handlers.has("account:request"), false);
  assert.equal(f.handlers.has("account:bindSession"), false);
});

test("actual named IPC handlers reject foreign senders and subframes before invoking migration", async (t) => {
  const f = await fixture(t);
  for (const name of [
    "pdx-storage:state",
    "pdx-storage:prepare",
    "pdx-storage:commit",
    "pdx-storage:discard",
    "pdx-storage:cancel",
    "pdx-storage:recover",
    "pdx:pause",
    "pdx:resume",
    "mods:thumbnail",
    "steam-missing:state",
    "steam-missing:prepare",
    "steam-missing:commit",
    "steam-missing:cancel",
    "launcher:launch",
    "performance:state",
    "performance:session",
    "performance:enabled",
    "performance:notes",
    "performance:compare",
    "coverage:scan",
    "coverage:progress",
    "coverage:cancel",
    "coverage:evidence",
    ...Array.from(f.handlers.keys()).filter(
      (name) => name.startsWith("projects:") || name.startsWith("update:"),
    ),
  ]) {
    await assert.rejects(
      f.invokeAs(
        name,
        { sender: {}, senderFrame: f.window.webContents.mainFrame },
        { reset: true },
      ),
      /无法识别/,
    );
    await assert.rejects(
      f.invokeAs(
        name,
        { sender: f.window.webContents, senderFrame: {} },
        { reset: true },
      ),
      /无法识别/,
    );
  }
  assert.equal(f.calls.length, 0);
  assert.equal(f.window.options.show, false);
  assert.equal(f.showRequested, undefined);
});

test("migration busy and recovery blocks prevent all actual mutation IPC delegates", async (t) => {
  for (const flag of ["relocationBusy", "recovery"]) {
    const f = await fixture(t);
    f.flags[flag] = true;
    for (const [channel, args, delegate] of guardedOperations) {
      await assert.rejects(f.invoke(channel, ...args), /迁移|恢复/);
      assert.equal(
        f.count(delegate),
        0,
        `${channel} must fail before ${delegate}`,
      );
    }
    await assert.rejects(f.invoke("launcher:launch", {}), /迁移|恢复/);
    assert.equal(f.count("launcher.launchGame"), 0);
  }
});

test("unrelated settings and read-only state remain available during migration", async (t) => {
  const f = await fixture(t);
  f.flags.relocationBusy = true;
  await f.invoke("launcher:save", { launchMode: "debug" });
  await f.invoke("launcher:state");
  await f.invoke("pdx-storage:state");
  await f.invoke("maintenance:plan");
  await f.invoke("maintenance:list");
  assert.equal(
    (await f.invoke("mods:thumbnail", "local:example.mod")).dataUrl,
    "fixture",
  );
  assert.deepEqual(
    f.calls.find((call) => call.name === "launcher.getModThumbnail").args,
    ["local:example.mod"],
  );
  assert.equal(f.count("launcher.saveSettings"), 1);
  assert.equal(f.count("relocation.getState"), 1);
});

test("download and uninstall receive a live migration guard through the actual factory wiring", async (t) => {
  const f = await fixture(t);
  assert.equal(typeof f.configs.downloads.assertOperationAllowed, "function");
  for (const flag of ["relocationBusy", "recovery"]) {
    f.flags[flag] = true;
    assert.throws(
      () => f.configs.downloads.assertOperationAllowed(),
      /迁移|恢复/,
    );
    await assert.rejects(
      f.invoke("pdx:download", { modId: "123" }),
      /迁移|恢复/,
    );
    await assert.rejects(f.invoke("pdx:uninstall", "123"), /迁移|恢复/);
    await assert.rejects(f.invoke("pdx:resume"), /迁移|恢复/);
    f.flags[flag] = false;
  }
  assert.equal(f.count("downloads.start"), 0);
  assert.equal(f.count("downloads.uninstall"), 0);
  assert.equal(f.count("downloads.resume"), 0);
  await f.invoke("pdx:download", { modId: "123" });
  await f.invoke("pdx:uninstall", "123");
  await f.invoke("pdx:resume");
  await f.invoke("pdx:pause");
  assert.equal(f.count("downloads.start"), 1);
  assert.equal(f.count("downloads.uninstall"), 1);
  assert.equal(f.count("downloads.resume"), 1);
  assert.equal(f.count("downloads.pause"), 1);
});

test("performance IPC uses the protected bridge without logging high-frequency reads", async (t) => {
  const f = await fixture(t);
  const state = await f.invoke("performance:state");
  assert.equal(state.enabled, true);
  await f.invoke("performance:session", "chosen-id");
  await f.invoke("performance:enabled", false);
  await f.invoke("performance:notes", "chosen-id", "user note");
  await f.invoke("performance:compare", "chosen-id", "other-id");
  assert.deepEqual(
    f.calls.find((item) => item.name === "performance.setNotes").args,
    ["chosen-id", "user note"],
  );
  assert.deepEqual(
    f.calls.find((item) => item.name === "performance.compareSessions").args,
    ["chosen-id", "other-id"],
  );
  assert.deepEqual(
    f.calls.find((item) => item.name === "performance.getSession").args,
    ["chosen-id"],
  );
  assert.deepEqual(
    f.calls.find((item) => item.name === "performance.setEnabled").args,
    [false],
  );
  assert.equal(
    f.logEvents.some(
      (item) =>
        item.action === "performance:state" ||
        item.action === "performance:session" ||
        item.action === "performance:compare",
    ),
    false,
  );
  assert.equal(
    f.logEvents.some(
      (item) => item.action === "performance:enabled" && item.result === "ok",
    ),
    true,
  );
  assert.equal(
    f.configs.performance.storageDirectory,
    path.join(f.root, "userData", "game-performance"),
  );
});

test("performance collection starts only after launch and its failure cannot undo a running game", async (t) => {
  const f = await fixture(t);
  f.hooks["performance.startSession"] = () => {
    throw new Error("Sampler failed");
  };
  const result = await f.invoke("launcher:launch", {});
  assert.equal(result.launched, true);
  assert.equal(f.count("launcher.launchGame"), 1);
  assert.equal(f.count("performance.startSession"), 1);
  assert.ok(
    f.calls.findIndex((item) => item.name === "launcher.launchGame") <
      f.calls.findIndex((item) => item.name === "performance.startSession"),
  );
  const input = f.calls.find((item) => item.name === "performance.startSession")
    .args[0];
  assert.equal(input.pid, result.pid);
  assert.equal(input.executable, result.executable);
  assert.equal(input.playsetName, "Campaign");
  assert.equal(input.modCount, 3);
  assert.equal(f.count("launcher.getState"), 0);
  assert.ok(
    f.logEvents.some(
      (event) =>
        event.action === "performance:start" && event.result === "error",
    ),
  );
});

test("a failed game launch never creates a performance session", async (t) => {
  const f = await fixture(t);
  f.hooks["launcher.launchGame"] = () => {
    throw new Error("Launch rejected");
  };
  await assert.rejects(f.invoke("launcher:launch", {}), /Launch rejected/);
  assert.equal(f.count("performance.startSession"), 0);
});

test("launch awaits installation recovery then relocation readiness before launching", async (t) => {
  const f = await fixture(t),
    installGate = gate(t),
    relocationGate = gate(t);
  f.hooks["downloads.ready"] = () => installGate.promise;
  f.hooks["relocation.assertReady"] = () => relocationGate.promise;
  const pending = f.invoke("launcher:launch", { playsetId: "fixture" });
  await until(() => f.count("downloads.ready") === 1);
  assert.equal(f.count("relocation.assertReady"), 0);
  assert.equal(f.count("launcher.launchGame"), 0);
  installGate.resolve();
  await until(() => f.count("relocation.assertReady") === 1);
  assert.equal(f.count("launcher.launchGame"), 0);
  relocationGate.resolve();
  assert.equal((await pending).launched, true);
  assert.equal(f.count("launcher.launchGame"), 1);
});

test("failed installation recovery prevents relocation checks and launch", async (t) => {
  const f = await fixture(t);
  f.hooks["downloads.ready"] = async () => {
    throw new Error("installation recovery failed");
  };
  await assert.rejects(
    f.invoke("launcher:launch", {}),
    /installation recovery failed/,
  );
  assert.equal(f.count("relocation.assertReady"), 0);
  assert.equal(f.count("launcher.launchGame"), 0);
});

test("a migration starting while launch readiness is awaited is rejected by the final guard", async (t) => {
  const f = await fixture(t),
    readyGate = gate(t);
  f.hooks["relocation.assertReady"] = () => readyGate.promise;
  const pending = f.invoke("launcher:launch", {});
  await until(() => f.count("relocation.assertReady") === 1);
  f.flags.relocationBusy = true;
  readyGate.resolve();
  await assert.rejects(pending, /迁移|恢复/);
  assert.equal(f.count("launcher.launchGame"), 0);
});

test("a download starting during awaited relocation readiness cannot race game launch", async (t) => {
  const f = await fixture(t),
    readyGate = gate(t);
  f.hooks["relocation.assertReady"] = () => readyGate.promise;
  const pending = f.invoke("launcher:launch", {});
  await until(() => f.count("relocation.assertReady") === 1);
  f.flags.downloadsBusy = true;
  readyGate.resolve();
  await assert.rejects(pending, /下载|安装|模组操作/);
  assert.equal(f.count("launcher.launchGame"), 0);
});

test("launch reservation reaches installer, downloads and relocation running callbacks", async (t) => {
  const f = await fixture(t),
    launchGate = gate(t);
  f.hooks["launcher.launchGame"] = () => launchGate.promise;
  const pending = f.invoke("launcher:launch", {});
  await until(() => f.count("launcher.launchGame") === 1);
  assert.equal(await f.configs.installer.isGameRunning(), true);
  assert.equal(await f.configs.downloads.isGameRunning(), true);
  assert.equal(await f.configs.relocation.isGameRunning(), true);
  assert.equal(await f.configs.projects.isGameRunning(), true);
  assert.equal(await f.configs.projectUpstream.isGameRunning(), true);
  launchGate.resolve({ launched: true });
  await pending;
  assert.equal(await f.configs.relocation.isGameRunning(), false);
  assert.equal(await f.configs.projects.isGameRunning(), false);
  assert.equal(await f.configs.projectUpstream.isGameRunning(), false);
});

test("project factories use source-only launcher scans and named version resolution without recursive project scans", async (t) => {
  const f = await fixture(t);
  f.projects = [{ id: "fixture-project", name: "Fixture project" }];
  assert.equal(await f.configs.launcher.getModProjects(), f.projects);
  assert.equal(f.count("projects.list"), 1);
  await f.configs.launcher.resolveProjectVersion(
    "fixture-project",
    "snapshot-1",
  );
  assert.deepEqual(
    f.calls.find((entry) => entry.name === "projects.resolveVersion").args,
    ["fixture-project", "snapshot-1"],
  );
  assert.equal(await f.configs.projects.getUserDataPath(), f.userData);
  assert.equal(
    (await f.configs.projectUpstream.getLauncherState()).paths.userData,
    f.userData,
  );
  assert.equal(f.count("launcher.getSourceState"), 2);
  assert.equal(f.count("launcher.getState"), 0);
  assert.equal(
    f.configs.projectController.projects,
    f.configs.projectUpstream.projects,
  );
  assert.equal(f.configs.projectUpstream.account, f.configs.downloads.account);
  assert.equal(
    path.basename(f.configs.projects.storageDirectory),
    "mod-projects",
  );
  assert.equal(
    path.basename(f.configs.projectUpstream.storageDirectory),
    "project-downloads",
  );
  f.gameFound = false;
  await assert.rejects(f.configs.projects.getUserDataPath(), /选择有效的 HOI4/);
});

test("creating a project with a known baseline binds source checks and main-process original verification", async (t) => {
  const f = await fixture(t);
  let accepted = 0;
  f.hooks["projects.create"] = async (input) => {
    await input.checkSource();
    accepted++;
    return { name: input.name, baselineKnown: input.baselineKnown };
  };
  const request = { modId: "pdx:123", name: "My fork", baselineKnown: true };
  const result = await f.invoke("projects:create-mod-project", request);
  assert.equal(result.name, "My fork");
  assert.equal(accepted, 1);
  assert.equal(
    f.calls.find((entry) => entry.name === "projectUpstream.sourceForMod")
      .args[1].requireStable,
    true,
  );
  assert.equal(f.count("projectUpstream.checkSource"), 1);
  assert.equal(f.count("projects.verifySource"), 1);
  const verified = f.calls.find(
    (entry) => entry.name === "projects.verifySource",
  ).args;
  assert.equal(verified[1], "pdx:123");
  assert.equal(verified[2].sourcePath, path.join(f.root, "original-content"));
  assert.equal(typeof verified[0].installer.recover, "function");
  assert.equal(
    (await verified[0].getLauncherState()).paths.userData,
    f.userData,
  );
  assert.equal(f.count("launcher.getState"), 0);
  f.hooks["projects.verifySource"] = async () => {
    throw new Error("original validation failed");
  };
  await assert.rejects(
    f.invoke("projects:create-mod-project", request),
    /original validation failed/,
  );
  assert.equal(accepted, 1);
  const checks = f.count("projects.verifySource");
  await f.invoke("projects:create-mod-project", {
    ...request,
    baselineKnown: false,
  });
  assert.equal(accepted, 2);
  assert.equal(f.count("projects.verifySource"), checks);
  assert.equal(f.count("steam.call"), 0);
});

test("project work and upstream retrieval exclude launch and competing mutations while state and cancellation remain available", async (t) => {
  for (const flag of ["projectsBusy", "projectUpstreamBusy"]) {
    const f = await fixture(t);
    f.flags[flag] = true;
    assert.equal(f.configs.relocation.isOtherBusy(), true);
    for (const [channel, args, delegate] of guardedOperations) {
      await assert.rejects(f.invoke(channel, ...args), /本地项目/);
      assert.equal(f.count(delegate), 0, channel);
    }
    await assert.rejects(f.invoke("launcher:launch", {}), /本地项目/);
    await assert.rejects(
      f.invoke("pdx:download", { modId: "123" }),
      /本地项目/,
    );
    await assert.rejects(
      f.invoke("projects:checkpoint-mod-project", "project-1", "checkpoint"),
      /本地项目/,
    );
    assert.equal(f.count("launcher.launchGame"), 0);
    assert.equal(f.count("downloads.start"), 0);
    assert.equal(f.count("projects.checkpoint"), 0);
    await f.invoke("projects:get-mod-projects");
    await f.invoke("projects:get-mod-project-upstream");
    await f.invoke("projects:cancel-mod-project-upstream");
    assert.equal(f.count("projects.list"), 1);
    assert.equal(f.count("projectUpstream.getState"), 1);
    assert.equal(f.count("projectUpstream.cancel"), 1);
    f.flags[flag] = false;
    assert.equal(f.configs.relocation.isOtherBusy(), false);
  }
});

test("project operations starting during awaited readiness cannot overtake the final launch guard", async (t) => {
  for (const flag of ["projectsBusy", "projectUpstreamBusy"]) {
    const f = await fixture(t),
      readiness = gate(t);
    f.hooks["relocation.assertReady"] = () => readiness.promise;
    const pending = f.invoke("launcher:launch", {});
    await until(() => f.count("relocation.assertReady") === 1);
    f.flags[flag] = true;
    readiness.resolve();
    await assert.rejects(pending, /本地项目/);
    assert.equal(f.count("launcher.launchGame"), 0);
  }
});

test("upstream retrieval receives live competing-operation guards without blocking its own reservation", async (t) => {
  const f = await fixture(t);
  f.flags.projectUpstreamBusy = true;
  assert.doesNotThrow(() => f.configs.projectUpstream.assertOperationAllowed());
  f.flags.projectUpstreamBusy = false;
  for (const flag of [
    "relocationBusy",
    "recovery",
    "steamMissingBusy",
    "downloadsBusy",
    "steamPublishing",
    "pdxPublishing",
  ]) {
    f.flags[flag] = true;
    assert.throws(
      () => f.configs.projectUpstream.assertOperationAllowed(),
      /迁移|恢复|Steam|下载或发布/,
    );
    f.flags[flag] = false;
  }
  f.flags.gameRunning = true;
  assert.equal(await f.configs.projects.isGameRunning(), true);
  assert.equal(await f.configs.projectUpstream.isGameRunning(), true);
});

test("asynchronous maintenance holds reverse migration exclusion and clears it on success or failure", async (t) => {
  for (const [channel, delegate, args] of [
    ["maintenance:clear", "launcher.clearCache", [["cache"]]],
    ["maintenance:restore", "launcher.restoreCacheBackup", ["backup"]],
  ]) {
    for (const shouldFail of [false, true]) {
      const f = await fixture(t),
        operationGate = gate(t);
      f.hooks[delegate] = async () => {
        await operationGate.promise;
        if (shouldFail) throw new Error("maintenance fixture failure");
        return true;
      };
      const pending = f.invoke(channel, ...args);
      await until(() => f.count(delegate) === 1);
      assert.equal(f.configs.relocation.isOtherBusy(), true);
      await assert.rejects(
        f.invoke("pdx-storage:prepare", { reset: true }),
        /维护|等待/,
      );
      await assert.rejects(f.invoke("launcher:launch", {}), /维护|等待/);
      assert.equal(f.count("relocation.prepare"), 0);
      operationGate.resolve();
      if (shouldFail)
        await assert.rejects(pending, /maintenance fixture failure/);
      else await pending;
      assert.equal(f.configs.relocation.isOtherBusy(), false);
    }
  }
});

test("detect and save hold reverse migration exclusion across asynchronous directory changes", async (t) => {
  for (const [channel, delegate, args] of [
    ["launcher:detect", "launcher.detectGame", []],
    [
      "launcher:save",
      "launcher.saveSettings",
      [{ gameDirectory: "fixture-directory" }],
    ],
  ]) {
    const f = await fixture(t),
      operationGate = gate(t);
    f.hooks[delegate] = async () => {
      await operationGate.promise;
      throw new Error("directory fixture failure");
    };
    const pending = f.invoke(channel, ...args);
    await until(() => f.count(delegate) === 1);
    assert.equal(f.configs.relocation.isOtherBusy(), true);
    await assert.rejects(
      f.invoke("pdx-storage:prepare", { reset: true }),
      /切换|等待/,
    );
    await assert.rejects(f.invoke("maintenance:clear", []), /切换|等待/);
    operationGate.resolve();
    await assert.rejects(pending, /directory fixture failure/);
    assert.equal(f.configs.relocation.isOtherBusy(), false);
  }
});

test("choosing a game directory reserves while the native dialog is pending and releases on cancel", async (t) => {
  const f = await fixture(t),
    dialogGate = gate(t);
  f.hooks["dialog.open"] = () => dialogGate.promise;
  const pending = f.invoke("launcher:choose");
  await until(() => f.count("dialog.open") === 1);
  assert.equal(f.configs.relocation.isOtherBusy(), true);
  await assert.rejects(
    f.invoke("pdx-storage:prepare", { reset: true }),
    /切换|等待/,
  );
  dialogGate.resolve({ canceled: true, filePaths: [] });
  assert.equal(await pending, null);
  assert.equal(f.count("launcher.saveSettings"), 0);
  assert.equal(f.configs.relocation.isOtherBusy(), false);
});

test("instance creation accepts only a name and binds the installation to a native selection", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.invoke("instances:create", {
      name: "old",
      gameDirectory: "renderer-path",
    }),
    /名称/,
  );
  assert.equal(f.count("dialog.open"), 0);
  const selected = path.join(f.root, "old-game");
  f.hooks["dialog.open"] = async () => ({
    canceled: false,
    filePaths: [selected],
  });
  await f.invoke("instances:create", { name: "1.10" });
  const call = f.calls.find(
    (item) => item.name === "launcher.createGameInstance",
  );
  assert.equal(call.args[0].name, "1.10");
  assert.equal(call.args[0].gameDirectory, selected);
  f.hooks["dialog.open"] = async () => ({ canceled: true, filePaths: [] });
  assert.equal(await f.invoke("instances:create", { name: "cancel" }), null);
  assert.equal(f.count("launcher.createGameInstance"), 1);
});

test("mod display-name IPC delegates only identifiers and keeps original metadata out of the renderer's control", async (t) => {
  const f = await fixture(t);
  const input = { modId: "workshop:123", name: "中文名", kind: "translated" };
  await f.invoke("mods:display-name", input);
  await f.invoke("mods:reset-name", "workshop:123");
  assert.equal(
    f.calls.find((call) => call.name === "launcher.setModDisplayName").args[0],
    input,
  );
  assert.equal(
    f.calls.find((call) => call.name === "launcher.resetModDisplayName")
      .args[0],
    "workshop:123",
  );
  assert.equal(f.count("steam.call"), 0);
});

test("Chinese names use the existing Steam title query and never send arbitrary text to a translation provider", async (t) => {
  const f = await fixture(t);
  f.mods = [
    {
      id: "workshop:123",
      source: "workshop",
      remoteId: "123",
      originalName: "English title",
    },
  ];
  f.hooks["steam.call"] = async (method, id, options) =>
    method === "getState"
      ? { connected: true }
      : { name: options?.language === "schinese" ? "工坊中文名" : "ignored" };
  assert.equal(
    (await f.invoke("mods:localized-name", "workshop:123")).name,
    "工坊中文名",
  );
  const lookup = f.calls.find(
    (call) => call.name === "steam.call" && call.args[0] === "getItem",
  );
  assert.equal(lookup.args[1], "123");
  assert.equal(lookup.args[2].language, "schinese");
  f.mods[0].originalName = "已有中文";
  const before = f.count("steam.call");
  assert.equal(
    (await f.invoke("mods:localized-name", "workshop:123")).name,
    "已有中文",
  );
  assert.equal(f.count("steam.call"), before);
  await assert.rejects(f.invoke("mods:localized-name", "missing"), /未找到/);
});

test("Steam context actions reserve switching and launch while a request is pending", async (t) => {
  const f = await fixture(t),
    request = gate(t);
  f.mods = [
    {
      id: "workshop:123",
      source: "workshop",
      remoteId: "123",
      canDelete: true,
    },
  ];
  f.hooks["steam.call"] = async (method) =>
    method === "getState" ? { connected: true } : request.promise;
  const updating = f.invoke("mods:update", "workshop:123");
  await until(() =>
    f.calls.some(
      (call) => call.name === "steam.call" && call.args[0] === "download",
    ),
  );
  await assert.rejects(f.invoke("instances:switch", "default"), /维护|等待/);
  await assert.rejects(f.invoke("launcher:launch", {}), /维护|等待/);
  request.resolve({ connected: true });
  await updating;
  const download = f.calls.find(
    (call) => call.name === "steam.call" && call.args[0] === "download",
  );
  assert.equal(download.args[1], "123");
});

test("context updates retain PDX pins and bind update and uninstall to the scanned user directory", async (t) => {
  const f = await fixture(t);
  f.mods = [{ id: "pdx:123", source: "pdx", remoteId: "123", canDelete: true }];
  f.settings.activePlaysetId = "campaign";
  f.settings.playsets = [
    { id: "campaign", modReferences: [{ id: "pdx:123", version: "3" }] },
  ];
  await f.invoke("mods:update", "pdx:123");
  const start = f.calls.find((call) => call.name === "downloads.start");
  assert.equal(start.args[0].revision, "3");
  assert.equal(start.args[1], f.userData);
  await f.invoke("mods:delete", "pdx:123");
  const uninstall = f.calls.find((call) => call.name === "downloads.uninstall");
  assert.equal(uninstall.args[0], "123");
  assert.equal(uninstall.args[1], f.userData);
  const forget = f.calls.find((call) => call.name === "launcher.forgetMod");
  assert.equal(forget.args[0], "pdx:123");
  assert.equal(forget.args[1], f.userData);
});

test("context delete respects source capabilities and running-game exclusion before native writes", async (t) => {
  const f = await fixture(t);
  f.mods = [
    { id: "local:owned.mod", source: "local", canDelete: true },
    { id: "pdx:123", source: "pdx", canDelete: false },
  ];
  await assert.rejects(f.invoke("mods:delete", "pdx:123"), /不能通过右键/);
  f.flags.gameRunning = true;
  await assert.rejects(f.invoke("mods:delete", "local:owned.mod"), /退出游戏/);
  assert.equal(f.count("launcher.removeLocalMod"), 0);
  f.flags.gameRunning = false;
  await f.invoke("mods:delete", "local:owned.mod");
  assert.equal(f.count("launcher.removeLocalMod"), 1);
  assert.equal(f.count("downloads.uninstall"), 0);
});

test("an unconfirmed PDX uninstall preserves playset references instead of reporting deletion", async (t) => {
  const f = await fixture(t);
  f.mods = [{ id: "pdx:123", source: "pdx", remoteId: "123", canDelete: true }];
  f.hooks["downloads.uninstall"] = async () => ({
    modId: "123",
    removed: false,
  });
  await assert.rejects(f.invoke("mods:delete", "pdx:123"), /未找到.*受管安装/);
  assert.equal(f.count("launcher.forgetMod"), 0);
});

test("instance native selection reserves launch and file operations until cancel", async (t) => {
  const f = await fixture(t),
    dialogGate = gate(t);
  f.hooks["dialog.open"] = () => dialogGate.promise;
  const creating = f.invoke("instances:create", { name: "legacy" });
  await until(() => f.count("dialog.open") === 1);
  await assert.rejects(f.invoke("launcher:launch", {}), /切换|等待/);
  await assert.rejects(f.invoke("instances:switch", "default"), /切换|等待/);
  await assert.rejects(f.invoke("maintenance:clear", []), /切换|等待/);
  dialogGate.resolve({ canceled: true, filePaths: [] });
  assert.equal(await creating, null);
  await f.invoke("instances:switch", "default");
  assert.equal(f.count("launcher.switchGameInstance"), 1);
});

test("a running game blocks every instance and installation-directory change before dialogs or delegates", async (t) => {
  const f = await fixture(t);
  f.flags.gameRunning = true;
  for (const [channel, args] of guardedOperations.filter(
    ([channel]) =>
      channel.startsWith("instances:") ||
      ["launcher:detect", "launcher:choose", "launcher:save"].includes(channel),
  ))
    await assert.rejects(f.invoke(channel, ...args), /退出游戏/);
  assert.equal(f.count("dialog.open"), 0);
  assert.equal(f.count("launcher.switchGameInstance"), 0);
  assert.equal(f.count("launcher.saveSettings"), 0);
});

test("other active mod operations reach reverse migration exclusion and directory/maintenance guards", async (t) => {
  for (const flag of ["downloadsBusy", "steamPublishing", "pdxPublishing"]) {
    const f = await fixture(t);
    f.flags[flag] = true;
    assert.equal(f.configs.relocation.isOtherBusy(), true);
    await assert.rejects(f.invoke("launcher:detect"), /模组操作/);
    await assert.rejects(f.invoke("maintenance:clear", []), /模组操作/);
    assert.equal(f.count("launcher.detectGame"), 0);
    assert.equal(f.count("launcher.clearCache"), 0);
    f.flags[flag] = false;
    assert.equal(f.configs.relocation.isOtherBusy(), false);
  }
});

test("migration reset IPC validates input, passes only selected paths, and does not open a reset dialog", async (t) => {
  const f = await fixture(t);
  for (const invalid of [
    undefined,
    {},
    { reset: "yes" },
    { reset: true, targetParent: "untrusted" },
  ])
    await assert.rejects(f.invoke("pdx-storage:prepare", invalid), /参数无效/);
  assert.equal(f.count("relocation.prepare"), 0);
  const reset = await f.invoke("pdx-storage:prepare", { reset: true });
  assert.equal(reset.targetParent, null);
  assert.equal(f.count("dialog.open"), 0);
  const selected = await f.invoke("pdx-storage:prepare", { reset: false });
  assert.equal(selected.targetParent, path.join(f.root, "selected-directory"));
  assert.equal(f.count("dialog.open"), 1);
  await f.invoke("pdx-storage:commit", "reviewed-plan");
  assert.equal(
    f.calls.find((call) => call.name === "relocation.commit").args[0],
    "reviewed-plan",
  );
});

test("migration receives current game userData and the installer rejects mismatching paths", async (t) => {
  const f = await fixture(t);
  assert.equal(await f.configs.relocation.getUserDataPath(), f.userData);
  await f.configs.installer.validateUserDataPath(f.userData);
  await assert.rejects(
    f.configs.installer.validateUserDataPath(
      path.join(f.root, "other-user-data"),
    ),
    /用户目录已变化/,
  );
  f.gameFound = false;
  await assert.rejects(f.configs.relocation.getUserDataPath(), /选择 HOI4/);
});

test("migration busy close prompt names migration and recovery and defaults to waiting", async (t) => {
  const f = await fixture(t),
    promptGate = gate(t);
  f.flags.relocationBusy = true;
  f.hooks["dialog.message"] = () => promptGate.promise;
  await f.invoke("window:close");
  await f.invoke("window:close");
  assert.equal(f.window.closed, false);
  assert.equal(
    f.count("dialog.message"),
    1,
    "pending close prompt must not duplicate",
  );
  const options = f.calls.find((call) => call.name === "dialog.message")
    .args[1];
  assert.match(options.message, /目录迁移/);
  assert.match(options.message, /恢复迁移事务/);
  assert.equal(options.defaultId, 0);
  assert.equal(options.cancelId, 0);
  assert.deepEqual(Array.from(options.buttons), ["继续等待", "关闭启动器"]);
  assert.ok(f.window.closeEvents.every((event) => event.prevented));
  promptGate.resolve({ response: 0 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.window.closed, false);
});

test("Steam missing-member requests exclude launch, mutations and relocation while local state and cancellation stay responsive", async (t) => {
  const f = await fixture(t);
  f.flags.steamMissingBusy = true;
  for (const [channel, args, delegate] of guardedOperations.filter(
    ([channel]) => !channel.startsWith("steam-missing:"),
  )) {
    await assert.rejects(f.invoke(channel, ...args), /Steam/);
    assert.equal(f.count(delegate), 0);
  }
  await assert.rejects(f.invoke("launcher:launch", {}), /Steam/);
  await assert.rejects(f.invoke("pdx:download", { modId: "123" }), /Steam/);
  await assert.rejects(f.invoke("pdx:resume"), /Steam/);
  await assert.rejects(f.invoke("steam:disconnect"), /Steam/);
  await assert.rejects(f.invoke("steam:subscribe", "123"), /Steam/);
  assert.equal(f.configs.relocation.isOtherBusy(), true);
  await f.invoke("steam-missing:state");
  await f.invoke("steam-missing:cancel");
  await f.invoke("mods:thumbnail", "local:fixture.mod");
  assert.equal(f.count("steamMissing.getState"), 1);
  assert.equal(f.count("steamMissing.cancel"), 1);
  assert.equal(f.count("launcher.launchGame"), 0);
});

test("Steam missing-member requests receive current context and live download, publication and launch guards", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await f.configs.steamMissing.getLauncherState()).paths.userData,
    f.userData,
  );
  for (const flag of ["downloadsBusy", "steamPublishing", "pdxPublishing"]) {
    f.flags[flag] = true;
    await assert.rejects(
      f.invoke("steam-missing:prepare", { playsetId: "default" }),
      /下载|发布/,
    );
    await assert.rejects(
      f.invoke("steam-missing:commit", "reviewed-plan"),
      /下载|发布/,
    );
    f.flags[flag] = false;
  }
  f.flags.gameRunning = true;
  assert.equal(await f.configs.steamMissing.isGameRunning(), true);
  f.flags.gameRunning = false;
  assert.equal(await f.configs.steamMissing.isGameRunning(), false);
  await f.invoke("steam-missing:prepare", { playsetId: "default" });
  assert.equal(f.count("steamMissing.prepare"), 1);
});

test("launch cannot overtake a missing-member operation that starts during readiness checks", async (t) => {
  const f = await fixture(t),
    readiness = gate(t);
  f.hooks["downloads.ready"] = () => readiness.promise;
  const launch = f.invoke("launcher:launch", {});
  await until(() => f.count("downloads.ready") === 1);
  f.flags.steamMissingBusy = true;
  readiness.resolve();
  await assert.rejects(launch, /Steam/);
  assert.equal(f.count("launcher.launchGame"), 0);
});

test("closing during missing-member requests explains accepted Steam downloads and defaults to waiting", async (t) => {
  const f = await fixture(t);
  f.flags.steamMissingBusy = true;
  f.hooks["dialog.message"] = async () => ({ response: 0 });
  await f.invoke("window:close");
  await new Promise((resolve) => setImmediate(resolve));
  const options = f.calls.find((call) => call.name === "dialog.message")
    .args[1];
  assert.match(options.message, /后续 Steam 请求/);
  assert.match(options.message, /不会撤回/);
  assert.equal(options.defaultId, 0);
  assert.equal(f.window.closed, false);
});

test("explicit close confirmation bypasses only the repeated close prompt", async (t) => {
  const f = await fixture(t);
  f.flags.relocationBusy = true;
  f.hooks["dialog.message"] = async () => ({ response: 1 });
  await f.invoke("window:close");
  await until(() => f.window.closed);
  assert.equal(f.count("dialog.message"), 1);
  assert.equal(f.window.closeEvents.length, 2);
  assert.equal(f.window.closeEvents[0].prevented, true);
  assert.equal(f.window.closeEvents[1].prevented, false);
});

test("saved interface language updates native window and file dialog labels without extra scans", async (t) => {
  const f = await fixture(t);
  assert.equal(f.window.title, "IRONCLAD · 钢铁雄心 IV 启动器");
  assert.equal(f.count("launcher.getState"), 0);
  f.hooks["dialog.open"] = async () => ({ canceled: true, filePaths: [] });
  await f.invoke("pdx-storage:prepare", { reset: false });
  assert.equal(
    f.calls.find((call) => call.name === "dialog.open").args[1].title,
    "选择 Paradox 模组存放位置",
  );
  f.settings.launcherPreferences.language = "en";
  f.settings.playsets = [{ id: "custom", name: "关闭启动器" }];
  const result = await f.invoke("launcher:state");
  assert.equal(result.settings, f.settings);
  assert.equal(result.settings.playsets[0].name, "关闭启动器");
  assert.equal(f.window.title, "IRONCLAD · Hearts of Iron IV Launcher");
  assert.equal(f.count("launcher.getState"), 1);
  f.hooks["launcher.exportPlayset"] = async () => ({ document: {} });
  const dialogs = [
    [
      "pdx-storage:prepare",
      [{ reset: false }],
      "dialog.open",
      "Choose a location for Paradox mods",
    ],
    [
      "launcher:choose",
      [],
      "dialog.open",
      "Choose the game folder containing hoi4.exe",
    ],
    [
      "playsets:import-file",
      [],
      "dialog.open",
      "Import playset JSON",
      "Playset JSON",
    ],
    [
      "playsets:export-file",
      ["custom"],
      "dialog.save",
      "Export playset in official format",
      "Playset JSON",
    ],
    [
      "diagnostics:export",
      [],
      "dialog.save",
      "Export launcher diagnostics",
      "ZIP",
    ],
  ];
  for (const [channel, args, delegate, title, filter] of dialogs) {
    const before = f.count(delegate);
    assert.equal(await f.invoke(channel, ...args), null);
    assert.equal(f.count(delegate), before + 1);
    const options = f.calls.filter((call) => call.name === delegate).at(-1)
      .args[1];
    assert.equal(options.title, title);
    if (filter) {
      assert.equal(options.filters[0].name, filter);
      assert.deepEqual(Array.from(options.filters[0].extensions), [
        filter === "ZIP" ? "zip" : "json",
      ]);
    }
  }
  assert.equal(
    f.count("launcher.getState"),
    2,
    "only the existing diagnostics export should read state again",
  );
  assert.equal(f.count("launcher.saveSettings"), 0);
});

test("native language follows successful saved settings, including the game-directory branch, and survives failed saves", async (t) => {
  for (const withDirectory of [false, true]) {
    const f = await fixture(t),
      saveGate = gate(t);
    const patch = {
      launcherPreferences: { language: "en", closeOnLaunch: false },
      ...(withDirectory ? { gameDirectory: "D:\\设置\\原始目录" } : {}),
    };
    f.hooks["launcher.saveSettings"] = () => saveGate.promise;
    const saving = f.invoke("launcher:save", patch);
    await until(() => f.count("launcher.saveSettings") === 1);
    assert.equal(f.window.title, "IRONCLAD · 钢铁雄心 IV 启动器");
    const saved = { ...f.settings, ...patch };
    saveGate.resolve(saved);
    assert.equal(await saving, saved);
    assert.equal(f.window.title, "IRONCLAD · Hearts of Iron IV Launcher");
    assert.equal(
      f.calls.find((call) => call.name === "launcher.saveSettings").args[0],
      patch,
    );
    f.hooks["launcher.saveSettings"] = async () => {
      throw new Error("fixture save failed");
    };
    await assert.rejects(
      f.invoke("launcher:save", {
        ...patch,
        launcherPreferences: { language: "zh-hans", closeOnLaunch: false },
      }),
      /fixture save failed/,
    );
    assert.equal(f.window.title, "IRONCLAD · Hearts of Iron IV Launcher");
    assert.equal(f.count("launcher.getState"), 0);
    f.hooks["launcher.saveSettings"] = async () => ({
      ...saved,
      launcherPreferences: { language: "zh-hans", closeOnLaunch: false },
    });
    await f.invoke("launcher:save", patch);
    assert.equal(
      f.window.title,
      "IRONCLAD · 钢铁雄心 IV 启动器",
      "use the validated service result, not the requested preference",
    );
  }
});

test("all English close warnings preserve cancellation boundaries and the original button decisions", async (t) => {
  const cases = [
    ["relocationBusy", /relocation transaction will be recovered/],
    ["steamPublishing", /already submitted will not be withdrawn/],
    ["pdxPublishing", /already submitted will not be withdrawn/],
    ["steamMissingBusy", /requests already submitted will not be withdrawn/],
    ["downloadsBusy", /resume the saved partial download/],
    [
      "projectsBusy",
      /local project is processing files or fetching upstream updates/,
    ],
    [
      "projectUpstreamBusy",
      /local project is processing files or fetching upstream updates/,
    ],
    ["campaignsBusy", /unfinished content will be retained/i],
    ["snapshotsBusy", /unfinished content will be retained/i],
    ["coverageBusy", /unfinished content will be retained/i],
  ];
  for (const [flag, meaning] of cases) {
    const f = await fixture(t);
    f.settings.launcherPreferences.language = "en";
    await f.invoke("launcher:state");
    f.flags[flag] = true;
    await f.invoke("window:close");
    await new Promise((resolve) => setImmediate(resolve));
    const options = f.calls.find((call) => call.name === "dialog.message")
      .args[1];
    assert.equal(options.title, "Mod operation in progress");
    assert.match(options.message, meaning);
    if (["projectsBusy", "projectUpstreamBusy"].includes(flag))
      assert.doesNotMatch(options.message, /resume|partial download/);
    assert.doesNotMatch(options.message, /[\u3400-\u9fff]/);
    assert.deepEqual(Array.from(options.buttons), [
      "Keep waiting",
      "Close launcher",
    ]);
    assert.equal(options.defaultId, 0);
    assert.equal(options.cancelId, 0);
    assert.equal(f.window.closed, false);
    f.hooks["dialog.message"] = async () => ({ response: 1 });
    await f.invoke("window:close");
    await until(() => f.window.closed);
    assert.equal(f.count("dialog.message"), 2);
  }
});

test("English native dialogs preserve selected paths, imported and exported playsets, and raw diagnostic data", async (t) => {
  const f = await fixture(t);
  f.settings.launcherPreferences.language = "en";
  await f.invoke("launcher:state");
  const selectedPath = path.join(f.root, "关闭启动器", "设置.JSON");
  const document = {
    name: "关闭启动器",
    mods: [{ displayName: "设置", description: "甲，但乙 {0}" }],
  };
  const json = JSON.stringify(document);
  f.hooks["dialog.open"] = async () => ({
    canceled: false,
    filePaths: [selectedPath],
  });
  f.hooks["fs.stat"] = async (file) => {
    assert.equal(file, selectedPath);
    return { isFile: () => true, size: Buffer.byteLength(json) };
  };
  f.hooks["fs.readFile"] = async (file, encoding) => {
    assert.equal(file, selectedPath);
    assert.equal(encoding, "utf8");
    return json;
  };
  f.hooks["launcher.importPlayset"] = async (text) => text;
  assert.equal(await f.invoke("playsets:import-file"), json);
  const selected = await f.invoke("pdx-storage:prepare", { reset: false });
  assert.equal(selected.targetParent, selectedPath);
  f.hooks["dialog.save"] = async () => ({
    canceled: false,
    filePath: selectedPath,
  });
  f.hooks["launcher.exportPlayset"] = async () => ({
    document,
    omittedLocalMods: [],
  });
  f.hooks["fs.writeFile"] = async () => {};
  const exported = await f.invoke("playsets:export-file", "custom");
  assert.equal(exported.path, selectedPath);
  const savedPlayset = f.calls
    .filter((call) => call.name === "fs.writeFile")
    .at(-1);
  assert.equal(savedPlayset.args[0], selectedPath);
  assert.deepEqual(JSON.parse(savedPlayset.args[1]), document);
  assert.equal(
    f.calls.filter((call) => call.name === "dialog.save").at(-1).args[1]
      .defaultPath,
    "hoi4-playset.json",
  );
  const rawWarning = "无法读取模组描述文件：设置.mod";
  f.hooks["launcher.getState"] = async () => ({
    game: { found: true, directory: "D:\\关闭启动器" },
    paths: { userData: selectedPath },
    settings: f.settings,
    mods: [],
    dlc: { items: [] },
    warnings: [rawWarning],
  });
  await f.invoke("diagnostics:export");
  const diagnostics = f.calls
    .filter((call) => call.name === "fs.writeFile")
    .at(-1);
  const report = JSON.parse(diagnostics.args[1]);
  assert.equal(report.paths.userData, selectedPath);
  assert.equal(report.game.directory, "D:\\关闭启动器");
  assert.deepEqual(report.warnings, [rawWarning]);
  assert.equal(
    f.calls.filter((call) => call.name === "dialog.save").at(-1).args[1]
      .defaultPath,
    "IRONCLAD-diagnostics.zip",
  );
});

test("diagnostics export defaults to a ZIP of app data and excludes raw account input", async (t) => {
  const f = await fixture(t);
  const selectedPath = path.join(f.root, "诊断日志.zip");
  f.hooks["account.login"] = async () => {
    throw new Error("fixture-account@example.invalid fixture-secret-only");
  };
  await assert.rejects(
    f.invoke("account:login", {
      email: "fixture-account@example.invalid",
      password: "fixture-secret-only",
    }),
    /fixture-secret-only/,
  );
  f.hooks["dialog.save"] = async () => ({
    canceled: false,
    filePath: selectedPath,
  });
  f.hooks["fs.writeFile"] = async () => {};
  const result = await f.invoke("diagnostics:export");
  assert.equal(result.path, selectedPath);
  const saved = f.calls.filter((call) => call.name === "fs.writeFile").at(-1);
  assert.equal(saved.args[0], selectedPath);
  assert.equal(Buffer.isBuffer(saved.args[1]), true);
  const zip = await require("yauzl").fromBufferPromise(saved.args[1], {
    lazyEntries: true,
  });
  const files = {};
  for await (const entry of zip.eachEntry()) {
    const chunks = [];
    for await (const chunk of await zip.openReadStreamPromise(entry))
      chunks.push(chunk);
    files[entry.fileName] = Buffer.concat(chunks).toString("utf8");
  }
  const report = JSON.parse(files["diagnostics.json"]);
  assert.equal(report.paths.userData, f.userData);
  const accountEvent = report.events.find(
    (event) => event.action === "account:login",
  );
  assert.equal(accountEvent.result, "error");
  assert.equal(accountEvent.detail, "");
  assert.equal(JSON.stringify(files).includes("fixture-secret-only"), false);
  assert.equal(
    JSON.stringify(files).includes("fixture-account@example.invalid"),
    false,
  );
  const options = f.calls.filter((call) => call.name === "dialog.save").at(-1)
    .args[1];
  assert.equal(options.defaultPath, "IRONCLAD-diagnostics.zip");
  assert.deepEqual(Array.from(options.filters[0].extensions), ["zip"]);
  assert.deepEqual(Array.from(options.filters[1].extensions), ["json"]);
});

test("a diagnostic ZIP save failure reaches the caller without reporting success", async (t) => {
  const f = await fixture(t);
  f.hooks["dialog.save"] = async () => ({
    canceled: false,
    filePath: path.join(f.root, "logs.zip"),
  });
  f.hooks["fs.writeFile"] = async () => {
    throw new Error("fixture disk failure");
  };
  await assert.rejects(f.invoke("diagnostics:export"), /fixture disk failure/);
  assert.equal(f.count("fs.writeFile"), 1);
});

test("diagnostics exports one history snapshot and reports persistence failure with the live ring", async (t) => {
  const f = await fixture(t);
  const history = {
    schemaVersion: 1,
    directory: path.join(f.root, "userData", "logs"),
    limits: { maxFileBytes: 2097152, maxFiles: 3, maxPending: 64 },
    status: {
      available: false,
      reason: "timeout",
      closed: false,
      droppedEvents: 2,
      writeFailures: 1,
      issues: [{ code: "timeout" }],
    },
    files: [
      {
        name: "old.jsonl",
        sessionId: "old",
        part: 0,
        createdAt: "2026-10-28T00:00:00.000Z",
        truncated: true,
        events: [
          {
            at: "2026-10-28T00:00:00.000Z",
            action: "app:start",
            result: "ok",
            detail: "",
          },
        ],
      },
    ],
  };
  f.hooks["diagnostics.snapshot"] = async () => history;
  f.hooks["dialog.save"] = async () => ({
    canceled: false,
    filePath: path.join(f.root, "history.JSON"),
  });
  f.hooks["fs.writeFile"] = async () => {};
  await f.invoke("launcher:save", { launchMode: "debug" });
  await f.invoke("diagnostics:export");
  const saved = f.calls.filter((call) => call.name === "fs.writeFile").at(-1);
  const report = JSON.parse(saved.args[1]);
  assert.deepEqual(report.logHistory, history);
  assert.equal(f.count("diagnostics.snapshot"), 1);
  assert.ok(report.events.some((event) => event.action === "launcher:save"));
  assert.equal(
    f.configs.diagnostics.storageDirectory,
    path.join(f.root, "userData", "logs"),
  );
  assert.deepEqual(f.logEvents[0].action, "app:start");
});

test("ordinary IPC queues events without waiting for history IO and cancel export does not read logs", async (t) => {
  const f = await fixture(t);
  f.hooks["diagnostics.snapshot"] = async () => {
    throw new Error("must not read history");
  };
  const result = await f.invoke("launcher:save", { launchMode: "debug" });
  assert.equal(result.launchMode, "debug");
  assert.ok(f.logEvents.some((event) => event.action === "launcher:save"));
  assert.equal(await f.invoke("diagnostics:export"), null);
  assert.equal(f.count("diagnostics.snapshot"), 0);
  assert.equal(f.count("fs.writeFile"), 0);
});

test("coverage scanning reserves file operations while progress and cancellation stay available", async (t) => {
  const f = await fixture(t),
    pending = gate(t);
  f.hooks["coverage.scan"] = () => pending.promise;
  const scan = f.invoke("coverage:scan");
  await until(() => f.count("coverage.scan") === 1);
  await assert.rejects(
    f.invoke("launcher:save", { launchMode: "debug" }),
    /等待/,
  );
  await assert.rejects(f.invoke("launcher:launch"), /等待/);
  await assert.rejects(
    f.invoke("snapshots:create", { name: "reserved" }),
    /等待/,
  );
  await f.invoke("coverage:progress");
  await f.invoke("coverage:cancel");
  assert.equal(f.count("coverage.getProgress"), 1);
  assert.equal(f.count("coverage.cancel"), 1);
  pending.resolve({ id: "report" });
  assert.equal((await scan).id, "report");
  await f.invoke("coverage:evidence", "trusted-report", "trusted-evidence");
  const read = f.calls.find((item) => item.name === "coverage.readEvidence");
  assert.deepEqual(read.args, ["trusted-report", "trusted-evidence"]);
  assert.equal(
    f.logEvents.some((item) => item.action === "coverage:progress"),
    false,
  );
});

test("coverage and snapshot operations block each other before service invocation", async (t) => {
  const f = await fixture(t);
  f.flags.snapshotsBusy = true;
  await assert.rejects(f.invoke("coverage:scan"), /快照/);
  assert.equal(f.count("coverage.scan"), 0);
  f.flags.snapshotsBusy = false;
  f.flags.coverageBusy = true;
  await assert.rejects(f.invoke("snapshots:restore", "id"), /覆盖/);
  await assert.rejects(f.invoke("instances:switch", "other"), /覆盖/);
  assert.equal(f.count("snapshots.restore"), 0);
});

test("Steam connection diagnostics use the connection result without logging account data", async (t) => {
  const f = await fixture(t);
  f.hooks["steam.call"] = async () => ({
    connected: false,
    error: "private native details",
    account: null,
    items: [],
  });
  assert.equal((await f.invoke("steam:connect")).connected, false);
  const failed = f.logEvents
    .filter((event) => event.action === "steam:connect")
    .at(-1);
  assert.equal(failed.result, "error");
  assert.doesNotMatch(failed.detail, /private/);
  f.hooks["steam.call"] = async () => ({
    connected: true,
    account: { name: "private player", steamId: "76561198000000000" },
    items: [],
  });
  assert.equal((await f.invoke("steam:connect")).connected, true);
  const success = f.logEvents
    .filter((event) => event.action === "steam:connect")
    .at(-1);
  assert.equal(success.result, "ok");
  assert.equal(success.detail, "");
});

test("normal quit cancels Electron exit until the bounded log close settles, then reissues quit once", async (t) => {
  const f = await fixture(t);
  const drain = gate(t);
  f.hooks["diagnostics.close"] = () => drain.promise;
  const quitEvent = () => ({
    prevented: false,
    preventDefault() {
      this.prevented = true;
    },
  });
  const first = quitEvent();
  f.app.emit("will-quit", first);
  await until(() => f.count("diagnostics.close") === 1);
  assert.equal(first.prevented, true);
  assert.equal(f.quitRequested, undefined);
  const repeated = quitEvent();
  f.app.emit("will-quit", repeated);
  assert.equal(repeated.prevented, true);
  assert.equal(f.count("diagnostics.close"), 1);
  assert.equal(
    f.logEvents.filter((event) => event.action === "app:quit").length,
    1,
  );
  drain.resolve();
  await until(() => f.quitRequested);
  const final = quitEvent();
  f.app.emit("will-quit", final);
  assert.equal(final.prevented, false);
  assert.equal(f.quitCount, 1);
});

test("a log close failure still releases the normal quit gate", async (t) => {
  const f = await fixture(t);
  f.hooks["diagnostics.close"] = async () => {
    throw new Error("fixture log failure");
  };
  let prevented = false;
  f.app.emit("will-quit", {
    preventDefault() {
      prevented = true;
    },
  });
  await until(() => f.quitRequested);
  assert.equal(prevented, true);
  assert.equal(f.quitCount, 1);
});

test("additional interface languages reach native pickers and close prompts without changing action defaults", async (t) => {
  const cases = [
    ["de", /Launcher.*schließen/i],
    ["fr", /Fermer le lanceur/i],
    ["es", /Cerrar/i],
    ["ja", /ランチャー/],
    ["ko", /런처/],
    ["pl", /launcher/i],
    ["pt", /[Ff]echar/],
    ["ru", /[Зз]акрыть/],
    ["tr", /[Kk]apat/],
    ["zh-hant", /關閉啟動器/],
  ];
  for (const [language, closeLabel] of cases) {
    const f = await fixture(t);
    f.settings.launcherPreferences.language = language;
    await f.invoke("launcher:state");
    const catalog = require(`../src/locales/${language}.json`);
    assert.equal(f.window.title, catalog["IRONCLAD · 钢铁雄心 IV 启动器"]);
    f.hooks["dialog.open"] = async () => ({ canceled: true, filePaths: [] });
    await f.invoke("playsets:import-file");
    const picker = f.calls.find((call) => call.name === "dialog.open").args[1];
    assert.equal(picker.title, catalog["导入预设 JSON"]);
    assert.equal(picker.filters[0].name, catalog["预设 JSON"]);
    await f.invoke("diagnostics:export");
    const diagnosticPicker = f.calls
      .filter((call) => call.name === "dialog.save")
      .at(-1).args[1];
    assert.equal(diagnosticPicker.title, catalog["导出启动器诊断"]);
    assert.equal(diagnosticPicker.defaultPath, "IRONCLAD-diagnostics.zip");
    assert.equal(diagnosticPicker.filters[0].name, "ZIP");
    assert.equal(diagnosticPicker.filters[1].name, catalog["诊断 JSON"]);
    for (const flag of [
      "relocationBusy",
      "steamPublishing",
      "pdxPublishing",
      "steamMissingBusy",
      "downloadsBusy",
      "projectsBusy",
      "projectUpstreamBusy",
      "campaignsBusy",
      "snapshotsBusy",
      "coverageBusy",
    ]) {
      f.flags[flag] = true;
      await f.invoke("window:close");
      await new Promise((resolve) => setImmediate(resolve));
      const prompt = f.calls
        .filter((call) => call.name === "dialog.message")
        .at(-1).args[1];
      assert.equal(prompt.title, catalog["模组操作进行中"]);
      assert.deepEqual(Array.from(prompt.buttons), [
        catalog["继续等待"],
        catalog["关闭启动器"],
      ]);
      assert.match(prompt.buttons[1], closeLabel);
      assert.equal(prompt.defaultId, 0);
      assert.equal(prompt.cancelId, 0);
      assert.equal(f.window.closed, false);
      f.flags[flag] = false;
    }
  }
});
