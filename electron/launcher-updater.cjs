"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { createReadStream } = require("node:fs");
const { spawn } = require("node:child_process");

const REPOSITORY = "SakuraLoveSmile/HOI4-Launcher";
const RELEASES_URL = `https://github.com/${REPOSITORY}/releases`;
const API_URL = `https://api.github.com/repos/${REPOSITORY}/releases/latest`;
const MAX_INSTALLER_BYTES = 1024 * 1024 * 1024;
const clone = (value) => JSON.parse(JSON.stringify(value));

function version(value) {
  if (typeof value !== "string") return null;
  const match =
    /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+([\da-z.-]+))?$/i.exec(
      value,
    );
  if (!match) return null;
  const numbers = match.slice(1, 4).map(Number);
  return numbers.every(Number.isSafeInteger) ? numbers : null;
}
function newer(candidate, current) {
  const left = version(candidate),
    right = version(current);
  if (!left || !right) throw new Error("启动器版本号无效，无法比较更新。");
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] > right[i];
  }
  return false;
}
function ownedAssetUrl(value, tag, name) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const expected = `/${REPOSITORY}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
  return url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    !url.port &&
    url.hostname === "github.com" &&
    url.pathname === expected &&
    !url.search &&
    !url.hash
    ? url.href
    : null;
}
function redirectAllowed(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    !url.port &&
    [
      "github.com",
      "release-assets.githubusercontent.com",
      "objects.githubusercontent.com",
    ].includes(url.hostname)
  );
}
async function hashFile(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
async function ordinaryFile(file) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error("更新文件必须是普通文件。");
  return stat;
}
async function safeDirectory(directory) {
  await fs.mkdir(directory, { recursive: true });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("更新缓存目录不可用。");
}

function createLauncherUpdater({
  currentVersion,
  storageDirectory,
  portableExecutable,
  isPackaged = false,
  platform = process.platform,
  fetchImpl = globalThis.fetch,
  spawnProcess = spawn,
  processId = process.pid,
  beforeInstall = async () => {},
  requestTimeoutMs = 30000,
  downloadTimeoutMs = 15 * 60 * 1000,
} = {}) {
  if (!version(currentVersion)) throw new Error("Invalid launcher version.");
  if (!storageDirectory || !path.isAbsolute(storageDirectory))
    throw new Error("Invalid update directory.");
  const portable = Boolean(
    isPackaged &&
      platform === "win32" &&
      typeof portableExecutable === "string" &&
      path.isAbsolute(portableExecutable) &&
      path.extname(portableExecutable).toLowerCase() === ".exe",
  );
  let state = {
    status: "idle",
    currentVersion,
    releasesUrl: RELEASES_URL,
    release: null,
    progress: { received: 0, total: 0 },
    error: null,
    canInstall: portable,
  };
  let selected = null,
    verified = null,
    controller = null,
    active = false;
  const getState = () => clone(state);
  async function discardVerified() {
    const previous = verified;
    verified = null;
    if (!previous) return;
    // Only discard this service's own unchanged cache entry. Unknown or
    // externally modified files are retained instead of removed by a scan.
    try {
      if (
        (await ordinaryFile(previous.file)).size === previous.size &&
        (await hashFile(previous.file)) === previous.digest
      )
        await fs.rm(previous.file);
    } catch {}
  }
  function idle() {
    if (active || state.status === "installing")
      throw new Error("启动器更新正在处理，请等待完成。");
  }
  async function request(url, signal) {
    let current = url;
    for (let count = 0; count < 6; count++) {
      signal.throwIfAborted();
      const response = await fetchImpl(current, {
        signal,
        redirect: "manual",
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "IRONCLAD-Launcher",
        },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        const next = location && new URL(location, current).href;
        await response.body?.cancel();
        if (!next || !redirectAllowed(next))
          throw new Error("GitHub 更新下载重定向地址无效。");
        current = next;
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 403 || response.status === 429)
          throw new Error("GitHub 请求受限，请稍后重试，或打开发布页面下载。");
        if (response.status === 404)
          throw new Error(
            "GitHub 尚未提供可用的正式发布，请打开发布页面查看。",
          );
        throw new Error(
          `GitHub 更新请求失败（HTTP ${response.status}），请稍后重试。`,
        );
      }
      return response;
    }
    throw new Error("GitHub 更新下载重定向次数过多。");
  }
  async function json(url, signal, limit) {
    const response = await request(url, signal);
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body || []) {
      signal.throwIfAborted();
      size += chunk.length;
      if (size > limit) throw new Error("GitHub 更新元数据过大。");
      chunks.push(Buffer.from(chunk));
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new Error("GitHub 更新元数据格式无效。");
    }
  }
  async function run(status, timeout, task) {
    idle();
    active = true;
    controller = new AbortController();
    const local = controller;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      local.abort();
    }, timeout);
    state.status = status;
    state.error = null;
    try {
      await task(local.signal);
    } catch (error) {
      state.status = local.signal.aborted && !timedOut ? "cancelled" : "error";
      state.error =
        state.status === "cancelled"
          ? null
          : timedOut
            ? "GitHub 更新请求超时，请检查网络后重试。"
            : error instanceof Error
              ? error.message
              : "启动器更新失败，请重试。";
    } finally {
      clearTimeout(timer);
      if (controller === local) controller = null;
      active = false;
    }
    return getState();
  }
  async function check() {
    return run("checking", requestTimeoutMs, async (signal) => {
      selected = null;
      await discardVerified();
      state.release = null;
      state.progress = { received: 0, total: 0 };
      const release = await json(API_URL, signal, 2 * 1024 * 1024);
      signal.throwIfAborted();
      const tag = release.tag_name;
      if (release.draft || release.prerelease || !version(tag))
        throw new Error("GitHub 未返回有效的正式版本。");
      const normalized = tag.replace(/^v/, "");
      const url = `${RELEASES_URL}/tag/${encodeURIComponent(tag)}`;
      if (release.html_url !== url)
        throw new Error("GitHub 发布来源与启动器仓库不匹配。");
      const assetName = `IRONCLAD-${normalized}-portable.exe`;
      const assets = Array.isArray(release.assets) ? release.assets : [];
      if (
        assets.filter((item) => item.name === assetName).length > 1 ||
        assets.filter((item) => item.name === "updater.json").length > 1
      )
        throw new Error("GitHub 发布包含重名更新资产，请在发布页面核对。");
      const asset = assets.find((item) => item.name === assetName);
      const manifest = assets.find((item) => item.name === "updater.json");
      const assetUrl =
        asset && ownedAssetUrl(asset.browser_download_url, tag, assetName);
      const manifestUrl =
        manifest &&
        ownedAssetUrl(manifest.browser_download_url, tag, "updater.json");
      const size = asset?.size;
      const digest = /^sha256:[a-f\d]{64}$/i.test(asset?.digest || "")
        ? asset.digest.slice(7).toLowerCase()
        : null;
      const usable = Boolean(
        assetUrl &&
          Number.isSafeInteger(size) &&
          size > 0 &&
          size <= MAX_INSTALLER_BYTES,
      );
      state.release = {
        version: normalized,
        notes:
          typeof release.body === "string" ? release.body.slice(0, 30000) : "",
        url,
        assetName,
        size: usable ? size : 0,
        canDownload: usable && Boolean(manifestUrl || digest),
      };
      selected = usable
        ? {
            tag,
            version: normalized,
            assetName,
            assetUrl,
            size,
            manifestUrl,
            digest,
          }
        : null;
      state.status = newer(normalized, currentVersion)
        ? "available"
        : "current";
    });
  }
  async function download() {
    idle();
    if (
      !selected ||
      !state.release?.canDownload ||
      !newer(selected.version, currentVersion)
    )
      throw new Error("此版本没有可校验的便携更新包，请打开发布页面下载。");
    const release = selected;
    return run("downloading", downloadTimeoutMs, async (signal) => {
      await discardVerified();
      state.progress = { received: 0, total: release.size };
      let digest = release.digest;
      if (release.manifestUrl) {
        const manifest = await json(release.manifestUrl, signal, 64 * 1024);
        if (
          manifest.schema !== 1 ||
          manifest.version !== release.version ||
          manifest.asset !== release.assetName ||
          manifest.size !== release.size ||
          !/^[a-f\d]{64}$/i.test(manifest.sha256 || "")
        )
          throw new Error("启动器更新校验清单无效或与发布文件不匹配。");
        if (digest && digest !== manifest.sha256.toLowerCase())
          throw new Error("GitHub 与更新清单的 SHA-256 不一致。");
        digest = manifest.sha256.toLowerCase();
      }
      if (!digest) throw new Error("此版本缺少 SHA-256 校验，无法自动更新。");
      await safeDirectory(storageDirectory);
      const temporary = path.join(storageDirectory, `${randomUUID()}.download`);
      const final = path.join(storageDirectory, `${randomUUID()}.exe`);
      let handle;
      try {
        handle = await fs.open(temporary, "wx");
        const response = await request(release.assetUrl, signal);
        const contentLength = response.headers.get("content-length");
        if (contentLength !== null && Number(contentLength) !== release.size)
          throw new Error("启动器更新包长度与发布信息不匹配。");
        const hash = createHash("sha256");
        let received = 0;
        for await (const chunk of response.body || []) {
          signal.throwIfAborted();
          received += chunk.length;
          if (received > release.size)
            throw new Error("启动器更新包超出声明大小。");
          hash.update(chunk);
          let offset = 0;
          while (offset < chunk.length) {
            const { bytesWritten } = await handle.write(
              chunk,
              offset,
              chunk.length - offset,
            );
            if (!bytesWritten)
              throw new Error("更新缓存写入失败，请检查磁盘空间。");
            offset += bytesWritten;
          }
          state.progress = { received, total: release.size };
        }
        signal.throwIfAborted();
        if (received !== release.size || hash.digest("hex") !== digest)
          throw new Error("启动器更新包 SHA-256 或大小校验失败，请重新下载。");
        await handle.sync();
        await handle.close();
        handle = null;
        await fs.rename(temporary, final);
        verified = {
          file: final,
          digest,
          size: received,
          version: release.version,
        };
        state.status = "ready";
      } finally {
        await handle?.close();
        await fs.rm(temporary, { force: true });
      }
    });
  }
  function cancel() {
    controller?.abort();
    return getState();
  }
  async function install() {
    idle();
    if (state.status !== "ready" || !verified)
      throw new Error("请先下载并校验启动器更新。");
    if (!portable)
      throw new Error("当前为开发版或非便携版，请从发布页面下载新版。");
    active = true;
    const update = verified;
    let staged;
    try {
      await beforeInstall();
      const original = await ordinaryFile(portableExecutable);
      if (
        (await ordinaryFile(update.file)).size !== update.size ||
        (await hashFile(update.file)) !== update.digest
      )
        throw new Error("已下载更新包发生变化，请重新下载。");
      const id = randomUUID();
      staged = path.join(
        path.dirname(portableExecutable),
        `.ironclad-update-${id}.exe`,
      );
      // Copy beside the portable executable before quitting: this validates
      // destination permissions and leaves replacement on the same volume.
      await fs.copyFile(
        update.file,
        staged,
        require("node:fs").constants.COPYFILE_EXCL,
      );
      if (
        (await ordinaryFile(staged)).size !== update.size ||
        (await hashFile(staged)) !== update.digest
      )
        throw new Error("更新安装副本校验失败，请重新下载。");
      const targetHash = await hashFile(portableExecutable);
      const current = await ordinaryFile(portableExecutable);
      if (
        current.size !== original.size ||
        current.mtimeMs !== original.mtimeMs
      )
        throw new Error("当前便携程序发生变化，请重新启动后更新。");
      await safeDirectory(storageDirectory);
      const configFile = path.join(storageDirectory, `${id}.json`);
      const logFile = path.join(storageDirectory, `${id}.log`);
      // PowerShell cannot read a script inside Electron's app.asar. Materialize
      // this bundled source as a unique ordinary file in the update cache.
      const helper = path.join(storageDirectory, `${id}.ps1`);
      await fs.writeFile(
        helper,
        await fs.readFile(path.join(__dirname, "launcher-update-helper.ps1")),
        { flag: "wx" },
      );
      await fs.writeFile(
        configFile,
        JSON.stringify({
          processId,
          source: staged,
          target: portableExecutable,
          backup: `${portableExecutable}.backup-${id}`,
          sha256: update.digest,
          originalSha256: targetHash,
          log: logFile,
        }),
        { flag: "wx" },
      );
      const executable = path.join(
        process.env.SystemRoot || "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      );
      const child = spawnProcess(
        executable,
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          helper,
          "-ConfigPath",
          configFile,
        ],
        {
          windowsHide: true,
          detached: true,
          stdio: "ignore",
        },
      );
      await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("spawn", resolve);
      });
      child.unref();
      state.status = "installing";
      state.error = null;
      state.installerLogPath = logFile;
      return { started: true, logPath: logFile };
    } catch (error) {
      if (staged) await fs.rm(staged, { force: true }).catch(() => {});
      state.error = error.message;
      throw error;
    } finally {
      active = false;
    }
  }
  return {
    getState,
    check,
    download,
    cancel,
    install,
    dispose: cancel,
    isBusy: () => active || state.status === "installing",
  };
}

module.exports = { createLauncherUpdater, RELEASES_URL, API_URL, newer };
