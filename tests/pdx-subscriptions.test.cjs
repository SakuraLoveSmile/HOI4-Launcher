"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createPdxSubscriptions } = require("../electron/pdx-subscriptions.cjs");
const clone = (value) => structuredClone(value);
const error = (code, message = "fixture secret must not escape") =>
  Object.assign(new Error(message), { code });
const code = (expected) => (value) => value.code === expected;
const row = (modId, changes = {}) => ({
  modId: String(modId),
  game: "hoi4",
  displayName: `Mod ${modId}`,
  preferredVersion: null,
  latestVersion: 12,
  ...changes,
});
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

function fixture() {
  const f = {
    current: "account-A",
    accountReads: 0,
    calls: [],
    writes: [],
    running: false,
    before: null,
    override: null,
    after: null,
    getAccountOverride: null,
    users: new Map([
      [
        "account-A",
        {
          sets: [
            {
              id: 77,
              game: "hoi4",
              owned: true,
              state: "private",
              preferredVersion: null,
            },
          ],
          items: [],
        },
      ],
      [
        "account-B",
        {
          sets: [
            {
              id: 88,
              game: "hoi4",
              owned: true,
              state: "private",
              preferredVersion: null,
            },
          ],
          items: [],
        },
      ],
    ]),
  };
  f.account = {
    async getAccount() {
      f.accountReads++;
      if (f.getAccountOverride) return f.getAccountOverride();
      return f.current
        ? {
            status: "signed-in",
            account: { id: f.current, displayName: "Same display name" },
          }
        : { status: "signed-out", account: null };
    },
    async request(input) {
      const call = { method: "GET", ...clone(input) };
      f.calls.push(call);
      await f.before?.(call);
      if (input.expectedAccountId !== f.current) throw error("ACCOUNT_CHANGED");
      const override = await f.override?.(call);
      let result;
      if (override) result = override.value;
      else {
        const user = f.users.get(f.current);
        if (call.path === "/mods" && call.method === "GET") {
          result = {
            result: "OK",
            modDetail: {
              modId: call.query.modId,
              game: "hoi4",
              displayName: `Mod ${call.query.modId}`,
              state: "published",
              isRegionBlocked: false,
              modVersion: call.query.modVersion || "12",
            },
          };
        } else if (call.path === "/mods/sets/list/hoi4")
          result = { result: "OK", sets: clone(user.sets) };
        else if (/^\/mods\/sets\/\d+\/mods$/.test(call.path)) {
          const offset = (call.query.page - 1) * call.query.limit;
          result = {
            result: "OK",
            count: user.items.length,
            mods: clone(user.items.slice(offset, offset + call.query.limit)),
          };
        } else if (call.path === "/mods/installed" && call.method === "POST") {
          f.writes.push(call);
          const mod = call.body.mods[0];
          if (!user.sets.length)
            user.sets.push({
              id: 77,
              game: "hoi4",
              owned: true,
              preferredVersion: null,
            });
          user.items = user.items.filter(
            (item) => item.modId !== String(mod.id),
          );
          user.items.push(
            row(mod.id, { preferredVersion: mod.version ?? null }),
          );
          result = { result: "OK", mods: [{ id: mod.id }] };
        } else if (
          call.path === "/mods/installed" &&
          call.method === "DELETE"
        ) {
          f.writes.push(call);
          user.items = user.items.filter(
            (item) => item.modId !== call.query.modId,
          );
          result = null;
        } else
          throw new Error(
            `Unexpected fixture request: ${call.method} ${call.path}`,
          );
      }
      await f.after?.(call, result);
      if (input.expectedAccountId !== f.current) throw error("CANCELLED");
      return result;
    },
  };
  f.service = createPdxSubscriptions({
    account: f.account,
    isGameRunning: async () => f.running,
  });
  f.user = f.users.get("account-A");
  return f;
}

test("construction is inert and signed-out reads never request subscriptions", async () => {
  const f = fixture();
  assert.equal(f.accountReads, 0);
  assert.equal(f.calls.length, 0);
  f.current = null;
  assert.deepEqual(await f.service.getState(), { accountId: null, items: [] });
  await assert.rejects(
    f.service.subscribe({ modId: "123" }),
    code("NOT_SIGNED_IN"),
  );
  assert.equal(f.calls.length, 0);
});

