"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createSteamWorkshopService,
} = require("../electron/steam-workshop.cjs");

const nativeItem = (id = 123n, patch = {}) => ({
  publishedFileId: id,
  consumerAppId: 394360,
  title: "A mod",
  description: "A campaign",
  banned: false,
  owner: { steamId64: 76561198000000000n },
  ...patch,
});

test("localized titles request only Simplified Chinese through the verified uncached SDK query", async () => {
  const f = fixture();
  await f.service.connect();
  let received;
  f.client.workshop.getItem = async (id, options) => {
    received = { id, options };
    return nativeItem(id, { title: "作者已有中文标题" });
  };
  assert.equal(
    (await f.service.getItem("123", { language: "schinese" })).name,
    "作者已有中文标题",
  );
  assert.deepEqual(received, {
    id: 123n,
    options: { cachedResponseMaxAge: 0, language: "schinese" },
  });
  for (const options of [
    { language: "english" },
    { language: "schinese", endpoint: "external" },
    null,
  ])
    await assert.rejects(f.service.getItem("123", options), /语言请求无效/);
  f.client.workshop.getItem = async () =>
    nativeItem(123n, { consumerAppId: 999 });
  await assert.rejects(
    f.service.getItem("123", { language: "schinese" }),
    /属于 HOI4/,
  );
});

function fixture(options = {}) {
  const calls = [];
  let subscribed = [123n];
  const items = new Map([
    ["123", nativeItem()],
    ["456", nativeItem(456n)],
  ]);
  const flags = new Map([
    ["123", 1 | 4 | 8 | 16 | 32],
    ["456", 0],
  ]);
  const client = {
    localplayer: {
      getSteamId: () => ({ steamId64: 76561198000000000n }),
      getName: () => "Test player",
    },
    utils: { getAppId: () => 394360 },
    workshop: {
      getSubscribedItems: () => [...subscribed],
      getItems: async (ids) => ({
        items: ids.map((id) => items.get(String(id))),
      }),
      getItem: async (id) => {
        calls.push(["getItem", id]);
        return items.get(String(id));
      },
      getAllItems: async (...args) => {
        calls.push(["getAllItems", ...args]);
        return { items: [...items.values()], totalResults: 51 };
      },
      state: (id) => flags.get(String(id)) || 0,
      downloadInfo: () => ({ current: 1024n, total: 2048n }),
      installInfo: (id) => {
        calls.push(["installInfo", id]);
        return {
          folder: `C:\\Steam\\steamapps\\workshop\\content\\394360\\${id}`,
          timestamp: 1700000000,
          sizeOnDisk: 2048n,
        };
      },
      subscribe: async (id) => {
        calls.push(["subscribe", id]);
        subscribed.push(id);
        flags.set(String(id), 1);
      },
      unsubscribe: async (id) => {
        calls.push(["unsubscribe", id]);
        subscribed = subscribed.filter((item) => item !== id);
        flags.set(String(id), 0);
      },
      download: (id, priority) => {
        calls.push(["download", id, priority]);
        flags.set(String(id), (flags.get(String(id)) || 0) | 16);
        return true;
      },
      createItem: async (appId) => {
        calls.push(["createItem", appId]);
        items.set("777", nativeItem(777n));
        return { itemId: 777n, needsToAcceptAgreement: false };
      },
      updateItemWithCallback: (
        id,
        details,
        appId,
        success,
        _error,
        progress,
        interval,
      ) => {
        calls.push(["update", id, details, appId, interval]);
        queueMicrotask(() => {
          progress({ status: 3, progress: 512n, total: 1024n });
          success({ itemId: id, needsToAcceptAgreement: false });
        });
      },
      ...options.workshop,
    },
  };
  const service = createSteamWorkshopService({
    createClient: async (appId) => {
      calls.push(["connect", appId]);
      return client;
    },
    ...(options.onPublishStatus
      ? { onPublishStatus: options.onPublishStatus }
      : {}),
  });
  return { service, client, calls, items, flags };
}

test("requiring and reading an offline service never initializes Steam", async () => {
  let count = 0;
  const service = createSteamWorkshopService({
    createClient: () => {
      count++;
      throw new Error("do not initialize");
    },
  });
  assert.deepEqual(await service.getState(), {
    connected: false,
    account: null,
    items: [],
  });
  await assert.rejects(service.browse(), /先连接/);
  await assert.rejects(service.subscribe("123"), /先连接/);
  await assert.rejects(service.unsubscribe("123"), /先连接/);
  await assert.rejects(service.download("123"), /先连接/);
  assert.equal(count, 0);
});

test("project source detail is fresh, read-only, actor-bound and sanitizes native failures", async () => {
  const f = fixture();
  await f.service.connect();
  f.calls.length = 0;
  const result = await f.service.getItem("123");
  assert.equal(result.id, "123");
  assert.equal(result.account.steamId, "76561198000000000");
  assert.equal(result.downloading, true);
  assert.deepEqual(result.installation, {
    folder: "C:\\Steam\\steamapps\\workshop\\content\\394360\\123",
    timestamp: 1700000000,
  });
  assert.deepEqual(f.calls, [
    ["getItem", 123n],
    ["installInfo", 123n],
  ]);
  f.client.workshop.getItem = async () => {
    throw new Error("sensitive-native-token");
  };
  await assert.rejects(
    f.service.getItem("123"),
    (error) => !error.message.includes("sensitive-native-token"),
  );
  f.client.workshop.getItem = async () => {
    f.client.localplayer.getSteamId = () => ({ steamId64: 76561198000000001n });
    return nativeItem();
  };
  await assert.rejects(f.service.getItem("123"), /账号/);
});

test("project source installation comes from the native SDK and invalid installation details are omitted", async () => {
  const f = fixture();
  await f.service.connect();
  for (const installation of [
    null,
    { folder: "invalid\0path", timestamp: 1 },
    { folder: "C:\\Steam\\content", timestamp: -1 },
    { folder: "C:\\Steam\\content", timestamp: NaN },
  ]) {
    f.client.workshop.installInfo = () => installation;
    assert.equal((await f.service.getItem("123")).installation, null);
  }
  delete f.client.workshop.installInfo;
  assert.equal((await f.service.getItem("123")).installation, null);
  f.client.workshop.installInfo = () => {
    throw new Error("private-installation-token");
  };
  await assert.rejects(
    f.service.getItem("123"),
    (error) => !error.message.includes("private-installation-token"),
  );
});

const tick = () => new Promise((resolve) => setImmediate(resolve));
const publishInput = (patch = {}) => ({
  id: "job-1",
  existingItemId: null,
  contentPath: "C:\\launcher\\snapshot\\content",
  previewPath: "C:\\launcher\\snapshot\\preview.png",
  title: "My mod",
  description: "My reviewed description\nSecond line",
  tags: ["Alternative History", "Gameplay"],
  visibility: 2,
  changeNote: "First upload",
  ...patch,
});

test("publish status and attempted offline publishing do not initialize Steam", async () => {
  let calls = 0;
  const service = createSteamWorkshopService({
    createClient: () => {
      calls++;
      throw new Error("not allowed");
    },
  });
  assert.equal(service.getPublishStatus(), null);
  assert.throws(() => service.startPublish(publishInput()), /先连接/);
  await assert.rejects(service.validatePublishTarget("123"), /先连接/);
  assert.equal(calls, 0);
});

