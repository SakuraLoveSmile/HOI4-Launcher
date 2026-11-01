"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createModCatalogService } = require("../electron/mod-catalog.cjs");
const { original } = require("../electron/diagnostic-message.cjs");
const i18n = import("../src/i18n-core.mjs");
const NOW = Date.UTC(2026, 9, 28, 12);
const mod = (patch = {}) => ({
  modId: "123",
  displayName: "Test mod",
  author: "Mod author",
  requiredVersion: "1.19.*",
  shortDescription: "A new campaign",
  game: "hoi4",
  state: "published",
  displayImagePath:
    "https://modscontent.paradox-interactive.com/hoi4/abc-123/content/cover.jpg",
  ...patch,
});
const response = (mods = [mod()], totalCount = mods.length) =>
  new Response(JSON.stringify({ mods, totalCount, result: "OK" }), {
    status: 200,
  });

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ironclad-catalog-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, cachePath: path.join(root, "catalog.json") };
}

test("search uses the confirmed anonymous searchQuery and pagination contract", async () => {
  const calls = [];
  const service = createModCatalogService({
    now: () => NOW,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response([mod()], 668);
    },
  });
  const result = await service.search({
    query: " Kaiserreich ",
    sort: "best",
    page: 1,
  });
  assert.equal(calls[0].url, "https://api.paradox-interactive.com/mods");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    gameNames: ["hoi4"],
    orderBy: "desc",
    sortBy: "best",
    pageSize: 12,
    page: 1,
    states: ["published"],
    searchQuery: "Kaiserreich",
    time: "quarter",
  });
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.credentials, "omit");
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(calls[0].options.headers.Authorization, undefined);
  assert.equal(result.source, "live");
  assert.equal(result.page, 1);
  assert.equal(result.pageSize, 12);
  assert.equal(result.totalPages, 56);
});

test("recent maps to updated without the best-quarter time filter", async () => {
  let body;
  await createModCatalogService({
    now: () => NOW,
    fetchImpl: async (_url, options) => {
      body = JSON.parse(options.body);
      return response();
    },
  }).search({ sort: "recent" });
  assert.equal(body.sortBy, "updated");
  assert.equal(body.orderBy, "desc");
  assert.equal(body.time, undefined);
  assert.equal(body.searchQuery, undefined);
});

