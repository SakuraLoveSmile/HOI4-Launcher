"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const {
  diagnostic,
  diagnosticError,
  errorDiagnostic,
} = require("./diagnostic-message.cjs");
const CATALOG_ERROR = Symbol("mod-catalog-error");

const API_URL = "https://api.paradox-interactive.com/mods";
const PAGE_SIZE = 12;
const MAX_BYTES = 1024 * 1024;
const CACHE_TTL = 15 * 60 * 1000;
const MAX_CACHE_ENTRIES = 20;
const TIMEOUT_MS = 8000;
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const clone = (value) => JSON.parse(JSON.stringify(value));

function normalizeRequest(input = {}) {
  if (
    !object(input) ||
    Object.keys(input).some((key) => !["query", "sort", "page"].includes(key))
  )
    throw failure("模组目录查询参数无效。");
  const { query = "", sort = "best", page = 0 } = input;
  if (
    typeof query !== "string" ||
    query.length > 120 ||
    /[\0-\x1f\x7f]/.test(query)
  )
    throw failure("搜索关键词须为不超过 120 个字符的单行文字。");
  if (!["best", "recent"].includes(sort))
    throw failure("不支持此模组排序方式。");
  if (!Number.isInteger(page) || page < 0 || page > 10000)
    throw failure("模组目录页码须为 0 至 10000 的整数。");
  return { query: query.trim(), sort, page };
}

function cacheKey(request) {
  return JSON.stringify([request.query, request.sort, request.page]);
}

function plainText(value, max) {
  if (typeof value !== "string") return "";
  const entities = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  };
  let text = value.slice(0, 100000);
  for (let pass = 0; pass < 2; pass++)
    text = text.replace(
      /&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,
      (whole, entity) => {
        if (entity[0] !== "#") return entities[entity.toLowerCase()] || whole;
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
  text = text
    .replace(
      /<(script|style|iframe|svg|object)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
      " ",
    )
    .replace(/\[(img|video|youtube)(?:=[^\]]*)?\][\s\S]*?\[\/\1\]/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\[\/?[a-z*][^\]]*\]/gi, " ")
    .replace(/[\0-\x1f\x7f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? text.slice(0, max - 1).trimEnd() + "…" : text;
}

function thumbnail(value) {
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
    url.protocol !== "https:" ||
    url.hostname !== "modscontent.paradox-interactive.com" ||
    url.port ||
    url.username ||
    url.password ||
    !/^\/hoi4\/[a-z0-9_-]+\/content\/[a-z0-9%._/-]+\.(?:png|jpe?g|webp|gif|bmp)$/i.test(
      url.pathname,
    )
  )
    return null;
  url.search = "";
  url.hash = "";
  return url.href;
}

function normalizeItem(item, cached = false) {
  if (!object(item)) return null;
  if (!cached && (item.game !== "hoi4" || item.state !== "published"))
    return null;
  const rawId = cached ? item.id : item.modId;
  const id = Number.isSafeInteger(rawId) && rawId > 0 ? String(rawId) : rawId;
  if (typeof id !== "string" || !/^[1-9]\d{0,19}$/.test(id)) return null;
  const name = plainText(cached ? item.name : item.displayName, 160);
  if (!name) return null;
  const url = `https://mods.paradoxplaza.com/mods/${id}/Any`;
  if (cached && item.url !== url) return null;
  return {
    id,
    name,
    author: plainText(item.author, 100),
    requiredVersion: plainText(item.requiredVersion, 60),
    description: plainText(
      cached ? item.description : item.shortDescription,
      350,
    ),
    url,
    thumbnailUrl: thumbnail(cached ? item.thumbnailUrl : item.displayImagePath),
  };
}

function normalizeResults(data, request, cached = false) {
  const entries = cached ? data?.items : data?.mods;
  if (
    !object(data) ||
    (!cached && data.result !== "OK") ||
    !Number.isInteger(data.totalCount) ||
    data.totalCount < 0 ||
    data.totalCount > 10_000_000 ||
    !Array.isArray(entries) ||
    entries.length > PAGE_SIZE
  )
    throw failure("Paradox Mods 返回的目录格式无效。");
  const seen = new Set(),
    items = [];
  for (const entry of entries) {
    const item = normalizeItem(entry, cached);
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    items.push(item);
  }
  if (request.page * PAGE_SIZE < data.totalCount && !items.length)
    throw failure("未收到可展示的 HOI4 已发布模组。");
  return { items, totalCount: data.totalCount };
}

