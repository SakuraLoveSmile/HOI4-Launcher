import { useI18n, T } from "./i18n.jsx";
import React, { useEffect, useState } from "react";
import {
  ArrowRight,
  Archive,
  ExternalLink,
  FileDown,
  Newspaper,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from "lucide-react";
export function NewsPanel({ api, perform, busy }) {
  const { t, message, locale } = useI18n();
  const [feed, setFeed] = useState(null);
  useEffect(() => {
    let mounted = true;
    api
      .getNews?.()
      .then((result) => mounted && setFeed(result))
      .catch(
        () =>
          mounted &&
          setFeed({
            items: [],
            source: "unavailable",
            error: "暂时无法读取公告。",
          }),
      );
    return () => {
      mounted = false;
    };
  }, [api]);
  return (
    <section className="panel news-panel">
      <div className="section-heading">
        <h2>
          <Newspaper size={17} />
          <T id={"前线简报 "} />
          <span className="news-source">
            <T id={"HOI4 官方公告"} />
          </span>
        </h2>
        <button
          className="text-button"
          disabled={busy}
          onClick={() =>
            perform("news", async () => {
              const result = await api.getNews({
                refresh: true,
              });
              setFeed(result);
              return result;
            })
          }
        >
          <RefreshCw size={13} />
          <T id={"刷新新闻"} />
        </button>
      </div>
      {feed?.items.length ? (
        <div className="news-grid">
          {feed.items.slice(0, 6).map((item) => (
            <article className="news-card" key={item.id}>
              <time>{new Date(item.date).toLocaleDateString(locale)}</time>
              <h3>{item.title}</h3>
              <p>{item.excerpt}</p>
              <button
                className="text-button"
                onClick={() => perform("open", () => api.openNews(item.id))}
              >
                <T id={"阅读公告"} />
                <ExternalLink size={12} />
              </button>
            </article>
          ))}
        </div>
      ) : (
        <div className="news-empty">
          {message(feed?.errorDiagnostic ?? feed?.error, feed?.error) ||
            (feed ? t("暂时没有可显示的官方公告。") : t("正在读取官方公告…"))}
          <span>
            <T id={"新闻不可用时仍可正常管理并启动游戏。"} />
          </span>
        </div>
      )}
      {feed?.source === "cache" && (
        <div className="panel-footnote">
          <T
            id={"当前显示本地缓存。{0}"}
            values={[message(feed.errorDiagnostic ?? feed.error, feed.error)]}
          />
        </div>
      )}
    </section>
  );
}
export function CommunityLinks({ api, perform, busy }) {
  const { t, message, locale } = useI18n();
  if (!api.openLink) return null;
  return (
    <div className="community-links">
      {[
        ["workshop", t("Steam 创意工坊")],
        ["dlc", t("DLC 商店")],
        ["community", t("官方社区")],
        ["support", t("游戏支持")],
      ].map(([id, label]) => (
        <button
          disabled={busy}
          key={id}
          onClick={() => perform("open", () => api.openLink(id))}
        >
          {t(label)}
          <ExternalLink size={12} />
        </button>
      ))}
    </div>
  );
}
export function MaintenancePanel({
  state,
  api,
  perform,
  onState,
  busy,
  Dialog,
}) {
  const { t, message, locale } = useI18n();
  const [mode, setMode] = useState(null);
  const [plan, setPlan] = useState(null);
  const [selection, setSelection] = useState([]);
  const [backups, setBackups] = useState([]);
  const running = state.launchStatus?.running;
  async function showPlan() {
    await perform("cache-plan", async () => {
      const result = await api.getCachePlan();
      setPlan(result);
      setSelection(
        result.targets
          .filter((target) => target.exists && target.selectedByDefault)
          .map((target) => target.id),
      );
      setMode("clear");
      return result;
    });
  }
  async function showBackups() {
    await perform("backups", async () => {
      const result = await api.listCacheBackups();
      setBackups(result);
      setMode("backups");
      return result;
    });
  }
  async function clearSelected() {
    await perform(
      "clear-cache",
      async () => {
        const result = await api.clearCache(selection);
        onState(await api.getState());
        setMode(null);
        return result;
      },
      "选中缓存已移入备份，可随时恢复",
    );
  }
  async function restore(id) {
    await perform(
      "restore-cache",
      async () => {
        const result = await api.restoreCacheBackup(id);
        setBackups(await api.listCacheBackups());
        onState(await api.getState());
        return result;
      },
      "备份已恢复，当前同名内容也已另存备份",
    );
  }
  return (
    <section className="panel settings-panel">
      <div className="section-heading">
        <h2>
          <ShieldCheck size={19} />
          <T id={"维护与诊断"} />
        </h2>
      </div>
      <p className="section-description">
        <T id={"清理前先将选中内容移入备份。游戏运行时暂不执行清理或恢复。"} />
      </p>
      <div className="settings-actions maintenance-actions">
        <button
          className="button subtle"
          disabled={busy || running}
          onClick={showPlan}
        >
          <Trash2 size={15} />
          <T id={"备份并清理缓存"} />
        </button>
        <button className="button subtle" disabled={busy} onClick={showBackups}>
          <Archive size={15} />
          <T id={"缓存备份"} />
        </button>
        <button
          className="button subtle"
          disabled={busy}
          onClick={() =>
            perform(
              "diagnostics",
              () => api.exportDiagnostics(),
              "诊断文件已导出",
            )
          }
        >
          <FileDown size={15} />
          <T id={"导出诊断"} />
        </button>
      </div>
      {mode && (
        <Dialog
          title={
            mode === "clear" ? t("备份并清理游戏缓存") : t("缓存备份与恢复")
          }
          onClose={() => !busy && setMode(null)}
        >
          {mode === "clear" ? (
            <>
              <p className="modal-description">
                <T
                  id={
                    "只处理你选中的项目。含模组描述、规则或播放列表的项目需要单独勾选；存档、账号、设置和官方预设数据库始终保留。"
                  }
                />
              </p>
              {plan.warnings.map((warning, index) => (
                <p className="inline-note" key={index}>
                  {message(warning)}
                </p>
              ))}
              <div className="cache-targets">
                {plan.targets.map((target) => (
                  <label
                    className={`cache-target ${target.containsUserContent ? "user-content" : ""}`}
                    key={target.id}
                  >
                    <input
                      type="checkbox"
                      checked={selection.includes(target.id)}
                      disabled={busy || !target.exists}
                      onChange={(event) =>
                        setSelection((previous) =>
                          event.target.checked
                            ? [...previous, target.id]
                            : previous.filter((id) => id !== target.id),
                        )
                      }
                    />
                    <span>
                      {t(target.label || target.id)}
                      <small>
                        {target.id}
                        {!target.exists
                          ? t(" · 不存在")
                          : target.containsUserContent
                            ? t(" · 含用户内容，恢复前将暂不可用")
                            : t(" · 可重建缓存")}
                      </small>
                    </span>
                  </label>
                ))}
              </div>
              <div className="modal-actions">
                <button
                  className="button subtle"
                  disabled={busy}
                  onClick={() => setMode(null)}
                >
                  <T id={"取消"} />
                </button>
                <button
                  className="button primary"
                  disabled={busy || running || !selection.length}
                  onClick={clearSelected}
                >
                  <T id={"备份并清理 {0} 项"} values={[selection.length]} />
                  <ArrowRight size={15} />
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="modal-description">
                <T
                  id={
                    "恢复时如果当前位置已有新内容，会先为新内容另建备份，保留两个版本。"
                  }
                />
              </p>
              <div className="backup-list">
                {backups.map((backup) => (
                  <div className="backup-item" key={backup.id}>
                    <div>
                      <strong>
                        {Number.isFinite(Date.parse(backup.createdAt))
                          ? new Date(backup.createdAt).toLocaleString(locale)
                          : t("日期未知")}
                      </strong>
                      <p>
                        {backup.targets
                          .map((target) =>
                            typeof target === "string"
                              ? target
                              : target.id || target.path,
                          )
                          .join("、")}
                      </p>
                      <small>
                        {{
                          completed: t("可恢复"),
                          restored: t("已恢复"),
                          prepared: t("备份未完成"),
                          restoring: t("恢复未完成"),
                          invalid: t("备份信息无效"),
                          "recovery-required": t("需要手动检查备份目录"),
                        }[backup.status] || t("状态未知，请检查备份目录")}
                      </small>
                    </div>
                    <button
                      className="button subtle"
                      disabled={
                        busy || running || backup.status !== "completed"
                      }
                      onClick={() => restore(backup.id)}
                    >
                      <T id={"恢复此备份"} />
                    </button>
                  </div>
                ))}
              </div>
              {!backups.length && (
                <p className="inline-note">
                  <T id={"还没有由本启动器创建的缓存备份。"} />
                </p>
              )}
            </>
          )}
        </Dialog>
      )}
    </section>
  );
}
