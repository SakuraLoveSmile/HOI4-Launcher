import { useI18n, T } from "./i18n.jsx";
import React, { useEffect, useRef, useState } from "react";
import { Download, RefreshCw, Square } from "lucide-react";
const PAGE_SIZE = 40;
const activeStatuses = new Set(["queued", "running", "cancelling"]);
const jobLabels = {
  queued: "等待提交",
  running: "正在逐项提交",
  cancelling: "正在停止后续请求",
  completed: "请求处理完成",
  partial: "部分请求未完成",
  cancelled: "已停止后续请求",
  interrupted: "请求结果需核对",
  blocked: "已停止，请检查提示",
};
const itemLabels = {
  pending: "尚未提交",
  checking: "正在核验并请求",
  submitted: "已提交至 Steam",
  skipped: "无需重复请求",
  failed: "请求未完成",
  unknown: "结果未知，请核对",
  cancelled: "未提交",
};
export default function SteamMissingMods({
  api,
  state,
  steam,
  perform,
  busy,
  Dialog,
  onState,
}) {
  const { t, message, locale } = useI18n();
  const [snapshot, setSnapshot] = useState({
    job: null,
    plan: null,
  });
  const [review, setReview] = useState(null),
    [notice, setNotice] = useState("");
  const [planPage, setPlanPage] = useState(0),
    [jobPage, setJobPage] = useState(0);
  const reading = useRef(false);
  const availableApi = typeof api.getSteamMissingMods === "function";
  useEffect(() => {
    if (!availableApi) return;
    let alive = true;
    const refresh = async () => {
      if (reading.current) return;
      reading.current = true;
      try {
        const next = await api.getSteamMissingMods();
        if (alive) setSnapshot(next);
      } catch {
        if (alive) setNotice("补齐任务状态暂不可读，请稍后重试。");
      } finally {
        reading.current = false;
      }
    };
    refresh();
    const timer = setInterval(refresh, 1000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [api, availableApi]);
  if (!availableApi) return null;
  const playset =
    state.settings.playsets.find(
      (entry) => entry.id === state.settings.activePlaysetId,
    ) || state.settings.playsets[0];
  const local = new Set(
    state.mods.filter((mod) => mod.available).map((mod) => mod.id),
  );
  const members = [
    ...new Set([...(playset?.modOrder || []), ...(playset?.modIds || [])]),
  ];
  const missing = members.filter(
    (id) => id.startsWith("workshop:") && !local.has(id),
  );
  const job = snapshot.job,
    active = activeStatuses.has(job?.status);
  const pageItems =
    job?.items?.slice(jobPage * PAGE_SIZE, (jobPage + 1) * PAGE_SIZE) || [];
  const completed =
    job?.items?.filter((item) => !["pending", "checking"].includes(item.status))
      .length || 0;
  async function prepare() {
    await perform("steam-missing-prepare", async () => {
      const plan = await api.prepareSteamMissingMods({
        playsetId: playset.id,
      });
      setReview(plan);
      setPlanPage(0);
      setNotice("");
      setSnapshot((previous) => ({
        ...previous,
        plan,
      }));
      return plan;
    });
  }
  async function commit() {
    await perform("steam-missing-commit", async () => {
      const started = await api.commitSteamMissingMods(review.id);
      setSnapshot({
        job: started,
        plan: null,
      });
      setReview(null);
      setJobPage(0);
      setNotice("");
      return started;
    });
  }
  function pagination(count, page, setPage, label) {
    if (count <= PAGE_SIZE) return null;
    return (
      <div className="catalog-pagination">
        <span>
          <T
            id={"{0} 项 · 第 {1} / {2} 页"}
            values={[count, page + 1, Math.ceil(count / PAGE_SIZE)]}
          />
        </span>
        <div>
          <button
            className="button subtle"
            aria-label={t("{0}上一页", {
              0: t(label),
            })}
            disabled={page === 0}
            onClick={() => setPage(page - 1)}
          >
            <T id={"上一页"} />
          </button>
          <button
            className="button subtle"
            aria-label={t("{0}下一页", {
              0: t(label),
            })}
            disabled={(page + 1) * PAGE_SIZE >= count}
            onClick={() => setPage(page + 1)}
          >
            <T id={"下一页"} />
          </button>
        </div>
      </div>
    );
  }
  return (
    <section
      className="panel catalog-panel steam-missing-panel"
      aria-label={t("补齐预设 Steam 模组")}
    >
      <div className="section-heading">
        <div>
          <h2>
            <T id={"补齐预设模组"} />
          </h2>
          <p className="section-description">
            <T
              id={"「{0}」有 {1} 个 Steam 模组文件缺失，包含未启用成员。"}
              values={[playset?.name, missing.length]}
            />
          </p>
        </div>
        <button
          className="button primary"
          disabled={
            busy ||
            active ||
            steam.repairing ||
            !steam.connected ||
            !missing.length
          }
          onClick={prepare}
        >
          <Download size={14} />
          <T id={"审阅补齐计划"} />
        </button>
      </div>
      <p className="section-description">
        <T
          id={
            "确认名单后才会订阅并请求下载，预设顺序与启用状态会保留。Steam 下载速度与暂停由 Steam 客户端管理。"
          }
        />
      </p>
      {!steam.connected && (
        <p className="inline-note">
          <T id={"请先点击「连接 Steam」，再准备补齐计划。"} />
        </p>
      )}
      {(notice || job?.error) && (
        <p className="inline-note" role="status">
          {message(notice || job.error)}
        </p>
      )}
      {job && (
        <div className="download-job">
          <div className="download-job-title">
            <strong>
              {job.playsetName} · {t(jobLabels[job.status] || job.status)}
            </strong>
            <span>
              <T id={"{0} / {1} 项"} values={[completed, job.items.length]} />
            </span>
          </div>
          <p>
            <T
              id={"账号：{0}。已提交不代表已安装；文件到位后刷新本地模组。"}
              values={[job.account?.name || t("Steam 玩家")]}
            />
          </p>
          <progress
            aria-label={t("补齐请求处理进度")}
            value={completed}
            max={job.items.length || 1}
          />
          <ul className="publish-files">
            {pageItems.map((item) => (
              <li key={item.id}>
                <span>
                  {item.name}{" "}
                  <small>
                    #{item.id} · {item.enabled ? t("已启用") : t("未启用")}
                  </small>
                </span>
                <span>
                  {t(itemLabels[item.status] || item.status)}
                  {item.subscription === "confirmed" ? t(" · 已确认订阅") : ""}
                  {item.downloadRequest === "accepted"
                    ? t(" · 已接受下载请求")
                    : ""}
                  {item.downloadRequest === "already-active"
                    ? t(" · Steam 已在下载或排队")
                    : ""}
                  {message(item.error) && <small>{message(item.error)}</small>}
                </span>
              </li>
            ))}
          </ul>
          {pagination(job.items.length, jobPage, setJobPage, t("补齐结果"))}
          <div className="modal-actions">
            {job.canCancel && (
              <button
                className="button subtle"
                onClick={() =>
                  perform("steam-missing-cancel", async () => {
                    const next = await api.cancelSteamMissingMods();
                    setSnapshot((previous) => ({
                      ...previous,
                      job: next,
                      plan: null,
                    }));
                    return next;
                  })
                }
              >
                <Square size={13} />
                <T id={"停止后续请求"} />
              </button>
            )}
            <button
              className="button subtle"
              disabled={busy || active}
              onClick={() =>
                perform("steam-missing-refresh", async () => {
                  const next = await api.getState();
                  onState(next);
                  setNotice("已刷新本地模组；仍缺失的内容可重新审阅补齐。");
                  return next;
                })
              }
            >
              <RefreshCw size={13} />
              <T id={"刷新本地模组"} />
            </button>
          </div>
        </div>
      )}
      {review && (
        <Dialog
          title={t("确认补齐 Steam 模组")}
          onClose={() => !busy && setReview(null)}
        >
          <p className="modal-description">
            <T
              id={
                "将为 Steam 账号「{0}」（{1}）处理「{2}」的 {3} 个缺失模组。未订阅的项目会订阅，下载使用普通优先级。"
              }
              values={[
                review.account.name,
                review.account.steamId,
                review.playsetName,
                review.items.length,
              ]}
            />
          </p>
          <p className="inline-note">
            <T
              id={
                "停止后续请求不会撤回当前模组请求，Steam 已接受的下载可能继续。"
              }
            />
          </p>
          <ul className="publish-files">
            {review.items
              .slice(planPage * PAGE_SIZE, (planPage + 1) * PAGE_SIZE)
              .map((item) => (
                <li key={item.id}>
                  <span>
                    {item.name}
                    <small>Steam #{item.id}</small>
                  </span>
                  <span>{item.enabled ? t("已启用") : t("未启用")}</span>
                </li>
              ))}
          </ul>
          {pagination(
            review.items.length,
            planPage,
            setPlanPage,
            t("补齐计划"),
          )}
          <div className="modal-actions">
            <button
              className="button subtle"
              disabled={busy}
              onClick={() => setReview(null)}
            >
              <T id={"返回"} />
            </button>
            <button className="button primary" disabled={busy} onClick={commit}>
              <T id={"确认订阅并请求下载"} />
            </button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