function failure(key, values = []) {
  const error = diagnosticError(key, values);
  error[CATALOG_ERROR] = true;
  return error;
}

async function boundedBody(response, controller) {
  if (Number(response.headers?.get?.("content-length")) > MAX_BYTES) {
    controller.abort();
    throw failure("模组目录响应过大，已停止读取。");
  }
  if (!response.body?.getReader) {
    controller.abort();
    throw failure("模组目录响应不支持安全读取。");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array))
        throw failure("模组目录响应格式无效。");
      size += value.byteLength;
      if (size > MAX_BYTES) {
        controller.abort();
        throw failure("模组目录响应过大，已停止读取。");
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size).toString("utf8");
}

async function fetchResults(fetchImpl, request) {
  const body = {
    gameNames: ["hoi4"],
    orderBy: "desc",
    sortBy: request.sort === "recent" ? "updated" : "best",
    pageSize: PAGE_SIZE,
    page: request.page,
    states: ["published"],
  };
  // Confirmed by the public site and anonymous API: search/query are ignored.
  if (request.query) body.searchQuery = request.query;
  if (request.sort === "best") body.time = "quarter";
  const controller = new AbortController();
  let timer,
    timedOut = false;
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(failure("读取 Paradox Mods 超时，请稍后重试。"));
    }, TIMEOUT_MS);
  });
  const operation = (async () => {
    const response = await fetchImpl(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      credentials: "omit",
      redirect: "error",
      signal: controller.signal,
      body: JSON.stringify(body),
    });
    if (!response?.ok)
      throw Number.isInteger(response?.status)
        ? failure("Paradox Mods 暂不可用（HTTP {0}）。", [response.status])
        : failure("Paradox Mods 返回了无效响应。");
    const text = await boundedBody(response, controller);
    let data;
    try {
      data = JSON.parse(text.replace(/^\uFEFF/, ""));
    } catch {
      throw failure("无法解析 Paradox Mods 目录数据。");
    }
    return normalizeResults(data, request);
  })();
  try {
    return await Promise.race([operation, deadline]);
  } catch (error) {
    if (timedOut || error?.name === "AbortError")
      throw failure("读取 Paradox Mods 超时，请稍后重试。");
    if (error?.[CATALOG_ERROR]) throw error;
    throw failure("暂时无法连接 Paradox Mods，请检查网络或稍后重试。");
  } finally {
    clearTimeout(timer);
  }
}

async function atomicCache(cachePath, data) {
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  const temporary = cachePath + ".tmp-" + randomUUID();
  try {
    await fs.writeFile(temporary, JSON.stringify(data), {
      flag: "wx",
      encoding: "utf8",
    });
    await fs.rename(temporary, cachePath);
  } finally {
    await fs.unlink(temporary).catch(() => {});
  }
}

