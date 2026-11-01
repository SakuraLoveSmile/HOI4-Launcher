"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID, createHash } = require("node:crypto");
const ACTIVE = new Set(["queued", "running", "cancelling"]);
const ITEM_STATUSES = new Set([
  "pending",
  "checking",
  "submitted",
  "skipped",
  "failed",
  "unknown",
  "cancelled",
]);
const JOB_STATUSES = new Set([
  ...ACTIVE,
  "completed",
  "partial",
  "cancelled",
  "interrupted",
  "blocked",
]);
const ACTOR_ERRORS = new Set([
  "ACCOUNT_CHANGED",
  "APP_CHANGED",
  "IDENTITY_UNAVAILABLE",
]);
// Settings accepts 10,000 ordered and 10,000 enabled members before merging.
const MAX_MEMBERS = 20000;
const MAX_EVENT_BYTES = 8192;
const MAX_JOURNAL_BYTES = 256 * 1024 * 1024;
const ITEM_STATE_KEYS = new Set([
  "status",
  "subscription",
  "downloadRequest",
  "observed",
  "errorCode",
  "error",
]);
const clone = (value) => JSON.parse(JSON.stringify(value));
const object = (value) =>
  value && typeof value === "object" && !Array.isArray(value);
const canonical = (value) => path.resolve(value).toLowerCase();
const failure = (code, message) => Object.assign(new Error(message), { code });
const cleanText = (value, max = 160) =>
  typeof value === "string"
    ? value.replace(/[\0-\x1f\x7f]/g, " ").slice(0, max)
    : "";
function steamId(value) {
  if (
    typeof value !== "string" ||
    !/^[1-9]\d{0,19}$/.test(value) ||
    BigInt(value) > 18446744073709551615n
  )
    throw failure("INVALID_ID", "预设含有无效的 Steam 模组或账号编号。");
  return value;
}
function actor(value) {
  if (!value?.connected || !object(value.account))
    throw failure("NOT_CONNECTED", "请先连接 Steam，再准备补齐模组。");
  if (value.repairing)
    throw failure(
      "STEAM_BUSY",
      "Steam 仍在处理上一项请求，请等待结果后再操作。",
    );
  return {
    steamId: steamId(value.account.steamId),
    name: cleanText(value.account.name) || "Steam 玩家",
  };
}
function playsetContext(current, playsetId) {
  if (
    !current?.game?.found ||
    typeof current.settings?.gameDirectory !== "string" ||
    !path.isAbsolute(current.settings.gameDirectory) ||
    typeof current.paths?.userData !== "string" ||
    !path.isAbsolute(current.paths.userData)
  )
    throw failure("NO_GAME", "请先选择有效的 HOI4 游戏目录。");
  const playset = current.settings.playsets?.find(
    (entry) => entry.id === playsetId,
  );
  if (!playset)
    throw failure("PLAYSET_MISSING", "所选预设已不存在，请重新选择。");
  const ordered = playset.modOrder ?? playset.modIds;
  if (
    !Array.isArray(ordered) ||
    !Array.isArray(playset.modIds) ||
    ordered.length > MAX_MEMBERS ||
    playset.modIds.length > MAX_MEMBERS
  )
    throw failure("INVALID_MEMBERS", "预设成员数量或格式无效。");
  const order = [...new Set([...ordered, ...playset.modIds])];
  if (order.length > MAX_MEMBERS || order.some((id) => typeof id !== "string"))
    throw failure("INVALID_MEMBERS", "预设成员数量或格式无效。");
  const enabled = new Set(playset.modIds),
    references = new Map(
      (playset.modReferences || []).map((ref) => [ref.id, ref]),
    );
  const mods = new Map((current.mods || []).map((mod) => [mod.id, mod]));
  const items = order
    .filter((id) => id.startsWith("workshop:") && !mods.get(id)?.available)
    .map((id) => ({
      id: steamId(id.slice(9)),
      name: cleanText(references.get(id)?.name || mods.get(id)?.name) || id,
      enabled: enabled.has(id),
    }));
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        playsetId,
        gameDirectory: canonical(current.settings.gameDirectory),
        userDataPath: canonical(current.paths.userData),
        order,
        enabled: order.filter((id) => enabled.has(id)),
      }),
    )
    .digest("hex");
  return {
    fingerprint,
    playsetName: cleanText(playset.name, 128),
    items,
    available: new Set(
      [...mods.values()].filter((mod) => mod.available).map((mod) => mod.id),
    ),
  };
}
function checkedResult(result, id) {
  if (
    !object(result) ||
    result.id !== id ||
    !["submitted", "already-present", "failed", "unknown"].includes(
      result.outcome,
    ) ||
    !["unchanged", "confirmed", "unknown"].includes(result.subscription) ||
    ![
      "not-requested",
      "already-active",
      "accepted",
      "rejected",
      "unknown",
    ].includes(result.downloadRequest)
  )
    throw failure("INVALID_RESPONSE", "Steam 回执无效，无法确认操作结果。");
  let observed = null;
  if (result.observed != null) {
    if (
      !object(result.observed) ||
      result.observed.id !== id ||
      ![
        "subscribed",
        "installed",
        "needsUpdate",
        "downloading",
        "pending",
      ].every((key) => typeof result.observed[key] === "boolean")
    )
      throw failure(
        "INVALID_RESPONSE",
        "Steam 回执状态无效，无法确认操作结果。",
      );
    observed = Object.fromEntries(
      ["subscribed", "installed", "needsUpdate", "downloading", "pending"].map(
        (key) => [key, result.observed[key]],
      ),
    );
    for (const key of ["downloadedBytes", "totalBytes"])
      observed[key] =
        Number.isSafeInteger(result.observed[key]) && result.observed[key] >= 0
          ? result.observed[key]
          : null;
    if (observed.downloadedBytes > observed.totalBytes)
      observed.downloadedBytes = observed.totalBytes = null;
  }
  return {
    outcome: result.outcome,
    subscription: result.subscription,
    downloadRequest: result.downloadRequest,
    observed,
    errorCode:
      typeof result.errorCode === "string" &&
      /^[A-Z_]{1,40}$/.test(result.errorCode)
        ? result.errorCode
        : null,
    error: result.error ? cleanText(result.error, 500) : null,
  };
}

