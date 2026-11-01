import React, { useEffect, useRef, useState } from "react";
import { Download, ExternalLink, RefreshCw } from "lucide-react";
import { useI18n } from "./i18n.jsx";
import { version } from "../package.json";
import "./launcher-updates.css";

const active = (status) =>
  ["checking", "downloading", "installing"].includes(status);
const statusLabels = {
  idle: "检查 GitHub 上的启动器新版本。",
  checking: "正在检查启动器更新…",
  current: "当前已是最新稳定版本。",
  available: "发现启动器新版本。",
  downloading: "正在下载并校验更新…",
  ready: "更新已下载并通过校验。",
  installing: "正在退出并安装更新…",
  cancelled: "更新下载已取消，可重新下载。",
  error: "启动器更新未完成，请重试。",
};

export default function LauncherUpdates({ api, busy, running, Dialog }) {
  const { t, message } = useI18n();
  const [update, setUpdate] = useState({ status: "idle" });
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState(false);
  const mounted = useRef(false);
  const acting = useRef(false);
  const supported = Boolean(api.getLauncherUpdate);

  useEffect(() => {
    mounted.current = true;
    if (!supported)
      return () => {
        mounted.current = false;
      };
    let reading = false;
    async function poll() {
      if (reading) return;
      reading = true;
      try {
        const next = await api.getLauncherUpdate();
        if (mounted.current) setUpdate(next);
      } catch (failure) {
        if (mounted.current) setError(failure.message);
      } finally {
        reading = false;
      }
    }
    poll();
    const timer = setInterval(poll, 700);
    return () => {
      mounted.current = false;
      clearInterval(timer);
    };
  }, [api, supported]);

  async function action(method) {
    if (acting.current) return;
    acting.current = true;
    setWorking(true);
    setError("");
    try {
      await api[method]();
    } catch (failure) {
      if (mounted.current) setError(failure.message);
    } finally {
      try {
        const next = await api.getLauncherUpdate();
        if (mounted.current) setUpdate(next);
      } catch (failure) {
        if (mounted.current) setError(failure.message);
      }
      acting.current = false;
      if (mounted.current) setWorking(false);
    }
  }

  const locked = working || active(update.status);
  const release = update.release;
  const received = update.progress?.received || 0;
  const total = update.progress?.total || release?.size || 0;
  const problem = error || update.error;
  const canDownload =
    release?.canDownload &&
    ["available", "error", "cancelled"].includes(update.status);

  return (
    <section className="panel settings-panel launcher-updates">
      <div className="section-heading">
        <h2>{t("启动器更新")}</h2>
        <span className="section-count">
          v{update.currentVersion || version}
        </span>
      </div>
      <p className="section-description">
        GitHub · SakuraLoveSmile/HOI4-Launcher
      </p>
      <p role="status" aria-live="polite" className="launcher-update-status">
        {t(
          supported
            ? statusLabels[update.status] || statusLabels.idle
            : "请在桌面版中检查启动器更新。",
        )}
      </p>
      {release && (
        <div className="launcher-update-release">
          <strong>
            {t("可用版本")} · v{release.version}
          </strong>
          {release.notes && (
            <p className="launcher-update-notes">{release.notes}</p>
          )}
          {!release.canDownload && (
            <p className="inline-note">
              {t("此发布缺少可校验的更新包，请前往发布页。")}
            </p>
          )}
        </div>
      )}
      {update.status === "downloading" && (
        <div className="launcher-update-progress">
          <progress
            aria-label={t("更新下载进度")}
            value={received}
            max={total || 1}
          />
          <small>
            {(received / 1048576).toFixed(1)} / {(total / 1048576).toFixed(1)}{" "}
            MiB
          </small>
        </div>
      )}
      {problem && (
        <p className="inline-note error" role="alert">
          {message(problem)}
        </p>
      )}
      {supported && !update.canInstall && (
        <p className="section-description">
          {t("当前运行方式不支持原位更新，可下载新版后手动替换。")}
        </p>
      )}
      {running && (
        <p className="inline-note">{t("请先退出游戏，再安装启动器更新。")}</p>
      )}
      <div className="launcher-update-actions">
        <button
          className="button subtle"
          disabled={!supported || busy || locked}
          onClick={() => action("checkLauncherUpdate")}
        >
          <RefreshCw
            size={15}
            className={update.status === "checking" ? "spinning" : ""}
          />
          {t("检查更新")}
        </button>
        {canDownload && (
          <button
            className="button primary"
            disabled={busy || locked}
            onClick={() => action("downloadLauncherUpdate")}
          >
            <Download size={15} />
            {t("下载更新")}
          </button>
        )}
        {["checking", "downloading"].includes(update.status) && (
          <button
            className="button subtle"
            onClick={async () => {
              try {
                await api.cancelLauncherUpdate();
              } catch (failure) {
                if (mounted.current) setError(failure.message);
              }
            }}
          >
            {t("取消")}
          </button>
        )}
        {update.status === "ready" && (
          <button
            className="button primary"
            disabled={busy || locked || running || !update.canInstall}
            onClick={() => setConfirm(true)}
          >
            <RefreshCw size={15} />
            {t("安装并重启")}
          </button>
        )}
        <button
          className="button subtle"
          disabled={!api.openLauncherReleases}
          onClick={async () => {
            try {
              await api.openLauncherReleases();
            } catch (failure) {
              if (mounted.current) setError(failure.message);
            }
          }}
        >
          <ExternalLink size={15} />
          {t("打开 GitHub 发布页")}
        </button>
      </div>
      {confirm && (
        <Dialog
          title={t("安装启动器更新")}
          onClose={() => !working && setConfirm(false)}
        >
          <p className="modal-description">
            {t(
              "安装将关闭启动器，保留旧程序备份并重启新版；游戏配置和模组保持原位。",
            )}
          </p>
          <div className="modal-actions">
            <button
              className="button subtle"
              disabled={working}
              onClick={() => setConfirm(false)}
            >
              {t("取消")}
            </button>
            <button
              className="button primary"
              disabled={
                busy ||
                locked ||
                running ||
                !update.canInstall ||
                update.status !== "ready"
              }
              onClick={() => {
                setConfirm(false);
                action("installLauncherUpdate");
              }}
            >
              {t("确认安装并重启")}
            </button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
