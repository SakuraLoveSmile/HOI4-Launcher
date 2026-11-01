"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID, createHash } = require("node:crypto");
const { spawn } = require("node:child_process");
const { TextDecoder } = require("node:util");
const data = require("./managed-data.cjs");
const {
  validateEnvironment,
  compareEnvironments,
} = require("./launch-environment.cjs");

const INTERVAL_MS = 5000;
const HISTORY_LIMIT = 100;
const MAX_TREND_POINTS = 1200;
const MAX_TREND_BYTES = 2 * 1024 * 1024;
const MAX_RECORD_BYTES = 64 * 1024;
const MAX_MONITOR_BYTES = 8 * 1024 * 1024;
const MAX_ENVIRONMENT_BYTES = 32 * 1024 * 1024;
const MAX_NOTES_CHARACTERS = 4000;
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const STATUSES = new Set([
  "recording",
  "completed",
  "interrupted",
  "unavailable",
  "stale",
]);
const NOTICES = {
  monitor: "性能采集器不可用，请重新安装启动器。",
  corrupt: "部分游戏统计记录无法读取，原始文件已保留。",
  start: "性能采集启动失败，本次游戏仍可正常运行。",
  environmentMissing: "此统计记录未保存完整启动配置，无法比较配置。",
  environmentCorrupt: "启动配置记录无法读取，原始文件已保留。",
  annotationCorrupt: "统计备注无法读取，原始文件已保留。",
  comparisonUnavailable:
    "至少一条统计记录缺少可读取的完整启动配置，无法比较配置。",
};

const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const finite = (value, max = Number.MAX_SAFE_INTEGER) =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= max;
const text = (value, max = 256) =>
  typeof value === "string" && value.length <= max && !/[\0-\x1f]/.test(value);
const instant = (value) =>
  text(value, 48) && /Z$/.test(value) && Number.isFinite(Date.parse(value));
const samePath = (a, b) =>
  process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
const notesText = (value) =>
  typeof value === "string" &&
  value.length <= MAX_NOTES_CHARACTERS &&
  !/[\0-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(value);
const exactKeys = (value, keys) =>
  object(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const parseJsonBytes = (bytes) =>
  JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));

async function safeDirectory(directory, allowMissing = false) {
  const absolute = path.resolve(directory);
  for (let current = absolute; ; current = path.dirname(current)) {
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory())
        throw new Error("Unsafe statistics directory.");
    } catch (error) {
      if (!(allowMissing && error.code === "ENOENT")) throw error;
    }
    if (path.dirname(current) === current) break;
  }
  return absolute;
}