test("publish target validation requires HOI4, a valid author and the current owner", async () => {
  const f = fixture();
  await f.service.connect();
  assert.deepEqual(await f.service.validatePublishTarget("123"), {
    id: "123",
    name: "A mod",
    owned: true,
  });
  for (const patch of [
    { consumerAppId: 480 },
    { banned: true },
    { banned: undefined },
    { owner: null },
    { owner: { steamId64: 76561198000000001n } },
    { publishedFileId: 456n },
  ]) {
    f.items.set("123", nativeItem(123n, patch));
    await assert.rejects(f.service.validatePublishTarget("123"));
  }
  assert.ok(!f.calls.some(([name]) => ["createItem", "update"].includes(name)));
  f.client.workshop.getItem = async () => {
    throw new Error("private/path token");
  };
  await assert.rejects(
    f.service.validatePublishTarget("123"),
    (error) => !/private|token/.test(error.message),
  );
});

test("target validation rejects an account change while metadata is being fetched", async () => {
  const f = fixture();
  await f.service.connect();
  f.client.workshop.getItem = async () => {
    f.client.localplayer.getSteamId = () => ({ steamId64: 76561198000000001n });
    return nativeItem();
  };
  await assert.rejects(f.service.validatePublishTarget("123"), /账号已改变/);
});

test("startPublish returns queued immediately and status remains readable through creation and upload", async () => {
  const events = [];
  const f = fixture({ onPublishStatus: (job) => events.push(job) });
  await f.service.connect();
  let created, callbacks;
  f.client.workshop.createItem = (appId) => {
    f.calls.push(["createItem", appId]);
    return new Promise((resolve) => {
      created = resolve;
    });
  };
  f.client.workshop.updateItemWithCallback = (...args) => {
    callbacks = args;
    f.calls.push(["update", ...args.slice(0, 3)]);
  };
  const started = f.service.startPublish(publishInput());
  assert.deepEqual(started, {
    id: "job-1",
    status: "queued",
    itemId: null,
    progress: null,
    needsAgreement: false,
    error: null,
  });
  assert.equal(
    f.calls.some(([name]) => name === "createItem"),
    false,
  );
  await tick();
  assert.equal(f.service.getPublishStatus().status, "creating");
  created({ itemId: 777n, needsToAcceptAgreement: false });
  await tick();
  assert.equal(f.service.getPublishStatus().status, "uploading");
  assert.equal(f.service.getPublishStatus().itemId, "777");
  assert.deepEqual(
    f.calls.find(([name]) => name === "createItem"),
    ["createItem", 394360],
  );
  assert.deepEqual(callbacks.slice(0, 3), [
    777n,
    {
      contentPath: "C:\\launcher\\snapshot\\content",
      previewPath: "C:\\launcher\\snapshot\\preview.png",
      title: "My mod",
      description: "My reviewed description\nSecond line",
      tags: ["Alternative History", "Gameplay"],
      visibility: 2,
      changeNote: "First upload",
    },
    394360,
  ]);
  assert.equal(callbacks[6], 500);
  callbacks[5]({ status: 3, progress: 100n, total: 500n });
  assert.deepEqual(f.service.getPublishStatus().progress, {
    stage: 3,
    processedBytes: 100,
    totalBytes: 500,
  });
  callbacks[3]({ itemId: 777n, needsToAcceptAgreement: false });
  await tick();
  assert.equal(f.service.getPublishStatus().status, "succeeded");
  assert.ok(
    events.some((job) => job.itemId === "777" && job.status === "creating"),
  );
  assert.deepEqual(
    events.map((job) => job.status),
    ["queued", "creating", "creating", "uploading", "uploading", "succeeded"],
  );
  assert.ok(events.every((job) => !JSON.stringify(job).includes("snapshot")));
});

test("updates recheck ownership after prior confirmation and never create a second item", async () => {
  const f = fixture();
  await f.service.connect();
  await f.service.validatePublishTarget("123");
  f.items.set(
    "123",
    nativeItem(123n, { owner: { steamId64: 76561198000000001n } }),
  );
  f.service.startPublish(publishInput({ existingItemId: "123" }));
  await tick();
  assert.equal(f.service.getPublishStatus().status, "failed");
  assert.equal(f.service.getPublishStatus().itemId, "123");
  assert.match(f.service.getPublishStatus().error, /不属于/);
  assert.equal(f.calls.filter(([name]) => name === "getItem").length, 2);
  assert.ok(!f.calls.some(([name]) => ["createItem", "update"].includes(name)));
});

test("new item agreement pauses before content upload and resumes the same item under a new job ID", async () => {
  const f = fixture();
  await f.service.connect();
  f.client.workshop.createItem = async (appId) => {
    f.calls.push(["createItem", appId]);
    f.items.set("777", nativeItem(777n));
    return { itemId: 777n, needsToAcceptAgreement: true };
  };
  f.service.startPublish(publishInput());
  await tick();
  assert.deepEqual(f.service.getPublishStatus(), {
    id: "job-1",
    status: "agreement-required",
    itemId: "777",
    progress: null,
    needsAgreement: true,
    error: null,
  });
  assert.equal(
    f.calls.some(([name]) => name === "update"),
    false,
  );
  assert.throws(
    () => f.service.startPublish(publishInput({ existingItemId: "777" })),
    /已经提交/,
  );
  f.service.startPublish(publishInput({ id: "job-2", existingItemId: "777" }));
  await tick();
  assert.equal(f.service.getPublishStatus().status, "succeeded");
  assert.equal(f.service.getPublishStatus().itemId, "777");
  assert.equal(f.calls.filter(([name]) => name === "createItem").length, 1);
  assert.ok(f.calls.some(([name, id]) => name === "getItem" && id === 777n));
});

test("successful update can still require the Steam Workshop agreement", async () => {
  const f = fixture();
  await f.service.connect();
  f.client.workshop.updateItemWithCallback = (id, _details, _appId, success) =>
    success({ itemId: id, needsToAcceptAgreement: true });
  f.service.startPublish(publishInput({ existingItemId: "123" }));
  await tick();
  assert.equal(f.service.getPublishStatus().status, "agreement-required");
  assert.equal(f.service.getPublishStatus().needsAgreement, true);
  assert.equal(f.service.getPublishStatus().itemId, "123");
});

test("upload failure retains the new item ID and retry updates it without creating another item", async () => {
  const f = fixture();
  await f.service.connect();
  const update = f.client.workshop.updateItemWithCallback;
  f.client.workshop.updateItemWithCallback = (
    _id,
    _details,
    _appId,
    _success,
    failure,
  ) => failure(new Error("private token C:/secret"));
  f.service.startPublish(publishInput());
  await tick();
  const failed = f.service.getPublishStatus();
  assert.equal(failed.status, "failed");
  assert.equal(failed.itemId, "777");
  assert.doesNotMatch(failed.error, /private|token|secret/);
  f.client.workshop.updateItemWithCallback = update;
  f.service.startPublish(
    publishInput({ id: "job-2", existingItemId: failed.itemId }),
  );
  await tick();
  assert.equal(f.service.getPublishStatus().status, "succeeded");
  assert.equal(f.calls.filter(([name]) => name === "createItem").length, 1);
  assert.throws(() => f.service.startPublish(publishInput()), /已经提交/);
});

