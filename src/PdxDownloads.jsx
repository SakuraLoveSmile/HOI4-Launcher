import { useI18n, T } from "./i18n.jsx";
import React, { useEffect, useRef, useState } from "react";
import { Download, Pause, Play, RefreshCw, Trash2, X } from "lucide-react";
export const activePdxJob = (job) =>
  [
    "queued",
    "resolving",
    "verifying",
    "downloading",
    "installing",
    "cancelling",
    "pausing",
  ].includes(job?.status);
const statuses = {
  queued: "等待下载",
  resolving: "正在获取版本",
  verifying: "正在验证安装",
  downloading: "正在下载",
  installing: "校验并安装",
  cancelling: "正在取消",
  pausing: "正在保存下载进度",
  paused: "已暂停",
  succeeded: "安装完成",
  cancelled: "下载已取消",
  failed: "下载未完成",
  interrupted: "上次下载已中断",
};
export const formatBytes = (value = 0) =>
  value >= 1024 ** 3
    ? `${(value / 1024 ** 3).toFixed(2)} GiB`
    : value >= 1024 ** 2
      ? `${(value / 1024 ** 2).toFixed(1)} MiB`
      : `${Math.ceil(value / 1024)} KiB`;
export function usePdxDownloads(api, onState) {
  const [downloads, setDownloads] = useState({
    job: null,
    installations: [],
    bytesPerSecond: 0,
  });
  const [error, setError] = useState("");
  const lastCompleted = useRef("");
  useEffect(() => {
    let alive = true,
      reading = false;
    async function refresh() {
      if (reading) return;
      reading = true;
      try {
        const next = await api.getPdxDownloads();
        if (!alive) return;
        setDownloads(next);
        setError("");
        if (
          next.job?.status === "succeeded" &&
          lastCompleted.current !== next.job.id
        ) {
          const state = await api.getState();
          if (alive) {
            onState(state);
            lastCompleted.current = next.job.id;
          }
        }
      } catch {
        if (alive) setError("下载状态暂时不可用，请重新进入此页面重试。");
      } finally {
        reading = false;
      }
    }
    refresh();
    const timer = setInterval(refresh, 1000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [api, onState]);
  return {
    downloads,
    setDownloads,
    error,
  };
}
export default function PdxDownloads({
  api,
  state,
  downloads,
  setDownloads,
  error,
  perform,
  busy,
  onState,
  Dialog,
  start,
  authorization,
  setAuthorization,
}) {
  const { t, message, locale } = useI18n();
  const [remove, setRemove] = useState(null);
  const [repair, setRepair] = useState(null);
  const job = downloads.job,
    active = activePdxJob(job);
  const pending = active || job?.canResume || job?.canCancel;
  const retained = [
    ...new Set([
      ...(job?.retainedDownloadDirectories || []),
      ...(job?.retainedDownloadDirectory
        ? [job.retainedDownloadDirectory]
        : []),
    ]),
  ];
  const userModDirectory = (
    state.paths.userData.replace(/\\/g, "/").replace(/\/$/, "") + "/mod/"
  ).toLowerCase();
  const installed = downloads.installations.filter((item) =>
    item.descriptorPath
      .replace(/\\/g, "/")
      .toLowerCase()
      .startsWith(userModDirectory),
  );
  const otherDirectories = downloads.installations.filter(
    (item) => !installed.includes(item),
  );
  const playset = state.settings.playsets.find(
    (item) => item.id === state.settings.activePlaysetId,
  );
  const missing = (playset?.modReferences || []).filter(
    (ref) =>
      ref.source === "pdx" &&
      !state.mods.some(
        (mod) =>
          mod.id === ref.id &&
          mod.available &&
          (!ref.version || ref.version === mod.installedRevision),
      ),
  );
  return (
    <section className="panel pdx-downloads">
      <div className="section-heading">
        <h2>
          <Download size={18} />
          <T id={"本地下载"} />
        </h2>
        <label className="download-limit">
          <T id={"限速"} />
          <select
            aria-label={t("Paradox 下载限速")}
            value={downloads.bytesPerSecond}
            disabled={busy || active}
            onChange={(event) =>
              perform("download-limit", async () => {
                const value = await api.setPdxDownloadLimit(
                  Number(event.target.value),
                );
                setDownloads((previous) => ({
                  ...previous,
                  bytesPerSecond: value,
                }));
              })
            }
          >
            <option value={0}>
              <T id={"不限速"} />
            </option>
            <option value={512 * 1024}>512 KiB/s</option>
            <option value={1024 ** 2}>1 MiB/s</option>
            <option value={5 * 1024 ** 2}>5 MiB/s</option>
            <option value={10 * 1024 ** 2}>10 MiB/s</option>
          </select>
        </label>
      </div>
      <p className="section-description">
        <T
          id={
            "下载模组并安装到本机；私有内容需选择有权访问的当前账号。下载不会更改账号订阅。"
          }
        />
      </p>
      <label className="download-limit">
        <T id={"下载身份"} />
        <select
          aria-label={t("Paradox 下载身份")}
          value={authorization}
          disabled={busy || pending}
          onChange={(event) => setAuthorization(event.target.value)}
        >
          <option value="anonymous">
            <T id={"公开下载（无需账号）"} />
          </option>
          <option value="account">
            <T id={"使用当前 Paradox 账号"} />
          </option>
        </select>
      </label>
      {authorization === "account" && (
        <p className="section-description">
          <T
            id={
              "请先在设置页登录。将用当前账号读取你有权访问的模组版本；退出或重新登录会停止尚未完成的下载。"
            }
          />
        </p>
      )}
      {message(error) && (
        <p role="alert" className="inline-note">
          {message(error)}
        </p>
      )}
      {otherDirectories.length > 0 && (
        <p className="inline-note">
          <T
            id={
              "另有 {0} 个模组安装在其他游戏用户目录。切回原目录后可更新或卸载：{1}"
            }
            values={[
              otherDirectories.length,
              [
                ...new Set(
                  otherDirectories.map((item) =>
                    item.descriptorPath.replace(/[/\\]mod[/\\][^/\\]+$/, ""),
                  ),
                ),
              ].join("；"),
            ]}
          />
        </p>
      )}
      {job && (
        <div className="download-job" role="status">
          <div className="download-job-title">
            <strong>
              {job.titleIsFallback
                ? t("Paradox 模组 {0}", { 0: job.modId })
                : job.title}
            </strong>
            <span>
              {t(
                job.operation === "repair" && job.status === "succeeded"
                  ? "验证与修复完成"
                  : job.operation === "repair" && job.status === "failed"
                    ? "验证与修复未完成"
                    : statuses[job.status] || job.status,
              )}
            </span>
          </div>
          <p>
            {job.authorization === "account"
              ? t("账号授权下载")
              : t("公开下载")}
            {job.revision
              ? t(" · 版本 {0}", {
                  0: job.revision,
                })
              : ""}
          </p>
          {job.progress && (
            <>
              <progress
                max={job.progress.totalBytes || 1}
                value={job.progress.receivedBytes || 0}
                aria-label={t("Paradox 下载进度")}
              />
              <p>
                {formatBytes(job.progress.receivedBytes)} /{" "}
                {formatBytes(job.progress.totalBytes)} ·{" "}
                {formatBytes(job.progress.bytesPerSecond)}/s
              </p>
            </>
          )}
          {message(job.error) && (
            <p className="inline-note">{message(job.error)}</p>
          )}
          {job.errorCode === "ACCESS_DENIED" &&
            job.authorization !== "account" && (
              <p className="inline-note">
                <T
                  id={
                    "可选择“使用当前 Paradox 账号”后重新下载，是否可用取决于该账号的访问权限。"
                  }
                />
              </p>
            )}
          {retained.length > 0 && (
            <details className="storage-retained">
              <summary>
                <T
                  id={"保留的临时下载位置（{0}）"}
                  values={[retained.length]}
                />
              </summary>
              <ul>
                {retained.map((directory) => (
                  <li key={directory}>
                    <code>{directory}</code>
                  </li>
                ))}
              </ul>
            </details>
          )}
          {message(job.notice) && <p>{message(job.notice)}</p>}
          {job.validation && (
            <div className="pdx-validation">
              {job.validation.status === "unverified" ? (
                <p className="inline-note">
                  <T id={"缺少可信文件基准，需要下载同版本完整包核对。"} />
                </p>
              ) : (
                <p>
                  <T
                    id={
                      "文件验证：已检查 {0}/{1}；缺失 {2}，改动 {3}，多余 {4}，不安全 {5}。"
                    }
                    values={[
                      job.validation.checkedFiles,
                      job.validation.totalFiles,
                      job.validation.missingFiles,
                      job.validation.changedFiles,
                      job.validation.extraFiles,
                      job.validation.unsafeFiles,
                    ]}
                  />
                </p>
              )}
              {job.validation.registrationIntact === false && (
                <p className="inline-note">
                  <T id={"注册描述文件已改变或丢失。"} />
                </p>
              )}
              {job.validation.issues?.length > 0 && (
                <details className="storage-retained">
                  <summary>
                    <T id={"文件检查结果"} />
                  </summary>
                  <ul>
                    {job.validation.issues.map((issue, index) => (
                      <li key={`${issue.path}-${index}`}>
                        {t(
                          {
                            missing: "文件缺失",
                            changed: "文件已改动",
                            extra: "额外文件",
                            unsafe: "不安全的文件",
                          }[issue.kind] || "不安全的文件",
                        )}
                        {"："}
                        <code>{issue.path}</code>
                      </li>
                    ))}
                  </ul>
                  {job.validation.issuesTruncated && (
                    <p>
                      <T id={"当前验证结果的文件列表已截断。"} />
                    </p>
                  )}
                </details>
              )}
            </div>
          )}
          {job.installed?.repair?.retainedContentPath && (
            <p>
              <T
                id={"旧内容保留在：{0}"}
                values={[job.installed.repair.retainedContentPath]}
              />
            </p>
          )}
          {job.installed?.repair?.retainedDescriptorPath && (
            <p>
              <T
                id={"原注册文件保留在：{0}"}
                values={[job.installed.repair.retainedDescriptorPath]}
              />
            </p>
          )}
          {job.progress?.restarted && (
            <p className="inline-note">
              <T id={"服务器未接受续传，本次改为下载完整文件。"} />
            </p>
          )}
          {active ? (
            <div className="settings-actions">
              {job.canPause && (
                <button
                  className="button subtle"
                  disabled={busy}
                  onClick={() =>
                    perform("pause-download", async () => {
                      const next = await api.pausePdxDownload();
                      setDownloads((previous) => ({
                        ...previous,
                        job: next,
                      }));
                    })
                  }
                >
                  <Pause size={14} />
                  <T id={"暂停下载"} />
                </button>
              )}
              <button
                className="button subtle"
                disabled={
                  busy ||
                  job.status === "cancelling" ||
                  job.installProgress?.cancellable === false
                }
                onClick={() =>
                  perform("cancel-download", async () => {
                    const next = await api.cancelPdxDownload();
                    setDownloads((previous) => ({
                      ...previous,
                      job: next,
                    }));
                  })
                }
              >
                <X size={14} />
                {job.installProgress?.cancellable === false
                  ? t("正在完成安装")
                  : t("取消下载")}
              </button>
            </div>
          ) : job.canResume || job.canCancel ? (
            <div className="settings-actions">
              {job.canResume ? (
                <button
                  className="button primary"
                  disabled={busy || state.launchStatus?.running}
                  onClick={() =>
                    perform("resume-download", async () => {
                      const next = await api.resumePdxDownload();
                      setDownloads((previous) => ({
                        ...previous,
                        job: next,
                      }));
                    })
                  }
                >
                  <Play size={14} />
                  <T id={"继续下载"} />
                </button>
              ) : (
                <p className="inline-note">
                  <T
                    id={
                      "当前片段无法继续，请取消当前任务后重新下载。保留的未知文件不会被删除。"
                    }
                  />
                </p>
              )}
              <button
                className="button subtle"
                disabled={busy}
                onClick={() =>
                  perform("cancel-download", async () => {
                    const next = await api.cancelPdxDownload();
                    setDownloads((previous) => ({
                      ...previous,
                      job: next,
                    }));
                  })
                }
              >
                <X size={14} />
                <T id={"取消下载"} />
              </button>
            </div>
          ) : (
            job.status !== "succeeded" && (
              <button
                className="button subtle"
                disabled={busy || state.launchStatus?.running}
                onClick={() => start(job.modId, job.revision)}
              >
                <RefreshCw size={14} />
                <T id={"重新下载"} />
              </button>
            )
          )}
        </div>
      )}
      {missing.length > 0 && (
        <div className="pdx-managed">
          <h3>
            <T id={"当前预设缺少的 Paradox 模组"} />
          </h3>
          {missing.map((ref) => (
            <div className="pdx-installed-row" key={ref.id}>
              <div>
                <strong>{ref.name}</strong>
                <small>
                  {ref.version
                    ? t("固定版本 {0}", {
                        0: ref.version,
                      })
                    : t("当前公开版本")}
                </small>
              </div>
              <button
                className="button subtle"
                disabled={busy || pending || state.launchStatus?.running}
                onClick={() => start(ref.remoteId, ref.version)}
              >
                <Download size={14} />
                <T id={"下载缺失内容"} />
              </button>
            </div>
          ))}
        </div>
      )}
      {installed.length > 0 && (
        <div className="pdx-managed">
          <h3>
            <T id={"IRONCLAD 管理的安装 · {0}"} values={[installed.length]} />
          </h3>
          {installed.map((item) => (
            <div className="pdx-installed-row" key={item.modId}>
              <div>
                <strong>
                  {item.title ||
                    t("模组 {0}", {
                      0: item.modId,
                    })}
                </strong>
                <small>
                  <T id={"版本 {0}"} values={[item.revision]} />
                </small>
                {item.installationDamaged && (
                  <small>
                    <T id={"安装内容或注册文件已改变或丢失。"} />
                  </small>
                )}
              </div>
              <div>
                <button
                  className="button subtle"
                  disabled={busy || pending || state.launchStatus?.running}
                  onClick={() => setRepair(item)}
                >
                  <RefreshCw size={14} />
                  <T id={"验证并修复"} />
                </button>
                <button
                  className="button subtle"
                  disabled={busy || pending || state.launchStatus?.running}
                  onClick={() => start(item.modId)}
                >
                  <RefreshCw size={14} />
                  <T id={"检查并更新"} />
                </button>
                <button
                  className="icon-button"
                  aria-label={t("卸载 {0}", {
                    0: item.title || item.modId,
                  })}
                  disabled={busy || active || state.launchStatus?.running}
                  onClick={() => setRemove(item)}
                >
                  <Trash2 size={15} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      {repair && (
        <Dialog
          title={t("验证固定版本")}
          onClose={() => !busy && setRepair(null)}
        >
          <p>
            <T
              id={
                "将检查“{0}”的已安装文件。若发现损坏或缺少可信基准，将重新下载并校验完整版本 {1}，旧内容和预设会保留。"
              }
              values={[repair.title || repair.modId, repair.revision]}
            />
          </p>
          <p>
            {authorization === "account" ? t("账号授权下载") : t("公开下载")}
          </p>
          <div className="modal-actions">
            <button
              className="button subtle"
              disabled={busy}
              onClick={() => setRepair(null)}
            >
              <T id={"取消"} />
            </button>
            <button
              className="button primary"
              disabled={busy || pending || state.launchStatus?.running}
              onClick={() =>
                perform("repair-pdx", async () => {
                  const next = await api.repairPdxMod({
                    modId: repair.modId,
                    authorization,
                  });
                  setRepair(null);
                  setDownloads((previous) => ({ ...previous, job: next }));
                })
              }
            >
              <T id={"开始验证"} />
            </button>
          </div>
        </Dialog>
      )}
      {remove && (
        <Dialog
          title={t("卸载本地模组")}
          onClose={() => !busy && setRemove(null)}
        >
          <p>
            <T
              id={
                "将注销 IRONCLAD 安装的“{0}”，旧内容保留为恢复备份。预设引用会保留；若没有其他已安装版本，会显示为缺失。"
              }
              values={[remove.title || remove.modId]}
            />
          </p>
          <div className="dialog-actions">
            <button className="button subtle" onClick={() => setRemove(null)}>
              <T id={"取消"} />
            </button>
            <button
              className="button danger"
              disabled={busy}
              onClick={() =>
                perform("uninstall-pdx", async () => {
                  await api.uninstallPdxMod(remove.modId);
                  setRemove(null);
                  setDownloads(await api.getPdxDownloads());
                  onState(await api.getState());
                })
              }
            >
              <T id={"确认卸载"} />
            </button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
