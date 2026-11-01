import { useI18n, T, LanguagePanel } from "./i18n.jsx";
import React, { useEffect, useRef, useState } from "react";
import {
  Activity,
  ArrowRight,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  Copy,
  Crosshair,
  FileText,
  Folder,
  FolderOpen,
  Grid2X2,
  HardDrive,
  Layers3,
  Package,
  LoaderCircle,
  Map,
  Maximize2,
  Minus,
  Pencil,
  Play,
  Plus,
  Radio,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  TriangleAlert,
  X,
} from "lucide-react";
import PlaysetWorkspace from "./PlaysetWorkspace.jsx";
import ModProjects from "./ModProjects.jsx";
import ModContextMenu from "./ModContextMenu.jsx";
import LauncherUpdates from "./LauncherUpdates.jsx";
import GameInstances from "./GameInstances.jsx";
import GamePerformance from "./GamePerformance.jsx";
import CompactHome from "./CompactHome.jsx";
import Campaigns, { CampaignReview, CampaignProgress } from "./Campaigns.jsx";
import PlaysetSnapshots, { SnapshotProgress } from "./PlaysetSnapshots.jsx";
import ModCoverage, { CoverageProgress } from "./ModCoverage.jsx";
import { createPreviewApi } from "./preview.js";
import {
  DlcPanel,
  GameOptionsPanel,
  ContinueCard,
  PlaysetTransfer,
} from "./ParityPanels.jsx";
import {
  NewsPanel,
  CommunityLinks,
  MaintenancePanel,
} from "./NewsMaintenancePanels.jsx";
import LocalModEditor from "./LocalModEditor.jsx";
import ModCatalog from "./ModCatalog.jsx";
import AccountPanel from "./AccountPanel.jsx";
import SteamWorkshop from "./SteamWorkshop.jsx";
import ModThumbnail from "./ModThumbnail.jsx";
import PublishDialog from "./PublishDialog.jsx";
import PdxStorage, { usePdxStorage } from "./PdxStorage.jsx";
import { version as launcherVersion } from "../package.json";
const isPreview = !window.launcher;
const api = window.launcher || createPreviewApi();
const nav = [
  {
    id: "home",
    title: "作战准备室",
    label: "总览",
    icon: Grid2X2,
  },
  {
    id: "mods",
    title: "模组库",
    label: "模组管理",
    icon: Layers3,
  },
  {
    id: "discover",
    title: "发现模组",
    label: "发现模组",
    icon: Search,
  },
  { id: "projects", title: "本地项目", label: "本地项目", icon: FolderOpen },
  { id: "campaigns", title: "战役档案", label: "战役档案", icon: FileText },
  {
    id: "dlc",
    title: "扩展内容",
    label: "DLC 管理",
    icon: Package,
  },
  {
    id: "performance",
    title: "游戏统计",
    label: "游戏统计",
    icon: Activity,
  },
  {
    id: "settings",
    title: "启动器设置",
    label: "设置",
    icon: Settings2,
  },
];
function MapArtwork() {
  const { t, message, locale } = useI18n();
  return (
    <svg className="map-art" viewBox="0 0 680 440" aria-hidden="true">
      <defs>
        <pattern id="grid" width="42" height="42" patternUnits="userSpaceOnUse">
          <path
            d="M42 0H0V42"
            fill="none"
            stroke="var(--muted)"
            strokeOpacity=".085"
          />
        </pattern>
        <radialGradient id="glow">
          <stop stopColor="var(--gold)" stopOpacity=".17" />
          <stop offset="1" stopColor="var(--bg)" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="land" x1="0" x2="1" y1="0" y2="1">
          <stop stopColor="var(--muted)" stopOpacity=".28" />
          <stop offset="1" stopColor="var(--line)" stopOpacity=".1" />
        </linearGradient>
      </defs>
      <rect width="680" height="440" fill="url(#grid)" />
      <ellipse cx="400" cy="230" rx="300" ry="230" fill="url(#glow)" />
      <g
        fill="url(#land)"
        stroke="var(--muted)"
        strokeWidth="1"
        strokeOpacity=".35"
        transform="rotate(-12 380 220)"
      >
        <path d="M290 49l20 11 1 27-21 16-6 24-29 7-12 27-26 8-13 34 15 23 18-1 4-28 24-8 14 21-9 27 17 21 34 7 22 25-5 37 27 34 17 6 12-25-22-28-1-19 30 8 26 28 24 5 5-18-23-25 8-17 33 2 21 22 25-2 12-18 25 8 18-14-10-25 20-13 28 12 32-5 20-31-9-28-32-8-11-20 16-32-8-28-30-15-31 12-18-18-28-1-16 20-24 1-13-24 16-17-9-19-24-5-14 21-6 39-17 11-9-16 5-29-17-12-17 5z" />
        <path d="M215 170l-18-19-6-26-15-8-13 15 9 23-7 25 13 22 22-6zM161 155l-18-9-9 21 5 19 17-7zM259 279l-36 4-27 14-11 30 17 19 19 1 24-27 22-9zM305 352l46 6 35-9 32 13 49-5 37 23 24 35-25 29H285l-31-31 14-33z" />
        <g fill="none" strokeDasharray="3 4" strokeOpacity=".3">
          <path d="M281 197l39 28 31-11 19-28 39 10 10 45 38 21M247 248l48-10 20 46m36-70 17 53 40 13M408 196l41-29 52 19 52-3" />
        </g>
      </g>
      <g fill="none" stroke="var(--gold)">
        <circle cx="391" cy="221" r="106" strokeOpacity=".15" />
        <circle
          cx="391"
          cy="221"
          r="77"
          strokeOpacity=".25"
          strokeDasharray="2 8"
        />
        <circle cx="391" cy="221" r="36" strokeOpacity=".3" />
        <path d="M268 221h28m190 0h28M391 98v28m0 190v28" strokeOpacity=".4" />
        <path
          d="M242 280l149-59 136-57"
          strokeDasharray="5 7"
          strokeOpacity=".6"
        />
      </g>
      <g fill="var(--gold)">
        <circle cx="391" cy="221" r="5" />
        <circle cx="242" cy="280" r="3" />
        <circle cx="527" cy="164" r="3" />
      </g>
      <g fontFamily="monospace" fontSize="9" fill="var(--muted)" opacity=".65">
        <text x="408" y="209">
          BERLIN
        </text>
        <text x="538" y="157">
          EASTERN FRONT
        </text>
        <text x="175" y="306">
          48°51′ N
        </text>
        <text x="510" y="375">
          EUROPEAN THEATRE
        </text>
        <text x="510" y="390">
          01 / STRATEGIC OVERVIEW
        </text>
      </g>
      <path
        d="M540 58h50v50m-330 260v32h40"
        stroke="var(--gold)"
        opacity=".25"
        fill="none"
      />
      <g transform="translate(589 63)" stroke="var(--muted)" opacity=".6">
        <path d="M0 0v33M-7 15L0 0l7 15" fill="none" />
        <text x="-3" y="-9" fill="var(--muted)" stroke="none" fontSize="9">
          N
        </text>
      </g>
    </svg>
  );
}
function Dialog({ title, children, onClose }) {
  const { t, message, locale } = useI18n();
  const ref = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement;
    (
      ref.current?.querySelector("input, textarea") ||
      ref.current?.querySelector("button")
    )?.focus();
    function handleKey(event) {
      if (event.key === "Escape") closeRef.current();
      if (event.key !== "Tab") return;
      const items = [
        ...ref.current.querySelectorAll(
          "button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)",
        ),
      ];
      if (!items.length) return;
      const first = items[0],
        last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      }
      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("keydown", handleKey);
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <section
        className="modal"
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="section-heading">
          <h2>{title}</h2>
          <button
            className="icon-button"
            aria-label={t("关闭对话框")}
            onClick={onClose}
          >
            <X size={19} />
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}
function ModEmblem({ mod, index = 0 }) {
  const { t, message, locale } = useI18n();
  const Icon = /music|radio|音乐/i.test(mod.name + mod.tags.join(" "))
    ? Radio
    : /tool|button|界面|工具/i.test(mod.name + mod.tags.join(" "))
      ? SlidersHorizontal
      : Map;
  return (
    <ModThumbnail
      api={api}
      mod={mod}
      className={`mod-emblem emblem-${index % 4}`}
      fallback={<Icon size={23} strokeWidth={1.3} aria-hidden="true" />}
    />
  );
}
export default function App() {
  const { t, message, locale, setLanguage } = useI18n();
  const [state, setState] = useState(null);
  useEffect(() => {
    if (state)
      setLanguage(state.settings.launcherPreferences?.language || "zh-hans");
  }, [state?.settings.launcherPreferences?.language, setLanguage]);
  const [page, setPage] = useState("home");
  const [busy, setBusy] = useState("loading");
  const lock = useRef(false);
  const [loadError, setLoadError] = useState("");
  const [toast, setToast] = useState(null);

  const [modal, setModal] = useState(null);
  const [name, setName] = useState("");
  const [copyMods, setCopyMods] = useState(false);
  const [launchPending, setLaunchPending] = useState(false);
  const [campaignReview, setCampaignReview] = useState(null);

  const [detailMod, setDetailMod] = useState(null);
  const [modContext, setModContext] = useState(null);
  const [projectCreation, setProjectCreation] = useState(null);
  const [authoring, setAuthoring] = useState(null);
  const [publishing, setPublishing] = useState(null);
  const [onlineSource, setOnlineSource] = useState("pdx");
  const { data: storageState, setData: setStorageState } = usePdxStorage(
    api,
    state?.paths.userData,
    Boolean(state?.game.found),
    setState,
  );
  useEffect(() => {
    if (
      !api.getLaunchStatus ||
      (!launchPending && !state?.launchStatus?.running)
    )
      return;
    let mounted = true;
    const timer = setInterval(
      () =>
        api
          .getLaunchStatus()
          .then((status) => {
            if (!mounted) return;
            setState((previous) =>
              previous
                ? {
                    ...previous,
                    launchStatus: status,
                  }
                : previous,
            );
            if (!status.running) setLaunchPending(false);
          })
          .catch(() => {}),
      2000,
    );
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, [launchPending, state?.launchStatus?.running]);
  useEffect(() => {
    let mounted = true;
    api
      .getState()
      .then((result) => {
        if (mounted) setState(result);
      })
      .catch((error) => {
        if (mounted) setLoadError(cleanError(error));
      })
      .finally(() => {
        if (mounted) setBusy("");
      });
    return () => {
      mounted = false;
    };
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timeout = setTimeout(
      () => setToast(null),
      toast.type === "error" ? 9000 : 5000,
    );
    return () => clearTimeout(timeout);
  }, [toast]);
  useEffect(() => {
    if (!launchPending) return;
    const timeout = setTimeout(() => setLaunchPending(false), 10000);
    return () => clearTimeout(timeout);
  }, [launchPending]);
  function cleanError(error) {
    return (error?.message || "操作失败，请重试。").replace(
      /^Error invoking remote method '[^']+': (Error: )?/,
      "",
    );
  }
  async function perform(action, task, success) {
    if (lock.current) return;
    lock.current = true;
    setBusy(action);
    try {
      const result = await task();
      if (success && result !== null)
        setToast({
          type: "success",
          text: success,
        });
      return result;
    } catch (error) {
      setToast({
        type: "error",
        text: cleanError(error),
        diagnostic: error?.diagnostic,
      });
      return null;
    } finally {
      setBusy("");
      lock.current = false;
    }
  }
  async function refresh(detect = false) {
    return perform(
      "refresh",
      async () => {
        const result = await (detect ? api.detectGame() : api.getState());
        setState(result);
        setLoadError("");
        return result;
      },
      "本地资料已刷新",
    );
  }
  async function chooseDirectory() {
    return perform(
      "choose",
      async () => {
        const result = await api.selectGameDirectory();
        if (result) setState(result);
        return result;
      },
      "游戏目录已更新",
    );
  }
  async function persist(patch, message) {
    return perform(
      "save",
      async () => {
        const settings = await api.saveSettings(patch);
        setState((previous) => ({
          ...previous,
          settings,
        }));
        // Diagnostics reflect the scanned playset; refresh them after a repair or switch.
        if (patch.activePlaysetId || state.warnings.length)
          setState(await api.getState());
        return settings;
      },
      message,
    );
  }
  const settings = state?.settings;
  const active =
    settings?.playsets.find((item) => item.id === settings.activePlaysetId) ||
    settings?.playsets[0];
  const selected = new Set(active?.modIds || []);
  const mods = state?.mods || [];
  const modOrder = active?.modOrder || active?.modIds || [];
  const members = modOrder.map(
    (id) =>
      mods.find((mod) => mod.id === id) || {
        ...(active?.modReferences || []).find((ref) => ref.id === id),
        id,
        name:
          (active?.modReferences || []).find((ref) => ref.id === id)?.name ||
          id,
        available: false,
        tags: [],
        supportedVersion: "",
        source: id.startsWith("workshop:")
          ? "workshop"
          : id.startsWith("pdx:")
            ? "pdx"
            : "local",
        compatibility: "unknown",
        dependencies: [],
        missingDependencies: [],
      },
  );
  const enabled = members.filter(
    (mod) => selected.has(mod.id) && mod.available,
  );
  const missing = [...selected].filter(
    (id) => !mods.some((mod) => mod.id === id && mod.available),
  );
  const isBusy = Boolean(busy);
  const canLaunch =
    state?.game.found &&
    !missing.length &&
    !isBusy &&
    !launchPending &&
    !storageState.busy &&
    !storageState.recoveryRequired &&
    !state?.launchStatus?.running &&
    !state?.launchBlockedReason;
  const pageTitle = nav.find((item) => item.id === page)?.title;
  function updateMods(modIds) {
    return persist({
      playsets: settings.playsets.map((item) =>
        item.id === active.id
          ? {
              ...item,
              modIds,
            }
          : item,
      ),
    });
  }
  function addMembers(ids) {
    const additions = ids.filter((id) => !modOrder.includes(id));
    if (!additions.length) return;
    return persist({
      playsets: settings.playsets.map((item) =>
        item.id === active.id
          ? {
              ...item,
              modOrder: [...modOrder, ...additions],
              modIds: [...item.modIds, ...additions],
            }
          : item,
      ),
    });
  }
  function toggleMod(id) {
    return updateMods(
      selected.has(id)
        ? active.modIds.filter((item) => item !== id)
        : [...active.modIds, id],
    );
  }
  function moveMember(id, targetIndex) {
    const order = modOrder.filter((item) => item !== id);
    order.splice(Math.max(0, Math.min(targetIndex, order.length)), 0, id);
    return persist({
      playsets: settings.playsets.map((item) =>
        item.id === active.id
          ? {
              ...item,
              modOrder: order,
              modIds: order.filter((key) => selected.has(key)),
            }
          : item,
      ),
    });
  }
  function removeMember(id) {
    return persist({
      playsets: settings.playsets.map((item) =>
        item.id === active.id
          ? {
              ...item,
              modOrder: modOrder.filter((key) => key !== id),
              modIds: item.modIds.filter((key) => key !== id),
              modReferences: (item.modReferences || []).filter(
                (ref) => ref.id !== id,
              ),
            }
          : item,
      ),
    });
  }
  function removeMissingMembers() {
    return persist({
      playsets: settings.playsets.map((item) =>
        item.id === active.id
          ? {
              ...item,
              modOrder: modOrder.filter((id) => !missing.includes(id)),
              modIds: item.modIds.filter((id) => !missing.includes(id)),
              modReferences: (item.modReferences || []).filter(
                (ref) => !missing.includes(ref.id),
              ),
            }
          : item,
      ),
    });
  }
  function openModal(type) {
    setName(type === "rename" || type === "copy" ? active.name : "");
    setCopyMods(type === "copy");
    setModal(type);
  }
  async function submitPlayset(event) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    let result;
    if (modal === "rename") {
      result = await persist(
        {
          playsets: settings.playsets.map((item) =>
            item.id === active.id
              ? {
                  ...item,
                  name: trimmed,
                }
              : item,
          ),
        },
        "播放集名称已更新",
      );
    } else {
      const id = `playset-${crypto.randomUUID()}`;
      result = await persist(
        {
          playsets: [
            ...settings.playsets,
            {
              id,
              name: trimmed,
              modIds: copyMods ? [...active.modIds] : [],
              modOrder: copyMods ? [...modOrder] : [],
              modReferences: copyMods ? [...(active.modReferences || [])] : [],
              disabledDlcIds: copyMods ? active.disabledDlcIds : null,
              unmappedDlcIds: copyMods
                ? [...(active.unmappedDlcIds || [])]
                : [],
            },
          ],
          activePlaysetId: id,
        },
        "新播放集已创建",
      );
    }
    if (result) setModal(null);
  }
  async function deletePlayset() {
    const playsets = settings.playsets.filter((item) => item.id !== active.id);
    if (!playsets.length) return;
    const result = await persist(
      {
        playsets,
        activePlaysetId: playsets[0].id,
      },
      "播放集已删除",
    );
    if (result) setModal(null);
  }
  async function launch(request = {}) {
    if (request.resume && api.reviewContinueCampaign) {
      const checked = await perform("campaign-review", async () => ({
        review: await api.reviewContinueCampaign(),
      }));
      if (!checked) return;
      if (checked.review) {
        setCampaignReview(checked.review);
        return;
      }
    }
    await perform(
      "launch",
      async () => {
        const result = await api.launchGame(request);
        setCampaignReview(null);
        setLaunchPending(true);
        setState(await api.getState());
        return result;
      },
      "启动请求已发送，游戏窗口即将打开。",
    );
  }
  function renderMod(mod, index) {
    return (
      <div
        className={`mod-row ${selected.has(mod.id) ? "is-enabled" : ""}`}
        key={mod.id}
      >
        <ModEmblem mod={mod} index={index} />
        <div className="mod-info">
          <h3 title={mod.name}>
            <button
              className="mod-name-button"
              onClick={() => setDetailMod(mod)}
            >
              {mod.name}
            </button>
          </h3>
          <div className="mod-meta">
            <span>
              {mod.source === "workshop"
                ? t("Steam 创意工坊")
                : mod.source === "pdx"
                  ? "Paradox Mods"
                  : t("本地模组")}
            </span>
            <span className="meta-dot">·</span>
            <span>{mod.supportedVersion || t("未声明版本")}</span>
            {mod.compatibility === "different" && (
              <span className="compatibility-warning">
                <T id={"版本不匹配"} />
              </span>
            )}
          </div>
        </div>
        {!mod.available && (
          <span className="unavailable">
            <T id={"文件缺失"} />
          </span>
        )}
        <span className="enabled-label">
          <span className="status-dot" />
          <T id={"已启用"} />
        </span>
      </div>
    );
  }
  const sourceNavigation = (
    <div className="member-tabs discover-source-tabs">
      <button
        className={onlineSource === "pdx" ? "selected" : ""}
        onClick={() => setOnlineSource("pdx")}
      >
        Paradox Mods
      </button>
      <button
        className={onlineSource === "steam" ? "selected" : ""}
        onClick={() => setOnlineSource("steam")}
      >
        <T id={"Steam 创意工坊"} />
      </button>
    </div>
  );
  return (
    <div
      className={`app-shell${page === "discover" && onlineSource === "steam" ? " workshop-shell" : ""}`}
    >
      <div className="titlebar">
        <span className="titlebar-mark">IC</span>
        <span>IRONCLAD</span>
        <span className="title-divider">/</span>
        <span className="titlebar-subtitle">HEARTS OF IRON IV LAUNCHER</span>
        <div className="window-controls">
          {isPreview ? (
            <span className="preview-badge">
              <T id={"界面预览 · 示例数据"} />
            </span>
          ) : (
            <>
              <button aria-label={t("最小化")} onClick={() => api.minimize()}>
                <Minus size={15} />
              </button>
              <button
                aria-label={t("最大化或还原")}
                onClick={() => api.maximize()}
              >
                <Maximize2 size={12} />
              </button>
              <button
                className="window-close"
                aria-label={t("关闭启动器")}
                onClick={() => api.close()}
              >
                <X size={16} />
              </button>
            </>
          )}
        </div>
      </div>
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-symbol">
            <span />
            <span />
            <span />
          </div>
          <div>
            <strong>IRONCLAD</strong>
            <p>
              <T id={"为下一场战役而生"} />
            </p>
          </div>
        </div>
        <div className="nav-caption">
          <span className="nav-caption-label">
            <T id={"指挥中心 "} />
          </span>
          <span className="nav-caption-context">COMMAND</span>
        </div>
        <nav aria-label={t("主导航")}>
          {nav.map((item) => (
            <button
              key={item.id}
              className={`nav-item ${page === item.id ? "active" : ""}`}
              aria-current={page === item.id ? "page" : undefined}
              onClick={() => setPage(item.id)}
            >
              <item.icon size={19} strokeWidth={1.6} />
              <span>{t(item.label)}</span>
              {item.id === "mods" && (
                <span className="nav-count">
                  {mods.length.toString().padStart(2, "0")}
                </span>
              )}
              {page === item.id && item.id !== "mods" && (
                <span className="nav-active-dot" />
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-note">
          <div className="sidebar-note-content">
            <Crosshair size={23} strokeWidth={1.2} />
            <p>
              <T id={"好的战略"} />
              <br />
              <T id={"从准备开始。"} />
            </p>
            <span>PLAN. PREPARE. PREVAIL.</span>
          </div>
        </div>
        <div className="sidebar-bottom">
          <div>
            <span className="status-dot" />
            <T id={"本地运行 "} />
            <span className="version-label">v{launcherVersion}</span>
          </div>
          <p>
            <T id={"独立第三方启动器"} />
          </p>
        </div>
      </aside>
      <main className="main-content">
        <header className="page-header">
          <div>
            <div className="eyebrow">YOUR NEXT CAMPAIGN</div>
            <h1>
              {t(pageTitle)}
              <span className="heading-dot">.</span>
            </h1>
            <p>
              {page === "home"
                ? t("整备你的模组，开启属于你的历史。")
                : page === "mods"
                  ? t("让每一场战役，都有新的可能。")
                  : t("准备就绪，然后专注于你的战役。")}
            </p>
          </div>
          <button
            className="button quiet refresh-button"
            disabled={isBusy}
            onClick={() => refresh()}
          >
            <RefreshCw size={15} className={busy === "refresh" ? "spin" : ""} />
            <T id={"刷新资料"} />
          </button>
        </header>

        {!state ? (
          <div className="loading-panel">
            {message(loadError) ? (
              <>
                <TriangleAlert size={30} />
                <h2>
                  <T id={"暂时无法读取配置"} />
                </h2>
                <p>{message(loadError)}</p>
                <button
                  className="button primary"
                  disabled={isBusy}
                  onClick={() => refresh()}
                >
                  <T id={"重新读取"} />
                </button>
              </>
            ) : (
              <>
                <LoaderCircle className="spin" size={28} />
                <p>
                  <T id={"正在读取本地游戏与模组…"} />
                </p>
              </>
            )}
          </div>
        ) : (
          <>
            {(missing.length > 0 || state.warnings.length > 0) && (
              <div className="warning-banner">
                <TriangleAlert size={17} />
                <span>
                  {missing.length
                    ? t("当前播放集有 {0} 个模组文件缺失，请清理后再启动。", {
                        0: missing.length,
                      })
                    : message(state.warnings[0])}
                </span>
                {missing.length > 0 ? (
                  <button disabled={isBusy} onClick={removeMissingMembers}>
                    <T id={"移除缺失项"} />
                  </button>
                ) : (
                  <button onClick={() => setPage("settings")}>
                    <T id={"查看详情"} />
                  </button>
                )}
              </div>
            )}

            {page === "home" && (
              <>
                <GameInstances
                  compact
                  state={state}
                  api={api}
                  perform={perform}
                  onState={setState}
                  busy={
                    isBusy ||
                    launchPending ||
                    storageState.busy ||
                    storageState.recoveryRequired
                  }
                  Dialog={Dialog}
                />
                <div className="home-layout-toolbar">
                  <button
                    className="text-button"
                    disabled={isBusy}
                    onClick={() =>
                      persist({
                        launcherPreferences: {
                          ...settings.launcherPreferences,
                          homeLayout:
                            settings.launcherPreferences?.homeLayout ===
                            "compact"
                              ? "full"
                              : "compact",
                        },
                      })
                    }
                  >
                    <Grid2X2 size={14} />
                    {settings.launcherPreferences?.homeLayout === "compact"
                      ? t("切换到完整首页")
                      : t("切换到紧凑首页")}
                  </button>
                </div>
                {settings.launcherPreferences?.homeLayout === "compact" ? (
                  <CompactHome
                    api={api}
                    state={state}
                    active={active}
                    busy={
                      isBusy ||
                      launchPending ||
                      storageState.busy ||
                      storageState.recoveryRequired
                    }
                    canLaunch={canLaunch}
                    perform={perform}
                    persist={persist}
                    onReview={setCampaignReview}
                    onLaunch={launch}
                    onNavigate={setPage}
                    onChooseDirectory={chooseDirectory}
                  />
                ) : (
                  <>
                    <section className="hero">
                      <MapArtwork />
                      <div className="hero-content">
                        <div className="hero-overline">
                          <span className="hero-dash" />
                          HEARTS OF IRON IV
                          <span className="edition">
                            <T id={"钢铁雄心 IV"} />
                          </span>
                        </div>
                        <div className="hero-kicker">
                          THE WORLD IS YOURS TO RESHAPE
                        </div>
                        <h2>
                          <T id={"历史的下一页，"} />
                          <br />
                          <span>
                            <T id={"由你执笔。"} />
                          </span>
                        </h2>
                        <p className="hero-description">
                          <T id={"从一张地图开始，改变世界的走向。"} />
                          <br />
                          {state.game.found
                            ? t("你的战役，已准备就绪。")
                            : t("选好游戏目录，就可以开始你的战役。")}
                        </p>
                        <div className="hero-actions">
                          <button
                            className="button launch-button"
                            disabled={!canLaunch}
                            onClick={() => launch()}
                          >
                            {busy === "launch" || launchPending ? (
                              <LoaderCircle size={19} className="spin" />
                            ) : (
                              <Play size={18} fill="currentColor" />
                            )}
                            {state.launchStatus?.running
                              ? t("游戏运行中")
                              : launchPending
                                ? t("游戏启动中")
                                : t("启动游戏")}
                            <ArrowRight size={19} />
                          </button>
                          {!state.game.found ? (
                            <button
                              className="button hero-secondary"
                              disabled={isBusy}
                              onClick={chooseDirectory}
                            >
                              <FolderOpen size={16} />
                              <T id={"选择游戏目录"} />
                            </button>
                          ) : (
                            <label className="launch-mode">
                              <select
                                aria-label={t("启动模式")}
                                value={settings.launchMode}
                                disabled={isBusy}
                                onChange={(event) =>
                                  persist({
                                    launchMode: event.target.value,
                                  })
                                }
                              >
                                <option value="normal">
                                  <T id={"标准模式"} />
                                </option>
                                <option value="debug">
                                  <T id={"调试模式"} />
                                </option>
                              </select>
                              <ChevronDown size={14} />
                            </label>
                          )}
                        </div>
                      </div>
                      <div className="hero-bottom">
                        <span>
                          <span
                            className={`status-dot ${state.game.found ? "" : "amber"}`}
                          />
                          {state.game.found
                            ? t("游戏已就绪")
                            : t("等待配置游戏目录")}
                        </span>
                        <span className="hero-bottom-divider" />
                        <span>
                          {state.game.version
                            ? `v${state.game.version}`
                            : t("本地安装")}
                        </span>
                        <span className="hero-bottom-right">
                          1936 <span>—</span> ∞
                        </span>
                      </div>
                    </section>
                    <ContinueCard
                      state={state}
                      canLaunch={canLaunch}
                      onLaunch={launch}
                    />
                    <div className="stats-grid">
                      <div className="stat-card">
                        <div className="stat-icon">
                          <Layers3 size={21} />
                        </div>
                        <div>
                          <span className="stat-label">
                            <T id={"已安装模组"} />
                          </span>
                          <strong>
                            {mods.length.toString().padStart(2, "0")}
                            <small>
                              <T id={"个"} />
                            </small>
                          </strong>
                        </div>
                        <span className="stat-caption">
                          <T id={"你的战役扩展"} />
                        </span>
                      </div>
                      <div className="stat-card">
                        <div className="stat-icon green">
                          <CheckCheck size={22} />
                        </div>
                        <div>
                          <span className="stat-label">
                            <T id={"当前已启用"} />
                          </span>
                          <strong>
                            {enabled.length.toString().padStart(2, "0")}
                            <small>
                              <T id={"个"} />
                            </small>
                          </strong>
                        </div>
                        <span className="stat-caption">
                          <T id={"随游戏一同加载"} />
                        </span>
                      </div>
                      <div className="stat-card playset-stat">
                        <div className="stat-icon">
                          <Folder size={21} />
                        </div>
                        <div>
                          <span className="stat-label">
                            <T id={"当前模组播放集"} />
                          </span>
                          <strong title={active.name}>{active.name}</strong>
                        </div>
                        <ChevronDown size={15} />
                        <select
                          aria-label={t("当前模组播放集")}
                          value={active.id}
                          disabled={isBusy}
                          onChange={(event) =>
                            persist(
                              {
                                activePlaysetId: event.target.value,
                              },
                              "已切换模组播放集",
                            )
                          }
                        >
                          {settings.playsets.map((item) => (
                            <option key={item.id} value={item.id}>
                              {item.name}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                    <div className="dashboard-bottom">
                      <section className="panel current-mods">
                        <div className="section-heading">
                          <h2>
                            <span className="small-marker" />
                            <T id={"随行模组 "} />
                            <span className="count-pill">{enabled.length}</span>
                          </h2>
                          <button
                            className="text-button"
                            onClick={() => setPage("mods")}
                          >
                            <T id={"管理模组"} />
                            <ArrowRight size={15} />
                          </button>
                        </div>
                        {enabled.length ? (
                          <div className="mod-list">
                            {enabled
                              .slice(0, 3)
                              .map((mod, index) => renderMod(mod, index))}
                            {enabled.length > 3 && (
                              <button
                                className="list-more"
                                onClick={() => setPage("mods")}
                              >
                                <T
                                  id={"查看其余 {0} 个模组"}
                                  values={[enabled.length - 3]}
                                />
                                <ChevronRight size={14} />
                              </button>
                            )}
                          </div>
                        ) : (
                          <div className="empty-state compact">
                            <Layers3 size={28} />
                            <h3>
                              <T id={"轻装出发，或带上更多可能"} />
                            </h3>
                            <p>
                              <T
                                id={
                                  "当前为原版战役，前往模组库搭配你的播放集。"
                                }
                              />
                            </p>
                            <button
                              className="text-button"
                              onClick={() => setPage("mods")}
                            >
                              <T id={"浏览模组库"} />
                              <ArrowRight size={15} />
                            </button>
                          </div>
                        )}
                      </section>
                      <section className="panel playsets-panel">
                        <div className="section-heading">
                          <h2>
                            <span className="small-marker" />
                            <T id={"战役播放集"} />
                          </h2>
                          <span className="muted-count">
                            {settings.playsets.length
                              .toString()
                              .padStart(2, "0")}
                          </span>
                        </div>
                        <p className="section-description">
                          <T id={"不同的战役，一键切换。"} />
                        </p>
                        <div className="playset-list">
                          {settings.playsets.slice(0, 3).map((item) => (
                            <button
                              disabled={isBusy}
                              className={`playset-item ${item.id === active.id ? "selected" : ""}`}
                              key={item.id}
                              onClick={() =>
                                persist({
                                  activePlaysetId: item.id,
                                })
                              }
                            >
                              <Folder size={17} />
                              <span>
                                {item.name}
                                <small>
                                  <T
                                    id={"{0} 个模组"}
                                    values={[item.modIds.length]}
                                  />
                                </small>
                              </span>
                              {item.id === active.id ? (
                                <Check size={16} />
                              ) : (
                                <ChevronRight size={15} />
                              )}
                            </button>
                          ))}
                        </div>
                        <button
                          className="create-playset"
                          disabled={isBusy}
                          onClick={() => openModal("create")}
                        >
                          <Plus size={16} />
                          <T id={"新建播放集"} />
                        </button>
                      </section>
                    </div>
                    <NewsPanel api={api} perform={perform} busy={isBusy} />
                    <CommunityLinks api={api} perform={perform} busy={isBusy} />
                  </>
                )}
              </>
            )}

            {page === "mods" && (
              <PlaysetWorkspace
                settings={settings}
                active={active}
                mods={mods}
                members={members}
                busy={isBusy}
                persist={persist}
                addMembers={addMembers}
                updateMods={updateMods}
                toggleMod={toggleMod}
                moveMember={moveMember}
                removeMember={removeMember}
                onCreate={() => openModal("create")}
                onCopy={() => openModal("copy")}
                onRename={() => openModal("rename")}
                onDelete={() => setModal("delete")}
                onDetail={setDetailMod}
                onContextMenu={(event, mod) => {
                  event.preventDefault();
                  const rect = event.currentTarget.getBoundingClientRect();
                  setModContext({
                    mod,
                    x: Number.isFinite(event.clientX)
                      ? event.clientX
                      : rect.left + 30,
                    y: Number.isFinite(event.clientY)
                      ? event.clientY
                      : rect.top + 20,
                  });
                }}
                Emblem={ModEmblem}
              >
                <PlaysetTransfer
                  onCreateMod={() => setAuthoring({ kind: "create" })}
                  api={api}
                  state={state}
                  active={active}
                  onState={setState}
                  perform={perform}
                  busy={isBusy}
                  Dialog={Dialog}
                >
                  <PlaysetSnapshots
                    api={api}
                    state={state}
                    active={active}
                    busy={isBusy || launchPending}
                    perform={perform}
                    onState={setState}
                    Dialog={Dialog}
                  />
                  <ModCoverage
                    api={api}
                    state={state}
                    active={active}
                    busy={isBusy || launchPending}
                    perform={perform}
                    Dialog={Dialog}
                  />
                </PlaysetTransfer>
              </PlaysetWorkspace>
            )}

            {page === "projects" && (
              <ModProjects
                api={api}
                state={state}
                onState={setState}
                perform={perform}
                busy={isBusy}
                Dialog={Dialog}
                creationRequest={projectCreation}
                onCreationRequestHandled={() => setProjectCreation(null)}
              />
            )}
            {page === "campaigns" && (
              <Campaigns
                api={api}
                state={state}
                perform={perform}
                busy={isBusy || launchPending}
                Dialog={Dialog}
                onState={setState}
                onReview={setCampaignReview}
              />
            )}
            {page === "dlc" && (
              <DlcPanel
                state={state}
                active={active}
                persist={persist}
                busy={isBusy}
              />
            )}
            {page === "discover" && (
              <div>
                {onlineSource !== "steam" && sourceNavigation}
                {onlineSource === "pdx" ? (
                  <ModCatalog
                    api={api}
                    state={state}
                    perform={perform}
                    busy={isBusy}
                    onState={setState}
                    Dialog={Dialog}
                  />
                ) : (
                  <SteamWorkshop
                    sourceNavigation={sourceNavigation}
                    api={api}
                    state={state}
                    perform={perform}
                    busy={isBusy}
                    Dialog={Dialog}
                    onState={setState}
                  />
                )}
              </div>
            )}
            {page === "performance" && (
              <GamePerformance
                api={api}
                perform={perform}
                busy={isBusy}
                preview={isPreview}
              />
            )}
            {page === "settings" && (
              <div className="settings-stack">
                <LauncherUpdates
                  api={api}
                  busy={
                    isBusy ||
                    launchPending ||
                    storageState.busy ||
                    storageState.recoveryRequired
                  }
                  running={state.launchStatus?.running}
                  Dialog={Dialog}
                />
                <GameInstances
                  state={state}
                  api={api}
                  perform={perform}
                  onState={setState}
                  busy={
                    isBusy ||
                    launchPending ||
                    storageState.busy ||
                    storageState.recoveryRequired
                  }
                  Dialog={Dialog}
                />
                <LanguagePanel
                  settings={settings}
                  persist={persist}
                  busy={isBusy}
                />
                <AccountPanel
                  api={api}
                  perform={perform}
                  busy={isBusy}
                  Dialog={Dialog}
                />
                <GameOptionsPanel
                  state={state}
                  api={api}
                  persist={persist}
                  busy={isBusy}
                />
                <section className="panel settings-panel">
                  <div className="section-heading">
                    <h2>
                      <HardDrive size={19} />
                      <T id={"游戏安装"} />
                    </h2>
                    <span
                      className={`status-chip ${state.game.found ? "" : "warning"}`}
                    >
                      <span className="status-dot" />
                      {state.game.found ? t("已找到游戏") : t("未找到游戏")}
                    </span>
                  </div>
                  <p className="section-description">
                    <T id={"选择包含 hoi4.exe 的钢铁雄心 IV 安装目录。"} />
                  </p>
                  <div className="path-box">
                    <FolderOpen size={18} />
                    <span>
                      {settings.gameDirectory || t("尚未配置游戏目录")}
                    </span>
                  </div>
                  <div className="settings-actions">
                    <button
                      className="button primary"
                      disabled={
                        isBusy ||
                        storageState.busy ||
                        storageState.recoveryRequired
                      }
                      onClick={chooseDirectory}
                    >
                      <FolderOpen size={16} />
                      <T id={"选择目录"} />
                    </button>
                    <button
                      className="button subtle"
                      disabled={
                        isBusy ||
                        storageState.busy ||
                        storageState.recoveryRequired
                      }
                      onClick={() => refresh(true)}
                    >
                      <Search size={16} />
                      <T id={"自动检测"} />
                    </button>
                  </div>
                </section>
                <PdxStorage
                  api={api}
                  state={state}
                  data={storageState}
                  setData={setStorageState}
                  perform={perform}
                  busy={isBusy}
                  Dialog={Dialog}
                />
                <section className="panel settings-panel">
                  <div className="section-heading">
                    <h2>
                      <SlidersHorizontal size={19} />
                      <T id={"启动偏好"} />
                    </h2>
                  </div>
                  <div className="setting-row">
                    <div>
                      <h3>
                        <T id={"启动模式"} />
                      </h3>
                      <p>
                        <T id={"使用此游戏版本在官方配置中定义的启动参数。"} />
                      </p>
                    </div>
                    <select
                      aria-label={t("默认启动模式")}
                      value={settings.launchMode}
                      disabled={isBusy}
                      onChange={(event) =>
                        persist(
                          {
                            launchMode: event.target.value,
                          },
                          "启动模式已保存",
                        )
                      }
                    >
                      <option value="normal">
                        <T id={"标准模式"} />
                      </option>
                      <option value="debug">
                        <T id={"调试模式"} />
                      </option>
                    </select>
                  </div>
                  <div className="setting-row">
                    <div>
                      <h3>
                        <T id={"启动游戏后关闭启动器"} />
                      </h3>
                      <p>
                        <T id={"游戏进程创建成功后，自动关闭此窗口。"} />
                      </p>
                    </div>
                    <button
                      role="switch"
                      aria-label={t("启动游戏后关闭启动器")}
                      aria-checked={Boolean(
                        settings.launcherPreferences?.closeOnLaunch,
                      )}
                      className="toggle"
                      disabled={isBusy}
                      onClick={() =>
                        persist({
                          launcherPreferences: {
                            ...settings.launcherPreferences,
                            closeOnLaunch:
                              !settings.launcherPreferences?.closeOnLaunch,
                          },
                        })
                      }
                    >
                      <span />
                    </button>
                  </div>
                  <div className="setting-row">
                    <div>
                      <h3>
                        <T id={"模组配置备份"} />
                      </h3>
                      <p>
                        <T
                          id={
                            "应用模组、DLC 和游戏设置前自动备份，启动失败时恢复。"
                          }
                        />
                      </p>
                    </div>
                    <span className="safe-label">
                      <ShieldCheck size={16} />
                      <T id={"始终开启"} />
                    </span>
                  </div>
                </section>
                <section className="panel settings-panel">
                  <div className="section-heading">
                    <h2>
                      <FileText size={19} />
                      <T id={"本地资料"} />
                    </h2>
                  </div>
                  <div className="path-detail">
                    <span>
                      <T id={"游戏用户目录 / 本地模组"} />
                    </span>
                    <code>{state.paths.userData}</code>
                  </div>
                  <div className="path-detail">
                    <span>
                      <T id={"启动器设置 / 战役播放集"} />
                    </span>
                    <code>{state.paths.settings}</code>
                  </div>
                  {state.warnings.length > 0 && (
                    <div className="diagnostics">
                      <h3>
                        <TriangleAlert size={16} />
                        <T id={"扫描提示"} />
                      </h3>
                      <ul>
                        {state.warnings.map((warning, i) => (
                          <li key={i}>{message(warning)}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </section>
                <MaintenancePanel
                  state={state}
                  api={api}
                  perform={perform}
                  onState={setState}
                  busy={
                    isBusy || storageState.busy || storageState.recoveryRequired
                  }
                  Dialog={Dialog}
                />
                <div className="about-card">
                  <div className="about-monogram">IC</div>
                  <div>
                    <strong>
                      IRONCLAD <span>{launcherVersion} / Roadmap 1</span>
                    </strong>
                    <p>
                      <T id={"一个轻量、专注的钢铁雄心 IV 第三方启动器。"} />
                    </p>
                    <small>
                      <T
                        id={
                          "与 Paradox Interactive 无关联。游戏及模组版权归各自所有者所有。"
                        }
                      />
                    </small>
                  </div>
                </div>
              </div>
            )}
            <footer className="page-footer">
              <span>
                <ShieldCheck size={13} />
                <T id={"本地配置 · 无需账号"} />
              </span>
              <span>
                PREPARE FOR WHAT COMES NEXT{" "}
                <span className="footer-cross">+</span>
              </span>
            </footer>
          </>
        )}
      </main>
      {toast && (
        <div
          className={`toast ${toast.type}`}
          role={toast.type === "error" ? "alert" : "status"}
        >
          {toast.type === "error" ? (
            <TriangleAlert size={18} />
          ) : (
            <Check size={18} />
          )}
          <span>{message(toast.diagnostic ?? toast.text, toast.text)}</span>
          <button aria-label={t("关闭提示")} onClick={() => setToast(null)}>
            <X size={16} />
          </button>
        </div>
      )}
      {modal && (
        <Dialog
          title={
            modal === "delete"
              ? t("删除战役播放集")
              : modal === "rename"
                ? t("重命名播放集")
                : t("创建战役播放集")
          }
          onClose={() => !isBusy && setModal(null)}
        >
          {modal === "delete" ? (
            <>
              <p className="modal-description">
                <T
                  id={
                    "确定删除「{0}」吗？这只会删除此播放集，已安装的模组会保留。"
                  }
                  values={[active.name]}
                />
              </p>
              <div className="modal-actions">
                <button
                  className="button subtle"
                  disabled={isBusy}
                  onClick={() => setModal(null)}
                >
                  <T id={"取消"} />
                </button>
                <button
                  className="button danger"
                  disabled={isBusy}
                  onClick={deletePlayset}
                >
                  <T id={"删除播放集"} />
                </button>
              </div>
            </>
          ) : (
            <form onSubmit={submitPlayset}>
              <p className="modal-description">
                <T id={"给这套模组搭配起个名字，随时切换你的下一场战役。"} />
              </p>
              <label className="field-label" htmlFor="playset-name">
                <T id={"播放集名称"} />
              </label>
              <input
                id="playset-name"
                className="name-input"
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={128}
                placeholder={t("例如：我的 1936")}
                autoComplete="off"
                required
                disabled={isBusy}
              />
              {(modal === "create" || modal === "copy") && (
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={copyMods}
                    onChange={(event) => setCopyMods(event.target.checked)}
                    disabled={isBusy}
                  />
                  <Copy size={15} />
                  <T
                    id={"复制当前播放集的 {0} 个模组"}
                    values={[modOrder.length]}
                  />
                </label>
              )}
              <div className="modal-actions">
                <button
                  type="button"
                  className="button subtle"
                  disabled={isBusy}
                  onClick={() => setModal(null)}
                >
                  <T id={"取消"} />
                </button>
                <button
                  type="submit"
                  className="button primary"
                  disabled={isBusy || !name.trim()}
                >
                  {modal === "rename" ? t("保存名称") : t("创建播放集")}
                  <ArrowRight size={16} />
                </button>
              </div>
            </form>
          )}
        </Dialog>
      )}
      {modContext && (
        <ModContextMenu
          key={modContext.mod.id}
          request={modContext}
          state={state}
          api={api}
          perform={perform}
          onState={setState}
          onClose={() => setModContext(null)}
          busy={isBusy || launchPending}
          Dialog={Dialog}
          onRemoveMember={removeMember}
          onCreateProject={(mod) => {
            setProjectCreation({ modId: mod.id, name: mod.name });
            setPage("projects");
          }}
        />
      )}
      {detailMod && (
        <Dialog title={detailMod.name} onClose={() => setDetailMod(null)}>
          <div className="mod-detail">
            <ModThumbnail
              api={api}
              mod={detailMod}
              className="mod-detail-artwork"
              eager
              hideWhenEmpty
            />
            <p>
              {detailMod.source === "workshop"
                ? t("Steam 创意工坊")
                : detailMod.source === "pdx"
                  ? "Paradox Mods"
                  : t("本地模组")}{" "}
              · {detailMod.available ? t("文件可用") : t("未安装或文件缺失")}
            </p>
            <dl>
              <dt>
                <T id={"模组版本"} />
              </dt>
              <dd>
                {detailMod.version || t("作者未声明")}
                {detailMod.installedRevision
                  ? t(" · 固定版本 {0}", {
                      0: detailMod.installedRevision,
                    })
                  : ""}
              </dd>
              <dt>
                <T id={"适用游戏版本"} />
              </dt>
              <dd>{detailMod.supportedVersion || t("作者未声明")}</dd>
              <dt>
                <T id={"当前游戏版本"} />
              </dt>
              <dd>{state.game.version || t("未识别")}</dd>
              <dt>
                <T id={"加载顺序参考"} />
              </dt>
              <dd>
                {detailMod.dependencies?.join("、") || t("未声明加载顺序")}
              </dd>
              {detailMod.contentPath && (
                <>
                  <dt>
                    <T id={"本地路径"} />
                  </dt>
                  <dd>
                    <code>{detailMod.contentPath}</code>
                  </dd>
                </>
              )}
            </dl>
            {!!detailMod.dependencies?.length && (
              <p className="modal-description">
                <T
                  id={
                    "此列表可能包含排序或兼容关系，不代表全部都必须启用。必需前置请核对作者说明。"
                  }
                />
              </p>
            )}
            <div className="modal-actions">
              {detailMod.canEdit && api.getLocalModMetadata && (
                <button
                  className="button subtle"
                  disabled={isBusy}
                  onClick={() =>
                    perform("mod-metadata", async () => {
                      const metadata = await api.getLocalModMetadata(
                        detailMod.id,
                      );
                      setAuthoring({
                        kind: "edit",
                        id: detailMod.id,
                        metadata,
                      });
                      setDetailMod(null);
                    })
                  }
                >
                  <Pencil size={15} />
                  <T id={"编辑资料"} />
                </button>
              )}
              {detailMod.canEdit && api.getPublishDraft && (
                <button
                  className="button primary"
                  disabled={isBusy}
                  onClick={() =>
                    perform("publish-draft", async () => {
                      const draft = await api.getPublishDraft(detailMod.id);
                      setPublishing({
                        id: detailMod.id,
                        draft,
                      });
                      setDetailMod(null);
                    })
                  }
                >
                  <T id={"发布到工坊"} />
                  <ArrowRight size={15} />
                </button>
              )}
              {detailMod.canEdit && api.getPdxPublishDraft && (
                <button
                  className="button subtle"
                  disabled={isBusy}
                  onClick={() =>
                    perform("pdx-publish-draft", async () => {
                      const draft = await api.getPdxPublishDraft(detailMod.id);
                      setPublishing({
                        provider: "pdx",
                        id: detailMod.id,
                        draft,
                      });
                      setDetailMod(null);
                    })
                  }
                >
                  <T id={"发布到 Paradox Mods"} />
                  <ArrowRight size={15} />
                </button>
              )}
              {detailMod.available && api.openModFolder && (
                <button
                  className="button subtle"
                  onClick={() =>
                    perform("open", () => api.openModFolder(detailMod.id))
                  }
                >
                  <FolderOpen size={15} />
                  <T id={"所在文件夹"} />
                </button>
              )}
              {detailMod.source !== "local" && api.openModPage && (
                <button
                  className="button primary"
                  onClick={() =>
                    perform("open", () => api.openModPage(detailMod.id))
                  }
                >
                  <T id={"模组来源页"} />
                  <ArrowRight size={15} />
                </button>
              )}
            </div>
          </div>
        </Dialog>
      )}
      {authoring && (
        <LocalModEditor
          request={authoring}
          state={state}
          api={api}
          perform={perform}
          onState={setState}
          onClose={() => setAuthoring(null)}
          busy={isBusy}
          Dialog={Dialog}
        />
      )}
      {publishing && (
        <PublishDialog
          request={publishing}
          api={api}
          perform={perform}
          busy={isBusy}
          Dialog={Dialog}
          onClose={() => setPublishing(null)}
          onAccountSettings={() => {
            setPublishing(null);
            setPage("settings");
          }}
        />
      )}
      <CampaignReview
        review={campaignReview}
        Dialog={Dialog}
        busy={isBusy || launchPending}
        canLaunch={canLaunch}
        onClose={() => setCampaignReview(null)}
        onContinue={launch}
        onRestore={() =>
          perform("campaign-restore", async () => {
            const restored = await api.restoreCampaignConfiguration(
              campaignReview.campaign.id,
            );
            setState(restored);
            setCampaignReview(
              await api.reviewCampaign(campaignReview.campaign.id),
            );
            return restored;
          })
        }
      />
      <CampaignProgress api={api} active={busy.startsWith("campaign-")} />
      <SnapshotProgress api={api} active={busy.startsWith("snapshot-")} />
      <CoverageProgress api={api} active={busy.startsWith("coverage-")} />
    </div>
  );
}
