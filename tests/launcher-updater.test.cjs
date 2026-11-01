"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { EventEmitter } = require("node:events");
const { createHash } = require("node:crypto");
const {
  createLauncherUpdater,
  API_URL,
  newer,
} = require("../electron/launcher-updater.cjs");
const {
  createUpdateManifest,
} = require("../scripts/create-update-manifest.cjs");

const bytes = Buffer.from("Inert portable update fixture; never execute.");
const digest = createHash("sha256").update(bytes).digest("hex");
const assetUrl =
  "https://github.com/SakuraLoveSmile/HOI4-Launcher/releases/download/v0.28.0/IRONCLAD-0.28.0-portable.exe";
const manifestUrl =
  "https://github.com/SakuraLoveSmile/HOI4-Launcher/releases/download/v0.28.0/updater.json";
const release = () => ({
  tag_name: "v0.28.0",
  draft: false,
  prerelease: false,
  body: "Release notes <text>",
  html_url:
    "https://github.com/SakuraLoveSmile/HOI4-Launcher/releases/tag/v0.28.0",
  assets: [
    {
      name: "IRONCLAD-0.28.0-portable.exe",
      size: bytes.length,
      browser_download_url: assetUrl,
    },
    { name: "updater.json", size: 200, browser_download_url: manifestUrl },
  ],
});
const manifest = () => ({
  schema: 1,
  version: "0.28.0",
  asset: "IRONCLAD-0.28.0-portable.exe",
  size: bytes.length,
  sha256: digest,
});
const json = (data, options) => new Response(JSON.stringify(data), options);

async function fixture(t, patch = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ironclad-updater-"));
  t.after(() =>
    fs.rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    }),
  );
  const calls = [],
    spawns = [];
  const portableExecutable = path.join(root, "IRONCLAD's portable.exe");
  await fs.writeFile(
    portableExecutable,
    "Inert original executable; never execute.",
  );
  const storageDirectory = path.join(root, "cache");
  const data = { release: release(), manifest: manifest(), bytes };
  const config = {
    currentVersion: "0.27.0",
    storageDirectory,
    portableExecutable,
    isPackaged: true,
    platform: "win32",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url === API_URL) return json(data.release);
      if (url === manifestUrl) return json(data.manifest);
      if (url === assetUrl) return new Response(data.bytes);
      throw new Error(`Unexpected URL: ${url}`);
    },
    spawnProcess: (command, args, options) => {
      spawns.push({ command, args, options });
      const child = new EventEmitter();
      child.unref = () => {
        child.unreferenced = true;
      };
      process.nextTick(() => child.emit("spawn"));
      return child;
    },
    ...patch,
  };
  const service = createLauncherUpdater(config);
  return {
    root,
    data,
    service,
    calls,
    spawns,
    config,
    portableExecutable,
    storageDirectory,
  };
}

test("stable version comparison handles numeric ordering and rejects prereleases", () => {
  assert.equal(newer("v0.28.0", "0.27.0"), true);
  assert.equal(newer("0.10.0", "0.9.9"), true);
  assert.equal(newer("0.27.0", "0.27.0"), false);
  assert.equal(newer("0.26.9", "0.27.0"), false);
  assert.throws(() => newer("0.28.0-beta.1", "0.27.0"), /版本/);
});
test("check only retrieves the official stable release and returns a detached state", async (t) => {
  const f = await fixture(t);
  const state = await f.service.check();
  assert.equal(state.status, "available");
  assert.equal(state.release.canDownload, true);
  assert.equal(state.release.version, "0.28.0");
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].options.redirect, "manual");
  state.release.version = "tampered";
  assert.equal(f.service.getState().release.version, "0.28.0");
});
test("current or newer local versions do not offer a downgrade", async (t) => {
  const f = await fixture(t, { currentVersion: "0.29.0" });
  assert.equal((await f.service.check()).status, "current");
  await assert.rejects(f.service.download(), /没有可校验/);
});
for (const [name, change] of [
  [
    "prerelease",
    (data) => {
      data.prerelease = true;
    },
  ],
  [
    "draft",
    (data) => {
      data.draft = true;
    },
  ],
  [
    "invalid tag",
    (data) => {
      data.tag_name = "v0.28.0-beta";
    },
  ],
  [
    "foreign release page",
    (data) => {
      data.html_url = "https://github.com/evil/repo/releases/tag/v0.28.0";
    },
  ],
])
  test(`rejects ${name}`, async (t) => {
    const f = await fixture(t);
    change(f.data.release);
    assert.equal((await f.service.check()).status, "error");
  });
for (const responseStatus of [403, 404, 429, 500])
  test(`HTTP ${responseStatus} remains a retryable error with a release-page fallback`, async (t) => {
    const f = await fixture(t, {
      fetchImpl: async () =>
        new Response("failure", { status: responseStatus }),
    });
    const result = await f.service.check();
    assert.equal(result.status, "error");
    assert.match(result.error, /GitHub/);
    assert.equal(
      result.releasesUrl,
      "https://github.com/SakuraLoveSmile/HOI4-Launcher/releases",
    );
    assert.equal((await f.service.check()).status, "error");
  });
