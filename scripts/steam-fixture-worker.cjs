"use strict";
const { attachSteamWorker } = require("../electron/steam-worker.cjs");
attachSteamWorker(process.parentPort, (appId) => {
  if (appId !== 394360) throw new Error("Wrong fixture game");
  return {
    utils: { getAppId: () => 394360 },
    localplayer: {
      getSteamId: () => ({ steamId64: 76561198000000000n }),
      getName: () => "Isolated fixture",
    },
    workshop: {
      getSubscribedItems: () => [],
      getItems: async () => ({ items: [] }),
      getItem: async () => null,
      getAllItems: async () => ({ items: [], totalResults: 0 }),
      state: () => 0,
      downloadInfo: () => null,
      subscribe: async () => {
        throw new Error("No fixture mutations");
      },
      unsubscribe: async () => {
        throw new Error("No fixture mutations");
      },
      download: () => false,
      createItem: async () => ({
        itemId: 900001n,
        needsToAcceptAgreement: false,
      }),
      updateItemWithCallback: (
        id,
        details,
        appId,
        success,
        error,
        progress,
      ) => {
        if (id !== 900001n || appId !== 394360)
          return error(new Error("Invalid fixture target"));
        progress({ status: 3, progress: 10n, total: 20n });
        setTimeout(
          () => success({ itemId: id, needsToAcceptAgreement: false }),
          30,
        );
      },
    },
  };
});
