"use strict";

const APP_ID = 394360;
const PAGE_SIZE = 50;
const LANGUAGE_SCAN_PAGES = 4;
const LANGUAGE_SCAN_MS = 15000;
const MAX_ITEMS = 5000;
const MAX_ID = 18446744073709551615n;
const FILTERS = require("../src/workshop-filters.json");
const CATEGORIES = new Set(FILTERS.categories.map(([id]) => id));
const TAGS = new Set([...CATEGORIES].filter(Boolean));
const SORTS = new Map(
  FILTERS.sorts.map(([id, , nativeType]) => [id, nativeType]),
);
const LANGUAGES = new Set(FILTERS.languages.map(([id]) => id));
const ACTIVE_PUBLISH = new Set(["queued", "creating", "uploading"]);
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const clone = (value) => JSON.parse(JSON.stringify(value));

class WorkshopError extends Error {}
function problem(message, code) {
  return Object.assign(new WorkshopError(message), code ? { code } : {});
}
function knownMessage(error) {
  return error instanceof WorkshopError ? error.message : null;
}

function itemId(value, native = false) {
  if (native && typeof value === "bigint") value = String(value);
  if (native && Number.isSafeInteger(value)) value = String(value);
  if (
    typeof value !== "string" ||
    !/^[1-9]\d{0,19}$/.test(value) ||
    BigInt(value) > MAX_ID
  )
    throw problem("Steam 模组 ID 须为有效的正整数编号。");
  return value;
}