test("missing checksums and foreign download URLs disable automatic downloads", async (t) => {
  const f = await fixture(t);
  f.data.release.assets.pop();
  assert.equal((await f.service.check()).release.canDownload, false);
  f.data.release.assets.push(release().assets[1]);
  f.data.release.assets[0].browser_download_url =
    "https://example.org/update.exe";
  assert.equal((await f.service.check()).release.canDownload, false);
  await assert.rejects(f.service.download(), /发布页面/);
});
test("duplicate installer or manifest names are rejected", async (t) => {
  const f = await fixture(t);
  f.data.release.assets.push({ ...f.data.release.assets[0] });
  assert.equal((await f.service.check()).status, "error");
  f.data.release = release();
  f.data.release.assets.push({ ...f.data.release.assets[1] });
  assert.equal((await f.service.check()).status, "error");
});
test("checking again removes only the service's unchanged verified installer", async (t) => {
  const f = await fixture(t);
  await f.service.check();
  await f.service.download();
  const [verifiedFile] = await fs.readdir(f.storageDirectory);
  await f.service.check();
  assert.equal(
    (await fs.readdir(f.storageDirectory)).includes(verifiedFile),
    false,
  );
  await f.service.download();
  const [changedFile] = await fs.readdir(f.storageDirectory);
  await fs.writeFile(
    path.join(f.storageDirectory, changedFile),
    "keep externally changed file",
  );
  await f.service.check();
  assert.equal(
    await fs.readFile(path.join(f.storageDirectory, changedFile), "utf8"),
    "keep externally changed file",
  );
});
test("downloads manifest-bound bytes and installs only through a hidden detached helper", async (t) => {
  const f = await fixture(t);
  const original = await fs.readFile(f.portableExecutable);
  await f.service.check();
  const state = await f.service.download();
  assert.equal(state.status, "ready");
  assert.deepEqual(state.progress, {
    received: bytes.length,
    total: bytes.length,
  });
  const result = await f.service.install();
  assert.equal(result.started, true);
  assert.equal(f.service.getState().status, "installing");
  assert.equal(f.spawns.length, 1);
  assert.equal(f.spawns[0].options.windowsHide, true);
  assert.equal(f.spawns[0].options.detached, true);
  const args = f.spawns[0].args;
  const script = args[args.indexOf("-File") + 1];
  assert.equal(path.dirname(script), f.storageDirectory);
  assert.match(await fs.readFile(script, "utf8"), /WaitForExit/);
  const configPath = args[args.indexOf("-ConfigPath") + 1];
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  assert.equal(config.target, f.portableExecutable);
  assert.equal(config.sha256, digest);
  assert.equal(await fs.readFile(config.source, "utf8"), bytes.toString());
  assert.deepEqual(await fs.readFile(f.portableExecutable), original);
});
test("GitHub asset SHA-256 supports releases without a separate manifest", async (t) => {
  const f = await fixture(t);
  f.data.release.assets.pop();
  f.data.release.assets[0].digest = `sha256:${digest}`;
  await f.service.check();
  assert.equal((await f.service.download()).status, "ready");
  assert.deepEqual(
    f.calls.map((call) => call.url),
    [API_URL, assetUrl],
  );
});
for (const [name, change] of [
  [
    "manifest version",
    (f) => {
      f.data.manifest.version = "0.29.0";
    },
  ],
  [
    "manifest size",
    (f) => {
      f.data.manifest.size++;
    },
  ],
  [
    "manifest asset",
    (f) => {
      f.data.manifest.asset = "evil.exe";
    },
  ],
  [
    "mismatched digest",
    (f) => {
      f.data.manifest.sha256 = "a".repeat(64);
    },
  ],
  [
    "conflicting GitHub digest",
    (f) => {
      f.data.release.assets[0].digest = `sha256:${"a".repeat(64)}`;
    },
  ],
  [
    "truncated bytes",
    (f) => {
      f.data.bytes = bytes.subarray(1);
    },
  ],
  [
    "excess bytes",
    (f) => {
      f.data.bytes = Buffer.concat([bytes, Buffer.from("extra")]);
    },
  ],
])
  test(`rejects ${name} and never makes a bad installer ready`, async (t) => {
    const f = await fixture(t);
    change(f);
    await f.service.check();
    const result = await f.service.download();
    assert.equal(result.status, "error");
    await assert.rejects(f.service.install(), /先下载/);
    assert.equal(f.spawns.length, 0);
    const files = await fs.readdir(f.storageDirectory).catch(() => []);
    assert.equal(
      files.some((name) => /\.download$|\.exe$/.test(name)),
      false,
    );
  });
