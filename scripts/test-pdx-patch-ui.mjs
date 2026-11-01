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
const { createPdxContentService } = require("../electron/pdx-content.cjs");
const { createPdxDownloads } = require("../electron/pdx-downloads.cjs");
const { createPdxInstallService } = require("../electron/pdx-install.cjs");
const { createPdxArchiveCache } = require("../electron/pdx-archive-cache.cjs");
const {
  createPatchFixture,
  digest,
} = require("../tests/fixtures/pdx-patches/create-fixture.cjs");

async function until(predicate) {
  const deadline = Date.now() + 15000;
  while (!(await predicate())) {
    if (Date.now() > deadline)
      throw new Error("Patch UI fixture did not settle");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
const root = await fs.mkdtemp(path.join(os.tmpdir(), "ironclad-patch-ui-"));
const output = path.resolve("test-results");
const fixture = await createPatchFixture({
  sessionPath: path.join(root, "account-session.json"),
});
const services = [];
let downloads, browser, server;
try {
  await fs.mkdir(output, { recursive: true });
  await fixture.login();
  const game = path.join(root, "game");
  await fs.mkdir(game);
  await fs.writeFile(path.join(game, "hoi4.exe"), "fixture, never executable");
  const launcher = createLauncherService({
    settingsPath: path.join(root, "settings.json"),
    documentsPath: root,
    steamRoots: [],
    processProbe: async () => null,
    spawnProcess: () => {
      throw new Error("Patch UI test must not launch a process");
    },
  });
  await launcher.saveSettings({ gameDirectory: game });
  const playsets = (await launcher.getState()).settings.playsets;
  const installer = createPdxInstallService({
    storageDirectory: path.join(root, "installed"),
  });
  const cacheOptions = { storageDirectory: path.join(root, "archives") };
  const options = {
    storageDirectory: path.join(root, "downloads"),
    installer,
    archiveCache: createPdxArchiveCache(cacheOptions),
    account: fixture.account,
    getUserDataPath: async () => (await launcher.getState()).paths.userData,
  };
  const open = () => {
    const service = createPdxDownloads({
      ...options,
      content: createPdxContentService({
        account: fixture.account,
        integrity: fixture.integrity(),
        fetchImpl: fixture.fetchImpl,
      }),
    });
    services.push(service);
    return service;
  };
  downloads = open();
  fixture.controls.latest = "1";
  await downloads.start({ modId: "123", authorization: "account" });
  await until(() => !downloads.isBusy());
  assert.equal((await downloads.getState()).job.status, "succeeded");
  const original = (await installer.list())[0];
  fixture.controls.latest = "2";
  fixture.controls.hold = "2/1_to_2/1_to_2.zip";
  const updateStart = fixture.requests.length;
  const api = {
    getState: () => launcher.getState(),
    getLaunchStatus: () => launcher.getLaunchStatus(),
    getAccount: () => fixture.account.getAccount(),
    getPdxDownloads: () => downloads.getState(),
    downloadPdxMod: (input) => downloads.start(input),
    repairPdxMod: (input) => downloads.repair(input),
    pausePdxDownload: () => downloads.pause(),
    resumePdxDownload: () => downloads.resume(),
    cancelPdxDownload: () => downloads.cancel(),
    setPdxDownloadLimit: (value) => downloads.setLimit(value),
    getPdxStorageState: async () => ({
      storage: await installer.getStorageState({
        userDataPath: (await launcher.getState()).paths.userData,
      }),
      busy: false,
      job: null,
    }),
    getPdxSubscriptions: async () => ({ accountId: null, items: [] }),
    getNews: async () => ({ items: [], source: "fixture" }),
    searchModCatalog: async () => ({
      items: [],
      source: "fixture",
      totalCount: 0,
      totalPages: 0,
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
      "4176",
      "--strictPort",
    ],
    {
      cwd: path.resolve("."),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let serverLog = "";
  server.stdout.on("data", (data) => {
    serverLog += data;
  });
  server.stderr.on("data", (data) => {
    serverLog += data;
  });
  await until(() => {
    if (server.exitCode !== null) throw new Error(serverLog);
    return serverLog.includes("127.0.0.1:4176");
  });
  browser = await chromium.launch({
    channel: process.env.TEST_BROWSER_CHANNEL || "msedge",
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [],
    externalRequests = [],
    environmentRequests = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin === "http://127.0.0.1:4176") return route.continue();
    if (
      url.hostname === "me.kis.v2.scr.kaspersky-labs.com" &&
      url.pathname.endsWith("/main.js")
    )
      environmentRequests.push(url.hostname);
    else externalRequests.push(url.href);
    return route.abort();
  });
  await page.exposeBinding("fixtureInvoke", (_source, method, args) => {
    assert.ok(Object.hasOwn(api, method), "Unexpected fixture API: " + method);
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
  await page.goto("http://127.0.0.1:4176");
  await page.getByRole("button", { name: "发现模组", exact: true }).click();
  await page.getByLabel("Paradox 下载身份").selectOption("account");
  await page.getByRole("button", { name: "检查并更新", exact: true }).click();
  await page.waitForFunction(
    () =>
      document.querySelector('[aria-label="Paradox 下载进度"]')?.value === 64,
  );
  await page.getByRole("button", { name: "暂停下载", exact: true }).click();
  await page.getByRole("button", { name: "继续下载", exact: true }).waitFor();
  const paused = (await downloads.getState()).job;
  assert.equal(paused.status, "paused");
  assert.equal(paused.progress.receivedBytes, 64);
  assert.equal(fixture.controls.cancelled, true);
  const readJournal = async () =>
    JSON.parse(
      await fs.readFile(path.join(root, "downloads/downloads.json"), "utf8"),
    );
  const journal = await readJournal();
  assert.equal(journal.partial.plan.sha256, digest(fixture.target));
  assert.equal(journal.partial.transferPlan.sha256, digest(fixture.patch));
  assert.equal(journal.partial.sourcePlan.sha256, digest(fixture.source));
  fixture.assertNoSecrets([paused, journal]);
  assert.equal(
    (await installer.list())[0].installationId,
    original.installationId,
  );
  await page.screenshot({
    path: path.join(output, "pdx-patch-ui-paused.png"),
    fullPage: true,
  });
  downloads.dispose();
  const beforeReopen = fixture.requests.length,
    grantsBeforeReopen = fixture.grants.length;
  downloads = open();
  assert.equal((await downloads.getState()).job.canResume, true);
  assert.equal(fixture.requests.length, beforeReopen);
  assert.equal(fixture.grants.length, grantsBeforeReopen);
  await page.reload();
  await page.getByRole("button", { name: "发现模组", exact: true }).click();
  await page.getByRole("button", { name: "继续下载", exact: true }).click();
  await page.getByText("安装完成", { exact: true }).waitFor();
  await until(() => !downloads.isBusy());
  const updated = (await installer.list())[0];
  assert.equal(updated.revision, "2");
  assert.equal(updated.archiveSha256, digest(fixture.target));
  const updateTransfers = fixture.requests
    .slice(updateStart)
    .filter((item) => item.resource.endsWith(".zip"));
  assert.deepEqual(
    updateTransfers.map((item) => item.resource),
    ["2/1_to_2/1_to_2.zip", "2/1_to_2/1_to_2.zip"],
  );
  assert.equal(updateTransfers[1].range, "bytes=64-");
  assert.equal(
    await fs.readFile(
      path.join(original.contentPath, "events/fixture.txt"),
      "utf8",
    ),
    "original event\n",
  );
  const lease = await createPdxArchiveCache(cacheOptions).open({
    modId: "123",
    revision: "2",
    bytes: fixture.target.length,
    sha256: digest(fixture.target),
  });
  assert.ok(lease);
  try {
    assert.deepEqual(
      await lease.read(0, fixture.target.length),
      fixture.target,
    );
  } finally {
    await lease.close();
  }
  await page.screenshot({
    path: path.join(output, "pdx-patch-ui-updated.png"),
    fullPage: true,
  });
  await fs.writeFile(
    path.join(updated.contentPath, "events/fixture.txt"),
    "preserved local change\n",
  );
  await page.getByLabel("Paradox 下载身份").selectOption("account");
  const beforeRepair = fixture.requests.length;
  await page.getByRole("button", { name: "验证并修复", exact: true }).click();
  await page.getByRole("button", { name: "开始验证", exact: true }).click();
  await page
    .getByText("已修复固定版本，旧内容已保留。", { exact: true })
    .waitFor();
  await until(() => !downloads.isBusy());
  const repaired = (await installer.list())[0];
  assert.equal(repaired.revision, "2");
  assert.notEqual(repaired.installationId, updated.installationId);
  assert.equal(
    await fs.readFile(
      path.join(repaired.contentPath, "events/fixture.txt"),
      "utf8",
    ),
    "modified event\n",
  );
  assert.equal(
    await fs.readFile(
      path.join(updated.contentPath, "events/fixture.txt"),
      "utf8",
    ),
    "preserved local change\n",
  );
  const repairRequests = fixture.requests
    .slice(beforeRepair)
    .map((item) => item.resource);
  assert.equal(
    repairRequests.filter((item) => item.startsWith("files/")).length,
    1,
  );
  assert.deepEqual(
    repairRequests.filter((item) => item.endsWith(".zip")),
    ["2/-1_to_2/-1_to_2.zip"],
  );
  assert.equal(
    (
      await installer.verify("123", {
        userDataPath: (await launcher.getState()).paths.userData,
        installationId: repaired.installationId,
      })
    ).status,
    "intact",
  );
  assert.deepEqual((await launcher.getState()).settings.playsets, playsets);
  assert.deepEqual(await fs.readdir(options.storageDirectory), [
    "downloads.json",
  ]);
  fixture.assertNoSecrets([
    await downloads.getState(),
    await installer.list(),
    await readJournal(),
  ]);
  await assert.rejects(fs.lstat(path.join(root, "account-session.json")), {
    code: "ENOENT",
  });
  await page.screenshot({
    path: path.join(output, "pdx-patch-ui-repaired.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1000, height: 740 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    true,
  );
  await page.screenshot({
    path: path.join(output, "pdx-patch-ui-compact.png"),
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(externalRequests, []);
  const report = {
    checkedAt: new Date().toISOString(),
    headlessBrowser: "Edge",
    signedDeltaUpdate: true,
    pausedBytes: 64,
    reopenedWithoutNetwork: true,
    resumedRange: updateTransfers[1].range,
    separateSourcePatchTargetIdentities: true,
    sourceBytes: fixture.source.length,
    patchBytes: fixture.patch.length,
    targetBytes: fixture.target.length,
    reconstructedZipVerifiedAcrossCacheReopen: true,
    files404ThenSignedInstallationPatch: true,
    modifiedOldContentPreserved: true,
    installedRevision: repaired.revision,
    playsetsPreserved: true,
    resourceGrants: fixture.grants.length,
    revocationChecks: fixture.requests.filter(
      (item) => item.resource === "revocation",
    ).length,
    externalAppRequests: externalRequests.length,
    blockedEnvironmentScriptRequests: environmentRequests.length,
    grantUrlsPersisted: false,
    realGameDataUsed: false,
    electronExecuted: false,
  };
  await fs.writeFile(
    path.join(output, "pdx-patch-ui.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  for (const service of services) service.dispose();
  await fixture.account.logout();
  await browser?.close();
  if (server && server.exitCode === null) {
    server.kill();
    await once(server, "exit");
  }
  await until(() => services.every((service) => !service.isBusy()));
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith("ironclad-patch-ui-"));
  await fs.rm(root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 50,
  });
}
