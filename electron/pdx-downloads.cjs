"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { applyPdxPatchArchive } = require("./pdx-patch-archive.cjs");
const { createPdxPatchWorkspace } = require("./pdx-patch-workspace.cjs");
const {
  identity,
  same,
  stagingPath,
  planSnapshot,
  planKey,
  checkedCheckpoint,
  checkpointFile,
  cleanStaging,
} = require("./pdx-download-checkpoint.cjs");
const ACTIVE = new Set([
  "queued",
  "resolving",
  "verifying",
  "downloading",
  "installing",
  "pausing",
  "cancelling",
]);
const PAUSABLE = new Set(["queued", "resolving", "downloading"]);
const FATAL = new Set([
  "INVALID_CHECKPOINT",
  "SOURCE_CHANGED",
  "DESTINATION_CHANGED",
  "HASH_MISMATCH",
  "PLAN_CHANGED",
  "USER_DATA_CHANGED",
  "INSTALLATION_CHANGED",
]);
const clone = (value) => JSON.parse(JSON.stringify(value));
const canonical = (value) => path.resolve(value).toLowerCase();
const errorWith = (code, message) =>
  Object.assign(new Error(message), { code });
const aborted = (error) =>
  error?.name === "AbortError" || error?.code === "CANCELLED";
const id = (value) => {
  if (typeof value !== "string" || !/^[1-9]\d{0,19}$/.test(value))
    throw new Error("Paradox 模组编号无效。");
  return value;
};

