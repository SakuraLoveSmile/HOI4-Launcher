"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const sanitizeHtml = require("sanitize-html");
const {
  diagnostic,
  sequence,
  diagnosticError,
} = require("./diagnostic-message.cjs");
const LIMIT = 5 * 1024 ** 3;
const MAX_SOURCE = 200 * 1024 ** 3;
const ACTIVE = new Set(["queued", "packing", "uploading", "publishing"]);
const REJECTED_STATES = new Set([
  "failed",
  "rejected",
  "removedByUser",
  "disabledByManager",
]);
const STATUSES = new Set([
  ...ACTIVE,
  "succeeded",
  "pending",
  "failed",
  "interrupted",
]);
const MESSAGES = {
  INVALID_INPUT: "Paradox 发布资料无效，请重新准备。",
  BUSY: "已有 Paradox 发布或查询任务，请等待完成。",
  DISPOSED: "Paradox 发布服务已关闭。",
  NOT_SIGNED_IN: "请先主动登录 Paradox 账号。",
  ACCOUNT_CHANGED: "Paradox 账号已改变，请使用准备发布时的账号。",
  INVALID_RESPONSE: "Paradox 返回了无法识别的发布数据。",
  NOT_OWNER: "当前账号的已发布模组中没有该目标，不能更新。",
  WRONG_TARGET: "发布目标与 HOI4 模组或发布标识不一致。",
  TARGET_BUSY: "该模组正在发布或更新，请稍后重试。",
  TOO_LARGE: "Paradox 发布包必须小于 5 GiB。",
  SOURCE_TOO_LARGE: "发布源内容超过本应用的 200 GiB 上限。",
  ARCHIVE_FAILED:
    "无法为审核内容生成 ZIP，请检查磁盘空间或文件变化后重新准备。",
  PREVIEW_CHANGED: "预览图与已审核快照不符，请重新准备发布。",
  PERSISTENCE_ERROR: "发布记录无法保存，已停止后续写入，请保留当前发布标识。",
  REQUEST_REJECTED: "Paradox 拒绝了本次发布，请检查模组资料和账号权限。",
  PUBLICATION_REJECTED:
    "Paradox 已将该发布标记为失败或不可用，请检查远端模组状态。",
  UPLOAD_SOURCE_CHANGED: "上传文件发生变化或无法读取，请重新准备发布。",
  NETWORK_ERROR: "Paradox 发布请求未完成，请检查网络或账号状态。",
  PENDING:
    "Paradox 仍在处理发布；保留当前模组编号，稍后查询即可，请勿重复提交。",
  UNKNOWN:
    "发布请求已发出，但结果尚未确认。已保留发布标识，请只查询状态，勿重复提交。",
  NOT_FOUND_YET:
    "当前账号下尚未找到该发布标识，请稍后查询，勿重新提交新建发布。",
  INTERRUPTED: "发布操作已中断；已经提交的远端操作不会撤回，请查询结果。",
  ALREADY_SUBMITTED: "该任务已经提交过，请查询原任务，不能重复新建发布。",
};
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const clone = (value) => structuredClone(value);
function fail(code) {
  const error = diagnosticError(MESSAGES[code]);
  error.code = code;
  return error;
}
function safeCode(error) {
  if (Object.hasOwn(MESSAGES, error?.code)) return error.code;
  if (["NOT_SIGNED_IN", "SESSION_EXPIRED", "CANCELLED"].includes(error?.code))
    return "ACCOUNT_CHANGED";
  if (error?.code === "ACCESS_DENIED") return "REQUEST_REJECTED";
  return "NETWORK_ERROR";
}
function numeric(value) {
  if (typeof value === "number" && Number.isSafeInteger(value))
    value = String(value);
  if (
    typeof value !== "string" ||
    !/^[1-9]\d{0,15}$/.test(value) ||
    !Number.isSafeInteger(Number(value))
  )
    throw fail("INVALID_INPUT");
  return value;
}
function label(value) {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)
  )
    throw fail("INVALID_INPUT");
  return value;
}
function actor(value) {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 200 ||
    /[\0-\x1f\x7f]/.test(value)
  )
    throw fail("INVALID_INPUT");
  return value;
}
function field(value, maximum, fallback = "") {
  value ??= fallback;
  if (
    typeof value !== "string" ||
    value.length > maximum ||
    /[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)
  )
    throw fail("INVALID_INPUT");
  return value;
}
// Match the official launcher's preload sanitizer, including entity escaping.
function descriptionLength(value) {
  return sanitizeHtml(value, { allowedTags: [] }).length;
}
function result(data, allowEmpty = false) {
  if (allowEmpty && data === null) return;
  if (!object(data)) throw fail("INVALID_RESPONSE");
  if (
    (data.result !== undefined && data.result !== "OK") ||
    data.error ||
    (data.errors && (!Array.isArray(data.errors) || data.errors.length))
  )
    throw fail("REQUEST_REJECTED");
}
function canonical(value) {
  return path.resolve(value).toLowerCase();
}
function retainedNotice(value) {
  const location = value?.retainedPath;
  return typeof location === "string" &&
    location.length < 32768 &&
    path.isAbsolute(location) &&
    !/[\0-\x1f]/.test(location)
    ? ` 临时文件已保留：${location}`
    : "";
}
const retainedDiagnostic = (value) =>
  retainedNotice(value)
    ? diagnostic(" 临时文件已保留：{0}", [value.retainedPath])
    : "";
