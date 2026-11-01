import { useI18n, T } from "./i18n.jsx";
import React, { useEffect, useMemo, useRef, useState } from "react";
import SteamMissingMods from "./SteamMissingMods.jsx";
import ModThumbnail from "./ModThumbnail.jsx";
import workshopFilters from "./workshop-filters.json";
import "./workshop.css";
import {
  ArrowRight,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  ImageOff,
  LayoutGrid,
  Library,
  Plug,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Unplug,
  Users,
  X,
} from "lucide-react";

const offline = { connected: false, account: null, items: [] };
const { categories, sorts, languages, trendDays } = workshopFilters;
const emptyFilters = { tags: [], excludedTags: [], matchAnyTag: false };
const statusText = (item) =>
  item.downloading
    ? "正在下载"
    : item.pending
      ? "等待下载"
      : item.needsUpdate
        ? "有可用更新"
        : item.installed
          ? "已安装"
          : item.subscribed
            ? "已订阅 · 等待安装"
            : "未订阅";
const matches = (item, query) =>
  !query ||
  `${item.name} ${item.id}`
    .toLocaleLowerCase()
    .includes(query.trim().toLocaleLowerCase());

function Cover({ api, item, local, small = false, retryToken = 0 }) {
  const { t } = useI18n();
  const [failed, setFailed] = useState(null);
  useEffect(() => setFailed(null), [retryToken]);
  const fallback = (
    <span className="workshop-cover-fallback">
      <ImageOff size={small ? 18 : 30} />
      {!small && <span>{t("暂无封面")}</span>}
    </span>
  );
  return (
    <div className={`workshop-cover${small ? " is-small" : ""}`}>
      {item.previewUrl && item.previewUrl !== failed ? (
        <img
          src={item.previewUrl}
          alt={t("{0} 封面", { 0: item.name })}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          draggable={false}
          onError={() => setFailed(item.previewUrl)}
        />
      ) : local ? (
        <ModThumbnail api={api} mod={local} fallback={fallback} />
      ) : (
        fallback
      )}
    </div>
  );
}

