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
const { fixtureIntegrity } = require("./pdx-fixture-integrity.cjs");
const { createPdxDownloads } = require("../electron/pdx-downloads.cjs");
const { createPdxInstallService } = require("../electron/pdx-install.cjs");
const { createPdxArchiveCache } = require("../electron/pdx-archive-cache.cjs");
const { createPdxResumeFixture } = require("./pdx-resume-fixture.cjs");
const {
  createPdxPrivateResumeFixture,
} = require("./pdx-private-resume-fixture.cjs");
const {
  createPdxSignedResumeFixture,
} = require("./pdx-signed-resume-fixture.cjs");

const root = await fs.mkdtemp(path.join(os.tmpdir(), "ironclad-resume-ui-"));
const repairFlow = process.argv.includes("--repair"),
  signedContent = repairFlow || process.argv.includes("--signed"),
  protectedContent = signedContent || process.argv.includes("--private"),
  flowName = repairFlow
    ? "pdx-repair-ui"
    : signedContent
      ? "pdx-signed-ui"
      : protectedContent
        ? "pdx-private-ui"
        : "pdx-resume-ui",
  fixture = signedContent
    ? await createPdxSignedResumeFixture({
        sessionPath: path.join(root, "account-session.json"),
      })
    : protectedContent
      ? createPdxPrivateResumeFixture({
          sessionPath: path.join(root, "account-session.json"),
        })
      : createPdxResumeFixture(),
  output = path.resolve("test-results");
