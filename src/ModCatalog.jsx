import { useI18n, T } from "./i18n.jsx";
import React, { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Search,
  Layers3,
  Download,
} from "lucide-react";
import PdxDownloads, { activePdxJob, usePdxDownloads } from "./PdxDownloads";
import PdxSubscriptions from "./PdxSubscriptions";
export default function ModCatalog({
  api,
  state,
  perform,
  busy,
  onState,
  Dialog,
}) {
  const { t, message, locale } = useI18n();
  const { downloads, setDownloads, error } = usePdxDownloads(api, onState);
  const [authorization, setAuthorization] = useState("anonymous");
  const [subscriptions, setSubscriptions] = useState({
    accountId: null,
    items: [],
    loading: true,
  });
  useEffect(() => {
    let alive = true;
    api
      .getPdxSubscriptions()
      .then((next) => alive && setSubscriptions(next))
      .catch(
        () =>
          alive &&
          setSubscriptions({
            accountId: null,
            items: [],
            error: {
              message: "无法读取账号订阅，请刷新重试。",
            },
          }),
      );
    return () => {
      alive = false;
    };
  }, [api]);
  async function start(modId, revision) {
    await perform("pdx-download", async () => {
      const job = await api.downloadPdxMod({
        modId,
        ...(revision
          ? {
              revision,
            }
          : {}),
        authorization,
      });
      setDownloads((previous) => ({
        ...previous,
        job,
      }));
    });
  }
  const [query, setQuery] = useState("");
  const [request, setRequest] = useState({
    query: "",
    sort: "best",
    page: 0,
  });
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const sequence = useRef(0);
  useEffect(() => {
    const current = ++sequence.current;
    setLoading(true);
    api
      .searchModCatalog(request)
      .then((value) => {
        if (current === sequence.current) setResult(value);
      })
      .catch(() => {
        if (current === sequence.current)
          setResult({
            items: [],
            source: "unavailable",
            error: "暂时无法浏览模组，请稍后重试。",
            totalCount: 0,
            totalPages: 0,
          });
      })
      .finally(() => {
        if (current === sequence.current) setLoading(false);
      });
    return () => {
      sequence.current++;
    };
  }, [api, request]);
  return (
    <div className="catalog-stack">
      <section className="panel catalog-intro">
        <div>
          <p className="eyebrow">PARADOX MODS</p>
          <h2>
            <T id={"发现新的战场"} />
          </h2>
          <p>
            <T id={"浏览 HOI4 社区作品，下载公开模组并加入你的战役预设。"} />
          </p>
        </div>
        <button
          className="button subtle"
          disabled={busy}
          onClick={() => perform("open", () => api.openLink("workshop"))}
        >
          <T id={"Steam 创意工坊"} />
          <ExternalLink size={14} />
        </button>
      </section>
      <PdxDownloads
        api={api}
        state={state}
        downloads={downloads}
        setDownloads={setDownloads}
        error={error}
        perform={perform}
        busy={busy}
        onState={onState}
        Dialog={Dialog}
        start={start}
        authorization={authorization}
        setAuthorization={setAuthorization}
      />
      <PdxSubscriptions
        api={api}
        subscriptions={subscriptions}
        setSubscriptions={setSubscriptions}
        perform={perform}
        busy={busy}
        state={state}
        Dialog={Dialog}
        start={start}
        downloading={
          activePdxJob(downloads.job) ||
          downloads.job?.canResume ||
          downloads.job?.canCancel
        }
      />
      <section className="panel catalog-panel" aria-busy={loading}>
        <form
          className="catalog-toolbar"
          onSubmit={(event) => {
            event.preventDefault();
            setRequest((previous) => ({
              ...previous,
              query: query.trim(),
              page: 0,
            }));
          }}
        >
          <div className="search-input">
            <Search size={16} />
            <input
              aria-label={t("搜索在线模组")}
              placeholder={t("搜索 Paradox 模组…")}
              value={query}
              maxLength={120}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <select
            aria-label={t("在线模组排序")}
            value={request.sort}
            onChange={(event) =>
              setRequest((previous) => ({
                ...previous,
                sort: event.target.value,
                page: 0,
              }))
            }
          >
            <option value="best">
              <T id={"热门作品"} />
            </option>
            <option value="recent">
              <T id={"最近更新"} />
            </option>
          </select>
          <button className="button primary" disabled={loading} type="submit">
            <T id={"搜索"} />
            <ArrowRight size={14} />
          </button>
        </form>
        {result?.error && (
          <p className="inline-note" role="status">
            {message(result.errorDiagnostic ?? result.error, result.error)}
          </p>
        )}
        {result?.source === "cache" && (
          <p className="panel-footnote">
            <T
              id={"显示本地缓存 · {0}"}
              values={[new Date(result.fetchedAt).toLocaleString(locale)]}
            />
          </p>
        )}
        {loading ? (
          <div className="catalog-empty" role="status">
            <T id={"正在浏览模组…"} />
          </div>
        ) : result?.items.length ? (
          <div className="catalog-grid">
            {result.items.map((item) => {
              const installed = state.mods.some(
                (mod) => mod.id === `pdx:${item.id}` && mod.available,
              );
              return (
                <article className="catalog-card" key={item.id}>
                  <div className="catalog-card-header">
                    <Layers3 size={23} />
                    <span>{installed ? t("已安装") : "Paradox Mods"}</span>
                  </div>
                  <h3>{item.name}</h3>
                  <p className="catalog-author">
                    {item.author || t("社区作者")}
                    {item.requiredVersion ? ` · ${item.requiredVersion}` : ""}
                  </p>
                  <p className="catalog-description">
                    {item.description || t("作者未提供简介。")}
                  </p>
                  <button
                    className="button subtle"
                    disabled={
                      busy ||
                      activePdxJob(downloads.job) ||
                      downloads.job?.canResume ||
                      downloads.job?.canCancel ||
                      state.launchStatus?.running
                    }
                    onClick={() => start(item.id)}
                  >
                    <Download size={14} />
                    {installed ? t("检查并更新") : t("下载并安装")}
                  </button>
                  <button
                    className="text-button"
                    disabled={
                      busy ||
                      !subscriptions.accountId ||
                      Boolean(subscriptions.error) ||
                      state.launchStatus?.running ||
                      subscriptions.items.some((sub) => sub.modId === item.id)
                    }
                    onClick={() =>
                      perform("pdx-subscribe", async () =>
                        setSubscriptions(
                          await api.subscribePdxMod({
                            modId: item.id,
                          }),
                        ),
                      )
                    }
                  >
                    {subscriptions.items.some((sub) => sub.modId === item.id)
                      ? t("账号已订阅")
                      : t("订阅到账号")}
                  </button>
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={() =>
                      perform("open", () => api.openModPage(`pdx:${item.id}`))
                    }
                  >
                    <T id={"查看模组"} />
                    <ExternalLink size={13} />
                  </button>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="catalog-empty">
            {result?.source === "unavailable"
              ? t("在线内容暂不可用，你仍可管理本地模组。")
              : t("没有找到符合条件的模组。")}
          </div>
        )}
        <div className="catalog-pagination">
          <span>
            <T
              id={"{0} 个结果 · 第 {1} / {2} 页"}
              values={[
                result?.totalCount ?? 0,
                request.page + 1,
                Math.max(1, result?.totalPages || 1),
              ]}
            />
          </span>
          <div>
            <button
              className="button subtle"
              aria-label={t("上一页模组")}
              disabled={loading || request.page === 0}
              onClick={() =>
                setRequest((previous) => ({
                  ...previous,
                  page: previous.page - 1,
                }))
              }
            >
              <ChevronLeft size={16} />
            </button>
            <button
              className="button subtle"
              aria-label={t("下一页模组")}
              disabled={
                loading || request.page + 1 >= (result?.totalPages || 0)
              }
              onClick={() =>
                setRequest((previous) => ({
                  ...previous,
                  page: previous.page + 1,
                }))
              }
            >
              <ChevronRight size={16} />
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
