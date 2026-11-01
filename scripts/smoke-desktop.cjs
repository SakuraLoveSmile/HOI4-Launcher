const {
  app,
  BrowserWindow,
  ipcMain,
  utilityProcess,
  nativeImage,
} = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert/strict");
const yauzl = require("yauzl");
const { createAccountService } = require("../electron/account-service.cjs");
const { createPdxPublisher } = require("../electron/pdx-publisher.cjs");
const {
  createPublishArchiveService,
} = require("../electron/publish-archive.cjs");
const { createLauncherService } = require("../electron/launcher-service.cjs");
const {
  createGamePerformanceService,
} = require("../electron/game-performance.cjs");
const {
  createSteamWorkerClient,
} = require("../electron/steam-worker-client.cjs");
const { createPublishService } = require("../electron/publish-service.cjs");
const { createPdxContentService } = require("../electron/pdx-content.cjs");
const { createPdxInstallService } = require("../electron/pdx-install.cjs");
const { createPdxDownloads } = require("../electron/pdx-downloads.cjs");
const { createPdxRelocation } = require("../electron/pdx-relocation.cjs");
const { createPdxSubscriptions } = require("../electron/pdx-subscriptions.cjs");
const { createPdxFixture } = require("./pdx-fixture.cjs");
const { createPdxResumeFixture } = require("./pdx-resume-fixture.cjs");

app.disableHardwareAcceleration();
app.on("window-all-closed", () => {});

let fixture;
let window;
let steamFixture;
let publishFixture;
let pdxFixture;
let relocationFixture;
let pdxPublishFixture;
let pdxPublisherFixture;
let accountFixture;
const timeout = setTimeout(() => {
  console.error("Desktop smoke test timed out.");
  app.exit(1);
}, 45000);