test("item text is plain and detail links are constructed from numeric IDs", async () => {
  const result = await createModCatalogService({
    now: () => NOW,
    fetchImpl: async () =>
      response([
        mod({
          displayName: "<b>中文 &amp; Mod</b>",
          shortDescription:
            "<script>bad()</script>[url=https://evil.invalid/]Hello[/url] <b>World</b> " +
            "long ".repeat(100),
          url: "https://evil.invalid/",
        }),
      ]),
  }).search();
  assert.equal(result.items[0].name, "中文 & Mod");
  assert.equal(
    result.items[0].url,
    "https://mods.paradoxplaza.com/mods/123/Any",
  );
  assert.ok(result.items[0].description.startsWith("Hello World"));
  assert.ok(result.items[0].description.length <= 350);
  assert.doesNotMatch(result.items[0].description, /script|https:|<|\[/);
});

test("unsafe image URLs become null and other games or unpublished items are omitted", async () => {
  const hostile = [
    "javascript:alert(1)",
    "https://evil.invalid/cover.jpg",
    "https://modscontent.paradox-interactive.com.evil.invalid/hoi4/a/content/a.jpg",
    "https://user:pass@modscontent.paradox-interactive.com/hoi4/a/content/a.jpg",
    "https://modscontent.paradox-interactive.com/hoi4/a/content/a.svg",
    "https://modscontent.paradox-interactive.com/stellaris/a/content/a.jpg",
  ];
  const items = hostile.map((displayImagePath, index) =>
    mod({ modId: String(index + 1), displayImagePath }),
  );
  items.push(
    mod({ modId: "10", game: "stellaris" }),
    mod({ modId: "11", state: "rejected" }),
    mod({ modId: "../12" }),
  );
  const result = await createModCatalogService({
    now: () => NOW,
    fetchImpl: async () => response(items),
  }).search();
  assert.equal(result.items.length, hostile.length);
  assert.ok(result.items.every((item) => item.thumbnailUrl === null));
});

test("input limits reject without contacting a remote endpoint", async () => {
  let calls = 0;
  const service = createModCatalogService({
    fetchImpl: async () => {
      calls++;
      return response();
    },
  });
  for (const input of [
    null,
    [],
    { query: "x".repeat(121) },
    { query: "a\nb" },
    { query: {} },
    { page: -1 },
    { page: 10001 },
    { page: 1.2 },
    { sort: "unknown" },
    { token: "should not be sent" },
  ]) {
    const result = await service.search(input);
    assert.equal(result.source, "unavailable");
    assert.ok(result.error);
  }
  assert.equal(calls, 0);
});

test("valid empty and out-of-range pages return empty live results", async () => {
  const empty = await createModCatalogService({
    now: () => NOW,
    fetchImpl: async () => response([], 0),
  }).search({ query: "nothing" });
  assert.equal(empty.source, "live");
  assert.equal(empty.totalPages, 0);
  assert.equal(empty.error, null);
  const beyond = await createModCatalogService({
    now: () => NOW,
    fetchImpl: async () => response([], 1),
  }).search({ page: 3 });
  assert.equal(beyond.source, "live");
  assert.equal(beyond.page, 3);
  assert.equal(beyond.totalPages, 1);
});

test("cache keys separate query, sort and page and expire after fifteen minutes", async (t) => {
  const f = await fixture(t);
  let now = NOW,
    calls = 0;
  const service = createModCatalogService({
    cachePath: f.cachePath,
    now: () => now,
    fetchImpl: async () => {
      calls++;
      return response([mod()], 100);
    },
  });
  await service.search({ query: "one" });
  assert.equal((await service.search({ query: "one" })).source, "cache");
  await service.search({ query: "two" });
  await service.search({ query: "one", sort: "recent" });
  await service.search({ query: "one", page: 1 });
  assert.equal(calls, 4);
  now += 15 * 60 * 1000;
  assert.equal((await service.search({ query: "one" })).source, "live");
  assert.equal(calls, 5);
});

test("offline fallback uses only an exact matching query and persists across restarts", async (t) => {
  const f = await fixture(t);
  await createModCatalogService({
    cachePath: f.cachePath,
    now: () => NOW,
    fetchImpl: async () => response(),
  }).search({ query: "one" });
  const original = await fs.readFile(f.cachePath, "utf8");
  const offline = createModCatalogService({
    cachePath: f.cachePath,
    now: () => NOW + 86400000,
    fetchImpl: async () => {
      throw new Error("private system detail");
    },
  });
  const same = await offline.search({ query: "one" });
  assert.equal(same.source, "cache");
  assert.match(same.error, /该查询/);
  assert.doesNotMatch(same.error, /private/);
  for (const input of [
    { query: "two" },
    { query: "one", page: 1 },
    { query: "one", sort: "recent" },
  ]) {
    const result = await offline.search(input);
    assert.equal(result.source, "unavailable");
    assert.deepEqual(result.items, []);
  }
  assert.equal(await fs.readFile(f.cachePath, "utf8"), original);
});

test("concurrent distinct queries survive atomic disk cache writes", async (t) => {
  const f = await fixture(t);
  const service = createModCatalogService({
    cachePath: f.cachePath,
    now: () => NOW,
    fetchImpl: async () => response(),
  });
  await Promise.all([
    service.search({ query: "one" }),
    service.search({ query: "two" }),
  ]);
  const data = JSON.parse(await fs.readFile(f.cachePath, "utf8"));
  assert.equal(data.entries.length, 2);
  assert.deepEqual((await fs.readdir(f.root)).sort(), ["catalog.json"]);
});

test("same in-flight query is shared and caller results cannot alter the cache", async () => {
  let calls = 0,
    release;
  const ready = new Promise((resolve) => {
    release = resolve;
  });
  const service = createModCatalogService({
    now: () => NOW,
    fetchImpl: async () => {
      calls++;
      await ready;
      return response();
    },
  });
  const a = service.search(),
    b = service.search();
  release();
  const [first, second] = await Promise.all([a, b]);
  assert.equal(calls, 1);
  first.items[0].name = "changed";
  assert.notEqual(second.items[0].name, "changed");
  assert.notEqual((await service.search()).items[0].name, "changed");
});

test("malformed shape, result errors and oversized payloads are unavailable", async () => {
  for (const makeResponse of [
    () => new Response("bad json"),
    () =>
      new Response(
        JSON.stringify({ result: "Failure", totalCount: 0, mods: [] }),
      ),
    () =>
      new Response(JSON.stringify({ result: "OK", totalCount: -1, mods: [] })),
    () => response(Array(13).fill(mod()), 13),
    () => new Response("{}", { headers: { "content-length": "999999999" } }),
    () => new Response("x".repeat(1024 * 1024 + 1)),
  ]) {
    const result = await createModCatalogService({
      now: () => NOW,
      fetchImpl: async () => makeResponse(),
    }).search();
    assert.equal(result.source, "unavailable");
    assert.ok(result.error);
  }
});

test("hostile cache records cannot supply unrelated or unsafe links", async (t) => {
  const f = await fixture(t);
  const entry = {
    request: { query: "safe", sort: "best", page: 0 },
    fetchedAt: new Date(NOW).toISOString(),
    totalCount: 1,
    items: [
      {
        id: "123",
        name: "Unsafe",
        author: "a",
        requiredVersion: "1.19.*",
        description: "bad",
        url: "https://evil.invalid/",
        thumbnailUrl: null,
      },
    ],
  };
  await fs.writeFile(
    f.cachePath,
    JSON.stringify({
      version: 1,
      game: "hoi4",
      pageSize: 12,
      entries: [entry],
    }),
  );
  const result = await createModCatalogService({
    cachePath: f.cachePath,
    now: () => NOW,
    fetchImpl: async () => {
      throw new Error("offline");
    },
  }).search({ query: "safe" });
  assert.equal(result.source, "unavailable");
  assert.deepEqual(result.items, []);
});

test("cache is bounded to the twenty newest query pages", async (t) => {
  const f = await fixture(t);
  let now = NOW;
  const service = createModCatalogService({
    cachePath: f.cachePath,
    now: () => now++,
    fetchImpl: async () => response(),
  });
  for (let index = 0; index < 22; index++)
    await service.search({ query: "query" + index });
  const cache = JSON.parse(await fs.readFile(f.cachePath, "utf8"));
  assert.equal(cache.entries.length, 20);
  assert.ok(!cache.entries.some((entry) => entry.request.query === "query0"));
  assert.ok(cache.entries.some((entry) => entry.request.query === "query21"));
});

test("eight-second deadline aborts an unresponsive service without rejecting search", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let begin, signal;
  const started = new Promise((resolve) => {
    begin = resolve;
  });
  const service = createModCatalogService({
    now: () => NOW,
    fetchImpl: (_url, options) => {
      signal = options.signal;
      begin();
      return new Promise(() => {});
    },
  });
  const pending = service.search();
  await started;
  t.mock.timers.tick(8000);
  const result = await pending;
  assert.equal(signal.aborted, true);
  assert.equal(result.source, "unavailable");
  assert.match(result.error, /超时/);
});

