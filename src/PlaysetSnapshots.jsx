import React, { useEffect, useState } from "react";
import { Archive, FolderOpen, RefreshCw, ShieldCheck } from "lucide-react";
import { useI18n } from "./i18n.jsx";
import "./snapshots.css";

const phaseLabels = {
  checking: "正在检查来源",
  copying: "正在保存 Mod 文件",
  verifying: "正在校验快照",
  restoring: "正在创建独立本地版本",
  committing: "正在保存播放集",
  idle: "已完成",
};
export function SnapshotProgress({ api, active }) {
  const { t } = useI18n();
  const [value, setValue] = useState(null);
  useEffect(() => {
    if (!active || !api.getPlaysetSnapshotProgress) return;
    let alive = true;
    const refresh = () =>
      api
        .getPlaysetSnapshotProgress()
        .then((v) => {
          if (alive) setValue(v);
        })
        .catch(() => {});
    refresh();
    const timer = setInterval(refresh, 500);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [api, active]);
  if (!active) return null;
  return (
    <div className="campaign-progress" role="status">
      <span>
        {t(phaseLabels[value?.phase] || "正在处理组合快照…")}
        {value?.progress &&
          ` ${value.progress.index} / ${value.progress.total}`}
      </span>
      {value?.canCancel && (
        <button
          className="text-button"
          onClick={() => api.cancelPlaysetSnapshot()}
        >
          {t("取消")}
        </button>
      )}
    </div>
  );
}
export default function PlaysetSnapshots({
  api,
  state,
  active,
  busy,
  perform,
  onState,
  Dialog,
}) {
  const { t, locale, message } = useI18n();
  const [open, setOpen] = useState(false),
    [data, setData] = useState(null),
    [error, setError] = useState("");
  const [name, setName] = useState(""),
    [selectedId, setSelectedId] = useState(""),
    [restore, setRestore] = useState(false),
    [verified, setVerified] = useState("");
  const selected =
    data?.snapshots.find((s) => s.id === selectedId) || data?.snapshots[0];
  async function refresh() {
    try {
      setData(await api.getPlaysetSnapshots());
      setError("");
    } catch (e) {
      setError(e.message);
    }
  }
  useEffect(() => {
    if (open) {
      refresh();
      setName(active.name);
    }
  }, [open, state.settings.activeGameInstanceId]);
  async function action(kind, task) {
    return perform("snapshot-" + kind, async () => {
      const result = await task();
      await refresh();
      return result;
    });
  }
  const running = busy || state.launchStatus?.running;
  return (
    <>
      <button
        className="button subtle"
        disabled={busy}
        onClick={() => setOpen(true)}
      >
        <Archive size={15} />
        {t("组合快照")}
      </button>
      {open && (
        <Dialog
          title={t(restore ? "恢复组合快照" : "组合快照")}
          onClose={() => {
            if (!busy) {
              setOpen(false);
              setRestore(false);
            }
          }}
        >
          <div className="snapshot-manager">
            {restore && selected ? (
              <>
                <h3>{selected.name}</h3>
                <p>
                  {t(
                    "将校验保存的 Mod 文件，并创建独立本地项目与新播放集。现有模组和播放集会保留。",
                  )}
                </p>
                <p className="inline-note">
                  {t(
                    "快照只包含启用的 Mod 与配置，不包含游戏本体或存档。恢复后可能需要更多磁盘空间。",
                  )}
                </p>
                {selected.environment.game.version !== state.game.version && (
                  <p className="inline-note" role="alert">
                    {t(
                      "当前游戏版本与快照记录不同，请切换到对应版本后恢复以保持游戏环境一致。",
                    )}
                  </p>
                )}
                <div className="snapshot-mods">
                  {selected.environment.mods.map((m) => (
                    <div key={m.id}>
                      <strong>{m.name}</strong>
                      <small>
                        {m.source} · {m.version || m.revision || "—"}
                      </small>
                    </div>
                  ))}
                </div>
                <div className="campaign-actions">
                  <button
                    className="button subtle"
                    disabled={busy}
                    onClick={() => setRestore(false)}
                  >
                    {t("返回")}
                  </button>
                  <button
                    className="button primary"
                    disabled={running}
                    onClick={() =>
                      action("restore", async () => {
                        const result = await api.restorePlaysetSnapshot(
                          selected.id,
                        );
                        onState(result.state);
                        setRestore(false);
                        return result;
                      })
                    }
                  >
                    {t("恢复为独立播放集")}
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="section-description">
                  {t(
                    "保存当前启用 Mod 的实际文件、加载顺序、DLC 与游戏设置，供以后恢复。",
                  )}
                </p>
                <div className="snapshot-create">
                  <label className="campaign-field">
                    <span>{t("快照名称")}</span>
                    <input
                      aria-label={t("快照名称")}
                      value={name}
                      maxLength={128}
                      onChange={(e) => setName(e.target.value)}
                    />
                  </label>
                  <button
                    className="button primary"
                    disabled={running || !name.trim()}
                    onClick={() =>
                      action("create", async () => {
                        const result = await api.createPlaysetSnapshot({
                          name,
                        });
                        setSelectedId(result.id);
                        setVerified("");
                        return result;
                      })
                    }
                  >
                    {t("保存当前组合")}
                  </button>
                </div>
                <p className="performance-hint">
                  {t(
                    "保存时只读取源文件。Steam 以后更新原模组，也不会覆盖已保存的快照。",
                  )}
                </p>
                {error && (
                  <p className="inline-note" role="alert">
                    {message(error)}
                  </p>
                )}
                {data?.notices.map((v, i) => (
                  <p className="inline-note" key={i}>
                    {message(v)}
                  </p>
                ))}
                {data && !data.snapshots.length && (
                  <p className="snapshot-empty">
                    {t("当前版本还没有组合快照。")}
                  </p>
                )}
                {!!data?.snapshots.length && (
                  <>
                    <div className="snapshot-toolbar">
                      <label>
                        <span>{t("选择组合快照")}</span>
                        <select
                          aria-label={t("选择组合快照")}
                          value={selected?.id || ""}
                          disabled={busy}
                          onChange={(e) => {
                            setSelectedId(e.target.value);
                            setVerified("");
                          }}
                        >
                          {data.snapshots.map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.name} ·{" "}
                              {new Date(s.createdAt).toLocaleString(locale)}
                            </option>
                          ))}
                        </select>
                      </label>
                      <button
                        className="icon-button"
                        aria-label={t("刷新快照列表")}
                        disabled={busy}
                        onClick={refresh}
                      >
                        <RefreshCw size={16} />
                      </button>
                    </div>
                    {selected && (
                      <section className="snapshot-detail">
                        <h3>{selected.name}</h3>
                        <p>
                          {selected.environment.game.version || "—"} ·{" "}
                          {t("{0} 个已启用模组", { 0: selected.modCount })} ·{" "}
                          {(selected.totalBytes / 1024 ** 3).toFixed(2)} GiB
                        </p>
                        <div className="snapshot-mods">
                          {selected.environment.mods.map((m) => (
                            <div key={m.id}>
                              <strong>{m.name}</strong>
                              <small>
                                {m.source} · {m.version || m.revision || "—"}
                              </small>
                            </div>
                          ))}
                        </div>
                        <div className="campaign-actions">
                          <button
                            className="button subtle"
                            disabled={running}
                            onClick={() => {
                              setVerified("");
                              action("verify", async () => {
                                const result = await api.verifyPlaysetSnapshot(
                                  selected.id,
                                );
                                setVerified(selected.id);
                                return result;
                              });
                            }}
                          >
                            <ShieldCheck size={15} />
                            {t("校验保存文件")}
                          </button>
                          <button
                            className="button primary"
                            disabled={running}
                            onClick={() => setRestore(true)}
                          >
                            {t("恢复此组合")}
                          </button>
                          <button
                            className="button subtle"
                            disabled={busy}
                            onClick={() =>
                              action("folder", () =>
                                api.openPlaysetSnapshotFolder(selected.id),
                              )
                            }
                          >
                            <FolderOpen size={15} />
                            {t("打开快照目录")}
                          </button>
                        </div>
                        {verified === selected.id && (
                          <p className="inline-note" role="status">
                            {t("保存文件的摘要校验通过。")}
                          </p>
                        )}
                      </section>
                    )}
                  </>
                )}
                {!!data?.retainedDirectories?.length && (
                  <details>
                    <summary>{t("未完成的快照目录已保留")}</summary>
                    {data.retainedDirectories.map((item) => (
                      <div className="snapshot-retained" key={item.id}>
                        <span>{item.path}</span>
                        <button
                          className="text-button"
                          disabled={busy}
                          onClick={() =>
                            action("folder", () =>
                              api.openPlaysetSnapshotFolder(item.id),
                            )
                          }
                        >
                          {t("打开目录")}
                        </button>
                      </div>
                    ))}
                  </details>
                )}
              </>
            )}
          </div>
        </Dialog>
      )}
    </>
  );
}
