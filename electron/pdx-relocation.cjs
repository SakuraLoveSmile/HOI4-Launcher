"use strict";

const path = require("node:path");
const { randomUUID } = require("node:crypto");
const {
  diagnostic,
  errorDiagnostic,
  attachDiagnostic,
} = require("./diagnostic-message.cjs");
const clone = (value) => structuredClone(value);
const canonical = (value) => path.resolve(value).toLowerCase();

function createPdxRelocation({
  installer,
  getUserDataPath,
  ready = async () => {},
  isGameRunning = async () => false,
  isOtherBusy = () => false,
}) {
  let occupied = false,
    recovering = false,
    disposed = false,
    forcedRecovery = false;
  let initialization, reading, controller, plan, planUserData;
  let state = {
    storage: null,
    job: null,
    recoveryRequired: false,
    error: null,
    retainedPaths: [],
  };
  const retained = (result) =>
    Array.isArray(result?.retainedPaths)
      ? [
          ...new Set(
            result.retainedPaths.filter(
              (value) =>
                typeof value === "string" &&
                path.isAbsolute(value) &&
                !/[\0-\x1f]/.test(value),
            ),
          ),
        ]
      : [];
  const snapshot = () => clone({ ...state, busy: occupied || recovering });
  const message = (error) =>
    (
      error?.message || "目录状态无法确认，请检查磁盘和模组记录后重试恢复。"
    ).slice(0, 2000);
  const diagnosticFor = (error) =>
    typeof error?.message === "string" && error.message.length > 2000
      ? { kind: "literal", text: message(error) }
      : errorDiagnostic(error);
  function checkOpen() {
    if (disposed) throw new Error("目录迁移服务已关闭。");
  }
  async function guard() {
    checkOpen();
    if (isOtherBusy())
      throw new Error("请先完成其他模组操作，再迁移内容目录。");
    if (await isGameRunning())
      throw new Error("请先退出游戏，再迁移内容目录。");
    if (isOtherBusy()) throw new Error("其他模组操作已开始，请稍后重试。");
    checkOpen();
  }
  function requireIdle() {
    checkOpen();
    if (occupied || recovering)
      throw new Error("正在处理模组目录，请等待完成或取消。");
  }
  function markRecovery(error, force = false) {
    forcedRecovery ||= force;
    state.recoveryRequired = true;
    state.error = message(error);
    state.errorDiagnostic = diagnosticFor(error);
  }
  function initialize() {
    checkOpen();
    if (initialization) return initialization;
    recovering = true;
    initialization = Promise.resolve()
      .then(ready)
      .then((result) => {
        state.retainedPaths = [
          ...new Set([...state.retainedPaths, ...retained(result)]),
        ];
      })
      .catch((error) => {
        markRecovery(error, true);
        throw error;
      })
      .finally(() => {
        recovering = false;
      });
    return initialization;
  }
  async function readStorage() {
    const userDataPath = await getUserDataPath();
    const storage = await installer.getStorageState({ userDataPath });
    if (canonical(await getUserDataPath()) !== canonical(userDataPath))
      throw new Error("游戏用户目录已变化，请重新读取模组目录状态。");
    state.storage = { ...storage, userDataPath };
    state.recoveryRequired =
      forcedRecovery || Boolean(storage.recoveryRequired);
    state.error = state.recoveryRequired
      ? "上次目录操作尚未恢复，请重试恢复后继续。"
      : null;
    state.errorDiagnostic = state.recoveryRequired
      ? diagnostic(state.error)
      : null;
    return state.storage;
  }
  async function discardPlan() {
    const previous = plan;
    plan = null;
    planUserData = null;
    if (previous && installer.cancelRelocationPlan)
      await installer.cancelRelocationPlan(previous.planId);
  }
  async function run(planId, userDataPath, signal) {
    try {
      await guard();
      if (canonical(await getUserDataPath()) !== canonical(userDataPath))
        throw new Error("游戏用户目录已变化，请重新预览迁移。");
      signal.throwIfAborted();
      state.job.status = "moving";
      const result = await installer.relocate({
        planId,
        signal,
        onProgress: (progress) => {
          state.job.progress = clone(progress);
          if (progress.cancellable === false) state.job.status = "committing";
        },
      });
      state.job.status = "succeeded";
      state.job.result = clone(result);
    } catch (error) {
      const cancelled =
        error?.code !== "RECOVERY_REQUIRED" &&
        (error?.name === "AbortError" || error?.code === "CANCELLED");
      state.job.status = cancelled ? "cancelled" : "failed";
      state.job.error = cancelled
        ? "迁移已取消，原有安装保持可用。"
        : message(error);
      state.job.errorDiagnostic = cancelled
        ? diagnostic(state.job.error)
        : diagnosticFor(error);
      state.job.retainedPaths = retained(error);
      if (error?.code === "RECOVERY_REQUIRED") markRecovery(error, true);
    } finally {
      try {
        await readStorage();
      } catch (error) {
        markRecovery(error);
      }
      await discardPlan().catch(() => {});
      controller = null;
      occupied = false;
    }
  }
  return {
    async getState() {
      checkOpen();
      if (occupied || recovering || isOtherBusy()) return snapshot();
      if (!reading) {
        reading = (async () => {
          try {
            await initialize();
            await readStorage();
          } catch (error) {
            markRecovery(error);
          }
        })().finally(() => {
          reading = null;
        });
      }
      await reading;
      return snapshot();
    },
    isBusy: () => occupied || recovering,
    isBlocked: () => occupied || recovering || state.recoveryRequired,
    async assertReady() {
      checkOpen();
      if (occupied || recovering)
        throw new Error("正在处理模组目录，请稍后启动游戏。");
      await initialize();
      if (occupied || recovering)
        throw new Error("正在迁移模组目录，请稍后启动游戏。");
      try {
        await readStorage();
      } catch (error) {
        markRecovery(error);
        throw error;
      }
      checkOpen();
      if (occupied || recovering)
        throw new Error("正在处理模组目录，请稍后启动游戏。");
      if (state.recoveryRequired)
        throw attachDiagnostic(new Error(state.error), state.errorDiagnostic);
    },
    async prepare({ targetParent } = {}) {
      if (
        targetParent !== null &&
        (typeof targetParent !== "string" ||
          !path.isAbsolute(targetParent) ||
          /[\0-\x1f]/.test(targetParent))
      )
        throw new Error("请选择有效的目标目录。");
      requireIdle();
      occupied = true;
      try {
        await initialize();
        await guard();
        await readStorage();
        checkOpen();
        if (state.recoveryRequired)
          throw attachDiagnostic(new Error(state.error), state.errorDiagnostic);
        await discardPlan();
        const userDataPath = await getUserDataPath();
        checkOpen();
        const next = await installer.planRelocation({
          userDataPath,
          targetParent,
        });
        if (
          disposed ||
          canonical(await getUserDataPath()) !== canonical(userDataPath)
        ) {
          await installer.cancelRelocationPlan?.(next.planId);
          checkOpen();
          throw new Error("游戏用户目录已变化，请重新预览迁移。");
        }
        plan = clone(next);
        planUserData = userDataPath;
        return clone(plan);
      } finally {
        occupied = false;
      }
    },
    async commit(planId) {
      requireIdle();
      if (!plan || planId !== plan.planId || typeof planId !== "string")
        throw new Error("迁移预览已失效，请重新选择目录。");
      if (plan.conflicts?.length)
        throw new Error("目标存在冲突，请处理后重新预览。");
      occupied = true;
      try {
        await guard();
        const userDataPath = await getUserDataPath();
        if (canonical(userDataPath) !== canonical(planUserData))
          throw new Error("游戏用户目录已变化，请重新预览迁移。");
        controller = new AbortController();
        state.job = {
          id: randomUUID(),
          status: "queued",
          from: plan.from,
          to: plan.to,
          error: null,
          result: null,
          progress: {
            processedBytes: 0,
            totalBytes: plan.bytes,
            filesDone: 0,
            totalFiles: plan.files,
            cancellable: true,
          },
        };
        const result = clone(state.job);
        void run(planId, userDataPath, controller.signal);
        return result;
      } catch (error) {
        occupied = false;
        controller = null;
        throw error;
      }
    },
    async cancel() {
      checkOpen();
      if (!controller) return state.job ? clone(state.job) : null;
      if (state.job.progress?.cancellable === false)
        throw new Error("正在切换模组注册信息，请等待完成。");
      state.job.status = "cancelling";
      controller.abort();
      return clone(state.job);
    },
    async discard() {
      requireIdle();
      occupied = true;
      try {
        await discardPlan();
        return true;
      } finally {
        occupied = false;
      }
    },
    async recover() {
      requireIdle();
      occupied = true;
      try {
        await guard();
        const recovery = await installer.recover();
        state.retainedPaths = [
          ...new Set([...state.retainedPaths, ...retained(recovery)]),
        ];
        checkOpen();
        initialization = null;
        await initialize();
        forcedRecovery = false;
        await readStorage();
        if (state.recoveryRequired)
          throw attachDiagnostic(new Error(state.error), state.errorDiagnostic);
        return snapshot();
      } catch (error) {
        markRecovery(error, true);
        throw error;
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

module.exports = { createPdxRelocation };
