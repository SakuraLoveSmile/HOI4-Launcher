import { useI18n, T } from "./i18n.jsx";
import React, { useState } from "react";
import { ArrowRight } from "lucide-react";
export default function LocalModEditor({
  request,
  state,
  api,
  perform,
  onState,
  onClose,
  busy,
  Dialog,
}) {
  const { t, message, locale } = useI18n();
  const editing = request.kind === "edit";
  const metadata = request.metadata || {};
  const [name, setName] = useState(metadata.name || "");
  const [folder, setFolder] = useState(metadata.folder || "");
  const [version, setVersion] = useState(metadata.version || "1.0.0");
  const [supported, setSupported] = useState(
    metadata.supportedVersion ||
      (state.game.version
        ? state.game.version.split(".").slice(0, 2).join(".") + ".*"
        : "1.*"),
  );
  const [tags, setTags] = useState((metadata.tags || []).join(", "));
  const [description, setDescription] = useState(metadata.description || "");
  async function submit(event) {
    event.preventDefault();
    await perform(
      "mod-authoring",
      async () => {
        const input = {
          name,
          folder,
          version,
          supportedVersion: supported,
          tags: tags
            .split(/[,，]/)
            .map((tag) => tag.trim())
            .filter(Boolean),
          description,
        };
        const result = editing
          ? await api.updateLocalModMetadata(request.id, input)
          : await api.createLocalMod(input);
        onState(result.state);
        onClose();
        return result;
      },
      editing
        ? "模组资料已更新，原描述文件已备份"
        : "本地模组已创建，可在模组库中启用",
    );
  }
  return (
    <Dialog
      title={editing ? t("编辑本地模组资料") : t("创建本地模组")}
      onClose={() => !busy && onClose()}
    >
      <form onSubmit={submit}>
        <p className="modal-description">
          {editing
            ? t("修改名称、版本和标签。原有路径、发布标识和其他描述项会保留。")
            : t("在游戏用户目录中创建模组文件夹和描述文件，之后即可加入预设。")}
        </p>
        <div className="authoring-fields">
          <label>
            <T id={"模组名称"} />
            <input
              aria-label={t("模组名称")}
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={120}
              disabled={busy}
            />
          </label>
          <label>
            <T id={"文件夹名称"} />
            <input
              aria-label={t("模组文件夹名称")}
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
              required
              maxLength={80}
              disabled={busy || editing}
              placeholder={t("例如 my_first_mod")}
            />
          </label>
          <div className="authoring-columns">
            <label>
              <T id={"模组版本"} />
              <input
                aria-label={t("模组版本")}
                value={version}
                onChange={(e) => setVersion(e.target.value)}
                required
                maxLength={60}
                disabled={busy}
              />
            </label>
            <label>
              <T id={"支持的游戏版本"} />
              <input
                aria-label={t("支持的游戏版本")}
                value={supported}
                onChange={(e) => setSupported(e.target.value)}
                required
                maxLength={40}
                disabled={busy}
              />
            </label>
          </div>
          <label>
            <T id={"标签"} />
            <input
              aria-label={t("模组标签")}
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              maxLength={2500}
              disabled={busy}
              placeholder={t("以逗号分隔，例如 Alternative History, Gameplay")}
            />
          </label>
          <label>
            <T id={"描述"} />
            <textarea
              aria-label={t("模组描述")}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={10000}
              disabled={busy}
              rows={4}
            />
          </label>
        </div>
        <div className="modal-actions">
          <button
            type="button"
            className="button subtle"
            disabled={busy}
            onClick={onClose}
          >
            <T id={"取消"} />
          </button>
          <button
            type="submit"
            className="button primary"
            disabled={busy || !name.trim() || !folder.trim()}
          >
            {editing ? t("保存资料") : t("创建模组")}
            <ArrowRight size={16} />
          </button>
        </div>
      </form>
    </Dialog>
  );
}
