"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createNewsService } = require("../electron/news-service.cjs");
const { original } = require("../electron/diagnostic-message.cjs");
const i18n = import("../src/i18n-core.mjs");

const NOW = Date.UTC(2026, 9, 28, 12);
const announcement = (patch = {}) => ({
  gid: "1234567890123456789",
  title: "Official HOI4 News",
  contents: "A new campaign begins.",
  url: "https://store.steampowered.com/news/app/394360/view/1234567890123456789",
  date: NOW / 1000 - 3600,
  feedname: "steam_community_announcements",
  appid: 394360,
  ...patch,
});
const response = (items = [announcement()]) =>
  new Response(
    JSON.stringify({ appnews: { appid: 394360, newsitems: items } }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ironclad-news-"));
  t.after(() =>
    fs.rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    }),
  );
  const cachePath = path.join(root, "launcher", "news.json");
  const write = async (content) => {
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    await fs.writeFile(cachePath, content);
  };
  return { root, cachePath, write };
}

test("fetches only public HOI4 official announcements and saves a local cache", async (t) => {
  const f = await fixture(t);
  const calls = [];
  const service = createNewsService({
    cachePath: f.cachePath,
    now: () => NOW,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response();
    },
  });
  const result = await service.getNews();
  assert.equal(result.source, "live");
  assert.equal(result.items.length, 1);
  assert.equal(result.fetchedAt, new Date(NOW).toISOString());
  assert.equal(result.error, null);
  const url = new URL(calls[0].url);
  assert.equal(url.hostname, "api.steampowered.com");
  assert.equal(url.searchParams.get("appid"), "394360");
  assert.equal(url.searchParams.get("feeds"), "steam_community_announcements");
  assert.equal(url.searchParams.get("count"), "6");
  assert.equal(calls[0].options.redirect, "error");
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.equal(
    JSON.parse(await fs.readFile(f.cachePath, "utf8")).appId,
    394360,
  );
  assert.deepEqual((await fs.readdir(path.dirname(f.cachePath))).sort(), [
    "news.json",
  ]);
});

test("fresh cache avoids network, refresh bypasses it, and stale cache revalidates", async (t) => {
  const f = await fixture(t);
  let now = NOW,
    calls = 0;
  const service = createNewsService({
    cachePath: f.cachePath,
    now: () => now,
    fetchImpl: async () => {
      calls++;
      return response();
    },
  });
  await service.getNews();
  now += 15 * 60 * 1000 - 1;
  assert.equal((await service.getNews()).source, "cache");
  assert.equal(calls, 1);
  now++;
  assert.equal((await service.getNews()).source, "live");
  assert.equal(calls, 2);
  await service.getNews({ refresh: true });
  assert.equal(calls, 3);
});

test("cache persists across services and caller mutation cannot alter it", async (t) => {
  const f = await fixture(t);
  const first = createNewsService({
    cachePath: f.cachePath,
    now: () => NOW,
    fetchImpl: async () => response(),
  });
  const live = await first.getNews();
  live.items[0].url = "https://evil.invalid/";
  assert.match(
    (await first.getNews()).items[0].url,
    /^https:\/\/store.steampowered.com\//,
  );
  const second = createNewsService({
    cachePath: f.cachePath,
    now: () => NOW,
    fetchImpl: async () => {
      throw new Error("must not fetch");
    },
  });
  const result = await second.getNews();
  assert.equal(result.source, "cache");
  assert.equal(result.error, null);
});

test("offline requests return stale trusted cache with a useful reason", async (t) => {
  const f = await fixture(t);
  await createNewsService({
    cachePath: f.cachePath,
    now: () => NOW,
    fetchImpl: async () => response(),
  }).getNews();
  const original = await fs.readFile(f.cachePath, "utf8");
  const result = await createNewsService({
    cachePath: f.cachePath,
    now: () => NOW + 2 * 86400000,
    fetchImpl: async () => {
      throw new Error("raw local network secret");
    },
  }).getNews();
  assert.equal(result.source, "cache");
  assert.equal(result.items.length, 1);
  assert.match(result.error, /上次缓存/);
  assert.doesNotMatch(result.error, /secret/);
  assert.equal(await fs.readFile(f.cachePath, "utf8"), original);
});