export default function SteamWorkshop({
  api,
  state,
  perform,
  busy,
  Dialog,
  onState,
  sourceNavigation,
}) {
  const { t, message, locale } = useI18n();
  const [steam, setSteam] = useState(offline);
  const [tab, setTab] = useState("browse");
  const [query, setQuery] = useState("");
  const [request, setRequest] = useState({
    query: "",
    sort: "best",
    language: "all",
    ...emptyFilters,
    trendDays: 7,
    page: 1,
  });
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [filterDraft, setFilterDraft] = useState(emptyFilters);
  const [subscriptionSort, setSubscriptionSort] = useState("subscriptions");
  const [feed, setFeed] = useState(null);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState("");
  const [libraryQuery, setLibraryQuery] = useState("");
  const [libraryFilter, setLibraryFilter] = useState("all");
  const [selected, setSelected] = useState(null);
  const [remove, setRemove] = useState(null);
  const [coverRevision, setCoverRevision] = useState(0);
  const reading = useRef(false),
    epoch = useRef(0),
    busyRef = useRef(busy),
    languageCursors = useRef(new Map());
  busyRef.current = busy;
  const localMods = useMemo(
    () => new Map(state.mods.map((mod) => [mod.id, mod])),
    [state.mods],
  );
  const subscribed = useMemo(
    () => new Map(steam.items.map((item) => [item.id, item])),
    [steam.items],
  );

  useEffect(() => {
    let alive = true;
    async function refresh() {
      if (reading.current || busyRef.current) return;
      reading.current = true;
      const version = epoch.current;
      try {
        const result = await api.getSteamState();
        if (alive && version === epoch.current) setSteam(result);
      } catch {
        if (alive && version === epoch.current)
          setNotice("Steam 状态刷新失败，请重试。");
      } finally {
        reading.current = false;
      }
    }
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [api]);

  useEffect(() => {
    if (!steam.connected || tab !== "browse") {
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    setFeed(null);
    setNotice("");
    if (request.page === 1) languageCursors.current.clear();
    Promise.resolve()
      .then(() =>
        api.browseWorkshop({
          ...request,
          ...(request.language !== "all" &&
          languageCursors.current.has(request.page)
            ? { cursor: languageCursors.current.get(request.page) }
            : {}),
        }),
      )
      .then((result) => {
        if (alive) {
          if (result.nextCursor)
            languageCursors.current.set(request.page + 1, result.nextCursor);
          setFeed(result);
        }
      })
      .catch(() => {
        if (alive) setNotice("无法浏览工坊，请检查 Steam 连接后重试。");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [api, request, steam.connected, tab]);

  async function connect() {
    epoch.current++;
    await perform("steam-connect", async () => {
      const result = steam.connected
        ? await api.disconnectSteam()
        : await api.connectSteam();
      setSteam(result);
      setFeed(null);
      setSelected(null);
      setNotice("");
      return result;
    });
  }
  async function act(method, id) {
    epoch.current++;
    await perform("steam-action", async () => {
      const result = await api[method](id);
      setSteam(result);
      setRemove(null);
      setSelected(null);
      setNotice("");
      setRequest((previous) => ({ ...previous }));
      return result;
    });
  }
  async function refreshLocal() {
    epoch.current++;
    await perform(
      "refresh",
      async () => {
        const result = await api.getState();
        onState(result);
        setSteam(await api.getSteamState());
        setCoverRevision((previous) => previous + 1);
        setNotice("");
        return result;
      },
      "已刷新安装状态",
    );
  }
  const localFor = (item) => localMods.get(`workshop:${item.id}`);
  const compactNumber = (value) =>
    new Intl.NumberFormat(locale, {
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(value);
  const date = (value) =>
    new Date(value * 1000).toLocaleDateString(locale, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  const libraryItems = steam.items.filter(
    (item) =>
      matches(item, libraryQuery) &&
      (libraryFilter === "all" ||
        (libraryFilter === "downloading"
          ? item.downloading || item.pending
          : item[libraryFilter])),
  );
  const items =
    tab === "browse"
      ? (feed?.items || []).map((item) => ({
          ...item,
          ...subscribed.get(item.id),
        }))
      : steam.items
          .filter(
            (item) =>
              matches(item, request.query) &&
              (request.language === "all" ||
                Boolean(item.hasChineseContent) ===
                  (request.language === "chinese")) &&
              (!request.tags.length ||
                request.tags[request.matchAnyTag ? "some" : "every"]((tag) =>
                  item.tags?.includes(tag),
                )) &&
              !request.excludedTags.some((tag) => item.tags?.includes(tag)),
          )
          .sort((a, b) =>
            subscriptionSort === "recent"
              ? (b.updatedAt || 0) - (a.updatedAt || 0)
              : (b.subscriberCount || 0) - (a.subscriberCount || 0),
          );
  const filterCount = request.tags.length + request.excludedTags.length;
  const hasFilters =
    filterCount > 0 ||
    request.language !== "all" ||
    (tab === "browse"
      ? request.sort !== "best"
      : subscriptionSort !== "subscriptions");
  const categoryLabel = (tag) =>
    t(categories.find(([value]) => value === tag)?.[1] || tag);
  function clearFilters() {
    setRequest((previous) => ({
      ...previous,
      ...emptyFilters,
      sort: "best",
      language: "all",
      trendDays: 7,
      page: 1,
    }));
    setFilterDraft(emptyFilters);
    setSubscriptionSort("subscriptions");
  }
  function toggleDraftTag(field, tag) {
    const other = field === "tags" ? "excludedTags" : "tags";
    setFilterDraft((previous) => ({
      ...previous,
      [field]: previous[field].includes(tag)
        ? previous[field].filter((value) => value !== tag)
        : [...previous[field], tag],
      [other]: previous[other].filter((value) => value !== tag),
    }));
  }
  function removeTag(field, tag) {
    setRequest((previous) => ({
      ...previous,
      [field]: previous[field].filter((value) => value !== tag),
      page: 1,
    }));
    setFiltersOpen(false);
  }
  const detail = selected
    ? { ...selected, ...subscribed.get(selected.id) }
    : null;
  const playset =
    state.settings.playsets.find(
      (item) => item.id === state.settings.activePlaysetId,
    ) || state.settings.playsets[0];
  const missingCount = [
    ...new Set([...(playset?.modOrder || []), ...(playset?.modIds || [])]),
  ].filter(
    (id) => id.startsWith("workshop:") && !localMods.get(id)?.available,
  ).length;
  const resultLabel = t(
    tab === "browse" && feed?.languageFiltered
      ? "本页 {0} 个匹配项 · 第 {1} 页"
      : "{0} 个结果 · 第 {1} 页",
    {
      0:
        tab === "browse"
          ? feed?.languageFiltered
            ? items.length
            : feed?.totalCount || 0
          : items.length,
      1: tab === "browse" ? request.page : 1,
    },
  );

  function actionButton(item) {
    return (
      <button
        className={`button ${item.subscribed ? "subtle" : "primary"}`}
        disabled={
          busy || (item.subscribed && (item.downloading || item.pending))
        }
        onClick={() =>
          act(
            item.subscribed ? "downloadWorkshop" : "subscribeWorkshop",
            item.id,
          )
        }
      >
        <Download size={14} />
        {!item.subscribed
          ? t("订阅并下载")
          : item.installed
            ? t("检查更新")
            : t("下载")}
      </button>
    );
  }
  function progress(item) {
    return (
      item.downloading &&
      item.totalBytes > 0 && (
        <progress
          aria-label={t("{0} 下载进度", { 0: item.name })}
          value={item.downloadedBytes ?? 0}
          max={item.totalBytes}
        />
      )
    );
  }

  return (
    <div className="workshop">
      <header className="workshop-heading">
        {sourceNavigation || (
          <div className="workshop-heading-title">
            <span className="workshop-mark">
              <LayoutGrid size={23} />
            </span>
            <div>
              <p className="eyebrow">STEAM WORKSHOP</p>
              <h2>{t("创意工坊")}</h2>
            </div>
          </div>
        )}
        <div className="workshop-connection">
          {steam.connected && (
            <span className="workshop-account">
              <i />
              {t("已连接 · {0}", { 0: steam.account?.name || t("Steam 玩家") })}
            </span>
          )}
          <button className="button subtle" disabled={busy} onClick={connect}>
            {steam.connected ? <Unplug size={14} /> : <Plug size={14} />}
            {t(steam.connected ? "断开连接" : "连接 Steam")}
          </button>
        </div>
      </header>
      {message(notice || (!steam.connected && steam.error)) && (
        <p className="inline-note workshop-notice" role="status">
          {message(notice || steam.error)}
        </p>
      )}

      <div className="workshop-layout">
        <section className="workshop-browser" aria-label={t("浏览工坊")}>
          <form
            className="workshop-toolbar"
            onSubmit={(event) => {
              event.preventDefault();
              setRequest((previous) => ({
                ...previous,
                query: query.trim(),
                page: 1,
              }));
            }}
          >
            <div className="workshop-tabs">
              <button
                type="button"
                aria-pressed={tab === "browse"}
                className={tab === "browse" ? "selected" : ""}
                onClick={() => setTab("browse")}
              >
                <LayoutGrid size={15} />
                {t("浏览工坊")}
              </button>
              <button
                type="button"
                aria-pressed={tab === "subscribed"}
                className={tab === "subscribed" ? "selected" : ""}
                onClick={() => setTab("subscribed")}
              >
                <Library size={15} />
                {t("我的订阅")}
              </button>
            </div>
            <div className="workshop-search">
              <Search size={16} />
              <input
                aria-label={t("搜索工坊模组")}
                placeholder={t("搜索 Steam 创意工坊…")}
                value={query}
                maxLength={120}
                onChange={(event) => setQuery(event.target.value)}
              />
              <button type="submit" disabled={loading || !steam.connected}>
                {t("搜索")}
                <ArrowRight size={14} />
              </button>
            </div>
            <button
              className="workshop-icon-button"
              type="button"
              title={t("刷新工坊")}
              aria-label={t("刷新工坊")}
              disabled={loading || !steam.connected}
              onClick={() => setRequest((previous) => ({ ...previous }))}
            >
              <RefreshCw size={17} className={loading ? "spin" : ""} />
            </button>
          </form>
          <div className="workshop-filters">
            <span className="workshop-result-count">{resultLabel}</span>
            <div className="workshop-filter-select">
              <SlidersHorizontal size={14} />
              <select
                aria-label={t("工坊分类")}
                value={
                  request.tags.length > 1 ? "multiple" : request.tags[0] || ""
                }
                onChange={(event) => {
                  const tags = event.target.value ? [event.target.value] : [];
                  setRequest((previous) => ({
                    ...previous,
                    tags,
                    excludedTags: previous.excludedTags.filter(
                      (tag) => !tags.includes(tag),
                    ),
                    page: 1,
                  }));
                  setFiltersOpen(false);
                }}
              >
                {request.tags.length > 1 && (
                  <option value="multiple" disabled>
                    {t("多个分类（{0}）", { 0: request.tags.length })}
                  </option>
                )}
                {categories.map(([value, label]) => (
                  <option key={value} value={value}>
                    {t(label)}
                  </option>
                ))}
              </select>
            </div>
            <select
              aria-label={t("工坊排序")}
              value={tab === "browse" ? request.sort : subscriptionSort}
              onChange={(event) => {
                if (tab === "subscribed")
                  setSubscriptionSort(event.target.value);
                else
                  setRequest((previous) => ({
                    ...previous,
                    sort: event.target.value,
                    page: 1,
                  }));
              }}
            >
              {sorts
                .filter(
                  ([value]) =>
                    tab === "browse" ||
                    ["recent", "subscriptions"].includes(value),
                )
                .map(([value, label]) => (
                  <option key={value} value={value}>
                    {t(label)}
                  </option>
                ))}
            </select>
            <select
              aria-label={t("工坊内容语言")}
              title={t(
                "根据标题、简介和标签识别中文，可能遗漏；非中文内容包含未识别为中文的模组。",
              )}
              value={request.language}
              onChange={(event) =>
                setRequest((previous) => ({
                  ...previous,
                  language: event.target.value,
                  page: 1,
                }))
              }
            >
              {languages.map(([value, label]) => (
                <option key={value} value={value}>
                  {t(label)}
                </option>
              ))}
            </select>
            {tab === "browse" && request.sort === "trending" && (
              <select
                aria-label={t("热门时间范围")}
                value={request.trendDays}
                onChange={(event) =>
                  setRequest((previous) => ({
                    ...previous,
                    trendDays: Number(event.target.value),
                    page: 1,
                  }))
                }
              >
                {trendDays.map((days) => (
                  <option key={days} value={days}>
                    {t("最近 {0} 天", { 0: days })}
                  </option>
                ))}
              </select>
            )}
            <button
              type="button"
              className={`button subtle workshop-filter-toggle${filtersOpen ? " selected" : ""}`}
              aria-expanded={filtersOpen}
              aria-controls="workshop-advanced-filters"
              onClick={() => {
                if (!filtersOpen)
                  setFilterDraft({
                    tags: request.tags,
                    excludedTags: request.excludedTags,
                    matchAnyTag: request.matchAnyTag,
                  });
                setFiltersOpen((previous) => !previous);
              }}
            >
              <SlidersHorizontal size={14} />
              {t(filtersOpen ? "收起筛选" : "更多筛选")}
              {filterCount > 0 && <span>{filterCount}</span>}
            </button>
            {hasFilters && (
              <button
                className="text-button"
                type="button"
                onClick={clearFilters}
              >
                {t("清空筛选")}
              </button>
            )}
          </div>

          {request.language !== "all" && (
            <p className="workshop-language-note">
              {t(
                "根据标题、简介和标签识别中文，可能遗漏；非中文内容包含未识别为中文的模组。",
              )}
            </p>
          )}

          {filtersOpen && (
            <form
              id="workshop-advanced-filters"
              className="workshop-advanced-filters"
              onSubmit={(event) => {
                event.preventDefault();
                setRequest((previous) => ({
                  ...previous,
                  ...filterDraft,
                  page: 1,
                }));
                setFiltersOpen(false);
              }}
            >
              <label className="workshop-tag-matching">
                <span>{t("标签匹配方式")}</span>
                <select
                  aria-label={t("标签匹配方式")}
                  value={filterDraft.matchAnyTag ? "any" : "all"}
                  onChange={(event) =>
                    setFilterDraft((previous) => ({
                      ...previous,
                      matchAnyTag: event.target.value === "any",
                    }))
                  }
                >
                  <option value="all">{t("匹配全部标签")}</option>
                  <option value="any">{t("匹配任一标签")}</option>
                </select>
              </label>
              <div className="workshop-tag-columns">
                {[
                  ["tags", "包含标签"],
                  ["excludedTags", "排除标签"],
                ].map(([field, label]) => (
                  <fieldset key={field}>
                    <legend>{t(label)}</legend>
                    <div className="workshop-tag-options">
                      {categories
                        .filter(([value]) => value)
                        .map(([value, label]) => (
                          <label key={value}>
                            <input
                              type="checkbox"
                              checked={filterDraft[field].includes(value)}
                              onChange={() => toggleDraftTag(field, value)}
                            />
                            <span>{t(label)}</span>
                          </label>
                        ))}
                    </div>
                  </fieldset>
                ))}
              </div>
              <div className="workshop-filter-actions">
                <button
                  type="button"
                  className="text-button"
                  onClick={() => setFiltersOpen(false)}
                >
                  {t("取消")}
                </button>
                <button type="submit" className="button primary">
                  <Check size={14} />
                  {t("应用筛选")}
                </button>
              </div>
            </form>
          )}
          {filterCount > 0 && (
            <div className="workshop-active-filters">
              {request.tags.length > 1 && (
                <span>
                  {t(request.matchAnyTag ? "匹配任一标签" : "匹配全部标签")}
                </span>
              )}
              {[
                ["tags", request.tags],
                ["excludedTags", request.excludedTags],
              ].flatMap(([field, tags]) =>
                tags.map((tag) => {
                  const label =
                    field === "excludedTags"
                      ? t("排除：{0}", { 0: categoryLabel(tag) })
                      : categoryLabel(tag);
                  return (
                    <button
                      key={`${field}:${tag}`}
                      className={field === "excludedTags" ? "is-excluded" : ""}
                      aria-label={t("移除筛选：{0}", { 0: label })}
                      onClick={() => removeTag(field, tag)}
                    >
                      {label}
                      <X size={12} />
                    </button>
                  );
                }),
              )}
            </div>
          )}

          {!steam.connected ? (
            <div className="workshop-empty workshop-offline">
              <span className="workshop-empty-icon">
                <Plug size={32} />
              </span>
              <h3>{t("连接 Steam")}</h3>
              <p>
                {t(
                  "连接已运行的 Steam 客户端，浏览、订阅并管理 HOI4 模组下载。",
                )}
              </p>
              <small>
                {t(
                  "请先启动 Steam 并登录持有 HOI4 的账户。只有点击「连接 Steam」才会建立连接；Steam 可能将此连接显示为游戏运行状态。",
                )}
              </small>
              <button
                className="button subtle"
                disabled={busy}
                onClick={() => perform("open", () => api.openLink("workshop"))}
              >
                {t("在来源页浏览")}
                <ExternalLink size={14} />
              </button>
            </div>
          ) : loading && tab === "browse" ? (
            <div className="workshop-loading" role="status">
              <span>{t("正在读取工坊…")}</span>
              <div className="workshop-grid" aria-hidden="true">
                {Array.from({ length: 8 }, (_, index) => (
                  <div className="workshop-skeleton" key={index}>
                    <div />
                    <i />
                    <i />
                  </div>
                ))}
              </div>
            </div>
          ) : items.length ? (
            <div className="workshop-grid">
              {items.map((item) => (
                <article className="workshop-card" key={item.id}>
                  <button
                    className="workshop-cover-button"
                    onClick={() => setSelected(item)}
                    aria-label={item.name}
                  >
                    <Cover
                      api={api}
                      item={item}
                      local={localFor(item)}
                      retryToken={coverRevision}
                    />
                    {item.subscribed && (
                      <span className="workshop-subscribed-badge">
                        <Check size={12} />
                        {t("已订阅")}
                      </span>
                    )}
                    {Number.isSafeInteger(item.subscriberCount) && (
                      <span
                        className="workshop-popularity"
                        title={t("{0} 次订阅", {
                          0: item.subscriberCount.toLocaleString(locale),
                        })}
                      >
                        <Users size={12} />
                        {compactNumber(item.subscriberCount)}
                      </span>
                    )}
                  </button>
                  <div className="workshop-card-body">
                    <h3>
                      <button
                        onClick={() => setSelected(item)}
                        title={item.name}
                      >
                        {item.name}
                      </button>
                    </h3>
                    <div className="workshop-card-meta">
                      <span>
                        {item.updatedAt
                          ? `${t("最近更新")} · ${date(item.updatedAt)}`
                          : `ID ${item.id}`}
                      </span>
                    </div>
                    <div className="workshop-card-footer">
                      <span
                        className={`workshop-status${item.downloading || item.pending ? " is-active" : ""}`}
                      >
                        {t(statusText(item))}
                      </span>
                      {actionButton(item)}
                    </div>
                    {progress(item)}
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="workshop-empty">
              <Search size={28} />
              <p>
                {t(
                  tab === "browse" && feed?.languageFiltered && feed.hasMore
                    ? "本批暂无语言匹配项，可继续下一页。"
                    : tab === "subscribed" &&
                        !request.query &&
                        !filterCount &&
                        request.language === "all"
                      ? "此 Steam 账户尚未订阅 HOI4 模组。"
                      : "没有找到符合条件的模组。",
                )}
              </p>
            </div>
          )}

          {steam.connected && tab === "browse" && (
            <div className="workshop-pagination">
              <span>{resultLabel}</span>
              <div>
                <button
                  className="button subtle"
                  disabled={loading || request.page <= 1}
                  onClick={() =>
                    setRequest((previous) => ({
                      ...previous,
                      page: previous.page - 1,
                    }))
                  }
                >
                  <ChevronLeft size={15} />
                  {t("上一页")}
                </button>
                <button
                  className="button subtle"
                  disabled={
                    loading ||
                    (feed?.languageFiltered
                      ? !feed.hasMore
                      : request.page >= (feed?.totalPages || 0))
                  }
                  onClick={() =>
                    setRequest((previous) => ({
                      ...previous,
                      page: previous.page + 1,
                    }))
                  }
                >
                  {t("下一页")}
                  <ChevronRight size={15} />
                </button>
              </div>
            </div>
          )}

          <details
            className="workshop-repair"
            open={missingCount > 0 || undefined}
          >
            <summary>
              <Download size={15} />
              <span>{t("补齐预设模组")}</span>
              <span className="workshop-repair-count">
                {t("{0} 个模组", { 0: missingCount })}
              </span>
              <ChevronDown size={15} />
            </summary>
            <SteamMissingMods
              api={api}
              state={state}
              steam={steam}
              perform={perform}
              busy={busy}
              Dialog={Dialog}
              onState={onState}
            />
          </details>
        </section>

        <aside className="workshop-library" aria-label={t("我的订阅")}>
          <div className="workshop-library-header">
            <div>
              <h3>
                <Library size={16} />
                {t("我的订阅")}
              </h3>
              <p>{t("{0} 个模组", { 0: steam.items.length })}</p>
            </div>
            <button
              className="workshop-icon-button"
              disabled={busy || !steam.connected}
              aria-label={t("刷新本地模组")}
              title={t("刷新本地模组")}
              onClick={refreshLocal}
            >
              <RefreshCw size={15} />
            </button>
          </div>
          {steam.connected && steam.error && (
            <p className="workshop-library-note" role="status">
              {message(steam.error)}
            </p>
          )}
          <div className="workshop-library-controls">
            <select
              aria-label={t("订阅状态")}
              value={libraryFilter}
              onChange={(event) => setLibraryFilter(event.target.value)}
            >
              <option value="all">{t("全部订阅")}</option>
              <option value="needsUpdate">{t("有可用更新")}</option>
              <option value="downloading">{t("正在下载")}</option>
              <option value="installed">{t("已安装")}</option>
            </select>
            <label className="workshop-library-search">
              <Search size={14} />
              <input
                aria-label={t("搜索已订阅模组")}
                placeholder={t("名称或 Workshop ID")}
                maxLength={120}
                value={libraryQuery}
                onChange={(event) => setLibraryQuery(event.target.value)}
              />
            </label>
          </div>
          <div className="workshop-library-list">
            {!steam.connected ? (
              <p className="workshop-library-empty">{t("请先连接 Steam。")}</p>
            ) : !libraryItems.length ? (
              <p className="workshop-library-empty">
                {t(
                  steam.items.length
                    ? "没有找到符合条件的模组。"
                    : "此 Steam 账户尚未订阅 HOI4 模组。",
                )}
              </p>
            ) : (
              libraryItems.map((item) => (
                <button
                  className="workshop-library-item"
                  key={item.id}
                  onClick={() => setSelected(item)}
                >
                  <Cover
                    api={api}
                    item={item}
                    local={localFor(item)}
                    small
                    retryToken={coverRevision}
                  />
                  <span className="workshop-library-copy">
                    <strong title={item.name}>{item.name}</strong>
                    <small>
                      {localFor(item)?.supportedVersion || `ID ${item.id}`}
                    </small>
                    <span
                      className={`workshop-status${item.downloading || item.pending ? " is-active" : ""}`}
                    >
                      {t(statusText(item))}
                    </span>
                    {progress(item)}
                  </span>
                </button>
              ))
            )}
          </div>
        </aside>
      </div>

      {detail && !remove && (
        <Dialog title={detail.name} onClose={() => setSelected(null)}>
          <div className="workshop-detail">
            <Cover
              api={api}
              item={detail}
              local={localFor(detail)}
              retryToken={coverRevision}
            />
            <div className="workshop-detail-copy">
              <span className="workshop-status">{t(statusText(detail))}</span>
              <p>{detail.description || `Workshop ID · ${detail.id}`}</p>
              {detail.updatedAt && (
                <small>
                  {t("最近更新")} · {date(detail.updatedAt)}
                </small>
              )}
              {Number.isSafeInteger(detail.subscriberCount) && (
                <small>
                  <Users size={13} />
                  {t("{0} 次订阅", {
                    0: detail.subscriberCount.toLocaleString(locale),
                  })}
                </small>
              )}
              <div className="workshop-tags">
                {detail.tags?.map((tag) => (
                  <span key={tag}>{tag}</span>
                ))}
              </div>
              {progress(detail)}
            </div>
          </div>
          <div className="modal-actions workshop-detail-actions">
            <button
              className="button subtle"
              onClick={() =>
                perform("open", () => api.openModPage(`workshop:${detail.id}`))
              }
            >
              {t("在来源页浏览")}
              <ExternalLink size={14} />
            </button>
            {detail.subscribed && (
              <button
                className="text-button"
                disabled={busy}
                onClick={() => setRemove(detail)}
              >
                {t("取消订阅")}
              </button>
            )}
            {actionButton(detail)}
          </div>
        </Dialog>
      )}
      {remove && (
        <Dialog
          title={t("取消工坊订阅")}
          onClose={() => !busy && setRemove(null)}
        >
          <p className="modal-description">
            <T
              id={
                "取消订阅「{0}」后，Steam 可能移除下载的文件。已有预设会保留此项并提示缺失。"
              }
              values={[remove.name]}
            />
          </p>
          <p className="inline-note">
            <T
              id={"{0} 个预设包含此模组。"}
              values={[
                state.settings.playsets.filter((p) =>
                  p.modOrder.includes(`workshop:${remove.id}`),
                ).length,
              ]}
            />
          </p>
          <div className="modal-actions">
            <button
              className="button subtle"
              disabled={busy}
              onClick={() => setRemove(null)}
            >
              {t("保留订阅")}
            </button>
            <button
              className="button primary"
              disabled={busy}
              onClick={() => act("unsubscribeWorkshop", remove.id)}
            >
              {t("确认取消订阅")}
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
