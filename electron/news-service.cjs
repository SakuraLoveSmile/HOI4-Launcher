"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const {
  diagnostic,
  diagnosticError,
  errorDiagnostic,
} = require("./diagnostic-message.cjs");
const NEWS_ERROR = Symbol("news-service-error");
function failure(key, values = []) {
  const error = diagnosticError(key, values);
  error[NEWS_ERROR] = true;
  return error;
}

const APP_ID = 394360;
const FRESH_MS = 15 * 60 * 1000;
const TIMEOUT_MS = 8000;
const MAX_BYTES = 512 * 1024;
const MAX_ITEMS = 6;
const NEWS_URL =
  "https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=394360&count=6&maxlength=350&feeds=steam_community_announcements&format=json";
const clone = (value) => JSON.parse(JSON.stringify(value));
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function textOnly(value, limit) {
  if (typeof value !== "string") return "";
  let text = value.slice(0, 100000);
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  for (let pass = 0; pass < 2; pass++) {
    text = text.replace(
      /&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,
      (whole, entity) => {
        if (entity[0] !== "#") return named[entity.toLowerCase()] || whole;
        const code = /^#x/i.test(entity)
          ? parseInt(entity.slice(2), 16)
          : Number(entity.slice(1));
        return Number.isInteger(code) &&
          code > 0 &&
          code <= 0x10ffff &&
          !(code >= 0xd800 && code <= 0xdfff)
          ? String.fromCodePoint(code)
          : " ";
      },
    );
  }
  text = text
    .replace(
      /<(script|style|iframe|object|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
      " ",
    )
    .replace(
      /\[(img|previewyoutube|youtube|video|media)(?:=[^\]]*)?\][\s\S]*?\[\/\1\]/gi,
      " ",
    )
    .replace(/<[^>]*>/g, " ")
    .replace(/\[\/?[a-z*][^\]]*\]/gi, " ")
    .replace(/\{STEAM_CLAN_IMAGE\}[^\s]*/g, " ")
    .replace(/[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > limit ? text.slice(0, limit - 1).trimEnd() + "…" : text;
}

function articleUrl(value) {
  if (
    typeof value !== "string" ||
    value.length > 2048 ||
    /[\0-\x20\x7f]/.test(value)
  )
    return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.port
  )
    return null;
  const host = url.hostname.toLowerCase();
  const pathname = url.pathname;
  let allowed = false;
  if (["store.steampowered.com", "steamstore-a.akamaihd.net"].includes(host)) {
    allowed =
      /^\/news\/app\/394360\/view\/\d+\/?$/.test(pathname) ||
      /^\/news\/externalpost\/steam_community_announcements\/\d+\/?$/.test(
        pathname,
      );
    if (allowed) url.hostname = "store.steampowered.com";
  } else if (["steamcommunity.com", "www.steamcommunity.com"].includes(host)) {
    allowed =
      /^\/(?:games|ogg)\/(?:394360|hoi4)\/announcements\/detail\/\d+\/?$/i.test(
        pathname,
      ) || /^\/gid\/\d+\/announcements\/detail\/\d+\/?$/.test(pathname);
    if (allowed) url.hostname = "steamcommunity.com";
  } else if (
    ["paradoxinteractive.com", "www.paradoxinteractive.com"].includes(host)
  ) {
    allowed =
      /^\/games\/hearts-of-iron-iv\/news\/[a-z0-9][a-z0-9/_-]*\/?$/i.test(
        pathname,
      );
    if (allowed) url.hostname = "www.paradoxinteractive.com";
  } else if (host === "forum.paradoxplaza.com") {
    allowed =
      /^\/forum\/(?:threads|developer-diary)\/[a-z0-9][a-z0-9._/-]*\/?$/i.test(
        pathname,
      );
  }
  if (!allowed) return null;
  url.protocol = "https:";
  url.search = "";
  url.hash = "";
  return url.href;
}