function checkedInput(input) {
  if (
    !object(input) ||
    typeof input.contentPath !== "string" ||
    !path.isAbsolute(input.contentPath) ||
    /[\0-\x1f]/.test(input.contentPath) ||
    !Array.isArray(input.files) ||
    !input.files.length ||
    input.files.length > 100000
  )
    throw fail("INVALID_INPUT");
  const selected = {
    id: label(input.id),
    actorId: actor(input.actorId),
    existingItemId:
      input.existingItemId == null ? null : numeric(input.existingItemId),
    contentPath: path.resolve(input.contentPath),
    title: field(input.title, 60).trim(),
    description: field(input.description, 1000000),
    shortDescription: field(input.shortDescription, 10000),
    changeNote: field(input.changeNote, 5000),
    recommendedVersion: field(input.recommendedVersion, 12, "*") || "*",
  };
  if (
    selected.title.length < 3 ||
    descriptionLength(selected.description) < 10 ||
    descriptionLength(selected.shortDescription) < 10 ||
    descriptionLength(selected.shortDescription) > 200 ||
    !/^[A-Za-z0-9.*_+-]{1,12}$/.test(selected.recommendedVersion) ||
    !Array.isArray(input.tags) ||
    input.tags.length > 10
  )
    throw fail("INVALID_INPUT");
  selected.tags = input.tags.map((tag) => {
    const value = field(tag, 256).trim();
    if (!value || /[\r\n]/.test(value)) throw fail("INVALID_INPUT");
    return value;
  });
  let total = 0;
  const names = new Set();
  selected.files = input.files.map((file) => {
    if (
      !object(file) ||
      typeof file.relative !== "string" ||
      !file.relative ||
      path.isAbsolute(file.relative) ||
      /[:\0-\x1f]/.test(file.relative) ||
      file.relative
        .split(/[\\/]/)
        .some((part) => !part || part === "." || part === "..") ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      !/^[0-9a-f]{64}$/.test(file.hash) ||
      // Ordinary Node stats can contain rounded, > MAX_SAFE_INTEGER Windows
      // inode values. Preserve that representation for later identity checks;
      // reviewed length and SHA-256 are still required for content integrity.
      !Number.isInteger(file.targetIno) ||
      file.targetIno < 0 ||
      !Number.isInteger(file.targetDev) ||
      file.targetDev < 0
    )
      throw fail("INVALID_INPUT");
    const relative = path.normalize(file.relative),
      key = relative.toLowerCase();
    if (names.has(key)) throw fail("INVALID_INPUT");
    names.add(key);
    total += file.size;
    if (!Number.isSafeInteger(total) || total > MAX_SOURCE)
      throw fail("SOURCE_TOO_LARGE");
    return {
      relative,
      size: file.size,
      hash: file.hash,
      targetIno: file.targetIno,
      targetDev: file.targetDev,
    };
  });
  if (!names.has("descriptor.mod")) throw fail("INVALID_INPUT");
  selected.totalBytes = total;
  if (input.previewPath !== undefined && input.previewPath !== null) {
    if (
      typeof input.previewPath !== "string" ||
      !path.isAbsolute(input.previewPath)
    )
      throw fail("INVALID_INPUT");
    selected.previewPath = path.resolve(input.previewPath);
    selected.preview = selected.files.find(
      (file) =>
        canonical(path.join(selected.contentPath, file.relative)) ===
        canonical(selected.previewPath),
    );
    if (
      !selected.preview ||
      selected.preview.size > 1_000_000 ||
      !/\.(png|jpe?g)$/i.test(selected.previewPath)
    )
      throw fail("INVALID_INPUT");
  }
  return selected;
}