test("cache write errors do not discard successful live results", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(f.cachePath);
  const result = await createModCatalogService({
    cachePath: f.cachePath,
    now: () => NOW,
    fetchImpl: async () => response(),
  }).search();
  assert.equal(result.source, "live");
  assert.match(result.error, /缓存/);
  assert.equal(result.items.length, 1);
});

test("a timed out catalog query carries nested diagnostics and preserves cached user and remote text", async (t) => {
  const f = await fixture(t),
    literal = "设置 {0} C:\\用户\\总览，读取 Paradox Mods 超时，请稍后重试。",
    query = "设置 {1}，但总览";
  const live = await createModCatalogService({
    cachePath: f.cachePath,
    now: () => NOW,
    fetchImpl: async () =>
      response([mod({ displayName: literal, shortDescription: literal })]),
  }).search({ query });
  assert.equal(Object.hasOwn(live, "errorDiagnostic"), false);
  const saved = await fs.readFile(f.cachePath, "utf8");
  assert.equal(saved.includes("errorDiagnostic"), false);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let start, signal;
  const started = new Promise((resolve) => {
    start = resolve;
  });
  const pending = createModCatalogService({
    cachePath: f.cachePath,
    now: () => NOW + 86400000,
    fetchImpl: (_url, options) => {
      signal = options.signal;
      start();
      return new Promise(() => {});
    },
  }).search({ query });
  await started;
  t.mock.timers.tick(8000);
  const result = await pending,
    { formatDiagnostic } = await i18n;
  assert.equal(signal.aborted, true);
  assert.equal(result.source, "cache");
  assert.equal(result.errorDiagnostic.key, "{0} 当前显示该查询的上次缓存。");
  assert.equal(
    result.errorDiagnostic.values[0].key,
    "读取 Paradox Mods 超时，请稍后重试。",
  );
  assert.equal(original(result.errorDiagnostic), result.error);
  assert.equal(
    formatDiagnostic("en", result.errorDiagnostic),
    "Reading Paradox Mods timed out. Try again later. Showing the previous cached results for this query.",
  );
  assert.equal(result.items[0].name, literal);
  assert.equal(result.items[0].description, literal);
  assert.equal(await fs.readFile(f.cachePath, "utf8"), saved);
});

