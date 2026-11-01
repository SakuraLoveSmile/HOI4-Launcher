"use strict";

const path = require("node:path");
const { performance } = require("node:perf_hooks");

const MAX_HANDLE = 0xffffffffffffffffn;
const CALLBACK_ID = 3401;
// Windows x64, SteamUGC v020, SDK headers pinned by steamworks.js 0.4.0.
// Both structs use the SDK's 8-byte Windows callback packing. Keep the final
// m_ulTotalFilesSize field: omitting it would let GetQueryUGCResult overrun memory.
const CALLBACK_BYTES = 280;
const DETAILS_BYTES = 9784;
const PAGE_SIZE = 50;
const MAX_TIMEOUT_MS = 20000;
const DEFAULT_TIMEOUT_MS = 6000;
const waitArray = new Int32Array(new SharedArrayBuffer(4));

function failure(message) {
  return Object.assign(new Error(message), {
    code: "STEAM_WORKSHOP_NATIVE_QUERY_FAILED",
  });
}

function unsigned(value, max = 0xffffffff) {
  return Number.isSafeInteger(value) && value >= 0 && value <= max;
}

function handle(value) {
  const result =
    typeof value === "bigint"
      ? value
      : unsigned(value, Number.MAX_SAFE_INTEGER)
        ? BigInt(value)
        : 0n;
  return result > 0n && result < MAX_HANDLE ? result : null;
}

function cString(buffer, offset = 0, length = buffer.length - offset) {
  const end = buffer.indexOf(0, offset);
  return buffer.toString(
    "utf8",
    offset,
    end >= offset && end < offset + length ? end : offset + length,
  );
}

function validate(
  page,
  queryType,
  ugcType,
  creatorAppId,
  consumerAppId,
  config,
) {
  const fields = new Set([
    "cachedResponseMaxAge",
    "requiredTags",
    "excludedTags",
    "matchAnyTag",
    "searchText",
    "rankedByTrendDays",
  ]);
  if (
    !unsigned(page, 10000) ||
    !page ||
    !unsigned(queryType, 21) ||
    !unsigned(ugcType, 13) ||
    !unsigned(creatorAppId) ||
    !unsigned(consumerAppId) ||
    !config ||
    typeof config !== "object" ||
    Array.isArray(config) ||
    Object.keys(config).some((key) => !fields.has(key))
  )
    throw failure("Steam 扩展工坊查询参数无效。");
  const validText = (value, max) =>
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= max &&
    !/[\0-\x1f\x7f]/.test(value);
  const validTags = (tags) =>
    Array.isArray(tags) &&
    tags.length <= 32 &&
    tags.every((tag) => validText(tag, 255) && !tag.includes(","));
  if (
    (config.cachedResponseMaxAge !== undefined &&
      !unsigned(config.cachedResponseMaxAge)) ||
    (config.matchAnyTag !== undefined &&
      typeof config.matchAnyTag !== "boolean") ||
    (config.searchText !== undefined && !validText(config.searchText, 480)) ||
    (config.rankedByTrendDays !== undefined &&
      (!unsigned(config.rankedByTrendDays, 365) ||
        !config.rankedByTrendDays)) ||
    ["requiredTags", "excludedTags"].some(
      (field) => config[field] !== undefined && !validTags(config[field]),
    )
  )
    throw failure("Steam 扩展工坊查询参数无效。");
}