function validateStoredJob(value) {
  if (value === null) return;
  if (
    !object(value) ||
    typeof value.id !== "string" ||
    !JOB_STATUSES.has(value.status) ||
    !Array.isArray(value.items) ||
    value.items.length > MAX_MEMBERS
  )
    throw new Error("invalid job");
  const seen = new Set();
  for (const item of value.items) {
    if (!object(item) || !ITEM_STATUSES.has(item.status))
      throw new Error("invalid item");
    steamId(item.id);
    if (seen.has(item.id)) throw new Error("duplicate item");
    seen.add(item.id);
  }
}

function readJournal(bytes) {
  const newline = bytes.indexOf("\n");
  let first;
  try {
    first = JSON.parse(newline < 0 ? bytes : bytes.slice(0, newline));
  } catch {
    /* Legacy v1 uses indented JSON. */
  }
  if (first?.version !== 2) {
    const legacy = JSON.parse(bytes);
    if (legacy.version !== 1) throw new Error("invalid journal version");
    validateStoredJob(legacy.job);
    return { job: legacy.job, sequence: 0, incompleteTail: false };
  }
  if (newline < 0 || first.type !== "snapshot")
    throw new Error("incomplete snapshot");
  validateStoredJob(first.job);
  const restored = first.job;
  let offset = newline + 1,
    sequence = 0;
  for (;;) {
    const end = bytes.indexOf("\n", offset);
    if (end < 0) break;
    const line = bytes.slice(offset, end);
    if (Buffer.byteLength(line) > MAX_EVENT_BYTES)
      throw new Error("oversized event");
    const event = JSON.parse(line);
    if (
      !restored ||
      !ACTIVE.has(restored.status) ||
      !object(event) ||
      event.version !== 2 ||
      event.type !== "item" ||
      event.jobId !== restored.id ||
      event.sequence !== sequence + 1 ||
      !Number.isInteger(event.index) ||
      event.index < 0 ||
      event.index >= restored.items.length ||
      sequence >= 2 * MAX_MEMBERS
    )
      throw new Error("invalid event sequence");
    const previous = restored.items[event.index],
      item = event.state;
    if (
      !object(item) ||
      Object.keys(item).some((key) => !ITEM_STATE_KEYS.has(key)) ||
      !ITEM_STATUSES.has(item.status) ||
      !(previous.status === "pending"
        ? ["checking", "skipped"].includes(item.status)
        : previous.status === "checking" &&
          ["submitted", "skipped", "failed", "unknown", "cancelled"].includes(
            item.status,
          ))
    )
      throw new Error("invalid item transition");
    restored.items[event.index] = { ...previous, ...item };
    sequence++;
    offset = end + 1;
  }
  // Only an unterminated final append can be incomplete. Never accept a bad
  // complete line or continue writing onto an uncertain tail after restart.
  if (Buffer.byteLength(bytes.slice(offset)) > MAX_EVENT_BYTES)
    throw new Error("oversized incomplete event");
  if (offset < bytes.length && !ACTIVE.has(restored?.status))
    throw new Error("unexpected tail after terminal snapshot");
  return { job: restored, sequence, incompleteTail: offset < bytes.length };
}