function createPdxPublisher({
  account,
  createArchive,
  onPublishStatus = () => {},
  pollIntervalMs = 2500,
  maxPolls = 48,
} = {}) {
  if (
    typeof account?.request !== "function" ||
    typeof account?.getAccount !== "function" ||
    typeof account?.uploadFile !== "function" ||
    typeof createArchive !== "function" ||
    typeof onPublishStatus !== "function" ||
    !Number.isSafeInteger(pollIntervalMs) ||
    pollIntervalMs < 0 ||
    pollIntervalMs > 60000 ||
    !Number.isSafeInteger(maxPolls) ||
    maxPolls < 1 ||
    maxPolls > 1000
  )
    throw fail("INVALID_INPUT");
  let queue = Promise.resolve(),
    job = null,
    busy = false,
    disposed = false,
    controller = null;
  const submitted = new Set();
  const serial = (work) => {
    const pending = queue.then(work);
    queue = pending.catch(() => {});
    return pending;
  };
  const check = (signal) => {
    if (disposed || signal?.aborted) throw fail("INTERRUPTED");
  };
  async function identity(expected) {
    const state = await account.getAccount();
    if (state?.status !== "signed-in" || !state.account?.id)
      throw fail("NOT_SIGNED_IN");
    const accountId = actor(state.account.id);
    if (expected && expected !== accountId) throw fail("ACCOUNT_CHANGED");
    return {
      connected: true,
      accountId,
      displayName: field(state.account.displayName, 200) || null,
    };
  }
  const request = (accountId, input, signal) =>
    account.request({ ...input, expectedAccountId: accountId, signal });
  async function emit(patch) {
    if (
      Object.hasOwn(patch, "error") &&
      !Object.hasOwn(patch, "errorDiagnostic")
    )
      patch = {
        ...patch,
        errorDiagnostic: patch.error ? diagnostic(patch.error) : null,
      };
    job = { ...job, ...patch };
    try {
      await onPublishStatus(clone(job));
    } catch {
      throw fail("PERSISTENCE_ERROR");
    }
  }
  function progress(value, offset = 0, total) {
    const count = value?.processedBytes;
    const maximum = total ?? value?.totalBytes;
    if (
      Number.isSafeInteger(count) &&
      count >= 0 &&
      Number.isSafeInteger(maximum) &&
      maximum >= offset &&
      count + offset <= maximum
    )
      job.progress = { processedBytes: count + offset, totalBytes: maximum };
  }
  async function owned(accountId, signal) {
    const items = [],
      seen = new Set();
    let expected;
    for (let page = 0; page < 101; page++) {
      check(signal);
      const data = await request(
        accountId,
        {
          method: "POST",
          path: "/mods",
          body: {
            gameNames: ["hoi4"],
            onlyModsByMe: true,
            page,
            pageSize: 100,
          },
        },
        signal,
      );
      result(data);
      if (!Array.isArray(data.mods) || data.mods.length > 100)
        throw fail("INVALID_RESPONSE");
      if (data.totalCount !== undefined) {
        if (
          !Number.isSafeInteger(data.totalCount) ||
          data.totalCount < 0 ||
          data.totalCount > 10000 ||
          (expected !== undefined && expected !== data.totalCount)
        )
          throw fail("INVALID_RESPONSE");
        expected = data.totalCount;
      }
      for (const row of data.mods) {
        if (!object(row)) throw fail("INVALID_RESPONSE");
        const id = numeric(row.modId);
        if (seen.has(id) || seen.size >= 10000) throw fail("INVALID_RESPONSE");
        seen.add(id);
        items.push({ ...row, modId: id });
      }
      if (
        !data.mods.length ||
        (expected !== undefined && items.length === expected)
      ) {
        if (expected !== undefined && items.length !== expected)
          throw fail("INVALID_RESPONSE");
        return items;
      }
      if (expected !== undefined && items.length > expected)
        throw fail("INVALID_RESPONSE");
    }
    throw fail("INVALID_RESPONSE");
  }
  async function detail(accountId, itemId, publicationName, signal) {
    const data = await request(
      accountId,
      { path: "/mods", query: { modId: itemId } },
      signal,
    );
    result(data);
    const value = data.modDetail;
    if (
      !object(value) ||
      numeric(value.modId) !== itemId ||
      value.game !== "hoi4" ||
      (publicationName && value.name !== publicationName)
    )
      throw fail("WRONG_TARGET");
    label(value.name);
    return value;
  }
  async function target(itemId, accountId, signal, allowUpdating = false) {
    if (!(await owned(accountId, signal)).some((item) => item.modId === itemId))
      throw fail("NOT_OWNER");
    const value = await detail(accountId, itemId, null, signal);
    if (!allowUpdating && value.updating !== false) throw fail("TARGET_BUSY");
    return value;
  }
  async function preview(selected, signal) {
    if (!selected.preview) return null;
    check(signal);
    const filename = selected.previewPath,
      expected = selected.preview;
    if (
      canonical(await fs.realpath(filename)) !== canonical(filename) ||
      canonical(await fs.realpath(selected.contentPath)) !==
        canonical(selected.contentPath)
    )
      throw fail("PREVIEW_CHANGED");
    const initial = await fs.lstat(filename);
    if (
      !initial.isFile() ||
      initial.isSymbolicLink() ||
      initial.nlink !== 1 ||
      initial.ino !== expected.targetIno ||
      initial.dev !== expected.targetDev ||
      initial.size !== expected.size
    )
      throw fail("PREVIEW_CHANGED");
    const handle = await fs.open(filename, "r");
    try {
      const before = await handle.stat();
      if (
        before.ino !== initial.ino ||
        before.dev !== initial.dev ||
        before.size !== expected.size
      )
        throw fail("PREVIEW_CHANGED");
      const buffer = Buffer.alloc(expected.size + 1);
      let length = 0;
      while (length < buffer.length) {
        check(signal);
        const { bytesRead } = await handle.read(
          buffer,
          length,
          buffer.length - length,
          length,
        );
        if (!bytesRead) break;
        length += bytesRead;
      }
      const data = buffer.subarray(0, length);
      const after = await handle.stat();
      if (
        data.length !== expected.size ||
        after.size !== expected.size ||
        after.mtimeMs !== before.mtimeMs ||
        createHash("sha256").update(data).digest("hex") !== expected.hash
      )
        throw fail("PREVIEW_CHANGED");
      check(signal);
      return {
        path: filename,
        bytes: expected.size,
        sha256: expected.hash,
        filename: `thumbnail${path.extname(filename).toLowerCase()}`,
      };
    } finally {
      await handle.close();
    }
  }
  async function wait(signal) {
    check(signal);
    await new Promise((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer);
        reject(fail("INTERRUPTED"));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", abort);
        resolve();
      }, pollIntervalMs);
      signal.addEventListener("abort", abort, { once: true });
    });
  }
  async function poll(signal, attempts = maxPolls) {
    for (let index = 0; index < attempts; index++) {
      check(signal);
      const current = await detail(
        job.accountId,
        job.itemId,
        job.publicationName,
        signal,
      );
      if (REJECTED_STATES.has(current.state))
        throw fail("PUBLICATION_REJECTED");
      const revision = current.modVersion ?? current.latestVersion;
      const newer =
        !job.existingItemId ||
        (job.baseRevision &&
          BigInt(numeric(revision)) > BigInt(job.baseRevision));
      if (
        current.state === "published" &&
        current.updating === false &&
        newer
      ) {
        await identity(job.accountId);
        check(signal);
        await emit({
          status: "succeeded",
          error: null,
          ...(typeof current.acl === "string" &&
          /^[a-z]{1,32}$/.test(current.acl)
            ? { visibility: current.acl }
            : {}),
        });
        return;
      }
      if (index + 1 < attempts) await wait(signal);
    }
    await emit({ status: "pending", error: MESSAGES.PENDING });
  }
  async function run(selected, signal) {
    let archive,
      commitAttempted = false,
      pollingStarted = false;
    try {
      // This event durably reserves the UUID before the first content PUT.
      await emit({});
      check(signal);
      await identity(selected.actorId);
      check(signal);
      if (selected.existingItemId) {
        const existing = await target(
          selected.existingItemId,
          selected.actorId,
          signal,
        );
        await emit({
          publicationName: existing.name,
          baseRevision: numeric(existing.modVersion ?? existing.latestVersion),
        });
      }
      await emit({
        status: "packing",
        progress: { processedBytes: 0, totalBytes: selected.totalBytes },
      });
      try {
        archive = await createArchive({
          contentPath: selected.contentPath,
          files: clone(selected.files),
          signal,
          onProgress: (value) => progress(value),
        });
      } catch (error) {
        const failure = fail("ARCHIVE_FAILED");
        if (retainedNotice(error)) failure.retainedPath = error.retainedPath;
        throw failure;
      }
      if (
        !object(archive) ||
        typeof archive.path !== "string" ||
        !path.isAbsolute(archive.path) ||
        !Number.isSafeInteger(archive.bytes) ||
        archive.bytes < 1 ||
        !/^[0-9a-f]{64}$/.test(archive.sha256) ||
        typeof archive.cleanup !== "function"
      )
        throw fail("INVALID_INPUT");
      if (archive.bytes >= LIMIT) throw fail("TOO_LARGE");
      const thumb = await preview(selected, signal);
      await identity(selected.actorId);
      check(signal);
      if (selected.existingItemId) {
        const existing = await target(
          selected.existingItemId,
          selected.actorId,
          signal,
        );
        if (
          existing.name !== job.publicationName ||
          numeric(existing.modVersion ?? existing.latestVersion) !==
            job.baseRevision
        )
          throw fail("WRONG_TARGET");
      }
      const total = archive.bytes + (thumb?.bytes || 0),
        contentFilename = `content_${selected.id}.zip`;
      await emit({
        status: "uploading",
        progress: { processedBytes: 0, totalBytes: total },
      });
      check(signal);
      const uploaded = await account.uploadFile({
        path: `/mods/content/hoi4/${job.publicationName}/content/${contentFilename}`,
        filePath: archive.path,
        bytes: archive.bytes,
        sha256: archive.sha256,
        expectedAccountId: selected.actorId,
        signal,
        onProgress: (value) => progress(value, 0, total),
      });
      result(uploaded, true);
      check(signal);
      if (thumb) {
        const uploadedThumb = await account.uploadFile({
          path: `/mods/content/hoi4/${job.publicationName}/thumbnail/${thumb.filename}`,
          filePath: thumb.path,
          bytes: thumb.bytes,
          sha256: thumb.sha256,
          expectedAccountId: selected.actorId,
          signal,
          onProgress: (value) => progress(value, archive.bytes, total),
        });
        result(uploadedThumb, true);
        check(signal);
      }
      await identity(selected.actorId);
      check(signal);
      if (selected.existingItemId) {
        const current = await target(
          selected.existingItemId,
          selected.actorId,
          signal,
        );
        if (
          current.name !== job.publicationName ||
          numeric(current.modVersion ?? current.latestVersion) !==
            job.baseRevision
        )
          throw fail("WRONG_TARGET");
      }
      const body = {
        modName: job.publicationName,
        gameName: "hoi4",
        contentFileName: contentFilename,
        ...(thumb ? { thumbnail: thumb.filename } : {}),
        os: "Any",
        arch: "Any",
        longDescription: selected.description,
        shortDescription: selected.shortDescription,
        displayName: selected.title,
        tags: selected.tags,
        recommendedGameVersion: selected.recommendedVersion,
        ...(selected.existingItemId
          ? {
              modId: selected.existingItemId,
              changelogEntry: selected.changeNote || " ",
            }
          : {}),
      };
      await emit({
        status: "publishing",
        progress: { processedBytes: total, totalBytes: total },
        commitSent: true,
      });
      check(signal);
      commitAttempted = true;
      submitted.add(selected.id);
      const reply = await request(
        selected.actorId,
        {
          method: "POST",
          path: selected.existingItemId
            ? "/mods/publishUpdate"
            : "/mods/publish",
          body,
        },
        signal,
      );
      result(reply);
      const itemId = numeric(reply.modId);
      if (selected.existingItemId && itemId !== selected.existingItemId)
        throw fail("WRONG_TARGET");
      await emit({ itemId });
      check(signal);
      if (REJECTED_STATES.has(reply.state)) throw fail("PUBLICATION_REJECTED");
      if (!["publishing", "published"].includes(reply.state))
        throw fail("INVALID_RESPONSE");
      pollingStarted = true;
      await poll(signal);
    } catch (error) {
      const code = safeCode(error);
      const status =
        disposed || signal.aborted
          ? "interrupted"
          : commitAttempted &&
              code !== "PUBLICATION_REJECTED" &&
              (pollingStarted || code !== "REQUEST_REJECTED")
            ? "pending"
            : "failed";
      const message =
        status === "interrupted"
          ? MESSAGES.INTERRUPTED
          : status === "pending"
            ? `${MESSAGES.UNKNOWN} ${MESSAGES[code]}`
            : MESSAGES[code];
      const detail =
        status === "pending"
          ? sequence([
              diagnostic(MESSAGES.UNKNOWN),
              " ",
              diagnostic(MESSAGES[code]),
            ])
          : diagnostic(message);
      try {
        await emit({
          status,
          error: message + retainedNotice(error),
          errorDiagnostic: sequence([detail, retainedDiagnostic(error)]),
          ...(!commitAttempted ? { commitSent: false } : {}),
        });
      } catch {
        job = {
          ...job,
          status,
          error: `${message} ${MESSAGES.PERSISTENCE_ERROR}`,
          errorDiagnostic: sequence([
            detail,
            " ",
            diagnostic(MESSAGES.PERSISTENCE_ERROR),
          ]),
        };
      }
    } finally {
      if (typeof archive?.cleanup === "function") {
        try {
          const result = await archive.cleanup();
          if (result?.removed === false) {
            await emit({
              error:
                `${job.error || ""} 临时归档目录含无法确认归属的内容，已保留。${retainedNotice(result)}`.trim(),
              errorDiagnostic: diagnostic(
                "{0} 临时归档目录含无法确认归属的内容，已保留。{1}",
                [
                  job.errorDiagnostic ?? {
                    kind: "literal",
                    text: job.error || "",
                  },
                  retainedDiagnostic(result),
                ],
              ),
            });
          }
        } catch {
          job.errorDiagnostic = diagnostic(
            "{0} 临时归档清理未完成，请保留发布记录。",
            [job.errorDiagnostic ?? { kind: "literal", text: job.error || "" }],
          );
          job.error =
            `${job.error || ""} 临时归档清理未完成，请保留发布记录。`.trim();
          try {
            await emit({});
          } catch {}
        }
      }
      busy = false;
      controller = null;
    }
  }
  async function recover(persisted) {
    if (!object(persisted) || !STATUSES.has(persisted.status))
      throw fail("INVALID_INPUT");
    const restored = {
      id: label(persisted.id),
      status: "pending",
      accountId: actor(persisted.accountId),
      publicationName: label(persisted.publicationName),
      itemId: persisted.itemId == null ? null : numeric(persisted.itemId),
      existingItemId:
        persisted.existingItemId == null
          ? null
          : numeric(persisted.existingItemId),
      baseRevision:
        persisted.baseRevision == null ? null : numeric(persisted.baseRevision),
      commitSent: persisted.commitSent === true,
      progress: null,
      error: null,
    };
    await identity(restored.accountId);
    job = restored;
    if (job.commitSent) submitted.add(job.id);
    controller = new AbortController();
    const signal = controller.signal;
    try {
      const all = await owned(job.accountId, signal);
      if (job.itemId) {
        if (!all.some((item) => item.modId === job.itemId))
          throw fail("NOT_OWNER");
      } else {
        const matches = [];
        for (const item of all) {
          let name = item.name;
          if (name === undefined)
            name = (await detail(job.accountId, item.modId, null, signal)).name;
          if (name === job.publicationName) matches.push(item.modId);
        }
        if (matches.length > 1) throw fail("WRONG_TARGET");
        if (!matches.length) {
          await emit({ status: "pending", error: MESSAGES.NOT_FOUND_YET });
          return clone(job);
        }
        await emit({ itemId: matches[0] });
      }
      await poll(signal, 1);
    } catch (error) {
      try {
        await emit({
          status: disposed
            ? "interrupted"
            : error?.code === "PUBLICATION_REJECTED"
              ? "failed"
              : "pending",
          error: MESSAGES[safeCode(error)],
        });
      } catch {
        job.error = MESSAGES.PERSISTENCE_ERROR;
        job.errorDiagnostic = diagnostic(job.error);
      }
    } finally {
      controller = null;
    }
    return clone(job);
  }
  return {
    getState: () =>
      serial(async () => {
        try {
          if (disposed) throw fail("DISPOSED");
          return await identity();
        } catch (error) {
          if (error.code === "NOT_SIGNED_IN")
            return { connected: false, accountId: null, displayName: null };
          throw fail(safeCode(error));
        }
      }),
    validatePublishTarget(id) {
      try {
        id = numeric(id);
        if (disposed) throw fail("DISPOSED");
        if (busy) throw fail("BUSY");
      } catch (error) {
        return Promise.reject(error);
      }
      const binding = identity();
      binding.catch(() => {});
      return serial(async () => {
        const current = await binding;
        await identity(current.accountId);
        const value = await target(id, current.accountId);
        await identity(current.accountId);
        return {
          itemId: id,
          accountId: current.accountId,
          displayName: current.displayName,
          publicationName: value.name,
        };
      }).catch((error) => {
        throw fail(safeCode(error));
      });
    },
    startPublish(input) {
      if (disposed) throw fail("DISPOSED");
      if (busy) throw fail("BUSY");
      const selected = checkedInput(input);
      if (submitted.has(selected.id)) throw fail("ALREADY_SUBMITTED");
      busy = true;
      controller = new AbortController();
      job = {
        id: selected.id,
        status: "queued",
        itemId: selected.existingItemId,
        publicationName: selected.existingItemId ? null : randomUUID(),
        accountId: selected.actorId,
        existingItemId: selected.existingItemId,
        baseRevision: null,
        commitSent: false,
        progress: null,
        error: null,
      };
      const signal = controller.signal,
        snapshot = clone(job);
      void serial(() => run(selected, signal));
      return snapshot;
    },
    getPublishStatus: () => (job ? clone(job) : null),
    refreshPublish(persisted) {
      if (disposed) return Promise.reject(fail("DISPOSED"));
      if (busy) return Promise.reject(fail("BUSY"));
      busy = true;
      return serial(() => recover(clone(persisted)))
        .catch((error) => {
          throw fail(safeCode(error));
        })
        .finally(() => {
          busy = false;
        });
    },
    dispose() {
      disposed = true;
      controller?.abort();
    },
  };
}

module.exports = { createPdxPublisher };