function createPdxDownloads({
  storageDirectory,
  content,
  account,
  installer,
  archiveCache,
  getUserDataPath,
  isGameRunning = async () => false,
  assertOperationAllowed = async () => {},
}) {
  const root = path.resolve(storageDirectory),
    journal = path.join(root, "downloads.json");
  let state = {
    version: 2,
    job: null,
    bytesPerSecond: 0,
    staging: null,
    partial: null,
    resumeSource: null,
  };
  let initialization, controller, pauseController, rootIdentity, realRoot;
  let installedCache = [],
    occupied = false,
    disposed = false,
    recovering = false,
    userCancelled = false;
  let persistence = Promise.resolve();

  async function rootGuard() {
    if (
      !same(await fs.lstat(root), rootIdentity) ||
      (await fs.realpath(root)) !== realRoot
    )
      throw new Error("下载记录目录发生变化，请重启后检查。");
  }
  function save() {
    const bytes = JSON.stringify(state, null, 2) + "\n";
    const operation = persistence.then(async () => {
      await rootGuard();
      const temp = path.join(root, `downloads-${randomUUID()}.tmp`);
      const handle = await fs.open(temp, "wx");
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rootGuard();
      await fs.rename(temp, journal);
    });
    persistence = operation.catch(() => {});
    return operation;
  }
  const archiveOf = (staging, partial) =>
    path.join(
      stagingPath(root, staging),
      partial?.transferPlan?.kind === "patch" ? "patch.zip" : "content.zip",
    );
  function retained(staging) {
    const directory = stagingPath(root, staging);
    if (!directory || !state.job) return;
    const paths = new Set(state.job.retainedDownloadDirectories || []);
    if (state.job.retainedDownloadDirectory)
      paths.add(state.job.retainedDownloadDirectory);
    paths.add(directory);
    state.job.retainedDownloadDirectories = [...paths];
    state.job.retainedDownloadDirectory =
      state.job.retainedDownloadDirectories[0];
  }
  async function clean(entry) {
    if (!entry?.staging) return true;
    const removed = await cleanStaging(
      root,
      realRoot,
      entry.staging,
      entry.partial,
      rootGuard,
    );
    if (!removed) retained(entry.staging);
    return removed;
  }
  async function cleanAll() {
    await clean({ staging: state.staging, partial: state.partial });
    await clean(state.resumeSource);
    state.staging = null;
    state.partial = null;
    state.resumeSource = null;
  }
  function hasCheckpoint() {
    return !!(
      state.partial?.checkpoint || state.resumeSource?.partial?.checkpoint
    );
  }
  function pending() {
    return !!(
      state.staging ||
      state.resumeSource ||
      state.job?.status === "paused" ||
      hasCheckpoint()
    );
  }
  function resumable() {
    return !!(
      state.job &&
      !state.job.resumeBlocked &&
      ["paused", "interrupted", "failed"].includes(state.job.status) &&
      state.partial?.userDataPath &&
      (hasCheckpoint() || state.job.status === "paused")
    );
  }
  function snapshot() {
    if (!state.job) return null;
    return {
      ...clone(state.job),
      canPause:
        occupied &&
        !!controller &&
        PAUSABLE.has(state.job.status) &&
        !controller.signal.aborted &&
        !pauseController.signal.aborted,
      canResume: !occupied && !disposed && resumable(),
      canCancel:
        !!(
          occupied &&
          controller &&
          ACTIVE.has(state.job.status) &&
          !userCancelled
        ) ||
        (!occupied && pending()),
    };
  }
  function checkPartial(partial, staging, job) {
    if (
      !partial ||
      typeof partial !== "object" ||
      typeof partial.userDataPath !== "string" ||
      !path.isAbsolute(partial.userDataPath)
    )
      throw new Error("invalid partial");
    const plan = partial.plan ? planSnapshot(partial.plan) : null;
    if (
      plan &&
      (plan.kind !== undefined ||
        plan.modId !== job.modId ||
        plan.revision !== job.revision)
    )
      throw new Error("inconsistent plan");
    const transferPlan = partial.transferPlan
      ? planSnapshot(partial.transferPlan)
      : null;
    const sourcePlan = partial.sourcePlan
      ? planSnapshot(partial.sourcePlan)
      : null;
    if (
      transferPlan &&
      (!plan ||
        transferPlan.kind !== "patch" ||
        ["modId", "revision", "name", "platform", "access"].some(
          (key) => transferPlan[key] !== plan[key],
        ))
    )
      throw new Error("inconsistent transfer");
    if (
      sourcePlan &&
      (!transferPlan ||
        transferPlan.fromRevision === "-1" ||
        sourcePlan.kind !== undefined ||
        sourcePlan.revision !== transferPlan.fromRevision ||
        ["modId", "name", "platform"].some(
          (key) => sourcePlan[key] !== plan[key],
        ))
    )
      throw new Error("inconsistent patch source");
    if (transferPlan && transferPlan.fromRevision !== "-1" && !sourcePlan)
      throw new Error("missing patch source");
    if (partial.checkpoint && (!plan || !staging))
      throw new Error("missing source");
    return {
      plan,
      ...(transferPlan ? { transferPlan } : {}),
      ...(sourcePlan ? { sourcePlan } : {}),
      checkpoint: partial.checkpoint
        ? checkedCheckpoint(
            partial.checkpoint,
            transferPlan || plan,
            archiveOf(staging, { transferPlan }),
          )
        : null,
      userDataPath: path.resolve(partial.userDataPath),
    };
  }
  // A crash during prefix copying can leave a smaller new checkpoint. Keep the
  // larger trusted source. A secondary file from a crash is retained until the
  // user can inspect it; it is never mistaken for the source of a new transfer.
  async function selectSource() {
    if (!state.resumeSource) return;
    const old = state.resumeSource,
      current = { staging: state.staging, partial: state.partial };
    let secondary = old;
    if (
      old.partial?.checkpoint &&
      (!current.partial?.checkpoint ||
        current.partial.checkpoint.receivedBytes <
          old.partial.checkpoint.receivedBytes)
    ) {
      state.staging = old.staging;
      state.partial = old.partial;
      secondary = current;
    }
    // Publish only a complete source selection. The secondary copy may not
    // have a checkpoint yet, so putting it in resumeSource would produce a
    // journal that initialize() cannot read after an intervening crash.
    retained(secondary.staging);
    state.resumeSource = null;
    await save();
  }
  function initialize() {
    if (initialization) return initialization;
    recovering = true;
    initialization = (async () => {
      await fs.mkdir(root, { recursive: true });
      const info = await fs.lstat(root);
      if (info.isSymbolicLink() || !info.isDirectory())
        throw new Error("下载记录目录不是普通文件夹。");
      rootIdentity = identity(info);
      realRoot = await fs.realpath(root);
      let data;
      try {
        data = JSON.parse(await fs.readFile(journal, "utf8"));
        if (
          ![1, 2].includes(data.version) ||
          !Number.isSafeInteger(data.bytesPerSecond) ||
          data.bytesPerSecond < 0 ||
          data.bytesPerSecond > 1024 ** 3 ||
          (data.job !== null &&
            (!data.job ||
              typeof data.job.id !== "string" ||
              typeof data.job.status !== "string"))
        )
          throw new Error("invalid");
        if (data.staging && !stagingPath(root, data.staging))
          throw new Error("invalid staging");
        if (data.version === 2) {
          if (data.partial || data.resumeSource) {
            id(data.job?.modId);
            if (data.job.revision != null) id(data.job.revision);
            if (
              ![undefined, "anonymous", "account"].includes(
                data.job.authorization,
              ) ||
              ![undefined, "download", "repair"].includes(data.job.operation) ||
              (data.job.operation === "repair" &&
                (typeof data.job.installationId !== "string" ||
                  data.job.installationId.length !== 36 ||
                  !/^[a-f0-9-]{36}$/.test(data.job.installationId))) ||
              !data.partial
            )
              throw new Error("invalid job context");
          }
          if (data.partial)
            data.partial = checkPartial(data.partial, data.staging, data.job);
          if (data.resumeSource) {
            if (!stagingPath(root, data.resumeSource.staging))
              throw new Error("invalid source");
            data.resumeSource.partial = checkPartial(
              data.resumeSource.partial,
              data.resumeSource.staging,
              data.job,
            );
            if (
              !data.resumeSource.partial.checkpoint ||
              (data.partial?.plan &&
                planKey(data.partial.plan) !==
                  planKey(data.resumeSource.partial.plan)) ||
              (data.partial?.plan &&
                planKey(data.partial.transferPlan || data.partial.plan) !==
                  planKey(
                    data.resumeSource.partial.transferPlan ||
                      data.resumeSource.partial.plan,
                  ))
            )
              throw new Error("invalid source plan");
          }
        } else {
          data.partial = null;
          data.resumeSource = null;
        }
      } catch (error) {
        if (error.code !== "ENOENT")
          throw new Error(
            "下载记录无法读取，已保留原文件，请检查 downloads.json。",
          );
      }
      if (data) {
        state = { ...data, version: 2 };
        if (state.job && ACTIVE.has(state.job.status)) {
          state.job.status = "interrupted";
          state.job.error = hasCheckpoint()
            ? "上次下载已中断，可手动恢复已保存的进度。"
            : "上次下载未完成，可重新下载；已安装版本会保留。";
        }
        if (["succeeded", "cancelled"].includes(state.job?.status)) {
          await save();
          await cleanAll();
        } else if (!hasCheckpoint() && state.staging) {
          if (
            await cleanStaging(
              root,
              realRoot,
              state.staging,
              state.partial,
              rootGuard,
            )
          )
            state.staging = null;
          else retained(state.staging);
        }
        await save();
      }
      const recovery = await installer.recover();
      installedCache = await installer.list({ includeDamaged: true });
      return recovery;
    })()
      .catch((error) => {
        initialization = null;
        throw error;
      })
      .finally(() => {
        recovering = false;
      });
    return initialization;
  }
  async function runningGuard() {
    await assertOperationAllowed();
    if (await isGameRunning())
      throw new Error("请先退出游戏，再下载或卸载模组。");
    await assertOperationAllowed();
  }
  async function userDataGuard(expected) {
    if (canonical(await getUserDataPath()) !== canonical(expected))
      throw errorWith(
        "USER_DATA_CHANGED",
        "游戏用户目录发生变化，尚未安装；请确认目录并取消当前任务后重新下载。",
      );
  }
  async function checkpointSaved(checkpoint, plan) {
    const archive = archiveOf(state.staging, state.partial);
    let cp, info;
    try {
      cp = checkedCheckpoint(checkpoint, plan, archive);
      info = await checkpointFile(archive, cp);
    } catch {
      throw errorWith(
        "INVALID_CHECKPOINT",
        "下载断点或文件身份无效，片段已保留。",
      );
    }
    const previous = state.partial,
      previousIdentity = state.staging.archiveIdentity;
    state.partial = { ...state.partial, checkpoint: cp };
    state.staging.archiveIdentity =
      info.size === cp.receivedBytes ? identity(info) : null;
    try {
      await save();
    } catch {
      state.partial = previous;
      state.staging.archiveIdentity = previousIdentity;
      throw errorWith(
        "CHECKPOINT_ERROR",
        "无法保存下载断点，已保留上一次可恢复的片段。",
      );
    }
    if (
      state.resumeSource &&
      cp.receivedBytes >= state.resumeSource.partial.checkpoint.receivedBytes
    ) {
      // The transfer closed its verified source before this callback. The new
      // checkpoint is durable before any attempt to remove the old source.
      await clean(state.resumeSource);
      state.resumeSource = null;
      await save();
    }
  }
  async function run(requestSignal, binding, resuming) {
    const signal = binding?.signal || requestSignal,
      pauseSignal = pauseController.signal;
    const check = () => {
      binding?.check();
      signal.throwIfAborted();
    };
    const pauseCheck = () => {
      check();
      if (pauseSignal.aborted) throw errorWith("PAUSED", "下载已暂停。");
    };
    let resolving = false,
      archive,
      sourceLease,
      workspace;
    try {
      const userDataPath = state.partial.userDataPath;
      pauseCheck();
      await userDataGuard(userDataPath);
      pauseCheck();
      const repairing = state.job.operation === "repair";
      if (repairing) {
        state.job.status = "verifying";
        await save();
        check();
        state.job.validation = await installer.verify(state.job.modId, {
          userDataPath,
          installationId: state.job.installationId,
          signal,
          onProgress: (value) => {
            state.job.validation = clone(value);
          },
        });
        check();
        await userDataGuard(userDataPath);
        if (state.job.validation.status === "intact") {
          state.job.status = "succeeded";
          state.job.notice = "安装文件完整，无需修复。";
          return;
        }
      }
      state.job.status = "resolving";
      resolving = true;
      const resolved = await content.resolve({
        modId: state.job.modId,
        ...(repairing ? { repair: true } : {}),
        ...(state.job.revision ? { revision: state.job.revision } : {}),
        ...(binding ? { expectedAccountId: binding.accountId } : {}),
        signal: AbortSignal.any([signal, pauseSignal]),
      });
      resolving = false;
      check();
      let plan;
      try {
        plan = planSnapshot(resolved);
      } catch {
        throw errorWith(
          "PLAN_CHANGED",
          "下载计划无效或发生变化，请取消当前任务后重试。",
        );
      }
      if (
        plan.modId !== state.job.modId ||
        (state.job.revision && plan.revision !== state.job.revision) ||
        (state.partial.plan && planKey(plan) !== planKey(state.partial.plan))
      )
        throw errorWith(
          "PLAN_CHANGED",
          "所选版本的下载计划或摘要发生变化，已保留片段；请取消当前任务后重新下载。",
        );
      if (plan.title) {
        state.job.title = plan.title;
        delete state.job.titleIsFallback;
      }
      state.job.revision = plan.revision;
      state.partial.plan = plan;
      await save();
      pauseCheck();
      installedCache = await installer.list({ includeDamaged: true });
      const current = installedCache.find(
        (item) =>
          item.modId === state.job.modId &&
          item.revision === plan.revision &&
          canonical(item.descriptorPath).startsWith(
            canonical(userDataPath) + path.sep,
          ),
      );
      pauseCheck();
      if (
        repairing &&
        (!current || current.installationId !== state.job.installationId)
      )
        throw errorWith(
          "INSTALLATION_CHANGED",
          "待修复的安装已变化，请重新验证。",
        );
      if (current) {
        if (current.archiveSha256 !== plan.sha256)
          throw errorWith(
            "PLAN_CHANGED",
            "相同版本的归档摘要发生变化，请检查下载来源。",
          );
        if (!repairing && !current.installationDamaged) {
          state.job.status = "succeeded";
          state.job.notice = "当前已是所请求的版本。";
          return;
        }
      }
      resolving = true;
      let transferResolved = resolved,
        transferPlan = plan;
      const pinnedTransfer = state.partial.transferPlan;
      let sourcePlan;
      async function openSource(fromRevision, pinnedSource, previous) {
        const original = await content.resolve({
          modId: plan.modId,
          revision: fromRevision,
          ...(binding ? { expectedAccountId: binding.accountId } : {}),
          signal: AbortSignal.any([signal, pauseSignal]),
        });
        const selected = planSnapshot(original);
        if (
          selected.kind ||
          ["modId", "name", "platform"].some(
            (key) => selected[key] !== plan[key],
          ) ||
          (pinnedSource && planKey(selected) !== planKey(pinnedSource))
        )
          throw errorWith(
            "PLAN_CHANGED",
            "增量来源版本或摘要已变化，请取消后重新下载。",
          );
        if (previous && selected.sha256 !== previous.archiveSha256)
          return false;
        sourcePlan = selected;
        sourceLease = await archiveCache?.open(selected, {
          signal: AbortSignal.any([signal, pauseSignal]),
        });
        return !!sourceLease;
      }
      if (pinnedTransfer) {
        transferResolved = await content.resolvePatch(plan, {
          resolvedPlan: resolved,
          fromRevision: pinnedTransfer.fromRevision,
          signal: AbortSignal.any([signal, pauseSignal]),
        });
        if (
          !transferResolved ||
          planKey(transferResolved) !== planKey(pinnedTransfer)
        )
          throw errorWith(
            "PLAN_CHANGED",
            "补丁下载计划或摘要已变化，已保留片段；请取消后重新下载。",
          );
        let available = true;
        if (pinnedTransfer.fromRevision !== "-1") {
          try {
            available = await openSource(
              pinnedTransfer.fromRevision,
              state.partial.sourcePlan,
            );
          } catch (error) {
            pauseCheck();
            if (!/^CACHE_[A-Z_]+$/.test(error?.code || "")) throw error;
            available = false;
          }
        }
        if (!available)
          throw errorWith(
            "SOURCE_CHANGED",
            "增量来源缓存已不可用，已保留片段；请取消后重新下载完整包。",
          );
      } else if (!hasCheckpoint() && repairing && content.prepareRepair) {
        transferResolved = await content.prepareRepair(plan, {
          resolvedPlan: resolved,
          signal: AbortSignal.any([signal, pauseSignal]),
        });
      } else if (
        !hasCheckpoint() &&
        !repairing &&
        archiveCache &&
        content.getPatchSize
      ) {
        const previous = installedCache.find(
          (item) =>
            item.modId === plan.modId &&
            item.revision !== plan.revision &&
            canonical(item.descriptorPath).startsWith(
              canonical(userDataPath) + path.sep,
            ),
        );
        if (previous) {
          const patchBytes = content.getPatchSize(plan, {
            resolvedPlan: resolved,
            fromRevision: previous.revision,
          });
          if (patchBytes !== null && patchBytes < plan.bytes) {
            let available = false;
            try {
              available = await openSource(previous.revision, null, previous);
            } catch (error) {
              pauseCheck();
              if (
                !/^CACHE_[A-Z_]+$/.test(error?.code || "") &&
                !["NOT_FOUND", "UNAVAILABLE", "ACCESS_DENIED"].includes(
                  error?.code,
                )
              )
                throw error;
            }
            if (available)
              transferResolved = await content.resolvePatch(plan, {
                resolvedPlan: resolved,
                fromRevision: previous.revision,
                signal: AbortSignal.any([signal, pauseSignal]),
              });
          }
        }
      }
      if (!transferResolved)
        throw errorWith("PLAN_CHANGED", "补丁计划已不可用，请重新下载。");
      transferPlan = planSnapshot(transferResolved);
      if (
        ["modId", "revision", "name", "platform", "access"].some(
          (key) => transferPlan[key] !== plan[key],
        )
      )
        throw errorWith("PLAN_CHANGED", "补丁与所选模组版本不符。");
      if (transferPlan.kind === "patch") {
        state.partial.transferPlan = transferPlan;
        if (sourcePlan) state.partial.sourcePlan = sourcePlan;
      } else {
        await sourceLease?.close();
        sourceLease = null;
        delete state.partial.sourcePlan;
      }
      await save();
      pauseCheck();
      resolving = false;
      if (resuming && hasCheckpoint()) {
        await selectSource();
        try {
          await checkpointFile(
            archiveOf(state.staging, state.partial),
            state.partial.checkpoint,
          );
        } catch {
          throw errorWith(
            "SOURCE_CHANGED",
            "下载断点文件或所在目录已被替换，片段已保留，请取消当前任务后重新下载。",
          );
        }
        state.resumeSource = { staging: state.staging, partial: state.partial };
        state.staging = null;
        state.partial = {
          plan,
          checkpoint: null,
          userDataPath,
          ...(transferPlan.kind === "patch"
            ? { transferPlan, ...(sourcePlan ? { sourcePlan } : {}) }
            : {}),
        };
        await save();
      }
      pauseCheck();
      await rootGuard();
      const directory = await fs.mkdtemp(path.join(root, "download-"));
      state.staging = {
        directory: path.basename(directory),
        identity: identity(await fs.lstat(directory)),
        archiveIdentity: null,
      };
      archive = archiveOf(state.staging, state.partial);
      state.job.status = "downloading";
      await save();
      pauseCheck();
      const result = await content.download(transferPlan, {
        resolvedPlan: transferResolved,
        destination: archive,
        signal,
        pauseSignal,
        bytesPerSecond: state.bytesPerSecond,
        ...(state.resumeSource
          ? {
              resume: {
                source: archiveOf(
                  state.resumeSource.staging,
                  state.resumeSource.partial,
                ),
                checkpoint: clone(state.resumeSource.partial.checkpoint),
              },
            }
          : {}),
        onCheckpoint: (cp) => checkpointSaved(cp, transferPlan),
        onProgress: (progress) => {
          if (!signal.aborted) state.job.progress = clone(progress);
        },
      });
      check();
      if (result?.paused) {
        if (!state.partial.checkpoint)
          await checkpointSaved(result.checkpoint, transferPlan);
        state.job.status = "paused";
        return;
      }
      if (!state.partial.checkpoint)
        state.staging.archiveIdentity = identity(await fs.lstat(archive));
      pauseCheck();
      if (transferPlan.kind === "patch") {
        await runningGuard();
        await userDataGuard(userDataPath);
        pauseCheck();
        state.job.status = "installing";
        await save();
        check();
        workspace = await createPdxPatchWorkspace({ directory, signal });
        const patch = await workspace.openPatch(transferPlan);
        const scratch = await workspace.createScratch();
        const target = await workspace.createTarget({
          bytes: plan.bytes,
          sha256: plan.sha256,
        });
        await applyPdxPatchArchive({
          patch: { ...patch, unpackedBytes: transferPlan.unpackedBytes },
          source: sourceLease || undefined,
          scratch,
          target,
          expectedTargetFilename: plan.filename,
          expectedTargetBytes: plan.bytes,
          expectedTargetSha256: plan.sha256,
          signal,
          onProgress: ({ bytesWritten, totalBytes }) => {
            state.job.patchProgress = { bytesWritten, totalBytes };
          },
        });
        await target.finish();
        state.staging.artifacts = (await workspace.proofs()).filter(
          (item) => item.name !== "patch.zip",
        );
        await save();
        await workspace.close();
        workspace = null;
        archive = path.join(directory, "content.zip");
      }
      // Preserve the original signed ZIP for future delta sources. Caching is
      // optional: its budget or storage failure cannot invalidate a verified
      // full download. A user/session cancellation still stops installation.
      if (archiveCache) {
        try {
          await archiveCache.put(plan, {
            sourcePath: archive,
            signal: AbortSignal.any([signal, pauseSignal]),
          });
        } catch (error) {
          pauseCheck();
          if (aborted(error)) throw error;
        }
        pauseCheck();
      }
      await runningGuard();
      await userDataGuard(userDataPath);
      pauseCheck();
      state.job.status = "installing";
      await save();
      check();
      const installed = await installer.install({
        archivePath: archive,
        plan,
        userDataPath,
        signal,
        ...(repairing
          ? { repair: { installationId: state.job.installationId } }
          : {}),
        onProgress: (progress) => {
          state.job.installProgress = clone(progress);
        },
      });
      // The transaction owns the cancellation-versus-commit decision.
      state.job.status = "succeeded";
      state.job.installed = installed;
      if (repairing) {
        state.job.validation = installed.repair.validation;
        state.job.notice = installed.repair.repaired
          ? "已修复固定版本，旧内容已保留。"
          : "安装文件完整，无需修复。";
      } else state.job.notice = "模组已安装，可在模组库中加入预设。";
    } catch (caught) {
      let error = caught;
      if (binding && !requestSignal.aborted) {
        try {
          binding.check();
        } catch (accountError) {
          if (error?.code !== "RECOVERY_REQUIRED") error = accountError;
        }
      }
      const paused =
        !signal.aborted &&
        (error?.code === "PAUSED" ||
          (resolving && pauseSignal.aborted && aborted(error)));
      const interrupted =
        disposed && !userCancelled && error?.code !== "RECOVERY_REQUIRED";
      const cancelled =
        !interrupted && error?.code !== "RECOVERY_REQUIRED" && aborted(error);
      state.job.status = paused
        ? "paused"
        : interrupted
          ? "interrupted"
          : cancelled
            ? "cancelled"
            : "failed";
      state.job.errorCode = paused
        ? null
        : /^[A-Z_]{1,40}$/.test(error?.code || "")
          ? error.code
          : null;
      state.job.error = paused
        ? null
        : interrupted
          ? "下载已中断，可手动恢复已保存的进度。"
          : cancelled
            ? "已取消下载，原有安装保持不变。"
            : (error?.message || "下载未完成，请重试。").slice(0, 1000);
      if (FATAL.has(error?.code)) state.job.resumeBlocked = true;
    } finally {
      await workspace?.close().catch(() => {});
      await sourceLease?.close().catch(() => {});
      binding?.dispose();
      try {
        if (["succeeded", "cancelled"].includes(state.job.status)) {
          await save();
          await cleanAll();
        } else if (hasCheckpoint()) {
          if (state.job.resumeBlocked) {
            retained(state.staging);
            retained(state.resumeSource?.staging);
          } else await selectSource();
        } else {
          if (await clean({ staging: state.staging, partial: state.partial }))
            state.staging = null;
          if (state.job.status !== "paused") state.partial = null;
        }
        await save();
      } catch {
        state.job.error =
          "操作结果无法保存到下载记录，片段已保留；请刷新模组库确认安装情况。";
        retained(state.staging);
        retained(state.resumeSource?.staging);
      }
      try {
        installedCache = await installer.list({ includeDamaged: true });
      } catch {
        /* Retain last successful list. */
      }
      controller = null;
      pauseController = null;
      occupied = false;
    }
  }
  async function begin(input, resuming, expectedUserDataPath) {
    if (disposed) throw new Error("下载服务已关闭。");
    if (occupied) throw new Error("已有下载或安装任务，请等待完成或取消。");
    occupied = true;
    let binding,
      prepared = false;
    try {
      await initialize();
      if (resuming ? !resumable() : pending())
        throw new Error(
          resuming
            ? "当前任务没有可恢复的断点，请检查错误并取消后重试。"
            : "已有暂停任务或下载片段，请先恢复或取消当前任务。",
        );
      await runningGuard();
      if (disposed) throw new Error("下载服务已关闭。");
      const userDataPath = path.resolve(await getUserDataPath());
      if (
        expectedUserDataPath &&
        canonical(userDataPath) !== canonical(expectedUserDataPath)
      )
        throw new Error("版本实例已变化，请刷新模组列表。");
      if (!resuming && input.operation === "repair") {
        installedCache = await installer.list({ includeDamaged: true });
        const current = installedCache.find(
          (item) =>
            item.modId === input.modId &&
            canonical(item.descriptorPath).startsWith(
              canonical(userDataPath) + path.sep,
            ),
        );
        if (!current?.installationId || typeof installer.verify !== "function")
          throw new Error("未找到当前游戏目录中可验证的受管安装。");
        input = {
          ...input,
          revision: current.revision,
          installationId: current.installationId,
        };
      }
      if (
        resuming &&
        canonical(userDataPath) !== canonical(state.partial.userDataPath)
      ) {
        // A different selected instance is temporary. Preserve the checkpoint
        // so the player can switch back and resume the original download.
        throw errorWith(
          "USER_DATA_CHANGED",
          "请切回此下载所属的版本实例，再继续下载。",
        );
      }
      controller = new AbortController();
      pauseController = new AbortController();
      userCancelled = false;
      const authorization = resuming
        ? state.job.authorization || "anonymous"
        : input.authorization;
      if (authorization === "account") {
        if (!account?.bindSession)
          throw new Error(
            "当前环境不支持账号下载，请使用桌面版并登录 Paradox 账号。",
          );
        binding = await account.bindSession({ signal: controller.signal });
        binding.check();
      }
      controller.signal.throwIfAborted();
      if (!resuming) {
        const kept =
          state.job?.retainedDownloadDirectories ||
          (state.job?.retainedDownloadDirectory
            ? [state.job.retainedDownloadDirectory]
            : []);
        state.job = {
          id: randomUUID(),
          modId: input.modId,
          revision: input.revision,
          authorization,
          ...(input.operation === "repair"
            ? { operation: "repair", installationId: input.installationId }
            : {}),
          title: `Paradox 模组 ${input.modId}`,
          titleIsFallback: true,
          status: "queued",
          progress: null,
          error: null,
          createdAt: new Date().toISOString(),
          ...(kept.length
            ? {
                retainedDownloadDirectories: kept,
                retainedDownloadDirectory: kept[0],
              }
            : {}),
        };
        state.partial = { plan: null, checkpoint: null, userDataPath };
      } else {
        state.job.status = "queued";
        state.job.error = null;
        state.job.errorCode = null;
        delete state.job.installProgress;
      }
      prepared = true;
      await save();
      const result = snapshot();
      void run(controller.signal, binding, resuming);
      return result;
    } catch (error) {
      binding?.dispose();
      if (prepared) {
        state.job.status = "failed";
        state.job.error = "无法保存下载记录，未开始下载。";
      }
      controller = null;
      pauseController = null;
      occupied = false;
      throw error;
    }
  }
  return {
    async getState() {
      await initialize();
      if (!occupied)
        installedCache = await installer.list({ includeDamaged: true });
      return {
        job: snapshot(),
        installations: clone(installedCache),
        bytesPerSecond: state.bytesPerSecond,
      };
    },
    isBusy: () => occupied || recovering,
    ready: initialize,
    async start(input, expectedUserDataPath) {
      if (
        !input ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        Object.keys(input).some(
          (key) => !["modId", "revision", "authorization"].includes(key),
        )
      )
        throw new Error("下载参数无效。");
      const modId = id(input.modId),
        revision = input.revision == null ? null : id(input.revision),
        authorization = input.authorization ?? "anonymous";
      if (!["anonymous", "account"].includes(authorization))
        throw new Error("请选择公开下载或当前账号下载。");
      return begin(
        { modId, revision, authorization },
        false,
        expectedUserDataPath,
      );
    },
    async repair(input) {
      if (
        !input ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        Object.keys(input).some(
          (key) => !["modId", "authorization"].includes(key),
        )
      )
        throw new Error("修复参数无效。");
      const modId = id(input.modId),
        authorization = input.authorization ?? "anonymous";
      if (!["anonymous", "account"].includes(authorization))
        throw new Error("请选择公开下载或当前账号下载。");
      return begin({ modId, authorization, operation: "repair" }, false);
    },
    async pause() {
      await initialize();
      if (!snapshot()?.canPause)
        throw new Error("当前阶段无法暂停；安装期间请等待完成或取消。");
      state.job.status = "pausing";
      pauseController.abort();
      return snapshot();
    },
    async resume(...args) {
      if (args.length) throw new Error("恢复任务不接受外部路径或参数。");
      return begin(null, true);
    },
    async cancel() {
      await initialize();
      if (controller && occupied) {
        userCancelled = true;
        if (state.job && ACTIVE.has(state.job.status))
          state.job.status = "cancelling";
        controller.abort();
        return snapshot();
      }
      if (occupied || !pending()) return snapshot();
      occupied = true;
      try {
        state.job.status = "cancelled";
        state.job.error = "已取消下载，原有安装保持不变。";
        await save();
        await cleanAll();
        await save();
        return snapshot();
      } finally {
        occupied = false;
      }
    },
    async setLimit(value) {
      if (!Number.isSafeInteger(value) || value < 0 || value > 1024 ** 3)
        throw new Error("下载限速须为 0 至 1 GiB/s 的整数；0 表示不限速。");
      if (occupied) throw new Error("请在当前下载结束后修改限速。");
      occupied = true;
      let previous;
      try {
        await initialize();
        previous = state.bytesPerSecond;
        state.bytesPerSecond = value;
        await save();
        return value;
      } catch {
        if (previous !== undefined) state.bytesPerSecond = previous;
        throw new Error("无法保存下载限速设置。");
      } finally {
        occupied = false;
      }
    },
    async uninstall(modId, expectedUserDataPath) {
      id(modId);
      if (occupied) throw new Error("请先等待当前下载或安装结束。");
      occupied = true;
      try {
        await initialize();
        await runningGuard();
        const userDataPath = await getUserDataPath();
        if (
          expectedUserDataPath &&
          canonical(userDataPath) !== canonical(expectedUserDataPath)
        )
          throw new Error("版本实例已变化，请刷新模组列表。");
        return await installer.uninstall(modId, {
          userDataPath,
        });
      } finally {
        occupied = false;
      }
    },
    dispose() {
      disposed = true;
      controller?.abort();
    },
  };
}
module.exports = { createPdxDownloads };