function safeDate(value, nowMs, seconds = false) {
  const timestamp =
    seconds && typeof value === "number"
      ? value * 1000
      : typeof value === "string"
        ? Date.parse(value)
        : NaN;
  if (
    !Number.isFinite(timestamp) ||
    timestamp < Date.UTC(2000, 0, 1) ||
    timestamp > nowMs + 7 * 24 * 60 * 60 * 1000
  )
    return null;
  return new Date(timestamp).toISOString();
}

function normalizeItems(items, nowMs, fromCache) {
  if (!Array.isArray(items) || items.length > 100)
    throw failure("Steam 返回的新闻列表格式无效。");
  const result = [],
    seen = new Set();
  for (const item of items) {
    if (!object(item)) continue;
    if (
      !fromCache &&
      (item.feedname !== "steam_community_announcements" ||
        (item.appid !== undefined && item.appid !== APP_ID))
    )
      continue;
    const id = fromCache ? item.id : item.gid;
    const title = textOnly(item.title, 240);
    const excerpt = textOnly(fromCache ? item.excerpt : item.contents, 350);
    const url = articleUrl(item.url);
    const date = safeDate(item.date, nowMs, !fromCache);
    if (
      typeof id !== "string" ||
      !/^\d{1,30}$/.test(id) ||
      !title ||
      !url ||
      !date ||
      seen.has(id)
    )
      continue;
    seen.add(id);
    result.push({ id, title, excerpt, url, date });
  }
  return result
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, MAX_ITEMS);
}

async function readBoundedResponse(response, controller) {
  const contentLength = response.headers?.get?.("content-length");
  if (contentLength && Number(contentLength) > MAX_BYTES) {
    controller.abort();
    throw failure("新闻响应超过大小限制，已停止读取。");
  }
  if (!response.body?.getReader) {
    controller.abort();
    throw failure("Steam 返回的新闻响应不支持安全读取。");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array))
        throw failure("Steam 返回的新闻响应格式无效。");
      length += value.byteLength;
      if (length > MAX_BYTES) {
        controller.abort();
        throw failure("新闻响应超过大小限制，已停止读取。");
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, length).toString("utf8");
}

async function fetchItems(fetchImpl, nowMs) {
  const controller = new AbortController();
  let timedOut = false,
    timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new Error("timeout"));
    }, TIMEOUT_MS);
  });
  const request = (async () => {
    const response = await fetchImpl(NEWS_URL, {
      method: "GET",
      headers: { Accept: "application/json" },
      redirect: "error",
      signal: controller.signal,
    });
    if (!response || !response.ok)
      throw Number.isInteger(response?.status)
        ? failure("Steam 官方新闻服务暂不可用（HTTP {0}）。", [response.status])
        : failure("Steam 官方新闻服务返回了无效响应。");
    const text = await readBoundedResponse(response, controller);
    let parsed;
    try {
      parsed = JSON.parse(text.replace(/^\uFEFF/, ""));
    } catch {
      throw failure("Steam 返回的新闻数据无法解析。");
    }
    if (!object(parsed?.appnews) || parsed.appnews.appid !== APP_ID)
      throw failure("Steam 返回的公告不属于钢铁雄心 IV。");
    const items = normalizeItems(parsed.appnews.newsitems, nowMs, false);
    if (!items.length) throw failure("暂未取得可信的 HOI4 官方公告。");
    return items;
  })();
  try {
    return await Promise.race([request, timeout]);
  } catch (error) {
    if (timedOut || error?.name === "AbortError")
      throw failure("读取 Steam 官方新闻超时，请稍后重试。");
    if (error?.[NEWS_ERROR]) throw error;
    throw failure("暂时无法连接 Steam 官方新闻服务，请检查网络或稍后重试。");
  } finally {
    clearTimeout(timer);
  }
}