function loadNativeApi() {
  if (process.platform !== "win32" || process.arch !== "x64")
    throw failure("此 Steam 扩展排序仅支持 Windows x64。");
  const koffi = require("koffi");
  const steamDirectory = path.dirname(require.resolve("steamworks.js"));
  const libraryPath = path
    .join(steamDirectory, "dist", "win64", "steam_api64.dll")
    .replace(/\.asar([\\/])/i, ".asar.unpacked$1");
  // Loading the same DLL shares the session already initialized by steamworks.js.
  // This module deliberately never calls SteamAPI_Init or SteamAPI_Shutdown.
  const library = koffi.load(libraryPath);
  const ugc = library.func("void *SteamAPI_SteamUGC_v020()")();
  const utils = library.func("void *SteamAPI_SteamUtils_v010()")();
  const pipe = library.func("int32_t SteamAPI_GetHSteamPipe()")();
  if (!ugc || !utils || !Number.isInteger(pipe) || pipe <= 0)
    throw failure("Steam 会话尚未初始化，无法使用扩展排序。");
  const onUgc = (signature) => {
    const fn = library.func(signature);
    return (...args) => fn(ugc, ...args);
  };
  const runFrame = library.func(
    "void SteamAPI_ManualDispatch_RunFrame(int32_t pipe)",
  );
  const completed = library.func(
    "bool SteamAPI_ISteamUtils_IsAPICallCompleted(void *self, uint64_t call, void *failed)",
  );
  const getResult = library.func(
    "bool SteamAPI_ISteamUtils_GetAPICallResult(void *self, uint64_t call, void *result, int32_t bytes, int32_t expected, void *failed)",
  );
  return {
    createQuery: onUgc(
      "uint64_t SteamAPI_ISteamUGC_CreateQueryAllUGCRequestPage(void *self, int32_t queryType, int32_t ugcType, uint32_t creator, uint32_t consumer, uint32_t page)",
    ),
    setCachedAge: onUgc(
      "bool SteamAPI_ISteamUGC_SetAllowCachedResponse(void *self, uint64_t query, uint32_t seconds)",
    ),
    setMatchAnyTag: onUgc(
      "bool SteamAPI_ISteamUGC_SetMatchAnyTag(void *self, uint64_t query, bool matchAny)",
    ),
    addRequiredTag: onUgc(
      "bool SteamAPI_ISteamUGC_AddRequiredTag(void *self, uint64_t query, const char *tag)",
    ),
    addExcludedTag: onUgc(
      "bool SteamAPI_ISteamUGC_AddExcludedTag(void *self, uint64_t query, const char *tag)",
    ),
    setSearchText: onUgc(
      "bool SteamAPI_ISteamUGC_SetSearchText(void *self, uint64_t query, const char *search)",
    ),
    setTrendDays: onUgc(
      "bool SteamAPI_ISteamUGC_SetRankedByTrendDays(void *self, uint64_t query, uint32_t days)",
    ),
    sendQuery: onUgc(
      "uint64_t SteamAPI_ISteamUGC_SendQueryUGCRequest(void *self, uint64_t query)",
    ),
    runFrame: () => runFrame(pipe),
    isCallCompleted: (call, failed) => completed(utils, call, failed),
    getCallResult: (call, result, bytes, expected, failed) =>
      getResult(utils, call, result, bytes, expected, failed),
    getItem: onUgc(
      "bool SteamAPI_ISteamUGC_GetQueryUGCResult(void *self, uint64_t query, uint32_t index, void *details)",
    ),
    getPreview: onUgc(
      "bool SteamAPI_ISteamUGC_GetQueryUGCPreviewURL(void *self, uint64_t query, uint32_t index, void *url, uint32_t bytes)",
    ),
    getStatistic: onUgc(
      "bool SteamAPI_ISteamUGC_GetQueryUGCStatistic(void *self, uint64_t query, uint32_t index, int32_t statistic, void *value)",
    ),
    releaseQuery: onUgc(
      "bool SteamAPI_ISteamUGC_ReleaseQueryUGCRequest(void *self, uint64_t query)",
    ),
  };
}

function readItem(api, query, index) {
  const details = Buffer.alloc(DETAILS_BYTES);
  if (!api.getItem(query, index, details))
    throw failure("Steam 扩展工坊条目读取失败。");
  if (details.readInt32LE(8) !== 1) return null;
  const item = {
    publishedFileId: details.readBigUInt64LE(0),
    creatorAppId: details.readUInt32LE(16),
    consumerAppId: details.readUInt32LE(20),
    title: cString(details, 24, 129),
    description: cString(details, 153, 8000),
    timeCreated: details.readUInt32LE(8168),
    timeUpdated: details.readUInt32LE(8172),
    timeAddedToUserList: details.readUInt32LE(8176),
    visibility: details.readInt32LE(8180),
    banned: Boolean(details[8184]),
    acceptedForUse: Boolean(details[8185]),
    tagsTruncated: Boolean(details[8186]),
    tags: cString(details, 8187, 1025).split(",").filter(Boolean),
    url: cString(details, 9500, 256),
    numUpvotes: details.readUInt32LE(9756),
    numDownvotes: details.readUInt32LE(9760),
    numChildren: details.readUInt32LE(9768),
    statistics: {},
  };
  const preview = Buffer.alloc(2048);
  if (api.getPreview(query, index, preview, preview.length)) {
    const url = cString(preview);
    if (url) item.previewUrl = url;
  }
  const statistic = Buffer.alloc(8);
  // Missing optional previews/statistics are valid SDK results, not query failures.
  if (api.getStatistic(query, index, 0, statistic))
    item.statistics.numSubscriptions = statistic.readBigUInt64LE(0);
  return item;
}

