"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID, createHash } = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");
const clone = (value) => JSON.parse(JSON.stringify(value));
const key = (value) => path.resolve(value).toLowerCase();

async function verifyManagedProjectSource(
  { installer, getLauncherState },
  modId,
  source,
) {
  if (!modId.startsWith("pdx:")) return;
  const state = await getLauncherState();
  const installation = (await installer.list()).find(
    (entry) =>
      entry.modId === modId.slice(4) &&
      entry.revision === source.upstreamRef?.revision &&
      key(entry.contentPath) === key(source.sourcePath) &&
      key(path.dirname(entry.descriptorPath)) ===
        key(path.join(state.paths.userData, "mod")),
  );
  const unavailable =
    "此 Paradox 安装尚未通过原版验证，请使用未知基线导入或先修复原版。";
  if (!installation) throw new Error(unavailable);
  const result = await installer.verify(modId.slice(4), {
    userDataPath: state.paths.userData,
    installationId: installation.installationId,
  });
  if (result.status !== "intact") throw new Error(unavailable);
}

async function cleanDownload(owned) {
  if (!owned) return true;
  try {
    const stat = await fs.lstat(owned.directory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.dev !== owned.stat.dev ||
      stat.ino !== owned.stat.ino ||
      stat.birthtimeMs !== owned.stat.birthtimeMs ||
      key(await fs.realpath(owned.directory)) !== key(owned.directory)
    )
      return false;
    const entries = await fs.readdir(owned.directory);
    if (entries.length) {
      if (
        entries.length !== 1 ||
        entries[0] !== "content.zip" ||
        !owned.verified
      )
        return false;
      const file = path.join(owned.directory, "content.zip"),
        before = await fs.lstat(file);
      const downloaded = owned.verified.stat;
      if (
        !before.isFile() ||
        before.isSymbolicLink() ||
        before.nlink !== 1 ||
        before.size !== owned.verified.bytes ||
        !downloaded ||
        ["dev", "ino", "birthtimeMs", "size", "mtimeMs", "ctimeMs"].some(
          (field) => before[field] !== downloaded[field],
        )
      )
        return false;
      const handle = await fs.open(file, "r");
      try {
        const opened = await handle.stat();
        if (opened.dev !== before.dev || opened.ino !== before.ino)
          return false;
        const digest = createHash("sha256"),
          buffer = Buffer.allocUnsafe(1024 * 1024);
        let bytes = 0;
        for (;;) {
          const { bytesRead } = await handle.read(
            buffer,
            0,
            buffer.length,
            null,
          );
          if (!bytesRead) break;
          bytes += bytesRead;
          if (bytes > owned.verified.bytes) return false;
          digest.update(buffer.subarray(0, bytesRead));
        }
        const after = await fs.lstat(file);
        if (
          bytes !== owned.verified.bytes ||
          digest.digest("hex") !== owned.verified.sha256 ||
          before.dev !== after.dev ||
          before.ino !== after.ino ||
          before.mtimeMs !== after.mtimeMs ||
          before.ctimeMs !== after.ctimeMs
        )
          return false;
      } finally {
        await handle.close();
      }
      await fs.unlink(file);
    }
    await fs.rmdir(owned.directory);
    return true;
  } catch (error) {
    if (error.code !== "ENOENT") return false;
    try {
      await fs.lstat(owned.directory);
      return false;
    } catch (directoryError) {
      return directoryError.code === "ENOENT";
    }
  }
}

