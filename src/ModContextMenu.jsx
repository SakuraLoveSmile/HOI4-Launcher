import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  Copy,
  ExternalLink,
  FolderOpen,
  GitBranch,
  Languages,
  ListMinus,
  Pencil,
  RefreshCw,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { useI18n } from "./i18n.jsx";
import "./mod-context-menu.css";

export default function ModContextMenu({
  request,
  state,
  api,
  perform,
  onState,
  onClose,
  busy,
  Dialog,
  onRemoveMember,
  onCreateProject,
}) {
  const { t } = useI18n();
  const menu = useRef(null);
  const nameInput = useRef(null);
  const previousFocus = useRef(document.activeElement);
  const [dialog, setDialog] = useState(null);
  const [name, setName] = useState("");
  const [lookingUp, setLookingUp] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const mod =
    state.mods.find((item) => item.id === request.mod.id) || request.mod;
  const active = state.settings.playsets.find(
    (item) => item.id === state.settings.activePlaysetId,
  );
  const member = (active?.modOrder || active?.modIds || []).includes(mod.id);
  const running = state.launchStatus?.running;
  const remote = mod.source === "workshop" || mod.source === "pdx";
  const deletable =
    mod.canDelete ?? (!mod.projectId && (remote || mod.canDeleteLocal));
  const remoteId = mod.remoteId || mod.id;
  const originalName = mod.originalName || mod.name;

  useLayoutEffect(() => {
    if (dialog || !menu.current) return;
    const rect = menu.current.getBoundingClientRect();
    const x = Number.isFinite(request.x) ? request.x : 8;
    const y = Number.isFinite(request.y) ? request.y : 8;
    setPosition({
      left: Math.max(8, Math.min(x, window.innerWidth - rect.width - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - rect.height - 8)),
    });
    menu.current.querySelector('[role="menuitem"]:not(:disabled)')?.focus();
  }, [request.x, request.y, request.mod.id, dialog]);

  useEffect(() => {
    return () => {
      if (previousFocus.current?.isConnected) previousFocus.current.focus();
    };
  }, []);

  useEffect(() => {
    if (dialog === "translated" && !lookingUp) nameInput.current?.focus();
  }, [dialog, lookingUp]);

  useEffect(() => {
    if (dialog) return;
    function outside(event) {
      if (!menu.current?.contains(event.target)) onClose();
    }
    function scroll(event) {
      if (!menu.current?.contains(event.target)) onClose();
    }
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", onClose);
    };
  }, [dialog, onClose]);

  async function action(task, success) {
    return perform(
      "mod-context",
      async () => {
        const result = await task();
        const next = result?.state || (result?.settings ? result : null);
        if (next) onState(next);
        onClose();
        return result;
      },
      success,
    );
  }

  async function translateName() {
    setName(mod.displayNameKind === "translated" ? mod.name : "");
    setDialog("translated");
    setLookingUp(true);
    try {
      await perform("mod-name-lookup", async () => {
        const result = await api.getLocalizedModName(mod.id);
        if (result?.name) setName(result.name);
        return result;
      });
    } finally {
      setLookingUp(false);
    }
  }

  function keyboard(event) {
    if (["Escape", "Tab"].includes(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const items = [
      ...menu.current.querySelectorAll('[role="menuitem"]:not(:disabled)'),
    ];
    if (!items.length) return;
    const current = items.indexOf(document.activeElement);
    const index =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : (current + (event.key === "ArrowUp" ? -1 : 1) + items.length) %
            items.length;
    items[index].focus();
  }

  function item(Icon, label, callback, disabled = false, danger = false) {
    return (
      <button
        type="button"
        role="menuitem"
        tabIndex={-1}
        className={danger ? "is-danger" : ""}
        disabled={busy || disabled}
        onClick={callback}
      >
        <Icon size={15} aria-hidden="true" />
        <span>{t(label)}</span>
      </button>
    );
  }

  if (dialog)
    return (
      <Dialog
        title={t(
          dialog === "delete"
            ? "删除模组"
            : dialog === "translated"
              ? "汉化名称并记住"
              : "修改显示名称",
        )}
        onClose={() => !busy && !lookingUp && onClose()}
      >
        {dialog === "delete" ? (
          <>
            <p className="mod-context-current-name">{mod.name}</p>
            <p className="modal-description">
              {t(
                mod.source === "workshop"
                  ? "将取消此模组的 Steam 订阅，影响共用该工坊内容的所有版本；文件由 Steam 管理和移除，并从当前版本的所有播放集中移除引用。"
                  : mod.source === "pdx"
                    ? "仅卸载此游戏目录中的 IRONCLAD 受管安装，保留恢复备份，并从当前版本的所有播放集中移除引用。"
                    : "将本地模组和登记文件移到可恢复的回收位置，并从当前版本的所有播放集中移除引用。",
              )}
            </p>
            <div className="modal-actions">
              <button
                className="button subtle"
                disabled={busy}
                onClick={onClose}
              >
                {t("取消")}
              </button>
              <button
                className="button mod-context-delete-confirm"
                disabled={busy || running || !deletable}
                onClick={() =>
                  action(() => api.deleteMod(mod.id), "模组删除操作已完成")
                }
              >
                <Trash2 size={15} />
                {t("确认删除模组")}
              </button>
            </div>
          </>
        ) : (
          <form
            className="mod-context-name-form"
            onSubmit={(event) => {
              event.preventDefault();
              action(
                () =>
                  api.setModDisplayName({
                    modId: mod.id,
                    name: name.trim(),
                    kind: dialog,
                  }),
                "模组显示名称已保存",
              );
            }}
          >
            <p className="modal-description">
              {t("只改变启动器中的显示名称，不修改模组原文件或依赖关系。")}
            </p>
            <p className="mod-context-original-name">
              <span>{t("原名称")}</span>
              <span>{originalName}</span>
            </p>
            {dialog === "translated" && (
              <p
                className="section-description"
                role="status"
                aria-live="polite"
              >
                {t(
                  lookingUp
                    ? "正在读取已有中文标题…"
                    : "可审阅 Steam 已有的中文标题，或填写希望记住的中文名称。保存后会在启动器中沿用。",
                )}
              </p>
            )}
            <label>
              {t("显示名称")}
              <input
                ref={nameInput}
                aria-label={t("显示名称")}
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={128}
                required
                disabled={busy || lookingUp}
              />
            </label>
            <div className="modal-actions">
              <button
                type="button"
                className="button subtle"
                disabled={busy || lookingUp}
                onClick={onClose}
              >
                {t("取消")}
              </button>
              <button
                type="submit"
                className="button primary"
                disabled={busy || lookingUp || !name.trim()}
              >
                {t("保存名称")}
              </button>
            </div>
          </form>
        )}
      </Dialog>
    );

  return (
    <div
      ref={menu}
      role="menu"
      aria-label={t("模组操作")}
      className="mod-context-menu"
      style={position}
      onKeyDown={keyboard}
      onContextMenu={(event) => event.preventDefault()}
    >
      <div className="mod-context-menu-heading" title={mod.name}>
        <span>{mod.name}</span>
        <small>
          {t("模组 ID")} · {remoteId}
        </small>
      </div>
      {item(
        Pencil,
        "修改显示名称",
        () => {
          setName(mod.name);
          setDialog("custom");
        },
        !api.setModDisplayName,
      )}
      {item(
        Languages,
        "汉化名称并记住",
        translateName,
        !api.getLocalizedModName || !api.setModDisplayName,
      )}
      {item(
        RotateCcw,
        "恢复原名称",
        () => action(() => api.resetModDisplayName(mod.id), "模组原名称已恢复"),
        !mod.displayNameKind || !api.resetModDisplayName,
      )}
      <div role="separator" />
      {item(
        Copy,
        "复制模组 ID",
        () => action(() => api.copyText(String(remoteId)), "模组 ID 已复制"),
        !api.copyText,
      )}
      {item(
        FolderOpen,
        "打开模组目录",
        () => action(() => api.openModFolder(mod.id)),
        !mod.available || !api.openModFolder,
      )}
      {item(
        ExternalLink,
        mod.source === "pdx" ? "打开模组来源页" : "打开工坊页面",
        () => action(() => api.openModPage(mod.id)),
        !remote || !api.openModPage,
      )}
      {item(
        RefreshCw,
        "更新模组",
        () => action(() => api.updateMod(mod.id), "模组更新请求已提交"),
        running || !remote || !api.updateMod,
      )}
      {item(
        GitBranch,
        "创建二改项目",
        () => {
          onCreateProject(mod);
          onClose();
        },
        running ||
          !mod.available ||
          Boolean(mod.projectId) ||
          /^local:ironclad_project_/.test(mod.id) ||
          !api.createModProject ||
          !onCreateProject,
      )}
      <div role="separator" />
      {item(
        ListMinus,
        "移出当前播放集",
        () => {
          onRemoveMember(mod.id);
          onClose();
        },
        !member || !onRemoveMember,
      )}
      {item(
        Trash2,
        "删除模组",
        () => setDialog("delete"),
        running || !deletable || !api.deleteMod,
        true,
      )}
    </div>
  );
}
