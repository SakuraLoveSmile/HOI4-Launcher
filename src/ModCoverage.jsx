import React, { useEffect, useState } from "react";
import { FileSearch, RefreshCw } from "lucide-react";
import { useI18n } from "./i18n.jsx";
import "./coverage.css";

const kinds = {
  "same-path": "同路径文件",
  "replace-path": "目录替换声明",
  "event-id": "重复事件 ID",
  "focus-id": "重复国策 ID",
};

export function CoverageProgress({ api, active }) {
  const { t } = useI18n();
  const [progress, setProgress] = useState(null);
  useEffect(() => {
    if (!active || !api.getModCoverageProgress) return;
    let alive = true;
    const refresh = () =>
      api
        .getModCoverageProgress()
        .then((value) => {
          if (alive) setProgress(value);
        })
        .catch(() => {});
    refresh();
    const timer = setInterval(refresh, 500);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [api, active]);
  if (!active) return null;
  return (
    <div className="campaign-progress" role="status">
      <span>
        {t("正在检查跨 Mod 覆盖…")}
        {progress?.total > 0 && ` ${progress.index} / ${progress.total}`}
      </span>
      {progress?.canCancel && (
        <button className="text-button" onClick={() => api.cancelModCoverage()}>
          {t("取消检查")}
        </button>
      )}
    </div>
  );
}

export default function ModCoverage({
  api,
  state,
  active,
  busy,
  perform,
  Dialog,
}) {
  const { t, message, locale } = useI18n();
  const [open, setOpen] = useState(false),
    [report, setReport] = useState(null);
  const [kind, setKind] = useState("all"),
    [groupId, setGroupId] = useState("");
  const [snippet, setSnippet] = useState(null),
    [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const stamp = JSON.stringify([
    state.settings.activeGameInstanceId,
    active,
    state.settings.gameOptions,
    state.settings.launchMode,
    state.game.version,
  ]);
  useEffect(() => {
    setReport(null);
    setSnippet(null);
    setGroupId("");
  }, [stamp]);
  const groups = (report?.groups || []).filter(
    (group) =>
      (kind === "all" || group.kind === kind) &&
      (!query.trim() ||
        `${group.value} ${group.evidence.map((item) => item.modName).join(" ")}`
          .toLocaleLowerCase()
          .includes(query.trim().toLocaleLowerCase())),
  );
  const selected = groups.find((group) => group.id === groupId) || groups[0];
  const scan = () =>
    perform("coverage-scan", async () => {
      setError("");
      setSnippet(null);
      setReport(null);
      try {
        const next = await api.scanModCoverage();
        setReport(next);
        setGroupId("");
        return next;
      } catch (e) {
        setError(e.message);
        return null;
      }
    });
  const inspect = (evidence) =>
    perform("coverage-evidence", async () => {
      setError("");
      setSnippet(null);
      try {
        const next = await api.readModCoverageEvidence(report.id, evidence.id);
        setSnippet(next);
        return next;
      } catch (e) {
        setError(e.message);
        return null;
      }
    });
  return (
    <>
      <button
        className="button subtle"
        disabled={busy}
        onClick={() => setOpen(true)}
      >
        <FileSearch size={15} />
        {t("覆盖检查")}
      </button>
      {open && (
        <Dialog
          title={t("跨 Mod 覆盖证据")}
          onClose={() => {
            if (!busy) setOpen(false);
          }}
        >
          <div className="coverage-manager">
            <p className="section-description">
              {t(
                "检查当前启用 Mod 的同路径文件、目录替换声明和重复事件／国策 ID，并展示实际来源。",
              )}
            </p>
            <p className="performance-hint">
              {t(
                "覆盖可能来自正常兼容补丁；列表顺序不代表最终生效顺序，也不判定必需前置或存档兼容性。",
              )}
            </p>
            <div className="coverage-toolbar">
              <strong>{active.name}</strong>
              <button
                className="button primary"
                disabled={busy || !api.scanModCoverage}
                onClick={scan}
              >
                <RefreshCw size={15} />
                {t(report ? "重新检查覆盖" : "检查当前组合")}
              </button>
            </div>
            {error && (
              <p className="inline-note" role="alert">
                {message(error)}
              </p>
            )}
            {report && (
              <>
                <div className="coverage-summary">
                  <span>
                    {t("已检查 {0} 个 Mod、{1} 个文件", {
                      0: report.counts.mods,
                      1: report.counts.files,
                    })}
                  </span>
                  <span>
                    {new Date(report.checkedAt).toLocaleString(locale)}
                  </span>
                </div>
                <p
                  className={`inline-note ${report.partial ? "coverage-partial" : ""}`}
                  role="status"
                >
                  {t(
                    report.partial
                      ? "部分内容未完成检查，请结合下方说明审阅。"
                      : "已完成当前检查范围；结果不能证明所有 Mod 兼容。",
                  )}
                </p>
                {report.notices.map((notice, index) => (
                  <p className="performance-hint" key={index}>
                    {message(notice)}
                  </p>
                ))}
                <details className="coverage-mods">
                  <summary>{t("查看检查范围")}</summary>
                  {report.mods.map((mod) => (
                    <p key={mod.id}>
                      <span>
                        {mod.order}. {mod.name}
                      </span>
                      <span>
                        {mod.fileCount} ·{" "}
                        {t(mod.status === "complete" ? "已检查" : "未完整检查")}
                      </span>
                    </p>
                  ))}
                </details>
                <div className="coverage-filters">
                  <label>
                    <span>{t("证据类型")}</span>
                    <select
                      value={kind}
                      aria-label={t("证据类型")}
                      onChange={(event) => {
                        setKind(event.target.value);
                        setSnippet(null);
                      }}
                    >
                      <option value="all">{t("全部证据")}</option>
                      {Object.entries(kinds).map(([id, label]) => (
                        <option key={id} value={id}>
                          {t(label)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>{t("查找文件或 Mod")}</span>
                    <input
                      aria-label={t("查找文件或 Mod")}
                      value={query}
                      onChange={(event) => {
                        setQuery(event.target.value);
                        setSnippet(null);
                      }}
                    />
                  </label>
                </div>
                {groups.length ? (
                  <div className="coverage-columns">
                    <div
                      className="coverage-groups"
                      aria-label={t("覆盖证据列表")}
                    >
                      {groups.map((group) => (
                        <button
                          key={group.id}
                          className={
                            selected?.id === group.id ? "selected" : ""
                          }
                          disabled={busy}
                          onClick={() => {
                            setGroupId(group.id);
                            setSnippet(null);
                          }}
                        >
                          <small>
                            {t(kinds[group.kind])} · {group.evidence.length}
                          </small>
                          <strong>{group.value}</strong>
                        </button>
                      ))}
                    </div>
                    {selected && (
                      <section className="coverage-detail">
                        <h3>{selected.value}</h3>
                        <p className="performance-hint">
                          {t(kinds[selected.kind])}
                        </p>
                        <div className="coverage-sources">
                          {selected.evidence.map((item) => (
                            <button
                              key={item.id}
                              disabled={busy}
                              onClick={() => inspect(item)}
                              aria-label={t("查看 {0} 的文件证据", {
                                0: item.modName,
                              })}
                            >
                              <strong>
                                {item.order}. {item.modName}
                              </strong>
                              <span>
                                {item.path}
                                {item.line ? `:${item.line}` : ""}
                              </span>
                              {item.role && (
                                <small>
                                  {t(
                                    item.role === "declaration"
                                      ? "替换声明"
                                      : "匹配此目录的文件",
                                  )}
                                </small>
                              )}
                            </button>
                          ))}
                        </div>
                        {snippet && (
                          <div
                            className="coverage-snippet"
                            aria-label={t("文件证据")}
                          >
                            <p>
                              {snippet.modName} · {snippet.path}
                              {snippet.line ? `:${snippet.line}` : ""}
                            </p>
                            {snippet.unavailable ? (
                              <p className="performance-hint">
                                {t(
                                  "此文件没有可展示的文本片段；同路径证据仍可审阅。",
                                )}
                              </p>
                            ) : (
                              <pre>
                                {snippet.text
                                  .split(/\r?\n/)
                                  .map((line, index) => (
                                    <span
                                      className={
                                        snippet.firstLine + index ===
                                        snippet.line
                                          ? "highlight"
                                          : ""
                                      }
                                      key={index}
                                    >
                                      <i>{snippet.firstLine + index}</i>
                                      {line}
                                      {"\n"}
                                    </span>
                                  ))}
                              </pre>
                            )}
                            {snippet.truncated && (
                              <p className="performance-hint">
                                {t("仅展示对应位置附近的文本。")}
                              </p>
                            )}
                          </div>
                        )}
                      </section>
                    )}
                  </div>
                ) : (
                  <p className="snapshot-empty">
                    {t(
                      report.groups.length
                        ? "没有匹配的证据。"
                        : "当前检查范围内未发现上述覆盖证据。",
                    )}
                  </p>
                )}
                <p className="performance-hint">
                  {t("配置或文件变化后请重新检查；证据只对应本次扫描。")}
                </p>
              </>
            )}
          </div>
        </Dialog>
      )}
    </>
  );
}