test("catalog HTTP and parse failures expose explicit serializable metadata without response text", async () => {
  const { formatDiagnostic } = await i18n;
  for (const [reply, key, english] of [
    [
      new Response("private response", { status: 503 }),
      "Paradox Mods 暂不可用（HTTP {0}）。",
      "Paradox Mods is temporarily unavailable (HTTP 503).",
    ],
    [
      new Response("private malformed JSON"),
      "无法解析 Paradox Mods 目录数据。",
      "Unable to parse Paradox Mods catalog data.",
    ],
  ]) {
    const result = await createModCatalogService({
      now: () => NOW,
      fetchImpl: async () => reply,
    }).search();
    assert.equal(result.source, "unavailable");
    assert.equal(result.errorDiagnostic.key, key);
    assert.equal(original(result.errorDiagnostic), result.error);
    assert.equal(
      formatDiagnostic(
        "en",
        JSON.parse(JSON.stringify(result.errorDiagnostic)),
      ),
      english,
    );
    assert.doesNotMatch(
      JSON.stringify(result),
      /private response|private malformed/,
    );
  }
});

test("raw catalog fetch and stream errors cannot impersonate application diagnostic metadata", async () => {
  const raw = () =>
    Object.assign(new Error("private source 设置 {0}"), {
      catalogMessage: "读取 Paradox Mods 超时，请稍后重试。",
      diagnostic: { kind: "message", key: "设置", values: [] },
    });
  for (const fetchImpl of [
    async () => {
      throw raw();
    },
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(raw());
          },
        }),
      ),
  ]) {
    const result = await createModCatalogService({
      now: () => NOW,
      fetchImpl,
    }).search();
    assert.equal(
      result.errorDiagnostic.key,
      "暂时无法连接 Paradox Mods，请检查网络或稍后重试。",
    );
    assert.equal(original(result.errorDiagnostic), result.error);
    assert.doesNotMatch(
      JSON.stringify(result),
      /private source|"key":"设置"|catalogMessage/,
    );
  }
});