test("only one publish may be active and completed job IDs cannot be replayed", async () => {
  const f = fixture();
  await f.service.connect();
  let finish;
  f.client.workshop.updateItemWithCallback = (
    id,
    _details,
    _appId,
    success,
  ) => {
    finish = () => success({ itemId: id, needsToAcceptAgreement: false });
  };
  f.service.startPublish(publishInput());
  assert.throws(() => f.service.startPublish(publishInput()), /已经提交/);
  assert.throws(
    () => f.service.startPublish(publishInput({ id: "job-2" })),
    /进行中/,
  );
  await tick();
  assert.throws(
    () => f.service.startPublish(publishInput({ id: "job-2" })),
    /进行中/,
  );
  finish();
  await tick();
  assert.throws(() => f.service.startPublish(publishInput()), /已经提交/);
});

test("publishing and existing mutations share the queue while publish status stays synchronous", async () => {
  const f = fixture();
  await f.service.connect();
  const subscribe = f.client.workshop.subscribe;
  let releaseSubscribe, finishUpload;
  f.client.workshop.subscribe = async (id) => {
    await new Promise((resolve) => {
      releaseSubscribe = resolve;
    });
    await subscribe(id);
  };
  const preceding = f.service.subscribe("456");
  await tick();
  f.client.workshop.updateItemWithCallback = (
    id,
    _details,
    _appId,
    success,
  ) => {
    finishUpload = () => success({ itemId: id, needsToAcceptAgreement: false });
  };
  f.service.startPublish(publishInput());
  assert.equal(f.service.getPublishStatus().status, "queued");
  await tick();
  assert.equal(
    f.calls.some(([name]) => name === "createItem"),
    false,
  );
  releaseSubscribe();
  await preceding;
  await tick();
  assert.equal(f.service.getPublishStatus().status, "uploading");
  const following = f.service.unsubscribe("456");
  await tick();
  assert.equal(
    f.calls.some(([name]) => name === "unsubscribe"),
    false,
  );
  assert.equal(f.service.getPublishStatus().status, "uploading");
  finishUpload();
  await following;
  assert.equal(
    f.calls.some(([name]) => name === "unsubscribe"),
    true,
  );
});

test("publish request limits reject before consuming a job ID or calling native writes", async () => {
  const f = fixture();
  await f.service.connect();
  for (const patch of [
    { id: "" },
    { id: "x".repeat(129) },
    { existingItemId: undefined },
    { existingItemId: "0" },
    { title: " " },
    { title: "中".repeat(43) },
    { title: "a\nb" },
    { description: "中".repeat(2667) },
    { description: "a\0b" },
    { changeNote: "x".repeat(8001) },
    { tags: Array(101).fill("tag") },
    { tags: [""] },
    { tags: ["a", " a "] },
    { tags: ["中".repeat(86)] },
    { tags: ["a\nb"] },
    { visibility: -1 },
    { visibility: 4 },
    { visibility: "2" },
    { contentPath: "relative" },
    { contentPath: "C:\\a\\..\\secret" },
    { contentPath: "C:\\a:secret" },
    { contentPath: "\\\\host\\share" },
    { previewPath: "C:\\a\0b" },
    { token: "never sent" },
  ])
    assert.throws(() => f.service.startPublish(publishInput(patch)));
  assert.equal(
    f.calls.some(([name]) => ["createItem", "update"].includes(name)),
    false,
  );
  assert.equal(f.service.getPublishStatus(), null);
  assert.equal(
    f.service.startPublish(publishInput({ previewPath: undefined })).status,
    "queued",
  );
  await tick();
  assert.equal(f.service.getPublishStatus().status, "succeeded");
});

test("malformed create receipts retain any valid created ID and cannot upload", async () => {
  for (const result of [
    null,
    { itemId: 0n, needsToAcceptAgreement: false },
    { itemId: 777n, needsToAcceptAgreement: "no" },
  ]) {
    const f = fixture();
    await f.service.connect();
    f.client.workshop.createItem = async () => result;
    f.service.startPublish(publishInput());
    await tick();
    assert.equal(f.service.getPublishStatus().status, "failed");
    assert.equal(
      f.service.getPublishStatus().itemId,
      result?.itemId === 777n ? "777" : null,
    );
    assert.equal(
      f.calls.some(([name]) => name === "update"),
      false,
    );
  }
});

test("native create errors and synchronous upload exceptions are sanitized", async () => {
  for (const action of ["createItem", "updateItemWithCallback"]) {
    const f = fixture();
    await f.service.connect();
    f.client.workshop[action] = () => {
      throw new Error("native secret C:/private");
    };
    f.service.startPublish(publishInput());
    await tick();
    assert.equal(f.service.getPublishStatus().status, "failed");
    assert.doesNotMatch(
      f.service.getPublishStatus().error,
      /native|secret|private/,
    );
    assert.equal(
      f.service.getPublishStatus().itemId,
      action === "createItem" ? null : "777",
    );
  }
});

test("mismatched update receipts preserve the intended ID and do not report success", async () => {
  const f = fixture();
  await f.service.connect();
  f.client.workshop.updateItemWithCallback = (_id, _details, _appId, success) =>
    success({ itemId: 999n, needsToAcceptAgreement: false });
  f.service.startPublish(publishInput());
  await tick();
  assert.equal(f.service.getPublishStatus().status, "failed");
  assert.equal(f.service.getPublishStatus().itemId, "777");
  assert.match(f.service.getPublishStatus().error, /回执无效/);
});

test("progress handles bigint overflow and ignores late or duplicate callbacks", async () => {
  const f = fixture();
  await f.service.connect();
  let callbacks;
  f.client.workshop.updateItemWithCallback = (...args) => {
    callbacks = args;
  };
  f.service.startPublish(publishInput());
  await tick();
  for (const info of [
    { status: 3, progress: 2n ** 60n, total: 2n ** 61n },
    { status: 4, progress: -1n, total: 4n },
    { status: 5, progress: 10n, total: 5n },
  ]) {
    callbacks[5](info);
    assert.deepEqual(f.service.getPublishStatus().progress, {
      stage: info.status,
      processedBytes: null,
      totalBytes: null,
    });
  }
  callbacks[5]({ status: 100, progress: 1n, total: 2n });
  assert.equal(f.service.getPublishStatus().progress.stage, 5);
  callbacks[3]({ itemId: 777n, needsToAcceptAgreement: false });
  await tick();
  const completed = f.service.getPublishStatus();
  callbacks[4](new Error("late failure"));
  callbacks[5]({ status: 2, progress: 1n, total: 2n });
  callbacks[3]({ itemId: 999n, needsToAcceptAgreement: true });
  assert.deepEqual(f.service.getPublishStatus(), completed);
  completed.status = "tampered";
  completed.progress.stage = 99;
  assert.equal(f.service.getPublishStatus().status, "succeeded");
  assert.equal(f.service.getPublishStatus().progress.stage, 5);
});

