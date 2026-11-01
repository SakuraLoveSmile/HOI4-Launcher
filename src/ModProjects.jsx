import React, { useEffect, useState } from "react";
import {
  FolderOpen,
  GitBranch,
  Plus,
  RefreshCw,
  Download,
  Save,
  History,
  ArrowRight,
} from "lucide-react";
import { useI18n } from "./i18n.jsx";
import "./projects.css";

const labels = {
  unchanged: "未改变",
  "local-only": "我的修改",
  "upstream-only": "上游修改",
  same: "双方结果相同",
  conflict: "需要处理",
  merged: "可自动合并",
  added: "新增",
  deleted: "删除",
  modified: "修改",
  auto: "自动合并",
  upstream: "采纳上游",
  local: "保留我的版本",
  defer: "暂缓处理",
  manual: "手动结果",
  queued: "等待处理",
  checking: "检查上游",
  "waiting-steam": "等待 Steam 下载",
  downloading: "正在下载",
  capturing: "正在保存快照",
  succeeded: "候选版本已保存",
  failed: "获取失败",
  cancelled: "已取消",
};
const activeJob = (job) =>
  ["queued", "checking", "waiting-steam", "downloading", "capturing"].includes(
    job?.status,
  );
const groups = [
  ["focus", "国策", /^common\/national_focus\//i],
  ["events", "事件", /^events\//i],
  ["localisation", "本地化", /^locali[sz]ation\//i],
  ["decisions", "决议", /^common\/decisions\//i],
  ["history", "历史与国家", /^history\//i],
  ["graphics", "图形与界面", /^(gfx|interface)\//i],
  ["map", "地图", /^map\//i],
  ["audio", "音频", /^(sound|music)\//i],
  ["scripts", "其他脚本", /^common\//i],
  ["metadata", "模组资料", /^descriptor\.mod$/i],
  ["other", "其他文件", /./],
];

export default function ModProjects({
  api,
  state,
  onState,
  perform,
  busy,
  Dialog,
  creationRequest,
  onCreationRequestHandled,
}) {
  const { t, message, locale } = useI18n();
  const [projects, setProjects] = useState([]);
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [tab, setTab] = useState("overview");
  const [loadError, setLoadError] = useState("");
  const [creating, setCreating] = useState(false);
  const [kind, setKind] = useState("installed");
  const [source, setSource] = useState("");
  const [name, setName] = useState("");
  const [known, setKnown] = useState(false);
  const [checkpointName, setCheckpointName] = useState("");
  const [linkSource, setLinkSource] = useState("");
  const [authorization, setAuthorization] = useState("anonymous");
  const [update, setUpdate] = useState(null);
  const [job, setJob] = useState(null);
  const [plan, setPlan] = useState(null);
  const [choices, setChoices] = useState({});
  const [file, setFile] = useState(null);
  const [manual, setManual] = useState("");
  const [chunkChoices, setChunkChoices] = useState({});
  const [confirm, setConfirm] = useState(null);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [group, setGroup] = useState("all");
  const project = detail?.project;
  const currentJob = job?.projectId === selected ? job : null;
  const locked = busy || activeJob(job);
  const sources = state.mods.filter((mod) => mod.available && !mod.projectId);
  const upstreamSources = sources.filter((mod) =>
    ["workshop", "pdx"].includes(mod.source),
  );
  const time = (value) =>
    value ? new Date(value).toLocaleString(locale) : "—";

  useEffect(() => {
    if (!creationRequest) return;
    setKind("installed");
    setSource(creationRequest.modId);
    setName(creationRequest.name.slice(0, 120));
    setKnown(false);
    setCreating(true);
    onCreationRequestHandled?.();
  }, [creationRequest, onCreationRequestHandled]);

  async function reload(id = selected) {
    const result = await api.getModProjects();
    setProjects(result.projects);
    if (id) setDetail(await api.inspectModProject(id));
    onState(await api.getState());
    return result;
  }
  async function action(task, { refresh = true, reset = false } = {}) {
    return perform("mod-project", async () => {
      const result = await task();
      if (result !== null && refresh) await reload();
      if (reset && result !== null) {
        setPlan(null);
        setFile(null);
      }
      return result;
    });
  }
  useEffect(() => {
    let alive = true;
    if (!api.getModProjects) {
      setLoadError("请在桌面版中管理本地项目。");
      return;
    }
    api
      .getModProjects()
      .then((result) => {
        if (alive) {
          setProjects(result.projects);
          setSelected(result.projects[0]?.id || null);
        }
      })
      .catch((error) => alive && setLoadError(error.message));
    return () => {
      alive = false;
    };
  }, [api]);
  useEffect(() => {
    let alive = true;
    setDetail(null);
    setPlan(null);
    setFile(null);
    setUpdate(null);
    setQuery("");
    setPage(0);
    setLoadError("");
    if (selected)
      api
        .inspectModProject(selected)
        .then((result) => {
          if (alive) setDetail(result);
        })
        .catch((error) => alive && setLoadError(error.message));
    return () => {
      alive = false;
    };
  }, [api, selected]);
  useEffect(() => {
    if (!api.getModProjectUpstream) return;
    let alive = true,
      reading = false,
      lastCompleted = "";
    async function poll() {
      if (reading) return;
      reading = true;
      try {
        const value = await api.getModProjectUpstream();
        if (!alive) return;
        setJob(value.job);
        if (
          value.job?.status === "succeeded" &&
          lastCompleted !== value.job.id
        ) {
          lastCompleted = value.job.id;
          const next = await api.getModProjects();
          if (alive) setProjects(next.projects);
          if (selected === value.job.projectId) {
            const inspected = await api.inspectModProject(selected);
            if (alive) {
              setDetail(inspected);
              setPlan(null);
            }
          }
        }
      } catch (error) {
        if (alive) setLoadError(error.message);
      } finally {
        reading = false;
      }
    }
    poll();
    const timer = setInterval(poll, 1500);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [api, selected]);

  async function create(event) {
    event.preventDefault();
    await action(
      async () => {
        const result =
          kind === "installed"
            ? await api.createModProject({
                modId: source,
                name,
                baselineKnown: known,
              })
            : await api.importModProject({ kind, name, baselineKnown: known });
        if (!result) return null;
        setProjects((await api.getModProjects()).projects);
        setSelected(result.id);
        setCreating(false);
        setTab("overview");
        onState(await api.getState());
        return result;
      },
      { refresh: false },
    );
  }
  async function prepare() {
    await action(
      async () => {
        const result = await api.prepareModProjectMerge(selected);
        setPlan(result);
        setFile(null);
        setPage(0);
        setChoices(
          Object.fromEntries(
            result.entries
              .filter((entry) => entry.upstreamChanged)
              .map((entry) => [
                entry.path,
                { path: entry.path, choice: entry.suggested || "defer" },
              ]),
          ),
        );
        return result;
      },
      { refresh: false },
    );
  }
  const entries = (plan?.entries || []).filter(
    (entry) =>
      entry.upstreamChanged &&
      (group === "all" ||
        groups.find(([, , pattern]) => pattern.test(entry.path))?.[0] ===
          group) &&
      entry.path
        .toLocaleLowerCase(locale)
        .includes(query.trim().toLocaleLowerCase(locale)),
  );
  const date = (snapshot) =>
    `${
      snapshot.kind === "checkpoint"
        ? snapshot.name
        : t(
            {
              base: "初始基准",
              "before-merge": "合并前检查点",
              "before-restore": "恢复前检查点",
            }[snapshot.kind] || snapshot.kind,
          )
    } · ${time(snapshot.createdAt)}`;

  return (
    <section className="projects-workspace">
      <div className="section-heading">
        <div>
          <h2>
            <GitBranch size={20} /> {t("本地项目")}
          </h2>
          <p className="section-description">
            {t("保留自己的改动，选择吸收作者更新。")}
          </p>
        </div>
        <div className="button-row">
          <button
            className="button subtle"
            disabled={locked}
            onClick={() => action(() => reload(), { refresh: false })}
          >
            <RefreshCw size={15} />
            {t("刷新")}
          </button>
          <button
            className="button primary"
            disabled={locked || !api.createModProject}
            onClick={() => {
              setSource(sources[0]?.id || "");
              setName("");
              setKnown(false);
              setKind("installed");
              setCreating(true);
            }}
          >
            <Plus size={16} />
            {t("创建二改项目")}
          </button>
        </div>
      </div>
      {loadError && (
        <p role="alert" className="project-notice warning">
          {message(loadError)}
        </p>
      )}
      <div className="project-layout">
        <aside className="panel project-list" aria-label={t("本地项目列表")}>
          {projects.length ? (
            projects.map((item) => (
              <button
                key={item.id}
                className={`project-item ${selected === item.id ? "selected" : ""}`}
                onClick={() => {
                  setSelected(item.id);
                  setTab("overview");
                }}
                disabled={busy}
              >
                <GitBranch size={17} />
                <span>
                  {item.name}
                  <small>
                    {item.upstreamRef
                      ? `${item.upstreamRef.provider === "workshop" ? "Steam" : "Paradox"} · ${item.upstreamRef.remoteId}`
                      : t("纯本地项目")}
                  </small>
                </span>
                <ArrowRight size={14} />
              </button>
            ))
          ) : (
            <div className="empty-state compact">
              <GitBranch size={26} />
              <h3>{t("开始维护自己的版本")}</h3>
              <p>{t("从已安装模组创建独立副本，或导入本地文件夹和 ZIP。")}</p>
            </div>
          )}
        </aside>
        <div className="panel project-detail">
          {!project ? (
            <div className="empty-state compact">
              <p>
                {selected ? t("正在读取项目") : t("选择或创建一个本地项目")}
              </p>
            </div>
          ) : (
            <>
              <div className="section-heading">
                <h2>{project.name}</h2>
                <span className="tag">
                  {project.baselineKnown ? t("已保存基线") : t("基线未知")}
                </span>
              </div>
              <nav className="project-tabs" aria-label={t("项目页面")}>
                {[
                  ["overview", "概览"],
                  ["changes", "我的改动"],
                  ["upstream", "上游更新"],
                  ["history", "历史版本"],
                ].map(([id, label]) => (
                  <button
                    className={tab === id ? "active" : ""}
                    key={id}
                    onClick={() => setTab(id)}
                  >
                    {t(label)}
                  </button>
                ))}
              </nav>
              {tab === "overview" && (
                <div className="project-section">
                  <p className="section-description">
                    {t("工作区独立保存，原版更新不会覆盖这里的内容。")}
                  </p>
                  <div className="path-box">
                    <FolderOpen size={17} />
                    <span>{project.workPath}</span>
                  </div>
                  <div className="button-row">
                    <button
                      className="button subtle"
                      onClick={() =>
                        action(() => api.openModProject(selected), {
                          refresh: false,
                        })
                      }
                    >
                      <FolderOpen size={15} />
                      {t("打开工作区")}
                    </button>
                    <button
                      className="button primary"
                      disabled={locked}
                      onClick={() =>
                        action(async () => {
                          onState(await api.pinModProject(selected, null));
                          return true;
                        })
                      }
                    >
                      {t("在当前播放集中使用工作区")}
                    </button>
                  </div>
                  <p className="section-description">
                    {t("使用完整二改版时，会停用当前播放集中的对应原版。")}
                  </p>
                  {!project.baselineKnown && (
                    <p className="project-notice warning">
                      {t(
                        "无法确认修改前的原版。可以继续编辑和保存，但不会自动推断双方改动。",
                      )}
                    </p>
                  )}
                  <label>
                    {t("关联上游来源")}
                    <select
                      aria-label={t("关联上游来源")}
                      value={linkSource}
                      onChange={(e) => setLinkSource(e.target.value)}
                      disabled={locked}
                    >
                      <option value="">{t("选择已安装的来源模组")}</option>
                      {upstreamSources.map((mod) => (
                        <option value={mod.id} key={mod.id}>
                          {mod.name} · {mod.source}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    className="button subtle"
                    disabled={locked || !linkSource}
                    onClick={() =>
                      setConfirm({
                        title: "关联上游来源",
                        body: "变更来源会影响后续比较基线，请确认选择的是这个项目的原始来源。",
                        run: () => api.linkModProject(selected, linkSource),
                      })
                    }
                  >
                    {t("保存来源关联")}
                  </button>
                </div>
              )}
              {tab === "changes" && (
                <div className="project-section">
                  <p>{t("相对于项目合并基线的变化")}</p>
                  <div className="project-scroll">
                    <table className="project-table">
                      <thead>
                        <tr>
                          <th>{t("文件")}</th>
                          <th>{t("状态")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(detail.changes || []).slice(0, 300).map((entry) => (
                          <tr key={entry.path}>
                            <td>{entry.path}</td>
                            <td>{t(labels[entry.status] || entry.status)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {(detail.changes || []).length > 300 && (
                    <p>{t("仅显示前 300 项，请在工作区查看完整内容。")}</p>
                  )}
                  <p className="project-notice">
                    {t(
                      "以下为 HOI4 静态提示，仍需在游戏中验证玩法和存档兼容性。",
                    )}
                  </p>
                  {(detail.checks?.issues || []).map((issue, index) => (
                    <div className="project-issue" key={index}>
                      <strong>{issue.path}</strong>
                      <span>{message(issue.message)}</span>
                      {issue.relatedPaths?.length > 0 && (
                        <small>{issue.relatedPaths.join(" · ")}</small>
                      )}
                    </div>
                  ))}
                  {!detail.checks?.issues?.length && (
                    <p className="section-description">
                      {t("未发现已覆盖规则中的静态问题。")}
                    </p>
                  )}
                </div>
              )}
              {tab === "upstream" && (
                <div className="project-section">
                  <p className="section-description">
                    {t(
                      "先获取候选版本，再审阅合并；下载不会切换当前二改内容。",
                    )}
                  </p>
                  <div className="button-row">
                    {project.upstreamRef?.provider === "pdx" && (
                      <select
                        aria-label={t("下载身份")}
                        value={authorization}
                        onChange={(e) => setAuthorization(e.target.value)}
                        disabled={locked}
                      >
                        <option value="anonymous">{t("匿名下载")}</option>
                        <option value="account">
                          {t("使用当前 Paradox 账号")}
                        </option>
                      </select>
                    )}
                    <button
                      className="button subtle"
                      disabled={locked || !project.upstreamRef}
                      onClick={() =>
                        action(
                          async () => {
                            setUpdate(
                              await api.checkModProjectUpstream(
                                selected,
                                authorization,
                              ),
                            );
                            return true;
                          },
                          { refresh: false },
                        )
                      }
                    >
                      <RefreshCw size={15} />
                      {t("检查上游")}
                    </button>
                    <button
                      className="button primary"
                      disabled={locked || !project.upstreamRef}
                      onClick={() =>
                        action(
                          async () => {
                            setJob(
                              await api.fetchModProjectUpstream(selected, {
                                authorization,
                              }),
                            );
                            return true;
                          },
                          { refresh: false },
                        )
                      }
                    >
                      <Download size={15} />
                      {t("获取上游候选")}
                    </button>
                    <button
                      className="button subtle"
                      disabled={locked}
                      onClick={() =>
                        action(() => api.importModProjectCandidate(selected), {
                          reset: true,
                        })
                      }
                    >
                      {t("从 ZIP 导入候选")}
                    </button>
                  </div>
                  {project.upstreamRef?.provider === "workshop" && (
                    <p className="section-description">
                      {t(
                        "请先在 Steam 工坊页面连接客户端。停止获取不会撤销 Steam 已接受的下载。",
                      )}
                    </p>
                  )}
                  {update && (
                    <p className="project-notice">
                      {update.changed
                        ? t("上游有变化，可获取候选进行内容比较。")
                        : t("上游版本信息未变化，仍可重新获取并核对内容。")}
                      {update.revision && ` · ${update.revision}`}
                    </p>
                  )}
                  {currentJob && (
                    <div className="project-notice" role="status">
                      <span>
                        {t(labels[currentJob.status] || currentJob.status)}
                      </span>
                      {currentJob.progress?.receivedBytes != null && (
                        <span>
                          {" "}
                          ·{" "}
                          {(
                            currentJob.progress.receivedBytes / 1048576
                          ).toFixed(1)}{" "}
                          MiB
                        </span>
                      )}
                      {currentJob.error && <p>{message(currentJob.error)}</p>}
                      {currentJob.retainedDownloadDirectory && (
                        <p>
                          {t("下载文件发生变化，已保留供检查：")}
                          <br />
                          {currentJob.retainedDownloadDirectory}
                        </p>
                      )}
                      {activeJob(currentJob) && (
                        <button
                          className="button subtle"
                          onClick={() =>
                            action(() => api.cancelModProjectUpstream(), {
                              refresh: false,
                            })
                          }
                        >
                          {t("停止获取")}
                        </button>
                      )}
                    </div>
                  )}
                  <button
                    className="button subtle"
                    disabled={locked || !project.candidateSnapshotId}
                    onClick={prepare}
                  >
                    {t("比较并准备合并")}
                  </button>
                  {plan && (
                    <>
                      <p className="project-notice">
                        {t(
                          "采纳或保留会记录为已处理；暂缓的文件会在后续更新中继续提醒。",
                        )}
                      </p>
                      <input
                        aria-label={t("筛选更新文件")}
                        placeholder={t("筛选更新文件")}
                        value={query}
                        onChange={(e) => {
                          setQuery(e.target.value);
                          setPage(0);
                        }}
                      />
                      <select
                        aria-label={t("内容分类")}
                        value={group}
                        onChange={(e) => {
                          setGroup(e.target.value);
                          setPage(0);
                        }}
                      >
                        <option value="all">{t("全部内容")}</option>
                        {groups.map(([id, label]) => (
                          <option key={id} value={id}>
                            {t(label)}
                          </option>
                        ))}
                      </select>
                      <div className="project-scroll">
                        <table className="project-table">
                          <thead>
                            <tr>
                              <th>{t("文件")}</th>
                              <th>{t("状态")}</th>
                              <th>{t("处理方式")}</th>
                            </tr>
                          </thead>
                          <tbody>
                            {entries
                              .slice(page * 50, page * 50 + 50)
                              .map((entry) => (
                                <tr key={entry.path}>
                                  <td>
                                    <button
                                      className="project-file-button"
                                      disabled={busy}
                                      onClick={() =>
                                        action(
                                          async () => {
                                            const result =
                                              await api.readModProjectMergeFile(
                                                selected,
                                                plan.id,
                                                entry.path,
                                              );
                                            setFile(result);
                                            setManual(
                                              choices[entry.path]?.text ??
                                                result.mergedText ??
                                                result.localText ??
                                                "",
                                            );
                                            setChunkChoices(
                                              Object.fromEntries(
                                                (result.chunks || []).map(
                                                  (chunk) => [
                                                    chunk.id,
                                                    chunk.conflict
                                                      ? "local"
                                                      : "auto",
                                                  ],
                                                ),
                                              ),
                                            );
                                            return result;
                                          },
                                          { refresh: false },
                                        )
                                      }
                                    >
                                      {entry.path}
                                    </button>
                                  </td>
                                  <td>
                                    {t(labels[entry.status] || entry.status)}
                                  </td>
                                  <td>
                                    <select
                                      aria-label={`${t("处理方式")} ${entry.path}`}
                                      value={
                                        choices[entry.path]?.choice || "defer"
                                      }
                                      disabled={locked}
                                      onChange={(e) =>
                                        setChoices((old) => ({
                                          ...old,
                                          [entry.path]: {
                                            path: entry.path,
                                            choice: e.target.value,
                                          },
                                        }))
                                      }
                                    >
                                      {[
                                        "auto",
                                        "upstream",
                                        "local",
                                        "defer",
                                        ...(choices[entry.path]?.choice ===
                                        "manual"
                                          ? ["manual"]
                                          : []),
                                      ].map((choice) => (
                                        <option key={choice} value={choice}>
                                          {t(labels[choice])}
                                        </option>
                                      ))}
                                    </select>
                                  </td>
                                </tr>
                              ))}
                          </tbody>
                        </table>
                      </div>
                      <div className="button-row">
                        <button
                          className="button subtle"
                          disabled={page === 0}
                          onClick={() => setPage(page - 1)}
                        >
                          {t("上一页")}
                        </button>
                        <span>
                          {page + 1} /{" "}
                          {Math.max(1, Math.ceil(entries.length / 50))}
                        </span>
                        <button
                          className="button subtle"
                          disabled={(page + 1) * 50 >= entries.length}
                          onClick={() => setPage(page + 1)}
                        >
                          {t("下一页")}
                        </button>
                      </div>
                      <button
                        className="button primary"
                        disabled={
                          locked ||
                          (!Object.keys(choices).length &&
                            project.baselineKnown)
                        }
                        onClick={() =>
                          action(
                            async () => {
                              const preview = await api.previewModProjectMerge(
                                selected,
                                plan.id,
                                Object.values(choices),
                              );
                              setConfirm({
                                preview,
                                title: "应用所选合并",
                                body: "将根据当前逐文件选择更新工作区，并保存可恢复的合并前版本。外部编辑发生变化时需重新比较。",
                                run: () =>
                                  api.applyModProjectMerge(
                                    selected,
                                    plan.id,
                                    Object.values(choices),
                                  ),
                                reset: true,
                              });
                              return preview;
                            },
                            { refresh: false },
                          )
                        }
                      >
                        {t("预览合并结果")}
                      </button>
                    </>
                  )}
                </div>
              )}
              {tab === "history" && (
                <div className="project-section">
                  <form
                    className="button-row"
                    onSubmit={(event) => {
                      event.preventDefault();
                      action(async () => {
                        const result = await api.checkpointModProject(
                          selected,
                          checkpointName,
                        );
                        setCheckpointName("");
                        return result;
                      });
                    }}
                  >
                    <input
                      aria-label={t("版本名称")}
                      placeholder={t("版本名称")}
                      value={checkpointName}
                      maxLength={120}
                      onChange={(e) => setCheckpointName(e.target.value)}
                    />
                    <button
                      className="button primary"
                      disabled={locked || !checkpointName.trim()}
                    >
                      <Save size={15} />
                      {t("保存检查点")}
                    </button>
                  </form>
                  <p className="section-description">
                    {t(
                      "固定版本供当前播放集使用，工作区仍可继续编辑。恢复会同时还原对应的合并基线。",
                    )}
                  </p>
                  <div className="project-history">
                    {(project.snapshots || [])
                      .filter((s) =>
                        [
                          "base",
                          "checkpoint",
                          "before-merge",
                          "before-restore",
                        ].includes(s.kind),
                      )
                      .map((snapshot) => (
                        <div key={snapshot.id}>
                          <History size={16} />
                          <span>{date(snapshot)}</span>
                          <div className="button-row">
                            <button
                              className="button subtle"
                              disabled={locked}
                              onClick={() =>
                                action(async () => {
                                  onState(
                                    await api.pinModProject(
                                      selected,
                                      snapshot.id,
                                    ),
                                  );
                                  return true;
                                })
                              }
                            >
                              {t("固定到当前播放集")}
                            </button>
                            <button
                              className="button subtle"
                              disabled={locked}
                              onClick={() =>
                                setConfirm({
                                  title: "恢复项目版本",
                                  body: "当前工作区会先保存检查点，再恢复所选内容和基线。",
                                  run: () =>
                                    api.restoreModProject(
                                      selected,
                                      snapshot.id,
                                    ),
                                  reset: true,
                                })
                              }
                            >
                              {t("恢复")}
                            </button>
                          </div>
                        </div>
                      ))}
                  </div>
                  <button
                    className="button subtle"
                    disabled={locked}
                    onClick={() =>
                      action(() => api.exportModProject(selected), {
                        refresh: false,
                      })
                    }
                  >
                    {t("备份本地项目")}
                  </button>
                  <p className="section-description">
                    {t(
                      "项目备份包含工作区、基线和历史；官方播放集 JSON 仍不包含本地项目。",
                    )}
                  </p>
                </div>
              )}
            </>
          )}
        </div>
      </div>
      {creating && (
        <Dialog
          title={t("创建二改项目")}
          onClose={() => !busy && setCreating(false)}
        >
          <form onSubmit={create} className="project-section">
            <label>
              {t("导入来源")}
              <select
                aria-label={t("导入来源")}
                value={kind}
                onChange={(e) => setKind(e.target.value)}
                disabled={busy}
              >
                {[
                  ["installed", "已安装模组"],
                  ["folder", "本地文件夹"],
                  ["zip", "模组 ZIP"],
                  ["backup", "项目备份"],
                ].map(([id, label]) => (
                  <option key={id} value={id}>
                    {t(label)}
                  </option>
                ))}
              </select>
            </label>
            {kind === "installed" && (
              <label>
                {t("来源模组")}
                <select
                  aria-label={t("来源模组")}
                  value={source}
                  disabled={busy}
                  onChange={(e) => setSource(e.target.value)}
                >
                  <option value="">{t("选择已安装的来源模组")}</option>
                  {sources.map((mod) => (
                    <option key={mod.id} value={mod.id}>
                      {mod.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {kind !== "backup" && (
              <>
                <label>
                  {t("项目名称")}
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    maxLength={120}
                    required
                    disabled={busy}
                  />
                </label>
                <label className="project-checkbox">
                  <input
                    type="checkbox"
                    checked={known}
                    onChange={(e) => setKnown(e.target.checked)}
                    disabled={busy}
                  />
                  {t("我确认这份来源尚未进行个人修改，可作为原版基线。")}
                </label>
                <p className="section-description">
                  {t(
                    "已经改过或无法确认时，请保留基线未知。工坊原始版本需连接 Steam 并等待下载完成。",
                  )}
                </p>
              </>
            )}
            <div className="modal-actions">
              <button
                type="button"
                className="button subtle"
                disabled={busy}
                onClick={() => setCreating(false)}
              >
                {t("取消")}
              </button>
              <button
                className="button primary"
                disabled={
                  busy ||
                  (kind !== "backup" && !name.trim()) ||
                  (kind === "installed" && !source)
                }
              >
                {t("创建独立项目")}
              </button>
            </div>
          </form>
        </Dialog>
      )}
      {file && (
        <Dialog title={file.path} onClose={() => setFile(null)}>
          <div className="project-section">
            {file.binary ? (
              <p>{t("二进制或不支持的文本编码，请选择完整文件版本。")}</p>
            ) : (
              <>
                <div className="project-diff">
                  {[
                    [
                      file.baselineKnown
                        ? "原版基线"
                        : "导入时的内容（基线未知）",
                      file.baseText,
                    ],
                    ["我的版本", file.localText],
                    ["上游版本", file.upstreamText],
                  ].map(([title, text]) => (
                    <section key={title}>
                      <h3>{t(title)}</h3>
                      <pre>{text ?? t("文件不存在")}</pre>
                    </section>
                  ))}
                </div>
                {file.chunks?.some((chunk) => chunk.changed) && (
                  <details className="project-chunks">
                    <summary>{t("逐片段选择")}</summary>
                    <p className="section-description">
                      {t(
                        "冲突片段默认保留我的内容。生成结果会替换下方编辑框，请先完成片段选择，再手动微调。",
                      )}
                    </p>
                    {file.chunks
                      .filter((chunk) => chunk.changed)
                      .map((chunk, index) => (
                        <section className="project-chunk" key={chunk.id}>
                          <label>
                            {t("片段")} {index + 1} ·{" "}
                            {t(chunk.conflict ? "需要处理" : "可自动合并")}
                            <select
                              aria-label={`${t("片段")} ${index + 1}`}
                              value={chunkChoices[chunk.id]}
                              onChange={(e) =>
                                setChunkChoices((old) => ({
                                  ...old,
                                  [chunk.id]: e.target.value,
                                }))
                              }
                            >
                              {(!chunk.conflict
                                ? ["auto", "local", "upstream"]
                                : ["local", "upstream"]
                              ).map((choice) => (
                                <option key={choice} value={choice}>
                                  {t(labels[choice])}
                                </option>
                              ))}
                            </select>
                          </label>
                          <div className="project-diff">
                            {[
                              ["原版基线", chunk.baseText],
                              ["我的版本", chunk.localText],
                              ["上游版本", chunk.upstreamText],
                            ].map(([title, text]) => (
                              <section key={title}>
                                <h3>{t(title)}</h3>
                                <pre>{text || t("空片段")}</pre>
                              </section>
                            ))}
                          </div>
                        </section>
                      ))}
                    <button
                      className="button subtle"
                      onClick={() =>
                        setManual(
                          file.chunks
                            .map((chunk) => {
                              const choice = chunkChoices[chunk.id];
                              return choice === "local"
                                ? chunk.localText
                                : choice === "upstream"
                                  ? chunk.upstreamText
                                  : chunk.mergedText;
                            })
                            .join(""),
                        )
                      }
                    >
                      {t("按片段选择生成结果")}
                    </button>
                  </details>
                )}
                <label>
                  {t("手动合并结果")}
                  <textarea
                    aria-label={t("手动合并结果")}
                    className="project-editor"
                    value={manual}
                    onChange={(e) => setManual(e.target.value)}
                    spellCheck={false}
                  />
                </label>
                <button
                  className="button primary"
                  onClick={() => {
                    setChoices((old) => ({
                      ...old,
                      [file.path]: {
                        path: file.path,
                        choice: "manual",
                        text: manual,
                      },
                    }));
                    setFile(null);
                  }}
                >
                  {t("保存手动选择")}
                </button>
              </>
            )}
          </div>
        </Dialog>
      )}
      {confirm && (
        <Dialog
          title={t(confirm.title)}
          onClose={() => !busy && setConfirm(null)}
        >
          <p className="modal-description">{t(confirm.body)}</p>
          {confirm.preview && (
            <div className="project-section">
              <p>{t("所选结果的静态检查")}</p>
              <p>
                {t("新增")} {confirm.preview.counts.added} · {t("修改")}{" "}
                {confirm.preview.counts.changed} · {t("删除")}{" "}
                {confirm.preview.counts.deleted} · {t("暂缓处理")}{" "}
                {confirm.preview.counts.deferred}
              </p>
              <div className="project-scroll">
                {confirm.preview.checks.issues.map((issue, index) => (
                  <div className="project-issue" key={index}>
                    <strong>{issue.path}</strong>
                    <span>{message(issue.message)}</span>
                  </div>
                ))}
              </div>
              <p className="section-description">
                {t("以下为 HOI4 静态提示，仍需在游戏中验证玩法和存档兼容性。")}
              </p>
            </div>
          )}
          <div className="modal-actions">
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
              onClick={async () => {
                const result = await action(confirm.run, {
                  reset: confirm.reset,
                });
                if (result !== null) setConfirm(null);
              }}
            >
              {t("确认")}
            </button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
