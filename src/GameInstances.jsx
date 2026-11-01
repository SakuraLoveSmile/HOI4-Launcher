import React, { useState } from "react";
import { Layers3, Plus, Pencil, Trash2, FolderOpen } from "lucide-react";
import { useI18n } from "./i18n.jsx";
import "./game-instances.css";

export default function GameInstances({
  state,
  api,
  perform,
  onState,
  busy,
  Dialog,
  compact = false,
}) {
  const { t } = useI18n();
  const [editor, setEditor] = useState(null);
  const [name, setName] = useState("");
  const [removing, setRemoving] = useState(null);
  const settings = state.settings;
  const instances = settings.gameInstances || [
    { id: "default", name: t("默认版本"), isolated: false },
  ];
  const activeId = settings.activeGameInstanceId || "default";
  const active = instances.find((item) => item.id === activeId) || instances[0];
  const locked = busy || state.launchStatus?.running;
  const supported = typeof api.switchGameInstance === "function";

  async function action(task, close = false) {
    return perform("game-instance", async () => {
      const result = await task();
      if (result) {
        onState(result);
        if (close) {
          setEditor(null);
          setRemoving(null);
        }
      }
      return result;
    });
  }

  const selector = (
    <label className="instance-selector">
      <span>{t("当前游戏版本")}</span>
      <select
        aria-label={t("当前游戏版本")}
        value={active.id}
        disabled={locked || !supported}
        onChange={(event) =>
          action(() => api.switchGameInstance(event.target.value))
        }
      >
        {instances.map((instance) => (
          <option key={instance.id} value={instance.id}>
            {instance.name}
          </option>
        ))}
      </select>
    </label>
  );

  if (compact)
    return (
      <div className="instance-compact" data-testid="game-instance-switcher">
        <Layers3 size={16} aria-hidden="true" />
        {selector}
      </div>
    );

  return (
    <section className="panel settings-panel game-instances-panel">
      <div className="section-heading">
        <h2>
          <Layers3 size={19} />
          {t("版本隔离")}
        </h2>
        <span className="status-chip">
          {active.isolated ? t("独立用户目录") : t("沿用原用户目录")}
        </span>
      </div>
      <p className="section-description">
        {t(
          "为旧版本或独立安装添加版本，各自保存播放集、DLC 选择和游戏设置。独立版本使用自己的存档、模组登记与缓存目录。",
        )}
      </p>
      <div className="instance-controls">
        {selector}
        <button
          className="button primary"
          disabled={locked || !supported}
          onClick={() => {
            setName("");
            setEditor({ kind: "create" });
          }}
        >
          <Plus size={16} />
          {t("添加独立版本")}
        </button>
        <button
          className="button subtle"
          disabled={locked || !supported}
          onClick={() => {
            setName(active.name);
            setEditor({ kind: "rename", id: active.id });
          }}
        >
          <Pencil size={15} />
          {t("重命名版本")}
        </button>
        <button
          className="button subtle"
          disabled={locked || !supported || active.id === "default"}
          onClick={() => setRemoving(active)}
        >
          <Trash2 size={15} />
          {t("移除版本")}
        </button>
      </div>
      <div className="instance-paths">
        <div>
          <span>{t("游戏安装")}</span>
          <code>{settings.gameDirectory || t("尚未配置游戏目录")}</code>
        </div>
        <div>
          <span>{t("存档与配置目录")}</span>
          <code>{state.paths.userData}</code>
        </div>
      </div>
      <p className="inline-note">
        {t(
          "添加时选择本机已有的游戏安装；启动器不会下载或复制游戏。Steam 工坊内容仍由 Steam 统一管理和更新。",
        )}
      </p>
      {state.launchStatus?.running && (
        <p className="inline-note" role="status">
          {t("请先退出游戏，再切换或管理版本。")}
        </p>
      )}
      {editor && (
        <Dialog
          title={t(editor.kind === "create" ? "添加独立版本" : "重命名版本")}
          onClose={() => !busy && setEditor(null)}
        >
          <form
            className="instance-form"
            onSubmit={(event) => {
              event.preventDefault();
              action(
                () =>
                  editor.kind === "create"
                    ? api.createGameInstance({ name: name.trim() })
                    : api.renameGameInstance({
                        id: editor.id,
                        name: name.trim(),
                      }),
                true,
              );
            }}
          >
            <label>
              {t("版本名称")}
              <input
                aria-label={t("版本名称")}
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={128}
                required
                disabled={busy}
              />
            </label>
            {editor.kind === "create" && (
              <p className="section-description">
                {t(
                  "下一步选择包含 hoi4.exe 的已有安装目录。新版本从空播放集开始，原版本的存档和配置保留。",
                )}
              </p>
            )}
            <div className="modal-actions">
              <button
                type="button"
                className="button subtle"
                disabled={busy}
                onClick={() => setEditor(null)}
              >
                {t("取消")}
              </button>
              <button
                type="submit"
                className="button primary"
                disabled={busy || !name.trim()}
              >
                {editor.kind === "create" && <FolderOpen size={16} />}
                {t(
                  editor.kind === "create" ? "选择安装目录并添加" : "保存名称",
                )}
              </button>
            </div>
          </form>
        </Dialog>
      )}
      {removing && (
        <Dialog
          title={t("移除版本")}
          onClose={() => !busy && setRemoving(null)}
        >
          <p className="instance-remove-name">{removing.name}</p>
          <p className="section-description">
            {t(
              "仅从启动器移除此版本记录，游戏文件、存档和配置目录均保留。移除后将切回默认版本。",
            )}
          </p>
          <div className="modal-actions">
            <button
              className="button subtle"
              disabled={busy}
              onClick={() => setRemoving(null)}
            >
              {t("取消")}
            </button>
            <button
              className="button primary"
              disabled={busy}
              onClick={() =>
                action(() => api.removeGameInstance(removing.id), true)
              }
            >
              {t("确认移除版本")}
            </button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