function createModCatalogService({
  fetchImpl = globalThis.fetch,
  cachePath,
  now = Date.now,
} = {}) {
  if (
    typeof fetchImpl !== "function" ||
    typeof now !== "function" ||
    (cachePath !== undefined &&
      (typeof cachePath !== "string" ||
        !path.isAbsolute(cachePath) ||
        /[\0-\x1f]/.test(cachePath)))
  )
    throw failure("模组目录服务配置无效。");
  const cache = new Map(),
    inFlight = new Map();
  let loaded = false,
    loading = null,
    writeQueue = Promise.resolve();

  function prune() {
    const entries = [...cache.entries()].sort(
      (a, b) => Date.parse(b[1].fetchedAt) - Date.parse(a[1].fetchedAt),
    );
    for (const [key] of entries.slice(MAX_CACHE_ENTRIES)) cache.delete(key);
  }

  async function loadCache() {
    if (loaded) return;
    if (!loading)
      loading = (async () => {
        try {
          if (!cachePath) return;
          const stat = await fs.stat(cachePath);
          if (!stat.isFile() || stat.size > MAX_BYTES) return;
          const data = JSON.parse(
            (await fs.readFile(cachePath, "utf8")).replace(/^\uFEFF/, ""),
          );
          if (
            !object(data) ||
            data.version !== 1 ||
            data.game !== "hoi4" ||
            data.pageSize !== PAGE_SIZE ||
            !Array.isArray(data.entries) ||
            data.entries.length > MAX_CACHE_ENTRIES
          )
            return;
          for (const entry of data.entries) {
            try {
              if (!object(entry)) continue;
              const request = normalizeRequest(entry.request);
              const timestamp =
                typeof entry.fetchedAt === "string"
                  ? Date.parse(entry.fetchedAt)
                  : NaN;
              if (
                !Number.isFinite(timestamp) ||
                timestamp < Date.UTC(2000, 0, 1) ||
                timestamp > now() + 5 * 60 * 1000
              )
                continue;
              const results = normalizeResults(entry, request, true);
              cache.set(cacheKey(request), {
                request,
                fetchedAt: new Date(timestamp).toISOString(),
                ...results,
              });
            } catch {
              /* An invalid entry never becomes a fallback for a different query. */
            }
          }
        } catch {
          /* A disposable cache is optional; live queries still work. */
        } finally {
          loaded = true;
          loading = null;
        }
      })();
    await loading;
  }

  function saveCache() {
    if (!cachePath) return Promise.resolve();
    const job = writeQueue.then(() =>
      atomicCache(cachePath, {
        version: 1,
        game: "hoi4",
        pageSize: PAGE_SIZE,
        entries: [...cache.values()],
      }),
    );
    writeQueue = job.catch(() => {});
    return job;
  }

  function publicResult(
    request,
    entry,
    source,
    error = null,
    errorInfo = null,
  ) {
    const totalCount = entry?.totalCount || 0;
    return {
      items: entry?.items || [],
      page: request.page,
      pageSize: PAGE_SIZE,
      totalCount,
      totalPages: Math.ceil(totalCount / PAGE_SIZE),
      source,
      fetchedAt: entry?.fetchedAt || null,
      error,
      ...(error && errorInfo ? { errorDiagnostic: errorInfo } : {}),
    };
  }

  async function search(input = {}) {
    let request;
    try {
      request = normalizeRequest(input);
    } catch (error) {
      return publicResult(
        { page: 0 },
        null,
        "unavailable",
        error.message,
        errorDiagnostic(error),
      );
    }
    await loadCache();
    const key = cacheKey(request),
      existing = cache.get(key),
      nowMs = now();
    const fetchedMs = existing ? Date.parse(existing.fetchedAt) : NaN;
    if (existing && nowMs >= fetchedMs && nowMs - fetchedMs < CACHE_TTL)
      return clone(publicResult(request, existing, "cache"));
    if (!inFlight.has(key)) {
      const pending = (async () => {
        try {
          const results = await fetchResults(fetchImpl, request);
          const entry = {
            request,
            ...results,
            fetchedAt: new Date(now()).toISOString(),
          };
          cache.set(key, entry);
          prune();
          let error = null;
          try {
            await saveCache();
          } catch {
            error = "目录已获取，但本地缓存暂时无法保存。";
          }
          return publicResult(
            request,
            entry,
            "live",
            error,
            error ? diagnostic(error) : null,
          );
        } catch (error) {
          const fallback = cache.get(key);
          return publicResult(
            request,
            fallback,
            fallback ? "cache" : "unavailable",
            error.message + (fallback ? " 当前显示该查询的上次缓存。" : ""),
            fallback
              ? diagnostic("{0} 当前显示该查询的上次缓存。", [
                  errorDiagnostic(error),
                ])
              : errorDiagnostic(error),
          );
        }
      })().finally(() => {
        inFlight.delete(key);
      });
      inFlight.set(key, pending);
    }
    return clone(await inFlight.get(key));
  }

  return { search };
}

module.exports = { createModCatalogService };
