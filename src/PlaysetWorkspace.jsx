import React, { useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  Copy,
  GripVertical,
  Layers3,
  ListFilter,
  ListMusic,
  Pencil,
  Plus,
  Search,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import { useI18n, T } from "./i18n.jsx";
import "./playsets.css";

export default function PlaysetWorkspace({
  settings,
  active,
  mods,
  members,
  busy,
  persist,
  addMembers,
  updateMods,
  toggleMod,
  moveMember,
  removeMember,
  onCreate,
  onCopy,
  onRename,
  onDelete,
  onDetail,
  onContextMenu,
  Emblem,
  children,
}) {
  const { t, locale } = useI18n();
  const [query, setQuery] = useState("");
  const [memberQuery, setMemberQuery] = useState("");
  const [source, setSource] = useState("all");
  const [status, setStatus] = useState("all");
  const [sort, setSort] = useState("name");
  const [compact, setCompact] = useState(false);
  const order = active.modOrder || active.modIds;
  const positions = new Map(order.map((id, index) => [id, index]));
  const enabled = new Set(active.modIds);
  const matches = (mod, text) =>
    `${mod.name} ${mod.originalName || ""} ${mod.remoteId || ""} ${(mod.tags || []).join(" ")}`
      .toLocaleLowerCase(locale)
      .includes(text.trim().toLocaleLowerCase(locale));
  const library = mods
    .filter(
      (mod) =>
        (source === "all" || source === mod.source) &&
        matches(mod, query) &&
        (status === "all" ||
          (status === "unadded" && !positions.has(mod.id)) ||
          (status === "enabled" && enabled.has(mod.id)) ||
          (status === "unavailable" && !mod.available) ||
          (status === "incompatible" && mod.compatibility === "different")),
    )
    .sort((a, b) =>
      sort === "source"
        ? a.source.localeCompare(b.source) ||
          a.name.localeCompare(b.name, locale)
        : (sort === "name-desc" ? -1 : 1) *
          a.name.localeCompare(b.name, locale),
    );
  const visibleMembers = members.filter((mod) => matches(mod, memberQuery));
  const additions = library.filter(
    (mod) => mod.available && !positions.has(mod.id),
  );
  const enableIds = new Set(
    visibleMembers.filter((mod) => mod.available).map((mod) => mod.id),
  );

  function search(value, onChange, label, clearLabel) {
    return (
      <div className="search-input">
        <Search size={15} aria-hidden="true" />
        <input
          aria-label={label}
          placeholder={label}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
        {value && (
          <button aria-label={clearLabel} onClick={() => onChange("")}>
            <X size={14} />
          </button>
        )}
      </div>
    );
  }

  function row(mod, index, member) {
    const position = positions.get(mod.id);
    const added = positions.has(mod.id);
    return (
      <div
        key={mod.id}
        data-mod-id={mod.id}
        className={`mod-row ${member && enabled.has(mod.id) ? "is-enabled" : ""}`}
        tabIndex={onContextMenu ? 0 : undefined}
        aria-haspopup={onContextMenu ? "menu" : undefined}
        onContextMenu={(event) => {
          if (!onContextMenu) return;
          event.preventDefault();
          onContextMenu(event, mod);
        }}
        onKeyDown={(event) => {
          if (
            onContextMenu &&
            (event.key === "ContextMenu" ||
              (event.shiftKey && event.key === "F10"))
          ) {
            event.preventDefault();
            event.stopPropagation();
            onContextMenu(event, mod);
          }
        }}
        draggable={member && !busy}
        onDragStart={(event) => {
          event.dataTransfer.setData(
            "application/x-ironclad-member",
            JSON.stringify({ playset: active.id, id: mod.id }),
          );
          event.dataTransfer.effectAllowed = "move";
        }}
        onDragOver={(event) => {
          if (
            member &&
            !busy &&
            event.dataTransfer.types.includes("application/x-ironclad-member")
          )
            event.preventDefault();
        }}
        onDrop={(event) => {
          event.preventDefault();
          if (!member || busy) return;
          try {
            const value = JSON.parse(
              event.dataTransfer.getData("application/x-ironclad-member"),
            );
            if (
              value.playset === active.id &&
              positions.has(value.id) &&
              value.id !== mod.id
            )
              moveMember(value.id, position);
          } catch {
            /* Ignore unrelated drag payloads. */
          }
        }}
      >
        {member && (
          <div className="playset-order">
            <GripVertical size={12} aria-hidden="true" />
            <span>{position + 1}</span>
            <div>
              <button
                aria-label={t("上移 {0}", { 0: mod.name })}
                disabled={busy || position === 0}
                onClick={() => moveMember(mod.id, position - 1)}
              >
                <ArrowUp size={12} />
              </button>
              <button
                aria-label={t("下移 {0}", { 0: mod.name })}
                disabled={busy || position === order.length - 1}
                onClick={() => moveMember(mod.id, position + 1)}
              >
                <ArrowDown size={12} />
              </button>
            </div>
          </div>
        )}
        <Emblem mod={mod} index={index} />
        <div className="mod-info">
          <h3 title={mod.name}>
            <button className="mod-name-button" onClick={() => onDetail(mod)}>
              {mod.name}
            </button>
          </h3>
          <div className="mod-meta">
            <span>
              {mod.source === "workshop"
                ? "Steam"
                : mod.source === "pdx"
                  ? "Paradox Mods"
                  : t("本地模组")}
            </span>
            <span>·</span>
            <span>{mod.supportedVersion || t("未声明版本")}</span>
          </div>
          <div className="playset-row-status">
            {!mod.available ? (
              <span className="compatibility-warning">
                <T id="文件缺失" />
              </span>
            ) : mod.compatibility === "different" ? (
              <span className="compatibility-warning">
                <T id="版本不匹配" />
              </span>
            ) : (
              <span>{mod.version || t("文件可用")}</span>
            )}
          </div>
        </div>
        {member ? (
          <>
            <button
              type="button"
              role="switch"
              className="toggle"
              aria-checked={enabled.has(mod.id)}
              aria-label={`${enabled.has(mod.id) ? t("停用") : t("启用")} ${mod.name}`}
              disabled={busy || (!mod.available && !enabled.has(mod.id))}
              onClick={() => toggleMod(mod.id)}
            >
              <span />
            </button>
            <button
              className="playset-row-action"
              aria-label={t("从播放集移除 {0}", { 0: mod.name })}
              title={t("从播放集移除 {0}", { 0: mod.name })}
              disabled={busy}
              onClick={() => removeMember(mod.id)}
            >
              <X size={17} />
            </button>
          </>
        ) : (
          <button
            className={`playset-row-action ${added ? "is-added" : ""}`}
            aria-label={t(added ? "已在播放集 {0}" : "加入播放集 {0}", {
              0: mod.name,
            })}
            title={t(added ? "已在播放集 {0}" : "加入播放集 {0}", {
              0: mod.name,
            })}
            disabled={busy || added || !mod.available}
            onClick={() => addMembers([mod.id])}
          >
            {added ? <Check size={18} /> : <Plus size={20} />}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className={`playset-workspace ${compact ? "is-compact" : ""}`}>
      <section className="playset-toolbar">
        <label className="toolbar-label" htmlFor="active-playset">
          <ListMusic size={19} />
          <T id="播放集" />
        </label>
        <select
          id="active-playset"
          aria-label={t("编辑模组播放集")}
          value={active.id}
          disabled={busy}
          onChange={(event) =>
            persist({ activePlaysetId: event.target.value }, "已切换模组播放集")
          }
        >
          {settings.playsets.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
        <button
          className="button subtle"
          disabled={busy || settings.playsets.length >= 100}
          onClick={onCreate}
        >
          <Plus size={15} />
          <T id="新建播放集" />
        </button>
        <div className="playset-actions">
          {[
            [Copy, "复制当前播放集", onCopy],
            [Pencil, "重命名当前播放集", onRename],
            [Trash2, "删除当前播放集", onDelete],
          ].map(([Icon, label, action]) => (
            <button
              key={label}
              className="icon-button"
              aria-label={t(label)}
              title={t(label)}
              onClick={action}
              disabled={
                busy ||
                (label === "删除当前播放集" && settings.playsets.length <= 1) ||
                (label === "复制当前播放集" && settings.playsets.length >= 100)
              }
            >
              <Icon size={16} />
            </button>
          ))}
        </div>
        <button
          className="button subtle playset-density"
          aria-pressed={compact}
          onClick={() => setCompact(!compact)}
        >
          <ListFilter size={15} />
          <T id="简化显示" />
        </button>
      </section>
      {children}
      <div className="playset-columns">
        <section className="panel playset-library" aria-label={t("已识别模组")}>
          <header className="playset-panel-heading">
            <h2>
              <Layers3 size={17} />
              <T id="已识别模组" />
              <span>{mods.length}</span>
            </h2>
          </header>
          <div className="playset-search">
            {search(query, setQuery, t("搜索模组"), t("清空搜索"))}
          </div>
          <div className="playset-library-controls">
            <div
              className="source-tabs"
              role="group"
              aria-label={t("模组来源")}
            >
              {[
                ["all", t("全部模组")],
                ["workshop", t("创意工坊")],
                ["pdx", "Paradox Mods"],
                ["local", t("本地")],
              ].map(([value, label]) => (
                <button
                  key={value}
                  className={source === value ? "selected" : ""}
                  aria-pressed={source === value}
                  onClick={() => setSource(value)}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="playset-filters">
              <select
                aria-label={t("模组状态筛选")}
                value={status}
                onChange={(event) => setStatus(event.target.value)}
              >
                {[
                  ["all", "所有状态"],
                  ["unadded", "未加入播放集"],
                  ["enabled", "已启用"],
                  ["unavailable", "文件缺失"],
                  ["incompatible", "版本不匹配"],
                ].map(([value, label]) => (
                  <option key={value} value={value}>
                    {t(label)}
                  </option>
                ))}
              </select>
              <select
                aria-label={t("模组库排序")}
                value={sort}
                onChange={(event) => setSort(event.target.value)}
              >
                {[
                  ["name", "名称 A → Z"],
                  ["name-desc", "名称 Z → A"],
                  ["source", "按来源"],
                ].map(([value, label]) => (
                  <option key={value} value={value}>
                    {t(label)}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="playset-list-summary">
            <span>
              <T id="模组名称 " />
              <T id="/ {0} 项" values={[library.length]} />
            </span>
            <button
              disabled={busy || !additions.length}
              onClick={() => addMembers(additions.map((mod) => mod.id))}
            >
              <Plus size={13} />
              <T id="加入筛选结果" />
            </button>
          </div>
          <div className="mod-list full-list">
            {library.map((mod, index) => row(mod, index, false))}
            {!library.length && (
              <div className="empty-state">
                <Layers3 size={30} />
                <h3>
                  {mods.length
                    ? t("没有找到匹配的模组")
                    : t("你的模组库，等待集结")}
                </h3>
                <p>
                  {mods.length
                    ? t("试试其他名称，或切换模组来源。")
                    : t(
                        "在 Steam 订阅模组或添加本地 .mod 文件后，点击刷新资料。",
                      )}
                </p>
              </div>
            )}
          </div>
        </section>
        <section
          className="panel playset-members"
          aria-label={t("当前播放集模组")}
        >
          <header className="playset-panel-heading">
            <h2>
              <ListMusic size={17} />
              <T id="当前播放集模组" />
              <span>{members.length}</span>
            </h2>
            <span className="playset-enabled-count">
              <T
                id="{0} / {1} 已启用"
                values={[enabled.size, members.length]}
              />
            </span>
          </header>
          <div className="playset-search">
            {search(
              memberQuery,
              setMemberQuery,
              t("搜索当前播放集"),
              t("清空播放集搜索"),
            )}
          </div>
          <p className="playset-order-hint">
            <GripVertical size={14} />
            <T id="拖动行或使用箭头调整顺序" />
          </p>
          <div className="playset-list-summary">
            <span>
              <T id="模组名称 " />
              <T id="/ {0} 项" values={[visibleMembers.length]} />
            </span>
            <div>
              <button
                disabled={
                  busy ||
                  !visibleMembers.some(
                    (mod) => mod.available && !enabled.has(mod.id),
                  )
                }
                onClick={() =>
                  updateMods(
                    order.filter((id) => enabled.has(id) || enableIds.has(id)),
                  )
                }
              >
                <T id="启用筛选结果" />
              </button>
              <button
                disabled={busy || !enabled.size}
                onClick={() => updateMods([])}
              >
                <T id="全部停用" />
              </button>
            </div>
          </div>
          <div className="mod-list full-list">
            {visibleMembers.map((mod, index) => row(mod, index, true))}
            {!visibleMembers.length && (
              <div className="empty-state">
                <ListMusic size={30} />
                <h3>
                  {members.length
                    ? t("没有找到匹配的模组")
                    : t("此播放集暂无模组")}
                </h3>
                <p>
                  {members.length
                    ? t("试试其他名称，或清空搜索。")
                    : t("点击左侧的加号，将模组加入当前播放集。")}
                </p>
              </div>
            )}
          </div>
        </section>
      </div>
      <div className="panel-footnote">
        <ShieldCheck size={15} />
        <T id="播放集会自动保存；点击启动游戏时应用模组，并备份原有加载配置。" />
      </div>
    </div>
  );
}