test("default set listing is one-based and finishes only on the empty page", async () => {
  const f = fixture();
  f.user.items = Array.from({ length: 201 }, (_, i) => row(i + 1));
  const state = await f.service.getState();
  assert.equal(state.accountId, "account-A");
  assert.equal(state.items.length, 201);
  const pages = f.calls.filter((call) => /\/mods$/.test(call.path));
  assert.deepEqual(
    pages.map((call) => call.query.page),
    [1, 2, 3, 4],
  );
  assert.ok(pages.every((call) => call.query.limit === 100));
  assert.ok(f.calls.every((call) => call.expectedAccountId === "account-A"));
  assert.deepEqual(f.calls[0].query, { includeShared: true });
  assert.deepEqual(state.items[0], { modId: "1", title: "Mod 1" });
});

test("only preferredVersion pins a subscription; latestVersion remains unpinned", async () => {
  const f = fixture();
  f.user.items = [
    row("1"),
    row("2", { preferredVersion: 7, displayName: "Pinned\u0000 title" }),
  ];
  assert.deepEqual((await f.service.getState()).items, [
    { modId: "1", title: "Mod 1" },
    { modId: "2", title: "Pinned  title", revision: "7" },
  ]);
});

test("only generated subscription titles are marked for interface localization", async () => {
  const f = fixture();
  f.user.items = [
    row("1", { displayName: "\u0000  " }),
    row("2", { displayName: "Paradox 模组 2" }),
  ];
  assert.deepEqual((await f.service.getState()).items, [
    { modId: "1", title: "Paradox 模组 1", titleIsFallback: true },
    { modId: "2", title: "Paradox 模组 2" },
  ]);
});

test("older list rows without game are verified through HOI4 metadata", async () => {
  const f = fixture();
  f.user.items = [row("1", { game: undefined })];
  assert.equal((await f.service.getState()).items.length, 1);
  assert.ok(
    f.calls.some((call) => call.path === "/mods" && call.query.modId === "1"),
  );
  const wrong = fixture();
  wrong.user.items = [row("1", { game: "stellaris" })];
  const result = await wrong.service.getState();
  assert.equal(result.error.code, "WRONG_GAME");
  assert.deepEqual(result.items, []);
});

test("no default set is empty on read and a user subscription omits activationSetId", async () => {
  const f = fixture();
  f.user.sets = [];
  assert.deepEqual(await f.service.getState(), {
    accountId: "account-A",
    items: [],
  });
  assert.equal(f.calls.length, 1);
  const state = await f.service.subscribe({ modId: "123" });
  assert.deepEqual(f.writes[0].body, { mods: [{ id: 123 }] });
  assert.equal(state.items[0].modId, "123");
  assert.equal(
    f.calls.some((call) => call.path === "/mods/sets"),
    false,
  );
});

test("multiple or shared-only sets are not guessed as a default", async () => {
  for (const sets of [
    [{ id: 1 }, { id: 2 }],
    [{ id: 1, owned: false }],
    [{ id: 1, state: "removedByUser" }],
  ]) {
    const f = fixture();
    f.user.sets = sets;
    assert.equal(
      (await f.service.getState()).error.code,
      "DEFAULT_SET_UNAVAILABLE",
    );
    await assert.rejects(
      f.service.subscribe({ modId: "123" }),
      code("DEFAULT_SET_UNAVAILABLE"),
    );
    assert.equal(f.writes.length, 0);
  }
});

test("subscribe validates the game, requests the selected version and uses the actual set", async () => {
  const f = fixture();
  const state = await f.service.subscribe({ modId: 123, revision: "5" });
  assert.equal(state.items[0].revision, "5");
  assert.deepEqual(f.calls[0].query, { modId: "123", modVersion: "5" });
  assert.deepEqual(f.writes[0].body, {
    activationSetId: 77,
    mods: [{ id: 123, version: 5 }],
  });
  const wrong = fixture();
  wrong.override = (call) =>
    call.path === "/mods"
      ? {
          value: {
            result: "OK",
            modDetail: { modId: "123", game: "stellaris" },
          },
        }
      : null;
  await assert.rejects(
    wrong.service.subscribe({ modId: "123" }),
    code("WRONG_GAME"),
  );
  assert.equal(wrong.writes.length, 0);
});

