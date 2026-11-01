const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  clipboard,
  shell,
  safeStorage,
  utilityProcess,
} = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const { createLauncherService } = require("./launcher-service.cjs");
const { createGamePerformanceService } = require("./game-performance.cjs");
const { createCampaignService } = require("./campaigns.cjs");
const { createPlaysetSnapshotService } = require("./playset-snapshots.cjs");
const { createModCoverageService } = require("./mod-coverage.cjs");
const { createDisplayService } = require("./display-service.cjs");
const { createNewsService } = require("./news-service.cjs");
const { createModCatalogService } = require("./mod-catalog.cjs");
const { createAccountService } = require("./account-service.cjs");
const { createSteamWorkerClient } = require("./steam-worker-client.cjs");
const { createSteamMissingService } = require("./steam-missing.cjs");
const { createModProjectService } = require("./mod-projects.cjs");
const {
  createModProjectUpstream,
  verifyManagedProjectSource,
} = require("./mod-project-upstream.cjs");
const { createModProjectController } = require("./mod-project-controller.cjs");
const { createLauncherUpdater } = require("./launcher-updater.cjs");
const { createPublishService } = require("./publish-service.cjs");
const { createPdxContentService } = require("./pdx-content.cjs");
const { createPdxInstallService } = require("./pdx-install.cjs");
const { createPdxDownloads } = require("./pdx-downloads.cjs");
const { createPdxArchiveCache } = require("./pdx-archive-cache.cjs");
const { createPdxRelocation } = require("./pdx-relocation.cjs");
const { createPdxSubscriptions } = require("./pdx-subscriptions.cjs");
const { createPdxPublisher } = require("./pdx-publisher.cjs");
const { createPublishArchiveService } = require("./publish-archive.cjs");
const { createNativeI18n } = require("./native-i18n.cjs");
const { createDiagnosticsArchive } = require("./diagnostics-archive.cjs");
const { plainDiagnostic } = require("./diagnostic-message.cjs");
const {
  createDiagnosticsLog,
  sanitizeDiagnosticEvent,
} = require("./diagnostics-log.cjs");