async function readBounded(file, limit, optional = false, binary = false) {
  let handle;
  try {
    await safeDirectory(path.dirname(file));
    const before = await fs.lstat(file);
    if (
      before.isSymbolicLink() ||
      !before.isFile() ||
      before.nlink !== 1 ||
      before.size > limit
    )
      throw new Error("Unsafe or oversized statistics file.");
    handle = await fs.open(file, "r");
    const identity = await handle.stat();
    if (
      identity.ino !== before.ino ||
      identity.dev !== before.dev ||
      identity.nlink !== 1 ||
      identity.size !== before.size
    )
      throw new Error("Statistics file changed while opening.");
    const bytes = Buffer.alloc(identity.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (!bytesRead) throw new Error("Truncated statistics file.");
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (
      after.size !== identity.size ||
      after.mtimeMs !== identity.mtimeMs ||
      after.nlink !== 1
    )
      throw new Error("Statistics file changed while reading.");
    await safeDirectory(path.dirname(file));
    return binary ? bytes : bytes.toString("utf8");
  } catch (error) {
    if (optional && error.code === "ENOENT") return null;
    throw error;
  } finally {
    await handle?.close();
  }
}

async function atomicJson(file, value) {
  await safeDirectory(path.dirname(file));
  try {
    const previous = await fs.lstat(file);
    if (!previous.isFile() || previous.isSymbolicLink() || previous.nlink !== 1)
      throw new Error("Unsafe statistics file.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const temporary = path.join(path.dirname(file), ".write-" + randomUUID());
  let handle;
  try {
    handle = await fs.open(temporary, "wx");
    await handle.writeFile(JSON.stringify(value) + "\n", "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await safeDirectory(path.dirname(file));
    await fs.rename(temporary, file);
  } finally {
    await handle?.close();
    await fs.unlink(temporary).catch(() => {});
  }
}

function parseSummary(value, id, now, intervalMs) {
  if (
    !object(value) ||
    value.schemaVersion !== 1 ||
    value.id !== id ||
    !STATUSES.has(value.status) ||
    !instant(value.startedAt) ||
    !(value.endedAt === null || instant(value.endedAt)) ||
    !(value.lastSampleAt === null || instant(value.lastSampleAt)) ||
    !finite(value.durationMs) ||
    !Number.isSafeInteger(value.sampleCount) ||
    value.sampleCount < 0
  )
    throw new Error("Invalid statistics summary.");
  const result = {
    id,
    status: value.status,
    startedAt: value.startedAt,
    endedAt: value.endedAt,
    lastSampleAt: value.lastSampleAt,
    durationMs: value.durationMs,
    sampleCount: value.sampleCount,
  };
  for (const key of [
    "cpuAveragePercent",
    "cpuPeakPercent",
    "memoryAverageBytes",
    "memoryPeakBytes",
    "privateMemoryAverageBytes",
    "privateMemoryPeakBytes",
  ]) {
    if (
      !(
        value[key] === null ||
        finite(value[key], key.startsWith("cpu") ? 100 : undefined)
      )
    )
      throw new Error("Invalid statistics metric.");
    result[key] = value[key];
  }
  for (const key of [
    "gameVersion",
    "instanceId",
    "instanceName",
    "playsetId",
    "playsetName",
  ]) {
    if (!(value[key] === null || text(value[key])))
      throw new Error("Invalid statistics metadata.");
    result[key] = value[key];
  }
  if (
    !Number.isSafeInteger(value.modCount) ||
    value.modCount < 0 ||
    value.modCount > 100000 ||
    !(
      value.logicalCpuCount === null ||
      (Number.isInteger(value.logicalCpuCount) &&
        value.logicalCpuCount >= 1 &&
        value.logicalCpuCount <= 4096)
    )
  )
    throw new Error("Invalid statistics context.");
  result.modCount = value.modCount;
  result.logicalCpuCount = value.logicalCpuCount;
  result.launchMode = ["normal", "debug"].includes(value.launchMode)
    ? value.launchMode
    : "normal";
  if (
    value.processStartedAt !== undefined &&
    !(value.processStartedAt === null || instant(value.processStartedAt))
  )
    throw new Error("Invalid process identity.");
  if (
    value.processStartTicks !== undefined &&
    !(
      value.processStartTicks === null ||
      (typeof value.processStartTicks === "string" &&
        /^\d{1,20}$/.test(value.processStartTicks))
    )
  )
    throw new Error("Invalid process identity.");
  if (
    value.failureReason !== undefined &&
    !(
      value.failureReason === null ||
      (typeof value.failureReason === "string" &&
        /^[a-z0-9-]{1,64}$/.test(value.failureReason))
    )
  )
    throw new Error("Invalid statistics status.");
  result.processStartedAt = value.processStartedAt || null;
  result.processStartTicks = value.processStartTicks || null;
  result.failureReason = value.failureReason || null;
  result.samplingGapCount =
    Number.isSafeInteger(value.samplingGapCount) && value.samplingGapCount >= 0
      ? value.samplingGapCount
      : 0;
  result.trendDownsampled = value.trendDownsampled === true;
  if (
    result.status === "recording" &&
    now - Date.parse(result.lastSampleAt || result.startedAt) >
      Math.max(30000, intervalMs * 4)
  )
    result.status = "stale";
  return result;
}

function downsample(samples) {
  let result = samples;
  while (result.length > MAX_TREND_POINTS) {
    const next = [result[0]];
    for (let index = 1; index < result.length - 1; index += 2) {
      const a = result[index],
        b = result[index + 1];
      if (index + 1 === result.length - 1) {
        next.push(a);
        continue;
      }
      const point = { elapsedMs: (a.elapsedMs + b.elapsedMs) / 2 };
      for (const key of ["cpuPercent", "memoryBytes", "privateMemoryBytes"])
        point[key] =
          a[key] === null || b[key] === null ? null : (a[key] + b[key]) / 2;
      next.push(point);
    }
    next.push(result[result.length - 1]);
    result = next;
  }
  return result;
}

function createGamePerformanceService({
  storageDirectory,
  monitorPath,
  spawnProcess = spawn,
  now = Date.now,
  platform = process.platform,
  sampleIntervalMs = INTERVAL_MS,
} = {}) {
  if (!storageDirectory || !path.isAbsolute(storageDirectory))
    throw new Error("A statistics storage directory is required.");
  if (!monitorPath || !path.isAbsolute(monitorPath))
    throw new Error("A performance monitor path is required.");
  if (
    !Number.isInteger(sampleIntervalMs) ||
    sampleIntervalMs < 250 ||
    sampleIntervalMs > 60000
  )
    throw new Error("Invalid sampling interval.");
  const root = path.resolve(storageDirectory);
  const sessionsDirectory = path.join(root, "sessions");
  const settingsPath = path.join(root, "settings.json");
  const indexPath = path.join(root, "index.json");
  let settings;
  let notice = null;
  let queue = Promise.resolve();
  const serialize = (operation) => {
    const result = queue.then(operation, operation);
    queue = result.catch(() => {});
    return result;
  };
  const corrupt = () => {
    notice = NOTICES.corrupt;
  };

  async function readyDirectory(directory) {
    await safeDirectory(directory, true);
    await fs.mkdir(directory, { recursive: true });
    await safeDirectory(directory);
  }
  function parseSettings(value) {
    if (
      !object(value) ||
      value.schemaVersion !== 1 ||
      typeof value.enabled !== "boolean"
    )
      throw new Error("Invalid performance settings.");
    return { schemaVersion: 1, enabled: value.enabled };
  }
  function parseIndex(value) {
    if (
      !object(value) ||
      value.schemaVersion !== 1 ||
      !Array.isArray(value.sessions) ||
      value.sessions.length > HISTORY_LIMIT
    )
      throw new Error("Invalid statistics index.");
    const seen = new Set();
    for (const item of value.sessions) {
      if (
        !object(item) ||
        !ID.test(item.id) ||
        !instant(item.startedAt) ||
        seen.has(item.id)
      )
        throw new Error("Invalid statistics index entry.");
      seen.add(item.id);
    }
    return value.sessions;
  }
  async function preserveInvalidBeforeWrite(file, limit, parse) {
    const original = await readBounded(file, limit, true, true);
    if (original === null) return;
    try {
      parse(JSON.parse(original.toString("utf8")));
      return;
    } catch {
      corrupt();
    }
    // Explicit recovery may replace the live file, but never loses its original
    // bytes. Unknown links and damaged existing backups are never overwritten.
    const directory = path.join(root, "corrupt-backups");
    await readyDirectory(directory);
    const digest = createHash("sha256").update(original).digest("hex");
    const backup = path.join(
      directory,
      path.basename(file) + "." + digest + ".bak",
    );
    let handle;
    try {
      try {
        handle = await fs.open(backup, "wx");
        await handle.writeFile(original);
        await handle.sync();
        await handle.close();
        handle = null;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      const retained = await readBounded(backup, limit, false, true);
      if (!retained.equals(original))
        throw new Error("Statistics backup changed.");
    } finally {
      await handle?.close();
    }
  }
  async function loadSettings() {
    if (settings) return settings;
    try {
      const saved = await readBounded(settingsPath, MAX_RECORD_BYTES, true);
      settings = parseSettings(
        saved === null
          ? { schemaVersion: 1, enabled: true }
          : JSON.parse(saved),
      );
    } catch {
      corrupt();
      settings = { schemaVersion: 1, enabled: false };
    }
    return settings;
  }
  async function supported() {
    if (platform !== "win32") return false;
    try {
      const parent = path.dirname(monitorPath);
      await safeDirectory(parent);
      const stat = await fs.lstat(monitorPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
        return false;
      const real = await fs.realpath(monitorPath);
      return samePath(path.resolve(monitorPath), real);
    } catch {
      return false;
    }
  }
  async function persistentMonitor() {
    // Portable launcher resources can disappear as soon as its wrapper exits.
    // Execute an independently verified, immutable copy in persistent app storage.
    const source = await readBounded(
      monitorPath,
      MAX_MONITOR_BYTES,
      false,
      true,
    );
    if (source.length < 64 || source.toString("ascii", 0, 2) !== "MZ")
      throw new Error("Invalid performance monitor image.");
    const pe = source.readUInt32LE(0x3c);
    if (
      pe > source.length - 4 ||
      source.toString("ascii", pe, pe + 4) !== "PE\0\0"
    )
      throw new Error("Invalid performance monitor image.");
    const digest = createHash("sha256").update(source).digest("hex");
    const directory = path.join(root, "monitors");
    await readyDirectory(directory);
    const target = path.join(directory, digest + ".exe");
    let handle;
    try {
      try {
        handle = await fs.open(target, "wx");
        await handle.writeFile(source);
        await handle.sync();
        await handle.close();
        handle = null;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      const cached = await readBounded(target, MAX_MONITOR_BYTES, false, true);
      if (createHash("sha256").update(cached).digest("hex") !== digest)
        throw new Error("Performance monitor cache changed.");
      return target;
    } catch (error) {
      error.code = "PERFORMANCE_MONITOR_CACHE_INVALID";
      throw error;
    } finally {
      await handle?.close();
    }
  }
  async function readIndex() {
    try {
      const source = await readBounded(indexPath, 128 * 1024, true);
      if (source === null) return [];
      return parseIndex(JSON.parse(source));
    } catch {
      corrupt();
      // Recover a bounded view without rewriting or removing the damaged index.
      const candidates = [];
      let directory;
      try {
        await safeDirectory(sessionsDirectory);
        directory = await fs.opendir(sessionsDirectory);
        let examined = 0;
        for await (const item of directory) {
          if (++examined > 5000) break;
          if (!item.isDirectory() || !ID.test(item.name)) continue;
          const stat = await fs.lstat(path.join(sessionsDirectory, item.name));
          if (stat.isSymbolicLink()) continue;
          candidates.push({
            id: item.name,
            at: stat.birthtimeMs || stat.mtimeMs,
          });
        }
        return candidates
          .sort((a, b) => b.at - a.at)
          .slice(0, HISTORY_LIMIT)
          .map((item) => ({
            id: item.id,
            startedAt: new Date(item.at).toISOString(),
          }));
      } catch {
        return [];
      }
    }
  }
  async function summary(id) {
    if (typeof id !== "string" || !ID.test(id)) return null;
    const file = path.join(sessionsDirectory, id, "summary.json");
    try {
      const source = await readBounded(file, MAX_RECORD_BYTES, true);
      if (source === null) return null;
      return parseSummary(JSON.parse(source), id, now(), sampleIntervalMs);
    } catch {
      corrupt();
      return null;
    }
  }
  async function getState() {
    const config = await loadSettings();
    const available = await supported();
    const entries = await readIndex();
    const sessions = [];
    // Bounded batches avoid one process or unbounded file handles per history item.
    for (let index = 0; index < entries.length; index += 10) {
      const batch = await Promise.all(
        entries.slice(index, index + 10).map((entry) => summary(entry.id)),
      );
      sessions.push(...batch.filter(Boolean));
    }
    sessions.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
    return {
      enabled: config.enabled,
      supported: available,
      intervalMs: sampleIntervalMs,
      sessions,
      notice: notice || (config.enabled && !available ? NOTICES.monitor : null),
    };
  }
  async function metrics(id) {
    let current = await summary(id);
    if (!current) return null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const source = await readBounded(
          path.join(sessionsDirectory, id, "samples.jsonl"),
          MAX_TREND_BYTES,
          true,
        );
        if (source === null) return { ...current, samples: [] };
        const lines = source.split("\n");
        const complete = lines.pop();
        if (complete) corrupt(); // Preserve earlier complete samples after a torn final append.
        if (!lines.length || lines.length > 2502)
          throw new Error("Invalid statistics trend.");
        const header = JSON.parse(lines.shift());
        if (
          !object(header) ||
          header.schemaVersion !== 1 ||
          header.id !== id ||
          typeof header.trendDownsampled !== "boolean"
        )
          throw new Error("Invalid statistics trend header.");
        const samples = [];
        let previousElapsed = -1;
        let previousSample = 0;
        for (const line of lines) {
          if (!line) throw new Error("Invalid empty statistics sample.");
          const point = JSON.parse(line);
          if (
            !object(point) ||
            !finite(point.elapsedMs) ||
            point.elapsedMs <= previousElapsed ||
            !Number.isSafeInteger(point.sampleNumber) ||
            point.sampleNumber <= previousSample
          )
            throw new Error("Invalid statistics sample.");
          for (const key of ["cpuPercent", "memoryBytes", "privateMemoryBytes"])
            if (
              !(
                point[key] === null ||
                finite(point[key], key === "cpuPercent" ? 100 : undefined)
              )
            )
              throw new Error("Invalid statistics sample metric.");
          previousElapsed = point.elapsedMs;
          previousSample = point.sampleNumber;
          if (
            point.sampleNumber <= current.sampleCount &&
            point.elapsedMs <= current.durationMs
          )
            samples.push({
              elapsedMs: point.elapsedMs,
              cpuPercent: point.cpuPercent,
              memoryBytes: point.memoryBytes,
              privateMemoryBytes: point.privateMemoryBytes,
            });
        }
        if (
          header.trendDownsampled &&
          !current.trendDownsampled &&
          attempt === 0
        ) {
          current = await summary(id);
          if (!current) return null;
          continue;
        }
        const displayed = downsample(samples);
        return {
          ...current,
          samples: displayed,
          trendDownsampled:
            current.trendDownsampled ||
            header.trendDownsampled ||
            displayed.length < samples.length,
        };
      } catch {
        if (attempt === 0) {
          current = await summary(id);
          if (!current) return null;
          continue;
        }
        corrupt();
        return { ...current, samples: [] };
      }
    }
    return { ...current, samples: [] };
  }
  function contextPath(id, filename) {
    if (typeof id !== "string" || !ID.test(id))
      throw new Error("统计记录不存在或无法读取。");
    return path.join(sessionsDirectory, id, filename);
  }
  function parseEnvironmentRecord(value, id) {
    if (
      !exactKeys(value, ["schemaVersion", "id", "environment"]) ||
      value.schemaVersion !== 1 ||
      value.id !== id
    )
      throw new Error("Invalid statistics environment.");
    return validateEnvironment(value.environment);
  }
  function parseAnnotation(value, id) {
    if (
      !exactKeys(value, ["schemaVersion", "id", "notes", "updatedAt"]) ||
      value.schemaVersion !== 1 ||
      value.id !== id ||
      !notesText(value.notes) ||
      !instant(value.updatedAt)
    )
      throw new Error("Invalid statistics annotation.");
    return value;
  }
  async function readEnvironment(id) {
    try {
      const bytes = await data.read(
        contextPath(id, "environment.json"),
        MAX_ENVIRONMENT_BYTES,
        true,
      );
      return bytes === null
        ? { environment: null, notice: NOTICES.environmentMissing }
        : {
            environment: parseEnvironmentRecord(parseJsonBytes(bytes), id),
            notice: null,
          };
    } catch {
      return { environment: null, notice: NOTICES.environmentCorrupt };
    }
  }
  async function context(id) {
    const saved = await readEnvironment(id);
    const result = {
      environment: saved.environment,
      notes: "",
      notesUpdatedAt: null,
      contextNotice: saved.notice,
    };
    try {
      const bytes = await data.read(
        contextPath(id, "annotation.json"),
        MAX_RECORD_BYTES,
        true,
      );
      if (bytes !== null) {
        const annotation = parseAnnotation(parseJsonBytes(bytes), id);
        result.notes = annotation.notes;
        result.notesUpdatedAt = annotation.updatedAt;
      }
    } catch {
      result.contextNotice = [saved.notice, NOTICES.annotationCorrupt]
        .filter(Boolean)
        .join("\n");
    }
    return result;
  }
  async function getSession(id) {
    const detail = await metrics(id);
    return detail ? { ...detail, ...(await context(id)) } : null;
  }
  async function setNotes(id, notes) {
    if (!notesText(notes))
      throw new Error("统计备注须为不超过 4000 字的文本，可使用换行和制表符。");
    const file = contextPath(id, "annotation.json");
    if (!(await summary(id))) throw new Error("统计记录不存在或无法读取。");
    let previous;
    try {
      previous = await data.read(file, MAX_RECORD_BYTES, true);
      if (previous !== null) parseAnnotation(parseJsonBytes(previous), id);
    } catch {
      throw new Error("统计备注无法读取，原始文件已保留。");
    }
    if (!(await summary(id))) throw new Error("统计记录不存在或无法读取。");
    const value = {
      schemaVersion: 1,
      id,
      notes,
      updatedAt: new Date(now()).toISOString(),
    };
    try {
      await data.atomic(
        file,
        Buffer.from(JSON.stringify(value) + "\n"),
        previous,
      );
    } catch {
      throw new Error("统计备注未保存，原文件及保留文件已保留，请刷新后重试。");
    }
    return getSession(id);
  }
  async function compareSessions(beforeId, afterId) {
    contextPath(beforeId, "environment.json");
    contextPath(afterId, "environment.json");
    const records = await Promise.all([summary(beforeId), summary(afterId)]);
    const environments = await Promise.all(
      records.map((record, index) =>
        record ? readEnvironment(index === 0 ? beforeId : afterId) : null,
      ),
    );
    if (!environments[0]?.environment || !environments[1]?.environment)
      return {
        beforeId,
        afterId,
        available: false,
        changes: [],
        notice: NOTICES.comparisonUnavailable,
      };
    return {
      beforeId,
      afterId,
      available: true,
      changes: compareEnvironments(
        environments[0].environment,
        environments[1].environment,
      ),
      notice: null,
    };
  }
  async function startSession(input) {
    if (!(await loadSettings()).enabled) return null;
    if (
      !object(input) ||
      !Number.isInteger(input.pid) ||
      input.pid < 1 ||
      input.pid > 2147483647 ||
      !instant(input.launchedAt) ||
      !text(input.executable, 4096) ||
      !path.isAbsolute(input.executable)
    )
      throw new Error("Invalid performance session target.");
    const metadata = {};
    for (const key of [
      "gameVersion",
      "instanceId",
      "instanceName",
      "playsetId",
      "playsetName",
    ]) {
      const value = input[key] ?? null;
      if (!(value === null || text(value)))
        throw new Error("Invalid performance session metadata.");
      metadata[key] = value;
    }
    if (
      !Number.isInteger(input.modCount) ||
      input.modCount < 0 ||
      input.modCount > 100000
    )
      throw new Error("Invalid performance mod count.");
    const id = randomUUID();
    let environmentBytes = null;
    if (input.environment !== undefined && input.environment !== null) {
      const environment = structuredClone(
        validateEnvironment(input.environment),
      );
      environmentBytes = Buffer.from(
        JSON.stringify({ schemaVersion: 1, id, environment }) + "\n",
      );
      if (environmentBytes.length > MAX_ENVIRONMENT_BYTES)
        throw new Error("统计启动配置超过允许大小。");
    }
    await readyDirectory(sessionsDirectory);
    const directory = path.join(sessionsDirectory, id);
    await fs.mkdir(directory);
    await safeDirectory(directory);
    const initial = {
      schemaVersion: 1,
      id,
      status: "recording",
      startedAt: input.launchedAt,
      endedAt: null,
      lastSampleAt: null,
      durationMs: 0,
      sampleCount: 0,
      cpuAveragePercent: null,
      cpuPeakPercent: null,
      memoryAverageBytes: null,
      memoryPeakBytes: null,
      privateMemoryAverageBytes: null,
      privateMemoryPeakBytes: null,
      ...metadata,
      modCount: input.modCount,
      logicalCpuCount: null,
      launchMode: ["normal", "debug"].includes(input.launchMode)
        ? input.launchMode
        : "normal",
      processStartedAt: null,
      processStartTicks: null,
      samplingGapCount: 0,
      trendDownsampled: false,
      failureReason: null,
    };
    const configuration = {
      schemaVersion: 1,
      id,
      pid: input.pid,
      launchedAt: input.launchedAt,
      executable: path.resolve(input.executable),
      intervalMs: sampleIntervalMs,
      session: initial,
    };
    try {
      configuration.canonicalExecutable = await fs.realpath(input.executable);
    } catch {
      /* The collector reports target absence or denial without changing the game. */
    }
    await atomicJson(path.join(directory, "session.json"), configuration);
    await atomicJson(path.join(directory, "summary.json"), initial);
    if (environmentBytes !== null) {
      await data.atomic(
        path.join(directory, "environment.json"),
        environmentBytes,
        null,
      );
    }
    const index = (await readIndex()).filter((entry) => entry.id !== id);
    index.unshift({ id, startedAt: input.launchedAt });
    await preserveInvalidBeforeWrite(indexPath, 128 * 1024, parseIndex);
    await atomicJson(indexPath, {
      schemaVersion: 1,
      sessions: index.slice(0, HISTORY_LIMIT),
    });
    try {
      if (!(await supported()))
        throw new Error("Performance collector unavailable.");
      const executable = await persistentMonitor();
      const child = spawnProcess(
        executable,
        [path.join(directory, "session.json")],
        {
          detached: true,
          windowsHide: true,
          stdio: "ignore",
        },
      );
      await new Promise((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      child.unref();
    } catch (error) {
      notice = NOTICES.start;
      await atomicJson(path.join(directory, "summary.json"), {
        ...initial,
        status: "unavailable",
        endedAt: new Date(now()).toISOString(),
        failureReason:
          error.code === "PERFORMANCE_MONITOR_CACHE_INVALID"
            ? "monitor-cache-invalid"
            : "monitor-start-failed",
      });
    }
    return summary(id);
  }
  async function setEnabled(enabled) {
    if (typeof enabled !== "boolean")
      throw new Error("Invalid statistics preference.");
    await readyDirectory(root);
    const value = { schemaVersion: 1, enabled };
    await preserveInvalidBeforeWrite(
      settingsPath,
      MAX_RECORD_BYTES,
      parseSettings,
    );
    await atomicJson(settingsPath, value);
    settings = value;
    return getState();
  }
  return {
    startSession: (input) => serialize(() => startSession(input)),
    getState,
    getSession: (id) => serialize(() => getSession(id)),
    setNotes: (id, notes) => serialize(() => setNotes(id, notes)),
    compareSessions: (beforeId, afterId) =>
      serialize(() => compareSessions(beforeId, afterId)),
    setEnabled: (enabled) => serialize(() => setEnabled(enabled)),
  };
}

module.exports = { createGamePerformanceService };
