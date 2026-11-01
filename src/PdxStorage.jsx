import { useI18n, T } from "./i18n.jsx";
import React, { useEffect, useRef, useState } from "react";
import { FolderOpen, HardDrive, RefreshCw, X } from "lucide-react";
import { formatBytes } from "./PdxDownloads.jsx";
const empty = {
  storage: null,
  job: null,
  busy: false,
  recoveryRequired: false,
  error: null,
};
const active = (job) =>
  ["queued", "moving", "committing", "cancelling"].includes(job?.status);
const labels = {
  queued: "等待迁移",
  moving: "正在复制和校验",
  committing: "正在切换模组位置",
  cancelling: "正在取消迁移",
  succeeded: "迁移已完成",
  cancelled: "迁移已取消",
  failed: "迁移未完成",
};
export function usePdxStorage(api, userDataPath, enabled, onState) {
  const [data, setData] = useState(empty);
  const completed = useRef("");
  useEffect(() => {
    let alive = true,
      reading = false;
    setData(empty);
    if (!enabled || !api.getPdxStorageState) return;
    async function refresh() {
      if (reading) return;
      reading = true;
      try {
        const next = await api.getPdxStorageState();
        if (!alive) return;
        setData(next);
        if (
          !next.busy &&
          next.job?.status === "succeeded" &&
          completed.current !== next.job.id
        ) {
          const current = await api.getState();
          if (alive) {
            onState(current);
            completed.current = next.job.id;
          }
        }
      } catch (error) {
        if (alive)
          setData((previous) => ({
            ...previous,
            recoveryRequired: true,
            error: (error?.message || "无法读取模组目录状态。").replace(
              /^Error invoking remote method '[^']+': (Error: )?/,
              "",
            ),
          }));
      } finally {
        reading = false;
      }
    }
    refresh();
    const timer = setInterval(refresh, 1200);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [api, userDataPath, enabled, onState]);
  return {
    data,
    setData,
  };
}
function Paths({ paths }) {
  const { t, message, locale } = useI18n();
  return paths?.length ? (
    <details className="storage-retained">
      <summary>
        <T id={"保留的内容位置（{0}）"} values={[paths.length]} />
      </summary>
      <ul>
        {paths.map((value) => (
          <li key={value}>
            <code>{value}</code>
          </li>
        ))}
      </ul>
    </details>
  ) : null;
}
export default function PdxStorage({
  api,
  state,
  data,
  setData,
  perform,
  busy,
  Dialog,
}) {
  const { t, message, locale } = useI18n();
  const [review, setReview] = useState(null);
  const disabled =
    busy || data.busy || state.launchStatus?.running || !state.game.found;
  async function prepare(reset) {
    await perform("pdx-storage-prepare", async () => {
      const next = await api.preparePdxRelocation({
        reset,
      });
      if (next) setReview(next);
      return next;
    });
  }
  async function close() {
    if (busy) return;
    await perform("pdx-storage-discard", async () => {
      await api.discardPdxRelocation();
      setReview(null);
    });
  }
  return (
    <section className="panel settings-panel pdx-storage">
      <div className="section-heading">
        <h2>
          <HardDrive size={19} />
          <T id={"Paradox 模组位置"} />
        </h2>
      </div>
      <p className="section-description">
        <T
          id={
            "选择 IRONCLAD 下载模组的存放位置。现有受管内容会一并迁移，预设顺序与版本保持不变。"
          }
        />
      </p>
      <div className="path-box">
        <FolderOpen size={18} />
        <span>
          {data.storage?.location ||
            (state.game.found ? t("正在读取模组目录…") : t("请先配置游戏目录"))}
        </span>
      </div>
      {message(data.errorDiagnostic ?? data.error, data.error) && (
        <p className="inline-note" role="alert">
          {message(data.errorDiagnostic ?? data.error, data.error)}
        </p>
      )}
      <div className="settings-actions">
        <button
          className="button subtle"
          disabled={disabled || data.recoveryRequired || !data.storage}
          onClick={() => prepare(false)}
        >
          <FolderOpen size={16} />
          <T id={"选择模组位置"} />
        </button>
        <button
          className="button subtle"
          disabled={
            disabled ||
            data.recoveryRequired ||
            !data.storage ||
            data.storage.isDefault
          }
          onClick={() => prepare(true)}
        >
          <RefreshCw size={16} />
          <T id={"恢复默认位置"} />
        </button>
        {data.recoveryRequired && (
          <button
            className="button subtle"
            disabled={disabled}
            onClick={() =>
              perform(
                "pdx-storage-recover",
                async () => {
                  await api.recoverPdxStorage();
                  setData(await api.getPdxStorageState());
                },
                "模组目录已恢复",
              )
            }
          >
            <RefreshCw size={16} />
            <T id={"重试恢复目录"} />
          </button>
        )}
      </div>
      <Paths paths={data.storage?.retainedLegacyPaths} />
      <Paths paths={data.retainedPaths} />
      {data.job && (
        <div className="download-job" role="status">
          <div className="download-job-title">
            <strong>{t(labels[data.job.status]) || t("目录迁移")}</strong>
          </div>
          <p className="storage-target">
            <T id={"目标："} />
            <code>{data.job.to}</code>
          </p>
          {active(data.job) && data.job.progress && (
            <>
              <progress
                aria-label={t("Paradox 目录迁移进度")}
                max={data.job.progress.totalBytes || 1}
                value={data.job.progress.processedBytes || 0}
              />
              <p>
                <T
                  id={"{0} / {1} · {2} / {3} 个文件"}
                  values={[
                    formatBytes(data.job.progress.processedBytes),
                    formatBytes(data.job.progress.totalBytes),
                    data.job.progress.filesDone || 0,
                    data.job.progress.totalFiles || 0,
                  ]}
                />
              </p>
              <button
                className="button subtle"
                disabled={
                  busy ||
                  data.job.status === "cancelling" ||
                  data.job.progress.cancellable === false
                }
                onClick={() =>
                  perform("pdx-storage-cancel", async () => {
                    const job = await api.cancelPdxRelocation();
                    setData((previous) => ({
                      ...previous,
                      job,
                    }));
                  })
                }
              >
                <X size={14} />
                {data.job.progress.cancellable === false
                  ? t("正在完成目录切换")
                  : t("取消迁移")}
              </button>
            </>
          )}
          {message(
            data.job.errorDiagnostic ?? data.job.error,
            data.job.error,
          ) && (
            <p className="inline-note">
              {message(
                data.job.errorDiagnostic ?? data.job.error,
                data.job.error,
              )}
            </p>
          )}
          {data.job.result?.warnings?.map((warning, i) => (
            <p className="inline-note" key={i}>
              {message(warning)}
            </p>
          ))}
          <Paths paths={data.job.result?.retainedPaths} />
          <Paths paths={data.job.retainedPaths} />
        </div>
      )}
      {review && (
        <Dialog title={t("预览模组目录迁移")} onClose={close}>
          <p className="modal-description">
            <T
              id={
                "确认后复制并核验以下内容，再切换模组注册信息；切换成功后清理已验证的原文件。"
              }
            />
          </p>
          <div className="path-detail">
            <span>
              <T id={"当前位置"} />
            </span>
            <code>{review.from}</code>
          </div>
          <div className="path-detail">
            <span>
              <T id={"目标位置"} />
            </span>
            <code>{review.to}</code>
          </div>
          <p className="storage-summary">
            <T
              id={"{0} 个模组版本 · {1} 个文件 · {2}"}
              values={[
                review.installations.length,
                review.files,
                formatBytes(review.bytes),
              ]}
            />
          </p>
          {review.installations.length > 0 && (
            <details>
              <summary>
                <T id={"查看迁移的模组"} />
              </summary>
              <ul className="publish-files">
                {review.installations.map((item, index) => (
                  <li
                    key={
                      item.transactionId ||
                      `${item.modId}:${item.revision}:${index}`
                    }
                  >
                    <span>{item.title}</span>
                    <small>
                      {item.retained ? t("保留版本") : t("当前版本")}{" "}
                      {item.revision}
                    </small>
                  </li>
                ))}
              </ul>
            </details>
          )}
          {review.conflicts.length > 0 && (
            <div className="inline-note" role="alert">
              <p>
                <T id={"请先处理以下冲突，再重新选择目录："} />
              </p>
              <ul>
                {review.conflicts.map((value, i) => (
                  <li key={i}>{message(value)}</li>
                ))}
              </ul>
            </div>
          )}
          <Paths paths={review.retainedLegacyPaths} />
          <div className="modal-actions">
            <button className="button subtle" disabled={busy} onClick={close}>
              <T id={"取消"} />
            </button>
            <button
              className="button primary"
              disabled={disabled || review.conflicts.length > 0}
              onClick={() =>
                perform("pdx-storage-commit", async () => {
                  const job = await api.commitPdxRelocation(review.planId);
                  setData((previous) => ({
                    ...previous,
                    job,
                    busy: true,
                  }));
                  setReview(null);
                })
              }
            >
              <T id={"确认迁移"} />
            </button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