test("first-run network errors return unavailable without creating cache files", async (t) => {
  const f = await fixture(t);
  const result = await createNewsService({
    cachePath: f.cachePath,
    now: () => NOW,
    fetchImpl: async () => {
      throw new Error("offline");
    },
  }).getNews();
  assert.deepEqual(result.items, []);
  assert.equal(result.source, "unavailable");
  assert.equal(result.fetchedAt, null);
  assert.match(result.error, /网络|连接/);
  await assert.rejects(fs.stat(f.cachePath), { code: "ENOENT" });
});

test("HTML and BBCode become bounded plain text with media and scripts removed", async (t) => {
  const f = await fixture(t);
  const item = announcement({
    title: "&lt;b&gt;更新 &amp; 公告&lt;/b&gt;",
    contents:
      "<script>evil()</script><style>.bad{}</style>[h1]Hello[/h1] [url=https://evil.invalid/]label[/url] [img]{STEAM_CLAN_IMAGE}/payload.jpg[/img] <b>World</b> &#x1f389; " +
      "long ".repeat(100),
  });
  const result = await createNewsService({
    cachePath: f.cachePath,
    now: () => NOW,
    fetchImpl: async () => response([item]),
  }).getNews();
  assert.equal(result.items[0].title, "更新 & 公告");
  assert.ok(result.items[0].excerpt.startsWith("Hello label World 🎉"));
  assert.ok(result.items[0].excerpt.length <= 350);
  assert.doesNotMatch(
    result.items[0].excerpt,
    /evil|script|payload|\[|<|https:/,
  );
});

test("untrusted hosts, protocols, credentials and redirect routes are rejected", async (t) => {
  const f = await fixture(t);
  const hostile = [
    "javascript:alert(1)",
    "file:///C:/secret",
    "https://evil.invalid/news",
    "https://store.steampowered.com.evil.invalid/news/app/394360/view/1",
    "https://user:pass@store.steampowered.com/news/app/394360/view/1",
    "https://store.steampowered.com:8443/news/app/394360/view/1",
    "https://steamcommunity.com/linkfilter/?url=https://evil.invalid/",
    "https://store.steampowered.com/news/app/730/view/1",
    "https://forum.paradoxplaza.com/forum/redirect?url=evil",
  ];
  const items = hostile.map((url, index) =>
    announcement({ gid: String(index + 1), url }),
  );
  items.push(
    announcement({
      gid: "999",
      url: "http://store.steampowered.com/news/externalpost/steam_community_announcements/999?redirect=https://evil.invalid/#x",
    }),
  );
  const result = await createNewsService({
    cachePath: f.cachePath,
    now: () => NOW,
    fetchImpl: async () => response(items),
  }).getNews();
  assert.equal(result.items.length, 1);
  assert.equal(
    result.items[0].url,
    "https://store.steampowered.com/news/externalpost/steam_community_announcements/999",
  );
});

test("official community and Paradox article destinations are accepted without queries", async (t) => {
  const f = await fixture(t);
  const urls = [
    "https://steamcommunity.com/games/394360/announcements/detail/123",
    "https://steamcommunity.com/ogg/394360/announcements/detail/124",
    "https://steamstore-a.akamaihd.net/news/externalpost/steam_community_announcements/125",
    "https://www.paradoxinteractive.com/games/hearts-of-iron-iv/news/developer-diary",
    "https://forum.paradoxplaza.com/forum/developer-diary/hoi4-dev-diary.1234567/?ref=test",
  ];
  const result = await createNewsService({
    cachePath: f.cachePath,
    now: () => NOW,
    fetchImpl: async () =>
      response(
        urls.map((url, index) => announcement({ gid: String(index + 1), url })),
      ),
  }).getNews();
  assert.equal(result.items.length, urls.length);
  assert.ok(result.items.every((item) => !item.url.includes("?")));
  assert.equal(
    result.items[2].url,
    "https://store.steampowered.com/news/externalpost/steam_community_announcements/125",
  );
});

test("wrong games, unrelated feeds, future dates and duplicate ids do not become articles", async (t) => {
  const f = await fixture(t);
  const items = [
    announcement(),
    announcement(),
    announcement({ gid: "2", appid: 730 }),
    announcement({ gid: "3", feedname: "pcgamer" }),
    announcement({ gid: "4", date: NOW / 1000 + 86400000 }),
    announcement({ gid: "5", title: "<script>empty</script>" }),
  ];
  const result = await createNewsService({
    cachePath: f.cachePath,
    now: () => NOW,
    fetchImpl: async () => response(items),
  }).getNews();
  assert.equal(result.items.length, 1);
  const wrongGame = createNewsService({
    cachePath: path.join(f.root, "wrong.json"),
    now: () => NOW,
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          appnews: { appid: 730, newsitems: [announcement()] },
        }),
      ),
  });
  assert.equal((await wrongGame.getNews()).source, "unavailable");
});

