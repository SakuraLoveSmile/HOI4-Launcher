"use strict";

function createSteamWorkerClient({
  fork,
  scriptPath,
  timeoutMs = 30000,
  onPublishStatus = () => {},
}) {
  let child = null,
    ready = null,
    nextId = 0;
  const pending = new Map();
  const repairs = new Set();
  let publishing = false;
  let lastPublishJob = null;
  let connected = false;
  let submittedMutation = false;
  const mutations = new Set([
    "subscribe",
    "unsubscribe",
    "download",
    "repairItem",
    "startPublish",
  ]);
  const empty = () => ({ connected: false, account: null, items: [] });
  const allowed = new Set([
    "connect",
    "getState",
    "browse",
    "getItem",
    "subscribe",
    "unsubscribe",
    "download",
    "repairItem",
    "validatePublishTarget",
    "startPublish",
    "getPublishStatus",
  ]);
  function failAll(message) {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error(message));
    }
    pending.clear();
  }
  function start() {
    if (child) return ready;
    const instance = fork(scriptPath, [], {
      stdio: "pipe",
      serviceName: "IRONCLAD Steam Workshop",
    });
    child = instance;
    connected = false;
    submittedMutation = false;
    ready = new Promise((resolve, reject) => {
      const abandon = (message) => {
        clearTimeout(startTimer);
        if (child === instance) {
          child = null;
          ready = null;
        }
        reject(new Error(message));
        instance.kill();
      };
      const startTimer = setTimeout(
        () => abandon("启动 Steam 连接服务超时，请重试。"),
        timeoutMs,
      );
      instance.once("spawn", () => {
        clearTimeout(startTimer);
        resolve();
      });
      instance.once("error", () =>
        abandon("无法启动 Steam 连接服务，请检查安装文件。"),
      );
      instance.once("exit", () => {
        clearTimeout(startTimer);
        reject(new Error("Steam 连接服务已退出。"));
      });
    });
    instance.on("message", (message) => {
      if (child !== instance) return;
      if (
        message?.event === "repair-status" &&
        Number.isSafeInteger(message.requestId)
      ) {
        if (message.active === true) repairs.add(message.requestId);
        else if (message.active === false) repairs.delete(message.requestId);
        return;
      }
      if (message?.event === "publish-status" && message.job) {
        lastPublishJob = message.job;
        publishing = ["queued", "creating", "uploading"].includes(
          message.job.status,
        );
        onPublishStatus(message.job);
        return;
      }
      if (message?.result?.connected === true) connected = true;
      // A reply also completes rejected requests that never emitted an active
      // event, and late replies after a timeout still release their reservation.
      if (
        Number.isSafeInteger(message?.id) &&
        (Object.hasOwn(message, "result") || typeof message.error === "string")
      )
        repairs.delete(message.id);
      const request = pending.get(message?.id);
      if (!request) return;
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (typeof message.error === "string")
        request.reject(new Error(message.error.slice(0, 1000)));
      else request.resolve(message.result);
    });
    instance.on("exit", () => {
      if (child === instance) {
        if (publishing && lastPublishJob)
          onPublishStatus({
            ...lastPublishJob,
            status: "interrupted",
            error: "Steam连接进程已退出，发布结果未能确认；请先检查工坊目标。",
          });
        child = null;
        ready = null;
        publishing = false;
        repairs.clear();
        failAll(
          "Steam 连接已断开；若刚提交操作，请重新连接并刷新状态以确认结果。",
        );
      }
    });
    // Native stdout/stderr are deliberately not put in diagnostics: they may contain account data.
    instance.stdout?.resume();
    instance.stderr?.resume();
    return ready;
  }
  async function call(method, ...args) {
    if (!allowed.has(method)) throw new Error("不支持的 Steam 操作。");
    if (!child && method === "getState") return empty();
    if (!child && method !== "connect") throw new Error("请先连接 Steam。");
    await (method === "connect" ? start() : ready);
    const instance = child;
    if (!instance) throw new Error("Steam 连接已断开。");
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("Steam 操作超时，无法确认完成；请刷新状态后再操作。"));
        // Initial connection only reads the account and subscriptions. A native
        // read can hang forever, blocking the worker's serial queue and every
        // later reconnect. Retire that process so the next explicit connection
        // starts cleanly; never do this after a connection or mutation occurred.
        if (
          method === "connect" &&
          child === instance &&
          !connected &&
          !submittedMutation &&
          !publishing
        )
          dispose();
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer, method });
      if (method === "repairItem") repairs.add(id);
      try {
        if (mutations.has(method)) submittedMutation = true;
        instance.postMessage({ id, method, args });
      } catch {
        clearTimeout(timer);
        pending.delete(id);
        repairs.delete(id);
        reject(new Error("无法连接 Steam 服务，请重新连接。"));
      }
    });
  }
  function disconnect() {
    if (publishing) throw new Error("正在上传模组，无法断开 Steam 连接。");
    if (repairs.size)
      throw new Error("Steam 正在处理补齐请求，请等待当前项完成后再断开。");
    if (
      [...pending.values()].some((request) =>
        ["subscribe", "unsubscribe", "download"].includes(request.method),
      )
    )
      throw new Error("Steam 正在处理操作，请稍候再断开。");
    dispose();
    return empty();
  }
  function dispose() {
    const instance = child;
    child = null;
    ready = null;
    connected = false;
    submittedMutation = false;
    repairs.clear();
    failAll("Steam 连接已断开。");
    instance?.kill();
  }
  return { call, disconnect, dispose, isRepairing: () => repairs.size > 0 };
}
module.exports = { createSteamWorkerClient };
