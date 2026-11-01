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
const {
  createSteamWorkshopService,
} = require("../electron/steam-workshop.cjs");
const { createSteamMissingService } = require("../electron/steam-missing.cjs");

async function until(predicate) {
  const deadline = Date.now() + 15000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("Fixture did not settle");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const root = await fs.mkdtemp(
  path.join(os.tmpdir(), "ironclad-steam-missing-ui-"),
);
const output = path.resolve("test-results");
let browser, server, page, missing, releaseCurrent;
const errors = [],
  calls = [],
  externalRequests = [],
  environmentRequests = [];
try {
  await fs.mkdir(output, { recursive: true });
  const game = path.join(root, "game"),
    steamRoot = path.join(root, "steam");
  const write = async (file, bytes) => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, bytes);
  };
  await write(path.join(game, "hoi4.exe"), "Fixture only; never execute");
  await write(
    path.join(game, "launcher-settings.json"),
    '{"rawVersion":"1.19.4.0"}',
  );
  const materialize = async (id) =>
    write(
      path.join(
        steamRoot,
        "steamapps",
        "workshop",
        "content",
        "394360",
        id,
        "descriptor.mod",
      ),
      `name="Fixture ${id}"\nsupported_version="1.19.*"\n`,
    );
  await materialize("789");
  const launcher = createLauncherService({
    settingsPath: path.join(root, "settings.json"),
    documentsPath: root,
    steamRoots: [steamRoot],
    processProbe: async () => null,
    spawnProcess: () => {
      throw new Error("Steam UI test must never start a game");
    },
  });
  await launcher.saveSettings({ gameDirectory: game });
  const importMembers = async (name, ids) =>
    launcher.importPlayset(
      JSON.stringify({
        game: "hoi4",
        name,
        mods: ids.map((id, index) => ({
          steamId: id,
          displayName: `Fixture ${id}`,
          position: index,
          enabled: index % 2 === 1,
        })),
      }),
    );
  await importMembers("Imported Steam fixture", [
    "456",
    "123",
    "789",
    ...Array.from({ length: 41 }, (_, i) => String(1000 + i)),
  ]);
  const originalPlaysets = (await launcher.getState()).settings.playsets;
  let accountId = 76561198000000000n,
    connections = 0,
    heldId = null,
    changeAccountAt = null,
    loseReplyAt = null;
  const flags = new Map([
    ["456", 1 | 32],
    ["789", 1 | 4],
  ]);
  const nativeItem = (id) => ({
    publishedFileId: id,
    consumerAppId: 394360,
    banned: false,
    title: `Fixture ${id}`,
  });
  const native = {
    localplayer: {
      getSteamId: () => ({ steamId64: accountId }),
      getName: () => "Fixture player",
    },
    utils: { getAppId: () => 394360 },
    workshop: {
      getSubscribedItems: () =>
        [...flags].filter(([, state]) => state & 1).map(([id]) => BigInt(id)),
      getItems: async (ids) => ({ items: ids.map(nativeItem) }),
      getItem: async (id) => {
        calls.push(["getItem", String(id)]);
        if (String(id) === heldId)
          await new Promise((resolve) => {
            releaseCurrent = resolve;
          });
        return nativeItem(id);
      },
      getAllItems: async () => ({ items: [], totalResults: 0 }),
      state: (id) => flags.get(String(id)) || 0,
      downloadInfo: () => ({ current: 0n, total: 1024n }),
      subscribe: async (id) => {
        calls.push(["subscribe", String(id)]);
        flags.set(String(id), 1);
        if (String(id) === changeAccountAt) accountId = 76561198000000001n;
      },
      unsubscribe: async () => {
        throw new Error("No unsubscription is expected");
      },
      download: (id, priority) => {
        calls.push(["download", String(id), priority]);
        if (String(id) === "1001") return false;
        flags.set(String(id), (flags.get(String(id)) || 0) | 16);
        return true;
      },
    },
  };
  const steam = createSteamWorkshopService({
    createClient: async () => {
      connections++;
      return native;
    },
  });
  const worker = {
    async call(method, input) {
      const result = await steam[method](input);
      if (method === "repairItem" && input.id === loseReplyAt)
        throw new Error("Fixture: accepted reply lost");
      return result;
    },
  };
  const openMissing = () =>
    createSteamMissingService({
      storageDirectory: path.join(root, "batch"),
      getLauncherState: () => launcher.getState(),
      steam: worker,
    });
  missing = openMissing();
  const api = {
    getState: () => launcher.getState(),
    getLaunchStatus: () => launcher.getLaunchStatus(),
    getNews: async () => ({ items: [], source: "fixture" }),
    getSteamState: () => steam.getState(),
    connectSteam: () => steam.connect(),
    browseWorkshop: (input) => steam.browse(input),
    getSteamMissingMods: () => missing.getState(),
    prepareSteamMissingMods: (input) => missing.prepare(input),
    commitSteamMissingMods: (id) => missing.commit(id),
    cancelSteamMissingMods: () => missing.cancel(),
    getPdxSubscriptions: async () => ({ accountId: null, items: [] }),
    getPdxDownloads: async () => ({
      job: null,
      installations: [],
      bytesPerSecond: 0,
    }),
    searchModCatalog: async () => ({
      items: [],
      totalCount: 0,
      totalPages: 0,
      page: 0,
      pageSize: 12,
    }),
  };
  server = spawn(
    process.execPath,
    [
      "node_modules/vite/bin/vite.js",
      "preview",
      "--host",
      "127.0.0.1",
      "--port",
      "4177",
      "--strictPort",
    ],
    {
      cwd: path.resolve("."),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let log = "";
  server.stdout.on("data", (data) => {
    log += data;
  });
  server.stderr.on("data", (data) => {
    log += data;
  });
  await until(() => {
    if (server.exitCode !== null) throw new Error(log);
    return log.includes("127.0.0.1:4177");
  });
  browser = await chromium.launch({
    channel: process.env.TEST_BROWSER_CHANNEL || "msedge",
    headless: true,
  });
  page = await browser.newPage({
    viewport: { width: 1320, height: 1050 },
    reducedMotion: "reduce",
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => {
    if (route.request().url().startsWith("http://127.0.0.1:4177/"))
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
  await page.exposeBinding("fixtureInvoke", (_source, method, args) => {
    assert.ok(Object.hasOwn(api, method), "Unexpected API: " + method);
    return api[method](...args);
  });
  await page.addInitScript((names) => {
    window.launcher = Object.fromEntries(
      names.map((name) => [
        name,
        (...args) => window.fixtureInvoke(name, args),
      ]),
    );
  }, Object.keys(api));
  const openPanel = async () => {
    await page.goto("http://127.0.0.1:4177");
    await page.getByRole("button", { name: "发现模组", exact: true }).click();
    await page
      .locator(".member-tabs")
      .getByRole("button", { name: "Steam 创意工坊", exact: true })
      .click();
    await page.getByRole("region", { name: "补齐预设 Steam 模组" }).waitFor();
  };
  const panel = () => page.getByRole("region", { name: "补齐预设 Steam 模组" });
  const review = async () => {
    await panel()
      .getByRole("button", { name: "审阅补齐计划", exact: true })
      .click();
    return page.getByRole("dialog", {
      name: "确认补齐 Steam 模组",
      exact: true,
    });
  };
  const submit = async () =>
    (await review())
      .getByRole("button", { name: "确认订阅并请求下载", exact: true })
      .click();
  const settle = async () => {
    await until(() => !missing.isBusy());
    return (await missing.getState()).job;
  };
  await openPanel();
  assert.equal(connections, 0, "opening the panel cannot initialize Steam");
  assert.equal(
    await panel()
      .getByRole("button", { name: "审阅补齐计划", exact: true })
      .isDisabled(),
    true,
  );
  await page.getByRole("button", { name: "连接 Steam", exact: true }).click();
  assert.equal(connections, 1);
  const dialog = await review();
  await dialog.waitFor();
  assert.equal(
    calls.length,
    0,
    "preparing and reviewing cannot submit native requests",
  );
  assert.equal(await dialog.locator(".publish-files li").count(), 40);
  assert.match(await dialog.innerText(), /Fixture player/);
  assert.match(
    await dialog.locator(".publish-files li").first().innerText(),
    /Fixture 456.*未启用/s,
  );
  await dialog
    .getByRole("button", { name: "补齐计划下一页", exact: true })
    .click();
  assert.equal(await dialog.locator(".publish-files li").count(), 3);
  await page.screenshot({
    path: path.join(output, "steam-missing-review.png"),
    fullPage: true,
    animations: "disabled",
  });
  await dialog
    .getByRole("button", { name: "确认订阅并请求下载", exact: true })
    .click();
  const first = await settle();
  assert.equal(first.status, "partial");
  assert.deepEqual(
    first.items.slice(0, 2).map(({ id, enabled }) => ({ id, enabled })),
    [
      { id: "456", enabled: false },
      { id: "123", enabled: true },
    ],
  );
  assert.equal(first.items.length, 43);
  assert.equal(
    first.items.find((item) => item.id === "1001").downloadRequest,
    "rejected",
  );
  assert.equal(
    first.items.at(-1).status,
    "submitted",
    "known item rejection permits later items",
  );
  assert.equal(
    calls.some(
      ([method, id]) =>
        ["subscribe", "download"].includes(method) && id === "456",
    ),
    false,
    "active Steam downloads are not duplicated",
  );
  assert.ok(
    calls
      .filter(([method]) => method === "download")
      .every(([, , priority]) => priority === false),
  );
  assert.deepEqual(
    (await launcher.getState()).settings.playsets,
    originalPlaysets,
  );
  await panel()
    .getByText(/部分请求未完成/)
    .waitFor();
  assert.match(await panel().innerText(), /有 43 个 Steam 模组文件缺失/);
  assert.equal(
    await panel().locator(".download-job .publish-files li").count(),
    40,
  );
  await panel()
    .getByRole("button", { name: "补齐结果下一页", exact: true })
    .click();
  assert.equal(
    await panel().locator(".download-job .publish-files li").count(),
    3,
  );
  assert.equal(
    await panel()
      .getByRole("button", { name: "补齐结果下一页", exact: true })
      .isDisabled(),
    true,
  );
  await panel()
    .getByRole("button", { name: "补齐结果上一页", exact: true })
    .click();
  await page.screenshot({
    path: path.join(output, "steam-missing-results.png"),
    fullPage: true,
    animations: "disabled",
  });
  for (const item of first.items)
    if (item.downloadRequest !== "rejected") await materialize(item.id);
  await panel()
    .getByRole("button", { name: "刷新本地模组", exact: true })
    .click();
  await panel()
    .getByText(/有 1 个 Steam 模组文件缺失/)
    .waitFor();
  assert.deepEqual(
    (await launcher.getState()).settings.playsets,
    originalPlaysets,
  );

  // A held native read does not block status, cancellation, or the renderer.
  await importMembers("Cancellation fixture", ["2001", "2002"]);
  heldId = "2001";
  await openPanel();
  await submit();
  await until(() => typeof releaseCurrent === "function");
  await panel()
    .getByRole("button", { name: "停止后续请求", exact: true })
    .click();
  await panel()
    .getByText(/正在停止后续请求/)
    .waitFor();
  assert.equal(missing.isBusy(), true);
  releaseCurrent();
  releaseCurrent = null;
  heldId = null;
  const cancelled = await settle();
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.items[0].downloadRequest, "accepted");
  assert.equal(cancelled.items[1].status, "cancelled");
  assert.equal(
    calls.some(([, id]) => id === "2002"),
    false,
  );

  await importMembers("Account change fixture", ["3001", "3002"]);
  changeAccountAt = "3001";
  await openPanel();
  await submit();
  const changed = await settle();
  assert.equal(changed.status, "blocked");
  assert.equal(changed.items[0].errorCode, "ACCOUNT_CHANGED");
  assert.equal(
    calls.some(([method, id]) => method === "download" && id === "3001"),
    false,
  );
  assert.equal(
    calls.some(([, id]) => id === "3002"),
    false,
  );
  accountId = 76561198000000000n;
  changeAccountAt = null;

  await importMembers("Unknown receipt fixture", ["4001", "4002"]);
  loseReplyAt = "4001";
  await openPanel();
  await submit();
  const unknown = await settle();
  assert.equal(unknown.status, "interrupted");
  assert.equal(unknown.items[0].status, "unknown");
  assert.equal(
    calls.some(([, id]) => id === "4002"),
    false,
  );
  missing.dispose();
  missing = openMissing();
  const countBeforeReopen = calls.length,
    connectionsBeforeReopen = connections;
  await openPanel();
  await panel()
    .getByText(/请求结果需核对/)
    .waitFor();
  assert.equal(calls.length, countBeforeReopen);
  assert.equal(connections, connectionsBeforeReopen);
  assert.deepEqual(errors, []);
  assert.deepEqual(externalRequests, []);
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  const report = {
    checkedAt: new Date().toISOString(),
    headlessBrowser: "Edge",
    realLauncherAndCoordinator: true,
    fakeNativeSteamOnly: true,
    explicitConnectAndReviewRequired: true,
    reviewedMembers: first.items.length,
    planAndResultsPagination: 40,
    disabledMembersAndOrderPreserved: true,
    normalDownloadPriority: true,
    alreadyActiveNotDuplicated: true,
    knownRejectionContinues: true,
    missingClearedOnlyAfterDiskRefresh: true,
    cancellationResponsiveDuringNativeWait: true,
    currentAcceptedRequestPreserved: true,
    accountChangeAndUnknownReceiptStopFollowingItems: true,
    reopenDoesNotReplayOrConnect: true,
    externalAppRequests: externalRequests.length,
    blockedEnvironmentScriptRequests: environmentRequests.length,
    realGameDataUsed: false,
    electronExecuted: false,
  };
  await fs.writeFile(
    path.join(output, "steam-missing-ui.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(
    JSON.stringify(
      { errors, body: await page?.locator("body").innerText() },
      null,
      2,
    ),
  );
  await page
    ?.screenshot({
      path: path.join(output, "steam-missing-ui-failure.png"),
      fullPage: true,
      animations: "disabled",
    })
    .catch(() => {});
  throw error;
} finally {
  releaseCurrent?.();
  missing?.dispose();
  await browser?.close();
  if (server && server.exitCode === null) {
    server.kill();
    await once(server, "exit");
  }
  await until(() => !missing?.isBusy());
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith("ironclad-steam-missing-ui-"));
  await fs.rm(root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 50,
  });
}
