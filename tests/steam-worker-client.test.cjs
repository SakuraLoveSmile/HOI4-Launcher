"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { attachSteamWorker } = require("../electron/steam-worker.cjs");
const {
  createSteamWorkerClient,
} = require("../electron/steam-worker-client.cjs");

test("failed worker startup is bounded and a later connection can retry", async () => {
  let forks = 0,
    kills = 0;
  const client = createSteamWorkerClient({
    scriptPath: "fixture",
    timeoutMs: 15,
    fork: () => {
      forks++;
      const child = new EventEmitter();
      child.kill = () => {
        kills++;
        child.emit("exit", 1);
      };
      return child;
    },
  });
  await assert.rejects(client.call("connect"), /超时/);
  await assert.rejects(client.call("connect"), /超时/);
  assert.equal(forks, 2);
  assert.equal(kills, 2);
  client.dispose();
});

function fixture(handler, timeoutMs = 200, extra = {}) {
  let forks = 0,
    child;
  const client = createSteamWorkerClient({
    scriptPath: "fixture-only.cjs",
    timeoutMs,
    ...extra,
    fork: () => {
      forks++;
      child = new EventEmitter();
      child.postMessage = (message) => handler(child, message);
      child.kill = () => child.emit("exit", 0);
      queueMicrotask(() => child.emit("spawn"));
      return child;
    },
  });
  return {
    client,
    get child() {
      return child;
    },
    get forks() {
      return forks;
    },
  };
}
test("Steam worker stays absent until explicit connect and shares one process", async () => {
  const f = fixture((child, message) =>
    queueMicrotask(() =>
      child.emit("message", { id: message.id, result: { connected: true } }),
    ),
  );
  assert.equal((await f.client.call("getState")).connected, false);
  assert.equal(f.forks, 0);
  await assert.rejects(f.client.call("subscribe", "123"), /先连接/);
  assert.equal(f.forks, 0);
  await Promise.all([f.client.call("connect"), f.client.call("connect")]);
  assert.equal(f.forks, 1);
  assert.equal(f.client.disconnect().connected, false);
});
test("Steam worker exits reject pending operations and can reconnect", async () => {
  const f = fixture((child, message) => {
    if (message.method === "connect")
      queueMicrotask(() =>
        child.emit("message", { id: message.id, result: { connected: true } }),
      );
  });
  await f.client.call("connect");
  const pending = f.client.call("subscribe", "123");
  await new Promise((resolve) => setImmediate(resolve));
  assert.throws(() => f.client.disconnect(), /正在处理/);
  f.child.emit("exit", 1);
  await assert.rejects(pending, /刷新状态/);
  await f.client.call("connect");
  assert.equal(f.forks, 2);
  f.client.dispose();
});
test("unknown methods and timeout fail without replaying writes", async () => {
  const f = fixture((child, message) => {
    if (message.method === "connect")
      queueMicrotask(() =>
        child.emit("message", { id: message.id, result: { connected: true } }),
      );
  }, 20);
  await assert.rejects(f.client.call("eval", "anything"), /不支持/);
  assert.equal(f.forks, 0);
  await f.client.call("connect");
  await assert.rejects(f.client.call("download", "123"), /无法确认完成/);
  assert.equal(f.forks, 1);
  f.client.dispose();
});

test("a hung first connection retires its read-only worker and an explicit retry starts fresh", async () => {
  const f = fixture((child, message) => {
    if (f.forks > 1)
      queueMicrotask(() =>
        child.emit("message", { id: message.id, result: { connected: true } }),
      );
  }, 20);
  const initial = assert.rejects(f.client.call("connect"), /超时/);
  await new Promise((resolve) => setImmediate(resolve));
  const abandoned = f.child;
  let killed = 0;
  abandoned.on("exit", () => killed++);
  const waitingRead = assert.rejects(f.client.call("getState"), /断开/);
  await Promise.all([initial, waitingRead]);
  assert.equal(killed, 1);
  assert.equal((await f.client.call("getState")).connected, false);
  assert.equal((await f.client.call("connect")).connected, true);
  assert.equal(f.forks, 2);
  // Late messages from the retired process must not poison the new connection.
  abandoned.emit("message", { id: 1, result: { connected: false } });
  assert.equal((await f.client.call("getState")).connected, true);
  f.client.dispose();
});

test("a connect timeout never terminates an already established session", async () => {
  let connections = 0;
  const f = fixture((child, message) => {
    if (message.method === "connect" && ++connections === 1)
      queueMicrotask(() =>
        child.emit("message", { id: message.id, result: { connected: true } }),
      );
  }, 20);
  await f.client.call("connect");
  let killed = 0;
  f.child.on("exit", () => killed++);
  await assert.rejects(f.client.call("connect"), /超时/);
  assert.equal(killed, 0);
  assert.equal(f.forks, 1);
  f.client.dispose();
});