app.setName("IRONCLAD");
let mainWindow;
let service;
let launching = false;
let lastLaunch = 0;
const nativeI18n = createNativeI18n();
const t = (key) => nativeI18n.t(key);
function updateNativeLanguage(settings) {
  nativeI18n.setLanguage(settings?.launcherPreferences?.language);
  mainWindow?.setTitle(t("IRONCLAD · 钢铁雄心 IV 启动器"));
}
const events = [];
let diagnosticsLog;
function recordEvent(action, result, detail = "") {
  const event = sanitizeDiagnosticEvent({
    at: new Date().toISOString(),
    action,
    result,
    detail,
  });
  if (!event) return;
  events.push(event);
  if (events.length > 200) events.shift();
  // Persistence is best-effort and bounded; disk latency must not delay IPC.
  diagnosticsLog?.record(event);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    diagnosticsLog = createDiagnosticsLog({
      storageDirectory: path.join(app.getPath("userData"), "logs"),
    });
    recordEvent("app:start", "ok");
    let quitDraining = false;
    let quitDrained = false;
    app.on("will-quit", (event) => {
      if (quitDrained) return;
      // will-quit must be cancelled explicitly: Electron ignores promises
      // returned by event handlers. The log itself bounds its drain deadline.
      event?.preventDefault();
      if (quitDraining) return;
      quitDraining = true;
      recordEvent("app:quit", "ok");
      Promise.resolve()
        .then(() => diagnosticsLog.close())
        .catch(() => {})
        .finally(() => {
          quitDrained = true;
          app.quit();
        });
    });
    let modProjects, projectUpstream, playsetSnapshots, modCoverage;
    service = createLauncherService({
      settingsPath: path.join(app.getPath("userData"), "settings.json"),
      documentsPath: app.getPath("documents"),
      getModProjects: async () =>
        modProjects ? (await modProjects.list()).projects : [],
      resolveProjectVersion: (id, version) =>
        modProjects.resolveVersion(id, version),
    });
    const gamePerformance = createGamePerformanceService({
      storageDirectory: path.join(app.getPath("userData"), "game-performance"),
      monitorPath: app.isPackaged
        ? path.join(process.resourcesPath, "performance-monitor.exe")
        : path.join(__dirname, "..", "assets", "game-performance-monitor.exe"),
    });
    const campaigns = createCampaignService({
      storageDirectory: path.join(app.getPath("userData"), "campaigns"),
      launcher: service,
      isGameRunning: async () => (await service.getLaunchStatus()).running,
    });
    let pdxRelocation,
      steamMissing,
      changingGameDirectory = false,
      maintaining = false;
    let installingLauncherUpdate = false;
    let activeMutations = 0;
    const passiveChannels = new Set([
      "launcher:state",
      "launcher:status",
      "update:state",
      "update:releases",
      "window:minimize",
      "window:maximize",
      "window:close",
      "mods:thumbnail",
      "pdx:state",
      "pdx-storage:state",
      "account:state",
      "steam:state",
      "steam-missing:state",
      "publish:status",
      "pdx-publish:status",
      "campaigns:state",
      "campaigns:progress",
      "snapshots:state",
      "snapshots:progress",
      "coverage:progress",
      "performance:state",
      "performance:session",
      "performance:compare",
      "projects:get-mod-projects",
      "projects:get-mod-project-upstream",
      "news:state",
      "catalog:search",
      "system:displays",
    ]);
    function storageIdle({
      skipSteamMissing = false,
      skipProjects = false,
    } = {}) {
      if (campaigns.isBusy())
        throw new Error("战役档案正在检查或备份，请等待完成。");
      if (playsetSnapshots?.isBusy())
        throw new Error("正在保存或恢复组合快照，请等待完成。");
      if (modCoverage?.isBusy())
        throw new Error("正在检查跨 Mod 覆盖，请等待完成。");
      if (!skipProjects && (modProjects?.isBusy() || projectUpstream?.isBusy()))
        throw new Error("本地项目正在处理文件或获取上游更新，请等待完成。");
      if (!skipSteamMissing && steamMissing?.isBusy())
        throw new Error(
          "正在处理预设缺失的 Steam 模组，请等待完成或停止后续请求。",
        );
      if (pdxRelocation?.isBlocked())
        throw new Error(
          "模组目录正在迁移或需要恢复，请先在设置页完成目录操作。",
        );
      if (changingGameDirectory || maintaining)
        throw new Error("正在切换游戏目录或维护文件，请等待完成。");
    }
    async function changeGameDirectory(operation) {
      storageIdle();
      if (
        pdxDownloads.isBusy() ||
        publisher.isPublishing() ||
        pdxPublisher.isPublishing()
      )
        throw new Error("请先完成模组操作，再切换游戏目录。");
      changingGameDirectory = true;
      try {
        if (launching || (await service.getLaunchStatus()).running)
          throw new Error("请先退出游戏，再切换版本实例或游戏目录。");
        return await operation();
      } finally {
        changingGameDirectory = false;
      }
    }
    async function maintainFiles(operation) {
      storageIdle();
      if (
        pdxDownloads.isBusy() ||
        publisher.isPublishing() ||
        pdxPublisher.isPublishing()
      )
        throw new Error("请先完成模组操作，再维护缓存。");
      maintaining = true;
      try {
        return await operation();
      } finally {
        maintaining = false;
      }
    }

    const handle = (name, callback) =>
      ipcMain.handle(name, async (event, ...args) => {
        if (
          event.sender !== mainWindow?.webContents ||
          event.senderFrame !== mainWindow.webContents.mainFrame
        ) {
          throw new Error("无法识别的窗口请求。");
        }
        if (
          installingLauncherUpdate &&
          !["update:state", "window:minimize", "window:maximize"].includes(name)
        )
          throw new Error("正在安装启动器更新，请等待重启完成。");
        const mutating = !passiveChannels.has(name);
        if (mutating) activeMutations++;
        try {
          const result = await callback(...args);
          if (name === "steam:connect" && result?.connected !== true)
            recordEvent(name, "error", "Steam 客户端连接未建立。");
          else if (
            ![
              "launcher:state",
              "launcher:status",
              "pdx-storage:state",
              "mods:thumbnail",
              "performance:state",
              "performance:session",
              "performance:compare",
              "campaigns:progress",
              "snapshots:progress",
              "coverage:progress",
              "update:state",
            ].includes(name)
          )
            recordEvent(name, "ok");
          return result;
        } catch (error) {
          recordEvent(name, "error", error?.message || "操作失败");
          const diagnostic = plainDiagnostic(error?.diagnostic);
          if (diagnostic)
            return {
              __ironcladDiagnosticError: 1,
              message: error?.message || "操作失败，请重试。",
              diagnostic,
              ...(typeof error?.code === "string" &&
              /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code)
                ? { code: error.code }
                : {}),
            };
          throw new Error(error?.message || "操作失败，请重试。");
        } finally {
          if (mutating) activeMutations--;
        }
      });

    async function assertUpdateInstallAllowed() {
      storageIdle();
      if (
        pdxDownloads.isBusy() ||
        publisher.isPublishing() ||
        pdxPublisher.isPublishing()
      )
        throw new Error("请先完成模组操作，再安装启动器更新。");
      if (launching || (await service.getLaunchStatus()).running)
        throw new Error("请先退出游戏，再安装启动器更新。");
    }
    const launcherUpdater = createLauncherUpdater({
      currentVersion: app.getVersion(),
      storageDirectory: path.join(app.getPath("userData"), "updates"),
      portableExecutable: process.env?.PORTABLE_EXECUTABLE_FILE,
      isPackaged: app.isPackaged,
      platform: process.platform,
      beforeInstall: assertUpdateInstallAllowed,
    });
    handle("update:state", () => launcherUpdater.getState());
    handle("update:check", () => launcherUpdater.check());
    handle("update:download", () => launcherUpdater.download());
    handle("update:cancel", () => launcherUpdater.cancel());
    handle("update:releases", async () => {
      await shell.openExternal(
        "https://github.com/SakuraLoveSmile/HOI4-Launcher/releases",
      );
      return true;
    });
    handle("update:install", async () => {
      if (activeMutations > 1)
        throw new Error("启动器仍在处理其他操作，请等待完成后再安装更新。");
      installingLauncherUpdate = true;
      let started = false;
      try {
        await assertUpdateInstallAllowed();
        const result = await launcherUpdater.install();
        if (!result?.started) throw new Error("更新程序未能启动，请重试。");
        started = true;
        app.quit();
        return result;
      } finally {
        if (!started) installingLauncherUpdate = false;
      }
    });
    app.once("will-quit", () => launcherUpdater.dispose());

    handle("launcher:state", async () => {
      const result = await service.getState();
      updateNativeLanguage(result.settings);
      return result;
    });
    handle("launcher:detect", () =>
      changeGameDirectory(() => service.detectGame()),
    );
    handle("launcher:save", async (patch) => {
      if (
        launching ||
        campaigns.isBusy() ||
        playsetSnapshots?.isBusy() ||
        modCoverage?.isBusy() ||
        maintaining
      )
        throw new Error("正在检查配置或处理文件，请等待完成后再修改设置。");
      const result =
        patch && Object.hasOwn(patch, "gameDirectory")
          ? await changeGameDirectory(() => service.saveSettings(patch))
          : await service.saveSettings(patch);
      updateNativeLanguage(result);
      return result;
    });
    handle("launcher:status", () => service.getLaunchStatus());
    handle("performance:state", () => gamePerformance.getState());
    handle("performance:session", (id) => gamePerformance.getSession(id));
    handle("performance:enabled", (enabled) =>
      gamePerformance.setEnabled(enabled),
    );
    handle("performance:notes", (id, notes) =>
      gamePerformance.setNotes(id, notes),
    );
    handle("performance:compare", (beforeId, afterId) =>
      gamePerformance.compareSessions(beforeId, afterId),
    );
    handle("campaigns:state", () => campaigns.list());
    handle("campaigns:progress", () => campaigns.getProgress());
    handle("campaigns:cancel", () => campaigns.cancel());
    handle("campaigns:review", (id) =>
      maintainFiles(() => {
        if (launching) throw new Error("游戏正在启动，请稍候。");
        return campaigns.review(id);
      }),
    );
    handle("campaigns:review-current", () =>
      maintainFiles(() => {
        if (launching) throw new Error("游戏正在启动，请稍候。");
        return campaigns.reviewCurrent();
      }),
    );
    handle("campaigns:bind", (input) =>
      maintainFiles(async () => {
        if (
          !input ||
          typeof input !== "object" ||
          Array.isArray(input) ||
          Object.keys(input).some((k) => !["name", "notes"].includes(k))
        )
          throw new Error("战役编辑参数无效。");
        if (launching || (await service.getLaunchStatus()).running)
          throw new Error("请先退出游戏，再绑定存档。");
        const state = await service.getState();
        const result = await dialog.showOpenDialog(mainWindow, {
          title: t("选择战役存档"),
          defaultPath: path.join(state.paths.userData, "save games"),
          properties: ["openFile"],
          filters: [{ name: "HOI4", extensions: ["hoi4"] }],
        });
        if (result.canceled || !result.filePaths[0]) return null;
        return campaigns.bind({ ...input, savePath: result.filePaths[0] });
      }),
    );
    for (const [channel, method] of [
      ["update", "update"],
      ["accept", "acceptEnvironment"],
      ["restore-config", "restoreConfiguration"],
      ["backup", "backup"],
      ["restore-backup", "restoreBackup"],
    ]) {
      handle("campaigns:" + channel, (...args) =>
        maintainFiles(async () => {
          if (launching) throw new Error("游戏正在启动，请稍候。");
          return campaigns[method](...args);
        }),
      );
    }
    handle("campaigns:folder", async (id) =>
      shell.showItemInFolder(await campaigns.resolveSave(id)),
    );
    handle("instances:create", (input) =>
      changeGameDirectory(async () => {
        if (
          !input ||
          typeof input !== "object" ||
          Array.isArray(input) ||
          Object.keys(input).some((key) => key !== "name") ||
          typeof input.name !== "string" ||
          !input.name.trim() ||
          input.name.trim().length > 128 ||
          /[\0-\x1f]/.test(input.name)
        )
          throw new Error("版本实例名称须为 1 至 128 个字符。");
        const selected = await dialog.showOpenDialog(mainWindow, {
          title: t("选择包含 hoi4.exe 的游戏文件夹"),
          properties: ["openDirectory"],
        });
        if (selected.canceled || !selected.filePaths[0]) return null;
        return service.createGameInstance({
          name: input.name,
          gameDirectory: selected.filePaths[0],
        });
      }),
    );
    handle("instances:switch", (id) =>
      changeGameDirectory(() => service.switchGameInstance(id)),
    );
    handle("instances:rename", (input) =>
      changeGameDirectory(() => service.renameGameInstance(input)),
    );
    handle("instances:remove", (id) =>
      changeGameDirectory(() => service.removeGameInstance(id)),
    );
    const pdxInstaller = createPdxInstallService({
      storageDirectory: path.join(
        app.getPath("userData"),
        "pdx",
        "installations",
      ),
      isGameRunning: async () =>
        launching || (await service.getLaunchStatus()).running,
      validateUserDataPath: async (target) => {
        const current = await service.getSourceState();
        if (
          !current.game.found ||
          path.resolve(current.paths.userData).toLowerCase() !==
            path.resolve(target).toLowerCase()
        )
          throw new Error(
            "游戏用户目录已变化，尚未登记模组，请确认目录后重试。",
          );
      },
    });
    const account = createAccountService({
      sessionPath: path.join(app.getPath("userData"), "account.session"),
      encryptString: (value) => safeStorage.encryptString(value),
      decryptString: (value) => safeStorage.decryptString(value),
      isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
    });
    const pdxDownloads = createPdxDownloads({
      storageDirectory: path.join(app.getPath("userData"), "pdx", "downloads"),
      content: createPdxContentService({ account }),
      account,
      installer: pdxInstaller,
      archiveCache: createPdxArchiveCache({
        storageDirectory: path.join(app.getPath("userData"), "pdx", "archives"),
      }),
      assertOperationAllowed: storageIdle,
      isGameRunning: async () =>
        launching || (await service.getLaunchStatus()).running,
      getUserDataPath: async () => {
        const current = await service.getState();
        if (!current.game.found)
          throw new Error("请先在设置页选择 HOI4 游戏目录。");
        return current.paths.userData;
      },
    });
    handle("pdx:state", () => pdxDownloads.getState());
    handle("pdx:download", (input) => pdxDownloads.start(input));
    handle("pdx:repair", (input) => pdxDownloads.repair(input));
    handle("pdx:pause", () => pdxDownloads.pause());
    handle("pdx:resume", () => pdxDownloads.resume());
    handle("pdx:cancel", () => pdxDownloads.cancel());
    handle("pdx:limit", (value) => pdxDownloads.setLimit(value));
    handle("pdx:uninstall", (id) => pdxDownloads.uninstall(id));
    app.once("will-quit", () => pdxDownloads.dispose());
    handle("account:state", () => account.getAccount());
    handle("account:login", (input) => account.login(input));
    handle("account:logout", () => account.logout());
    handle("account:cancel", () => account.cancelLogin());
    const pdxSubscriptions = createPdxSubscriptions({
      account,
      isGameRunning: async () =>
        launching || (await service.getLaunchStatus()).running,
    });
    handle("pdx:subscriptions", (options) =>
      pdxSubscriptions.getState(options),
    );
    handle("pdx:subscribe", (input) => pdxSubscriptions.subscribe(input));
    handle("pdx:unsubscribe", (id) => pdxSubscriptions.unsubscribe(id));
    let publisher, pdxPublisher;
    const archives = createPublishArchiveService({
      storageDirectory: path.join(
        app.getPath("userData"),
        "publishing-pdx",
        "archives",
      ),
    });
    const pdxBackend = createPdxPublisher({
      account,
      createArchive: archives.createArchive,
      onPublishStatus: (job) => pdxPublisher.recordStatus(job),
    });
    pdxPublisher = createPublishService({
      provider: "pdx",
      storageDirectory: path.join(app.getPath("userData"), "publishing-pdx"),
      resolveMod: (id) => service.getLocalModMetadata(id),
      isGameRunning: async () =>
        launching || (await service.getLaunchStatus()).running,
      steam: { call: (method, ...args) => pdxBackend[method](...args) },
    });
    handle("pdx-publish:draft", (id) => pdxPublisher.getDraft(id));
    handle("pdx-publish:prepare", (input) => {
      storageIdle();
      return pdxPublisher.prepare(input);
    });
    handle("pdx-publish:commit", (id) => {
      storageIdle();
      return pdxPublisher.commit(id);
    });
    handle("pdx-publish:cancel", () => pdxPublisher.cancel());
    handle("pdx-publish:status", () => pdxPublisher.getStatus());
    handle("pdx-publish:refresh", () => pdxPublisher.refreshStatus());
    app.once("will-quit", () => pdxBackend.dispose());
    const steam = createSteamWorkerClient({
      fork: (...args) => utilityProcess.fork(...args),
      scriptPath: path.join(__dirname, "steam-worker.cjs"),
      onPublishStatus: (job) =>
        publisher
          ?.recordStatus(job)
          .catch(() =>
            recordEvent(
              "publish:journal",
              "error",
              "无法保存发布记录，请在工坊确认目标编号。",
            ),
          ),
    });
    publisher = createPublishService({
      storageDirectory: path.join(app.getPath("userData"), "publishing"),
      resolveMod: (id) => service.getLocalModMetadata(id),
      isGameRunning: async () =>
        launching || (await service.getLaunchStatus()).running,
      steam,
    });
    steamMissing = createSteamMissingService({
      storageDirectory: path.join(app.getPath("userData"), "steam-missing"),
      getLauncherState: () => service.getState(),
      steam,
      isGameRunning: async () =>
        launching || (await service.getLaunchStatus()).running,
      assertOperationAllowed: () => {
        storageIdle({ skipSteamMissing: true });
        if (
          pdxDownloads.isBusy() ||
          publisher.isPublishing() ||
          pdxPublisher.isPublishing()
        )
          throw new Error(
            "请先完成模组下载、安装或发布，再处理缺失的 Steam 模组。",
          );
      },
    });
    handle("steam-missing:state", () => steamMissing.getState());
    handle("steam-missing:prepare", (input) => steamMissing.prepare(input));
    handle("steam-missing:commit", (planId) => steamMissing.commit(planId));
    handle("steam-missing:cancel", () => steamMissing.cancel());
    app.once("will-quit", () => steamMissing.dispose());
    pdxRelocation = createPdxRelocation({
      installer: pdxInstaller,
      ready: () => pdxDownloads.ready(),
      isGameRunning: async () =>
        launching || (await service.getLaunchStatus()).running,
      isOtherBusy: () =>
        Boolean(modProjects?.isBusy() || projectUpstream?.isBusy()) ||
        steamMissing.isBusy() ||
        pdxDownloads.isBusy() ||
        publisher.isPublishing() ||
        pdxPublisher.isPublishing() ||
        changingGameDirectory ||
        maintaining,
      getUserDataPath: async () => {
        const current = await service.getState();
        if (!current.game.found) throw new Error("请先选择 HOI4 游戏目录。");
        return current.paths.userData;
      },
    });
    handle("pdx-storage:state", () => pdxRelocation.getState());
    handle("pdx-storage:prepare", async (options) => {
      if (
        !options ||
        typeof options.reset !== "boolean" ||
        Object.keys(options).some((key) => key !== "reset")
      )
        throw new Error("目录预览参数无效。");
      storageIdle();
      let targetParent = null;
      if (!options.reset) {
        const result = await dialog.showOpenDialog(mainWindow, {
          title: t("选择 Paradox 模组存放位置"),
          properties: ["openDirectory", "createDirectory"],
        });
        if (result.canceled || !result.filePaths[0]) return null;
        targetParent = result.filePaths[0];
      }
      return pdxRelocation.prepare({ targetParent });
    });
    handle("pdx-storage:commit", (planId) => pdxRelocation.commit(planId));
    handle("pdx-storage:discard", () => pdxRelocation.discard());
    handle("pdx-storage:cancel", () => pdxRelocation.cancel());
    handle("pdx-storage:recover", () => pdxRelocation.recover());
    app.once("will-quit", () => pdxRelocation.dispose());
    handle("publish:draft", (id) => publisher.getDraft(id));
    handle("publish:prepare", (input) => {
      storageIdle();
      return publisher.prepare(input);
    });
    handle("publish:commit", (id) => {
      storageIdle();
      return publisher.commit(id);
    });
    handle("publish:cancel", () => publisher.cancel());
    handle("publish:status", () => publisher.getStatus());
    handle("publish:agreement", async () => {
      await shell.openExternal(
        "https://steamcommunity.com/workshop/workshoplegalagreement/",
      );
      return true;
    });
    app.once("will-quit", () => steam.dispose());
    handle("steam:state", () => steam.call("getState"));
    handle("steam:connect", () => {
      storageIdle();
      return steam.call("connect");
    });
    handle("steam:disconnect", () => {
      storageIdle();
      return steam.disconnect();
    });
    handle("steam:browse", (options) => steam.call("browse", options));
    for (const method of ["subscribe", "unsubscribe", "download"])
      handle(`steam:${method}`, async (id) => {
        storageIdle();
        if ((await service.getLaunchStatus()).running)
          throw new Error("请先退出游戏，再修改工坊订阅或下载内容。");
        storageIdle();
        return steam.call(method, id);
      });
    handle("maintenance:plan", () => service.getCachePlan());
    handle("maintenance:list", () => service.listCacheBackups());
    handle("maintenance:clear", (ids) =>
      maintainFiles(() => service.clearCache(ids)),
    );
    handle("maintenance:restore", (id) =>
      maintainFiles(() => service.restoreCacheBackup(id)),
    );
    handle("mods:create", (input) => service.createLocalMod(input));
    handle("mods:metadata", (id) => service.getLocalModMetadata(id));
    handle("mods:thumbnail", (id) => service.getModThumbnail(id));
    handle("mods:update-metadata", (id, input) =>
      service.updateLocalModMetadata(id, input),
    );
    handle("mods:display-name", (input) => service.setModDisplayName(input));
    handle("mods:reset-name", (id) => service.resetModDisplayName(id));
    async function contextMod(id, expected) {
      if (typeof id !== "string" || !id || id.length > 4096)
        throw new Error("模组标识无效。");
      const current = await service.getState();
      if (
        expected &&
        (current.settings.activeGameInstanceId !==
          expected.settings.activeGameInstanceId ||
          path.resolve(current.paths.userData).toLowerCase() !==
            path.resolve(expected.paths.userData).toLowerCase())
      )
        throw new Error("版本实例已变化，请刷新模组列表。");
      const mod = current.mods.find((item) => item.id === id);
      if (!mod) throw new Error("未找到此模组，请刷新后重试。");
      return { current, mod };
    }
    async function connectedSteam() {
      const current = await steam.call("getState");
      if (!current.connected) {
        const connected = await steam.call("connect");
        if (!connected?.connected) throw new Error("Steam 客户端连接未建立。");
      }
    }
    handle("mods:localized-name", async (id) => {
      const { mod } = await contextMod(id);
      const original = mod.originalName || mod.name;
      if (/[\u3400-\u9fff]/.test(original)) return { name: original };
      if (mod.source !== "workshop") return { name: null };
      storageIdle();
      await connectedSteam();
      const localized = await steam.call("getItem", mod.remoteId, {
        language: "schinese",
      });
      return {
        name:
          typeof localized?.name === "string" &&
          /[\u3400-\u9fff]/.test(localized.name)
            ? localized.name.slice(0, 128)
            : null,
      };
    });
    handle("mods:update", async (id) => {
      storageIdle();
      if (publisher.isPublishing() || pdxPublisher.isPublishing())
        throw new Error("请先完成模组操作，再维护缓存。");
      const { current, mod } = await contextMod(id);
      if (mod.source === "pdx" && !mod.projectId) {
        const active = current.settings.playsets.find(
          (item) => item.id === current.settings.activePlaysetId,
        );
        const pin = active?.modReferences?.find(
          (ref) => ref.id === id,
        )?.version;
        await pdxDownloads.start(
          { modId: mod.remoteId, revision: pin || null },
          current.paths.userData,
        );
        return { state: await service.getState() };
      }
      if (mod.source !== "workshop" || mod.projectId)
        throw new Error("本地模组没有可请求的在线更新。");
      return maintainFiles(async () => {
        await contextMod(id, current);
        if (launching || (await service.getLaunchStatus()).running)
          throw new Error("请先退出游戏，再更新或删除模组。");
        await connectedSteam();
        await steam.call("download", mod.remoteId);
        return { state: await service.getState() };
      });
    });
    handle("mods:delete", async (id) => {
      storageIdle();
      if (publisher.isPublishing() || pdxPublisher.isPublishing())
        throw new Error("请先完成模组操作，再维护缓存。");
      const { current, mod } = await contextMod(id);
      if (!mod.canDelete || mod.projectId)
        throw new Error(
          "此模组不能通过右键菜单删除，请使用对应的项目或内容管理功能。",
        );
      if (mod.source === "pdx") {
        const removed = await pdxDownloads.uninstall(
          mod.remoteId,
          current.paths.userData,
        );
        if (removed?.removed !== true)
          throw new Error("未找到当前游戏目录中可验证的受管安装。");
        return { state: await service.forgetMod(id, current.paths.userData) };
      }
      return maintainFiles(async () => {
        await contextMod(id, current);
        if (launching || (await service.getLaunchStatus()).running)
          throw new Error("请先退出游戏，再更新或删除模组。");
        if (mod.source === "local") return service.removeLocalMod(id);
        await connectedSteam();
        await steam.call("unsubscribe", mod.remoteId);
        return { state: await service.forgetMod(id, current.paths.userData) };
      });
    });
    modProjects = createModProjectService({
      storageDirectory: path.join(app.getPath("userData"), "mod-projects"),
      getUserDataPath: async () => {
        const state = await service.getSourceState();
        if (!state.game.found)
          throw new Error("请先选择有效的 HOI4 游戏目录。");
        return state.paths.userData;
      },
      isGameRunning: async () =>
        launching || (await service.getLaunchStatus()).running,
    });
    playsetSnapshots = createPlaysetSnapshotService({
      storageDirectory: path.join(app.getPath("userData"), "playset-snapshots"),
      launcher: service,
      projects: modProjects,
      isGameRunning: async () =>
        launching || (await service.getLaunchStatus()).running,
    });
    handle("snapshots:state", () => playsetSnapshots.list());
    handle("snapshots:progress", () => playsetSnapshots.getProgress());
    handle("snapshots:cancel", () => playsetSnapshots.cancel());
    for (const [channel, method] of [
      ["create", "create"],
      ["verify", "verify"],
      ["restore", "restore"],
    ])
      handle("snapshots:" + channel, (input) =>
        maintainFiles(() => playsetSnapshots[method](input)),
      );
    handle("snapshots:folder", async (id) => {
      const error = await shell.openPath(
        await playsetSnapshots.resolveDirectory(id),
      );
      if (error) throw new Error(error);
      return true;
    });
    modCoverage = createModCoverageService({ launcher: service });
    handle("coverage:scan", () =>
      maintainFiles(() => {
        if (launching) throw new Error("游戏正在启动，请稍候。");
        return modCoverage.scan();
      }),
    );
    handle("coverage:progress", () => modCoverage.getProgress());
    handle("coverage:cancel", () => modCoverage.cancel());
    handle("coverage:evidence", (reportId, evidenceId) =>
      modCoverage.readEvidence(reportId, evidenceId),
    );
    projectUpstream = createModProjectUpstream({
      projects: modProjects,
      getLauncherState: () => service.getSourceState(),
      steam,
      content: createPdxContentService({ account }),
      account,
      storageDirectory: path.join(app.getPath("userData"), "project-downloads"),
      isGameRunning: async () =>
        launching || (await service.getLaunchStatus()).running,
      assertOperationAllowed: () => {
        storageIdle({ skipProjects: true });
        if (
          pdxDownloads.isBusy() ||
          publisher.isPublishing() ||
          pdxPublisher.isPublishing()
        )
          throw new Error("请先完成模组下载或发布，再获取上游更新。");
      },
    });
    const projectController = createModProjectController({
      projects: modProjects,
      upstream: projectUpstream,
      launcher: service,
      runMutation: (operation) => maintainFiles(operation),
      openPath: (target) => shell.openPath(target),
      verifyOriginal: (id, source) =>
        verifyManagedProjectSource(
          {
            installer: pdxInstaller,
            getLauncherState: () => service.getSourceState(),
          },
          id,
          source,
        ),
      chooseOpen: async (kind) => {
        const result = await dialog.showOpenDialog(mainWindow, {
          title: t("导入本地项目"),
          properties: kind === "folder" ? ["openDirectory"] : ["openFile"],
          ...(kind === "folder"
            ? {}
            : { filters: [{ name: "ZIP", extensions: ["zip"] }] }),
        });
        return result.canceled ? null : result.filePaths[0];
      },
      chooseSave: async () => {
        const result = await dialog.showSaveDialog(mainWindow, {
          title: t("备份本地项目"),
          defaultPath: "ironclad-project.zip",
          filters: [{ name: "ZIP", extensions: ["zip"] }],
        });
        return result.canceled ? null : result.filePath;
      },
    });
    for (const [method, callback] of Object.entries(projectController))
      handle(
        `projects:${method.replace(/[A-Z]/g, (letter) => "-" + letter.toLowerCase())}`,
        callback,
      );
    const news = createNewsService({
      cachePath: path.join(app.getPath("userData"), "cache", "hoi4-news.json"),
    });
    handle("news:state", (options) => news.getNews(options));
    const catalog = createModCatalogService({
      cachePath: path.join(
        app.getPath("userData"),
        "cache",
        "hoi4-mod-catalog.json",
      ),
    });
    handle("catalog:search", (options) => catalog.search(options));
    handle("news:open", async (id) => {
      const feed = await news.getNews();
      const item = feed.items.find((item) => item.id === id);
      if (!item) throw new Error("此公告不在当前新闻列表中，请刷新后重试。");
      await shell.openExternal(item.url);
      return true;
    });
    handle("links:open", async (name) => {
      const links = {
        workshop: "https://steamcommunity.com/app/394360/workshop/",
        dlc: "https://store.steampowered.com/dlc/394360/Hearts_of_Iron_IV/",
        community:
          "https://forum.paradoxplaza.com/forum/forums/hearts-of-iron-iv.844/",
        support:
          "https://support.paradoxplaza.com/hc/en-us/categories/202732728-Hearts-of-Iron-IV",
      };
      if (!Object.hasOwn(links, name)) throw new Error("不支持的外部链接。");
      await shell.openExternal(links[name]);
      return true;
    });
    handle("diagnostics:export", async () => {
      const current = await service.getState();
      const result = await dialog.showSaveDialog(mainWindow, {
        title: t("导出启动器诊断"),
        defaultPath: "IRONCLAD-diagnostics.zip",
        filters: [
          { name: "ZIP", extensions: ["zip"] },
          { name: t("诊断 JSON"), extensions: ["json"] },
        ],
      });
      if (result.canceled || !result.filePath) return null;
      const logHistory = await diagnosticsLog.snapshot();
      const report = {
        generatedAt: new Date().toISOString(),
        launcherVersion: app.getVersion(),
        runtime: {
          electron: process.versions.electron,
          node: process.versions.node,
          platform: process.platform,
          arch: process.arch,
        },
        game: current.game,
        paths: current.paths,
        counts: {
          mods: current.mods.length,
          playsets: current.settings.playsets.length,
          dlc: current.dlc.items.length,
        },
        launchStatus: current.launchStatus,
        warnings: current.warnings,
        events: [...events],
        logHistory,
      };
      if (path.extname(result.filePath).toLowerCase() === ".json")
        await fs.writeFile(
          result.filePath,
          JSON.stringify(report, null, 2),
          "utf8",
        );
      else
        await fs.writeFile(
          result.filePath,
          await createDiagnosticsArchive(report),
        );
      return { path: result.filePath };
    });
    const displays = createDisplayService();
    handle("system:displays", () => displays.getDisplays());
    handle("system:copy-text", (text) => {
      if (typeof text !== "string" || text.length > 4 * 1024 * 1024)
        throw new Error("要复制的内容过大或无效。");
      clipboard.writeText(text);
      return true;
    });
    handle("mods:folder", async (id) => {
      const state = await service.getState();
      const mod = state.mods.find((item) => item.id === id);
      if (!mod?.available || !mod.contentPath)
        throw new Error("找不到此模组的本地文件。");
      const stat = await fs.stat(mod.contentPath);
      const target = stat.isDirectory()
        ? mod.contentPath
        : path.dirname(mod.contentPath);
      const error = await shell.openPath(target);
      if (error) throw new Error("无法打开模组所在文件夹。");
      return true;
    });
    handle("mods:page", async (id) => {
      if (typeof id !== "string") throw new Error("模组标识无效。");
      const match = /^(workshop|pdx):(\d{1,25})$/.exec(id);
      if (!match) throw new Error("此模组没有可打开的来源页。");
      await shell.openExternal(
        match[1] === "workshop"
          ? "https://steamcommunity.com/sharedfiles/filedetails/?id=" + match[2]
          : "https://mods.paradoxplaza.com/mods/" + match[2] + "/Any",
      );
      return true;
    });
    handle("playsets:official", () => service.getOfficialPlaysets());
    handle("playsets:import-official", (ids) =>
      service.importOfficialPlaysets(ids),
    );
    handle("playsets:import-text", (text) => service.importPlayset(text));
    handle("playsets:export-data", (id) => service.exportPlayset(id));
    handle("playsets:import-file", async () => {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: t("导入预设 JSON"),
        properties: ["openFile"],
        filters: [{ name: t("预设 JSON"), extensions: ["json"] }],
      });
      if (result.canceled || !result.filePaths[0]) return null;
      const file = result.filePaths[0];
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size > 4 * 1024 * 1024)
        throw new Error("预设文件必须是小于 4 MB 的 JSON 文件。");
      return service.importPlayset(await fs.readFile(file, "utf8"));
    });
    handle("playsets:export-file", async (id) => {
      const result = await service.exportPlayset(id);
      const dialogResult = await dialog.showSaveDialog(mainWindow, {
        title: t("导出官方兼容预设"),
        defaultPath: "hoi4-playset.json",
        filters: [{ name: t("预设 JSON"), extensions: ["json"] }],
      });
      if (dialogResult.canceled || !dialogResult.filePath) return null;
      await fs.writeFile(
        dialogResult.filePath,
        JSON.stringify(result.document, null, 2),
        "utf8",
      );
      return {
        path: dialogResult.filePath,
        omittedLocalMods: result.omittedLocalMods,
      };
    });
    handle("launcher:choose", () =>
      changeGameDirectory(async () => {
        const result = await dialog.showOpenDialog(mainWindow, {
          title: t("选择包含 hoi4.exe 的游戏文件夹"),
          properties: ["openDirectory"],
        });
        if (result.canceled || !result.filePaths[0]) return null;
        await service.saveSettings({ gameDirectory: result.filePaths[0] });
        return service.getState();
      }),
    );
    handle("launcher:launch", async (request) => {
      await pdxDownloads.ready();
      if (pdxDownloads.isBusy())
        throw new Error("正在下载或安装模组，请完成或取消后启动游戏。");
      await pdxRelocation.assertReady();
      storageIdle();
      if (pdxDownloads.isBusy())
        throw new Error("模组下载或安装已开始，请完成后再启动游戏。");
      if (publisher.isPublishing() || pdxPublisher.isPublishing())
        throw new Error("正在发布模组，请等待上传结束后启动游戏。");
      if (launching || Date.now() - lastLaunch < 8000)
        throw new Error("游戏正在启动，请稍候。");
      launching = true;
      try {
        let launchRequest = request;
        if (request && Object.hasOwn(request, "campaignId")) {
          if (
            Object.keys(request).some(
              (k) => !["campaignId", "reviewId"].includes(k),
            )
          )
            throw new Error("启动请求无效。");
          const checked = await campaigns.resolveContinue(
            request.campaignId,
            request.reviewId,
          );
          launchRequest = { resume: true, saveFilename: checked.filename };
        } else if (request && Object.hasOwn(request, "saveFilename"))
          throw new Error("启动请求无效。");
        const result = await service.launchGame(launchRequest);
        lastLaunch = Date.now();
        // Game launch has committed. Statistics failures must not report a failed
        // launch or roll back files while the successfully started game uses them.
        try {
          await gamePerformance.startSession({
            ...result.performanceContext,
            pid: result.pid,
            launchedAt: result.launchedAt,
            executable: result.executable,
          });
        } catch (error) {
          recordEvent(
            "performance:start",
            "error",
            error?.message || "性能采集启动失败，本次游戏仍可正常运行。",
          );
        }
        if (result.closeOnLaunch) setTimeout(() => mainWindow?.close(), 250);
        return result;
      } finally {
        launching = false;
      }
    });
    handle("window:minimize", () => mainWindow.minimize());
    handle("window:maximize", () =>
      mainWindow.isMaximized()
        ? mainWindow.unmaximize()
        : mainWindow.maximize(),
    );
    handle("window:close", () => mainWindow.close());

    mainWindow = new BrowserWindow({
      width: 1320,
      height: 900,
      minWidth: 1000,
      minHeight: 740,
      frame: false,
      show: false,
      backgroundColor: "#111419",
      title: t("IRONCLAD · 钢铁雄心 IV 启动器"),
      icon: path.join(__dirname, "..", "assets", "icon.ico"),
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    });
    mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    mainWindow.webContents.on("will-navigate", (event) =>
      event.preventDefault(),
    );
    mainWindow.webContents.session.setPermissionRequestHandler(
      (_webContents, _permission, callback) => callback(false),
    );
    mainWindow.once("ready-to-show", () => mainWindow.show());
    let allowPublishClose = false,
      publishClosePrompt = false;
    mainWindow.on("close", (event) => {
      if (
        (!publisher.isPublishing() &&
          !pdxPublisher.isPublishing() &&
          !steamMissing.isBusy() &&
          !pdxRelocation.isBusy() &&
          !modProjects.isBusy() &&
          !projectUpstream.isBusy() &&
          !campaigns.isBusy() &&
          !playsetSnapshots.isBusy() &&
          !modCoverage.isBusy() &&
          !pdxDownloads.isBusy()) ||
        allowPublishClose
      )
        return;
      event.preventDefault();
      if (publishClosePrompt) return;
      publishClosePrompt = true;
      dialog
        .showMessageBox(mainWindow, {
          type: "warning",
          title: t("模组操作进行中"),
          message: t(
            pdxRelocation.isBusy()
              ? "关闭启动器会中断目录迁移，下次启动将先恢复迁移事务。"
              : publisher.isPublishing() || pdxPublisher.isPublishing()
                ? "关闭启动器会中断发布准备或上传，已经提交的发布操作不会撤回。"
                : steamMissing.isBusy()
                  ? "关闭启动器会停止后续 Steam 请求；已提交的订阅或下载不会撤回，下次请先刷新确认结果。"
                  : campaigns.isBusy() ||
                      playsetSnapshots.isBusy() ||
                      modCoverage.isBusy()
                    ? "关闭启动器会中断当前本地检查或备份；未完成内容会保留，请在重开后核对。"
                    : modProjects.isBusy() || projectUpstream.isBusy()
                      ? "本地项目正在处理文件或获取上游更新，请等待完成。"
                      : "关闭启动器会中断下载；下次可继续已保存的片段，原有安装会保留。",
          ),
          buttons: [t("继续等待"), t("关闭启动器")],
          defaultId: 0,
          cancelId: 0,
        })
        .then(({ response }) => {
          if (response === 1) {
            allowPublishClose = true;
            mainWindow?.close();
          }
        })
        .finally(() => {
          publishClosePrompt = false;
        });
    });
    mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
    mainWindow.on("closed", () => {
      mainWindow = null;
    });
  });
}

app.on("window-all-closed", () => app.quit());