function createModProjectUpstream({
  projects,
  getLauncherState,
  steam,
  content,
  account,
  storageDirectory,
  isGameRunning = async () => false,
  assertOperationAllowed = () => {},
  pollMs = 1500,
  maxSteamWaitMs = 30 * 60 * 1000,
}) {
  let job = null,
    controller = null,
    pending = null;
  const active = () => pending !== null;
  async function guard(signal) {
    signal?.throwIfAborted();
    await assertOperationAllowed();
    if (await isGameRunning())
      throw new Error("请先退出游戏，再获取上游更新。");
    signal?.throwIfAborted();
  }
  async function context(projectId) {
    const project = await projects.get(projectId);
    if (!project.upstreamRef) throw new Error("此项目尚未关联上游来源。");
    const current = await getLauncherState();
    if (key(project.userData) !== key(current.paths.userData))
      throw new Error("项目属于其他游戏用户目录，请切回原目录后操作。");
    return { project, ref: project.upstreamRef, current };
  }
  function stableSteam(item, expected) {
    if (!item.installed || item.needsUpdate || item.downloading || item.pending)
      throw new Error("Steam 模组尚未完成更新，请等待下载完成后重试。");
    if (
      expected &&
      (item.updatedAt !== expected.updatedAt ||
        item.account?.steamId !== expected.account?.steamId ||
        JSON.stringify(item.installation) !==
          JSON.stringify(expected.installation))
    )
      throw new Error("Steam 来源或账号发生变化，请重新获取候选版本。");
  }
  async function sourceForMod(
    modId,
    { requireStable = false, workshopInstall = false } = {},
  ) {
    const current = await getLauncherState();
    const original = current.mods.find((item) => item.id === modId);
    const mod = original && { ...original };
    if (
      !mod?.available ||
      !mod.contentPath ||
      mod.projectId ||
      /^local:ironclad_project_/.test(mod.id)
    )
      throw new Error("未找到可复制的原始模组，请刷新模组库。");
    let expected;
    if ((requireStable || workshopInstall) && mod.source === "workshop") {
      expected = await steam.call("getItem", mod.remoteId);
      stableSteam(expected);
      if (workshopInstall) {
        const folder = expected.installation?.folder;
        if (
          typeof folder !== "string" ||
          !path.isAbsolute(folder) ||
          !folder
            .replaceAll("\\", "/")
            .replace(/\/$/, "")
            .toLowerCase()
            .endsWith(`/workshop/content/394360/${mod.remoteId}`)
        )
          throw new Error("未找到可复制的原始模组，请刷新模组库。");
        mod.contentPath = path.resolve(folder);
        mod.descriptorPath = path.join(mod.contentPath, "descriptor.mod");
      }
    }
    const readDescriptor = async () => {
      const before = await fs.lstat(mod.descriptorPath);
      if (
        !before.isFile() ||
        before.isSymbolicLink() ||
        before.nlink !== 1 ||
        before.size > 1024 * 1024
      )
        throw new Error("来源描述文件不是有效的普通文件。");
      const handle = await fs.open(mod.descriptorPath, "r");
      try {
        const opened = await handle.stat();
        const bytes = await handle.readFile();
        const after = await fs.lstat(mod.descriptorPath);
        if (
          [opened, after].some(
            (stat) =>
              stat.dev !== before.dev ||
              stat.ino !== before.ino ||
              stat.size !== before.size ||
              stat.mtimeMs !== before.mtimeMs ||
              stat.ctimeMs !== before.ctimeMs,
          )
        )
          throw new Error("来源模组或游戏目录发生变化，请重新创建快照。");
        return bytes;
      } finally {
        await handle.close();
      }
    };
    const descriptor = await readDescriptor();
    const upstreamRef = ["workshop", "pdx"].includes(mod.source)
      ? {
          provider: mod.source,
          remoteId: mod.remoteId,
          modId: mod.id,
          ...(mod.installedRevision ? { revision: mod.installedRevision } : {}),
        }
      : null;
    if (expected) {
      if (expected.updatedAt !== undefined)
        upstreamRef.updatedAt = expected.updatedAt;
    }
    const checkSource = async () => {
      const state = await getLauncherState();
      const again = state.mods.find((item) => item.id === modId);
      if (
        !again?.available ||
        (!workshopInstall && key(again.contentPath) !== key(mod.contentPath)) ||
        again.installedRevision !== mod.installedRevision ||
        key(state.paths.userData) !== key(current.paths.userData)
      )
        throw new Error("来源模组或游戏目录发生变化，请重新创建快照。");
      if (expected)
        stableSteam(await steam.call("getItem", mod.remoteId), expected);
      if (!(await readDescriptor()).equals(descriptor))
        throw new Error("来源模组或游戏目录发生变化，请重新创建快照。");
    };
    return {
      sourcePath: mod.contentPath,
      sourceModId: mod.id,
      descriptorText: descriptor.toString("utf8"),
      upstreamRef,
      checkSource,
      name: mod.name,
    };
  }
  async function check(projectId, authorization = "anonymous") {
    if (!["anonymous", "account"].includes(authorization))
      throw new Error("下载身份无效。");
    const { ref, project } = await context(projectId);
    const observed =
      [...(project.history || [])]
        .reverse()
        .find(
          (entry) =>
            entry.type === "candidate" &&
            entry.upstreamRef?.modId === ref.modId,
        )?.upstreamRef || ref;
    if (ref.provider === "workshop") {
      const item = await steam.call("getItem", ref.remoteId);
      return {
        provider: ref.provider,
        checkedAt: new Date().toISOString(),
        name: item.name,
        updatedAt: item.updatedAt ?? null,
        needsUpdate: item.needsUpdate,
        installed: item.installed,
        downloading: item.downloading || item.pending,
        changed: item.needsUpdate || item.updatedAt !== observed.updatedAt,
      };
    }
    let binding;
    try {
      if (authorization === "account") binding = await account.bindSession({});
      const plan = await content.resolve({
        modId: ref.remoteId,
        ...(binding
          ? { expectedAccountId: binding.accountId, signal: binding.signal }
          : {}),
      });
      binding?.check();
      return {
        provider: "pdx",
        checkedAt: new Date().toISOString(),
        revision: plan.revision,
        bytes: plan.bytes,
        sha256: plan.sha256,
        changed: plan.revision !== observed.revision,
      };
    } finally {
      binding?.dispose();
    }
  }
  async function run(projectId, authorization, signal) {
    let binding, ownedDownload;
    try {
      await guard(signal);
      const { project, ref } = await context(projectId);
      const captureGuard = async () => {
        await guard(signal);
        binding?.check();
        const state = await getLauncherState();
        if (key(state.paths.userData) !== key(project.userData))
          throw new Error("项目属于其他游戏用户目录，请切回原目录后操作。");
      };
      const projectGuard = async () => {
        await captureGuard();
        const latest = await context(projectId);
        if (JSON.stringify(latest.ref) !== JSON.stringify(ref))
          throw new Error("上游关联已变化，请重新获取更新。");
      };
      if (ref.provider === "workshop") {
        job.status = "checking";
        let item = await steam.call("getItem", ref.remoteId);
        const actor = item.account?.steamId;
        if (
          !item.installed ||
          item.needsUpdate ||
          item.downloading ||
          item.pending
        ) {
          job.status = "waiting-steam";
          if (!item.downloading && !item.pending)
            await steam.call("download", ref.remoteId);
          const deadline = Date.now() + maxSteamWaitMs;
          do {
            await delay(pollMs, undefined, { signal });
            await projectGuard();
            item = await steam.call("getItem", ref.remoteId);
            if (item.account?.steamId !== actor)
              throw new Error("Steam 账号已变化，请重新连接。");
            job.progress = {
              receivedBytes: item.downloadedBytes,
              totalBytes: item.totalBytes,
            };
            if (Date.now() > deadline)
              throw new Error(
                "Steam 下载仍未完成，可稍后重新获取；已提交的下载由 Steam 管理。",
              );
          } while (
            !item.installed ||
            item.needsUpdate ||
            item.downloading ||
            item.pending
          );
        }
        stableSteam(item);
        const source = await sourceForMod(ref.modId, {
          requireStable: true,
          workshopInstall: true,
        });
        job.status = "capturing";
        await projects.captureCandidate(project.id, {
          ...source,
          checkSource: async () => {
            await captureGuard();
            await source.checkSource();
            stableSteam(await steam.call("getItem", ref.remoteId), item);
          },
        });
      } else {
        if (authorization === "account")
          binding = await account.bindSession({ signal });
        const effectiveSignal = binding?.signal || signal;
        job.status = "checking";
        const plan = await content.resolve({
          modId: ref.remoteId,
          signal: effectiveSignal,
          ...(binding ? { expectedAccountId: binding.accountId } : {}),
        });
        await projectGuard();
        // The verified complete ZIP becomes a candidate. No original registration
        // or current playset is changed and no installer repair targets the fork.
        await fs.mkdir(storageDirectory, { recursive: true });
        for (let p = path.resolve(storageDirectory); ; p = path.dirname(p)) {
          if (
            !(await fs.lstat(p)).isDirectory() ||
            (await fs.lstat(p)).isSymbolicLink()
          )
            throw new Error("上游下载目录不安全，请检查目录。");
          if (p === path.dirname(p)) break;
        }
        const directory = await fs.mkdtemp(
          path.join(storageDirectory, "candidate-"),
        );
        ownedDownload = {
          directory,
          stat: await fs.lstat(directory),
          verified: null,
        };
        const destination = path.join(directory, "content.zip");
        job.status = "downloading";
        job.revision = plan.revision;
        await content.download(plan, {
          resolvedPlan: plan,
          destination,
          signal: effectiveSignal,
          onProgress: (value) => {
            job.progress = clone(value);
          },
        });
        ownedDownload.verified = {
          bytes: plan.bytes,
          sha256: plan.sha256,
          stat: await fs.lstat(destination),
        };
        await projectGuard();
        job.status = "capturing";
        await projects.captureCandidate(project.id, {
          sourcePath: destination,
          upstreamRef: { ...ref, revision: plan.revision },
          checkSource: captureGuard,
        });
      }
      job.status = "succeeded";
      job.completedAt = new Date().toISOString();
    } catch (error) {
      job.status = signal.aborted ? "cancelled" : "failed";
      job.error = signal.aborted
        ? "已停止获取，当前二改内容保持不变。"
        : error.message;
    } finally {
      binding?.dispose();
      if (!(await cleanDownload(ownedDownload)))
        job.retainedDownloadDirectory = ownedDownload.directory;
    }
  }
  return {
    sourceForMod,
    check,
    isBusy: active,
    getState: () => ({ job: job ? clone(job) : null }),
    async start(projectId, { authorization = "anonymous" } = {}) {
      if (pending) throw new Error("已有上游获取任务，请等待完成或取消。");
      if (!["anonymous", "account"].includes(authorization))
        throw new Error("下载身份无效。");
      controller = new AbortController();
      job = {
        id: randomUUID(),
        projectId,
        status: "queued",
        progress: null,
        error: null,
        createdAt: new Date().toISOString(),
      };
      pending = run(projectId, authorization, controller.signal).finally(() => {
        pending = null;
      });
      return clone(job);
    },
    cancel() {
      controller?.abort();
      return { job: job ? clone(job) : null };
    },
    async settled() {
      await pending;
      return { job: job ? clone(job) : null };
    },
  };
}

module.exports = { createModProjectUpstream, verifyManagedProjectSource };