test("latest six trustworthy items are returned in descending date order", async (t) => {
  const f = await fixture(t);
  const items = Array.from({ length: 10 }, (_, index) =>
    announcement({
      gid: String(index + 1),
      date: NOW / 1000 - index * 100,
      title: "News " + index,
    }),
  );
  const result = await createNewsService({
    cachePath: f.cachePath,
    now: () => NOW,
    fetchImpl: async () => response(items.reverse()),
  }).getNews();
  assert.equal(result.items.length, 6);
  assert.deepEqual(
    result.items.map((item) => item.id),
    ["1", "2", "3", "4", "5", "6"],
  );
});

test("content-length and streaming byte limits reject oversized responses", async (t) => {
  const f = await fixture(t);
  for (const [index, fetchImpl] of [
    async () =>
      new Response("{}", { headers: { "content-length": "9999999" } }),
    async () => new Response("x".repeat(512 * 1024 + 1)),
  ].entries()) {
    const result = await createNewsService({
      cachePath: path.join(f.root, index + ".json"),
      now: () => NOW,
      fetchImpl,
    }).getNews();
    assert.equal(result.source, "unavailable");
    assert.match(result.error, /大小限制/);
  }
});

test("invalid cache contents are not trusted while offline", async (t) => {
  const f = await fixture(t);
  for (const content of [
    "broken json",
    JSON.stringify({
      version: 1,
      appId: 730,
      fetchedAt: new Date(NOW).toISOString(),
      items: [],
    }),
    JSON.stringify({
      version: 1,
      appId: 394360,
      fetchedAt: new Date(NOW + 86400000).toISOString(),
      items: [],
    }),
    JSON.stringify({
      version: 1,
      appId: 394360,
      fetchedAt: new Date(NOW).toISOString(),
      items: [
        {
          id: "1",
          title: "Attack",
          excerpt: "bad",
          url: "https://evil.invalid/",
          date: new Date(NOW).toISOString(),
        },
      ],
    }),
  ]) {
    await f.write(content);
    const result = await createNewsService({
      cachePath: f.cachePath,
      now: () => NOW,
      fetchImpl: async () => {
        throw new Error("offline");
      },
    }).getNews();
    assert.equal(result.source, "unavailable");
    assert.deepEqual(result.items, []);
    assert.equal(await fs.readFile(f.cachePath, "utf8"), content);
  }
});

test("HTTP and abort failures become useful nonthrowing states", async (t) => {
  const f = await fixture(t);
  const http = await createNewsService({
    cachePath: f.cachePath,
    now: () => NOW,
    fetchImpl: async () => new Response("rate limited", { status: 429 }),
  }).getNews();
  assert.match(http.error, /HTTP 429/);
  const aborted = await createNewsService({
    cachePath: f.cachePath,
    now: () => NOW,
    fetchImpl: async () => {
      throw Object.assign(new Error("raw error"), { name: "AbortError" });
    },
  }).getNews();
  assert.match(aborted.error, /超时/);
});

test("simultaneous requests share one fetch and independent result objects", async (t) => {
  const f = await fixture(t);
  let calls = 0,
    release;
  const ready = new Promise((resolve) => {
    release = resolve;
  });
  const service = createNewsService({
    cachePath: f.cachePath,
    now: () => NOW,
    fetchImpl: async () => {
      calls++;
      await ready;
      return response();
    },
  });
  const a = service.getNews(),
    b = service.getNews({ refresh: true });
  release();
  const [first, second] = await Promise.all([a, b]);
  assert.equal(calls, 1);
  first.items[0].title = "changed";
  assert.notEqual(second.items[0].title, "changed");
});

test("eight-second deadline aborts even a fetch implementation that never settles", async (t) => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let begin, signal;
  const started = new Promise((resolve) => {
    begin = resolve;
  });
  const service = createNewsService({
    cachePath: f.cachePath,
    now: () => NOW,
    fetchImpl: (_url, options) => {
      signal = options.signal;
      begin();
      return new Promise(() => {});
    },
  });
  const pending = service.getNews();
  await started;
  t.mock.timers.tick(8000);
  const result = await pending;
  assert.equal(signal.aborted, true);
  assert.equal(result.source, "unavailable");
  assert.match(result.error, /超时/);
});