test("a requested revision must be explicitly authorized and returned by metadata", async () => {
  for (const kind of ["denied", "different"]) {
    const f = fixture();
    f.override = (call) => {
      if (call.path !== "/mods") return null;
      if (kind === "denied") throw error("ACCESS_DENIED");
      return {
        value: {
          result: "OK",
          modDetail: { modId: "123", game: "hoi4", modVersion: "12" },
        },
      };
    };
    await assert.rejects(
      f.service.subscribe({ modId: "123", revision: "5" }),
      code(kind === "denied" ? "ACCESS_DENIED" : "INVALID_RESPONSE"),
    );
    assert.equal(f.writes.length, 0);
  }
});

test("unsubscribe accepts a 204 result and does not alter local files or installs", async () => {
  const f = fixture();
  f.user.items = [row("123")];
  const state = await f.service.unsubscribe("123");
  assert.deepEqual(state, { accountId: "account-A", items: [] });
  assert.deepEqual(f.writes[0].query, { modId: "123", activationSetId: "77" });
  assert.equal(f.writes[0].method, "DELETE");
});

test("already desired membership avoids duplicate writes and unpinning omits version", async () => {
  const f = fixture();
  f.user.items = [row("123")];
  await f.service.subscribe({ modId: "123" });
  await f.service.unsubscribe("456");
  assert.equal(f.writes.length, 0);
  f.user.items[0].preferredVersion = "3";
  await f.service.subscribe({ modId: "123" });
  assert.deepEqual(f.writes[0].body.mods, [{ id: 123 }]);
});

test("queued duplicate mutations share successful results without replaying a write", async () => {
  const f = fixture();
  const results = await Promise.all([
    f.service.subscribe({ modId: "123" }),
    f.service.subscribe({ modId: "123" }),
    f.service.subscribe({ modId: "123" }),
  ]);
  assert.equal(f.writes.length, 1);
  assert.deepEqual(results[0], results[1]);
  assert.deepEqual(results[0], results[2]);
  results[0].items[0].title = "caller mutation";
  assert.equal(results[1].items[0].title, "Mod 123");
});

test("confirmed writes followed by refresh failure remain confirmed and are never replayed", async () => {
  const f = fixture();
  f.override = (call) => {
    if (f.writes.length && call.path === "/mods/sets/list/hoi4")
      throw error("NETWORK_ERROR");
  };
  const [state, duplicate] = await Promise.all([
    f.service.subscribe({ modId: "123" }),
    f.service.subscribe({ modId: "123" }),
  ]);
  assert.equal(f.writes.length, 1);
  assert.equal(state.error.code, "REFRESH_FAILED_AFTER_WRITE");
  assert.equal(state.error.writeSucceeded, true);
  assert.deepEqual(state.items, []);
  assert.deepEqual(state, duplicate);
  assert.equal(state.error.message.includes("secret"), false);
});

test("a lost write response is unknown, with no automatic retry or stale list", async () => {
  const f = fixture();
  f.after = (call) => {
    if (call.method === "POST") throw error("TIMEOUT");
  };
  const [state, duplicate] = await Promise.all([
    f.service.subscribe({ modId: "123" }),
    f.service.subscribe({ modId: "123" }),
  ]);
  assert.equal(state.error.code, "MUTATION_UNKNOWN");
  assert.equal(state.error.outcomeUnknown, true);
  assert.deepEqual(state, duplicate);
  assert.equal(f.writes.length, 1);
  f.after = null;
  assert.equal(
    (await f.service.getState({ refresh: true })).items[0].modId,
    "123",
  );
  assert.equal(f.writes.length, 1);
});

