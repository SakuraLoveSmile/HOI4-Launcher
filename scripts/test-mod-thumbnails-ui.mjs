import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { deflateSync, crc32 } from "node:zlib";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { createLauncherService } = require("../electron/launcher-service.cjs");
const yazl = require("yazl");

function png(red, green, blue, width = 96, height = 64) {
  const pixels = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = y * (width * 4 + 1) + 1 + x * 4;
      const scale = x > y * 1.5 ? 1 : 0.5;
      pixels.set([red * scale, green * scale, blue * scale, 255], offset);
    }
  }
  function chunk(type, data) {
    const name = Buffer.from(type),
      length = Buffer.alloc(4),
      checksum = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
    return Buffer.concat([length, name, data, checksum]);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), "ironclad-thumbnail-ui-"));
const output = path.resolve("test-results");
let browser, server, page;
const errors = [];
try {
  await fs.mkdir(output, { recursive: true });
  const game = path.join(root, "game"),
    steam = path.join(root, "steam");
  const userData = path.join(root, "Paradox Interactive", "Hearts of Iron IV");
  const modDirectory = path.join(userData, "mod");
  const write = async (file, bytes) => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, bytes);
  };
  await write(path.join(game, "hoi4.exe"), "fixture only, never executable");
  await write(
    path.join(game, "launcher-settings.json"),
    '{"rawVersion":"1.19.4.0"}',
  );
  const covers = [
    png(210, 185, 110),
    png(100, 170, 145),
    png(130, 145, 205, 768, 512),
    png(190, 120, 125),
  ];
  const localCover = path.join(modDirectory, "local", "cover.png");
  await write(
    path.join(modDirectory, "local.mod"),
    'name="Local cover"\npath="mod/local"\npicture="cover.png"\n',
  );
  await write(localCover, covers[0]);
  await write(
    path.join(modDirectory, "implicit.mod"),
    'name="Implicit thumbnail"\npath="mod/implicit"\n',
  );
  await write(
    path.join(modDirectory, "implicit", "descriptor.mod"),
    'name="Implicit thumbnail"\n',
  );
  await write(path.join(modDirectory, "implicit", "thumbnail.png"), covers[0]);
  const jpegBytes = Buffer.from(
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAADAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDiKKKK9g8s/9k=",
    "base64",
  );
  await write(
    path.join(modDirectory, "misnamed.mod"),
    'name="JPEG named PNG"\npath="mod/misnamed"\npicture="thumbnail.png"\n',
  );
  await write(path.join(modDirectory, "misnamed", "thumbnail.png"), jpegBytes);
  const archive = new yazl.ZipFile();
  archive.addBuffer(covers[1], "images/cover.png");
  archive.addBuffer(
    Buffer.from('name="Archive cover"\npicture="images/cover.png"'),
    "descriptor.mod",
  );
  const zipChunks = [];
  archive.outputStream.on("data", (chunk) => zipChunks.push(chunk));
  const zipped = once(archive.outputStream, "end");
  archive.end();
  await zipped;
  await write(path.join(modDirectory, "archive.zip"), Buffer.concat(zipChunks));
  await write(
    path.join(modDirectory, "archive.mod"),
    'name="Archive cover"\narchive="mod/archive.zip"\npicture="images/cover.png"\n',
  );
  const workshop = path.join(
    steam,
    "steamapps",
    "workshop",
    "content",
    "394360",
    "123",
  );
  await write(
    path.join(workshop, "descriptor.mod"),
    'name="Steam cover"\npicture="cover.png"\n',
  );
  await write(path.join(workshop, "cover.png"), covers[2]);
  await write(
    path.join(modDirectory, "pdx_456_7.mod"),
    'name="PDX cover"\npath="mod/pdx"\npicture="cover.png"\n',
  );
  await write(path.join(modDirectory, "pdx", "cover.png"), covers[3]);
  await write(
    path.join(modDirectory, "unsafe.mod"),
    'name="Unsafe cover"\npath="mod/local"\npicture="../outside.png"\n',
  );
  await write(path.join(modDirectory, "outside.png"), covers[0]);
  await write(
    path.join(modDirectory, "browser-error.mod"),
    'name="Unreadable cover"\npath="mod/local"\npicture="cover.png"\n',
  );
  const launcher = createLauncherService({
    settingsPath: path.join(root, "settings.json"),
    documentsPath: root,
    steamRoots: [steam],
    processProbe: async () => null,
    spawnProcess: () => {
      throw new Error("Thumbnail test must not start a process");
    },
  });
  await launcher.saveSettings({ gameDirectory: game });
  const original = await launcher.getState();
  const thumbnailMembers = ["local:implicit.mod", "local:misnamed.mod"];
  const expectedPlaysets = original.settings.playsets.map((playset) =>
    playset.id === original.settings.activePlaysetId
      ? {
          ...playset,
          modIds: [...playset.modIds, ...thumbnailMembers],
          modOrder: [...playset.modOrder, ...thumbnailMembers],
        }
      : playset,
  );
  const reads = [];
  const api = {
    getState: () => launcher.getState(),
    getLaunchStatus: () => launcher.getLaunchStatus(),
    getNews: async () => ({ items: [], source: "fixture" }),
    getPdxStorageState: async () => {
      // Actual storage status resolves the user directory through a state scan.
      await launcher.getState();
      return { storage: {}, busy: false, job: null };
    },
    getModThumbnail: async (id) => {
      reads.push(id);
      if (id === "local:browser-error.mod")
        return { dataUrl: "data:image/png;base64,YmFk" };
      return launcher.getModThumbnail(id);
    },
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
  const deadline = Date.now() + 15000;
  while (!serverLog.includes("127.0.0.1:4176")) {
    if (server.exitCode !== null || Date.now() > deadline)
      throw new Error(serverLog);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  browser = await chromium.launch({
    channel: process.env.TEST_BROWSER_CHANNEL || "msedge",
    headless: true,
  });
  page = await browser.newPage({
    viewport: { width: 1320, height: 1050 },
    reducedMotion: "reduce",
  });
  const externalRequests = [],
    blockedEnvironmentRequests = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => {
    if (route.request().url().startsWith("http://127.0.0.1:4176/"))
      return route.continue();
    const url = new URL(route.request().url());
    if (
      url.hostname === "me.kis.v2.scr.kaspersky-labs.com" &&
      url.pathname.endsWith("/main.js")
    )
      blockedEnvironmentRequests.push(url.hostname);
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
  await page.getByRole("button", { name: /^模组管理/ }).waitFor();
  assert.equal(
    reads.length,
    0,
    "opening the overview must not eagerly load the whole library",
  );
  await launcher.saveSettings({ playsets: expectedPlaysets });
  assert.deepEqual(
    (await launcher.getState()).settings.playsets,
    expectedPlaysets,
  );
  await page.reload();
  await page.getByRole("button", { name: /^模组管理/ }).click();
  const library = page.getByRole("region", { name: "已识别模组", exact: true });
  const members = page.getByRole("region", {
    name: "当前播放集模组",
    exact: true,
  });
  for (const name of [
    "Local cover",
    "Implicit thumbnail",
    "JPEG named PNG",
    "Archive cover",
    "Steam cover",
    "PDX cover",
  ]) {
    const img = library.getByAltText(`${name} 封面`, { exact: true });
    await img.waitFor();
    await img.evaluate((element) => element.decode());
    assert.equal(
      await img.evaluate((element) => element.naturalWidth),
      name === "Steam cover" ? 512 : name === "JPEG named PNG" ? 2 : 96,
    );
  }
  async function matchingColumnCovers() {
    for (const [name, width] of [
      ["Implicit thumbnail", 96],
      ["JPEG named PNG", 2],
    ]) {
      const left = library.getByAltText(`${name} 封面`, { exact: true });
      const right = members.getByAltText(`${name} 封面`, { exact: true });
      await right.waitFor();
      await right.evaluate((image) => image.decode());
      assert.equal(await right.evaluate((image) => image.naturalWidth), width);
      assert.equal(
        await right.getAttribute("src"),
        await left.getAttribute("src"),
        `${name} must show the same cover in both columns`,
      );
    }
  }
  await matchingColumnCovers();
  for (const id of thumbnailMembers)
    assert.equal(
      reads.filter((read) => read === id).length,
      1,
      "library and current playset share a cover read for the current scan",
    );
  const unsafe = page.locator(".mod-row").filter({
    has: page.getByRole("button", { name: "Unsafe cover", exact: true }),
  });
  assert.equal(await unsafe.locator("img").count(), 0);
  await page.waitForFunction(() => {
    const row = [...document.querySelectorAll(".mod-row")].find((row) =>
      row.textContent.includes("Unreadable cover"),
    );
    return row?.querySelector(".mod-emblem svg") && !row.querySelector("img");
  });
  const firstSource = await page
    .getByAltText("Local cover 封面", { exact: true })
    .getAttribute("src");
  await page.getByRole("button", { name: "Local cover", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Local cover", exact: true });
  await dialog.getByAltText("Local cover 封面", { exact: true }).waitFor();
  assert.equal(
    reads.filter((id) => id === "local:local.mod").length,
    1,
    "library and details share a read for the current scan",
  );
  await page.screenshot({
    path: path.join(output, "mod-thumbnail-details.png"),
    fullPage: true,
    animations: "disabled",
  });
  await page.keyboard.press("Escape");
  await write(localCover, png(110, 185, 210));
  await page.getByRole("button", { name: "刷新资料", exact: true }).click();
  await page.waitForFunction((oldSource) => {
    const img = document.querySelector('img[alt="Local cover 封面"]');
    return img?.src !== oldSource && img?.complete && img?.naturalWidth === 96;
  }, firstSource);
  await matchingColumnCovers();
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await page.screenshot({
    path: path.join(output, "mod-thumbnail-library.png"),
    fullPage: true,
  });
  await page.screenshot({
    path: path.join(output, "mod-thumbnail-both-columns.png"),
    fullPage: false,
  });
  assert.deepEqual(
    (await launcher.getState()).settings.playsets,
    expectedPlaysets,
  );
  assert.deepEqual(
    await fs.readFile(path.join(workshop, "cover.png")),
    covers[2],
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(externalRequests, []);
  const report = {
    checkedAt: new Date().toISOString(),
    headlessBrowser: "Edge",
    sources: [
      "local-directory",
      "local-zip",
      "Steam-directory",
      "registered-Paradox-directory",
    ],
    realBackend: true,
    overviewLoadsNoImages: true,
    sharedDetailRead: true,
    invalidPathAndBrowserDecodeFallback: true,
    implicitRootThumbnailWithoutDescriptorPicture: true,
    jpegBytesWithPngExtension: true,
    currentPlaysetCoversMatchLibrary: true,
    currentPlaysetCoversSurviveRefresh: true,
    sharedLibraryAndPlaysetCoverReads: true,
    onlyExplicitFixtureMembershipChanges: true,
    fixturePlaysetMemberIds: thumbnailMembers,
    displayCopiesBoundedTo512Pixels: true,
    refreshedCoverUpdated: true,
    playsetsPreserved: true,
    externalAppRequests: externalRequests.length,
    blockedEnvironmentScriptRequests: blockedEnvironmentRequests.length,
    electronExecuted: false,
  };
  await fs.writeFile(
    path.join(output, "mod-thumbnails-ui.json"),
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
      path: path.join(output, "mod-thumbnails-ui-failure.png"),
      fullPage: true,
    })
    .catch(() => {});
  throw error;
} finally {
  await browser?.close();
  if (server && server.exitCode === null) {
    server.kill();
    await once(server, "exit");
  }
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith("ironclad-thumbnail-ui-"));
  await fs.rm(root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 50,
  });
}