test("observer copies cannot modify the job and observer failures cannot cancel publishing", async () => {
  let events = 0;
  const f = fixture({
    onPublishStatus: (job) => {
      events++;
      job.status = "tampered";
      job.itemId = "999";
      if (events % 2) throw new Error("observer failed");
      return Promise.reject(new Error("async observer failed"));
    },
  });
  await f.service.connect();
  f.service.startPublish(publishInput());
  await tick();
  assert.equal(f.service.getPublishStatus().status, "succeeded");
  assert.equal(f.service.getPublishStatus().itemId, "777");
  assert.ok(events >= 5);
});

test("a queued publish cannot proceed after the Steam account changes", async () => {
  const f = fixture();
  await f.service.connect();
  f.service.startPublish(publishInput());
  f.client.localplayer.getSteamId = () => ({ steamId64: 76561198000000001n });
  await tick();
  assert.equal(f.service.getPublishStatus().status, "failed");
  assert.match(f.service.getPublishStatus().error, /账号已改变/);
  assert.ok(!f.calls.some(([name]) => ["createItem", "update"].includes(name)));
});

test("a changed account after creation retains the ID without uploading content", async () => {
  const f = fixture();
  await f.service.connect();
  f.client.workshop.createItem = async () => {
    f.client.localplayer.getSteamId = () => ({ steamId64: 76561198000000001n });
    return { itemId: 777n, needsToAcceptAgreement: false };
  };
  f.service.startPublish(publishInput());
  await tick();
  assert.equal(f.service.getPublishStatus().status, "failed");
  assert.equal(f.service.getPublishStatus().itemId, "777");
  assert.ok(!f.calls.some(([name]) => name === "update"));
});

test("connect uses HOI4 and serializes bigint account and state flags", async () => {
  const f = fixture();
  const result = await f.service.connect();
  assert.deepEqual(f.calls, [["connect", 394360]]);
  assert.equal(result.connected, true);
  assert.deepEqual(result.account, {
    name: "Test player",
    steamId: "76561198000000000",
  });
  assert.deepEqual(result.items[0], {
    id: "123",
    name: "A mod",
    hasChineseContent: false,
    subscribed: true,
    installed: true,
    needsUpdate: true,
    downloading: true,
    pending: true,
    downloadedBytes: 1024,
    totalBytes: 2048,
  });
  assert.doesNotThrow(() => JSON.stringify(result));
  result.items[0].name = "tampered";
  assert.equal((await f.service.getState()).items[0].name, "A mod");
});

test("concurrent connect calls initialize exactly once", async () => {
  const f = fixture();
  const results = await Promise.all([
    f.service.connect(),
    f.service.connect(),
    f.service.getState(),
  ]);
  assert.equal(f.calls.filter(([name]) => name === "connect").length, 1);
  assert.ok(results.every((result) => result.connected));
});

test("subscription and browse cards expose only validated display metadata", async () => {
  const f = fixture();
  const metadata = {
    previewUrl: "https://images.steamusercontent.com/ugc/123/cover.jpg",
    timeUpdated: 1793260800,
    statistics: { numSubscriptions: 123456n, numFollowers: 999n },
    tags: ["Gameplay", "<b>Graphics</b>", "Gameplay", "", null],
    fileSize: 2000,
  };
  f.items.set("123", nativeItem(123n, metadata));
  const subscribed = (await f.service.connect()).items[0];
  const browsed = (await f.service.browse()).items[0];
  for (const item of [subscribed, browsed]) {
    assert.equal(item.previewUrl, metadata.previewUrl);
    assert.equal(item.updatedAt, metadata.timeUpdated);
    assert.equal(item.subscriberCount, 123456);
    assert.deepEqual(item.tags, ["Gameplay", "Graphics"]);
    assert.equal(Object.hasOwn(item, "statistics"), false);
    assert.equal(Object.hasOwn(item, "fileSize"), false);
    assert.doesNotThrow(() => JSON.stringify(item));
  }
  assert.equal(subscribed.description, undefined);
  assert.equal(browsed.description, "A campaign");
  subscribed.tags.push("edited");
  assert.deepEqual((await f.service.getState()).items[0].tags, [
    "Gameplay",
    "Graphics",
  ]);
});

test("Steam cover URLs permit only HTTPS images on the supported CDN hosts", async () => {
  const f = fixture();
  await f.service.connect();
  for (const url of [
    "https://steamstatic.com/cover.png",
    "https://cdn.akamai.steamstatic.com/cover.jpg?width=400",
    "https://steamusercontent.com/cover.jpg",
    "https://images.steamusercontent.com/ugc/123/cover.jpg",
    "https://steamuserimages-a.akamaihd.net/ugc/123/cover.jpg",
    "https://IMAGES.STEAMUSERCONTENT.COM:443/ugc/123/cover.jpg",
  ]) {
    f.items.set("123", nativeItem(123n, { previewUrl: url }));
    assert.equal(
      (await f.service.browse()).items[0].previewUrl,
      new URL(url).href,
    );
  }
  for (const url of [
    "http://images.steamusercontent.com/cover.jpg",
    "//images.steamusercontent.com/cover.jpg",
    "file:///C:/private/cover.png",
    "data:image/svg+xml,<svg />",
    "javascript:alert(1)",
    "https://images.steamusercontent.com.evil.test/cover.jpg",
    "https://notsteamstatic.com/cover.jpg",
    "https://steamstatic.com@evil.test/cover.jpg",
    "https://user:secret@images.steamusercontent.com/cover.jpg",
    "https://images.steamusercontent.com:444/cover.jpg",
    "https://images.steamusercontent.com./cover.jpg",
    "https://steamuserimages-a.akamaihd.net.evil.test/cover.jpg",
    "https://unapproved.akamaihd.net/cover.jpg",
    "https://images.steamusercontent.com/\ncover.jpg",
    "https://images.steamusercontent.com/" + "a".repeat(2048),
    {},
    null,
  ]) {
    f.items.set("123", nativeItem(123n, { previewUrl: url }));
    assert.equal(
      Object.hasOwn((await f.service.browse()).items[0], "previewUrl"),
      false,
    );
  }
});

test("unknown or unsafe metadata is omitted without rejecting an otherwise valid item", async () => {
  const f = fixture();
  await f.service.connect();
  for (const value of [
    undefined,
    null,
    -1,
    -1n,
    1.5,
    "12",
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    2n ** 64n,
  ]) {
    f.items.set(
      "123",
      nativeItem(123n, {
        timeUpdated: value,
        statistics: { numSubscriptions: value },
        tags: "Gameplay",
      }),
    );
    const item = (await f.service.getState()).items[0];
    assert.equal(item.id, "123");
    assert.equal(Object.hasOwn(item, "updatedAt"), false);
    assert.equal(Object.hasOwn(item, "subscriberCount"), false);
    assert.equal(Object.hasOwn(item, "tags"), false);
  }
  f.items.set(
    "123",
    nativeItem(123n, {
      timeUpdated: 8640000000001,
      statistics: { numSubscriptions: 0n },
    }),
  );
  let item = (await f.service.browse()).items[0];
  assert.equal(item.updatedAt, undefined);
  assert.equal(item.subscriberCount, 0);
  f.items.set(
    "123",
    nativeItem(123n, {
      timeUpdated: 0,
      statistics: { numSubscriptions: BigInt(Number.MAX_SAFE_INTEGER) },
    }),
  );
  item = (await f.service.browse()).items[0];
  assert.equal(item.updatedAt, undefined);
  assert.equal(item.subscriberCount, Number.MAX_SAFE_INTEGER);
});