test("a timed-out initial connect cannot kill a worker with an unconfirmed mutation", async () => {
  const f = fixture(() => {}, 20);
  const connection = assert.rejects(f.client.call("connect"), /超时/);
  await new Promise((resolve) => setImmediate(resolve));
  let killed = 0;
  f.child.on("exit", () => killed++);
  const write = assert.rejects(f.client.call("download", "123"), /超时/);
  await Promise.all([connection, write]);
  assert.equal(killed, 0);
  assert.equal(f.forks, 1);
  f.client.dispose();
});

test("publication status prevents disconnect and reports interrupted IDs on native exit", async () => {
  const events = [];
  const f = fixture(
    (child, message) =>
      queueMicrotask(() =>
        child.emit("message", { id: message.id, result: { connected: true } }),
      ),
    200,
    { onPublishStatus: (job) => events.push(job) },
  );
  await f.client.call("connect");
  f.child.emit("message", {
    event: "publish-status",
    job: { id: "fixture", itemId: "900001", status: "uploading" },
  });
  assert.throws(() => f.client.disconnect(), /上传/);
  f.child.emit("exit", 1);
  assert.equal(events.at(-1).status, "interrupted");
  assert.equal(events.at(-1).itemId, "900001");
  assert.equal((await f.client.call("getState")).connected, false);
});

test("repair timeout retains the active native operation until the worker explicitly finishes it", async () => {
  let repairId;
  const f = fixture((child, message) => {
    if (message.method === "connect")
      queueMicrotask(() =>
        child.emit("message", { id: message.id, result: { connected: true } }),
      );
    if (message.method === "repairItem") {
      repairId = message.id;
      child.emit("message", {
        event: "repair-status",
        requestId: message.id,
        active: true,
      });
    }
  }, 20);
  await f.client.call("connect");
  await assert.rejects(
    f.client.call("repairItem", {
      id: "123",
      expectedSteamId: "76561198000000000",
    }),
    /无法确认/,
  );
  assert.equal(f.client.isRepairing(), true);
  assert.throws(() => f.client.disconnect(), /补齐请求/);
  f.child.emit("message", {
    event: "repair-status",
    requestId: repairId,
    active: false,
  });
  assert.equal(f.client.isRepairing(), false);
  f.client.disconnect();
});

test("worker exit clears native repair activity without replaying the request", async () => {
  let repairs = 0;
  const f = fixture((child, message) => {
    if (message.method === "connect")
      queueMicrotask(() =>
        child.emit("message", { id: message.id, result: { connected: true } }),
      );
    if (message.method === "repairItem") repairs++;
  });
  await f.client.call("connect");
  const pending = f.client.call("repairItem", {
    id: "123",
    expectedSteamId: "76561198000000000",
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.client.isRepairing(), true);
  f.child.emit("exit", 1);
  await assert.rejects(pending, /断开/);
  assert.equal(f.client.isRepairing(), false);
  await f.client.call("connect");
  assert.equal(repairs, 1);
  f.client.dispose();
});

test("a rejected repair request without an active event does not leave a phantom reservation", async () => {
  const f = fixture((child, message) =>
    queueMicrotask(() =>
      child.emit(
        "message",
        message.method === "repairItem"
          ? { id: message.id, error: "正在上传" }
          : { id: message.id, result: { connected: true } },
      ),
    ),
  );
  await f.client.call("connect");
  await assert.rejects(f.client.call("repairItem", {}), /上传/);
  assert.equal(f.client.isRepairing(), false);
  f.client.disconnect();
});

test("actual worker protocol keeps reads responsive through a timed-out repair and releases only after its result", async () => {
  const port = new EventEmitter(),
    calls = [];
  let release,
    initialized = 0;
  const native = {
    utils: { getAppId: () => 394360 },
    localplayer: {
      getSteamId: () => ({ steamId64: 76561198000000000n }),
      getName: () => "Fixture",
    },
    workshop: {
      getSubscribedItems: () => [],
      getItems: async () => ({ items: [] }),
      getAllItems: async () => ({ items: [], totalResults: 0 }),
      getItem: () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              publishedFileId: 123n,
              consumerAppId: 394360,
              banned: false,
              title: "Fixture",
            });
        }),
      state: () => 1,
      downloadInfo: () => null,
      subscribe: async () => {
        calls.push("subscribe");
      },
      unsubscribe: async () => {},
      download: (id, priority) => {
        calls.push(["download", String(id), priority]);
        return true;
      },
    },
  };
  attachSteamWorker(port, async () => {
    initialized++;
    return native;
  });
  const f = fixture((child, message) => {
    port.postMessage = (response) => child.emit("message", response);
    port.emit("message", { data: message });
  }, 20);
  assert.equal((await f.client.call("getState")).connected, false);
  assert.equal(initialized, 0);
  await f.client.call("connect");
  await assert.rejects(
    f.client.call("repairItem", {
      id: "123",
      expectedSteamId: "76561198000000000",
    }),
    /超时/,
  );
  assert.equal((await f.client.call("getState")).repairing, true);
  await assert.rejects(f.client.call("startPublish", {}), /补齐/);
  assert.throws(() => f.client.disconnect(), /补齐请求/);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.client.isRepairing(), false);
  assert.deepEqual(calls, [["download", "123", false]]);
  f.client.disconnect();
});
