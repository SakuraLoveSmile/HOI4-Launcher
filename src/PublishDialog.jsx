import { useI18n, T } from "./i18n.jsx";
import React, { useEffect, useState } from "react";
import {
  ArrowRight,
  ExternalLink,
  Upload,
  Plug,
  FileCheck,
} from "lucide-react";
const active = (job) =>
  ["queued", "creating", "packing", "uploading", "publishing"].includes(
    job?.status,
  );
const size = (value) =>
  value < 1024
    ? `${value} B`
    : value < 1024 ** 2
      ? `${(value / 1024).toFixed(1)} KB`
      : `${(value / 1024 ** 2).toFixed(1)} MB`;
const labels = {
  queued: "等待提交",
  creating: "创建工坊项目",
  uploading: "上传模组",
  packing: "正在打包模组",
  publishing: "服务器正在处理发布",
  pending: "发布结果待确认",
  succeeded: "发布已完成",
  failed: "发布未完成",
  "agreement-required": "需要接受工坊协议",
  interrupted: "发布结果待确认",
};
const visibilityNames = {
  0: "公开",
  1: "仅好友",
  2: "私密",
  3: "不在列表中显示",
};
export default function PublishDialog({
  request,
  api,
  perform,
  busy,
  Dialog,
  onClose,
  onAccountSettings,
}) {
  const { t, message, locale } = useI18n();
  const pdx = request.provider === "pdx";
  const draft = request.draft,
    metadata = draft.metadata;
  const [title, setTitle] = useState(metadata.name || ""),
    [description, setDescription] = useState(metadata.description || ""),
    [tags, setTags] = useState((metadata.tags || []).join(", ")),
    [visibility, setVisibility] = useState(2),
    [note, setNote] = useState(""),
    [thumbnail, setThumbnail] = useState(""),
    [target, setTarget] = useState(draft.existingItemId || "");
  const [shortDescription, setShortDescription] = useState(
    (metadata.description || "").slice(0, 200),
  );
  const [recommendedVersion, setRecommendedVersion] = useState(
    metadata.supportedVersion || "*",
  );
  const [review, setReview] = useState(null),
    [job, setJob] = useState(draft.lastJob),
    [connected, setConnected] = useState(false),
    [connectionError, setConnectionError] = useState("");
  useEffect(() => {
    let alive = true;
    (pdx ? api.getAccount() : api.getSteamState())
      .then((value) => {
        if (alive) {
          setConnected(pdx ? value.status === "signed-in" : value.connected);
          setConnectionError(value.error || value.notice || "");
        }
      })
      .catch(
        () =>
          alive &&
          setConnectionError(
            pdx ? "无法读取Paradox账号状态。" : "无法读取Steam连接状态。",
          ),
      );
    return () => {
      alive = false;
    };
  }, [api, pdx]);
  useEffect(() => {
    if (!active(job)) return;
    let alive = true,
      reading = false;
    const timer = setInterval(async () => {
      if (reading) return;
      reading = true;
      try {
        const next =
          await api[pdx ? "getPdxPublishStatus" : "getPublishStatus"]();
        if (alive && next?.id === job.id) setJob(next);
      } catch {
        if (alive)
          setConnectionError("暂时无法读取进度，请保持启动器开启并稍后检查。");
      } finally {
        reading = false;
      }
    }, 800);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [api, pdx, job?.id, job?.status]);
  const close = () => {
    if (busy || active(job)) return;
    perform("publish-cancel", async () => {
      await api[
        pdx ? "cancelPdxPublishPreparation" : "cancelPublishPreparation"
      ]();
      onClose();
    });
  };
  async function prepare(event) {
    event.preventDefault();
    await perform("publish-prepare", async () => {
      const next = await api[pdx ? "preparePdxPublish" : "preparePublish"]({
        modId: request.id,
        title,
        description,
        tags: tags
          .split(/[,，]/)
          .map((value) => value.trim())
          .filter(Boolean),
        visibility,
        changeNote: note,
        existingItemId: target.trim() || null,
        thumbnail: thumbnail.trim(),
        ...(pdx
          ? {
              shortDescription,
              recommendedVersion,
            }
          : {}),
      });
      setJob(null);
      setReview(next);
      return next;
    });
  }
  return (
    <Dialog
      title={pdx ? t("发布到 Paradox Mods") : t("发布到 Steam 创意工坊")}
      onClose={close}
    >
      {job ? (
        <div className="publish-job">
          <div className="publish-status">
            <Upload size={27} />
            <h3>{t(labels[job.status]) || t("发布状态待确认")}</h3>
          </div>
          {job.itemId && (
            <p>
              {pdx ? t("Paradox 模组编号") : t("工坊编号")}{" "}
              <strong>{job.itemId}</strong>
            </p>
          )}
          {pdx && job.publicationName && !job.itemId && (
            <p>
              <T id={"发布标识 "} />
              <code>{job.publicationName}</code>
            </p>
          )}
          {pdx && job.visibility && (
            <p>
              <T id={"服务端可见性：{0}"} values={[job.visibility]} />
            </p>
          )}
          {message(job.errorDiagnostic ?? job.error, job.error) && (
            <p className="inline-note" role="status">
              {message(job.errorDiagnostic ?? job.error, job.error)}
            </p>
          )}
          {active(job) && (
            <p className="modal-description">
              <T
                id={
                  "请保持启动器开启。已经提交的发布操作不能通过关闭此页撤回。"
                }
              />
            </p>
          )}
          {job.progress?.totalBytes > 0 && (
            <>
              <progress
                aria-label={t("模组上传进度")}
                value={job.progress.processedBytes || 0}
                max={job.progress.totalBytes}
              />
              <p>
                {size(job.progress.processedBytes || 0)} /{" "}
                {size(job.progress.totalBytes)}
              </p>
            </>
          )}
          {job.needsAgreement && (
            <p className="inline-note">
              <T
                id={
                  "Steam 要求接受创意工坊法律协议。完成后重新准备，将继续更新此编号，不会创建重复项目。"
                }
              />
            </p>
          )}
          <div className="modal-actions">
            {job.itemId && (
              <button
                className="button subtle"
                onClick={() =>
                  perform("open", () =>
                    api.openModPage(
                      `${pdx ? "pdx" : "workshop"}:${job.itemId}`,
                    ),
                  )
                }
              >
                {pdx ? t("查看 Paradox 项目") : t("查看工坊项目")}
                <ExternalLink size={14} />
              </button>
            )}
            {job.needsAgreement && (
              <button
                className="button subtle"
                onClick={() =>
                  perform("open", () => api.openWorkshopAgreement())
                }
              >
                <T id={"打开工坊协议"} />
                <ExternalLink size={14} />
              </button>
            )}
            {!active(job) && (
              <>
                <button
                  className="button subtle"
                  disabled={busy}
                  onClick={close}
                >
                  <T id={"关闭"} />
                </button>
                <button
                  className="button primary"
                  disabled={
                    busy ||
                    (pdx &&
                      job.commitSent &&
                      !job.itemId &&
                      ["pending", "interrupted"].includes(job.status))
                  }
                  onClick={() => {
                    if (job.itemId) setTarget(job.itemId);
                    setJob(null);
                    setReview(null);
                  }}
                >
                  <T id={"准备更新"} />
                  <ArrowRight size={14} />
                </button>
                {pdx && (
                  <button
                    className="button subtle"
                    disabled={busy}
                    onClick={() =>
                      perform("pdx-publish-refresh", async () => {
                        const next = await api.refreshPdxPublish();
                        if (next) setJob(next);
                        return next;
                      })
                    }
                  >
                    <T id={"检查发布状态"} />
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      ) : review ? (
        <div className="publish-review">
          <p className="modal-description">
            <T
              id={"将上传以下快照。确认后会{0}。"}
              values={[
                review.existingItemId
                  ? t("更新{0}项目 {1}", {
                      0: pdx ? "Paradox" : t("工坊"),
                      1: review.existingItemId,
                    })
                  : t("创建新的{0}项目", {
                      0: pdx ? "Paradox" : t("工坊"),
                    }),
              ]}
            />
          </p>
          <dl>
            <dt>
              <T id={"标题"} />
            </dt>
            <dd>{review.title}</dd>
            <dt>
              <T id={"可见性"} />
            </dt>
            <dd>
              {pdx
                ? t("使用 Paradox 服务端默认设置，提交后核对实际可见性")
                : t(visibilityNames[review.visibility])}
            </dd>
            {pdx && (
              <>
                <dt>
                  <T id={"发布账号"} />
                </dt>
                <dd>{review.actor}</dd>
                <dt>
                  <T id={"简介"} />
                </dt>
                <dd>{review.shortDescription}</dd>
                <dt>
                  <T id={"推荐版本"} />
                </dt>
                <dd>{review.recommendedVersion}</dd>
              </>
            )}
            <dt>
              <T id={"内容"} />
            </dt>
            <dd>
              <T
                id={"{0} 个文件 · {1}"}
                values={[review.fileCount, size(review.totalBytes)]}
              />
            </dd>
            <dt>
              <T id={"预览图"} />
            </dt>
            <dd>{review.thumbnail || t("未指定")}</dd>
            <dt>
              <T id={"描述"} />
            </dt>
            <dd className="publish-description">
              {review.description || t("无")}
            </dd>
            <dt>
              <T id={"变更说明"} />
            </dt>
            <dd>{review.changeNote || t("无")}</dd>
          </dl>
          <details>
            <summary>
              <T id={"查看将上传的文件"} />
            </summary>
            <ul className="publish-files">
              {review.files.slice(0, 100).map((file) => (
                <li key={file.path}>
                  <span>{file.path}</span>
                  <small>{size(file.size)}</small>
                </li>
              ))}
            </ul>
            {review.files.length > 100 && (
              <p className="inline-note">
                <T
                  id={"显示前100项，共{0}项。"}
                  values={[review.files.length]}
                />
              </p>
            )}
          </details>
          {review.omitted.length > 0 && (
            <p className="inline-note">
              <T
                id={"已排除 {0} 项版本库或启动器备份内容。"}
                values={[review.omitted.length]}
              />
            </p>
          )}
          <div className="modal-actions">
            <button
              className="button subtle"
              disabled={busy}
              onClick={() => setReview(null)}
            >
              <T id={"返回修改"} />
            </button>
            <button
              className="button primary"
              disabled={busy}
              onClick={() =>
                perform("publish-submit", async () => {
                  const next = await api[
                    pdx ? "commitPdxPublish" : "commitPublish"
                  ](review.id);
                  setJob(next);
                  return next;
                })
              }
            >
              <Upload size={16} />
              {review.existingItemId ? t("确认上传更新") : t("确认创建并上传")}
            </button>
          </div>
        </div>
      ) : (
        <form onSubmit={prepare}>
          <p className="modal-description">
            <T
              id={
                "先检查内容和发布资料，再确认上传。你必须拥有作品内容和所选项目的发布权限。"
              }
            />
          </p>
          {!connected && (
            <div className="inline-note">
              <p>
                {pdx
                  ? t("请在设置页主动登录 Paradox 账号。")
                  : t("请连接正在运行的 Steam 客户端。")}
              </p>
              <button
                type="button"
                className="button subtle"
                disabled={busy}
                onClick={() =>
                  pdx
                    ? onAccountSettings()
                    : perform("steam-connect", async () => {
                        const result = await api.connectSteam();
                        setConnected(result.connected);
                        setConnectionError(result.error || "");
                        return result;
                      })
                }
              >
                <Plug size={14} />
                {pdx ? t("前往账号设置") : t("连接 Steam")}
              </button>
            </div>
          )}
          {message(connectionError) && (
            <p className="inline-note" role="status">
              {message(connectionError)}
            </p>
          )}
          <div className="authoring-fields">
            <label>
              {pdx ? t("标题（3–60个字符）") : t("标题（最多128字节）")}
              <input
                aria-label={pdx ? t("Paradox 发布标题") : t("工坊发布标题")}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                required
                maxLength={pdx ? 60 : 128}
                disabled={busy}
              />
            </label>
            <label>
              {pdx ? t("目标 Paradox 编号") : t("目标工坊编号")}
              <input
                aria-label={pdx ? t("目标 Paradox 编号") : t("目标工坊编号")}
                value={target}
                onChange={(event) => setTarget(event.target.value)}
                maxLength={20}
                disabled={busy}
                placeholder={t("留空创建新项目；更新时填已有编号")}
              />
            </label>
            {!pdx && (
              <label>
                <T id={"可见性"} />
                <select
                  aria-label={t("工坊可见性")}
                  value={visibility}
                  onChange={(event) =>
                    setVisibility(Number(event.target.value))
                  }
                  disabled={busy}
                >
                  {Object.entries(visibilityNames).map(([id, label]) => (
                    <option value={id} key={id}>
                      {t(label)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {pdx && (
              <>
                <p className="inline-note">
                  <T
                    id={"按 Paradox 服务端默认可见性提交，发布后请核对来源页。"}
                  />
                </p>
                <label>
                  <T id={"简介（清除格式后10–200个字符）"} />
                  <textarea
                    aria-label={t("Paradox 发布简介")}
                    value={shortDescription}
                    onChange={(event) =>
                      setShortDescription(event.target.value)
                    }
                    rows={2}
                    minLength={10}
                    maxLength={10000}
                    required
                    disabled={busy}
                  />
                </label>
                <label>
                  <T id={"推荐游戏版本"} />
                  <input
                    aria-label={t("Paradox 推荐游戏版本")}
                    value={recommendedVersion}
                    onChange={(event) =>
                      setRecommendedVersion(event.target.value)
                    }
                    maxLength={12}
                    required
                    disabled={busy}
                  />
                </label>
              </>
            )}
            <label>
              <T id={"描述"} />
              <textarea
                aria-label={pdx ? t("Paradox 发布描述") : t("工坊发布描述")}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                rows={4}
                maxLength={pdx ? 1000000 : 8000}
                minLength={pdx ? 10 : undefined}
                required={pdx}
                disabled={busy}
              />
            </label>
            <label>
              <T id={"标签"} />
              <input
                aria-label={pdx ? t("Paradox 发布标签") : t("工坊发布标签")}
                value={tags}
                onChange={(event) => setTags(event.target.value)}
                disabled={busy}
              />
            </label>
            <label>
              {pdx
                ? t("预览图（模组内PNG/JPEG相对路径，最多1,000,000字节）")
                : t("预览图（模组内PNG/JPEG相对路径，最多1MiB）")}
              <input
                aria-label={pdx ? t("Paradox 预览图") : t("工坊预览图")}
                value={thumbnail}
                onChange={(event) => setThumbnail(event.target.value)}
                placeholder={t("例如 thumbnail.png")}
                required={pdx && !target.trim()}
                disabled={busy}
              />
            </label>
            <label>
              <T id={"变更说明"} />
              <textarea
                aria-label={pdx ? t("Paradox 变更说明") : t("工坊变更说明")}
                value={note}
                onChange={(event) => setNote(event.target.value)}
                rows={2}
                maxLength={pdx ? 5000 : 8000}
                disabled={busy}
              />
            </label>
          </div>
          <div className="modal-actions">
            <button
              className="button subtle"
              type="button"
              disabled={busy}
              onClick={close}
            >
              <T id={"取消"} />
            </button>
            <button
              className="button primary"
              type="submit"
              disabled={busy || !connected || !title.trim()}
            >
              <FileCheck size={16} />
              <T id={"准备并检查内容"} />
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
