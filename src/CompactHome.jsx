import React, { useEffect, useRef, useState } from "react";
import {
  Activity,
  ArrowRight,
  FileText,
  Layers3,
  Play,
  RefreshCw,
} from "lucide-react";
import { useI18n } from "./i18n.jsx";
import { changeLabels } from "./Campaigns.jsx";
import "./compact-home.css";

const duration = (value) => {
  if (!Number.isFinite(value)) return "—";
  const seconds = Math.max(0, Math.floor(value / 1000));
  return [
    Math.floor(seconds / 3600),
    Math.floor(seconds / 60) % 60,
    seconds % 60,
  ]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
};

export default function CompactHome({
  api,
  state,
  active,
  busy,
  canLaunch,
  perform,
  persist,
  onReview,
  onLaunch,
  onNavigate,
  onChooseDirectory,
}) {
  const { t, message, locale } = useI18n();
  const [campaignData, setCampaignData] = useState(null);
  const [performanceData, setPerformanceData] = useState(null);
  const [selectedId, setSelectedId] = useState("");
  const [refreshId, setRefreshId] = useState(0);
  const [loading, setLoading] = useState(false);
  const generation = useRef(0);
  // Refresh metadata after configuration changes; file hashing belongs to review.
  const stamp = JSON.stringify([
    state.settings.activeGameInstanceId,
    state.settings.activePlaysetId,
    state.settings.playsets,
    state.settings.gameOptions,
    state.settings.launchMode,
    state.settings.disabledDlcIds,
    state.game.version,
    state.paths.userData,
    state.mods.map((mod) => [mod.id, mod.version, mod.available]),
    state.dlc?.items,
    Boolean(state.launchStatus?.running),
  ]);
  useEffect(() => {
    const current = ++generation.current;
    let alive = true;
    setLoading(true);
    const read = async (task, fallback, update) => {
      try {
        const data = await (task ? task() : fallback);
        if (alive && current === generation.current) update({ stamp, data });
      } catch (error) {
        if (alive && current === generation.current)
          update({ stamp, error: error.message || String(error) });
      }
    };
    Promise.allSettled([
      read(
        api.getCampaigns && (() => api.getCampaigns()),
        { campaigns: [], notices: [] },
        setCampaignData,
      ),
      read(
        api.getGamePerformance && (() => api.getGamePerformance()),
        { sessions: [] },
        setPerformanceData,
      ),
    ]).then(() => {
      if (alive && current === generation.current) setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [api, stamp, refreshId]);
  const campaignResult = campaignData?.stamp === stamp ? campaignData : null;
  const performanceResult =
    performanceData?.stamp === stamp ? performanceData : null;
  const campaigns = campaignResult?.data?.campaigns || [];
  const preferred =
    campaigns.find(
      (item) =>
        item.available &&
        !state.continueGame?.remote &&
        item.filename.replace(/\\/g, "/").toLowerCase() ===
          state.continueGame?.filename?.replace(/\\/g, "/").toLowerCase(),
    ) ||
    campaigns.find((item) => item.available) ||
    campaigns[0];
  const campaign =
    campaigns.find((item) => item.id === selectedId) || preferred;
  const changes = campaign?.changes || [];
  const sessions = (performanceResult?.data?.sessions || [])
    .filter((item) => item.instanceId === state.settings.activeGameInstanceId)
    .slice(0, 3);
  const save = state.continueGame;
  const continueAvailable = campaign
    ? campaign.available
    : !campaignResult?.data?.notices?.length && save?.available;
  async function review() {
    if (!campaign) return onLaunch({ resume: true });
    const result = await perform("campaign-review", () =>
      api.reviewCampaign(campaign.id),
    );
    if (result) onReview(result);
  }
  return (
    <div className="compact-home" aria-label={t("紧凑首页")}>
      <div className="compact-home-toolbar">
        <span>{t("战役准备")}</span>
        <button
          className="text-button"
          disabled={busy || loading}
          onClick={() => setRefreshId((n) => n + 1)}
        >
          <RefreshCw size={14} className={loading ? "spin" : ""} />
          {t("刷新概览")}
        </button>
      </div>
      <div className="compact-home-grid">
        <section className="panel compact-home-card" aria-label={t("继续战役")}>
          <h2>
            <FileText size={18} />
            {t("继续战役")}
          </h2>
          {campaignResult?.error ? (
            <p role="alert" className="inline-note">
              {message(campaignResult.error)}
            </p>
          ) : campaign ? (
            <>
              <select
                aria-label={t("选择战役档案")}
                value={campaign.id}
                disabled={busy}
                onChange={(event) => setSelectedId(event.target.value)}
              >
                {campaigns.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
              <p className="compact-home-filename" title={campaign.filename}>
                {campaign.filename}
              </p>
              {!campaign.available && (
                <p className="inline-note">{t("存档文件缺失或不可读取。")}</p>
              )}
            </>
          ) : (
            <p>
              {!campaignResult
                ? t("正在读取…")
                : save?.available
                  ? save.title || save.filename
                  : t("尚无可继续的存档")}
            </p>
          )}
          {campaignResult?.data?.notices?.map((notice, index) => (
            <p className="inline-note" key={index}>
              {message(notice)}
            </p>
          ))}
          <div className="compact-home-actions">
            <button
              className="button primary"
              disabled={
                !canLaunch ||
                !continueAvailable ||
                !campaignResult ||
                Boolean(campaignResult.error)
              }
              onClick={review}
            >
              <Play size={15} />
              {campaign ? t("检查并继续") : t("继续游戏")}
            </button>
            <button
              className="text-button"
              onClick={() => onNavigate("campaigns")}
            >
              {t("战役档案")}
              <ArrowRight size={14} />
            </button>
          </div>
        </section>
        <section className="panel compact-home-card" aria-label={t("当前组合")}>
          <h2>
            <Layers3 size={18} />
            {t("当前组合")}
          </h2>
          <select
            aria-label={t("当前播放集")}
            value={active.id}
            disabled={busy}
            onChange={(event) =>
              persist({ activePlaysetId: event.target.value })
            }
          >
            {state.settings.playsets.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
          <p>
            {t("已启用 {0} 个模组 · {1} 个 DLC", [
              active.modIds.length,
              (state.dlc?.items || []).filter((item) => item.enabled).length,
            ])}
          </p>
          <div className="compact-home-actions">
            <button className="text-button" onClick={() => onNavigate("mods")}>
              {t("模组管理")}
              <ArrowRight size={14} />
            </button>
            <button className="text-button" onClick={() => onNavigate("dlc")}>
              {t("DLC 管理")}
              <ArrowRight size={14} />
            </button>
          </div>
        </section>
        <section className="panel compact-home-card" aria-label={t("配置变化")}>
          <h2>
            <RefreshCw size={18} />
            {t("配置变化")}
          </h2>
          {campaign ? (
            <>
              <p className="compact-home-filename" title={campaign.name}>
                {t("对照档案：{0}", [campaign.name])}
              </p>
              {changes.length ? (
                <ul className="compact-home-changes">
                  {changes.slice(0, 3).map((item, index) => (
                    <li key={index}>
                      {t(changeLabels[item.kind] || "配置变化")}
                      {item.name && <span title={item.name}>{item.name}</span>}
                    </li>
                  ))}
                </ul>
              ) : (
                <p>{t("配置选项暂无变化。")}</p>
              )}
              {changes.length > 3 && (
                <p>{t("另有 {0} 项变化", [changes.length - 3])}</p>
              )}
              <p className="compact-home-hint">
                {t("尚未核对实际 Mod 文件；继续前会完整检查。")}
              </p>
            </>
          ) : (
            <p>
              {!campaignResult
                ? t("正在读取…")
                : campaignResult.error || campaignResult.data?.notices?.length
                  ? t("档案暂不可用，请刷新重试。")
                  : t("绑定战役档案后可查看配置变化。")}
            </p>
          )}
        </section>
        <section className="panel compact-home-card" aria-label={t("最近游玩")}>
          <h2>
            <Activity size={18} />
            {t("最近游玩")}
          </h2>
          {performanceResult?.error ? (
            <p role="alert" className="inline-note">
              {message(performanceResult.error)}
            </p>
          ) : sessions.length ? (
            <ul className="compact-home-sessions">
              {sessions.map((session) => (
                <li key={session.id}>
                  <span title={session.playsetName}>
                    {session.playsetName}
                    <small>
                      {new Date(session.startedAt).toLocaleString(locale)}
                    </small>
                  </span>
                  <strong>{duration(session.durationMs)}</strong>
                </li>
              ))}
            </ul>
          ) : (
            <p>
              {!performanceResult
                ? t("正在读取…")
                : t("当前实例暂无游玩记录。")}
            </p>
          )}
          <button
            className="text-button"
            onClick={() => onNavigate("performance")}
          >
            {t("查看游戏统计")}
            <ArrowRight size={14} />
          </button>
        </section>
      </div>
      <div className="compact-home-launch">
        <button
          className="button launch-button"
          disabled={!canLaunch}
          onClick={() => onLaunch()}
        >
          <Play size={17} />
          {state.launchStatus?.running ? t("游戏运行中") : t("启动游戏")}
        </button>
        {state.game.found ? (
          <select
            aria-label={t("启动模式")}
            value={state.settings.launchMode}
            disabled={busy}
            onChange={(event) => persist({ launchMode: event.target.value })}
          >
            <option value="normal">{t("标准模式")}</option>
            <option value="debug">{t("调试模式")}</option>
          </select>
        ) : (
          <button
            className="button subtle"
            disabled={busy}
            onClick={onChooseDirectory}
          >
            {t("选择游戏目录")}
          </button>
        )}
      </div>
    </div>
  );
}