async function saveCache(cachePath, snapshot) {
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  const temporary = cachePath + ".tmp-" + randomUUID();
  try {
    await fs.writeFile(temporary, JSON.stringify(snapshot, null, 2), {
      encoding: "utf8",
      flag: "wx",
    });
    await fs.rename(temporary, cachePath);
  } finally {
    await fs.unlink(temporary).catch(() => {});
  }
}

function createNewsService({
  cachePath,
  fetchImpl = globalThis.fetch,
  now = Date.now,
} = {}) {
  if (
    typeof cachePath !== "string" ||
    !path.isAbsolute(cachePath) ||
    /[\0-\x1f]/.test(cachePath)
  )
    throw failure("新闻缓存必须位于启动器的绝对文件路径。");
  if (typeof fetchImpl !== "function" || typeof now !== "function")
    throw failure("新闻服务配置无效。");
  let snapshot = null;
  let cacheLoaded = false;
  let loadingCache = null;
  let pending = null;

  async function loadCache() {
    if (cacheLoaded) return snapshot;
    if (!loadingCache)
      loadingCache = (async () => {
        try {
          const stat = await fs.stat(cachePath);
          if (!stat.isFile() || stat.size > MAX_BYTES) return null;
          const parsed = JSON.parse(
            (await fs.readFile(cachePath, "utf8")).replace(/^\uFEFF/, ""),
          );
          const nowMs = now();
          const timestamp =
            typeof parsed?.fetchedAt === "string"
              ? Date.parse(parsed.fetchedAt)
              : NaN;
          if (
            !object(parsed) ||
            parsed.version !== 1 ||
            parsed.appId !== APP_ID ||
            !Number.isFinite(timestamp) ||
            timestamp < Date.UTC(2000, 0, 1) ||
            timestamp > nowMs + 5 * 60 * 1000
          )
            return null;
          const items = normalizeItems(parsed.items, nowMs, true);
          if (!items.length) return null;
          snapshot = {
            version: 1,
            appId: APP_ID,
            fetchedAt: new Date(timestamp).toISOString(),
            items,
          };
          return snapshot;
        } catch {
          return null;
        } finally {
          cacheLoaded = true;
          loadingCache = null;
        }
      })();
    return loadingCache;
  }

  async function getNews({ refresh = false } = {}) {
    await loadCache();
    const nowMs = now();
    const fetchedMs = snapshot ? Date.parse(snapshot.fetchedAt) : NaN;
    if (
      !refresh &&
      snapshot &&
      nowMs >= fetchedMs &&
      nowMs - fetchedMs < FRESH_MS
    )
      return clone({
        items: snapshot.items,
        source: "cache",
        fetchedAt: snapshot.fetchedAt,
        error: null,
      });
    if (!pending) {
      pending = (async () => {
        try {
          const items = await fetchItems(fetchImpl, nowMs);
          snapshot = {
            version: 1,
            appId: APP_ID,
            fetchedAt: new Date(now()).toISOString(),
            items,
          };
          let error = null;
          try {
            await saveCache(cachePath, snapshot);
          } catch {
            error = "官方新闻已更新，但本地缓存暂时无法保存。";
          }
          return {
            items,
            source: "live",
            fetchedAt: snapshot.fetchedAt,
            error,
            ...(error ? { errorDiagnostic: diagnostic(error) } : {}),
          };
        } catch (error) {
          return snapshot
            ? {
                items: snapshot.items,
                source: "cache",
                fetchedAt: snapshot.fetchedAt,
                error: error.message + " 当前显示上次缓存。",
                errorDiagnostic: diagnostic("{0} 当前显示上次缓存。", [
                  errorDiagnostic(error),
                ]),
              }
            : {
                items: [],
                source: "unavailable",
                fetchedAt: null,
                error: error.message,
                errorDiagnostic: errorDiagnostic(error),
              };
        }
      })().finally(() => {
        pending = null;
      });
    }
    return clone(await pending);
  }

  return { getNews };
}

module.exports = { createNewsService };