test("a cache write failure retains live articles instead of failing news", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, "not-a-folder"), "occupied");
  const result = await createNewsService({
    cachePath: path.join(f.root, "not-a-folder", "news.json"),
    now: () => NOW,
    fetchImpl: async () => response(),
  }).getNews();
  assert.equal(result.source, "live");
  assert.equal(result.items.length, 1);
  assert.match(result.error, /缓存暂时无法保存/);
});

test("a timed out refresh carries explicit nested diagnostics while cached article text stays literal", async (t) => {
  const f = await fixture(t),
    literal = "设置 {0} C:\\用户\\总览，读取 Steam 官方新闻超时，请稍后重试。";
  const live = await createNewsService({
    cachePath: f.cachePath,
    now: () => NOW,
    fetchImpl: async () =>
      response([announcement({ title: literal, contents: literal })]),
  }).getNews();
  assert.equal(Object.hasOwn(live, "errorDiagnostic"), false);
  const saved = await fs.readFile(f.cachePath, "utf8");
  assert.equal(saved.includes("errorDiagnostic"), false);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let start, signal;
  const started = new Promise((resolve) => {
    start = resolve;
  });
  const pending = createNewsService({
    cachePath: f.cachePath,
    now: () => NOW + 86400000,
    fetchImpl: (_url, options) => {
      signal = options.signal;
      start();
      return new Promise(() => {});
    },
  }).getNews({ refresh: true });
  await started;
  t.mock.timers.tick(8000);
  const result = await pending,
    { formatDiagnostic } = await i18n;
  assert.equal(signal.aborted, true);
  assert.equal(result.source, "cache");
  assert.equal(result.errorDiagnostic.key, "{0} 当前显示上次缓存。");
  assert.equal(
    result.errorDiagnostic.values[0].key,
    "读取 Steam 官方新闻超时，请稍后重试。",
  );
  assert.equal(original(result.errorDiagnostic), result.error);
  assert.equal(
    formatDiagnostic("en", result.errorDiagnostic),
    "Reading official Steam news timed out. Try again later. Showing the previous cached data.",
  );
  assert.equal(result.items[0].title, literal);
  assert.equal(result.items[0].excerpt, literal);
  assert.equal(await fs.readFile(f.cachePath, "utf8"), saved);
});

test("news HTTP and parse failures expose serializable application metadata without response text", async (t) => {
  const { formatDiagnostic } = await i18n;
  for (const [reply, key, english] of [
    [
      new Response("private response", { status: 429 }),
      "Steam 官方新闻服务暂不可用（HTTP {0}）。",
      "Steam's official news service is temporarily unavailable (HTTP 429).",
    ],
    [
      new Response("private malformed JSON"),
      "Steam 返回的新闻数据无法解析。",
      "The news data returned by Steam could not be parsed.",
    ],
  ]) {
    const f = await fixture(t),
      result = await createNewsService({
        cachePath: f.cachePath,
        now: () => NOW,
        fetchImpl: async () => reply,
      }).getNews();
    assert.equal(result.source, "unavailable");
    assert.equal(result.errorDiagnostic.key, key);
    assert.equal(
      formatDiagnostic(
        "en",
        JSON.parse(JSON.stringify(result.errorDiagnostic)),
      ),
      english,
    );
    assert.equal(original(result.errorDiagnostic), result.error);
    assert.doesNotMatch(
      JSON.stringify(result),
      /private response|private malformed/,
    );
  }
});

test("raw news fetch and stream errors cannot impersonate application diagnostics", async (t) => {
  const raw = () =>
    Object.assign(new Error("private network source 设置 {0}"), {
      newsMessage: "读取 Steam 官方新闻超时，请稍后重试。",
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
    const f = await fixture(t),
      result = await createNewsService({
        cachePath: f.cachePath,
        now: () => NOW,
        fetchImpl,
      }).getNews();
    assert.equal(
      result.errorDiagnostic.key,
      "暂时无法连接 Steam 官方新闻服务，请检查网络或稍后重试。",
    );
    assert.equal(original(result.errorDiagnostic), result.error);
    assert.doesNotMatch(
      JSON.stringify(result),
      /private network|"key":"设置"|newsMessage/,
    );
  }
});
