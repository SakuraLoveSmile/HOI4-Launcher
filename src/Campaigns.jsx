import React, { useEffect, useState } from "react";
import {
  Archive,
  FileText,
  FolderOpen,
  RefreshCw,
  Save,
  Play,
  Plus,
} from "lucide-react";
import { useI18n } from "./i18n.jsx";
import "./campaigns.css";

export const changeLabels = {
  game: "游戏版本变化",
  "mods-added": "新增启用模组",
  "mods-removed": "停用或移除模组",
  order: "加载顺序变化",
  "mod-version": "模组版本变化",
  "mod-content": "模组内容变化",
  dlc: "DLC 选择变化",
  settings: "游戏设置变化",
  mode: "启动模式变化",
  unverified: "模组内容尚未核实",
};
export function EnvironmentChanges({
  changes = [],
  emptyKey = "与档案记录的配置一致。",
}) {
  const { t } = useI18n();
  return changes.length ? (
    <ul className="environment-changes">
      {changes.map((item, index) => (
        <li key={index}>
          <strong>{t(changeLabels[item.kind] || "配置变化")}</strong>
          {item.name && <span>{item.name}</span>}
          {item.kind !== "unverified" && (
            <details>
              <summary>{t("查看差异")}</summary>
              <div className="environment-diff">
                <pre>{JSON.stringify(item.before ?? null, null, 2)}</pre>
                <pre>{JSON.stringify(item.after ?? null, null, 2)}</pre>
              </div>
            </details>
          )}
        </li>
      ))}
    </ul>
  ) : (
    <p className="inline-note">{t(emptyKey)}</p>
  );
}
export function CampaignReview({
  review,
  Dialog,
  busy,
  canLaunch,
  onClose,
  onContinue,
  onRestore,
}) {
  const { t, locale } = useI18n();
  if (!review) return null;
  return (
    <Dialog title={t("继续战役前检查")} onClose={onClose}>
      <div className="campaign-review">
        <h3>{review.campaign.name}</h3>
        <p>{review.campaign.filename}</p>
        <p className="section-description">
          {t(
            "已比较游戏版本、模组顺序与内容、DLC 和游戏设置。差异提示不等同存档兼容性验证。",
          )}
        </p>
        <EnvironmentChanges changes={review.changes} />
        <p className="performance-hint">
          {t("检查时间")} · {new Date(review.checkedAt).toLocaleString(locale)}
        </p>
        <div className="campaign-actions">
          <button className="button subtle" disabled={busy} onClick={onRestore}>
            {t("恢复记录配置并重新检查")}
          </button>
          <button
            className="button primary"
            disabled={busy || !canLaunch}
            onClick={() =>
              onContinue({
                campaignId: review.campaign.id,
                reviewId: review.reviewId,
              })
            }
          >
            <Play size={15} />
            {t("使用当前配置继续")}
          </button>
        </div>
        <p className="performance-hint">
          {t("恢复配置会创建新播放集；恢复实际 Mod 文件请使用组合快照。")}
        </p>
      </div>
    </Dialog>
  );
}
export function CampaignProgress({ api, active }) {
  const { t } = useI18n();
  const [progress, setProgress] = useState(null);
  useEffect(() => {
    if (!active || !api.getCampaignProgress) return;
    let alive = true;
    const refresh = () =>
      api
        .getCampaignProgress()
        .then((v) => {
          if (alive) setProgress(v);
        })
        .catch(() => {});
    refresh();
    const timer = setInterval(refresh, 600);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [api, active]);
  if (!active) return null;
  return (
    <div className="campaign-progress" role="status">
      <span>
        {t("正在检查模组内容或备份存档…")}
        {progress?.progress &&
          ` ${progress.progress.index} / ${progress.progress.total}`}
      </span>
      <button
        className="text-button"
        disabled={!progress?.canCancel}
        onClick={() => api.cancelCampaignCheck?.()}
      >
        {t("取消检查")}
      </button>
    </div>
  );
}
export default function Campaigns({
  api,
  state,
  perform,
  busy,
  Dialog,
  onState,
  onReview,
}) {
  const { t, locale, message } = useI18n();
  const [data, setData] = useState(null),
    [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState(""),
    [name, setName] = useState(""),
    [notes, setNotes] = useState("");
  const [backupId, setBackupId] = useState(""),
    [confirm, setConfirm] = useState(null);
  const selected =
    data?.campaigns.find((item) => item.id === selectedId) ||
    data?.campaigns[0];
  async function refresh() {
    try {
      setData(await api.getCampaigns());
      setError("");
    } catch (e) {
      setError(e.message);
    }
  }
  useEffect(() => {
    let alive = true;
    api
      .getCampaigns?.()
      .then((v) => {
        if (alive) setData(v);
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [
    api,
    state.settings.activeGameInstanceId,
    state.settings.activePlaysetId,
    state.settings.playsets,
    state.settings.gameOptions,
  ]);
  useEffect(() => {
    setName(selected?.name || "");
    setNotes(selected?.notes || "");
    setBackupId(selected?.backups.at(-1)?.id || "");
  }, [selected?.id, selected?.updatedAt]);
  async function action(kind, task) {
    return perform("campaign-" + kind, async () => {
      const result = await task();
      if (result !== null) await refresh();
      return result;
    });
  }
  return (
    <div className="campaign-stack">
      <section className="panel campaign-header">
        <div>
          <h2>
            <FileText size={19} />
            {t("战役档案")}
          </h2>
          <p className="section-description">
            {t("为本地存档记住完整配置、保留备份和战役备注。")}
          </p>
        </div>
        <button
          className="button primary"
          disabled={busy || state.launchStatus?.running}
          onClick={() =>
            action("bind", async () => {
              const result = await api.bindCampaign({});
              if (result) setSelectedId(result.id);
              return result;
            })
          }
        >
          <Plus size={16} />
          {t("绑定本地存档")}
        </button>
      </section>
      <p className="performance-hint">
        {t(
          "首次绑定以当前配置为记录基准，请先选好这份存档实际使用的播放集。绑定时会创建一份存档备份。",
        )}
      </p>
      {error && (
        <p role="alert" className="inline-note">
          {message(error)}
        </p>
      )}
      {data?.notices.map((value, i) => (
        <p key={i} className="inline-note">
          {message(value)}
        </p>
      ))}
      {data && !data.campaigns.length && (
        <section className="panel performance-empty">
          <Archive size={30} />
          <h2>{t("当前版本暂无战役档案")}</h2>
          <p>{t("选择 save games 目录中的存档，开始记录这场战役。")}</p>
        </section>
      )}
      {!!data?.campaigns.length && (
        <div className="campaign-columns">
          <section className="panel campaign-list" aria-label={t("战役列表")}>
            {data.campaigns.map((item) => (
              <button
                key={item.id}
                className={`campaign-item ${selected?.id === item.id ? "selected" : ""}`}
                onClick={() => setSelectedId(item.id)}
              >
                <strong>{item.name}</strong>
                <small>{item.filename}</small>
                <span>
                  {!item.available
                    ? t("存档文件缺失")
                    : item.changes.length
                      ? t("发现 {0} 项配置变化", { 0: item.changes.length })
                      : t("配置记录已保存")}
                </span>
              </button>
            ))}
          </section>
          {selected && (
            <section className="panel campaign-details">
              <div className="section-heading">
                <h2>{selected.name}</h2>
                <button
                  className="icon-button"
                  aria-label={t("刷新档案")}
                  disabled={busy}
                  onClick={refresh}
                >
                  <RefreshCw size={16} />
                </button>
              </div>
              <p className="path-box">{selected.filename}</p>
              <p className="performance-hint">
                {selected.environment.game.version || "—"} ·{" "}
                {selected.environment.playset.name} ·{" "}
                {t("{0} 个已启用模组", { 0: selected.environment.mods.length })}
              </p>
              <div className="campaign-actions">
                <button
                  className="button primary"
                  disabled={
                    busy || !selected.available || state.launchStatus?.running
                  }
                  onClick={() =>
                    action("review", async () => {
                      const result = await api.reviewCampaign(selected.id);
                      onReview(result);
                      return result;
                    })
                  }
                >
                  <Play size={15} />
                  {t("检查并继续战役")}
                </button>
                <button
                  className="button subtle"
                  disabled={busy || !selected.available}
                  onClick={() =>
                    action("folder", () => api.openCampaignFolder(selected.id))
                  }
                >
                  <FolderOpen size={15} />
                  {t("打开存档位置")}
                </button>
              </div>
              <h3>{t("配置变化")}</h3>
              <EnvironmentChanges changes={selected.changes} />
              <p className="performance-hint">
                {t("此处显示配置差异；检查并继续时还会校验实际模组内容。")}
              </p>
              <label className="campaign-field">
                <span>{t("战役名称")}</span>
                <input
                  aria-label={t("战役名称")}
                  maxLength={128}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <label className="campaign-field">
                <span>{t("战役备注")}</span>
                <textarea
                  aria-label={t("战役备注")}
                  maxLength={4000}
                  rows={4}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                />
              </label>
              <div className="campaign-actions">
                <button
                  className="button subtle"
                  disabled={busy || !name.trim()}
                  onClick={() =>
                    action("update", () =>
                      api.updateCampaign(selected.id, { name, notes }),
                    )
                  }
                >
                  <Save size={15} />
                  {t("保存档案")}
                </button>
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={() => setConfirm({ kind: "accept" })}
                >
                  {t("将当前配置记为新基准")}
                </button>
              </div>
              <h3>{t("存档备份")}</h3>
              <p className="performance-hint">
                {t("恢复前会额外备份当前存档；备份保存在本机，不操作云存档。")}
              </p>
              <div className="campaign-backups">
                <select
                  aria-label={t("选择存档备份")}
                  value={backupId}
                  onChange={(e) => setBackupId(e.target.value)}
                >
                  {selected.backups.map((b) => (
                    <option key={b.id} value={b.id}>
                      {new Date(b.createdAt).toLocaleString(locale)} ·{" "}
                      {(b.bytes / 1024 ** 2).toFixed(1)} MiB
                    </option>
                  ))}
                </select>
                <button
                  className="button subtle"
                  disabled={busy || !selected.available}
                  onClick={() =>
                    action("backup", () => api.backupCampaign(selected.id))
                  }
                >
                  {t("立即备份")}
                </button>
                <button
                  className="button subtle"
                  disabled={busy || !backupId}
                  onClick={() => setConfirm({ kind: "backup", backupId })}
                >
                  {t("恢复选中备份")}
                </button>
              </div>
            </section>
          )}
        </div>
      )}
      {confirm && selected && (
        <Dialog
          title={t(confirm.kind === "backup" ? "恢复存档备份" : "更新配置基准")}
          onClose={() => setConfirm(null)}
        >
          <p>
            {t(
              confirm.kind === "backup"
                ? "将恢复所选备份，并先保存当前存档。请确认游戏已退出。"
                : "将当前组合与实际 Mod 内容记为此存档的新基准，旧配置记录会保留。请确认它适用于这份存档。",
            )}
          </p>
          <div className="campaign-actions">
            <button
              className="button subtle"
              disabled={busy}
              onClick={() => setConfirm(null)}
            >
              {t("取消")}
            </button>
            <button
              className="button primary"
              disabled={busy}
              onClick={() =>
                action(confirm.kind, async () => {
                  const result =
                    confirm.kind === "backup"
                      ? await api.restoreCampaignBackup(
                          selected.id,
                          confirm.backupId,
                        )
                      : await api.acceptCampaignEnvironment(selected.id);
                  setConfirm(null);
                  return result;
                })
              }
            >
              {t("确认")}
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
