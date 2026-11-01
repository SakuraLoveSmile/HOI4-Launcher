"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const data = require("./managed-data.cjs");
const {
  captureEnvironment,
  fingerprintMods,
  compareEnvironments,
  validateEnvironment,
} = require("./launch-environment.cjs");
const MAX_RECORD = 16 * 1024 ** 2;
const clone = (v) => JSON.parse(JSON.stringify(v));
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
function title(v) {
  if (
    typeof v !== "string" ||
    !v.trim() ||
    v.trim().length > 128 ||
    /[\0-\x1f]/.test(v)
  )
    throw new Error("战役名称须为 1 至 128 个字符。");
  return v.trim();
}
function notes(v = "") {
  if (
    typeof v !== "string" ||
    v.length > 4000 ||
    /[\0\x01-\x08\x0b\x0c\x0e-\x1f]/.test(v)
  )
    throw new Error("战役备注最多 4000 个字符。");
  return v;
}
function identifier(v) {
  if (!data.UUID.test(v || "")) throw new Error("战役标识无效。");
  return v;
}
function saveName(v) {
  if (
    typeof v !== "string" ||
    !v ||
    v.length > 1024 ||
    path.isAbsolute(v) ||
    /[\0-\x1f<>:"|?*]/.test(v) ||
    v
      .split(/[\\/]/)
      .some((p) => !p || p === "." || p === ".." || /[. ]$/.test(p)) ||
    !/\.hoi4$/i.test(v)
  )
    throw new Error("请选择当前版本存档目录中的 HOI4 本地存档。");
  return v.replace(/\\/g, "/");
}

function createCampaignService({
  storageDirectory,
  launcher,
  isGameRunning = async () => false,
  now = () => new Date().toISOString(),
}) {
  const root = path.resolve(storageDirectory),
    records = path.join(root, "records");
  let queue = Promise.resolve(),
    busy = false,
    progress = null,
    aborter = null;
  const reviews = new Map();
  function serial(mutation, fn) {
    const task = queue.then(async () => {
      if (mutation && (await isGameRunning()))
        throw new Error("请先退出游戏，再修改战役档案或存档。");
      busy = true;
      try {
        return await fn();
      } finally {
        busy = false;
        progress = null;
        aborter = null;
      }
    });
    queue = task.catch(() => {});
    return task;
  }
  const recordPath = (id) => path.join(records, identifier(id) + ".json");
  function validate(value, id) {
    if (
      !object(value) ||
      value.schemaVersion !== 1 ||
      value.id !== id ||
      !data.UUID.test(id) ||
      title(value.name) !== value.name ||
      notes(value.notes) !== value.notes ||
      !path.isAbsolute(value.userData || "") ||
      typeof value.instanceId !== "string" ||
      !Array.isArray(value.backups) ||
      value.backups.length > 100 ||
      !Array.isArray(value.history) ||
      value.history.length > 20 ||
      !Number.isFinite(Date.parse(value.createdAt)) ||
      !Number.isFinite(Date.parse(value.updatedAt))
    )
      throw new Error("战役档案损坏，原始文件已保留。");
    saveName(value.filename);
    validateEnvironment(value.environment);
    for (const item of value.history) validateEnvironment(item.environment);
    for (const item of value.backups)
      if (
        !object(item) ||
        !data.UUID.test(item.id || "") ||
        !/^[a-f0-9]{64}$/.test(item.sha256 || "") ||
        !Number.isSafeInteger(item.bytes) ||
        item.bytes < 0 ||
        item.bytes > 4 * 1024 ** 3 ||
        !Number.isFinite(Date.parse(item.createdAt))
      )
        throw new Error("存档备份记录损坏，原始文件已保留。");
    return value;
  }
  async function load(id) {
    const bytes = await data.read(recordPath(id), MAX_RECORD);
    return { record: validate(JSON.parse(bytes), id), bytes };
  }
  async function save(record, previous = null) {
    validate(record, record.id);
    const bytes = Buffer.from(JSON.stringify(record, null, 2) + "\n");
    if (bytes.length > MAX_RECORD) throw new Error("战役记录超过大小限制。");
    await data.atomic(recordPath(record.id), bytes, previous);
  }
  async function context(record) {
    const state = await launcher.getState();
    if (
      record &&
      (record.instanceId !== state.settings.activeGameInstanceId ||
        !data.samePath(record.userData, state.paths.userData))
    )
      throw new Error("战役属于其他版本实例，请先切回对应版本。");
    return state;
  }
  async function savedFile(record, allowMissing = false) {
    const base = path.join(record.userData, "save games"),
      target = path.resolve(base, saveName(record.filename));
    if (!data.inside(base, target))
      throw new Error("存档路径超出当前版本目录。");
    try {
      await data.file(target, 4 * 1024 ** 3);
    } catch (error) {
      if (!(allowMissing && error.code === "ENOENT")) throw error;
    }
    return target;
  }
  async function capture(state) {
    aborter = new AbortController();
    try {
      const fingerprints = await fingerprintMods(state, {
        signal: aborter.signal,
        onProgress: (value) => {
          progress = value;
        },
      });
      return captureEnvironment(state, { fingerprints });
    } finally {
      aborter = null;
      progress = null;
    }
  }
  async function scanRecords(state) {
    let entries;
    try {
      await data.directory(records);
      entries = await fs.readdir(records, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return { campaigns: [], notices: [] };
      throw error;
    }
    const selected = entries.filter(
      (e) =>
        data.UUID.test(e.name.replace(/\.json$/, "")) &&
        e.name.endsWith(".json"),
    );
    if (selected.length > 500)
      throw new Error("战役档案超过 500 项，请整理后重试。");
    let totalRecordBytes = 0;
    const campaigns = [],
      notices = [];
    for (const entry of selected) {
      try {
        const stat = await data.file(
          recordPath(entry.name.slice(0, -5)),
          MAX_RECORD,
        );
        totalRecordBytes += stat.size;
        if (totalRecordBytes > 64 * 1024 ** 2)
          throw new Error("战役档案总量超过读取限制，请整理后重试。");
        const { record } = await load(entry.name.slice(0, -5));
        if (
          record.instanceId !== state.settings.activeGameInstanceId ||
          !data.samePath(record.userData, state.paths.userData)
        )
          continue;
        let available = true;
        try {
          await savedFile(record);
        } catch {
          available = false;
        }
        campaigns.push({
          ...record,
          available,
          changes: compareEnvironments(
            record.environment,
            captureEnvironment(state),
          ).filter((c) => c.kind !== "unverified"),
        });
      } catch {
        notices.push("部分战役档案无法读取，原始文件已保留。");
      }
    }
    return {
      campaigns: campaigns.sort((a, b) =>
        b.updatedAt.localeCompare(a.updatedAt),
      ),
      notices: [...new Set(notices)],
    };
  }
  async function review(id) {
    const { record, bytes } = await load(id),
      state = await context(record);
    await savedFile(record);
    const environment = await capture(state);
    const refreshed = await context(record);
    if (
      captureEnvironment(refreshed).configurationId !==
      captureEnvironment(state).configurationId
    )
      throw new Error("配置在检查期间发生变化，请重新检查。");
    const reviewId = randomUUID();
    const result = {
      reviewId,
      campaign: record,
      environment,
      changes: compareEnvironments(record.environment, environment),
      checkedAt: now(),
    };
    reviews.set(reviewId, {
      id,
      configurationId: environment.configurationId,
      recordDigest: data.sha256(bytes),
      expires: Date.now() + 10 * 60 * 1000,
    });
    if (reviews.size > 20) reviews.delete(reviews.keys().next().value);
    return result;
  }
  async function backupInner(record, source) {
    if (record.backups.length >= 100)
      throw new Error("此战役已保留 100 份备份，请先导出整理。");
    const id = randomUUID(),
      target = path.join(root, "backups", record.id, id + ".hoi4");
    const proof = await data.copyFile(source, target);
    const item = { id, ...proof, createdAt: now() };
    record.backups.push(item);
    return item;
  }
  return {
    isBusy: () => busy,
    getProgress: () => ({ busy, progress, canCancel: !!aborter }),
    cancel: () => {
      if (!aborter) return false;
      aborter.abort();
      return true;
    },
    list: () => serial(false, async () => scanRecords(await context())),
    bind: ({ savePath, name, notes: remark = "" }) =>
      serial(true, async () => {
        const state = await context();
        if (!state.game.found)
          throw new Error("请先选择有效的 HOI4 游戏目录。");
        const base = path.join(state.paths.userData, "save games");
        if (!path.isAbsolute(savePath || "") || !data.inside(base, savePath))
          throw new Error("请选择当前版本存档目录中的 HOI4 本地存档。");
        const filename = saveName(path.relative(base, savePath));
        const list = await scanRecords(state);
        if (
          list.campaigns.some(
            (c) => c.filename.toLowerCase() === filename.toLowerCase(),
          )
        )
          throw new Error("这个存档已经有战役档案，请选择已有档案。");
        const record = {
          schemaVersion: 1,
          id: randomUUID(),
          name: title(name || path.basename(filename, ".hoi4")),
          notes: notes(remark),
          instanceId: state.settings.activeGameInstanceId,
          userData: state.paths.userData,
          filename,
          createdAt: now(),
          updatedAt: now(),
          environment: await capture(state),
          history: [],
          backups: [],
        };
        await backupInner(record, await savedFile(record));
        const current = await context(record);
        if (
          captureEnvironment(current).configurationId !==
          captureEnvironment(state).configurationId
        )
          throw new Error("配置在检查期间发生变化，请重新检查。");
        await save(record);
        return record;
      }),
    update: (id, input) =>
      serial(true, async () => {
        if (
          !object(input) ||
          Object.keys(input).some((k) => !["name", "notes"].includes(k))
        )
          throw new Error("战役编辑参数无效。");
        const { record, bytes } = await load(id);
        await context(record);
        record.name = title(input.name);
        record.notes = notes(input.notes);
        record.updatedAt = now();
        await save(record, bytes);
        return record;
      }),
    review: (id) => serial(false, () => review(id)),
    reviewCurrent: () =>
      serial(false, async () => {
        const state = await context(),
          current = state.continueGame;
        if (!current?.available || current.remote) return null;
        const { campaigns, notices } = await scanRecords(state);
        const found = campaigns.find(
          (c) =>
            c.filename.toLowerCase() ===
            current.filename.replace(/\\/g, "/").toLowerCase(),
        );
        if (found) return review(found.id);
        if (notices.length) throw new Error(notices[0]);
        return null;
      }),
    resolveContinue: (id, reviewId) =>
      serial(false, async () => {
        const checked = reviews.get(reviewId);
        if (!checked || checked.id !== id || checked.expires < Date.now())
          throw new Error("检查结果已过期，请重新检查战役配置。");
        const { record, bytes } = await load(id),
          state = await context(record);
        if (data.sha256(bytes) !== checked.recordDigest)
          throw new Error("战役记录已变化，请重新检查后继续。");
        await savedFile(record);
        const environment = await capture(state);
        const latest = await context(record);
        if (
          environment.configurationId !== checked.configurationId ||
          captureEnvironment(latest).configurationId !==
            captureEnvironment(state).configurationId
        )
          throw new Error("配置已变化，请重新检查后继续。");
        reviews.delete(reviewId);
        return { filename: record.filename, title: record.name, environment };
      }),
    acceptEnvironment: (id) =>
      serial(true, async () => {
        const { record, bytes } = await load(id),
          state = await context(record);
        record.history.push({
          at: record.updatedAt,
          environment: record.environment,
        });
        record.history = record.history.slice(-20);
        record.environment = await capture(state);
        const latest = await context(record);
        if (
          captureEnvironment(latest).configurationId !==
          captureEnvironment(state).configurationId
        )
          throw new Error("配置在检查期间发生变化，请重新检查。");
        record.updatedAt = now();
        await save(record, bytes);
        return record;
      }),
    restoreConfiguration: (id) =>
      serial(true, async () => {
        const { record } = await load(id),
          state = await context(record),
          env = record.environment;
        if (state.settings.playsets.length >= 100)
          throw new Error("播放集已达 100 项，请先整理。");
        const playset = {
          ...clone(env.playset),
          id: "campaign-" + randomUUID(),
          name: title(record.name.slice(0, 110) + " · 恢复配置"),
          disabledDlcIds: (state.dlc?.items || [])
            .filter((d) => !env.dlcIds.includes(d.id))
            .map((d) => d.id),
        };
        await launcher.saveSettings({
          playsets: [...state.settings.playsets, playset],
          activePlaysetId: playset.id,
          gameOptions: env.gameOptions,
          launchMode: env.launchMode,
        });
        return launcher.getState();
      }),
    backup: (id) =>
      serial(true, async () => {
        const { record, bytes } = await load(id);
        await context(record);
        const result = await backupInner(record, await savedFile(record));
        record.updatedAt = now();
        await save(record, bytes);
        return result;
      }),
    restoreBackup: (id, backupId) =>
      serial(true, async () => {
        const { record, bytes } = await load(id);
        await context(record);
        const item = record.backups.find((b) => b.id === identifier(backupId));
        if (!item) throw new Error("找不到选中的存档备份。");
        const source = path.join(root, "backups", id, item.id + ".hoi4");
        const proof = await data.digestFile(source);
        if (proof.bytes !== item.bytes || proof.sha256 !== item.sha256)
          throw new Error("备份摘要不匹配，现有存档未修改。");
        const target = await savedFile(record, true);
        let current = null;
        try {
          current = await data.digestFile(target);
          await backupInner(record, target);
        } catch (e) {
          if (e.code !== "ENOENT") throw e;
        }
        // Persist the rescue backup before replacing the player's current save.
        record.updatedAt = now();
        await save(record, bytes);
        const temporary = path.join(
          path.dirname(target),
          ".ironclad-restore-" + randomUUID(),
        );
        const copied = await data.copyFile(source, temporary);
        if (copied.sha256 !== item.sha256)
          throw new Error("备份在恢复期间发生变化，现有存档未修改。");
        let latest = null;
        try {
          latest = await data.digestFile(target);
        } catch (e) {
          if (e.code !== "ENOENT") throw e;
        }
        if (JSON.stringify(current) !== JSON.stringify(latest))
          throw new Error("当前存档被外部修改，恢复已停止，文件均已保留。");
        await data.directory(path.dirname(target));
        if (current) {
          // Preserve the file actually present at commit, including a late
          // external write. Exclusive installation never overwrites a new save.
          const retained = path.join(
            path.dirname(target),
            ".ironclad-before-restore-" + randomUUID() + ".hoi4",
          );
          await fs.rename(target, retained);
          const moved = await data.digestFile(retained);
          if (JSON.stringify(moved) !== JSON.stringify(current)) {
            try {
              await data.installExclusive(retained, target);
            } catch {}
            throw new Error("当前存档被外部修改，恢复已停止，文件均已保留。");
          }
        }
        await data.installExclusive(temporary, target);
        return record;
      }),
    resolveSave: (id) =>
      serial(false, async () => {
        const { record } = await load(id);
        await context(record);
        return savedFile(record);
      }),
  };
}
module.exports = { createCampaignService, campaignSaveName: saveName };
