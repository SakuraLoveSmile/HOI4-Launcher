import { useI18n, T } from "./i18n.jsx";
import React, { useEffect, useState } from "react";
import {
  ArrowRight,
  Check,
  Copy,
  Download,
  FileJson,
  FolderInput,
  History,
  Layers3,
  Monitor,
  Package,
  Plus,
  Search,
  ShieldCheck,
  Upload,
  X,
} from "lucide-react";
const settingLabels = {
  display_mode: "显示模式",
  display_index: "显示器",
  vsync: "垂直同步",
  fullscreen_resolution: "全屏分辨率",
  windowed_resolution: "窗口分辨率",
  refreshRate: "刷新率",
  renderer: "渲染器",
  language: "游戏语言",
};
const valueLabels = {
  fullscreen: "全屏",
  borderless_fullscreen: "无边框全屏",
  windowed: "窗口",
  dx11: "DirectX 11",
  dx9_compat: "DirectX 9（兼容）",
  opengl: "OpenGL",
};
const categoryLabels = {
  content: "内容包",
  expansion: "扩展包",
  music: "音乐",
  unit: "单位包",
  cosmetic: "外观",
};
export function DlcPanel({ state, active, persist, busy }) {
  const { t, message, locale } = useI18n();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const dlc = state.dlc || {
    items: [],
    disabledIds: [],
  };
  const disabled = new Set(
    active.disabledDlcIds ?? state.settings.disabledDlcIds ?? dlc.disabledIds,
  );
  const visible = dlc.items.filter(
    (item) =>
      item.name.toLowerCase().includes(query.toLowerCase()) &&
      (filter === "all" ||
        (filter === "enabled"
          ? !disabled.has(item.id)
          : disabled.has(item.id))),
  );
  function save(ids, clearUnmapped = false) {
    return persist(
      {
        playsets: state.settings.playsets.map((item) =>
          item.id === active.id
            ? {
                ...item,
                disabledDlcIds: [...new Set(ids)],
                ...(clearUnmapped
                  ? {
                      unmappedDlcIds: [],
                    }
                  : {}),
              }
            : item,
        ),
      },
      "此播放集的 DLC 选择已保存",
    );
  }
  return (
    <>
      <div className="feature-intro">
        <Package size={20} />
        <div>
          <strong>{active.name}</strong>
          <p>
            <T id={"DLC 选择随播放集独立保存，在下一次启动时应用。"} />
          </p>
        </div>
        <span>
          <T
            id={"{0} / {1} 已启用"}
            values={[
              dlc.items.filter(
                (item) => item.installed && !disabled.has(item.id),
              ).length,
              dlc.items.length,
            ]}
          />
        </span>
      </div>
      {!!active.unmappedDlcIds?.length && (
        <div className="warning-banner">
          <span>
            <T
              id={"导入的播放集有 {0} 个 DLC 未在此安装中找到：{1}"}
              values={[
                active.unmappedDlcIds.length,
                active.unmappedDlcIds.join("、"),
              ]}
            />
          </span>
          <button disabled={busy} onClick={() => save([...disabled], true)}>
            <T id={"按本地 DLC 重新保存"} />
          </button>
        </div>
      )}
      <section className="panel">
        <div className="mods-tools">
          <div className="source-tabs">
            {[
              ["all", t("全部 DLC")],
              ["enabled", t("已启用")],
              ["disabled", t("已停用")],
            ].map(([key, label]) => (
              <button
                key={key}
                className={filter === key ? "selected" : ""}
                aria-pressed={filter === key}
                onClick={() => setFilter(key)}
              >
                {t(label)}
              </button>
            ))}
          </div>
          <div className="search-input">
            <Search size={16} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label={t("搜索 DLC")}
              placeholder={t("搜索扩展包、内容或音乐…")}
            />
          </div>
        </div>
        <div className="list-labels">
          <span>
            <T id={"已安装内容 / {0} 项"} values={[visible.length]} />
          </span>
          <div>
            <button
              disabled={busy || !visible.some((item) => disabled.has(item.id))}
              onClick={() =>
                save(
                  [...disabled].filter(
                    (id) =>
                      !visible.some((item) => item.id === id && item.installed),
                  ),
                )
              }
            >
              <T id={"启用筛选结果"} />
            </button>
            <span>·</span>
            <button
              disabled={busy || !visible.length}
              onClick={() =>
                save([...disabled, ...visible.map((item) => item.id)])
              }
            >
              <T id={"停用筛选结果"} />
            </button>
          </div>
        </div>
        <div className="dlc-grid">
          {visible.map((item) => (
            <article className="dlc-card" key={item.id}>
              <div className={`dlc-symbol category-${item.category}`}>
                <Package size={24} />
              </div>
              <div>
                <h3>{item.name}</h3>
                <p>
                  {t(categoryLabels[item.category] || item.category)}
                  {!item.installed && t(" · 文件缺失")}
                </p>
              </div>
              <button
                role="switch"
                aria-label={`${disabled.has(item.id) ? t("启用") : t("停用")} DLC ${item.name}`}
                aria-checked={!disabled.has(item.id) && item.installed}
                className="toggle"
                disabled={busy || !item.installed}
                onClick={() =>
                  save(
                    disabled.has(item.id)
                      ? [...disabled].filter((id) => id !== item.id)
                      : [...disabled, item.id],
                  )
                }
              >
                <span />
              </button>
            </article>
          ))}
        </div>
        {!visible.length && (
          <div className="empty-state">
            <Package size={32} />
            <h3>
              {dlc.items.length ? t("没有匹配的 DLC") : t("尚未发现 DLC 内容")}
            </h3>
            <p>
              <T id={"配置游戏目录并完成 Steam 下载后，刷新本地资料。"} />
            </p>
          </div>
        )}
        <div className="panel-footnote">
          <ShieldCheck size={15} />
          <span>
            <T
              id={"这里管理本地内容的启用状态；拥有权限仍由游戏与 Steam 验证。"}
            />
          </span>
        </div>
      </section>
    </>
  );
}
export function GameOptionsPanel({ state, persist, api, busy }) {
  const { t, message, locale } = useI18n();
  const [displays, setDisplays] = useState([]);
  const [displayError, setDisplayError] = useState("");
  useEffect(() => {
    let mounted = true;
    api
      .getDisplays?.()
      .then((result) => mounted && setDisplays(result))
      .catch((error) => mounted && setDisplayError(error.message));
    return () => {
      mounted = false;
    };
  }, [api]);
  const data = state.gameOptions;
  if (!data?.layout) return null;
  const values = {
    ...(data.persistedValues || data.values),
    ...state.settings.gameOptions,
  };
  const activeDisplay =
    displays.find((item) => item.index === Number(values.display_index ?? 0)) ||
    displays[0];
  function optionsFor(setting) {
    if (setting.options?.length)
      return setting.options.map((option) => ({
        ...option,
        label: valueLabels[option.value] || option.label,
      }));
    if (setting.name === "display_index")
      return displays.map((display) => ({
        value: String(display.index),
        label: `${display.index + 1} · ${display.name}${display.primary ? t("（主显示器）") : ""}`,
      }));
    if (setting.name.endsWith("_resolution"))
      return (activeDisplay?.resolutions || []).map((value) => ({
        value,
        label: value.replace("x", " × "),
      }));
    if (setting.name === "refreshRate")
      return (
        activeDisplay?.refreshRatesByResolution?.[
          values.fullscreen_resolution
        ] || [activeDisplay?.currentRefreshRate].filter(Boolean)
      ).map((value) => ({
        value: String(value),
        label: `${value} Hz`,
      }));
    return [];
  }
  function change(setting, value) {
    return persist(
      {
        gameOptions: {
          ...state.settings.gameOptions,
          [setting.name]: value,
        },
      },
      "游戏设置已保存，将在启动时应用",
    );
  }
  return (
    <section className="panel settings-panel game-options-panel">
      <div className="section-heading">
        <h2>
          <Monitor size={19} />
          <T id={"游戏设置"} />
        </h2>
        {Object.keys(state.settings.gameOptions || {}).length > 0 && (
          <button
            className="text-button"
            disabled={busy}
            onClick={() =>
              persist(
                {
                  gameOptions: {},
                },
                "已改为沿用游戏现有设置",
              )
            }
          >
            <T id={"沿用游戏现有设置"} />
          </button>
        )}
      </div>
      <p className="section-description">
        <T id={"按游戏提供的选项保存偏好，启动前自动备份原配置。"} />
      </p>
      {!state.game.found && (
        <p className="inline-note">
          <T id={"请先选择游戏目录。"} />
        </p>
      )}
      {data.layout.map((category) => (
        <div className="option-category" key={category.category}>
          <h3>
            {category.category === "Graphics"
              ? t("显示与图形")
              : category.category === "System"
                ? t("系统")
                : t(category.label)}
          </h3>
          <div className="option-grid">
            {category.settings.map((setting) => {
              const value = values[setting.name] ?? setting.default ?? "";
              let options = optionsFor(setting);
              if (
                value !== "" &&
                !options.some(
                  (option) => String(option.value) === String(value),
                )
              )
                options = [
                  {
                    value,
                    label: t("{0}（当前）", {
                      0: value,
                    }),
                  },
                  ...options,
                ];
              return (
                <label className="game-option" key={setting.name}>
                  <span>
                    {t(settingLabels[setting.name] || setting.label)}
                    {Object.hasOwn(
                      state.settings.gameOptions || {},
                      setting.name,
                    ) && (
                      <small>
                        <T id={"已保存偏好"} />
                      </small>
                    )}
                  </span>
                  {setting.type === "toggle" ? (
                    <button
                      type="button"
                      role="switch"
                      className="toggle"
                      aria-label={t(
                        settingLabels[setting.name] || setting.label,
                      )}
                      aria-checked={Boolean(value)}
                      disabled={busy || !state.game.found}
                      onClick={() => change(setting, !value)}
                    >
                      <span />
                    </button>
                  ) : (
                    <select
                      aria-label={t(
                        settingLabels[setting.name] || setting.label,
                      )}
                      value={String(value)}
                      disabled={busy || !state.game.found || !options.length}
                      onChange={(e) => change(setting, e.target.value)}
                    >
                      {value === "" && (
                        <option value="">
                          <T id={"沿用游戏默认"} />
                        </option>
                      )}
                      {options.map((option) => (
                        <option
                          key={String(option.value)}
                          value={String(option.value)}
                        >
                          {t(option.label)}
                        </option>
                      ))}
                    </select>
                  )}
                </label>
              );
            })}
          </div>
        </div>
      ))}
      {message(displayError) && (
        <p className="inline-note">
          <T
            id={"显示器选项读取失败：{0}。现有选项仍会保留。"}
            values={[message(displayError)]}
          />
        </p>
      )}
    </section>
  );
}
export function ContinueCard({ state, canLaunch, onLaunch }) {
  const { t, message, locale } = useI18n();
  const save = state.continueGame;
  return (
    <section className="continue-card">
      <div className="continue-icon">
        <History size={21} />
      </div>
      <div>
        <span>
          <T id={"继续上次战役"} />
        </span>
        <h3>{save?.title || t("你的下一场战役，从这里开始")}</h3>
        <p>
          {save?.available
            ? `${save.remote ? t("Steam 云存档") : t("本地存档")} · ${save.filename}`
            : message(save?.reason) || t("尚无可继续的存档")}
        </p>
      </div>
      <button
        className="button subtle"
        disabled={!canLaunch || !save?.available}
        onClick={() =>
          onLaunch({
            resume: true,
          })
        }
      >
        <T id={"继续游戏"} />
        <ArrowRight size={16} />
      </button>
    </section>
  );
}
export function PlaysetTransfer({
  children,
  api,
  state,
  active,
  onState,
  perform,
  busy,
  Dialog,
  onCreateMod,
}) {
  const { t, message, locale } = useI18n();
  const [mode, setMode] = useState(null);
  const [official, setOfficial] = useState(null);
  const [selection, setSelection] = useState([]);
  const [json, setJson] = useState("");
  const [exportData, setExportData] = useState(null);
  async function openOfficial() {
    await perform("official", async () => {
      const result = await api.getOfficialPlaysets();
      setOfficial(result);
      setSelection(
        result.playsets
          .filter((item) => item.isActive)
          .map((item) => item.sourceId),
      );
      setMode("official");
      return result;
    });
  }
  async function importSelected() {
    await perform(
      "import",
      async () => {
        const result = await api.importOfficialPlaysets(selection);
        onState(result.state);
        setMode(null);
        return result;
      },
      "官方播放集已导入",
    );
  }
  async function importText(event) {
    event.preventDefault();
    await perform(
      "import",
      async () => {
        const result = await api.importPlayset(json);
        onState(result);
        setMode(null);
        return result;
      },
      "播放集已导入",
    );
  }
  async function exportCurrent() {
    await perform("export", async () => {
      const result = await api.exportPlayset(active.id);
      setExportData(result);
      setJson(JSON.stringify(result.document, null, 2));
      setMode("export");
      return result;
    });
  }
  return (
    <>
      <div className="transfer-toolbar">
        <button
          className="button subtle"
          disabled={busy}
          onClick={openOfficial}
        >
          <FolderInput size={15} />
          <T id={"导入官方播放集"} />
        </button>
        <button
          className="button subtle"
          disabled={busy}
          onClick={() => {
            setJson("");
            setMode("import");
          }}
        >
          <Upload size={15} />
          <T id={"导入 JSON"} />
        </button>
        <button
          className="button subtle"
          disabled={busy}
          onClick={exportCurrent}
        >
          <Download size={15} />
          <T id={"导出当前播放集"} />
        </button>
        {onCreateMod && (
          <button
            className="button subtle"
            disabled={busy || state.launchStatus?.running}
            onClick={onCreateMod}
          >
            <Plus size={15} />
            <T id={"创建本地模组"} />
          </button>
        )}
        {children}
        <span>
          <T id={"兼容官方播放集格式"} />
        </span>
      </div>
      {mode && (
        <Dialog
          title={
            mode === "official"
              ? t("导入官方启动器播放集")
              : mode === "import"
                ? t("导入播放集 JSON")
                : t("导出当前播放集")
          }
          onClose={() => !busy && setMode(null)}
        >
          {mode === "official" ? (
            <>
              <p className="modal-description">
                <T
                  id={
                    "保留成员、启用状态、顺序和 DLC 选择。会创建新播放集，不修改官方数据。"
                  }
                />
              </p>
              {official.warnings.map((warning, index) => (
                <p className="inline-note" key={index}>
                  {message(warning)}
                </p>
              ))}
              <div className="official-playsets">
                {official.playsets.map((item) => (
                  <label className="official-playset" key={item.sourceId}>
                    <input
                      type="checkbox"
                      checked={selection.includes(item.sourceId)}
                      disabled={busy}
                      onChange={(e) =>
                        setSelection((previous) =>
                          e.target.checked
                            ? [...previous, item.sourceId]
                            : previous.filter((id) => id !== item.sourceId),
                        )
                      }
                    />
                    <span>
                      {item.name}
                      <small>
                        <T
                          id={"{0} 个成员 · {1} 个启用{2}"}
                          values={[
                            item.modOrder.length,
                            item.modIds.length,
                            item.isActive ? t(" · 官方当前播放集") : "",
                          ]}
                        />
                      </small>
                    </span>
                  </label>
                ))}
              </div>
              {!official.playsets.length && (
                <p className="inline-note">
                  <T id={"没有找到可导入的官方播放集。"} />
                </p>
              )}
              <div className="modal-actions">
                <button
                  className="button subtle"
                  onClick={() => setMode(null)}
                  disabled={busy}
                >
                  <T id={"取消"} />
                </button>
                <button
                  className="button primary"
                  disabled={busy || !selection.length}
                  onClick={importSelected}
                >
                  <T id={"导入 {0} 个播放集"} values={[selection.length]} />
                </button>
              </div>
            </>
          ) : (
            <form
              onSubmit={
                mode === "import" ? importText : (e) => e.preventDefault()
              }
            >
              <p className="modal-description">
                {mode === "import"
                  ? t(
                      "粘贴官方导出的播放集 JSON，或从文件导入。未安装的模组会保留为缺失项。",
                    )
                  : t(
                      "包含远程模组、启用状态和加载顺序。官方交换格式不包含本地模组及 DLC 选择。",
                    )}
              </p>
              {!!exportData?.omittedLocalMods.length && mode === "export" && (
                <p className="inline-note">
                  <T
                    id={"本次有 {0} 个本地模组不包含在导出文件中。"}
                    values={[exportData.omittedLocalMods.length]}
                  />
                </p>
              )}
              <textarea
                className="json-textarea"
                aria-label={t("播放集 JSON")}
                value={json}
                readOnly={mode === "export"}
                onChange={(e) => setJson(e.target.value)}
                maxLength={4 * 1024 * 1024}
                spellCheck="false"
              />
              <div className="modal-actions">
                {mode === "import" ? (
                  <>
                    <button
                      type="button"
                      className="button subtle"
                      disabled={busy}
                      onClick={() =>
                        perform(
                          "import",
                          async () => {
                            const result = await api.importPlaysetFile();
                            if (result) {
                              onState(result);
                              setMode(null);
                            }
                            return result;
                          },
                          "播放集已导入",
                        )
                      }
                    >
                      <FileJson size={15} />
                      <T id={"选择文件"} />
                    </button>
                    <button
                      type="submit"
                      className="button primary"
                      disabled={busy || !json.trim()}
                    >
                      <T id={"导入 JSON"} />
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      className="button subtle"
                      onClick={() =>
                        perform(
                          "copy",
                          async () => {
                            if (api.copyText) await api.copyText(json);
                            else await navigator.clipboard.writeText(json);
                            return true;
                          },
                          "JSON 已复制",
                        )
                      }
                      disabled={busy}
                    >
                      <Copy size={15} />
                      <T id={"复制 JSON"} />
                    </button>
                    <button
                      type="button"
                      className="button primary"
                      disabled={busy}
                      onClick={() =>
                        perform(
                          "export",
                          () => api.exportPlaysetFile(active.id),
                          "播放集文件已保存",
                        )
                      }
                    >
                      <Download size={15} />
                      <T id={"保存文件"} />
                    </button>
                  </>
                )}
              </div>
            </form>
          )}
        </Dialog>
      )}
    </>
  );
}