app
  .whenReady()
  .then(async () => {
    fixture = await fs.mkdtemp(
      path.join(os.tmpdir(), "ironclad-desktop-test-"),
    );
    await fs.mkdir(path.join(fixture, "appdata"), { recursive: true });
    app.setPath("userData", path.join(fixture, "appdata"));
    const service = createLauncherService({
      settingsPath: path.join(fixture, "settings.json"),
      documentsPath: fixture,
      steamRoots: [],
      processProbe: async () => null,
      spawnProcess: () => {
        throw new Error("Hidden smoke must never start a game process");
      },
    });
    const gamePerformance = createGamePerformanceService({
      storageDirectory: path.join(fixture, "game-performance"),
      monitorPath: path.resolve("assets/game-performance-monitor.exe"),
      spawnProcess: () => {
        throw new Error("Desktop UI checks must never start a game sampler");
      },
    });
    const pdxPublishDirectory = path.join(fixture, "publishing-pdx");
    const publicationRequests = [],
      publicationUploads = [],
      publicationFailures = [];
    const pdxHistoryFixture = createPdxFixture({
      revision: "2",
      title: "Hidden authorized revision fixture",
    });
    const pdxResumeFixture = createPdxResumeFixture();
    const historyApiQueries = [],
      historyCdnRequests = [];
    let publicationRecord = null,
      publicationBody = null;
    const response = (value) =>
      new Response(JSON.stringify(value), {
        headers: { "Content-Type": "application/json" },
      });
    accountFixture = createAccountService({
      sessionPath: path.join(fixture, "fixture-account-session.json"),
      fetchImpl: async (url, options) => {
        try {
          const address = new URL(url),
            method = options.method;
          assert.equal(address.origin, "https://api.paradox-interactive.com");
          publicationRequests.push({ method, path: address.pathname });
          if (
            method === "PUT" &&
            address.pathname === "/accounts/sessions/launcher-v2"
          )
            return response({
              session: {
                token: "isolated-access-fixture",
                userid: "fixture-publisher",
              },
            });
          assert.equal(
            JSON.parse(options.headers.Authorization).session.token,
            "isolated-access-fixture",
          );
          if (method === "GET" && address.pathname === "/accountdetails")
            return response({
              account: {
                email: "publisher@example.invalid",
                displayName: "Isolated PDX publisher",
              },
            });
          if (
            method === "GET" &&
            address.pathname === "/mods" &&
            address.searchParams.get("modId") === "123" &&
            address.searchParams.get("modVersion") === "2"
          ) {
            historyApiQueries.push(Object.fromEntries(address.searchParams));
            return pdxHistoryFixture.fetchImpl(url, options);
          }
          if (
            method === "GET" &&
            address.pathname === "/mods" &&
            address.searchParams.get("modId") === "123" &&
            address.searchParams.get("modVersion") === "3"
          )
            return pdxResumeFixture.fetchImpl(url, options);
          const upload = address.pathname.match(
            /^\/mods\/content\/hoi4\/([\da-f-]+)\/(content|thumbnail)\/([\w.-]+)$/,
          );
          if (method === "PUT" && upload) {
            const journal = JSON.parse(
              await fs.readFile(
                path.join(pdxPublishDirectory, "history.json"),
                "utf8",
              ),
            );
            assert.equal(
              journal.lastJob.publicationName,
              upload[1],
              "UUID must be durable before upload",
            );
            assert.equal(journal.lastJob.accountId, "fixture-publisher");
            assert.equal(journal.lastJob.commitSent, false);
            assert.equal(options.duplex, "half");
            assert.equal(
              typeof options.body?.[Symbol.asyncIterator],
              "function",
              "upload must use the real stream adapter",
            );
            const chunks = [];
            let length = 0;
            for await (const chunk of options.body) {
              length += chunk.byteLength;
              assert.ok(
                length < 1024 ** 2,
                "isolated smoke uploads must remain small",
              );
              chunks.push(Buffer.from(chunk));
            }
            const bytes = Buffer.concat(chunks);
            assert.equal(
              bytes.length,
              Number(options.headers["Content-Length"]),
            );
            publicationUploads.push({
              type: upload[2],
              filename: upload[3],
              bytes,
            });
            return response({ result: "OK" });
          }
          if (method === "POST" && address.pathname === "/mods/publish") {
            const body = JSON.parse(options.body);
            const journal = JSON.parse(
              await fs.readFile(
                path.join(pdxPublishDirectory, "history.json"),
                "utf8",
              ),
            );
            assert.equal(
              journal.lastJob.commitSent,
              true,
              "commit marker must be durable before POST",
            );
            assert.equal(journal.lastJob.publicationName, body.modName);
            assert.equal(body.gameName, "hoi4");
            assert.equal(body.displayName, "Hidden PDX publication");
            assert.equal(
              body.shortDescription,
              "A short isolated PDX summary.",
            );
            assert.equal(body.recommendedGameVersion, "1.20.*");
            assert.equal(body.acl, undefined);
            assert.equal(
              body.modId,
              undefined,
              "Steam binding must not turn PDX creation into an update",
            );
            assert.deepEqual(
              publicationUploads.map((item) => item.type),
              ["content", "thumbnail"],
            );
            assert.equal(body.contentFileName, publicationUploads[0].filename);
            assert.equal(body.thumbnail, publicationUploads[1].filename);
            publicationBody = body;
            publicationRecord = {
              modId: "800001",
              game: "hoi4",
              name: body.modName,
              state: "published",
              updating: false,
              modVersion: "1",
              acl: "public",
            };
            return response({ modId: "800001", state: "publishing" });
          }
          if (
            method === "GET" &&
            address.pathname === "/mods" &&
            address.searchParams.get("modId") === "800001"
          ) {
            assert.ok(publicationRecord);
            return response({ result: "OK", modDetail: publicationRecord });
          }
          throw new Error(
            `Unexpected isolated publication route: ${method} ${address.pathname}`,
          );
        } catch (error) {
          publicationFailures.push(error.message);
          throw error;
        }
      },
    });
    ipcMain.handle("launcher:state", () => service.getState());
    ipcMain.handle("launcher:save", (_event, patch) =>
      service.saveSettings(patch),
    );
    ipcMain.handle("system:displays", () => []);
    ipcMain.handle("account:state", () => accountFixture.getAccount());
    ipcMain.handle("news:state", () => ({
      items: [],
      source: "unavailable",
      error: "隔离桌面检查不请求网络。",
      fetchedAt: null,
    }));
    ipcMain.handle("launcher:status", () => service.getLaunchStatus());
    ipcMain.handle("performance:state", () => gamePerformance.getState());
    ipcMain.handle("performance:session", (_event, id) =>
      gamePerformance.getSession(id),
    );
    ipcMain.handle("performance:enabled", (_event, enabled) =>
      gamePerformance.setEnabled(enabled),
    );
    ipcMain.handle("playsets:official", () => service.getOfficialPlaysets());
    ipcMain.handle("mods:create", (_event, input) =>
      service.createLocalMod(input),
    );
    ipcMain.handle("mods:metadata", (_event, id) =>
      service.getLocalModMetadata(id),
    );
    ipcMain.handle("mods:thumbnail", (_event, id) =>
      service.getModThumbnail(id),
    );
    ipcMain.handle("mods:update-metadata", (_event, id, input) =>
      service.updateLocalModMetadata(id, input),
    );
    ipcMain.handle("steam:state", () => steamFixture.call("getState"));
    ipcMain.handle("publish:draft", (_event, id) =>
      publishFixture.getDraft(id),
    );
    ipcMain.handle("publish:prepare", (_event, input) =>
      publishFixture.prepare(input),
    );
    ipcMain.handle("publish:commit", (_event, id) => publishFixture.commit(id));
    ipcMain.handle("publish:status", () => publishFixture.getStatus());
    ipcMain.handle("publish:cancel", () => publishFixture.cancel());
    ipcMain.handle("pdx-publish:draft", (_event, id) =>
      pdxPublishFixture.getDraft(id),
    );
    ipcMain.handle("pdx-publish:prepare", (_event, input) =>
      pdxPublishFixture.prepare(input),
    );
    ipcMain.handle("pdx-publish:commit", (_event, id) =>
      pdxPublishFixture.commit(id),
    );
    ipcMain.handle("pdx-publish:status", () => pdxPublishFixture.getStatus());
    ipcMain.handle("pdx-publish:cancel", () => pdxPublishFixture.cancel());
    ipcMain.handle("pdx-publish:refresh", () =>
      pdxPublishFixture.refreshStatus(),
    );
    const pdxContentFixture = createPdxFixture();
    const pdxInstallerFixture = createPdxInstallService({
      storageDirectory: path.join(fixture, "pdx-installations"),
    });
    const migrationTarget = path.join(fixture, "custom-mods");
    await fs.mkdir(migrationTarget);
    const pdxDownloadOptions = {
      storageDirectory: path.join(fixture, "downloads"),
      account: accountFixture,
      content: createPdxContentService({
        integrity: require("./pdx-fixture-integrity.cjs").fixtureIntegrity,
        account: accountFixture,
        fetchImpl: async (url, options) => {
          assert.equal(
            new Headers(options.headers).has("Authorization"),
            false,
          );
          assert.equal(new Headers(options.headers).has("Cookie"), false);
          assert.equal(options.credentials, "omit");
          if (
            url.startsWith("https://modscontent.paradox-interactive.com/") &&
            url.includes("/3/complete/")
          )
            return pdxResumeFixture.fetchImpl(url, options);
          if (
            url.startsWith("https://api.paradox-interactive.com/mods?") &&
            new URL(url).searchParams.get("modVersion") === "2"
          )
            return new Response(null, { status: 401 });
          if (
            url.startsWith("https://modscontent.paradox-interactive.com/") &&
            url.includes("/2/complete/")
          ) {
            historyCdnRequests.push(url);
            return pdxHistoryFixture.fetchImpl(url, options);
          }
          return pdxContentFixture.fetchImpl(url, options);
        },
      }),
      installer: pdxInstallerFixture,
      getUserDataPath: async () => (await service.getState()).paths.userData,
    };
    pdxFixture = createPdxDownloads(pdxDownloadOptions);
    relocationFixture = createPdxRelocation({
      installer: pdxInstallerFixture,
      ready: () => pdxFixture.ready(),
      getUserDataPath: async () => (await service.getState()).paths.userData,
      isOtherBusy: () =>
        pdxFixture.isBusy() ||
        publishFixture?.isPublishing() ||
        pdxPublishFixture?.isPublishing(),
    });
    ipcMain.handle("pdx-storage:state", () => relocationFixture.getState());
    ipcMain.handle("pdx-storage:prepare", (_event, { reset }) =>
      relocationFixture.prepare({
        targetParent: reset ? null : migrationTarget,
      }),
    );
    ipcMain.handle("pdx-storage:commit", (_event, id) =>
      relocationFixture.commit(id),
    );
    ipcMain.handle("pdx-storage:discard", () => relocationFixture.discard());
    ipcMain.handle("pdx-storage:cancel", () => relocationFixture.cancel());
    ipcMain.handle("pdx-storage:recover", () => relocationFixture.recover());
    ipcMain.handle("pdx:state", () => pdxFixture.getState());
    ipcMain.handle("pdx:download", (_event, input) => pdxFixture.start(input));
    ipcMain.handle("pdx:pause", () => pdxFixture.pause());
    ipcMain.handle("pdx:resume", () => pdxFixture.resume());
    ipcMain.handle("pdx:limit", (_event, value) => pdxFixture.setLimit(value));
    ipcMain.handle("pdx:cancel", () => pdxFixture.cancel());
    ipcMain.handle("pdx:uninstall", (_event, id) => pdxFixture.uninstall(id));
    let subscribed = false;
    const subscriptionWrites = [];
    const subscriptions = createPdxSubscriptions({
      account: {
        getAccount: async () => ({
          status: "signed-in",
          account: { id: "fixture-account" },
        }),
        request: async (request) => {
          assert.equal(request.expectedAccountId, "fixture-account");
          if (request.path === "/mods")
            return {
              result: "OK",
              modDetail: {
                modId: "123",
                game: "hoi4",
                state: "published",
                isRegionBlocked: false,
                modVersion: "1",
              },
            };
          if (request.path === "/mods/sets/list/hoi4")
            return {
              result: "OK",
              sets: subscribed ? [{ id: 1, owned: true }] : [],
            };
          if (request.path === "/mods/sets/1/mods")
            return {
              result: "OK",
              mods:
                request.query.page === 1
                  ? [
                      {
                        modId: "123",
                        game: "hoi4",
                        displayName: "Hidden PDX fixture",
                        preferredVersion: null,
                      },
                    ]
                  : [],
            };
          if (request.path === "/mods/installed") {
            subscriptionWrites.push(request.method);
            subscribed = request.method === "POST";
            return subscribed
              ? { result: "OK", mods: [{ id: 123 }] }
              : { result: "OK" };
          }
          throw new Error("Unknown subscription fixture route");
        },
      },
    });
    ipcMain.handle("pdx:subscriptions", (_event, options) =>
      subscriptions.getState(options),
    );
    ipcMain.handle("pdx:subscribe", (_event, input) =>
      subscriptions.subscribe(input),
    );
    ipcMain.handle("pdx:unsubscribe", (_event, id) =>
      subscriptions.unsubscribe(id),
    );
    ipcMain.handle("catalog:search", () => ({
      items: [
        {
          id: "123",
          name: "Hidden PDX fixture",
          description: "Isolated download fixture",
          author: "Fixture",
        },
      ],
      page: 0,
      pageSize: 12,
      totalCount: 1,
      totalPages: 1,
      source: "network",
    }));
    // offscreen + show:false ensures this check never appears in the user's workspace.
    window = new BrowserWindow({
      width: 1320,
      height: 940,
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
      (_request, callback) => callback({ cancel: true }),
    );
    const errors = [];
    window.webContents.on("console-message", (event) => {
      if (event.level === "error") errors.push(event.message);
    });
    await window.loadFile(path.resolve("dist/index.html"));
    let text = "";
    for (let attempt = 0; attempt < 80; attempt++) {
      text = await window.webContents.executeJavaScript(
        "document.body.innerText",
      );
      if (text.includes("等待配置游戏目录")) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(
      text.includes("等待配置游戏目录"),
      "desktop renderer must load real fixture state",
    );
    assert.ok(
      !text.includes("界面预览"),
      "preload bridge must be available in sandboxed renderer",
    );
    assert.ok(!window.isVisible(), "test window must stay hidden");
    const result = await window.webContents.executeJavaScript(`(async () => {
    const state = await window.launcher.getState();
    const saved = await window.launcher.saveSettings({ launchMode: 'debug' });
    return { gameFound: state.game.found, savedMode: saved.launchMode, requireType: typeof require, processType: typeof process, methods: Object.keys(window.launcher) };
  })()`);
    assert.equal(result.gameFound, false);
    assert.equal(result.savedMode, "debug");
    assert.equal(result.requireType, "undefined");
    assert.equal(result.processType, "undefined");
    for (const method of [
      "getState",
      "saveSettings",
      "launchGame",
      "getOfficialPlaysets",
      "importPlayset",
      "exportPlayset",
      "getDisplays",
      "getLaunchStatus",
      "getGamePerformance",
      "getGamePerformanceSession",
      "setGamePerformanceEnabled",
      "getModThumbnail",
      "getPdxPublishDraft",
      "preparePdxPublish",
      "commitPdxPublish",
      "getPdxPublishStatus",
      "cancelPdxPublishPreparation",
      "refreshPdxPublish",
    ])
      assert.ok(result.methods.includes(method));
    assert.ok(!result.methods.includes("invoke"));
    const performanceBridge = await window.webContents
      .executeJavaScript(`(async () => {
      const initial = await window.launcher.getGamePerformance();
      const empty = await window.launcher.getGamePerformanceSession('12345678-1234-4234-8234-123456789abc');
      const disabled = await window.launcher.setGamePerformanceEnabled(false);
      await window.launcher.setGamePerformanceEnabled(true);
      Array.from(document.querySelectorAll('nav button')).find(button => button.textContent.includes('游戏统计')).click();
      return { supported: initial.supported, sessions: initial.sessions.length, empty, disabled: disabled.enabled };
    })()`);
    assert.deepEqual(performanceBridge, {
      supported: true,
      sessions: 0,
      empty: null,
      disabled: false,
    });
    for (let attempt = 0; attempt < 30; attempt++) {
      const ready = await window.webContents.executeJavaScript(
        "document.body.innerText.includes('暂无游玩记录') && document.querySelector('.performance-toggle [role=switch]')?.getAttribute('aria-checked') === 'true'",
      );
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(
      await window.webContents.executeJavaScript(
        "document.body.innerText.includes('整段游玩性能') && document.body.innerText.includes('暂无游玩记录') && document.querySelector('.performance-toggle [role=switch]')?.getAttribute('aria-checked') === 'true' && document.querySelector('nav [aria-current=page]')?.textContent.includes('游戏统计')",
      ),
    );
    await window.webContents.executeJavaScript(
      "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
    );
    await fs.mkdir(path.resolve("test-results/0.26.0"), { recursive: true });
    await fs.writeFile(
      path.resolve("test-results/0.26.0/performance-desktop.png"),
      (await window.webContents.capturePage()).toPNG(),
    );
    await window.webContents.executeJavaScript(
      "Array.from(document.querySelectorAll('nav button')).find(button => button.textContent.includes('总览')).click()",
    );
    const authored = await window.webContents.executeJavaScript(`(async () => {
      const result = await window.launcher.createLocalMod({name:'Hidden fixture',folder:'hidden_fixture',version:'1.0',supportedVersion:'1.19.*',tags:['Gameplay']});
      const mod = result.state.mods.find(item=>item.name==='Hidden fixture');
      const metadata = await window.launcher.getLocalModMetadata(mod.id);
      const updated = await window.launcher.updateLocalModMetadata(mod.id,{name:'Edited hidden fixture'});
      return {folder:metadata.folder,editable:mod.canEdit,updatedName:updated.state.mods.find(item=>item.id===mod.id).name,backups:updated.mod.backups.length};
    })()`);
    assert.deepEqual(authored, {
      folder: "hidden_fixture",
      editable: true,
      updatedName: "Edited hidden fixture",
      backups: 2,
    });
    const localMod = (await service.getState()).mods.find(
      (item) => item.name === "Edited hidden fixture",
    );
    const localMetadata = await service.getLocalModMetadata(localMod.id);
    const originalInnerDescriptor = await fs.readFile(
      path.join(localMetadata.contentPath, "descriptor.mod"),
    );
    const originalOuterDescriptor = await fs.readFile(
      localMetadata.descriptorPath,
    );
    const fixturePng = nativeImage
      .createFromBitmap(
        Buffer.from([
          0, 80, 255, 255, 0, 160, 255, 255, 255, 80, 0, 255, 255, 160, 0, 255,
        ]),
        { width: 2, height: 2 },
      )
      .toPNG();
    assert.equal(nativeImage.createFromBuffer(fixturePng).isEmpty(), false);
    await fs.writeFile(
      path.join(localMetadata.contentPath, "thumbnail.png"),
      fixturePng,
    );
    const cover = await window.webContents.executeJavaScript(`(async () => {
      const state = await window.launcher.getState();
      const mod = state.mods.find(item => item.name === 'Edited hidden fixture');
      const result = await window.launcher.getModThumbnail(mod.id);
      const image = new Image(); image.src = result.dataUrl;
      await image.decode();
      return {picture:mod.picture,mime:result.mime,width:image.naturalWidth,height:image.naturalHeight};
    })()`);
    assert.deepEqual(cover, {
      picture: "thumbnail.png",
      mime: "image/png",
      width: 2,
      height: 2,
    });
    assert.deepEqual(
      await fs.readFile(localMetadata.descriptorPath),
      originalOuterDescriptor,
    );
    assert.deepEqual(
      await fs.readFile(path.join(localMetadata.contentPath, "descriptor.mod")),
      originalInnerDescriptor,
    );
    assert.equal(
      JSON.parse(await fs.readFile(path.join(fixture, "settings.json"), "utf8"))
        .launchMode,
      "debug",
    );
    assert.deepEqual(errors, []);
    steamFixture = createSteamWorkerClient({
      fork: (...args) => utilityProcess.fork(...args),
      scriptPath: path.resolve("scripts/steam-fixture-worker.cjs"),
      timeoutMs: 5000,
      onPublishStatus: (job) => publishFixture?.recordStatus(job),
    });
    publishFixture = createPublishService({
      storageDirectory: path.join(fixture, "publishing"),
      resolveMod: (id) => service.getLocalModMetadata(id),
      isGameRunning: async () => false,
      steam: steamFixture,
    });
    const archives = createPublishArchiveService({
      storageDirectory: path.join(pdxPublishDirectory, "archives"),
    });
    pdxPublisherFixture = createPdxPublisher({
      account: accountFixture,
      createArchive: archives.createArchive,
      onPublishStatus: (job) => pdxPublishFixture.recordStatus(job),
      pollIntervalMs: 0,
      maxPolls: 3,
    });
    pdxPublishFixture = createPublishService({
      provider: "pdx",
      storageDirectory: pdxPublishDirectory,
      resolveMod: (id) => service.getLocalModMetadata(id),
      isGameRunning: async () => false,
      steam: {
        call: (method, ...args) => pdxPublisherFixture[method](...args),
      },
    });
    assert.equal((await steamFixture.call("getState")).connected, false);
    const steam = await steamFixture.call("connect");
    assert.equal(steam.connected, true);
    assert.equal(steam.account.name, "Isolated fixture");
    assert.deepEqual(
      (await steamFixture.call("browse", { page: 1, sort: "best" })).items,
      [],
    );
    await assert.rejects(steamFixture.call("subscribe", "123"), /属于 HOI4/);
    const reviewShown = await window.webContents.executeJavaScript(`(async()=>{
      const buttons=()=>[...document.querySelectorAll('button')];
      const click=text=>{const button=buttons().find(button=>button.textContent.trim()===text);if(!button)throw new Error('Missing button: '+text);button.click();};
      const until=async predicate=>{for(let i=0;i<60;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,80));}throw new Error('Fixture UI wait timed out');};
      click('刷新资料');
      document.querySelector('nav button:nth-child(2)').click();
      await until(()=>buttons().some(button=>button.textContent.trim()==='Edited hidden fixture'));
      click('Edited hidden fixture');await until(()=>buttons().some(button=>button.textContent.trim()==='发布到工坊'));
      click('发布到工坊');await until(()=>buttons().some(button=>button.textContent.trim()==='准备并检查内容'&&!button.disabled));
      click('准备并检查内容');await until(()=>document.body.innerText.includes('将上传以下快照'));
      return document.body.innerText.includes('私密')&&document.body.innerText.includes('确认创建并上传');
    })()`);
    assert.equal(reviewShown, true);
    // Offscreen painting can trail the DOM and CSS dialog transition.
    await new Promise((resolve) => setTimeout(resolve, 300));
    await fs.mkdir(path.resolve("test-results"), { recursive: true });
    await fs.writeFile(
      path.resolve("test-results/publish-review.png"),
      (await window.webContents.capturePage()).toPNG(),
    );
    const published = await window.webContents.executeJavaScript(`(async()=>{
      [...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='确认创建并上传').click();
      for(let i=0;i<60;i++){if(document.body.innerText.includes('发布已完成'))return true;await new Promise(resolve=>setTimeout(resolve,80));}return false;
    })()`);
    assert.equal(
      published,
      true,
      "reviewed fixture must publish through the actual hidden worker protocol",
    );
    assert.equal((await publishFixture.getStatus()).itemId, "900001");
    assert.equal(
      JSON.parse(
        await fs.readFile(
          path.join(fixture, "publishing", "history.json"),
          "utf8",
        ),
      ).bindings[0].itemId,
      "900001",
    );
    assert.deepEqual(errors, []);
    steamFixture.disconnect();
    assert.equal(
      (
        await accountFixture.login({
          email: "publisher@example.invalid",
          password: "isolated-fixture-password",
          remember: false,
        })
      ).status,
      "signed-in",
    );
    const pdxReview = await window.webContents.executeJavaScript(`(async()=>{
      const buttons=()=>[...document.querySelectorAll('button')];
      const click=text=>{const button=buttons().find(button=>button.textContent.trim()===text);if(!button)throw new Error('Missing PDX publish button: '+text);button.click();};
      const until=async predicate=>{for(let i=0;i<100;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,80));}throw new Error('PDX publish UI wait timed out: '+document.body.innerText);};
      const fill=async(label,value)=>{
        const input=document.querySelector('[aria-label="'+label+'"]');if(!input)throw new Error('Missing PDX publish field: '+label);
        const prototype=input.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(prototype,'value').set.call(input,value);
        input.dispatchEvent(new Event('input',{bubbles:true}));
        await new Promise(resolve=>setTimeout(resolve,0));
      };
      document.querySelector('[aria-label="关闭对话框"]').click();
      await until(()=>!document.querySelector('[aria-label="关闭对话框"]'));
      document.querySelector('nav button:nth-child(2)').click();
      await until(()=>buttons().some(button=>button.textContent.trim()==='Edited hidden fixture'));
      click('Edited hidden fixture');await until(()=>buttons().some(button=>button.textContent.trim()==='发布到 Paradox Mods'));
      click('发布到 Paradox Mods');await until(()=>buttons().some(button=>button.textContent.trim()==='准备并检查内容'&&!button.disabled));
      const initialTarget=document.querySelector('[aria-label="目标 Paradox 编号"]').value;
      await fill('Paradox 发布标题','Hidden PDX publication');
      await fill('Paradox 发布简介','A short isolated PDX summary.');
      await fill('Paradox 发布描述','A complete isolated description for the PDX publication smoke test.');
      await fill('Paradox 推荐游戏版本','1.20.*');
      await fill('Paradox 预览图','thumbnail.png');
      await fill('Paradox 变更说明','First isolated publication.');
      click('准备并检查内容');await until(()=>document.body.innerText.includes('将上传以下快照'));
      return {initialTarget,text:document.body.innerText};
    })()`);
    assert.equal(
      pdxReview.initialTarget,
      "",
      "PDX form must not inherit the Steam publication ID",
    );
    assert.ok(pdxReview.text.includes("创建新的Paradox项目"));
    assert.ok(pdxReview.text.includes("Isolated PDX publisher"));
    assert.ok(pdxReview.text.includes("thumbnail.png"));
    assert.ok(pdxReview.text.includes("服务端默认"));
    assert.equal(publicationUploads.length, 0, "review alone must not upload");
    assert.equal(publicationRecord, null, "review alone must not publish");
    await new Promise((resolve) => setTimeout(resolve, 300));
    await fs.writeFile(
      path.resolve("test-results/pdx-publish-review.png"),
      (await window.webContents.capturePage()).toPNG(),
    );
    const pdxPublished = await window.webContents.executeJavaScript(`(async()=>{
      [...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='确认创建并上传').click();
      for(let i=0;i<100;i++){
        if(document.body.innerText.includes('发布已完成'))return {complete:true,text:document.body.innerText};
        if(document.body.innerText.includes('发布未完成'))break;
        await new Promise(resolve=>setTimeout(resolve,80));
      }
      return {complete:false,text:document.body.innerText};
    })()`);
    assert.deepEqual(publicationFailures, []);
    assert.equal(pdxPublished.complete, true, pdxPublished.text);
    assert.ok(pdxPublished.text.includes("800001"));
    assert.match(
      pdxPublished.text,
      /服务端可见性[：:]\s*public/,
      "published UI must render the provider visibility field",
    );
    const pdxStatus = await pdxPublishFixture.getStatus();
    assert.equal(pdxStatus.status, "succeeded");
    assert.equal(pdxStatus.itemId, "800001");
    assert.equal(pdxStatus.accountId, "fixture-publisher");
    assert.equal(pdxStatus.visibility, "public");
    assert.equal(pdxStatus.commitSent, true);
    assert.equal(pdxStatus.publicationName, publicationBody.modName);
    const pdxHistory = JSON.parse(
      await fs.readFile(path.join(pdxPublishDirectory, "history.json"), "utf8"),
    );
    const steamHistory = JSON.parse(
      await fs.readFile(
        path.join(fixture, "publishing", "history.json"),
        "utf8",
      ),
    );
    assert.equal(pdxHistory.bindings[0].itemId, "800001");
    assert.equal(pdxHistory.lastJob.status, "succeeded");
    assert.equal(pdxHistory.lastJob.publicationName, publicationBody.modName);
    assert.equal(steamHistory.bindings[0].itemId, "900001");
    assert.equal(
      (await pdxPublishFixture.getDraft(localMod.id)).existingItemId,
      "800001",
    );
    assert.equal(
      (await publishFixture.getDraft(localMod.id)).existingItemId,
      "900001",
    );
    assert.equal(
      publicationRequests.filter((request) => request.path === "/mods/publish")
        .length,
      1,
    );
    assert.ok(
      publicationRequests.some(
        (request) => request.method === "GET" && request.path === "/mods",
      ),
      "published must be confirmed by actual provider polling",
    );
    const uploadedFiles = await readFixtureZip(publicationUploads[0].bytes);
    assert.deepEqual([...uploadedFiles.keys()].sort(), [
      "descriptor.mod",
      "thumbnail.png",
    ]);
    assert.match(
      uploadedFiles.get("descriptor.mod").toString("utf8"),
      /supported_version="1\.20\.\*"/,
    );
    assert.deepEqual(uploadedFiles.get("thumbnail.png"), fixturePng);
    assert.deepEqual(publicationUploads[1].bytes, fixturePng);
    assert.deepEqual(
      await fs.readFile(path.join(localMetadata.contentPath, "descriptor.mod")),
      originalInnerDescriptor,
      "PDX snapshot version must not change the source descriptor",
    );
    assert.deepEqual(
      await fs.readFile(localMetadata.descriptorPath),
      originalOuterDescriptor,
      "publication IDs must not overwrite the source registration descriptor",
    );
    assert.ok(
      !window.isVisible(),
      "PDX publication test window must stay hidden",
    );
    assert.deepEqual(errors, []);
    for (const status of ["failed", "pending"]) {
      await pdxPublishFixture.recordStatus({
        ...pdxStatus,
        status,
        itemId: null,
        existingItemId: null,
        commitSent: true,
      });
      const retryDisabled = await window.webContents
        .executeJavaScript(`(async()=>{
        const buttons=()=>[...document.querySelectorAll('button')];
        const click=text=>{const button=buttons().find(button=>button.textContent.trim()===text);if(!button)throw new Error('Missing retry-state button: '+text);button.click();};
        const until=async predicate=>{for(let i=0;i<60;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,50));}throw new Error('Retry-state UI wait timed out');};
        document.querySelector('[aria-label="关闭对话框"]').click();
        await until(()=>!document.querySelector('[aria-label="关闭对话框"]'));
        click('Edited hidden fixture');await until(()=>buttons().some(button=>button.textContent.trim()==='发布到 Paradox Mods'));
        click('发布到 Paradox Mods');await until(()=>buttons().some(button=>button.textContent.trim()==='准备更新'));
        return buttons().find(button=>button.textContent.trim()==='准备更新').disabled;
      })()`);
      assert.equal(
        retryDisabled,
        status === "pending",
        "unknown submissions block retry, explicit failures allow preparation",
      );
    }
    await pdxPublishFixture.recordStatus(pdxStatus);
    const pdxInstalled = await window.webContents.executeJavaScript(`(async()=>{
      const buttons=()=>[...document.querySelectorAll('button')];
      const click=text=>{const button=buttons().find(button=>button.textContent.trim()===text);if(!button)throw new Error('Missing button: '+text);button.click();};
      const until=async predicate=>{for(let i=0;i<100;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,80));}throw new Error('PDX fixture UI wait timed out');};
      document.querySelector('[aria-label="关闭对话框"]').click();
      click('发现模组'); await until(()=>buttons().some(button=>button.textContent.trim()==='下载并安装'));
      click('下载并安装'); await until(()=>document.body.innerText.includes('模组已安装，可在模组库中加入预设。'));
      const state=await window.launcher.getState();
      return state.mods.find(mod=>mod.id==='pdx:123');
    })()`);
    assert.equal(pdxInstalled.available, true);
    assert.equal(pdxInstalled.installedRevision, "1");
    assert.equal(pdxInstalled.source, "pdx");
    assert.equal(pdxContentFixture.calls.length, 3);
    await window.webContents.executeJavaScript(`(async()=>{
      const buttons=()=>[...document.querySelectorAll('button')];
      const click=text=>{const button=buttons().find(button=>button.textContent.trim()===text);if(!button)throw new Error('Missing subscription button: '+text);button.click();};
      const until=async predicate=>{for(let i=0;i<100;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,80));}throw new Error('Subscription UI timed out');};
      click('订阅到账号');await until(()=>document.body.innerText.includes('账号已订阅'));
      click('取消订阅');await until(()=>buttons().some(button=>button.textContent.trim()==='确认取消订阅'));
      click('确认取消订阅');await until(()=>document.body.innerText.includes('此账号还没有 HOI4 模组订阅。'));
    })()`);
    assert.equal(subscribed, false);
    assert.deepEqual(subscriptionWrites, ["POST", "DELETE"]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await fs.writeFile(
      path.resolve("test-results/pdx-download.png"),
      (await window.webContents.capturePage()).toPNG(),
    );
    const beforeMove = await service.getState();
    const fixtureGame = path.join(fixture, "fixture-game");
    await fs.mkdir(fixtureGame);
    await fs.writeFile(
      path.join(fixtureGame, "hoi4.exe"),
      "isolated fixture; not an executable",
    );
    await service.saveSettings({
      gameDirectory: fixtureGame,
      playsets: beforeMove.settings.playsets.map((playset) => ({
        ...playset,
        modIds: ["pdx:123"],
        modOrder: ["pdx:123"],
        modReferences: [
          {
            id: "pdx:123",
            name: "Hidden PDX fixture",
            source: "pdx",
            remoteId: "123",
            version: "1",
          },
        ],
      })),
    });
    const selectedBeforeMove = (await service.getState()).settings.playsets;
    const originalInstallation = (await pdxInstallerFixture.list())[0];
    const relocationReview = await window.webContents
      .executeJavaScript(`(async()=>{
      const buttons=()=>[...document.querySelectorAll('button')];
      const click=text=>{const button=buttons().find(button=>button.textContent.trim()===text);if(!button)throw new Error('Missing relocation button: '+text);button.click();};
      const until=async predicate=>{for(let i=0;i<100;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,50));}throw new Error('Relocation UI wait timed out: '+document.body.innerText);};
      click('刷新资料');click('设置');await until(()=>buttons().some(button=>button.textContent.trim()==='选择模组位置'&&!button.disabled));
      click('选择模组位置');await until(()=>document.body.innerText.includes('预览模组目录迁移'));
      return document.body.innerText;
    })()`);
    assert.ok(
      relocationReview.includes(path.join(migrationTarget, "hoi4", "ironclad")),
    );
    assert.equal(
      (await pdxInstallerFixture.list())[0].contentPath,
      originalInstallation.contentPath,
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    await fs.writeFile(
      path.resolve("test-results/pdx-relocation-review.png"),
      (await window.webContents.capturePage()).toPNG(),
    );
    const migrated = await window.webContents.executeJavaScript(`(async()=>{
      [...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='确认迁移').click();
      for(let i=0;i<120;i++){
        const state=await window.launcher.getPdxStorageState();
        if(!state.busy && state.job?.status==='succeeded')return state;
        if(state.job?.status==='failed')throw new Error(state.job.error);
        await new Promise(resolve=>setTimeout(resolve,50));
      }
      throw new Error('Migration did not settle');
    })()`);
    assert.equal(migrated.storage.isDefault, false);
    const movedInstallation = (await pdxInstallerFixture.list())[0];
    assert.ok(
      movedInstallation.contentPath.startsWith(
        migrated.storage.location + path.sep,
      ),
    );
    assert.equal(
      movedInstallation.descriptorPath,
      originalInstallation.descriptorPath,
    );
    assert.equal(
      movedInstallation.archiveSha256,
      originalInstallation.archiveSha256,
    );
    await assert.rejects(fs.stat(originalInstallation.contentPath), {
      code: "ENOENT",
    });
    const afterMove = await service.getState();
    assert.deepEqual(afterMove.settings.playsets, selectedBeforeMove);
    assert.equal(
      afterMove.mods.find((mod) => mod.id === "pdx:123").installedRevision,
      "1",
    );
    assert.equal(
      afterMove.mods.find((mod) => mod.id === "pdx:123").available,
      true,
    );
    const restored = await window.webContents.executeJavaScript(`(async()=>{
      const buttons=()=>[...document.querySelectorAll('button')];
      for(let i=0;i<100;i++){const button=buttons().find(button=>button.textContent.trim()==='恢复默认位置'&&!button.disabled);if(button){button.click();break;}await new Promise(resolve=>setTimeout(resolve,50));}
      for(let i=0;i<100;i++){const button=buttons().find(button=>button.textContent.trim()==='确认迁移');if(button){button.click();break;}await new Promise(resolve=>setTimeout(resolve,50));}
      for(let i=0;i<120;i++){const state=await window.launcher.getPdxStorageState();if(!state.busy&&state.job?.status==='succeeded'&&state.storage.isDefault)return state;if(state.job?.status==='failed')throw new Error(state.job.error);await new Promise(resolve=>setTimeout(resolve,50));}
      throw new Error('Restoring default location did not settle');
    })()`);
    assert.equal(
      restored.storage.location,
      path.join(fixture, "pdx-installations"),
    );
    await assert.rejects(fs.stat(movedInstallation.contentPath), {
      code: "ENOENT",
    });
    assert.deepEqual(
      (await service.getState()).settings.playsets,
      selectedBeforeMove,
    );
    const historicalPlaysets = selectedBeforeMove.map((playset) => ({
      ...playset,
      modReferences: playset.modReferences.map((reference) => ({
        ...reference,
        version: "2",
      })),
    }));
    await service.saveSettings({ playsets: historicalPlaysets });
    const historicalJob = await window.webContents
      .executeJavaScript(`(async()=>{
      const buttons=()=>[...document.querySelectorAll('button')];
      const click=text=>{const button=buttons().find(button=>button.textContent.trim()===text);if(!button)throw new Error('Missing historical download control: '+text);button.click();};
      const until=async predicate=>{for(let i=0;i<120;i++){if(await predicate())return;await new Promise(resolve=>setTimeout(resolve,50));}throw new Error('Historical download UI timed out');};
      click('刷新资料');
      await until(async()=> (await window.launcher.getState()).settings.playsets.some(p=>p.modReferences.some(r=>r.version==='2')));
      click('发现模组');
      await until(()=>buttons().some(button=>button.textContent.trim()==='下载缺失内容'));
      click('下载缺失内容');
      await until(async()=>{const s=await window.launcher.getPdxDownloads();return s.job?.status==='failed'&&s.job.errorCode==='ACCESS_DENIED';});
      await until(()=>buttons().some(button=>button.textContent.trim()==='重新下载'));
      const mode=document.querySelector('[aria-label="Paradox 下载身份"]');
      mode.value='account';mode.dispatchEvent(new Event('change',{bubbles:true}));
      await until(()=>document.body.innerText.includes('退出或重新登录会停止尚未完成的下载'));
      click('重新下载');
      await until(async()=>{const s=await window.launcher.getPdxDownloads();if(s.job?.authorization==='account'&&s.job?.status==='failed')throw new Error(s.job.error);return s.job?.authorization==='account'&&s.job?.status==='succeeded';});
      await until(()=>document.body.innerText.includes('安装完成')&&!document.body.innerText.includes('当前预设缺少的 Paradox 模组'));
      return (await window.launcher.getPdxDownloads()).job;
    })()`);
    assert.equal(historicalJob.authorization, "account");
    assert.equal(historicalJob.revision, "2");
    assert.deepEqual(historyApiQueries, [{ modId: "123", modVersion: "2" }]);
    assert.equal(historyCdnRequests.length, 2);
    assert.equal((await pdxInstallerFixture.list())[0].revision, "2");
    assert.deepEqual(
      (await service.getState()).settings.playsets,
      historicalPlaysets,
    );
    assert.deepEqual(publicationFailures, []);
    await fs.writeFile(
      path.resolve("test-results/pdx-authorized-download.json"),
      JSON.stringify(
        {
          checkedAt: new Date().toISOString(),
          anonymousDenied: true,
          accountMetadataQueries: historyApiQueries,
          cdnRequests: historyCdnRequests.length,
          cdnReceivedCredentials: false,
          installedRevision: historicalJob.revision,
          playsetsPreserved: true,
          realAccountUsed: false,
          realGameDataUsed: false,
        },
        null,
        2,
      ) + "\n",
    );
    assert.equal(window.isVisible(), false);
    assert.deepEqual(errors, []);
    const resumePlaysets = historicalPlaysets.map((playset) => ({
      ...playset,
      modReferences: playset.modReferences.map((reference) => ({
        ...reference,
        version: "3",
      })),
    }));
    await service.saveSettings({ playsets: resumePlaysets });
    const pausedJob = await window.webContents.executeJavaScript(`(async()=>{
      const buttons=()=>[...document.querySelectorAll('button')];
      const click=text=>{const button=buttons().find(button=>button.textContent.trim()===text);if(!button)throw new Error('Missing resume control: '+text);button.click();};
      const until=async predicate=>{for(let i=0;i<140;i++){if(await predicate())return;await new Promise(resolve=>setTimeout(resolve,50));}throw new Error('Pause UI did not settle');};
      click('刷新资料');
      await until(()=>document.body.innerText.includes('固定版本 3')&&buttons().some(button=>button.textContent.trim()==='下载缺失内容'&&!button.disabled));
      click('下载缺失内容');
      await until(async()=>{const state=await window.launcher.getPdxDownloads();return state.job?.progress?.receivedBytes>0&&buttons().some(button=>button.textContent.trim()==='暂停下载'&&!button.disabled);});
      click('暂停下载');
      await until(()=>buttons().some(button=>button.textContent.trim()==='继续下载'&&!button.disabled));
      return (await window.launcher.getPdxDownloads()).job;
    })()`);
    assert.equal(pausedJob.status, "paused");
    assert.equal(pausedJob.canResume, true);
    assert.equal(pdxResumeFixture.heldCancelled, true);
    assert.equal((await pdxInstallerFixture.list())[0].revision, "2");
    await fs.writeFile(
      path.resolve("test-results/pdx-download-paused.png"),
      (await window.webContents.capturePage()).toPNG(),
    );
    pdxFixture.dispose();
    const requestsBeforeReopen = pdxResumeFixture.requests.length;
    pdxFixture = createPdxDownloads(pdxDownloadOptions);
    assert.equal((await pdxFixture.getState()).job.canResume, true);
    assert.equal(pdxResumeFixture.requests.length, requestsBeforeReopen);
    const resumedJob = await window.webContents.executeJavaScript(`(async()=>{
      const buttons=()=>[...document.querySelectorAll('button')];
      buttons().find(button=>button.textContent.trim()==='继续下载').click();
      for(let i=0;i<180;i++){
        const state=await window.launcher.getPdxDownloads();
        if(state.job?.status==='failed')throw new Error(state.job.error);
        if(state.job?.status==='succeeded'&&state.job.revision==='3'&&!document.body.innerText.includes('当前预设缺少的 Paradox 模组'))return state.job;
        await new Promise(resolve=>setTimeout(resolve,50));
      }
      throw new Error('Resume UI did not finish');
    })()`);
    assert.equal(resumedJob.revision, "3");
    assert.equal((await pdxInstallerFixture.list())[0].revision, "3");
    assert.deepEqual(
      (await service.getState()).settings.playsets,
      resumePlaysets,
    );
    const resumeArchives = pdxResumeFixture.requests.filter(
      (request) => request.type === "archive",
    );
    assert.equal(resumeArchives.length, 2);
    assert.equal(
      resumeArchives[1].range,
      `bytes=${pausedJob.progress.receivedBytes}-`,
    );
    assert.equal(
      pdxResumeFixture.requests.filter((request) => request.type === "metadata")
        .length,
      2,
    );
    assert.deepEqual(publicationFailures, []);
    assert.deepEqual(errors, []);
    await fs.writeFile(
      path.resolve("test-results/pdx-resume-desktop.json"),
      JSON.stringify(
        {
          checkedAt: new Date().toISOString(),
          pausedBytes: pausedJob.progress.receivedBytes,
          reopenedWithoutNetwork: true,
          resumedRange: resumeArchives[1].range,
          reauthorized: true,
          installedRevision: resumedJob.revision,
          playsetsPreserved: true,
          realAccountUsed: false,
          realGameDataUsed: false,
        },
        null,
        2,
      ) + "\n",
    );
    await fs.mkdir(path.resolve("test-results"), { recursive: true });
    await fs.writeFile(
      path.resolve("test-results/desktop.png"),
      (await window.webContents.capturePage()).toPNG(),
    );
    console.log(
      "PASS hidden Electron: sandboxed bridge, authoring, Steam/PDX publication, downloads/subscriptions, reviewed relocation, account-authorized fixed revision, UI pause and disk-backed reopen/resume with exact Range and renewed metadata authorization; presets preserved, no renderer errors or visible window.",
    );
  })
  .then(() => finish(0))
  .catch((error) => {
    console.error(error);
    return finish(1);
  });

async function finish(code) {
  clearTimeout(timeout);
  steamFixture?.dispose();
  pdxFixture?.dispose();
  relocationFixture?.dispose();
  pdxPublisherFixture?.dispose();
  await accountFixture?.cancelLogin().catch(() => {});
  window?.destroy();
  // Only remove the freshly created, known test fixture under the system temp dir.
  if (
    fixture &&
    path.dirname(fixture) === os.tmpdir() &&
    path.basename(fixture).startsWith("ironclad-desktop-test-")
  )
    await fs
      .rm(fixture, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      })
      .catch(() => {});
  app.exit(code);
}

function readFixtureZip(bytes) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true }, (error, zip) => {
      if (error) return reject(error);
      const files = new Map();
      zip.on("error", reject);
      zip.on("end", () => resolve(files));
      zip.on("entry", (entry) => {
        if (entry.uncompressedSize > 1024 ** 2 || files.has(entry.fileName)) {
          zip.close();
          reject(
            new Error("Unexpected large or duplicate smoke archive entry"),
          );
          return;
        }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError) return reject(streamError);
          const chunks = [];
          stream.on("data", (chunk) => chunks.push(chunk));
          stream.on("error", reject);
          stream.on("end", () => {
            files.set(entry.fileName, Buffer.concat(chunks));
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}
