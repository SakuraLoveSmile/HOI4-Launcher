"use strict";

// This process is started only after the user clicks Connect Steam.
// Keep native Steam libraries out of the renderer and the launcher main process.
const { createSteamWorkshopService } = require("./steam-workshop.cjs");
function attachSteamWorker(port, createClient) {
  const service = createSteamWorkshopService({
    createClient,
    onPublishStatus: (job) =>
      port.postMessage({ event: "publish-status", job }),
  });
  let lastState = { connected: false, account: null, items: [] };
  let repairRequest = null;
  const methods = new Set([
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
  port.on("message", async ({ data }) => {
    if (
      !data ||
      !Number.isSafeInteger(data.id) ||
      !methods.has(data.method) ||
      !Array.isArray(data.args)
    )
      return;
    try {
      if (repairRequest !== null) {
        if (data.method === "getState") {
          port.postMessage({
            id: data.id,
            result: { ...lastState, repairing: true },
          });
          return;
        }
        if (data.method !== "getPublishStatus")
          throw new Error("正在补齐模组，请等待当前请求完成。");
      }
      if (
        ["queued", "creating", "uploading"].includes(
          service.getPublishStatus()?.status,
        )
      ) {
        if (data.method === "getState") {
          port.postMessage({
            id: data.id,
            result: {
              ...lastState,
              error: "模组正在上传，订阅状态将在发布完成后刷新。",
            },
          });
          return;
        }
        if (!["getPublishStatus", "startPublish"].includes(data.method))
          throw new Error("正在上传模组，请等待发布完成后再操作。");
      }
      if (data.method === "repairItem") {
        repairRequest = data.id;
        port.postMessage({
          event: "repair-status",
          requestId: data.id,
          active: true,
        });
      }
      const result = await service[data.method](...data.args);
      if (typeof result?.connected === "boolean") lastState = result;
      port.postMessage({ id: data.id, result });
    } catch (error) {
      port.postMessage({
        id: data.id,
        error: error?.message || "Steam 操作失败，请检查客户端连接。",
      });
    } finally {
      if (repairRequest === data.id) {
        repairRequest = null;
        port.postMessage({
          event: "repair-status",
          requestId: data.id,
          active: false,
        });
      }
    }
  });
}
module.exports = { attachSteamWorker };
if (require.main === module)
  attachSteamWorker(process.parentPort, (appId) => {
    const client = require("steamworks.js").init(appId);
    client.workshop.getAllItems =
      require("./steam-workshop-native-query.cjs").createExtendedWorkshopQuery(
        client.workshop.getAllItems,
      );
    return client;
  });