test("explicit server failure never becomes a successful or empty subscription list", async () => {
  const f = fixture();
  f.override = (call) =>
    call.method === "POST"
      ? { value: { result: "Failure", message: "fixture secret" } }
      : null;
  await assert.rejects(
    f.service.subscribe({ modId: "123" }),
    code("REQUEST_REJECTED"),
  );
  const list = fixture();
  list.override = () => ({ value: { result: "Failure", sets: [] } });
  assert.equal((await list.service.getState()).error.code, "REQUEST_REJECTED");
});

test("unrecognized successful write responses are reported unknown rather than retried", async () => {
  const f = fixture();
  f.override = (call) =>
    call.method === "POST"
      ? { value: { result: "OK", mods: [{ id: 456 }] } }
      : null;
  const state = await f.service.subscribe({ modId: "123" });
  assert.equal(state.error.outcomeUnknown, true);
  assert.equal(f.calls.filter((call) => call.method === "POST").length, 1);
});

test("server visibility lag preserves the acknowledged write warning in cached reads", async () => {
  const f = fixture();
  f.after = (call) => {
    if (call.method === "POST") f.user.items = [];
  };
  const state = await f.service.subscribe({ modId: "123" });
  assert.equal(state.error.code, "WRITE_NOT_YET_VISIBLE");
  assert.equal(state.error.writeSucceeded, true);
  assert.equal(
    (await f.service.getState()).error.code,
    "WRITE_NOT_YET_VISIBLE",
  );
  assert.equal(f.writes.length, 1);
});

test("switching accounts replaces cached lists despite identical display names", async () => {
  const f = fixture();
  f.user.items = [row("1")];
  f.users.get("account-B").items = [row("2")];
  assert.equal((await f.service.getState()).items[0].modId, "1");
  f.current = "account-B";
  const state = await f.service.getState();
  assert.equal(state.accountId, "account-B");
  assert.equal(state.items[0].modId, "2");
});

test("a switch immediately before the write is rejected by expectedAccountId", async () => {
  const f = fixture();
  f.before = (call) => {
    if (call.method === "POST") f.current = "account-B";
  };
  await assert.rejects(
    f.service.subscribe({ modId: "123" }),
    code("ACCOUNT_CHANGED"),
  );
  assert.equal(f.writes.length, 0);
  assert.deepEqual(f.users.get("account-B").items, []);
});

test("queued writes retain the calling account and cannot migrate to a newly logged-in account", async () => {
  const f = fixture();
  const entered = deferred(),
    release = deferred();
  f.before = async (call) => {
    if (call.path === "/mods" && call.query.modId === "1") {
      entered.resolve();
      await release.promise;
    }
  };
  const first = f.service.subscribe({ modId: "1" });
  await entered.promise;
  const second = f.service.subscribe({ modId: "2" });
  f.current = "account-B";
  release.resolve();
  const results = await Promise.allSettled([first, second]);
  assert.ok(
    results.every(
      (result) =>
        result.status === "rejected" &&
        result.reason.code === "ACCOUNT_CHANGED",
    ),
  );
  assert.equal(f.writes.length, 0);
});

test("account changes during list refresh cannot expose the previous user's subscriptions", async () => {
  const f = fixture();
  f.user.items = [row("123")];
  f.after = (call) => {
    if (/\/mods$/.test(call.path)) f.current = "account-B";
  };
  const state = await f.service.getState();
  assert.equal(state.accountId, null);
  assert.deepEqual(state.items, []);
  assert.equal(state.error.code, "ACCOUNT_CHANGED");
});

test("account changes after an acknowledged write preserve success but clear the list", async () => {
  const f = fixture();
  f.before = (call) => {
    if (f.writes.length && call.path === "/mods/sets/list/hoi4")
      f.current = "account-B";
  };
  const state = await f.service.subscribe({ modId: "123" });
  assert.equal(state.error.code, "ACCOUNT_CHANGED_AFTER_WRITE");
  assert.equal(state.error.writeSucceeded, true);
  assert.equal(state.accountId, null);
  assert.deepEqual(state.items, []);
  assert.equal(f.users.get("account-A").items[0].modId, "123");
  assert.deepEqual(f.users.get("account-B").items, []);
});