let browser, server, downloads;
try {
  await fs.mkdir(output, { recursive: true });
  if (protectedContent)
    await fixture.account.login({
      email: "private-ui@example.invalid",
      password: "private-ui-isolated-password",
      remember: false,
    });
  const game = path.join(root, "game");
  await fs.mkdir(game);
  await fs.writeFile(
    path.join(game, "hoi4.exe"),
    "fixture only, never executable",
  );
  const launcher = createLauncherService({
    settingsPath: path.join(root, "settings.json"),
    documentsPath: root,
    steamRoots: [],
    processProbe: async () => null,
    spawnProcess: () => {
      throw new Error("UI test must not start a process");
    },
  });
  await launcher.saveSettings({ gameDirectory: game });
  const initial = await launcher.getState();
  const playsets = initial.settings.playsets.map((playset) => ({
    ...playset,
    modIds: ["pdx:123"],
    modOrder: ["pdx:123"],
    modReferences: [
      {
        id: "pdx:123",
        source: "pdx",
        remoteId: "123",
        version: "3",
        name: "Resumable PDX fixture",
      },
    ],
  }));
  await launcher.saveSettings({ playsets });
  const installer = createPdxInstallService({
    storageDirectory: path.join(root, "installed"),
  });
  const downloadOptions = {
    storageDirectory: path.join(root, "downloads"),
    installer,
    ...(repairFlow
      ? {
          archiveCache: createPdxArchiveCache({
            storageDirectory: path.join(root, "archives"),
          }),
        }
      : {}),
    account: fixture.account,
    content: createPdxContentService({
      integrity: fixture.integrity?.() ?? fixtureIntegrity,
      account: fixture.account,
      fetchImpl: fixture.fetchImpl,
    }),
    getUserDataPath: async () => (await launcher.getState()).paths.userData,
  };
  downloads = createPdxDownloads(downloadOptions);
  const api = {
    getState: () => launcher.getState(),
    getLaunchStatus: () => launcher.getLaunchStatus(),
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
    ...(protectedContent
      ? { getAccount: () => fixture.account.getAccount() }
      : {}),
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
      "4175",
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
  const deadline = Date.now() + 15000;
  while (!serverLog.includes("127.0.0.1:4175")) {
    if (server.exitCode !== null || Date.now() > deadline)
      throw new Error(serverLog);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  browser = await chromium.launch({
    channel: process.env.TEST_BROWSER_CHANNEL || "msedge",
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  const externalRequests = [],
    environmentRequests = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => {
    if (route.request().url().startsWith("http://127.0.0.1:4175/"))
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
  await page.goto("http://127.0.0.1:4175");
  await page.getByRole("button", { name: "发现模组", exact: true }).click();
  if (protectedContent) {
    await page.getByLabel("Paradox 下载身份").selectOption("account");
    await page
      .getByText(
        "下载模组并安装到本机；私有内容需选择有权访问的当前账号。下载不会更改账号订阅。",
        { exact: true },
      )
      .waitFor();
  }
  await page.getByRole("button", { name: "下载缺失内容", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector('[aria-label="Paradox 下载进度"]')?.value > 0,
  );
  await page.getByRole("button", { name: "暂停下载", exact: true }).click();
  await page.getByRole("button", { name: "继续下载", exact: true }).waitFor();
  const paused = (await downloads.getState()).job;
  assert.equal(paused.status, "paused");
  assert.equal(fixture.heldCancelled, true);
  assert.equal(await page.getByLabel("Paradox 下载身份").isDisabled(), true);
  assert.deepEqual(await installer.list(), []);
  await page.screenshot({
    path: path.join(output, `${flowName}-paused.png`),
    fullPage: true,
  });
  downloads.dispose();
  const before = fixture.requests.length;
  const accountRequestsBefore = fixture.accountCalls?.length;
  if (protectedContent) {
    const journal = JSON.parse(
      await fs.readFile(path.join(root, "downloads", "downloads.json"), "utf8"),
    );
    assert.equal(journal.partial.plan.access, "repository");
    fixture.assertNoSecrets([paused, journal]);
  }
  downloads = createPdxDownloads({
    ...downloadOptions,
    content: createPdxContentService({
      integrity: fixture.integrity?.() ?? fixtureIntegrity,
      account: fixture.account,
      fetchImpl: fixture.fetchImpl,
    }),
  });
  assert.equal((await downloads.getState()).job.canResume, true);
  assert.equal(fixture.requests.length, before);
  if (protectedContent)
    assert.equal(fixture.accountCalls.length, accountRequestsBefore);
  await page.reload();
  await page.getByRole("button", { name: "发现模组", exact: true }).click();
  await page.getByRole("button", { name: "继续下载", exact: true }).click();
  await page.getByText("安装完成", { exact: true }).waitFor();
  await page
    .getByText("当前预设缺少的 Paradox 模组", { exact: true })
    .waitFor({ state: "hidden" });
  const final = (await downloads.getState()).job;
  assert.equal(final.status, "succeeded", final.error);
  assert.equal((await installer.list())[0].revision, "3");
  assert.deepEqual((await launcher.getState()).settings.playsets, playsets);
  const archives = fixture.requests.filter(
    (request) => request.type === "archive",
  );
  assert.equal(archives.length, 2);
  assert.equal(archives[1].range, `bytes=${paused.progress.receivedBytes}-`);
  assert.deepEqual(errors, []);
  assert.deepEqual(externalRequests, []);
  if (protectedContent) {
    assert.equal(final.authorization, "account");
    assert.deepEqual(
      fixture.grants.map((item) => item.resource),
      signedContent
        ? [
            ...fixture.signedResourceNames,
            `3/complete/${fixture.name}.zip`,
            ...fixture.signedResourceNames,
            `3/complete/${fixture.name}.zip`,
          ]
        : [
            "manifest",
            `${fixture.name}.zip`,
            "manifest",
            `${fixture.name}.zip`,
          ],
    );
    assert.equal(
      new Set(fixture.grants.map((item) => item.url)).size,
      signedContent ? 12 : 4,
    );
    if (signedContent)
      assert.equal(
        fixture.requests.filter((item) => item.type === "revocation").length,
        4,
      );
    fixture.assertNoSecrets([
      await downloads.getState(),
      await installer.list(),
      await fs.readFile(path.join(root, "downloads", "downloads.json"), "utf8"),
    ]);
    assert.deepEqual(fixture.failures, []);
    await assert.rejects(fs.lstat(path.join(root, "account-session.json")), {
      code: "ENOENT",
    });
  }
  let repairEvidence;
  if (repairFlow) {
    await page.getByLabel("Paradox 下载身份").selectOption("account");
    const beforeHealthy = fixture.requests.length,
      beforeHealthyAccount = fixture.accountCalls.length,
      original = (await installer.list())[0];
    await page.getByRole("button", { name: "验证并修复", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByText("验证固定版本", { exact: true })
      .waitFor();
    await page.screenshot({
      path: path.join(output, "pdx-repair-ui-review.png"),
      fullPage: true,
      animations: "disabled",
    });
    await page.getByRole("button", { name: "开始验证", exact: true }).click();
    await page.getByText("安装文件完整，无需修复。", { exact: true }).waitFor();
    assert.equal(downloads.isBusy(), false);
    assert.equal(fixture.requests.length, beforeHealthy);
    assert.equal(fixture.accountCalls.length - beforeHealthyAccount, 1);
    assert.equal(fixture.accountCalls.at(-1), "/accountdetails");
    assert.equal(
      (await installer.list())[0].installationId,
      original.installationId,
    );
    const contentFile = path.join(
        original.contentPath,
        "events",
        "fixture.txt",
      ),
      expected = await fs.readFile(contentFile);
    const handle = await fs.open(contentFile, "r+");
    try {
      await handle.write(Buffer.from("# changed"), 0, 9, 0);
    } finally {
      await handle.close();
    }
    await fs.writeFile(
      path.join(original.contentPath, "my-local-edit.txt"),
      "preserve this local addition",
    );
    await page.getByRole("button", { name: "验证并修复", exact: true }).click();
    await page.getByRole("button", { name: "开始验证", exact: true }).click();
    await page
      .getByText("已修复固定版本，旧内容已保留。", { exact: true })
      .waitFor();
    assert.equal(downloads.isBusy(), false);
    const repaired = (await downloads.getState()).job,
      current = (await installer.list())[0];
    assert.equal(repaired.operation, "repair");
    assert.equal(repaired.revision, "3");
    assert.equal(repaired.installed.repair.repaired, true);
    assert.equal(repaired.validation.changedFiles, 1);
    assert.equal(repaired.validation.extraFiles, 1);
    const reopenedCache = createPdxArchiveCache({
      storageDirectory: path.join(root, "archives"),
    });
    const cached = await reopenedCache.open({
      modId: "123",
      revision: "3",
      bytes: fixture.bytes.length,
      sha256: current.archiveSha256,
    });
    assert.ok(cached);
    try {
      assert.deepEqual(
        await cached.read(0, fixture.bytes.length),
        fixture.bytes,
      );
    } finally {
      await cached.close();
    }
    assert.deepEqual(await fs.readdir(path.join(root, "archives")), [
      `${current.archiveSha256}.zip`,
    ]);
    assert.notEqual(current.installationId, original.installationId);
    assert.deepEqual(
      await fs.readFile(
        path.join(current.contentPath, "events", "fixture.txt"),
      ),
      expected,
    );
    assert.equal(
      await fs.readFile(
        path.join(original.contentPath, "my-local-edit.txt"),
        "utf8",
      ),
      "preserve this local addition",
    );
    assert.equal(
      (
        await installer.verify("123", {
          userDataPath: (await launcher.getState()).paths.userData,
          installationId: current.installationId,
        })
      ).status,
      "intact",
    );
    assert.deepEqual((await launcher.getState()).settings.playsets, playsets);
    await page.getByText("文件检查结果", { exact: true }).click();
    await page.screenshot({
      path: path.join(output, "pdx-repair-ui-result.png"),
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
      path: path.join(output, "pdx-repair-ui-compact.png"),
      fullPage: true,
    });
    const { translate } = await import("../src/i18n-core.mjs");
    for (const language of ["en", "de"]) {
      const prefs = (await launcher.getState()).settings.launcherPreferences;
      await launcher.saveSettings({
        launcherPreferences: { ...prefs, language },
      });
      await page.reload();
      await page
        .getByRole("button", {
          name: translate(language, "发现模组"),
          exact: true,
        })
        .click();
      await page
        .getByRole("button", {
          name: translate(language, "验证并修复"),
          exact: true,
        })
        .click();
      await page
        .getByRole("dialog", {
          name: translate(language, "验证固定版本"),
          exact: true,
        })
        .waitFor();
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
        true,
      );
      await page.screenshot({
        path: path.join(output, `pdx-repair-ui-${language}.png`),
        fullPage: false,
        animations: "disabled",
      });
      await page
        .getByRole("dialog")
        .getByRole("button", { name: translate(language, "取消"), exact: true })
        .click();
    }
    const prefs = (await launcher.getState()).settings.launcherPreferences;
    await launcher.saveSettings({
      launcherPreferences: { ...prefs, language: "zh-hans" },
    });
    await page.reload();
    await page.getByRole("button", { name: "发现模组", exact: true }).click();
    await page.setViewportSize({ width: 1440, height: 1000 });
    fixture.assertNoSecrets([
      await downloads.getState(),
      await installer.list(),
      await fs.readFile(path.join(root, "downloads", "downloads.json"), "utf8"),
    ]);
    assert.deepEqual(errors, []);
    assert.deepEqual(externalRequests, []);
    assert.deepEqual(fixture.failures, []);
    repairEvidence = {
      healthyCheckWithoutContentRequests: true,
      healthyAccountSessionChecks: 1,
      pinnedRevision: "3",
      repairedChangedFiles: 1,
      preservedExtraFiles: 1,
      changedInstallationId: true,
      playsetsPreserved: true,
      languagesReviewed: ["zh-hans", "en", "de"],
      originalZipCacheVerifiedAcrossReopen: true,
    };
  }
  await page.screenshot({
    path: path.join(output, `${flowName}-complete.png`),
    fullPage: true,
  });
  const report = {
    checkedAt: new Date().toISOString(),
    headlessBrowser: "Edge",
    pausedBytes: paused.progress.receivedBytes,
    reopenedWithoutNetwork: true,
    resumedRange: archives[1].range,
    installedRevision: final.revision,
    playsetsPreserved: true,
    realGameDataUsed: false,
    electronExecuted: false,
    protectedContent,
    ...(signedContent
      ? {
          detachedSignaturesVerified: true,
          trustRoot: "generated isolated test root",
          revocationChecks: fixture.requests.filter(
            (item) => item.type === "revocation",
          ).length,
        }
      : {}),
    ...(protectedContent
      ? {
          resourceGrants: fixture.grants.length,
          grantUrlsPersisted: false,
          selectedAuthorization: final.authorization,
        }
      : {}),
    externalAppRequests: externalRequests.length,
    ...(repairEvidence ? { repair: repairEvidence } : {}),
    blockedEnvironmentScriptRequests: environmentRequests.length,
  };
  await fs.writeFile(
    path.join(output, `${flowName}.json`),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  downloads?.dispose();
  await fixture.account?.logout();
  await browser?.close();
  if (server && server.exitCode === null) {
    server.kill();
    await once(server, "exit");
  }
  const deadline = Date.now() + 5000;
  while (downloads?.isBusy() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 20));
  if (!downloads?.isBusy()) {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("ironclad-resume-ui-"));
    await fs.rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  }
}