test("trusted GitHub release-asset redirects work and foreign redirects are rejected", async (t) => {
  const f = await fixture(t);
  const originalFetch = f.config.fetchImpl;
  const cdn =
    "https://release-assets.githubusercontent.com/github-production-release-asset/fixture?signature=fixture";
  let destination = cdn;
  const service = createLauncherUpdater({
    ...f.config,
    fetchImpl: async (url, options) => {
      if (url === assetUrl)
        return new Response(null, {
          status: 302,
          headers: { location: destination },
        });
      if (url === cdn) return new Response(bytes);
      return originalFetch(url, options);
    },
  });
  await service.check();
  assert.equal((await service.download()).status, "ready");
  destination = "https://evil.example/update.exe";
  assert.equal((await service.download()).status, "error");
});
test("cancel and timeout release the operation lock without claiming the latest version", async (t) => {
  const f = await fixture(t);
  const waitingFetch = async (url, { signal }) =>
    new Promise((resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => reject(new DOMException("aborted", "AbortError")),
        { once: true },
      );
    });
  const service = createLauncherUpdater({
    ...f.config,
    fetchImpl: waitingFetch,
    requestTimeoutMs: 20,
  });
  const first = service.check();
  await assert.rejects(service.check(), /正在处理/);
  service.cancel();
  assert.equal((await first).status, "cancelled");
  const result = await service.check();
  assert.equal(result.status, "error");
  assert.match(result.error, /超时/);
  assert.equal(service.isBusy(), false);
});
test("cancelling an in-progress stream removes the partial file", async (t) => {
  const f = await fixture(t);
  let streamController, downloadOptions;
  const originalFetch = f.config.fetchImpl;
  const service = createLauncherUpdater({
    ...f.config,
    fetchImpl: async (url, options) => {
      if (url !== assetUrl) return originalFetch(url, options);
      downloadOptions = options;
      return new Response(
        new ReadableStream({
          start(controller) {
            streamController = controller;
            controller.enqueue(bytes.subarray(0, 4));
            options.signal.addEventListener(
              "abort",
              () => controller.error(new DOMException("aborted", "AbortError")),
              { once: true },
            );
          },
        }),
      );
    },
  });
  await service.check();
  const pending = service.download();
  while (!streamController)
    await new Promise((resolve) => setImmediate(resolve));
  service.cancel();
  assert.equal(downloadOptions.signal.aborted, true);
  assert.equal((await pending).status, "cancelled");
  assert.deepEqual(await fs.readdir(f.storageDirectory), []);
});
test("development builds can download but cannot invoke the installer", async (t) => {
  const f = await fixture(t, { isPackaged: false });
  await f.service.check();
  await f.service.download();
  assert.equal(f.service.getState().canInstall, false);
  await assert.rejects(f.service.install(), /开发版/);
  assert.equal(f.spawns.length, 0);
});
test("installation rechecks verified bytes and respects the application guard", async (t) => {
  const f = await fixture(t, {
    beforeInstall: async () => {
      throw new Error("Game is running");
    },
  });
  await f.service.check();
  await f.service.download();
  await assert.rejects(f.service.install(), /Game is running/);
  assert.equal(f.spawns.length, 0);
  f.config.beforeInstall = async () => {};
  const third = createLauncherUpdater(f.config);
  await third.check();
  await third.download();
  const files = await fs.readdir(f.storageDirectory);
  for (const file of files.filter((name) => name.endsWith(".exe")))
    await fs.writeFile(path.join(f.storageDirectory, file), "tampered");
  await assert.rejects(third.install(), /发生变化/);
  assert.equal(f.spawns.length, 0);
});
test("helper spawn failures retain the original and allow an installation retry", async (t) => {
  const f = await fixture(t, {
    spawnProcess: () => {
      const child = new EventEmitter();
      process.nextTick(() => child.emit("error", new Error("spawn denied")));
      return child;
    },
  });
  await f.service.check();
  await f.service.download();
  await assert.rejects(f.service.install(), /spawn denied/);
  assert.equal(f.service.getState().status, "ready");
  assert.equal(
    await fs.readFile(f.portableExecutable, "utf8"),
    "Inert original executable; never execute.",
  );
  assert.equal(
    (await fs.readdir(f.root)).some((name) =>
      name.startsWith(".ironclad-update"),
    ),
    false,
  );
});
test("release manifest generator hashes the exact portable artifact", async (t) => {
  const f = await fixture(t);
  const directory = path.join(f.root, "release");
  await fs.mkdir(directory);
  await fs.writeFile(
    path.join(directory, "IRONCLAD-0.28.0-portable.exe"),
    bytes,
  );
  const result = await createUpdateManifest({ version: "0.28.0", directory });
  assert.deepEqual(result, manifest());
  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(directory, "updater.json"), "utf8")),
    manifest(),
  );
  await assert.rejects(
    createUpdateManifest({ version: "0.28.0-beta", directory }),
    /stable/,
  );
});