test("offline account verification drops cached data instead of guessing account ownership", async () => {
  const f = fixture();
  f.user.items = [row("123")];
  await f.service.getState();
  f.getAccountOverride = () => {
    throw error("NETWORK_ERROR");
  };
  const state = await f.service.getState();
  assert.equal(state.accountId, null);
  assert.deepEqual(state.items, []);
  assert.equal(state.error.message.includes("secret"), false);
});

test("malformed pagination, repeated pages and wrong-game fallback metadata fail closed", async () => {
  const cases = [
    () => ({ value: { mods: [row("1")], count: 10001 } }),
    () => ({ value: { mods: [row("1")] } }),
    () => ({ value: { mods: [row("1", { preferredVersion: undefined })] } }),
  ];
  for (const handler of cases) {
    const f = fixture();
    f.override = (call) => (/\/mods$/.test(call.path) ? handler(call) : null);
    const state = await f.service.getState();
    assert.equal(state.error.code, "INVALID_RESPONSE");
    assert.deepEqual(state.items, []);
    assert.ok(f.calls.length <= 3);
  }
  const f = fixture();
  f.user.items = [row("1", { game: undefined })];
  f.override = (call) =>
    call.path === "/mods"
      ? { value: { result: "OK", modDetail: { modId: "1", game: "vic3" } } }
      : null;
  assert.equal((await f.service.getState()).error.code, "WRONG_GAME");
});

test("game guard prevents writes both before metadata and immediately before sending", async () => {
  const f = fixture();
  f.running = true;
  await assert.rejects(
    f.service.subscribe({ modId: "123" }),
    code("GAME_RUNNING"),
  );
  assert.equal(f.calls.length, 0);
  f.running = false;
  f.after = (call) => {
    if (/\/mods$/.test(call.path)) f.running = true;
  };
  await assert.rejects(
    f.service.subscribe({ modId: "123" }),
    code("GAME_RUNNING"),
  );
  assert.equal(f.writes.length, 0);
});

test("invalid input never contacts account services and unsupported status never writes", async () => {
  const f = fixture();
  for (const input of [
    null,
    {},
    { modId: "../1" },
    { modId: "1", activationSetId: "99" },
    { modId: "1", revision: "latest" },
  ])
    await assert.rejects(f.service.subscribe(input), code("INVALID_INPUT"));
  await assert.rejects(f.service.unsubscribe("01"), code("INVALID_INPUT"));
  await assert.rejects(
    f.service.getState({ refresh: "yes" }),
    code("INVALID_INPUT"),
  );
  assert.equal(f.accountReads, 0);
  f.override = (call) =>
    call.path === "/mods"
      ? { value: { modDetail: { modId: "1", game: "hoi4", state: "draft" } } }
      : null;
  await assert.rejects(
    f.service.subscribe({ modId: "1" }),
    code("UNAVAILABLE"),
  );
  assert.equal(f.writes.length, 0);
});

test("opposite queued actions preserve order and are not collapsed into an earlier write", async () => {
  const f = fixture();
  const results = await Promise.all([
    f.service.subscribe({ modId: "123" }),
    f.service.unsubscribe("123"),
    f.service.subscribe({ modId: "123" }),
  ]);
  assert.deepEqual(
    f.writes.map((call) => call.method),
    ["POST", "DELETE", "POST"],
  );
  assert.equal(results[0].items.length, 1);
  assert.equal(results[1].items.length, 0);
  assert.equal(results[2].items.length, 1);
});

test("queued copies of an explicitly rejected write are not retried", async () => {
  const f = fixture();
  f.override = (call) => {
    if (call.method === "POST") throw error("REQUEST_FAILED");
  };
  const results = await Promise.allSettled([
    f.service.subscribe({ modId: "123" }),
    f.service.subscribe({ modId: "123" }),
  ]);
  assert.ok(
    results.every(
      (result) =>
        result.status === "rejected" &&
        result.reason.code === "REQUEST_REJECTED",
    ),
  );
  assert.equal(f.calls.filter((call) => call.method === "POST").length, 1);
});