test("display tags are bounded, deduplicated plain text", async () => {
  const f = fixture();
  await f.service.connect();
  f.items.set(
    "123",
    nativeItem(123n, {
      tags: [
        "<script>secret()</script>[b]Gameplay[/b]\n",
        "Gameplay",
        "x".repeat(1000),
        ...Array.from({ length: 50 }, (_, i) => `tag${i}`),
      ],
    }),
  );
  const item = (await f.service.browse()).items[0];
  assert.equal(item.tags[0], "Gameplay");
  assert.equal(item.tags[1], "x".repeat(80));
  assert.equal(item.tags.length, 31);
  assert.equal(item.tags.at(-1), "tag28");
  assert.doesNotMatch(item.tags.join(" "), /secret|<|\[/);
});

test("failed native initialization is disconnected, sanitized, and can be retried", async () => {
  let count = 0;
  const f = fixture();
  const service = createSteamWorkshopService({
    createClient: () => {
      if (++count === 1) throw new Error("secret token C:/private");
      return f.client;
    },
  });
  const failed = await service.connect();
  assert.equal(failed.connected, false);
  assert.equal(failed.account, null);
  assert.doesNotMatch(failed.error, /secret|private/);
  assert.equal((await service.getState()).connected, false);
  assert.equal(count, 1);
  assert.equal((await service.connect()).connected, true);
  assert.equal(count, 2);
});

test("incomplete client, wrong app and invalid initial account never connect", async () => {
  for (const alter of [
    (client) => {
      delete client.workshop.getItem;
    },
    (client) => {
      client.utils.getAppId = () => 480;
    },
    (client) => {
      client.localplayer.getSteamId = () => {
        throw new Error("private");
      };
    },
    (client) => {
      client.localplayer.getSteamId = () => ({ steamId64: 0n });
    },
  ]) {
    const f = fixture();
    alter(f.client);
    const result = await f.service.connect();
    assert.equal(result.connected, false);
    assert.equal(result.account, null);
    assert.ok(result.error);
    assert.doesNotMatch(result.error, /private/);
  }
});

for (const method of ["getSubscribedItems", "getItems"]) {
  test(`initial ${method} failure preserves the connection and a later refresh recovers`, async () => {
    const f = fixture();
    const original = f.client.workshop[method];
    f.client.workshop[method] = () => {
      if (method === "getItems")
        return Promise.reject(new Error("private C:/secret token"));
      throw new Error("private C:/secret token");
    };
    const initial = await f.service.connect();
    assert.equal(initial.connected, true);
    assert.deepEqual(initial.account, {
      name: "Test player",
      steamId: "76561198000000000",
    });
    assert.deepEqual(initial.items, []);
    assert.equal(
      initial.error,
      "无法刷新 Steam 订阅状态，请检查客户端连接后重试。",
    );
    assert.doesNotMatch(initial.error, /private|secret|token/);
    assert.deepEqual(f.calls, [["connect", 394360]]);

    f.client.workshop[method] = original;
    const recovered = await f.service.getState();
    assert.equal(recovered.connected, true);
    assert.deepEqual(recovered.account, initial.account);
    assert.equal(recovered.items.length, 1);
    assert.equal(recovered.items[0].id, "123");
    assert.equal(recovered.error, undefined);
    assert.deepEqual(f.calls, [["connect", 394360]]);
  });
}

test("browse maps page, query and sort to native HOI4-only queries", async () => {
  const f = fixture();
  await f.service.connect();
  const result = await f.service.browse({ query: " Kaiserreich ", page: 2 });
  assert.deepEqual(f.calls.at(-1), [
    "getAllItems",
    2,
    11,
    0,
    0,
    394360,
    { cachedResponseMaxAge: 0, searchText: "Kaiserreich" },
  ]);
  assert.equal(result.page, 2);
  assert.equal(result.totalCount, 51);
  assert.equal(result.totalPages, 2);
  assert.equal(result.items[0].description, "A campaign");
  await f.service.browse({ sort: "recent" });
  assert.equal(f.calls.at(-1)[2], 19);
  await f.service.browse();
  assert.equal(f.calls.at(-1)[2], 0);
  assert.equal(f.calls.at(-1)[6].searchText, undefined);
});

test("browse categories add a required tag while preserving search, sort and page", async () => {
  const f = fixture();
  await f.service.connect();
  for (const category of [
    "Alternative History",
    "Gameplay",
    "Graphics",
    "Translation",
    "Balance",
    "Events",
    "Fixes",
    "Historical",
    "Map",
    "Military",
    "National Focuses",
    "Sound",
    "Technologies",
    "Utilities",
  ]) {
    await f.service.browse({
      category,
      query: " China ",
      sort: "recent",
      page: 3,
    });
    assert.deepEqual(f.calls.at(-1), [
      "getAllItems",
      3,
      19,
      0,
      0,
      394360,
      {
        cachedResponseMaxAge: 0,
        searchText: "China",
        requiredTags: [category],
      },
    ]);
  }
  await f.service.browse({ category: "" });
  assert.deepEqual(f.calls.at(-1)[6], { cachedResponseMaxAge: 0 });
});

test("browse combines included tags, exclusions and any-tag matching before Steam pagination", async () => {
  const f = fixture();
  await f.service.connect();
  const filters = {
    category: "Gameplay",
    tags: ["Gameplay", "Historical", "National Focuses"],
    excludedTags: ["Translation", "Graphics"],
    matchAnyTag: true,
    query: " China ",
    sort: "recent",
    page: 4,
  };
  const result = await f.service.browse(filters);
  assert.deepEqual(f.calls.at(-1), [
    "getAllItems",
    4,
    19,
    0,
    0,
    394360,
    {
      cachedResponseMaxAge: 0,
      searchText: "China",
      requiredTags: ["Gameplay", "Historical", "National Focuses"],
      excludedTags: ["Translation", "Graphics"],
      matchAnyTag: true,
    },
  ]);
  assert.equal(result.page, 4);
  assert.equal(result.totalCount, 51);
  assert.equal(result.totalPages, 2);
  assert.deepEqual(filters.tags, [
    "Gameplay",
    "Historical",
    "National Focuses",
  ]);
  await f.service.browse({
    tags: ["Historical", "Balance"],
    excludedTags: ["Translation"],
    matchAnyTag: false,
  });
  assert.deepEqual(f.calls.at(-1)[6], {
    cachedResponseMaxAge: 0,
    requiredTags: ["Historical", "Balance"],
    excludedTags: ["Translation"],
  });
  await f.service.browse({ excludedTags: ["Translation"], matchAnyTag: true });
  assert.deepEqual(f.calls.at(-1)[6], {
    cachedResponseMaxAge: 0,
    excludedTags: ["Translation"],
  });
});

test("browse exposes native rankings and applies trend windows only to trending queries", async () => {
  const f = fixture();
  await f.service.connect();
  for (const [sort, nativeType] of [
    ["recent", 19],
    ["weekly", 3],
    ["created", 1],
    ["trending", 3],
    ["subscriptions", 12],
    ["votes", 10],
    ["rated", 0],
    ["dependencies", 20],
    ["collections", 21],
  ]) {
    for (const query of ["", " China "]) {
      await f.service.browse({
        sort,
        query,
        page: 2,
        tags: ["Gameplay"],
        trendDays: 30,
      });
      assert.deepEqual(f.calls.at(-1), [
        "getAllItems",
        2,
        nativeType,
        0,
        0,
        394360,
        {
          cachedResponseMaxAge: 0,
          ...(query ? { searchText: "China" } : {}),
          requiredTags: ["Gameplay"],
          ...(sort === "trending" ? { rankedByTrendDays: 30 } : {}),
          ...(sort === "weekly" ? { rankedByTrendDays: 7 } : {}),
        },
      ]);
    }
  }
  for (const days of [7, 30, 90, 365]) {
    await f.service.browse({ sort: "trending", trendDays: days });
    assert.equal(f.calls.at(-1)[6].rankedByTrendDays, days);
  }
  await f.service.browse({ sort: "trending" });
  assert.equal(f.calls.at(-1)[6].rankedByTrendDays, 7);
});

test("browse input validation prevents native queries", async () => {
  const f = fixture();
  await f.service.connect();
  for (const input of [
    null,
    [],
    { query: "x".repeat(121) },
    { query: "x\ny" },
    { query: {} },
    { page: 0 },
    { page: 10001 },
    { page: 1.2 },
    { sort: "bad" },
    { language: "english" },
    { language: null },
    { language: {} },
    { cursor: { page: 1, offset: 0 } },
    { language: "chinese", cursor: null },
    { language: "chinese", cursor: {} },
    { language: "chinese", cursor: { page: 0, offset: 0 } },
    { language: "chinese", cursor: { page: 10001, offset: 0 } },
    { language: "chinese", cursor: { page: 1, offset: -1 } },
    { language: "chinese", cursor: { page: 1, offset: 50 } },
    { language: "chinese", cursor: { page: 1, offset: 0, token: "private" } },
    { category: "unknown" },
    { category: "Gameplay\n" },
    { category: ["Gameplay"] },
    { category: null },
    { category: {} },
    { tags: "Gameplay" },
    { tags: null },
    { tags: {} },
    { tags: ["unknown"] },
    { tags: ["Gameplay\n"] },
    { tags: [""] },
    { tags: [1] },
    { tags: [["Gameplay"]] },
    { tags: ["Gameplay", "Gameplay"] },
    { tags: Array(15).fill("Gameplay") },
    { tags: Array(1) },
    { excludedTags: "Translation" },
    { excludedTags: null },
    { excludedTags: {} },
    { excludedTags: ["unknown"] },
    { excludedTags: ["Translation", "Translation"] },
    { excludedTags: Array(15).fill("Gameplay") },
    { excludedTags: Array(1) },
    { category: "Gameplay", excludedTags: ["Gameplay"] },
    { tags: ["Gameplay"], excludedTags: ["Gameplay"] },
    { matchAnyTag: "true" },
    { matchAnyTag: 0 },
    { matchAnyTag: null },
    { trendDays: "7" },
    { trendDays: 0 },
    { trendDays: 1 },
    { trendDays: 7.5 },
    { trendDays: 366 },
    { trendDays: null },
    { trendDays: NaN },
    { trendDays: Infinity },
    { token: "private" },
  ])
    await assert.rejects(f.service.browse(input));
  assert.equal(f.calls.filter(([name]) => name === "getAllItems").length, 0);
});

test("Chinese identification uses author text and tags rather than localized return language", async () => {
  const f = fixture();
  await f.service.connect();
  for (const [patch, expected] of [
    [{ title: "中文模组" }, true],
    [{ title: "繁體國策" }, true],
    [{ description: "A campaign. 這是中文介紹。" }, true],
    [{ tags: ["Simplified Chinese"] }, true],
    [{ tags: ["tchinese"] }, true],
    [{ tags: ["Japanese"], title: "日本語の国策を追加" }, false],
    [{ title: "한국어 모드" }, false],
    [{ title: "A campaign", description: "English text" }, false],
    [{ title: "English name", description: "[img]中文图片地址[/img]" }, false],
  ]) {
    f.items.set("123", nativeItem(123n, patch));
    assert.equal(
      (await f.service.getState()).items[0].hasChineseContent,
      expected,
    );
    const result = await f.service.browse({ language: "chinese" });
    assert.equal(
      result.items.some((item) => item.id === "123"),
      expected,
    );
    assert.equal(f.calls.at(-1)[6].language, undefined);
  }
});

test("language filtering fills pages across Steam pages and resumes within the last source page", async () => {
  const entries = Array.from({ length: 140 }, (_, index) =>
    nativeItem(BigInt(index + 1), {
      title: index % 2 ? `English ${index}` : `中文 ${index}`,
      tags: ["Historical"],
    }),
  );
  const pages = [];
  const f = fixture({
    workshop: {
      getAllItems: async (page, queryType, _type, _creator, appId, config) => {
        pages.push({ page, queryType, appId, config });
        return {
          items: entries.slice((page - 1) * 50, page * 50),
          totalResults: entries.length,
        };
      },
    },
  });
  await f.service.connect();
  const filters = {
    language: "chinese",
    sort: "dependencies",
    query: "campaign",
    tags: ["Historical"],
  };
  const first = await f.service.browse(filters);
  assert.equal(first.items.length, 50);
  assert.equal(first.totalCount, null);
  assert.equal(first.totalPages, null);
  assert.equal(first.hasMore, true);
  assert.deepEqual(first.nextCursor, { page: 2, offset: 49 });
  const second = await f.service.browse({
    ...filters,
    page: 2,
    cursor: first.nextCursor,
  });
  assert.equal(second.items.length, 20);
  assert.equal(second.hasMore, false);
  assert.equal(second.nextCursor, null);
  assert.equal(
    new Set([...first.items, ...second.items].map((item) => item.id)).size,
    70,
  );
  assert.deepEqual(
    pages.map(({ page }) => page),
    [1, 2, 2, 3],
  );
  assert.ok(
    pages.every(
      ({ queryType, appId, config }) =>
        queryType === 20 &&
        appId === 394360 &&
        config.searchText === "campaign" &&
        config.requiredTags[0] === "Historical",
    ),
  );
  const reverse = await f.service.browse({ language: "non-chinese" });
  assert.ok(reverse.items.every((item) => !item.hasChineseContent));
  assert.ok(
    reverse.items.every(
      (item) => !first.items.some((match) => item.id === match.id),
    ),
  );
});

test("sparse language results stop after a bounded scan and allow continuing after empty batches", async () => {
  const pages = [];
  const f = fixture({
    workshop: {
      getAllItems: async (page) => {
        pages.push(page);
        return {
          items: Array.from({ length: page === 5 ? 1 : 50 }, (_, index) =>
            nativeItem(BigInt((page - 1) * 50 + index + 1), {
              title: page === 5 ? "最后一个中文模组" : "English mod",
            }),
          ),
          totalResults: 201,
        };
      },
    },
  });
  await f.service.connect();
  const first = await f.service.browse({ language: "chinese" });
  assert.equal(first.items.length, 0);
  assert.equal(first.hasMore, true);
  assert.deepEqual(pages, [1, 2, 3, 4]);
  const second = await f.service.browse({
    language: "chinese",
    page: 2,
    cursor: first.nextCursor,
  });
  assert.equal(second.items[0].id, "201");
  assert.equal(second.hasMore, false);
  const replay = await f.service.browse({ language: "chinese" });
  assert.deepEqual(replay.nextCursor, first.nextCursor);
});

test("language scanning rejects invalid later pages without returning a partial success", async () => {
  const f = fixture({
    workshop: {
      getAllItems: async (page) =>
        page === 1
          ? {
              items: Array.from({ length: 50 }, (_, index) =>
                nativeItem(BigInt(index + 1)),
              ),
              totalResults: 70,
            }
          : { items: [], totalResults: -1 },
    },
  });
  await f.service.connect();
  await assert.rejects(f.service.browse({ language: "chinese" }), /无效/);
});

test("browse accepts empty results and rejects malformed response shapes", async () => {
  const f = fixture();
  await f.service.connect();
  f.client.workshop.getAllItems = async () => ({ items: [], totalResults: 0 });
  assert.deepEqual(await f.service.browse(), {
    items: [],
    page: 1,
    totalCount: 0,
    totalPages: 0,
  });
  for (const result of [
    null,
    { items: [], totalResults: -1 },
    { items: [], totalResults: 10000001 },
    { items: [], totalResults: 1.5 },
    { items: Array(51).fill(nativeItem()), totalResults: 51 },
  ]) {
    f.client.workshop.getAllItems = async () => result;
    await assert.rejects(f.service.browse(), /无效/);
  }
});

test("foreign, banned, duplicate and malformed items cannot enter browse results", async () => {
  const f = fixture();
  await f.service.connect();
  f.client.workshop.getAllItems = async () => ({
    items: [
      nativeItem(),
      nativeItem(),
      nativeItem(456n, { consumerAppId: 480 }),
      nativeItem(789n, { banned: true }),
      nativeItem(0n),
      null,
    ],
    totalResults: 6,
  });
  const result = await f.service.browse();
  assert.deepEqual(
    result.items.map((item) => item.id),
    ["123"],
  );
});

test("unsafe or imprecise byte counts become unknown instead of inaccurate progress", async () => {
  const f = fixture();
  await f.service.connect();
  for (const info of [
    null,
    { current: -1n, total: 3n },
    { current: 5n, total: 4n },
    { current: 2n ** 64n, total: 2n ** 65n },
    { current: 1.5, total: 5 },
    { current: "2", total: "5" },
  ]) {
    f.client.workshop.downloadInfo = () => info;
    const item = (await f.service.getState()).items[0];
    assert.equal(item.downloadedBytes, null);
    assert.equal(item.totalBytes, null);
  }
});

test("native descriptions and names are bounded plain text", async () => {
  const f = fixture();
  await f.service.connect();
  f.items.set(
    "123",
    nativeItem(123n, {
      title: "<b>Hello</b>\nWorld",
      description: "<script>secret()</script>[b]text[/b] " + "x".repeat(1000),
    }),
  );
  const result = await f.service.browse();
  assert.equal(result.items[0].name, "Hello World");
  assert.equal(result.items[0].description.length, 350);
  assert.ok(result.items[0].description.startsWith("text "));
  assert.doesNotMatch(result.items[0].description, /secret|<|\[/);
});

test("all mutations verify app ownership and identifier before invoking a write", async () => {
  const f = fixture();
  await f.service.connect();
  for (const raw of [
    null,
    nativeItem(123n, { consumerAppId: 480 }),
    nativeItem(456n),
    nativeItem(123n, { consumerAppId: undefined }),
    nativeItem(123n, { banned: true }),
  ]) {
    f.client.workshop.getItem = async () => raw;
    for (const action of ["subscribe", "unsubscribe", "download"])
      await assert.rejects(f.service[action]("123"), /未执行/);
  }
  assert.ok(
    !f.calls.some(([name]) =>
      ["subscribe", "unsubscribe", "download"].includes(name),
    ),
  );
});

test("mutation IDs cannot overflow uint64 or lose numeric precision", async () => {
  const f = fixture();
  await f.service.connect();
  for (const id of [
    undefined,
    123,
    123n,
    "0",
    "-1",
    "01",
    " 123",
    "1e3",
    "18446744073709551616",
    "9".repeat(50),
    "123\n",
  ])
    await assert.rejects(f.service.subscribe(id), /ID/);
  assert.equal(f.calls.filter(([name]) => name === "getItem").length, 0);
  f.items.set("18446744073709551615", nativeItem(18446744073709551615n));
  await f.service.subscribe("18446744073709551615");
  assert.ok(
    f.calls.some(
      ([name, id]) => name === "subscribe" && id === 18446744073709551615n,
    ),
  );
});

test("subscribe, unsubscribe and low priority download return refreshed state", async () => {
  const f = fixture();
  await f.service.connect();
  let result = await f.service.subscribe("456");
  assert.equal(result.items.find((item) => item.id === "456").subscribed, true);
  result = await f.service.download("456");
  assert.equal(
    result.items.find((item) => item.id === "456").downloading,
    true,
  );
  assert.deepEqual(
    f.calls.find(([name]) => name === "download"),
    ["download", 456n, false],
  );
  result = await f.service.unsubscribe("456");
  assert.ok(!result.items.some((item) => item.id === "456"));
  const writes = f.calls.filter(([name]) => name !== "connect");
  assert.deepEqual(
    writes.map(([name]) => name),
    ["getItem", "subscribe", "getItem", "download", "getItem", "unsubscribe"],
  );
});

test("failed native writes and refused downloads are actionable and sanitized", async () => {
  const f = fixture();
  await f.service.connect();
  for (const action of ["subscribe", "unsubscribe", "download"]) {
    f.client.workshop[action] = () => {
      throw new Error("private C:/secret token");
    };
    await assert.rejects(
      f.service[action]("123"),
      (error) =>
        /失败/.test(error.message) &&
        !/private|secret|token/.test(error.message),
    );
  }
  f.client.workshop.download = () => false;
  await assert.rejects(f.service.download("123"), /未接受/);
});

test("native browse and detail errors never expose native error strings", async () => {
  const f = fixture();
  await f.service.connect();
  f.client.workshop.getAllItems = async () => {
    throw new Error("SECRET");
  };
  f.client.workshop.getItem = async () => {
    throw new Error("SECRET");
  };
  await assert.rejects(
    f.service.browse(),
    (error) => !error.message.includes("SECRET"),
  );
  await assert.rejects(
    f.service.subscribe("123"),
    (error) => !error.message.includes("SECRET"),
  );
});

test("mutations remain serial and a rejected operation does not poison the queue", async () => {
  const f = fixture();
  await f.service.connect();
  let release, started;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const began = new Promise((resolve) => {
    started = resolve;
  });
  const original = f.client.workshop.subscribe;
  f.client.workshop.subscribe = async (id) => {
    started();
    await pending;
    return original(id);
  };
  const first = f.service.subscribe("456");
  await began;
  const second = f.service.unsubscribe("456");
  await Promise.resolve();
  assert.deepEqual(
    f.calls.filter(([name]) => name === "getItem").map(([, id]) => id),
    [456n],
  );
  release();
  await Promise.all([first, second]);
  assert.deepEqual(
    f.calls
      .filter(([name]) => ["subscribe", "unsubscribe"].includes(name))
      .map(([name]) => name),
    ["subscribe", "unsubscribe"],
  );
  await assert.rejects(f.service.subscribe("bad"));
  assert.equal((await f.service.getState()).connected, true);
});

test("refresh failures retain the prior snapshot and report when a mutation succeeded", async () => {
  const f = fixture();
  await f.service.connect();
  f.client.workshop.getItems = async () => {
    throw new Error("private");
  };
  const stale = await f.service.getState();
  assert.equal(stale.connected, true);
  assert.equal(stale.items.length, 1);
  assert.ok(stale.error);
  assert.doesNotMatch(stale.error, /private/);
  const changed = await f.service.subscribe("456");
  assert.match(changed.error, /已订阅/);
  assert.doesNotMatch(changed.error, /private/);
});

test("subscribed details are batched and unavailable entries produce an explicit partial warning", async () => {
  const f = fixture();
  const ids = Array.from({ length: 205 }, (_, index) => BigInt(index + 1));
  const batches = [];
  f.client.workshop.getSubscribedItems = () => [...ids, 0n, 1n];
  f.client.workshop.getItems = async (requested) => {
    batches.push(requested.length);
    return {
      items: requested.map((id) => (id === 5n ? null : nativeItem(id))),
    };
  };
  const result = await f.service.connect();
  assert.deepEqual(batches, [100, 100, 5]);
  assert.equal(result.items.length, 204);
  assert.match(result.error, /不完整/);
});

test("repairItem subscribes and requests normal-priority download without refreshing the whole subscription library", async () => {
  const f = fixture();
  await f.service.connect();
  f.client.workshop.getItems = async () => {
    throw new Error("must not refresh all subscriptions");
  };
  const value = await f.service.repairItem({
    id: "456",
    expectedSteamId: "76561198000000000",
  });
  assert.equal(value.outcome, "submitted");
  assert.equal(value.subscription, "confirmed");
  assert.equal(value.downloadRequest, "accepted");
  assert.equal(value.observed.installed, false);
  assert.deepEqual(
    f.calls.filter(([name]) => name !== "connect"),
    [
      ["getItem", 456n],
      ["subscribe", 456n],
      ["download", 456n, false],
    ],
  );
});

for (const boundary of [
  "before-details",
  "after-details",
  "after-subscribe",
  "before-download",
]) {
  test(`repairItem stops writes when account changes ${boundary}`, async () => {
    const f = fixture();
    await f.service.connect();
    const change = () => {
      f.client.localplayer.getSteamId = () => ({
        steamId64: 76561198000000001n,
      });
    };
    if (boundary === "before-details") change();
    if (boundary === "after-details")
      f.client.workshop.getItem = async () => {
        change();
        return nativeItem(456n);
      };
    if (boundary === "after-subscribe")
      f.client.workshop.subscribe = async () => {
        f.calls.push(["subscribe", 456n]);
        change();
      };
    if (boundary === "before-download") {
      let reads = 0;
      f.client.workshop.state = () => {
        if (++reads === 2) change();
        return reads === 1 ? 0 : 1;
      };
    }
    const result = await f.service.repairItem({
      id: "456",
      expectedSteamId: "76561198000000000",
    });
    assert.equal(result.errorCode, "ACCOUNT_CHANGED");
    assert.equal(
      f.calls.some(([name]) => name === "download"),
      false,
    );
    if (["before-details", "after-details"].includes(boundary))
      assert.equal(
        f.calls.some(([name]) => name === "subscribe"),
        false,
      );
    if (boundary === "after-subscribe")
      assert.equal(result.subscription, "unknown");
  });
}

test("repairItem rejects a changed app, invalid IDs and unavailable or mismatched detail before any write", async () => {
  const f = fixture();
  await f.service.connect();
  await assert.rejects(
    f.service.repairItem({
      id: "456",
      expectedSteamId: "76561198000000000",
      highPriority: true,
    }),
    /参数/,
  );
  await assert.rejects(
    f.service.repairItem({
      id: "18446744073709551616",
      expectedSteamId: "76561198000000000",
    }),
    /ID/,
  );
  for (const value of [
    null,
    nativeItem(123n),
    nativeItem(456n, { consumerAppId: 480 }),
    nativeItem(456n, { banned: true }),
    nativeItem(456n, { banned: undefined }),
  ]) {
    f.client.workshop.getItem = async () => value;
    assert.equal(
      (
        await f.service.repairItem({
          id: "456",
          expectedSteamId: "76561198000000000",
        })
      ).errorCode,
      "ITEM_UNAVAILABLE",
    );
  }
  f.client.utils.getAppId = () => 480;
  assert.equal(
    (
      await f.service.repairItem({
        id: "456",
        expectedSteamId: "76561198000000000",
      })
    ).errorCode,
    "APP_CHANGED",
  );
  assert.equal(
    f.calls.some(([name]) => ["subscribe", "download"].includes(name)),
    false,
  );
});

test("already active or installed repairs avoid duplicate requests and distinguish refused and unknown writes", async () => {
  const f = fixture();
  await f.service.connect();
  assert.equal(
    (
      await f.service.repairItem({
        id: "123",
        expectedSteamId: "76561198000000000",
      })
    ).downloadRequest,
    "already-active",
  );
  f.flags.set("123", 1 | 4);
  assert.equal(
    (
      await f.service.repairItem({
        id: "123",
        expectedSteamId: "76561198000000000",
      })
    ).outcome,
    "already-present",
  );
  f.flags.set("123", 1);
  f.client.workshop.download = () => false;
  assert.equal(
    (
      await f.service.repairItem({
        id: "123",
        expectedSteamId: "76561198000000000",
      })
    ).downloadRequest,
    "rejected",
  );
  f.client.workshop.subscribe = async () => {
    throw Object.assign(new Error("private token"), { code: "PRIVATE_DATA" });
  };
  const unknown = await f.service.repairItem({
    id: "456",
    expectedSteamId: "76561198000000000",
  });
  assert.equal(unknown.outcome, "unknown");
  assert.equal(unknown.errorCode, "STEAM_REQUEST_FAILED");
  assert.doesNotMatch(JSON.stringify(unknown), /private token|PRIVATE_DATA/);
});

test("active repair keeps status readable and excludes publication or overlapping mutations", async () => {
  const f = fixture();
  await f.service.connect();
  let release;
  f.client.workshop.getItem = () =>
    new Promise((resolve) => {
      release = () => resolve(nativeItem(456n));
    });
  const repairing = f.service.repairItem({
    id: "456",
    expectedSteamId: "76561198000000000",
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await f.service.getState()).repairing, true);
  await assert.rejects(f.service.subscribe("123"), /补齐/);
  assert.throws(() => f.service.startPublish({}), /补齐/);
  await assert.rejects(
    f.service.repairItem({ id: "123", expectedSteamId: "76561198000000000" }),
    /已有/,
  );
  release();
  await repairing;
});