function createExtendedWorkshopQuery(getAllItems, options = {}) {
  if (typeof getAllItems !== "function")
    throw new TypeError("getAllItems must be a function");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = options.pollMs ?? 10;
  if (
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > MAX_TIMEOUT_MS ||
    !Number.isFinite(pollMs) ||
    pollMs <= 0 ||
    pollMs > 100
  )
    throw new TypeError("Invalid native Workshop query timeout");
  const now = options.now || (() => performance.now());
  const wait = options.wait || ((ms) => Atomics.wait(waitArray, 0, 0, ms));
  let nativeApi = options.nativeApi;
  return async function extendedQuery(
    page,
    queryType,
    ugcType,
    creatorAppId,
    consumerAppId,
    config,
  ) {
    if (queryType !== 20 && queryType !== 21) return getAllItems(...arguments);
    config ??= {};
    validate(page, queryType, ugcType, creatorAppId, consumerAppId, config);
    nativeApi ||= loadNativeApi();
    const api = nativeApi;
    const query = handle(
      api.createQuery(queryType, ugcType, creatorAppId, consumerAppId, page),
    );
    if (!query) throw failure("Steam 扩展工坊查询创建失败。");
    let primaryError = false;
    try {
      const check = (result) => {
        if (result !== true) throw failure("Steam 扩展工坊筛选设置失败。");
      };
      if (config.cachedResponseMaxAge !== undefined)
        check(api.setCachedAge(query, config.cachedResponseMaxAge));
      if (config.matchAnyTag !== undefined)
        check(api.setMatchAnyTag(query, config.matchAnyTag));
      for (const tag of config.requiredTags || [])
        check(api.addRequiredTag(query, tag));
      for (const tag of config.excludedTags || [])
        check(api.addExcludedTag(query, tag));
      if (config.searchText !== undefined)
        check(api.setSearchText(query, config.searchText));
      if (config.rankedByTrendDays !== undefined)
        check(api.setTrendDays(query, config.rankedByTrendDays));
      const call = handle(api.sendQuery(query));
      if (!call) throw failure("Steam 扩展工坊查询提交失败。");
      const deadline = now() + timeoutMs;
      const failed = Buffer.alloc(1);
      // This synchronous, bounded section belongs ONLY in the isolated Steam
      // utility process. steamworks-rs' 30 Hz runCallbacks consumes every call
      // result before looking for its own registered handlers. An awaited poll
      // would race that pump. RunFrame fills its queue without draining any
      // callbacks; retrieve only our call, then let the normal SDK pump resume.
      for (;;) {
        api.runFrame();
        failed[0] = 0;
        if (api.isCallCompleted(call, failed)) {
          if (failed[0]) throw failure("Steam 扩展工坊查询执行失败。");
          break;
        }
        const remaining = deadline - now();
        if (remaining <= 0)
          throw failure("Steam 扩展工坊查询超时，请稍后重试。");
        wait(Math.min(pollMs, remaining));
      }
      const result = Buffer.alloc(CALLBACK_BYTES);
      failed[0] = 0;
      if (
        !api.getCallResult(call, result, result.length, CALLBACK_ID, failed) ||
        failed[0] ||
        result.readBigUInt64LE(0) !== query ||
        result.readInt32LE(8) !== 1
      )
        throw failure("Steam 扩展工坊查询结果无效。");
      const returnedResults = result.readUInt32LE(12);
      const totalResults = result.readUInt32LE(16);
      if (returnedResults > PAGE_SIZE || totalResults < returnedResults)
        throw failure("Steam 扩展工坊查询结果无效。");
      const items = [];
      for (let index = 0; index < returnedResults; index++)
        items.push(readItem(api, query, index));
      return {
        items,
        returnedResults,
        totalResults,
        wasCached: Boolean(result[20]),
      };
    } catch (error) {
      primaryError = true;
      throw error;
    } finally {
      try {
        if (api.releaseQuery(query) !== true && !primaryError)
          throw failure("Steam 扩展工坊查询资源释放失败。");
      } catch (error) {
        if (!primaryError) throw error;
      }
    }
  };
}

module.exports = { createExtendedWorkshopQuery };