function createSteamMissingService({
  storageDirectory,
  getLauncherState,
  steam,
  isGameRunning = async () => false,
  assertOperationAllowed = async () => {},
}) {
  const root = path.resolve(storageDirectory),
    journal = path.join(root, "missing-mods.json");
  let initialization,
    rootIdentity,
    journalIdentity = null,
    sequence = 0,
    realRoot,
    prepared = null,
    job = null,
    occupied = false,
    disposed = false;
  let persistence = Promise.resolve();
  const sameRoot = (info) =>
    info.isDirectory() &&
    !info.isSymbolicLink() &&
    info.dev === rootIdentity.dev &&
    info.ino === rootIdentity.ino &&
    info.birthtimeMs === rootIdentity.birthtimeMs;
  async function guardRoot() {
    if (
      !sameRoot(await fs.lstat(root)) ||
      (await fs.realpath(root)) !== realRoot
    )
      throw failure(
        "JOURNAL_FAILED",
        "补齐任务记录目录发生变化，请检查后重启。",
      );
  }
  const ordinaryFile = (info) =>
    info.isFile() && !info.isSymbolicLink() && info.nlink === 1;
  const sameFile = (info, expected) =>
    expected &&
    ordinaryFile(info) &&
    ["dev", "ino", "birthtimeMs", "size", "mtimeMs", "ctimeMs"].every(
      (key) => info[key] === expected[key],
    );
  async function guardJournal() {
    await guardRoot();
    let info;
    try {
      info = await fs.lstat(journal);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (journalIdentity ? !info || !sameFile(info, journalIdentity) : info)
      throw failure(
        "JOURNAL_FAILED",
        "补齐任务记录被替换或修改，已保留文件并停止后续请求。",
      );
  }
  function persist(operation) {
    const pending = persistence.then(operation);
    persistence = pending.catch(() => {});
    return pending;
  }
  function saveSnapshot() {
    const bytes = JSON.stringify({ version: 2, type: "snapshot", job }) + "\n";
    if (Buffer.byteLength(bytes) > MAX_JOURNAL_BYTES)
      return Promise.reject(new Error("oversized snapshot"));
    return persist(async () => {
      await guardJournal();
      const temp = path.join(root, `missing-mods-${randomUUID()}.tmp`);
      const handle = await fs.open(temp, "wx");
      let replacement;
      try {
        await handle.writeFile(bytes);
        await handle.sync();
        replacement = await handle.stat();
      } finally {
        await handle.close();
      }
      await guardJournal();
      if (!sameFile(await fs.lstat(temp), replacement))
        throw new Error("snapshot changed");
      await fs.rename(temp, journal);
      const installed = await fs.lstat(journal);
      // Windows updates ctime on rename. Verify the renamed file's identity
      // and contents metadata before accepting that one expected change.
      if (
        !ordinaryFile(installed) ||
        !["dev", "ino", "birthtimeMs", "size", "mtimeMs"].every(
          (key) => installed[key] === replacement[key],
        )
      )
        throw new Error("snapshot replaced during rename");
      journalIdentity = installed;
      sequence = 0;
      await guardJournal();
    });
  }
  function saveItem(index) {
    const state = clone(
        Object.fromEntries(
          [...ITEM_STATE_KEYS].map((key) => [key, job.items[index][key]]),
        ),
      ),
      jobId = job.id;
    return persist(async () => {
      const bytes = Buffer.from(
        JSON.stringify({
          version: 2,
          type: "item",
          jobId,
          sequence: sequence + 1,
          index,
          state,
        }) + "\n",
      );
      if (
        bytes.length > MAX_EVENT_BYTES ||
        !journalIdentity ||
        journalIdentity.size + bytes.length > MAX_JOURNAL_BYTES
      )
        throw new Error("oversized event");
      await guardJournal();
      const handle = await fs.open(journal, "r+");
      try {
        if (!sameFile(await handle.stat(), journalIdentity))
          throw new Error("journal changed while opening");
        await guardJournal();
        let written = 0;
        while (written < bytes.length) {
          const { bytesWritten } = await handle.write(
            bytes,
            written,
            bytes.length - written,
            journalIdentity.size + written,
          );
          if (!bytesWritten) throw new Error("incomplete journal write");
          written += bytesWritten;
        }
        await handle.sync();
        const updated = await handle.stat();
        if (
          !ordinaryFile(updated) ||
          updated.size !== journalIdentity.size + bytes.length ||
          !["dev", "ino", "birthtimeMs"].every(
            (key) => updated[key] === journalIdentity[key],
          )
        )
          throw new Error("journal changed during append");
        await guardRoot();
        if (!sameFile(await fs.lstat(journal), updated))
          throw new Error("journal replaced during append");
        journalIdentity = updated;
        sequence++;
      } finally {
        await handle.close();
      }
    });
  }
  function initialize() {
    if (initialization) return initialization;
    initialization = (async () => {
      await fs.mkdir(root, { recursive: true });
      rootIdentity = await fs.lstat(root);
      realRoot = await fs.realpath(root);
      if (!rootIdentity.isDirectory() || rootIdentity.isSymbolicLink())
        throw new Error("补齐任务记录目录不是普通文件夹。");
      let data;
      try {
        const info = await fs.lstat(journal);
        if (!ordinaryFile(info) || info.size > MAX_JOURNAL_BYTES)
          throw new Error("invalid journal");
        const handle = await fs.open(journal, "r");
        try {
          if (!sameFile(await handle.stat(), info))
            throw new Error("journal changed while reading");
          data = readJournal(await handle.readFile("utf8"));
          if (
            !sameFile(await handle.stat(), info) ||
            !sameFile(await fs.lstat(journal), info)
          )
            throw new Error("journal changed while reading");
        } finally {
          await handle.close();
        }
        journalIdentity = info;
      } catch (error) {
        if (error.code !== "ENOENT")
          throw new Error(
            "补齐任务记录无法读取，原文件已保留，请检查 missing-mods.json。",
          );
      }
      if (data) {
        job = data.job;
        sequence = data.sequence;
        if (job && ACTIVE.has(job.status)) {
          job.status = "interrupted";
          job.error =
            "上次补齐任务已中断；不会自动重发请求，请连接 Steam 并刷新状态后重新审阅。";
          for (const item of job.items) {
            if (item.status === "checking") {
              item.status = "unknown";
              item.subscription = "unknown";
              item.downloadRequest = "unknown";
              item.error = "上次请求的结果未确认，请刷新 Steam 状态核对。";
            } else if (item.status === "pending") {
              item.status = "cancelled";
              item.error = "此项未提交，不会自动恢复。";
            }
          }
          if (data.incompleteTail)
            job.error += "记录末尾写入未完成，原文件已保留。";
        }
      }
    })().catch((error) => {
      initialization = null;
      throw error;
    });
    return initialization;
  }
  function isBusy() {
    return occupied || !!steam.isRepairing?.();
  }
  function jobSnapshot() {
    return job
      ? {
          ...clone(job),
          canCancel:
            occupied &&
            ACTIVE.has(job.status) &&
            !job.cancelRequested &&
            !disposed,
        }
      : null;
  }
  async function allowed() {
    await assertOperationAllowed();
    if (await isGameRunning())
      throw failure("GAME_RUNNING", "请先退出游戏，再补齐工坊模组。");
    await assertOperationAllowed();
  }
  function stopPending(reason) {
    for (const item of job.items)
      if (item.status === "pending") {
        item.status = "cancelled";
        item.error = reason;
      }
  }
  function stopRequested() {
    return disposed || job.cancelRequested;
  }
  async function run(available) {
    try {
      job.status = "running";
      for (const [index, item] of job.items.entries()) {
        if (stopRequested()) break;
        try {
          await allowed();
        } catch {
          job.status = "blocked";
          job.error = "游戏已运行或目录操作暂不可用，已停止后续补齐请求。";
          break;
        }
        if (stopRequested()) break;
        if (available.has(`workshop:${item.id}`)) {
          item.status = "skipped";
          item.error = "文件已可用，未提交请求。";
          await saveItem(index);
          continue;
        }
        // Persist the uncertain boundary before sending anything to the worker.
        item.status = "checking";
        await saveItem(index);
        if (stopRequested()) {
          item.status = "cancelled";
          item.error = "此项尚未提交。";
          break;
        }
        try {
          await allowed();
        } catch {
          item.status = "cancelled";
          item.error = "此项尚未提交。";
          job.status = "blocked";
          job.error = "游戏已运行或目录操作暂不可用，已停止后续补齐请求。";
          break;
        }
        if (stopRequested()) {
          item.status = "cancelled";
          item.error = "此项尚未提交。";
          break;
        }
        let result;
        try {
          result = checkedResult(
            await steam.call("repairItem", {
              id: item.id,
              expectedSteamId: job.account.steamId,
            }),
            item.id,
          );
        } catch {
          item.status = "unknown";
          item.subscription = "unknown";
          item.downloadRequest = "unknown";
          item.error =
            "Steam 请求结果未确认；请等待当前请求结束并刷新状态，勿重复提交。";
          job.status = "interrupted";
          job.error = "连接中断或请求超时，已停止提交后续模组。";
          break;
        }
        Object.assign(item, result, {
          status:
            result.outcome === "already-present" ? "skipped" : result.outcome,
        });
        delete item.outcome;
        await saveItem(index);
        if (ACTOR_ERRORS.has(result.errorCode)) {
          job.status = "blocked";
          job.error =
            result.error || "Steam 账号或游戏身份变化，已停止后续请求。";
          break;
        }
        if (result.outcome === "unknown") {
          job.status = "interrupted";
          job.error = "当前模组的请求结果未知，已停止后续请求，请先刷新核对。";
          break;
        }
      }
      if (ACTIVE.has(job.status)) {
        if (disposed) job.status = "interrupted";
        else if (job.cancelRequested) job.status = "cancelled";
        else
          job.status = job.items.some((item) => item.status === "failed")
            ? "partial"
            : "completed";
      }
      stopPending("此项未提交；如仍需补齐，请重新审阅计划。");
      job.finishedAt = new Date().toISOString();
      await saveSnapshot();
    } catch {
      job.status = "interrupted";
      job.error =
        "任务记录无法保存，已停止后续请求；请刷新 Steam 状态核对已提交项。";
      for (const item of job.items)
        if (item.status === "checking") {
          item.status = "cancelled";
          item.error = "记录保存失败，此项尚未提交。";
        }
      stopPending("此项未提交。");
      try {
        await saveSnapshot();
      } catch {
        /* The previous durable boundary remains usable without replay. */
      }
    } finally {
      occupied = false;
    }
  }
  return {
    async prepare(input) {
      if (
        !object(input) ||
        Object.keys(input).some((key) => key !== "playsetId") ||
        typeof input.playsetId !== "string" ||
        !input.playsetId ||
        input.playsetId.length > 120
      )
        throw new Error("请选择有效的预设。");
      if (disposed) throw new Error("补齐服务已关闭。");
      if (isBusy()) throw new Error("已有补齐或 Steam 请求，请等待完成。");
      occupied = true;
      prepared = null;
      try {
        await initialize();
        await allowed();
        const current = await getLauncherState();
        const context = playsetContext(current, input.playsetId);
        if (!context.items.length)
          throw new Error("此预设没有缺失的 Steam 模组。");
        const account = actor(await steam.call("getState"));
        await allowed();
        if (disposed) throw new Error("补齐服务已关闭。");
        const next = playsetContext(await getLauncherState(), input.playsetId);
        if (next.fingerprint !== context.fingerprint)
          throw new Error("预设或游戏目录已变化，请重新准备补齐计划。");
        const plan = {
          id: randomUUID(),
          playsetId: input.playsetId,
          playsetName: context.playsetName,
          items: context.items,
          account,
        };
        prepared = { plan, fingerprint: context.fingerprint };
        return clone(plan);
      } finally {
        occupied = false;
      }
    },
    async commit(planId) {
      if (disposed) throw new Error("补齐服务已关闭。");
      if (isBusy()) throw new Error("已有补齐或 Steam 请求，请等待完成。");
      occupied = true;
      try {
        await initialize();
        if (
          typeof planId !== "string" ||
          !prepared ||
          prepared.plan.id !== planId
        )
          throw new Error("补齐计划已失效或已提交，请重新审阅。");
        const selection = prepared;
        await allowed();
        const context = playsetContext(
          await getLauncherState(),
          selection.plan.playsetId,
        );
        if (context.fingerprint !== selection.fingerprint) {
          prepared = null;
          throw new Error("预设或游戏目录已变化，请重新准备补齐计划。");
        }
        if (disposed) throw new Error("补齐服务已关闭。");
        prepared = null;
        job = {
          id: randomUUID(),
          planId,
          playsetId: selection.plan.playsetId,
          playsetName: selection.plan.playsetName,
          account: clone(selection.plan.account),
          status: "queued",
          cancelRequested: false,
          error: null,
          createdAt: new Date().toISOString(),
          items: selection.plan.items.map((item) => ({
            ...item,
            status: "pending",
            subscription: "unchanged",
            downloadRequest: "not-requested",
            observed: null,
            errorCode: null,
            error: null,
          })),
        };
        await saveSnapshot();
        const snapshot = jobSnapshot();
        void run(context.available);
        return snapshot;
      } catch (error) {
        occupied = false;
        if (job?.status === "queued" && !prepared) {
          job.status = "interrupted";
          job.error = "任务未能保存，尚未提交请求。";
          stopPending("此项未提交。");
        }
        throw error;
      }
    },
    async getState() {
      await initialize();
      return {
        job: jobSnapshot(),
        plan: prepared ? clone(prepared.plan) : null,
      };
    },
    async cancel() {
      await initialize();
      prepared = null;
      if (job && occupied && ACTIVE.has(job.status)) {
        job.cancelRequested = true;
        job.status = "cancelling";
      }
      return jobSnapshot();
    },
    isBusy,
    dispose() {
      disposed = true;
      prepared = null;
    },
  };
}
module.exports = { createSteamMissingService };