function text(value, limit) {
  if (typeof value !== "string") return "";
  return value
    .slice(0, 100000)
    .replace(
      /<(script|style|iframe|svg|object)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
      " ",
    )
    .replace(/<[^>]*>/g, " ")
    .replace(/\[(img|video|youtube)(?:=[^\]]*)?\][\s\S]*?\[\/\1\]/gi, " ")
    .replace(/\[\/?[a-z*][^\]]*\]/gi, " ")
    .replace(/[\0-\x1f\x7f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

function byteCount(value) {
  if (typeof value === "bigint")
    return value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : null;
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function previewUrl(value) {
  if (
    typeof value !== "string" ||
    value.length > 2048 ||
    /[\0-\x20\x7f]/.test(value)
  )
    return null;
  try {
    const url = new URL(value);
    const host = url.hostname;
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      !(
        host === "steamstatic.com" ||
        host.endsWith(".steamstatic.com") ||
        host === "steamusercontent.com" ||
        host.endsWith(".steamusercontent.com") ||
        host === "steamuserimages-a.akamaihd.net"
      ) ||
      url.href.length > 2048
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}

function itemMetadata(value) {
  const result = {};
  const preview = previewUrl(value.previewUrl);
  if (preview) result.previewUrl = preview;
  if (
    Number.isSafeInteger(value.timeUpdated) &&
    value.timeUpdated > 0 &&
    Number.isFinite(new Date(value.timeUpdated * 1000).getTime())
  )
    result.updatedAt = value.timeUpdated;
  const subscriberCount = byteCount(value.statistics?.numSubscriptions);
  if (subscriberCount !== null) result.subscriberCount = subscriberCount;
  if (Array.isArray(value.tags))
    result.tags = [
      ...new Set(
        value.tags
          .slice(0, 32)
          .map((tag) => text(tag, 80))
          .filter(Boolean),
      ),
    ];
  return result;
}

function hasChineseContent(value) {
  const tags = Array.isArray(value.tags) ? value.tags.slice(0, 32) : [];
  const content = `${text(value.title, 160)} ${text(value.description, 10000)}`;
  if (
    tags.some(
      (tag) =>
        typeof tag === "string" &&
        /^(?:s?chinese|tchinese|simplified chinese|traditional chinese|中文|简体中文|繁體中文|繁体中文|汉化|漢化)$/i.test(
          tag.trim(),
        ),
    ) ||
    /中文|汉化|漢化|简中|簡中|繁中/.test(content)
  )
    return true;
  return (
    /\p{Script=Han}/u.test(content) &&
    !/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(content)
  );
}

function request(input = {}) {
  if (
    !object(input) ||
    Object.keys(input).some(
      (key) =>
        ![
          "query",
          "sort",
          "page",
          "category",
          "tags",
          "excludedTags",
          "matchAnyTag",
          "trendDays",
          "language",
          "cursor",
        ].includes(key),
    )
  )
    throw problem("Steam 创意工坊查询参数无效。");
  const {
    query = "",
    sort = "best",
    page = 1,
    category = "",
    tags = [],
    excludedTags = [],
    matchAnyTag = false,
    trendDays = 7,
    language = "all",
    cursor,
  } = input;
  if (
    typeof query !== "string" ||
    query.length > 120 ||
    /[\0-\x1f\x7f]/.test(query)
  )
    throw problem("搜索关键词须为不超过 120 个字符的单行文字。");
  if (!SORTS.has(sort)) throw problem("不支持此创意工坊排序方式。");
  if (!LANGUAGES.has(language)) throw problem("Steam 创意工坊查询参数无效。");
  if (
    cursor !== undefined &&
    (language === "all" ||
      !object(cursor) ||
      Object.keys(cursor).length !== 2 ||
      !Number.isInteger(cursor.page) ||
      cursor.page < 1 ||
      cursor.page > 10000 ||
      !Number.isInteger(cursor.offset) ||
      cursor.offset < 0 ||
      cursor.offset >= PAGE_SIZE)
  )
    throw problem("Steam 创意工坊查询参数无效。");
  if (!Number.isInteger(page) || page < 1 || page > 10000)
    throw problem("创意工坊页码须为 1 至 10000 的整数。");
  if (!CATEGORIES.has(category)) throw problem("Steam 创意工坊查询参数无效。");
  for (const values of [tags, excludedTags]) {
    if (
      !Array.isArray(values) ||
      values.length > TAGS.size ||
      new Set(values).size !== values.length
    )
      throw problem("Steam 创意工坊查询参数无效。");
    for (const tag of values)
      if (!TAGS.has(tag)) throw problem("Steam 创意工坊查询参数无效。");
  }
  if (
    typeof matchAnyTag !== "boolean" ||
    !FILTERS.trendDays.includes(trendDays) ||
    excludedTags.some((tag) => tag === category || tags.includes(tag))
  )
    throw problem("Steam 创意工坊查询参数无效。");
  return {
    query: query.trim(),
    sort,
    page,
    category,
    tags: [...tags],
    excludedTags: [...excludedTags],
    matchAnyTag,
    trendDays,
    language,
    ...(cursor ? { cursor: { page: cursor.page, offset: cursor.offset } } : {}),
  };
}

function publishPath(value) {
  if (
    typeof value !== "string" ||
    value.length > 32760 ||
    !/^[a-z]:[\\/]/i.test(value) ||
    /[\0-\x1f\x7f<>"|?*:]/.test(value.slice(2)) ||
    value.split(/[\\/]/).some((part) => part === "." || part === "..")
  )
    throw problem("发布文件须使用有效的 Windows 绝对路径。");
  return value;
}

function publishText(value, name, limit, multiline = false, required = false) {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") > limit ||
    (multiline ? /[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/ : /[\0-\x1f\x7f]/).test(
      value,
    ) ||
    (required && !value.trim())
  )
    throw problem(`${name}为空、含控制字符或超出 ${limit} 字节限制。`);
  return value;
}

function publishRequest(input) {
  const keys = [
    "id",
    "existingItemId",
    "contentPath",
    "previewPath",
    "title",
    "description",
    "tags",
    "visibility",
    "changeNote",
  ];
  if (!object(input) || Object.keys(input).some((key) => !keys.includes(key)))
    throw problem("Steam 发布参数无效。");
  if (
    typeof input.id !== "string" ||
    !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(input.id)
  )
    throw problem("发布任务编号无效。");
  if (
    !Number.isInteger(input.visibility) ||
    input.visibility < 0 ||
    input.visibility > 3
  )
    throw problem("请选择有效的创意工坊可见范围。");
  if (!Array.isArray(input.tags) || input.tags.length > 100)
    throw problem("发布标签须为不超过 100 项的列表。");
  const tags = input.tags.map((tag) =>
    publishText(tag, "发布标签", 255, false, true).trim(),
  );
  if (new Set(tags).size !== tags.length) throw problem("发布标签不能重复。");
  return {
    id: input.id,
    existingItemId:
      input.existingItemId === null ? null : itemId(input.existingItemId),
    details: {
      contentPath: publishPath(input.contentPath),
      ...(input.previewPath == null
        ? {}
        : { previewPath: publishPath(input.previewPath) }),
      title: publishText(input.title, "模组标题", 128, false, true).trim(),
      description: publishText(input.description, "模组描述", 8000, true),
      tags,
      visibility: input.visibility,
      changeNote: publishText(input.changeNote, "更新说明", 8000, true),
    },
  };
}

function createSteamWorkshopService({ createClient, onPublishStatus } = {}) {
  if (typeof createClient !== "function")
    throw new Error("Steam 服务需要客户端连接工厂。");
  if (onPublishStatus !== undefined && typeof onPublishStatus !== "function")
    throw new Error("Steam 发布状态回调无效。");
  let client = null;
  let state = { connected: false, account: null, items: [] };
  let queue = Promise.resolve();
  let publishJob = null;
  let repairing = false;
  const publishIds = new Set();

  function publishChanged(job) {
    if (!onPublishStatus) return;
    try {
      Promise.resolve(onPublishStatus(clone(job))).catch(() => {});
    } catch {
      /* A status observer cannot cancel an accepted Steam submission. */
    }
  }

  // Native requests and mutations share a queue so a refresh cannot overtake a write.
  function serial(task) {
    const job = queue.then(task);
    queue = job.catch(() => {});
    return job;
  }

  function connected() {
    if (!client) throw problem("请先连接正在运行的 Steam 客户端。");
    return client.workshop;
  }

  function account() {
    const player = client.localplayer.getSteamId();
    if (!object(player))
      throw problem("无法读取 Steam 登录信息，请检查客户端账号。");
    return {
      name: text(client.localplayer.getName(), 160) || "Steam 玩家",
      steamId: itemId(player.steamId64, true),
    };
  }

  function validItem(value, expectedId) {
    if (
      !object(value) ||
      value.consumerAppId !== APP_ID ||
      value.banned === true
    )
      return null;
    let id;
    try {
      id = itemId(value.publishedFileId, true);
    } catch {
      return null;
    }
    if (expectedId !== undefined && id !== expectedId) return null;
    return {
      id,
      name: text(value.title, 160) || `Steam 模组 ${id}`,
      description: text(value.description, 350),
      hasChineseContent: hasChineseContent(value),
      ...itemMetadata(value),
    };
  }

  function itemState(item, description = false) {
    const workshop = connected();
    const id = BigInt(item.id);
    const flags = workshop.state(id);
    if (!Number.isInteger(flags) || flags < 0 || flags > 63)
      throw problem("Steam 返回了无效的模组状态。");
    const info = workshop.downloadInfo(id);
    let downloadedBytes = null,
      totalBytes = null;
    if (object(info)) {
      downloadedBytes = byteCount(info.current);
      totalBytes = byteCount(info.total);
      if (
        downloadedBytes === null ||
        totalBytes === null ||
        downloadedBytes > totalBytes
      )
        downloadedBytes = totalBytes = null;
    }
    const { description: itemDescription, ...summary } = item;
    return {
      ...summary,
      subscribed: Boolean(flags & 1),
      installed: Boolean(flags & 4),
      needsUpdate: Boolean(flags & 8),
      downloading: Boolean(flags & 16),
      pending: Boolean(flags & 32),
      downloadedBytes,
      totalBytes,
      ...(description ? { description: itemDescription } : {}),
    };
  }

  async function refresh() {
    const workshop = connected();
    const currentAccount = account();
    const subscribed = workshop.getSubscribedItems();
    if (!Array.isArray(subscribed) || subscribed.length > 100000)
      throw problem("Steam 返回了无效的订阅列表。");
    const ids = [],
      seen = new Set();
    let incomplete = subscribed.length > MAX_ITEMS;
    for (const raw of subscribed.slice(0, MAX_ITEMS)) {
      let id;
      try {
        id = itemId(raw, true);
      } catch {
        incomplete = true;
        continue;
      }
      if (seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
    const items = [];
    for (let start = 0; start < ids.length; start += 100) {
      const batch = ids.slice(start, start + 100);
      const result = await workshop.getItems(batch.map(BigInt), {
        cachedResponseMaxAge: 0,
      });
      if (
        !object(result) ||
        !Array.isArray(result.items) ||
        result.items.length > 100
      )
        throw problem("Steam 返回了无效的模组详情。");
      const details = new Map();
      for (const raw of result.items) {
        const item = validItem(raw);
        if (item && batch.includes(item.id)) details.set(item.id, item);
      }
      for (const id of batch) {
        const item = details.get(id);
        if (!item) {
          incomplete = true;
          continue;
        }
        items.push(itemState(item));
      }
    }
    state = {
      connected: true,
      account: currentAccount,
      items,
      ...(incomplete
        ? { error: "部分订阅模组不可用或数量超出显示上限，列表可能不完整。" }
        : {}),
    };
    return clone(state);
  }

  async function readState(successMessage) {
    if (!client) return clone(state);
    try {
      return await refresh();
    } catch (error) {
      const detail =
        knownMessage(error) ||
        "无法刷新 Steam 订阅状态，请检查客户端连接后重试。";
      state = {
        ...state,
        error: successMessage ? `${successMessage}，但${detail}` : detail,
      };
      return clone(state);
    }
  }

  function connect() {
    return serial(async () => {
      if (client) return readState();
      try {
        const candidate = await createClient(APP_ID);
        const methods = [
          "getSubscribedItems",
          "getItems",
          "getItem",
          "getAllItems",
          "state",
          "downloadInfo",
          "subscribe",
          "unsubscribe",
          "download",
        ];
        if (
          !candidate ||
          !candidate.workshop ||
          methods.some(
            (method) => typeof candidate.workshop[method] !== "function",
          ) ||
          typeof candidate.localplayer?.getSteamId !== "function" ||
          typeof candidate.localplayer?.getName !== "function"
        )
          throw problem("Steam 客户端接口不完整，请更新 Steam 后重试。");
        if (
          typeof candidate.utils?.getAppId === "function" &&
          candidate.utils.getAppId() !== APP_ID
        )
          throw problem("Steam 未连接到 HOI4，请重新连接客户端。");
        client = candidate;
        // Validate the native session before treating catalog failures as refresh warnings.
        state = { connected: true, account: account(), items: [] };
        return await readState();
      } catch (error) {
        client = null;
        state = {
          connected: false,
          account: null,
          items: [],
          error:
            knownMessage(error) ||
            "无法连接 Steam，请启动 Steam 并登录拥有 HOI4 的账号后重试。",
        };
        return clone(state);
      }
    });
  }

  function getState() {
    // In particular, reading status never calls createClient or loads native libraries.
    if (repairing) return Promise.resolve({ ...clone(state), repairing: true });
    return serial(() => readState());
  }

  function browse(input = {}) {
    return serial(async () => {
      try {
        const options = request(input);
        const workshop = connected();
        const queryType = SORTS.get(options.sort) ?? (options.query ? 11 : 0);
        const requiredTags = [
          ...new Set([options.category, ...options.tags].filter(Boolean)),
        ];
        const config = {
          cachedResponseMaxAge: 0,
          ...(options.query ? { searchText: options.query } : {}),
          ...(requiredTags.length ? { requiredTags } : {}),
          ...(options.excludedTags.length
            ? { excludedTags: options.excludedTags }
            : {}),
          ...(requiredTags.length && options.matchAnyTag
            ? { matchAnyTag: true }
            : {}),
          ...(["weekly", "trending"].includes(options.sort)
            ? {
                rankedByTrendDays:
                  options.sort === "weekly" ? 7 : options.trendDays,
              }
            : {}),
        };
        // UGCType.Items = 0; creator 0 matches any tool, consumer stays HOI4.
        async function readPage(page) {
          const result = await workshop.getAllItems(
            page,
            queryType,
            0,
            0,
            APP_ID,
            config,
          );
          if (
            !object(result) ||
            !Array.isArray(result.items) ||
            result.items.length > PAGE_SIZE ||
            !Number.isSafeInteger(result.totalResults) ||
            result.totalResults < 0 ||
            result.totalResults > 10000000
          )
            throw problem("Steam 返回了无效的创意工坊目录。");
          return result;
        }
        const seen = new Set(),
          items = [];
        const languageFiltered = options.language !== "all";
        let sourcePage = languageFiltered
          ? options.cursor?.page || 1
          : options.page;
        let offset = languageFiltered ? options.cursor?.offset || 0 : 0;
        let result,
          nextCursor = null;
        const deadline = Date.now() + LANGUAGE_SCAN_MS;
        for (
          let scan = 0;
          scan < (languageFiltered ? LANGUAGE_SCAN_PAGES : 1);
          scan++
        ) {
          result = await readPage(sourcePage);
          let index = offset;
          for (; index < result.items.length; index++) {
            const item = validItem(result.items[index]);
            if (
              !item ||
              seen.has(item.id) ||
              (languageFiltered &&
                item.hasChineseContent !== (options.language === "chinese"))
            )
              continue;
            seen.add(item.id);
            items.push(itemState(item, true));
            if (items.length === PAGE_SIZE) {
              index++;
              break;
            }
          }
          nextCursor =
            index < result.items.length
              ? { page: sourcePage, offset: index }
              : sourcePage * PAGE_SIZE < result.totalResults &&
                  sourcePage < 10000
                ? { page: sourcePage + 1, offset: 0 }
                : null;
          if (
            !languageFiltered ||
            !nextCursor ||
            items.length === PAGE_SIZE ||
            Date.now() >= deadline
          )
            break;
          ({ page: sourcePage, offset } = nextCursor);
        }
        return {
          items,
          page: options.page,
          totalCount: languageFiltered ? null : result.totalResults,
          totalPages: languageFiltered
            ? null
            : Math.ceil(result.totalResults / PAGE_SIZE),
          ...(languageFiltered
            ? {
                languageFiltered: true,
                hasMore: nextCursor !== null,
                nextCursor,
              }
            : {}),
        };
      } catch (error) {
        throw new Error(
          knownMessage(error) ||
            "无法读取 Steam 创意工坊，请检查客户端连接后重试。",
        );
      }
    });
  }

  function mutate(action, rawId) {
    if (repairing)
      return Promise.reject(problem("正在补齐模组，请等待当前请求完成。"));
    return serial(async () => {
      const label = {
        subscribe: "订阅",
        unsubscribe: "取消订阅",
        download: "请求下载",
      }[action];
      try {
        const id = itemId(rawId);
        const workshop = connected();
        const raw = await workshop.getItem(BigInt(id), {
          cachedResponseMaxAge: 0,
        });
        if (!validItem(raw, id))
          throw problem(
            "无法确认该模组属于 HOI4 或该模组已不可用，未执行操作。",
          );
        if (action === "download") {
          // High priority would pause the user's other Steam downloads.
          if (workshop.download(BigInt(id), false) !== true)
            throw problem(
              "Steam 未接受下载请求，请检查客户端连接和模组状态后重试。",
            );
        } else {
          await workshop[action](BigInt(id));
        }
        return await readState(`已${label}`);
      } catch (error) {
        throw new Error(
          knownMessage(error) || `Steam ${label}失败，请检查客户端连接后重试。`,
        );
      }
    });
  }

  function getItem(rawId, options = {}) {
    return serial(async () => {
      try {
        if (
          !object(options) ||
          Object.keys(options).some((key) => key !== "language") ||
          (options.language !== undefined && options.language !== "schinese")
        )
          throw problem("工坊标题语言请求无效。");
        const id = itemId(rawId);
        const workshop = connected();
        const actor = account();
        repairActor(actor.steamId);
        const raw = await workshop.getItem(BigInt(id), {
          cachedResponseMaxAge: 0,
          ...(options.language ? { language: options.language } : {}),
        });
        const item = validItem(raw, id);
        if (!item)
          throw problem(
            "无法确认该模组属于 HOI4 或该模组已不可用，未执行操作。",
          );
        repairActor(actor.steamId);
        const installed = workshop.installInfo?.(BigInt(id));
        const installation =
          installed &&
          typeof installed.folder === "string" &&
          installed.folder.length <= 4096 &&
          !/[\0-\x1f]/.test(installed.folder) &&
          Number.isSafeInteger(installed.timestamp) &&
          installed.timestamp >= 0
            ? { folder: installed.folder, timestamp: installed.timestamp }
            : null;
        return { ...itemState(item, true), account: actor, installation };
      } catch (error) {
        throw new Error(
          knownMessage(error) || "Steam 模组详情暂时不可用，请稍后重试。",
        );
      }
    });
  }

  function repairActor(expectedSteamId) {
    try {
      connected();
      if (
        typeof client.utils?.getAppId !== "function" ||
        client.utils.getAppId() !== APP_ID
      )
        throw problem("Steam 游戏身份已变化，已停止后续请求。", "APP_CHANGED");
      if (account().steamId !== expectedSteamId)
        throw problem(
          "Steam 登录账号已变化，已停止后续请求。",
          "ACCOUNT_CHANGED",
        );
    } catch (error) {
      if (error instanceof WorkshopError && error.code) throw error;
      throw problem(
        "无法核验当前 Steam 身份，已停止后续请求。",
        "IDENTITY_UNAVAILABLE",
      );
    }
  }

  function repairItem(input) {
    if (
      !object(input) ||
      Object.keys(input).some((key) => !["id", "expectedSteamId"].includes(key))
    )
      return Promise.reject(problem("Steam 补齐参数无效。"));
    let id, expectedSteamId;
    try {
      id = itemId(input.id);
      expectedSteamId = itemId(input.expectedSteamId);
      connected();
      if (repairing || (publishJob && ACTIVE_PUBLISH.has(publishJob.status)))
        throw problem("已有 Steam 请求或发布任务，请等待完成。");
    } catch (error) {
      return Promise.reject(error);
    }
    repairing = true;
    return serial(async () => {
      const result = {
        id,
        outcome: "failed",
        subscription: "unchanged",
        downloadRequest: "not-requested",
        observed: null,
        errorCode: null,
        error: null,
      };
      let item;
      try {
        repairActor(expectedSteamId);
        const workshop = connected();
        const raw = await workshop.getItem(BigInt(id), {
          cachedResponseMaxAge: 0,
        });
        repairActor(expectedSteamId);
        item = validItem(raw, id);
        if (!item || raw.banned !== false)
          throw problem(
            "无法确认该模组属于 HOI4 或模组已不可用，未执行请求。",
            "ITEM_UNAVAILABLE",
          );
        result.observed = itemState(item);
        repairActor(expectedSteamId);
        if (!result.observed.subscribed) {
          result.subscription = "unknown";
          await workshop.subscribe(BigInt(id));
          repairActor(expectedSteamId);
          result.subscription = "confirmed";
          result.observed = itemState(item);
        }
        repairActor(expectedSteamId);
        if (result.observed.downloading || result.observed.pending) {
          result.downloadRequest = "already-active";
          result.outcome = "submitted";
        } else if (result.observed.installed && !result.observed.needsUpdate) {
          result.outcome = "already-present";
        } else {
          result.downloadRequest = "unknown";
          const accepted = workshop.download(BigInt(id), false);
          if (accepted !== true) {
            result.downloadRequest = "rejected";
            throw problem(
              "Steam 未接受此模组的下载请求，可刷新状态后再试。",
              "DOWNLOAD_REJECTED",
            );
          }
          result.downloadRequest = "accepted";
          result.outcome = "submitted";
          repairActor(expectedSteamId);
          result.observed = itemState(item);
        }
      } catch (caught) {
        let error = caught;
        try {
          repairActor(expectedSteamId);
        } catch (actorError) {
          error = actorError;
        }
        result.errorCode =
          error instanceof WorkshopError && error.code
            ? error.code
            : "STEAM_REQUEST_FAILED";
        result.error =
          knownMessage(error) ||
          "Steam 未确认操作结果，请刷新状态核对后再操作。";
        if (
          result.subscription === "unknown" ||
          result.downloadRequest === "unknown"
        )
          result.outcome = "unknown";
        else if (
          ["ACCOUNT_CHANGED", "APP_CHANGED", "IDENTITY_UNAVAILABLE"].includes(
            result.errorCode,
          )
        )
          result.outcome = "failed";
        else if (result.downloadRequest === "accepted")
          result.outcome = "submitted";
        else result.outcome = "failed";
      }
      return result;
    }).finally(() => {
      repairing = false;
    });
  }

  async function ownedPublishTarget(rawId, expectedOwner) {
    const id = itemId(rawId);
    const workshop = connected();
    const owner = account().steamId;
    if (expectedOwner !== undefined && owner !== expectedOwner)
      throw problem("Steam 登录账号已改变，请重新确认发布目标。");
    const raw = await workshop.getItem(BigInt(id), { cachedResponseMaxAge: 0 });
    const item = validItem(raw, id);
    if (!item || raw.banned !== false)
      throw problem("无法确认发布目标属于 HOI4 或该模组已不可用，未执行更新。");
    let itemOwner;
    try {
      itemOwner = itemId(raw.owner?.steamId64, true);
    } catch {
      throw problem("无法确认模组作者，未执行更新。");
    }
    if (itemOwner !== owner)
      throw problem("此模组不属于当前 Steam 账号，不能更新。");
    if (account().steamId !== owner)
      throw problem("Steam 登录账号已改变，请重新确认发布目标。");
    return { id: item.id, name: item.name, owned: true };
  }

  function validatePublishTarget(id) {
    return serial(async () => {
      try {
        return await ownedPublishTarget(id);
      } catch (error) {
        throw new Error(
          knownMessage(error) ||
            "无法核验 Steam 发布目标，请检查客户端连接后重试。",
        );
      }
    });
  }

  function getPublishStatus() {
    // Uploads can take hours. Status is an in-memory snapshot, never queued.
    return publishJob ? clone(publishJob) : null;
  }

  function upload(workshop, job, details) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      const success = (result) => {
        if (settled) return;
        try {
          if (
            !object(result) ||
            itemId(result.itemId, true) !== job.itemId ||
            typeof result.needsToAcceptAgreement !== "boolean"
          )
            throw problem(
              "Steam 发布回执无效，无法确认提交结果，请核对已保留的模组编号。",
            );
          settled = true;
          job.needsAgreement = result.needsToAcceptAgreement;
          job.status = job.needsAgreement ? "agreement-required" : "succeeded";
          publishChanged(job);
          resolve();
        } catch (error) {
          fail(error);
        }
      };
      const progress = (value) => {
        if (
          settled ||
          !object(value) ||
          !Number.isInteger(value.status) ||
          value.status < 0 ||
          value.status > 5
        )
          return;
        let processedBytes = byteCount(value.progress),
          totalBytes = byteCount(value.total);
        if (
          processedBytes === null ||
          totalBytes === null ||
          processedBytes > totalBytes
        )
          processedBytes = totalBytes = null;
        job.progress = { stage: value.status, processedBytes, totalBytes };
        publishChanged(job);
      };
      // SubmitItemUpdate has no cancellation API. Do not time out or release the
      // queue while Steam may still be uploading this item.
      try {
        workshop.updateItemWithCallback(
          BigInt(job.itemId),
          details,
          APP_ID,
          success,
          fail,
          progress,
          500,
        );
      } catch (error) {
        fail(error);
      }
    });
  }

  async function runPublish(options, job, owner) {
    try {
      const workshop = connected();
      if (account().steamId !== owner)
        throw problem("Steam 登录账号已改变，请重新确认发布目标。");
      if (options.existingItemId) {
        await ownedPublishTarget(options.existingItemId, owner);
      } else {
        job.status = "creating";
        publishChanged(job);
        const created = await workshop.createItem(APP_ID);
        // Preserve a valid new ID even if a later field or upload is invalid.
        if (object(created)) {
          job.itemId = itemId(created.itemId, true);
          publishChanged(job);
        }
        if (!job.itemId || typeof created.needsToAcceptAgreement !== "boolean")
          throw problem(
            "Steam 创建回执无效，请核对创意工坊中的模组编号后重试。",
          );
        job.needsAgreement = created.needsToAcceptAgreement;
        if (job.needsAgreement) {
          job.status = "agreement-required";
          publishChanged(job);
          return;
        }
      }
      if (account().steamId !== owner)
        throw problem(
          "Steam 登录账号已改变，已保留模组编号，请重新确认后继续上传。",
        );
      job.status = "uploading";
      publishChanged(job);
      await upload(workshop, job, options.details);
    } catch (error) {
      job.status = "failed";
      job.error =
        knownMessage(error) ||
        "Steam 未确认发布成功。请检查客户端连接，并核对已保留的模组编号后重试。";
      publishChanged(job);
    }
  }

  function startPublish(input) {
    try {
      if (repairing) throw problem("正在补齐模组，请等待当前请求完成后发布。");
      const options = publishRequest(input);
      const workshop = connected();
      if (
        typeof workshop.createItem !== "function" ||
        typeof workshop.updateItemWithCallback !== "function"
      )
        throw problem("Steam 客户端不支持发布，请更新客户端后重试。");
      if (publishIds.has(options.id))
        throw problem("此发布任务已经提交，不能重复执行。请查看原任务状态。");
      if (publishJob && ACTIVE_PUBLISH.has(publishJob.status))
        throw problem("已有 Steam 发布任务进行中，请等待其完成。");
      if (publishIds.size >= 10000)
        throw problem(
          "本次会话的发布任务过多，请在没有进行中的任务时重启启动器。",
        );
      const owner = account().steamId;
      const job = {
        id: options.id,
        status: "queued",
        itemId: options.existingItemId,
        progress: null,
        needsAgreement: false,
        error: null,
      };
      publishIds.add(options.id);
      publishJob = job;
      // Queue before returning so all later writes remain behind this upload.
      void serial(() => runPublish(options, job, owner));
      publishChanged(job);
      return clone(job);
    } catch (error) {
      throw new Error(
        knownMessage(error) || "无法开始 Steam 发布，请检查客户端连接后重试。",
      );
    }
  }

  return {
    connect,
    getState,
    browse,
    getItem,
    subscribe: (id) => mutate("subscribe", id),
    unsubscribe: (id) => mutate("unsubscribe", id),
    download: (id) => mutate("download", id),
    repairItem,
    validatePublishTarget,
    startPublish,
    getPublishStatus,
  };
}

module.exports = { createSteamWorkshopService };
