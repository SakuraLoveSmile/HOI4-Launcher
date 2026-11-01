import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createLauncherService } = require("../electron/launcher-service.cjs");
const {
  createSteamWorkshopService,
} = require("../electron/steam-workshop.cjs");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "ironclad-workshop-ui-"));
const output = path.resolve("test-results/workshop-filters");
const origin = "http://127.0.0.1:4188";
const errors = [],
  checks = [],
  queries = [],
  writes = [],
  opened = [];
const externalRequests = [],
  environmentRequests = [],
  coverRequests = [];
let browser, server, page;
let connections = 0;
let coverRecovered = false;

async function until(predicate, label = "Fixture did not settle") {
  const deadline = Date.now() + 15000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(label);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
function check(condition, description) {
  assert.ok(condition, description);
  checks.push(description);
  console.log("PASS " + description);
}
function cover(index) {
  const colors = ["#78604b", "#385868", "#607052", "#845254", "#535875"];
  const titles = [
    "KAISERREICH",
    "NATIONAL FOCUS",
    "PORTRAITS",
    "NEW HORIZONS",
    "WORLD AT WAR",
  ];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><defs><linearGradient id="b" x2="1" y2="1"><stop stop-color="${colors[index % colors.length]}"/><stop offset="1" stop-color="#131c26"/></linearGradient><pattern id="g" width="48" height="48" patternUnits="userSpaceOnUse"><path d="M48 0H0V48" fill="none" stroke="#f3dfb6" stroke-opacity=".08"/></pattern></defs><rect width="512" height="512" fill="url(#b)"/><rect width="512" height="512" fill="url(#g)"/><circle cx="256" cy="232" r="147" fill="none" stroke="#d6c5a4" stroke-width="2" opacity=".5"/><path d="M55 366L165 172L228 279L301 115L461 367Z" fill="#c6bb98" opacity=".24"/><path d="M88 360L184 229L237 307L308 175L420 360" fill="none" stroke="#ecddba" stroke-width="3" opacity=".7"/><text x="256" y="410" text-anchor="middle" fill="#f1e6d0" font-family="Georgia,serif" font-size="29" font-weight="bold">${titles[index % titles.length]}</text><text x="256" y="444" text-anchor="middle" fill="#d3c9b7" font-family="sans-serif" font-size="12" letter-spacing="5">ISOLATED UI FIXTURE</text></svg>`;
}

try {
  await fs.mkdir(output, { recursive: true });
  const game = path.join(root, "game");
  await fs.mkdir(game);
  await fs.writeFile(
    path.join(game, "hoi4.exe"),
    "Fixture only; never execute",
  );
  await fs.writeFile(
    path.join(game, "launcher-settings.json"),
    '{"rawVersion":"1.19.4.0"}',
  );
  const launcher = createLauncherService({
    settingsPath: path.join(root, "settings.json"),
    documentsPath: root,
    steamRoots: [],
    processProbe: async () => null,
    spawnProcess: () => {
      throw new Error("Workshop UI fixture must never start a game");
    },
  });
  await launcher.saveSettings({ gameDirectory: game });
  const originalPlaysets = structuredClone(
    (await launcher.getState()).settings.playsets,
  );
  const names = [
    "China Kaiserreich",
    "China National Focus",
    "China Portraits",
    "China New Horizons",
    "China World at War",
    "China Radio Collection",
  ];
  const categories = [
    "Alternative History",
    "Gameplay",
    "Graphics",
    "Translation",
  ];
  const entries = Array.from({ length: 58 }, (_, index) => ({
    publishedFileId: BigInt(9001 + index),
    consumerAppId: 394360,
    title:
      names[index] || `China Campaign ${String(index + 1).padStart(2, "0")}`,
    description: `A detailed isolated Workshop description for campaign ${index + 1}.${index % 2 === 0 ? " 中文模组介绍。" : ""}`,
    banned: false,
    timeUpdated: 1793260800 - index * 86400,
    statistics: { numSubscriptions: BigInt(90000 - index * 1000) },
    tags: [
      categories[index % categories.length],
      "Historical",
      ...(index % 6 === 1 ? ["Balance"] : []),
    ],
    ...(index === 3
      ? {}
      : {
          previewUrl: `https://images.steamusercontent.com/ugc/fixture/${index === 2 ? "broken" : index}.svg`,
        }),
  }));
  const flags = new Map([
    ["9001", 1 | 4],
    ["9002", 1 | 4 | 8],
    ["9003", 1 | 16],
    ["9004", 1 | 32],
    ["9005", 1 | 4],
  ]);
  const item = (id) =>
    entries.find((entry) => entry.publishedFileId === BigInt(id));
  const native = {
    utils: { getAppId: () => 394360 },
    localplayer: {
      getSteamId: () => ({ steamId64: 76561198000000000n }),
      getName: () => "Workshop fixture",
    },
    workshop: {
      getSubscribedItems: () =>
        [...flags].filter(([, value]) => value & 1).map(([id]) => BigInt(id)),
      getItems: async (ids) => ({ items: ids.map(item) }),
      getItem: async (id) => item(id),
      getAllItems: async (
        pageNumber,
        queryType,
        ugcType,
        creator,
        appId,
        config,
      ) => {
        queries.push({
          page: pageNumber,
          queryType,
          ugcType,
          creator,
          appId,
          config: structuredClone(config),
        });
        let found = entries.filter(
          (entry) =>
            (!config.searchText ||
              entry.title
                .toLowerCase()
                .includes(config.searchText.toLowerCase())) &&
            (!config.requiredTags ||
              config.requiredTags[config.matchAnyTag ? "some" : "every"](
                (tag) => entry.tags.includes(tag),
              )) &&
            !config.excludedTags?.some((tag) => entry.tags.includes(tag)),
        );
        if (queryType === 19)
          found = found.toSorted((a, b) => b.timeUpdated - a.timeUpdated);
        return {
          items: found.slice((pageNumber - 1) * 50, pageNumber * 50),
          totalResults: found.length,
        };
      },
      state: (id) => flags.get(String(id)) || 0,
      downloadInfo: (id) =>
        flags.get(String(id)) & 16 ? { current: 42n, total: 100n } : null,
      subscribe: async (id) => {
        writes.push(["subscribe", String(id)]);
        flags.set(String(id), 1 | 32);
      },
      unsubscribe: async (id) => {
        writes.push(["unsubscribe", String(id)]);
        flags.set(String(id), 0);
      },
      download: (id, priority) => {
        writes.push(["download", String(id), priority]);
        flags.set(String(id), 1 | 16);
        return true;
      },
    },
  };
  const makeSteam = () =>
    createSteamWorkshopService({
      createClient: () => {
        connections++;
        return native;
      },
    });
  let steam = makeSteam();
  const api = {
    getState: () => launcher.getState(),
    getLaunchStatus: () => launcher.getLaunchStatus(),
    getNews: async () => ({ items: [], source: "fixture" }),
    getSteamState: () => steam.getState(),
    connectSteam: () => steam.connect(),
    disconnectSteam: () => {
      steam = makeSteam();
      return steam.getState();
    },
    browseWorkshop: (input) => steam.browse(input),
    subscribeWorkshop: (id) => steam.subscribe(id),
    unsubscribeWorkshop: (id) => steam.unsubscribe(id),
    downloadWorkshop: (id) => steam.download(id),
    getSteamMissingMods: async () => ({ job: null, plan: null }),
    getPdxSubscriptions: async () => ({ accountId: null, items: [] }),
    getPdxDownloads: async () => ({
      job: null,
      installations: [],
      bytesPerSecond: 0,
    }),
    searchModCatalog: async () => ({
      items: [],
      totalCount: 0,
      totalPages: 0,
      page: 0,
      pageSize: 12,
    }),
    openModPage: async (id) => {
      opened.push(id);
    },
    openLink: async (id) => {
      opened.push(id);
    },
  };
  server = spawn(
    process.execPath,
    [
      "node_modules/vite/bin/vite.js",
      "preview",
      "--host",
      "127.0.0.1",
      "--port",
      "4188",
      "--strictPort",
    ],
    {
      cwd: path.resolve("."),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let serverLog = "";
  server.stdout.on("data", (data) => {
    serverLog += data;
  });
  server.stderr.on("data", (data) => {
    serverLog += data;
  });
  await until(() => {
    if (server.exitCode !== null) throw new Error(serverLog);
    return serverLog.includes(origin);
  });
  browser = await chromium.launch({
    channel: process.env.TEST_BROWSER_CHANNEL || "msedge",
    headless: true,
  });
  page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    reducedMotion: "reduce",
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === origin) return route.continue();
    if (
      url.hostname === "images.steamusercontent.com" &&
      url.pathname.startsWith("/ugc/fixture/")
    ) {
      coverRequests.push({
        path: url.pathname,
        referer: route.request().headers().referer || null,
      });
      if (url.pathname.endsWith("broken.svg") && !coverRecovered)
        return route.fulfill({ status: 404, body: "missing fixture" });
      return route.fulfill({
        status: 200,
        contentType: "image/svg+xml",
        body: cover(
          url.pathname.endsWith("broken.svg")
            ? 2
            : Number(path.basename(url.pathname, ".svg")),
        ),
      });
    }
    if (
      url.hostname === "me.kis.v2.scr.kaspersky-labs.com" &&
      url.pathname.endsWith("/main.js")
    )
      environmentRequests.push(url.hostname);
    else externalRequests.push(url.href);
    return route.abort();
  });
  await page.exposeBinding("fixtureInvoke", (_source, method, args) => {
    assert.ok(Object.hasOwn(api, method), "Unexpected API: " + method);
    return api[method](...args);
  });
  await page.addInitScript((methods) => {
    window.launcher = Object.fromEntries(
      methods.map((method) => [
        method,
        (...args) => window.fixtureInvoke(method, args),
      ]),
    );
  }, Object.keys(api));
  async function openPanel(english = false) {
    await page.goto(origin);
    await page
      .getByRole("button", {
        name: english ? "Discover mods" : "发现模组",
        exact: true,
      })
      .click();
    await page
      .locator(".discover-source-tabs")
      .getByRole("button", {
        name: english ? "Steam Workshop" : "Steam 创意工坊",
        exact: true,
      })
      .click();
    await page.locator(".workshop").waitFor();
  }
  const cards = () => page.locator(".workshop-card");
  const card = (name) =>
    cards().filter({ has: page.locator("h3", { hasText: name }) });
  const library = () => page.locator(".workshop-library");
  const libraryItems = () => library().locator(".workshop-library-item");
  async function ready(expected = 50) {
    await until(
      async () =>
        (await cards().count()) === expected &&
        !(await page.locator(".workshop-loading").count()),
    );
  }
  async function snapshot(name) {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: path.join(output, name + ".png"),
      fullPage: false,
      animations: "disabled",
    });
  }
  async function layout(width, height, name) {
    await page.setViewportSize({ width, height });
    await page.evaluate(() => document.fonts.ready);
    check(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      `${name}: no horizontal overflow`,
    );
    const boxes = await page.evaluate(() => {
      const bounds = (selector) => {
        const r = document.querySelector(selector).getBoundingClientRect();
        return { x: r.x, right: r.right, width: r.width };
      };
      return {
        browser: bounds(".workshop-browser"),
        library: bounds(".workshop-library"),
      };
    });
    check(
      boxes.browser.width > 300 && boxes.library.width > 180,
      `${name}: usable catalog and subscription widths`,
    );
    if (width >= 1440)
      check(
        boxes.library.x >= boxes.browser.right,
        `${name}: subscriptions appear to the right of the catalog`,
      );
    await snapshot(name);
  }

  await openPanel();
  check(
    connections === 0 && queries.length === 0,
    "opening Workshop never initializes Steam or browses without explicit connection",
  );
  check(
    await library().getByText("请先连接 Steam。", { exact: true }).isVisible(),
    "disconnected subscription rail explains connection state",
  );
  await snapshot("workshop-offline");
  await page.getByRole("button", { name: "连接 Steam", exact: true }).click();
  await ready();
  check(connections === 1, "explicit connect initializes the fixture SDK once");
  check(
    (await page
      .getByRole("button", { name: "浏览工坊", exact: true })
      .getAttribute("aria-pressed")) === "true",
    "connected Workshop defaults to browsing",
  );
  check(
    (await libraryItems().count()) === 5,
    "subscribed items remain visible beside the catalog",
  );
  await until(async () =>
    card("China Kaiserreich")
      .locator("img")
      .evaluate((image) => image.complete && image.naturalWidth > 0),
  );
  check(
    true,
    "valid Steam cover metadata loads through the restricted CDN image policy",
  );
  await until(async () =>
    card("China Portraits").getByText("暂无封面", { exact: true }).isVisible(),
  );
  check(true, "failed cover requests display the empty-cover fallback");
  check(
    await card("China New Horizons")
      .getByText("暂无封面", { exact: true })
      .isVisible(),
    "missing cover metadata displays a fallback",
  );
  check(
    coverRequests.length > 0 &&
      coverRequests.every((request) => request.referer === null),
    "cover requests omit the launcher referrer",
  );
  const failedRequests = coverRequests.filter((request) =>
    request.path.endsWith("broken.svg"),
  ).length;
  coverRecovered = true;
  await page.getByRole("button", { name: "刷新本地模组", exact: true }).click();
  await until(async () => {
    const images = await card("China Portraits").locator("img").all();
    return (
      images.length === 1 &&
      images[0].evaluate((image) => image.complete && image.naturalWidth > 0)
    );
  });
  check(
    coverRequests.filter((request) => request.path.endsWith("broken.svg"))
      .length > failedRequests,
    "explicit install refresh retries a failed cover at the same URL after recovery",
  );
  await until(async () => {
    const images = await library()
      .locator(".workshop-library-item")
      .filter({ hasText: "China Portraits" })
      .locator("img")
      .all();
    return (
      images.length === 1 &&
      images[0].evaluate((image) => image.complete && image.naturalWidth > 0)
    );
  });
  check(true, "explicit cover retry also restores the subscription rail image");
  await layout(1440, 900, "workshop-zh-1440");
  await layout(1000, 740, "workshop-zh-1000");
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.getByLabel("搜索工坊模组", { exact: true }).fill(" China ");
  await page
    .locator(".workshop-toolbar")
    .getByRole("button", { name: "搜索", exact: true })
    .click();
  await ready();
  check(
    queries.at(-1).config.searchText === "China" &&
      queries.at(-1).page === 1 &&
      queries.at(-1).queryType === 11,
    "submitted search is trimmed and reaches the SDK relevance query",
  );
  await page.getByLabel("工坊分类", { exact: true }).selectOption("Gameplay");
  await ready(15);
  check(
    queries.at(-1).config.requiredTags?.[0] === "Gameplay" &&
      queries.at(-1).page === 1,
    "category selection reaches the SDK as a required tag",
  );
  await page.getByLabel("工坊排序", { exact: true }).selectOption("recent");
  await ready(15);
  check(
    queries.at(-1).queryType === 19 &&
      queries.at(-1).config.requiredTags?.[0] === "Gameplay",
    "sort changes preserve the selected category",
  );
  await page.getByLabel("工坊分类", { exact: true }).selectOption("");
  await ready();
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await ready(8);
  check(
    queries.at(-1).page === 2 &&
      queries.at(-1).config.searchText === "China" &&
      queries.at(-1).queryType === 19,
    "pagination preserves the submitted search and sort",
  );
  await page.getByRole("button", { name: "上一页", exact: true }).click();
  await ready();

  const advancedFilters = () => page.locator("#workshop-advanced-filters");
  const includeTags = () =>
    advancedFilters().getByRole("group", { name: "包含标签", exact: true });
  const excludeTags = () =>
    advancedFilters().getByRole("group", { name: "排除标签", exact: true });
  async function editFilters() {
    await page.getByRole("button", { name: /^更多筛选/ }).click();
    await advancedFilters().waitFor();
  }
  async function applyFilters(expected) {
    await advancedFilters()
      .getByRole("button", { name: "应用筛选", exact: true })
      .click();
    await ready(expected);
  }
  await page.getByLabel("工坊分类", { exact: true }).selectOption("Gameplay");
  await ready(15);
  await editFilters();
  const draftQueries = queries.length;
  await includeTags().getByLabel("平衡", { exact: true }).check();
  check(
    queries.length === draftQueries,
    "editing tag selections waits for Apply before querying Steam",
  );
  await applyFilters(5);
  check(
    queries.at(-1).config.requiredTags.join(",") === "Gameplay,Balance" &&
      !queries.at(-1).config.matchAnyTag &&
      queries.at(-1).page === 1,
    "all-tag filtering intersects categories on the server and resets pagination",
  );
  check(
    (await page.getByLabel("工坊分类", { exact: true }).inputValue()) ===
      "multiple",
    "the quick category selector identifies multiple active categories",
  );
  await editFilters();
  await page.getByLabel("标签匹配方式", { exact: true }).selectOption("any");
  await applyFilters(20);
  check(
    queries.at(-1).config.matchAnyTag === true &&
      (await cards().allTextContents()).some((text) =>
        text.includes("China Campaign 08"),
      ),
    "any-tag matching returns the union of categories",
  );
  await editFilters();
  await excludeTags().getByLabel("翻译", { exact: true }).check();
  await applyFilters(15);
  check(
    queries.at(-1).config.excludedTags.join(",") === "Translation" &&
      !(await cards().allTextContents()).some((text) =>
        text.includes("China Campaign 08"),
      ),
    "excluded tags remove matching mods before counts and pagination are calculated",
  );
  await editFilters();
  await excludeTags().getByLabel("玩法", { exact: true }).check();
  check(
    !(await includeTags().getByLabel("玩法", { exact: true }).isChecked()),
    "selecting an excluded tag removes the same tag from includes",
  );
  await advancedFilters()
    .getByRole("button", { name: "取消", exact: true })
    .click();
  check(
    !queries.at(-1).config.excludedTags.includes("Gameplay"),
    "cancelling the filter editor preserves applied filters",
  );
  await page.getByRole("button", { name: "我的订阅", exact: true }).click();
  await ready(1);
  check(
    (await cards().innerText()).includes("China National Focus"),
    "combined tag and exclusion filters also apply to the full subscription list",
  );
  await page.getByRole("button", { name: "浏览工坊", exact: true }).click();
  await ready(15);
  await page
    .getByRole("button", { name: "移除筛选：排除：翻译", exact: true })
    .click();
  await ready(20);
  check(
    !queries.at(-1).config.excludedTags,
    "an active filter chip can remove an exclusion",
  );
  await page.getByRole("button", { name: "清空筛选", exact: true }).click();
  await ready();
  check(
    !queries.at(-1).config.requiredTags &&
      !queries.at(-1).config.excludedTags &&
      queries.at(-1).config.searchText === "China" &&
      queries.at(-1).queryType === 11,
    "clearing filters resets tags and sort while preserving the submitted search",
  );
  for (const [sort, queryType] of [
    ["created", 1],
    ["subscriptions", 12],
    ["votes", 10],
    ["weekly", 3],
    ["rated", 0],
    ["dependencies", 20],
    ["collections", 21],
    ["trending", 3],
  ]) {
    const previousQueries = queries.length;
    await page.getByLabel("工坊排序", { exact: true }).selectOption(sort);
    await until(() => queries.length > previousQueries);
    await ready();
    check(
      queries.at(-1).queryType === queryType,
      `${sort} sort reaches the native Steam query`,
    );
    if (sort === "weekly")
      check(
        queries.at(-1).config.rankedByTrendDays === 7,
        "Popular this week always uses the seven-day Steam trend window",
      );
  }
  await page.getByLabel("热门时间范围", { exact: true }).selectOption("30");
  await until(() => queries.at(-1).config.rankedByTrendDays === 30);
  await ready();
  await page.getByLabel("工坊分类", { exact: true }).selectOption("Historical");
  await until(() => queries.at(-1).config.requiredTags?.[0] === "Historical");
  await ready();
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await ready(8);
  check(
    queries.at(-1).page === 2 &&
      queries.at(-1).config.rankedByTrendDays === 30 &&
      queries.at(-1).config.requiredTags.join(",") === "Historical" &&
      queries.at(-1).config.searchText === "China" &&
      queries.at(-1).queryType === 3,
    "pagination retains tags, search, trend sort and its time window",
  );
  await page.getByRole("button", { name: "清空筛选", exact: true }).click();
  await ready();
  check(
    queries.at(-1).page === 1 && !queries.at(-1).config.rankedByTrendDays,
    "clearing filters on a later page resets pagination and the trending period",
  );
  const language = page.getByLabel("工坊内容语言", { exact: true });
  check(
    (await language.locator("option").allTextContents()).join(",") ===
      "全部语言,仅中文内容,非中文内容",
    "the language selector offers all three requested choices",
  );
  entries.push(
    ...Array.from({ length: 60 }, (_, index) => ({
      ...entries[0],
      publishedFileId: BigInt(100001 + index),
      title: `China Extra ${index}`,
      tags: ["Historical"],
    })),
  );
  await language.selectOption("chinese");
  await ready();
  const chineseNames = new Set(
    entries
      .filter((entry) => entry.description.includes("中文模组介绍"))
      .map((entry) => entry.title),
  );
  check(
    (await cards().locator("h3").allTextContents()).every((name) =>
      chineseNames.has(name),
    ) &&
      (await page.locator(".workshop-result-count").innerText()).includes(
        "本页 50 个匹配项",
      ),
    "Chinese filtering scans multiple source pages and reports matches on this page",
  );
  const firstChinese = await cards().locator("h3").allTextContents();
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await ready(39);
  const nextChinese = await cards().locator("h3").allTextContents();
  check(
    nextChinese.every((name) => !firstChinese.includes(name)) &&
      (await page
        .getByRole("button", { name: "下一页", exact: true })
        .isDisabled()),
    "filtered pagination resumes within a source page without duplicates and detects the end",
  );
  await page.getByRole("button", { name: "上一页", exact: true }).click();
  await ready();
  check(
    JSON.stringify(await cards().locator("h3").allTextContents()) ===
      JSON.stringify(firstChinese),
    "previous page restores the same filtered results",
  );
  await page.getByLabel("工坊分类", { exact: true }).selectOption("Graphics");
  await ready(14);
  check(
    queries.at(-1).config.requiredTags[0] === "Graphics" &&
      queries.at(-1).config.searchText === "China" &&
      (await page.locator(".workshop-result-count").innerText()).includes(
        "第 1 页",
      ),
    "category changes keep the language and submitted search while resetting pagination",
  );
  await layout(1440, 900, "workshop-language-zh-1440");
  await layout(1000, 740, "workshop-language-zh-1000");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "我的订阅", exact: true }).click();
  await ready(1);
  await page.getByLabel("工坊分类", { exact: true }).selectOption("");
  await ready(3);
  const localQueries = queries.length;
  await language.selectOption("non-chinese");
  await ready(2);
  check(
    queries.length === localQueries && (await libraryItems().count()) === 5,
    "subscription language filtering is local and keeps the independent subscription rail intact",
  );
  entries.splice(58);
  await page.getByRole("button", { name: "浏览工坊", exact: true }).click();
  await ready(29);
  check(
    (await cards().locator("h3").allTextContents()).every(
      (name) => !chineseNames.has(name),
    ),
    "Non-Chinese content excludes all identified Chinese entries",
  );
  await page.getByRole("button", { name: "清空筛选", exact: true }).click();
  await ready();
  check(
    (await language.inputValue()) === "all" &&
      queries.at(-1).config.searchText === "China",
    "clear filters resets content language and retains the submitted search",
  );
  await editFilters();
  await layout(1440, 900, "workshop-filters-zh-1440");
  await layout(1000, 740, "workshop-filters-zh-1000");
  await advancedFilters()
    .getByRole("button", { name: "取消", exact: true })
    .click();
  await page.setViewportSize({ width: 1440, height: 900 });

  const librarySearch = page.getByLabel("搜索已订阅模组", { exact: true });
  await librarySearch.fill("9002");
  await until(async () => (await libraryItems().count()) === 1);
  check(
    (await libraryItems().innerText()).includes("China National Focus"),
    "subscription rail searches by Workshop ID",
  );
  await librarySearch.fill("CHINA KAISERREICH");
  await until(async () =>
    (await libraryItems().allTextContents())
      .join("")
      .includes("China Kaiserreich"),
  );
  check(
    (await libraryItems().count()) === 1,
    "subscription rail searches names without case sensitivity",
  );
  await librarySearch.fill("");
  await page
    .getByLabel("订阅状态", { exact: true })
    .selectOption("needsUpdate");
  await until(async () => (await libraryItems().count()) === 1);
  check(
    (await libraryItems().innerText()).includes("China National Focus"),
    "subscription rail filters items needing updates",
  );
  await page
    .getByLabel("订阅状态", { exact: true })
    .selectOption("downloading");
  await until(async () => (await libraryItems().count()) === 2);
  check(true, "downloading filter includes queued downloads");
  await page.getByLabel("订阅状态", { exact: true }).selectOption("installed");
  await until(async () => (await libraryItems().count()) === 3);
  check(true, "installed filter shows installed subscriptions");
  await page.getByLabel("订阅状态", { exact: true }).selectOption("all");

  await card("China Kaiserreich").locator(".workshop-cover-button").click();
  let dialog = page.getByRole("dialog", {
    name: "China Kaiserreich",
    exact: true,
  });
  await dialog.waitFor();
  check(
    (await dialog.innerText()).includes(
      "A detailed isolated Workshop description",
    ),
    "cover opens a detail dialog with the remote description",
  );
  await snapshot("workshop-detail");
  await dialog
    .getByRole("button", { name: "在来源页浏览", exact: true })
    .click();
  await until(() => opened.length === 1);
  check(
    opened[0] === "workshop:9001",
    "source action delegates the exact registered Workshop identifier",
  );
  await dialog.getByRole("button", { name: "取消订阅", exact: true }).click();
  let confirmation = page.getByRole("dialog", {
    name: "取消工坊订阅",
    exact: true,
  });
  await confirmation.waitFor();
  check(
    writes.length === 0,
    "opening unsubscribe confirmation does not mutate subscriptions",
  );
  await confirmation
    .getByRole("button", { name: "保留订阅", exact: true })
    .click();
  await dialog.waitFor();
  check(
    writes.length === 0,
    "keeping a subscription does not submit a native write",
  );
  await dialog.getByRole("button", { name: "取消订阅", exact: true }).click();
  confirmation = page.getByRole("dialog", {
    name: "取消工坊订阅",
    exact: true,
  });
  await confirmation
    .getByRole("button", { name: "确认取消订阅", exact: true })
    .click();
  await until(async () => (await libraryItems().count()) === 4);
  await ready();
  check(
    writes.length === 1 &&
      writes[0][0] === "unsubscribe" &&
      writes[0][1] === "9001",
    "only confirmed unsubscribe updates the subscription rail",
  );
  check(
    await card("China Kaiserreich")
      .getByRole("button", { name: "订阅并下载", exact: true })
      .isVisible(),
    "unsubscribed catalog card exposes subscription action",
  );
  await card("China Radio Collection")
    .getByRole("button", { name: "订阅并下载", exact: true })
    .click();
  await until(async () => (await libraryItems().count()) === 5);
  await ready();
  check(
    writes.at(-1)[0] === "subscribe" && writes.at(-1)[1] === "9006",
    "subscribe action updates both catalog and subscription rail",
  );
  check(
    await card("China Radio Collection")
      .getByText("等待下载", { exact: true })
      .isVisible(),
    "updated subscription state displays pending download status",
  );
  await page.getByRole("button", { name: "我的订阅", exact: true }).click();
  await ready(5);
  check(true, "My subscriptions tab shows subscribed items only");
  await page.getByRole("button", { name: "浏览工坊", exact: true }).click();
  await ready();

  await launcher.saveSettings({
    launcherPreferences: { closeOnLaunch: false, language: "en" },
  });
  await openPanel(true);
  await ready();
  check(
    await page.getByLabel("Workshop category", { exact: true }).isVisible(),
    "English Workshop controls use translated accessible labels",
  );
  check(
    (
      await page
        .getByLabel("Workshop content language", { exact: true })
        .locator("option")
        .allTextContents()
    ).join(",") === "All languages,Chinese content only,Non-Chinese content",
    "English content-language options are translated",
  );
  await layout(1440, 900, "workshop-en-1440");
  await layout(1000, 740, "workshop-en-1000");
  await page.getByRole("button", { name: "More filters", exact: true }).click();
  check(
    (await page
      .getByRole("group", { name: "Include tags", exact: true })
      .isVisible()) &&
      (await page.getByLabel("Tag matching", { exact: true }).isVisible()),
    "English advanced filters have translated accessible labels",
  );
  await layout(1440, 900, "workshop-filters-en-1440");
  await layout(1000, 740, "workshop-filters-en-1000");
  assert.deepEqual(
    (await launcher.getState()).settings.playsets,
    originalPlaysets,
  );
  check(true, "Workshop actions preserve local presets");
  assert.deepEqual(errors, []);
  assert.deepEqual(externalRequests, []);
  const report = {
    checkedAt: new Date().toISOString(),
    passed: checks.length,
    checks,
    realLauncherAndSteamService: true,
    fakeNativeSteamOnly: true,
    mockedCoverRequests: coverRequests.length,
    externalAppRequests: externalRequests.length,
    blockedEnvironmentScriptRequests: environmentRequests.length,
    rendererErrors: errors,
    realGameDataUsed: false,
    subscriptionsChangedOnlyInFixture: true,
    screenshots: [
      "workshop-offline",
      "workshop-zh-1440",
      "workshop-zh-1000",
      "workshop-detail",
      "workshop-en-1440",
      "workshop-en-1000",
      "workshop-filters-zh-1440",
      "workshop-filters-zh-1000",
      "workshop-filters-en-1440",
      "workshop-filters-en-1000",
      "workshop-language-zh-1440",
      "workshop-language-zh-1000",
    ],
  };
  await fs.writeFile(
    path.join(output, "workshop-ui.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(
    JSON.stringify(
      { errors, body: await page?.locator("body").innerText() },
      null,
      2,
    ),
  );
  await page
    ?.screenshot({
      path: path.join(output, "workshop-ui-failure.png"),
      fullPage: true,
      animations: "disabled",
    })
    .catch(() => {});
  throw error;
} finally {
  await browser?.close();
  if (server && server.exitCode === null) {
    server.kill();
    await once(server, "exit");
  }
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith("ironclad-workshop-ui-"));
  await fs.rm(root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 50,
  });
}
