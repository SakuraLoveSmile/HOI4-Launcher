"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const yauzl = require("yauzl");
const yazl = require("yazl");
const { parseDescriptor } = require("./mod-authoring.cjs");
const {
  normalizePdxPatchPath,
  pdxPatchPathKey,
} = require("./pdx-patch-path.cjs");
const {
  createMergePlan,
  mergeTextBuffers,
  createTextMergeChunks,
  encodeMergeText,
} = require("./mod-project-merge.cjs");
const { analyzeProjectFiles } = require("./mod-project-checks.cjs");

const LIMITS = Object.freeze({
  files: 100000,
  bytes: 20 * 1024 ** 3,
  fileBytes: 4 * 1024 ** 3,
  textBytes: 1024 ** 2,
  jsonBytes: 64 * 1024 ** 2,
  snapshots: 1000,
  history: 5000,
  checksBytes: 8 * 1024 ** 2,
  mergeBytes: 64 * 1024 ** 2,
});
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const treeFile = (tree, name) =>
  Object.hasOwn(tree, name) ? tree[name] : null;
const clone = (v) => structuredClone(v);
const sha = (v) => createHash("sha256").update(v).digest("hex");
const canonical = (v) => path.resolve(v).toLowerCase();
const within = (root, value) => {
  const r = path.relative(root, value);
  return r !== ".." && !r.startsWith(".." + path.sep) && !path.isAbsolute(r);
};
const now = () => new Date().toISOString();
const quote = (v) => JSON.stringify(v).replaceAll("\\\\", "/");
const uuid = (v) =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    v,
  );
function problem(message, code = "PROJECT_INVALID") {
  return Object.assign(new Error(message), { code });
}
function id(value) {
  if (!uuid(value)) throw problem("项目或快照编号无效。");
  return value;
}
function absolute(value) {
  if (
    typeof value !== "string" ||
    !path.isAbsolute(value) ||
    /[\0-\x1f\x7f]/.test(value)
  )
    throw problem("项目路径必须是有效的绝对路径。");
  return path.resolve(value);
}
function title(value) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 120 ||
    /[\0-\x1f\x7f]/.test(value)
  )
    throw problem("项目或检查点名称须为 1 至 120 个普通字符。");
  return value.trim();
}
function upstream(value) {
  if (value === null || value === undefined) return null;
  if (
    !object(value) ||
    !["workshop", "pdx"].includes(value.provider) ||
    typeof value.remoteId !== "string" ||
    !/^[1-9]\d{0,19}$/.test(value.remoteId) ||
    value.modId !== `${value.provider}:${value.remoteId}` ||
    Object.keys(value).some(
      (k) =>
        !["provider", "remoteId", "modId", "revision", "updatedAt"].includes(k),
    ) ||
    (value.revision !== undefined &&
      (typeof value.revision !== "string" ||
        !/^[1-9]\d{0,19}$/.test(value.revision))) ||
    (value.updatedAt !== undefined &&
      (!Number.isSafeInteger(value.updatedAt) || value.updatedAt < 0))
  )
    throw problem("上游来源引用无效。");
  return clone(value);
}
const sameUpstream = (a, b) =>
  (!a && !b) ||
  Boolean(a && b && a.provider === b.provider && a.remoteId === b.remoteId);
const sameFile = (a, b) =>
  Boolean(
    a &&
      b &&
      a.dev === b.dev &&
      a.ino === b.ino &&
      a.birthtimeMs === b.birthtimeMs,
  );
const stable = (a, b) =>
  sameFile(a, b) &&
  a.size === b.size &&
  a.mtimeMs === b.mtimeMs &&
  a.ctimeMs === b.ctimeMs;
async function optional(filename) {
  try {
    return await fs.lstat(filename);
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}
async function chain(directory, create = false) {
  const resolved = absolute(directory),
    root = path.parse(resolved).root;
  let current = root;
  for (const part of resolved
    .slice(root.length)
    .split(path.sep)
    .filter(Boolean)) {
    current = path.join(current, part);
    let stat = await optional(current);
    if (!stat && create) {
      try {
        await fs.mkdir(current);
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
      }
      stat = await fs.lstat(current);
    }
    if (
      !stat?.isDirectory() ||
      stat.isSymbolicLink() ||
      canonical(await fs.realpath(current)) !== canonical(current)
    )
      throw problem(
        "项目路径包含链接、目录联接或重定向：" + current,
        "PROJECT_UNSAFE_PATH",
      );
  }
}
function rel(value) {
  try {
    return normalizePdxPatchPath(value);
  } catch {
    throw problem("项目包含不安全的相对路径。", "PROJECT_UNSAFE_PATH");
  }
}
function namespace(names, value, directory = false, explicit = true) {
  const parts = value.split("/");
  for (let n = 1; n <= parts.length; n++) {
    const name = parts.slice(0, n).join("/"),
      key = pdxPatchPathKey(name),
      leaf = n === parts.length;
    const kind = leaf && !directory ? "file" : "directory",
      old = names.get(key);
    if (
      old &&
      (old.name !== name ||
        old.kind !== kind ||
        (leaf && explicit && old.explicit))
    )
      throw problem(
        "项目包含重复、大小写冲突或文件目录冲突。",
        "PROJECT_PATH_COLLISION",
      );
    names.set(key, {
      name,
      kind,
      explicit: Boolean(old?.explicit || (leaf && explicit)),
    });
  }
}
async function fileDigest(
  filename,
  { read = false, maxBytes = LIMITS.fileBytes } = {},
) {
  await chain(path.dirname(filename));
  const before = await fs.lstat(filename);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    before.size > maxBytes
  )
    throw problem(
      "项目内容必须是大小合适的普通文件，不能包含硬链接或符号链接。",
      "PROJECT_UNSAFE_FILE",
    );
  const handle = await fs.open(filename, "r");
  try {
    if (!stable(before, await handle.stat()))
      throw problem("项目文件在读取前发生变化。", "PROJECT_SOURCE_CHANGED");
    const digest = createHash("sha256"),
      chunks = [],
      buffer = Buffer.allocUnsafe(1024 * 1024);
    let bytes = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      bytes += bytesRead;
      if (bytes > before.size || bytes > maxBytes)
        throw problem("项目文件在读取时增长。", "PROJECT_SOURCE_CHANGED");
      digest.update(buffer.subarray(0, bytesRead));
      if (read) chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
    if (
      bytes !== before.size ||
      !stable(before, await handle.stat()) ||
      !stable(before, await fs.lstat(filename))
    )
      throw problem("项目文件在读取时发生变化。", "PROJECT_SOURCE_CHANGED");
    return {
      bytes,
      sha256: digest.digest("hex"),
      identity: before,
      ...(read ? { buffer: Buffer.concat(chunks) } : {}),
    };
  } finally {
    await handle.close();
  }
}
function digestManifest(files) {
  return sha(
    JSON.stringify(
      Object.keys(files)
        .sort()
        .map((name) => [name, files[name].bytes, files[name].sha256]),
    ),
  );
}
async function scan(root) {
  await chain(root);
  const files = Object.create(null),
    names = new Map(),
    observed = [];
  let total = 0,
    count = 0;
  async function walk(directory, prefix = "") {
    const before = await fs.lstat(directory);
    if (!before.isDirectory() || before.isSymbolicLink())
      throw problem("项目包含目录链接。", "PROJECT_UNSAFE_PATH");
    const list = (await fs.readdir(directory, { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name),
    );
    for (const entry of list) {
      const name = rel(prefix + entry.name),
        filename = path.join(root, ...name.split("/"));
      const info = await fs.lstat(filename);
      namespace(names, name, info.isDirectory());
      if (info.isSymbolicLink())
        throw problem("项目包含链接。", "PROJECT_UNSAFE_PATH");
      if (info.isDirectory()) await walk(filename, name + "/");
      else {
        if (++count > LIMITS.files)
          throw problem("项目文件数量超过 100000。", "PROJECT_LIMIT");
        const result = await fileDigest(filename);
        total += result.bytes;
        if (total > LIMITS.bytes)
          throw problem("项目内容超过 20 GiB。", "PROJECT_LIMIT");
        files[name] = { bytes: result.bytes, sha256: result.sha256 };
        observed.push({ filename, stat: result.identity });
      }
    }
    observed.push({ filename: directory, stat: before });
  }
  await walk(root);
  for (const { filename, stat } of observed)
    if (!stable(stat, await fs.lstat(filename)))
      throw problem("扫描期间项目内容发生变化。", "PROJECT_SOURCE_CHANGED");
  return { files, digest: digestManifest(files), total, observed };
}
async function assertScan(root, expected) {
  const actual = await scan(root);
  if (actual.digest !== expected.digest)
    throw problem("项目内容已变化，请重新准备。", "PROJECT_SOURCE_CHANGED");
  if (expected.observed)
    for (const { filename, stat } of expected.observed)
      if (!stable(stat, await fs.lstat(filename)))
        throw problem(
          "项目文件已被替换，请重新准备。",
          "PROJECT_SOURCE_CHANGED",
        );
  return actual;
}
async function exclusive(filename, bytes) {
  await chain(path.dirname(filename), true);
  const handle = await fs.open(filename, "wx");
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function syncFile(filename) {
  const file = await fs.open(filename, "r+");
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}
async function readSmall(filename, maxBytes = LIMITS.jsonBytes) {
  return (await fileDigest(filename, { read: true, maxBytes })).buffer;
}
async function replaceFile(filename, bytes, expected) {
  await chain(path.dirname(filename), true);
  const current = await optional(filename);
  if (
    expected === null
      ? Boolean(current)
      : !current || !(await readSmall(filename)).equals(expected)
  )
    throw problem(
      "项目记录或注册文件已被其他程序修改。",
      "PROJECT_SOURCE_CHANGED",
    );
  const temp = filename + ".pending-" + randomUUID();
  await exclusive(temp, bytes);
  const again = await optional(filename);
  if (
    expected === null
      ? Boolean(again)
      : !again ||
        !sameFile(current, again) ||
        !(await readSmall(filename)).equals(expected)
  )
    throw problem(
      "项目记录在提交前发生变化，暂存文件已保留。",
      "PROJECT_SOURCE_CHANGED",
    );
  await fs.rename(temp, filename);
}
async function copyTree(source, destination) {
  const before = await scan(source);
  await chain(path.dirname(destination), true);
  await fs.mkdir(destination);
  for (const name of Object.keys(before.files).sort()) {
    const from = path.join(source, ...name.split("/")),
      target = path.join(destination, ...name.split("/"));
    await chain(path.dirname(target), true);
    await fs.copyFile(from, target, fs.constants.COPYFILE_EXCL);
    await fs.chmod(target, 0o600);
    await syncFile(target);
    const actual = await fileDigest(target);
    if (
      actual.bytes !== before.files[name].bytes ||
      actual.sha256 !== before.files[name].sha256
    )
      throw problem(
        "复制期间源文件发生变化，未使用此快照。",
        "PROJECT_SOURCE_CHANGED",
      );
  }
  await assertScan(source, before);
  await assertScan(destination, before);
  return before;
}
const crcTable = Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function crcUpdate(crc, bytes) {
  for (const b of bytes) crc = crcTable[(crc ^ b) & 255] ^ (crc >>> 8);
  return crc >>> 0;
}
async function unzip(source, destination) {
  const original = await fileDigest(source, { maxBytes: LIMITS.bytes });
  await chain(path.dirname(destination), true);
  await fs.mkdir(destination);
  const zip = await yauzl.openPromise(source, {
    lazyEntries: true,
    autoClose: false,
    strictFileNames: true,
    validateEntrySizes: true,
  });
  zip.on("error", () => {});
  const names = new Map();
  let count = 0,
    total = 0;
  try {
    if (zip.entryCount > LIMITS.files)
      throw problem("ZIP 文件数量超过限制。", "PROJECT_LIMIT");
    for await (const entry of zip.eachEntry()) {
      if (++count > LIMITS.files)
        throw problem("ZIP 文件数量超过限制。", "PROJECT_LIMIT");
      const directory = entry.fileName.endsWith("/"),
        mode = entry.externalFileAttributes >>> 16;
      if (
        (mode & 0xf000) === 0xa000 ||
        (mode & 0xf000 && ![0x8000, 0x4000].includes(mode & 0xf000)) ||
        (Boolean((mode & 0xf000) === 0x4000) && !directory) ||
        entry.generalPurposeBitFlag & 1 ||
        ![0, 8].includes(entry.compressionMethod)
      )
        throw problem(
          "ZIP 包含链接、加密文件或不支持的条目。",
          "PROJECT_UNSAFE_FILE",
        );
      const name = rel(
        directory ? entry.fileName.slice(0, -1) : entry.fileName,
      );
      namespace(names, name, directory);
      if (
        !Number.isSafeInteger(entry.uncompressedSize) ||
        entry.uncompressedSize < 0 ||
        entry.uncompressedSize > LIMITS.fileBytes ||
        entry.uncompressedSize >
          Math.max(1024 * 1024, entry.compressedSize * 1000)
      )
        throw problem("ZIP 大小或膨胀比例超过限制。", "PROJECT_LIMIT");
      const target = path.join(destination, ...name.split("/"));
      if (directory) {
        if (entry.uncompressedSize) throw problem("ZIP 目录含有异常数据。");
        await chain(target, true);
        continue;
      }
      await chain(path.dirname(target), true);
      const output = await fs.open(target, "wx");
      let bytes = 0,
        crc = 0xffffffff;
      try {
        const stream = await zip.openReadStreamPromise(entry);
        for await (const chunk of stream) {
          bytes += chunk.length;
          total += chunk.length;
          if (bytes > entry.uncompressedSize || total > LIMITS.bytes)
            throw problem("ZIP 解压大小超限。", "PROJECT_LIMIT");
          await output.writeFile(chunk);
          crc = crcUpdate(crc, chunk);
        }
        if (
          bytes !== entry.uncompressedSize ||
          (crc ^ 0xffffffff) >>> 0 !== entry.crc32
        )
          throw problem(
            "ZIP 文件大小或 CRC 校验失败。",
            "PROJECT_ARCHIVE_INVALID",
          );
        await output.sync();
      } finally {
        await output.close();
      }
    }
  } finally {
    zip.close();
  }
  const after = await fileDigest(source, { maxBytes: LIMITS.bytes });
  if (
    after.sha256 !== original.sha256 ||
    !stable(after.identity, original.identity)
  )
    throw problem("ZIP 在解压期间发生变化。", "PROJECT_SOURCE_CHANGED");
  return scan(destination);
}
function sanitizedDescriptor(bytes, name) {
  if (bytes.length > LIMITS.textBytes)
    throw problem("模组描述文件超过 1 MiB。", "PROJECT_LIMIT");
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw problem("模组描述文件必须是 UTF-8 文本。");
  }
  const fields = parseDescriptor(text);
  for (const field of fields
    .filter((v) =>
      ["name", "remote_file_id", "pops_id", "path", "archive"].includes(
        v.key.toLowerCase(),
      ),
    )
    .sort((a, b) => b.start - a.start))
    text = text.slice(0, field.start) + text.slice(field.end);
  return Buffer.from(
    text.trimEnd() + "\nname=" + JSON.stringify(name) + "\n",
    "utf8",
  );
}
async function sanitize(root, name, descriptorText) {
  const filename = path.join(root, "descriptor.mod");
  if (!(await optional(filename))) {
    if (descriptorText === undefined)
      throw problem(
        "请选择包含 descriptor.mod 的模组内容目录，或将该文件放在 ZIP 根目录。",
        "PROJECT_DESCRIPTOR_MISSING",
      );
    if (
      typeof descriptorText !== "string" ||
      Buffer.byteLength(descriptorText, "utf8") > LIMITS.textBytes
    )
      throw problem("备用模组描述文件须为不超过 1 MiB 的 UTF-8 文本。");
    await exclusive(
      filename,
      sanitizedDescriptor(Buffer.from(descriptorText, "utf8"), name),
    );
    return;
  }
  const bytes = await readSmall(filename, LIMITS.textBytes);
  await replaceFile(filename, sanitizedDescriptor(bytes, name), bytes);
}
function publicSnapshot(record, snapshot, root) {
  return {
    id: snapshot.id,
    name: snapshot.name,
    kind: snapshot.kind,
    createdAt: snapshot.createdAt,
    digest: snapshot.digest,
    workPath: path.join(
      root,
      "projects",
      record.id,
      "snapshots",
      snapshot.id,
      "content",
    ),
  };
}
function paths(record) {
  const stem = "ironclad_project_" + id(record.id),
    modRoot = path.join(absolute(record.userData), "mod");
  return {
    modId: "local:" + stem + ".mod",
    workPath: path.join(modRoot, stem),
    descriptorPath: path.join(modRoot, stem + ".mod"),
    modRoot,
  };
}
function context(record) {
  return {
    baseSnapshotId: record.baseSnapshotId,
    candidateSnapshotId: record.candidateSnapshotId,
    baselineKnown: record.baselineKnown,
    knownBasePaths: clone(record.knownBasePaths || []),
    upstreamRef: clone(record.upstreamRef),
    history: clone(record.history),
  };
}
function mergePlan(record, base, local, incoming) {
  const result = createMergePlan({
    base,
    local,
    upstream: incoming,
    baselineKnown: record.baselineKnown,
  });
  if (record.baselineKnown || !record.knownBasePaths?.length) return result;
  const reviewed = new Set(record.knownBasePaths);
  const comparable = createMergePlan({
    base,
    local,
    upstream: incoming,
    baselineKnown: true,
  });
  const byPath = new Map(
    comparable.entries.map((entry) => [entry.path, entry]),
  );
  result.entries = result.entries.map((entry) => {
    if (!reviewed.has(entry.path)) return entry;
    const known = byPath.get(entry.path);
    return { ...known, suggested: known.upstreamChanged ? "defer" : "local" };
  });
  for (const key of Object.keys(result.counts)) result.counts[key] = 0;
  for (const entry of result.entries) {
    result.counts.total++;
    result.counts[entry.status]++;
    if (entry.localChanged) result.counts.localChanged++;
    if (entry.upstreamChanged) result.counts.upstreamChanged++;
    if (entry.status === "conflict") result.counts.conflicts++;
  }
  return result;
}
function validateManifest(value) {
  if (
    !object(value) ||
    value.version !== 1 ||
    !object(value.files) ||
    !/^[a-f0-9]{64}$/.test(value.digest || "")
  )
    throw problem("项目快照清单损坏。");
  const names = new Map(),
    entries = Object.entries(value.files);
  if (entries.length > LIMITS.files) throw problem("项目快照清单超限。");
  let total = 0;
  for (const [name, file] of entries) {
    if (
      rel(name) !== name ||
      !object(file) ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0 ||
      file.bytes > LIMITS.fileBytes ||
      !/^[a-f0-9]{64}$/.test(file.sha256 || "")
    )
      throw problem("项目快照条目损坏。");
    namespace(names, name);
    total += file.bytes;
    if (total > LIMITS.bytes) throw problem("项目快照大小超限。");
  }
  if (digestManifest(value.files) !== value.digest)
    throw problem("项目快照摘要不匹配。");
  return value;
}
function validateRecord(record) {
  if (
    !object(record) ||
    record.version !== 1 ||
    !uuid(record.id) ||
    title(record.name) !== record.name ||
    absolute(record.userData) !== record.userData ||
    typeof record.baselineKnown !== "boolean" ||
    !Array.isArray(record.snapshots) ||
    record.snapshots.length > LIMITS.snapshots ||
    !Array.isArray(record.history) ||
    record.history.length > LIMITS.history ||
    !Array.isArray(record.retainedTrees) ||
    record.retainedTrees.some((v) => !uuid(v))
  )
    throw problem("项目记录损坏，原文件已保留。");
  upstream(record.upstreamRef);
  if (record.originRef !== undefined) upstream(record.originRef);
  if (
    record.originModId !== undefined &&
    record.originModId !== null &&
    (typeof record.originModId !== "string" ||
      record.originModId.length > 4096 ||
      !/^(?:local:[^\\/\0\r\n]+\.mod|(?:workshop|pdx):[1-9]\d{0,19})$/.test(
        record.originModId,
      ))
  )
    throw problem("上游来源引用无效。");
  if (
    record.knownBasePaths !== undefined &&
    (!Array.isArray(record.knownBasePaths) ||
      record.knownBasePaths.length > LIMITS.files ||
      new Set(record.knownBasePaths).size !== record.knownBasePaths.length ||
      record.knownBasePaths.some((v) => rel(v) !== v))
  )
    throw problem("项目逐文件基准记录损坏。");
  const seen = new Set();
  for (const snapshot of record.snapshots) {
    if (
      !object(snapshot) ||
      !uuid(snapshot.id) ||
      seen.has(snapshot.id) ||
      typeof snapshot.name !== "string" ||
      ![
        "base",
        "candidate",
        "checkpoint",
        "merge-base",
        "before-merge",
        "before-restore",
      ].includes(snapshot.kind) ||
      !/^[a-f0-9]{64}$/.test(snapshot.manifestSha256 || "") ||
      !/^[a-f0-9]{64}$/.test(snapshot.digest || "")
    )
      throw problem("项目快照引用损坏。");
    seen.add(snapshot.id);
  }
  if (
    !seen.has(record.baseSnapshotId) ||
    (record.candidateSnapshotId !== null &&
      !seen.has(record.candidateSnapshotId))
  )
    throw problem("项目缺少基准或候选快照。");
  return record;
}

function createModProjectService({
  storageDirectory,
  getUserDataPath,
  isGameRunning = async () => false,
  transactionObserver,
} = {}) {
  const storage = absolute(storageDirectory),
    projectsRoot = path.join(storage, "projects");
  if (typeof getUserDataPath !== "function")
    throw new Error("getUserDataPath is required");
  let pending = Promise.resolve(),
    busy = 0;
  const plans = new Map();
  const projectRoot = (projectId) => path.join(projectsRoot, id(projectId));
  const recordPath = (projectId) =>
    path.join(projectRoot(projectId), "project.json");
  const snapshotRoot = (projectId, snapshotId) =>
    path.join(projectRoot(projectId), "snapshots", id(snapshotId));
  async function gameGuard() {
    if (await isGameRunning())
      throw problem("请先关闭游戏，再修改二改项目。", "PROJECT_GAME_RUNNING");
  }
  const present = (record) => ({
    ...clone(record),
    originRef: clone(
      record.originRef === undefined ? record.upstreamRef : record.originRef,
    ),
    ...paths(record),
    snapshots: record.snapshots.map((s) => publicSnapshot(record, s, storage)),
  });
  async function readRecord(projectId) {
    let bytes;
    try {
      bytes = await readSmall(recordPath(projectId));
    } catch (e) {
      if (e.code === "ENOENT")
        throw problem("二改项目不存在。", "PROJECT_NOT_FOUND");
      throw e;
    }
    const value = validateRecord(JSON.parse(bytes));
    if (value.id !== projectId) throw problem("项目身份与目录不匹配。");
    return { value, bytes };
  }
  async function saveRecord(record, expected) {
    validateRecord(record);
    const bytes = Buffer.from(JSON.stringify(record, null, 2));
    if (bytes.length > LIMITS.jsonBytes)
      throw problem("项目记录大小超过限制，请导出备份。", "PROJECT_LIMIT");
    await replaceFile(recordPath(record.id), bytes, expected);
    plans.delete(record.id);
  }
  function history(record, value) {
    if (record.history.length >= LIMITS.history)
      throw problem(
        "项目历史达到 5000 项上限，请备份后建立新项目。",
        "PROJECT_LIMIT",
      );
    record.history.push({ id: randomUUID(), createdAt: now(), ...value });
    record.updatedAt = now();
  }
  async function snapshot(
    record,
    source,
    name,
    kind,
    ctx = context(record),
    checkSource,
    descriptorText,
  ) {
    if (record.snapshots.length >= LIMITS.snapshots)
      throw problem("项目快照达到 1000 项上限。", "PROJECT_LIMIT");
    const snapshotId = randomUUID(),
      root = snapshotRoot(record.id, snapshotId),
      contentPath = path.join(root, "content");
    await checkSource?.();
    await chain(root, true);
    const stat = await fs.lstat(absolute(source));
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()))
      throw problem("快照来源必须是普通目录或 ZIP。");
    if (stat.isDirectory()) await copyTree(source, contentPath);
    else {
      if (path.extname(source).toLowerCase() !== ".zip")
        throw problem("只支持普通目录或 ZIP 模组。");
      await unzip(source, contentPath);
    }
    await checkSource?.();
    await sanitize(contentPath, record.name, descriptorText);
    const scanned = await scan(contentPath);
    if (kind === "base" && ctx === null)
      ctx = {
        baseSnapshotId: snapshotId,
        candidateSnapshotId: null,
        baselineKnown: record.baselineKnown,
        knownBasePaths: [],
        upstreamRef: clone(record.upstreamRef),
        history: [],
      };
    const manifest = {
      version: 1,
      files: scanned.files,
      digest: scanned.digest,
      context: ctx,
    };
    const bytes = Buffer.from(JSON.stringify(manifest));
    if (bytes.length > LIMITS.jsonBytes)
      throw problem("项目快照记录超过限制。", "PROJECT_LIMIT");
    await exclusive(path.join(root, "manifest.json"), bytes);
    const entry = {
      id: snapshotId,
      name: title(name),
      kind,
      createdAt: now(),
      digest: scanned.digest,
      manifestSha256: sha(bytes),
    };
    record.snapshots.push(entry);
    return { entry, manifest, contentPath };
  }
  async function loadSnapshot(record, snapshotId) {
    const entry = record.snapshots.find((s) => s.id === id(snapshotId));
    if (!entry) throw problem("项目快照不存在。", "PROJECT_SNAPSHOT_NOT_FOUND");
    const root = snapshotRoot(record.id, snapshotId),
      bytes = await readSmall(path.join(root, "manifest.json"));
    if (sha(bytes) !== entry.manifestSha256)
      throw problem("项目快照清单已被修改。", "PROJECT_SNAPSHOT_CHANGED");
    const manifest = validateManifest(JSON.parse(bytes)),
      contentPath = path.join(root, "content");
    if (manifest.digest !== entry.digest) throw problem("项目快照引用不匹配。");
    await assertScan(contentPath, manifest);
    return { entry, manifest, contentPath };
  }
  async function registration(record, contentPath = paths(record).workPath) {
    const inner = await readSmall(
      path.join(contentPath, "descriptor.mod"),
      LIMITS.textBytes,
    );
    return Buffer.concat([
      Buffer.from("# IRONCLAD local project " + record.id + "\n"),
      sanitizedDescriptor(inner, record.name),
      Buffer.from("path=" + quote(paths(record).workPath) + "\n"),
    ]);
  }
  async function optionalBytes(filename) {
    return (await optional(filename)) ? readSmall(filename) : null;
  }
  async function recoverOne(projectId) {
    const journalPath = path.join(projectRoot(projectId), "transaction.json"),
      raw = await optionalBytes(journalPath);
    if (!raw) return;
    await gameGuard();
    const journal = JSON.parse(raw);
    if (
      !object(journal) ||
      journal.version !== 1 ||
      !uuid(journal.id) ||
      journal.projectId !== projectId
    )
      throw problem(
        "项目恢复日志损坏，需检查保留文件。",
        "PROJECT_RECOVERY_BLOCKED",
      );
    const next = validateRecord(journal.next),
      previous =
        journal.previous === null ? null : validateRecord(journal.previous);
    if (
      next.id !== projectId ||
      (previous &&
        (previous.id !== projectId || previous.userData !== next.userData)) ||
      !/^[a-f0-9]{64}$/.test(journal.nextDigest || "") ||
      (previous && !/^[a-f0-9]{64}$/.test(journal.previousDigest || "")) ||
      !(
        journal.registrationBefore === null ||
        typeof journal.registrationBefore === "string"
      ) ||
      typeof journal.registrationAfter !== "string"
    )
      throw problem("项目恢复绑定无效。", "PROJECT_RECOVERY_BLOCKED");
    const p = paths(next),
      stage = p.workPath + ".pending-" + journal.id,
      old = p.workPath + ".previous-" + journal.id;
    await chain(p.modRoot);
    const savedBytes = await optionalBytes(recordPath(projectId));
    const expectedPrevious = previous ? JSON.stringify(previous) : null;
    if (savedBytes) {
      const saved = JSON.stringify(validateRecord(JSON.parse(savedBytes)));
      if (saved !== JSON.stringify(next) && saved !== expectedPrevious)
        throw problem(
          "项目记录有外部改动，恢复已暂停。",
          "PROJECT_RECOVERY_BLOCKED",
        );
    } else if (previous)
      throw problem("原项目记录丢失，恢复已暂停。", "PROJECT_RECOVERY_BLOCKED");
    const regBytes = await optionalBytes(p.descriptorPath),
      regText = regBytes?.toString("utf8") ?? null;
    if (
      regText !== journal.registrationBefore &&
      regText !== journal.registrationAfter
    )
      throw problem(
        "项目注册有外部改动，恢复已暂停。",
        "PROJECT_RECOVERY_BLOCKED",
      );
    const stageExists = await optional(stage),
      workExists = await optional(p.workPath),
      oldExists = await optional(old);
    if (stageExists) {
      await assertScan(stage, { digest: journal.nextDigest });
      if (workExists) {
        if (!previous || oldExists)
          throw problem(
            "项目工作区状态不明确，恢复已暂停。",
            "PROJECT_RECOVERY_BLOCKED",
          );
        await assertScan(p.workPath, { digest: journal.previousDigest });
        await gameGuard();
        await fs.rename(p.workPath, old);
        await transactionObserver?.("old-moved", { projectId, journalPath });
      } else if (previous && !oldExists)
        throw problem(
          "项目旧工作区丢失，恢复已暂停。",
          "PROJECT_RECOVERY_BLOCKED",
        );
      if (previous) await assertScan(old, { digest: journal.previousDigest });
      await gameGuard();
      await fs.rename(stage, p.workPath);
      await transactionObserver?.("work-installed", { projectId, journalPath });
    } else {
      if (!workExists)
        throw problem(
          "项目暂存及工作区均不可用，恢复已暂停。",
          "PROJECT_RECOVERY_BLOCKED",
        );
      await assertScan(p.workPath, { digest: journal.nextDigest });
      if (previous) {
        if (!oldExists)
          throw problem("项目恢复缺少旧工作区。", "PROJECT_RECOVERY_BLOCKED");
        await assertScan(old, { digest: journal.previousDigest });
      }
    }
    await gameGuard();
    if (regText !== journal.registrationAfter)
      await replaceFile(
        p.descriptorPath,
        Buffer.from(journal.registrationAfter),
        regBytes,
      );
    await transactionObserver?.("registration-installed", {
      projectId,
      journalPath,
    });
    const currentRecord = await optionalBytes(recordPath(projectId));
    if (
      !currentRecord ||
      JSON.stringify(JSON.parse(currentRecord)) !== JSON.stringify(next)
    )
      await saveRecord(next, currentRecord);
    await transactionObserver?.("metadata-installed", {
      projectId,
      journalPath,
    });
    if (!(await readSmall(journalPath)).equals(raw))
      throw problem("恢复日志发生变化，已保留。", "PROJECT_RECOVERY_BLOCKED");
    await fs.unlink(journalPath);
    plans.delete(projectId);
  }
  async function initialize() {
    if (!(await optional(projectsRoot))) return;
    await chain(projectsRoot);
    for (const item of await fs.readdir(projectsRoot, {
      withFileTypes: true,
    })) {
      if (!uuid(item.name)) continue;
      if (!item.isDirectory() || item.isSymbolicLink())
        throw problem("项目控制目录含有链接。", "PROJECT_UNSAFE_PATH");
      await recoverOne(item.name);
    }
  }
  function serial(mutating, action) {
    if (mutating) busy++;
    const result = pending.then(async () => {
      await initialize();
      if (mutating) await gameGuard();
      return action();
    });
    pending = result.catch(() => {});
    return result.finally(() => {
      if (mutating) busy--;
    });
  }
  async function transition(previous, record, source, expectedWork, event) {
    const p = paths(record),
      txId = randomUUID(),
      stage = p.workPath + ".pending-" + txId;
    await chain(p.modRoot, true);
    await copyTree(source, stage);
    await sanitize(stage, record.name);
    const staged = await scan(stage);
    if (previous) await assertScan(p.workPath, expectedWork);
    else if (await optional(p.workPath))
      throw problem("项目工作区已经存在，未覆盖。");
    const registrationBefore = await optionalBytes(p.descriptorPath);
    if (!previous && registrationBefore)
      throw problem("项目注册已经存在，未覆盖。");
    if (previous) {
      const expected =
        previous.registrationText !== undefined
          ? Buffer.from(previous.registrationText)
          : await registration(previous);
      if (!registrationBefore?.equals(expected))
        throw problem(
          "项目注册已被其他程序修改，未覆盖。",
          "PROJECT_SOURCE_CHANGED",
        );
      record.retainedTrees.push(txId);
    }
    history(record, event);
    const after = await registration(record, stage);
    record.registrationText = after.toString("utf8");
    await gameGuard();
    if (previous) await assertScan(p.workPath, expectedWork);
    const journal = {
      version: 1,
      id: txId,
      projectId: record.id,
      previous,
      next: record,
      previousDigest: expectedWork?.digest ?? null,
      nextDigest: staged.digest,
      registrationBefore: registrationBefore?.toString("utf8") ?? null,
      registrationAfter: after.toString("utf8"),
    };
    const journalPath = path.join(projectRoot(record.id), "transaction.json");
    const journalBytes = Buffer.from(JSON.stringify(journal));
    if (journalBytes.length > LIMITS.jsonBytes)
      throw problem(
        "项目恢复日志超过 64 MiB，请先导出并拆分项目历史。",
        "PROJECT_LIMIT",
      );
    await exclusive(journalPath, journalBytes);
    await transactionObserver?.("prepared", {
      projectId: record.id,
      journalPath,
    });
    await recoverOne(record.id);
    return present(record);
  }
  async function createInner(input) {
    if (!object(input) || typeof input.baselineKnown !== "boolean")
      throw problem("创建项目参数无效。");
    const record = {
      version: 1,
      id: randomUUID(),
      name: title(input.name),
      userData: absolute(await getUserDataPath()),
      upstreamRef: upstream(input.upstreamRef),
      originRef: upstream(input.upstreamRef),
      originModId: input.sourceModId ?? input.upstreamRef?.modId ?? null,
      baselineKnown: input.baselineKnown,
      baseSnapshotId: null,
      candidateSnapshotId: null,
      knownBasePaths: [],
      snapshots: [],
      history: [],
      retainedTrees: [],
      createdAt: now(),
      updatedAt: now(),
    };
    const captured = await snapshot(
      record,
      absolute(input.sourcePath),
      "初始基准",
      "base",
      null,
      input.checkSource,
      input.descriptorText,
    );
    record.baseSnapshotId = captured.entry.id;
    await input.checkSource?.();
    return transition(null, record, captured.contentPath, null, {
      type: "created",
      snapshotId: captured.entry.id,
      baselineKnown: record.baselineKnown,
      upstreamRef: clone(record.upstreamRef),
    });
  }
  async function checkedPlan(projectId, planId) {
    const plan = plans.get(projectId);
    if (!plan || plan.id !== planId)
      throw problem("合并计划已失效，请重新比较。", "PROJECT_PLAN_STALE");
    const { value: record, bytes } = await readRecord(projectId);
    if (sha(bytes) !== plan.recordHash)
      throw problem(
        "项目基准或候选已经变化，请重新比较。",
        "PROJECT_PLAN_STALE",
      );
    await assertScan(paths(record).workPath, plan.work);
    const base = await loadSnapshot(record, record.baseSnapshotId),
      candidate = await loadSnapshot(record, record.candidateSnapshotId);
    return { plan, record, bytes, base, candidate };
  }
  async function fileBuffer(root, name, manifest, bounded = true) {
    const info = treeFile(manifest.files, name);
    if (!info) return null;
    if (bounded && info.bytes > LIMITS.textBytes) return undefined;
    const result = await fileDigest(path.join(root, ...name.split("/")), {
      read: true,
      maxBytes: LIMITS.textBytes,
    });
    if (result.sha256 !== info.sha256)
      throw problem("合并文件已变化。", "PROJECT_SOURCE_CHANGED");
    return result.buffer;
  }
  async function textMerge(state, name, includeChunks = false) {
    const buffers = await Promise.all([
      fileBuffer(state.base.contentPath, name, state.base.manifest),
      fileBuffer(paths(state.record).workPath, name, state.plan.work),
      fileBuffer(state.candidate.contentPath, name, state.candidate.manifest),
    ]);
    if (buffers.includes(undefined)) return { status: "binary" };
    if (
      !state.record.baselineKnown &&
      !state.record.knownBasePaths?.includes(name)
    ) {
      const decoded = buffers.map((value) =>
        value === null
          ? null
          : mergeTextBuffers({
              base: value,
              local: value,
              upstream: value,
              maxBytes: LIMITS.textBytes,
            }),
      );
      if (decoded.some((v) => v && (v.status === "binary" || v.binary)))
        return { status: "binary", binary: true };
      const format = decoded[1] || decoded[2] || decoded[0];
      return {
        status: "conflict",
        baseText: decoded[0]?.localText ?? null,
        localText: decoded[1]?.localText ?? null,
        upstreamText: decoded[2]?.localText ?? null,
        encoding: format?.encoding,
        bom: format?.bom,
      };
    }
    const input = {
      base: buffers[0],
      local: buffers[1],
      upstream: buffers[2],
      maxBytes: LIMITS.textBytes,
    };
    const merged = mergeTextBuffers(input);
    if (includeChunks && !merged.binary && merged.status !== "binary") {
      const fragments = createTextMergeChunks(input);
      if (fragments.status === "text") merged.chunks = fragments.chunks;
    }
    return merged;
  }
  async function materialize(directory, mapping) {
    await chain(path.dirname(directory), true);
    await fs.mkdir(directory);
    const names = new Map();
    for (const [name, value] of [...mapping].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      namespace(names, rel(name));
      const target = path.join(directory, ...name.split("/"));
      await chain(path.dirname(target), true);
      if (Buffer.isBuffer(value)) await exclusive(target, value);
      else {
        const actual = await fileDigest(value.filename);
        if (actual.sha256 !== value.sha256 || actual.bytes !== value.bytes)
          throw problem("合并源发生变化。", "PROJECT_SOURCE_CHANGED");
        await fs.copyFile(value.filename, target, fs.constants.COPYFILE_EXCL);
        await fs.chmod(target, 0o600);
        await syncFile(target);
        const copied = await fileDigest(target);
        if (copied.sha256 !== value.sha256 || copied.bytes !== value.bytes)
          throw problem("复制的合并源发生变化。", "PROJECT_SOURCE_CHANGED");
      }
    }
  }
  const mapping = (root, manifest) =>
    new Map(
      Object.entries(manifest.files).map(([name, value]) => [
        name,
        { ...value, filename: path.join(root, ...name.split("/")) },
      ]),
    );
  async function selection(state, decisions) {
    const { record, plan, base, candidate } = state;
    if (!Array.isArray(decisions) || decisions.length > LIMITS.files)
      throw problem("合并选择无效。");
    const required = new Map(
        plan.entries.filter((e) => e.upstreamChanged).map((e) => [e.path, e]),
      ),
      chosen = new Map();
    for (const decision of decisions) {
      if (
        !object(decision) ||
        !required.has(decision.path) ||
        chosen.has(decision.path) ||
        !["auto", "upstream", "local", "defer", "manual"].includes(
          decision.choice,
        ) ||
        Object.keys(decision).some(
          (k) => !["path", "choice", "text"].includes(k),
        )
      )
        throw problem("合并选择包含重复或无效项目。");
      chosen.set(decision.path, decision);
    }
    if (chosen.size !== required.size)
      throw problem("每个上游变更都必须选择采纳、保留或暂缓。");
    const resultFiles = mapping(paths(record).workPath, plan.work),
      baseFiles = mapping(base.contentPath, base.manifest),
      upper = mapping(candidate.contentPath, candidate.manifest);
    let generatedBytes = 0;
    const generated = (name, bytes) => {
      generatedBytes += bytes.length;
      if (generatedBytes > LIMITS.mergeBytes)
        throw problem(
          "本次文本合并结果超过 64 MiB，请分批合入或整文件选择。",
          "PROJECT_LIMIT",
        );
      resultFiles.set(name, bytes);
    };
    const copyChoice = (target, name) =>
      upper.has(name) ? target.set(name, upper.get(name)) : target.delete(name);
    for (const [name, decision] of chosen) {
      if (decision.choice === "defer") continue;
      copyChoice(baseFiles, name);
      if (decision.choice === "upstream") copyChoice(resultFiles, name);
      else if (decision.choice === "auto") {
        if (!record.baselineKnown && !record.knownBasePaths?.includes(name))
          throw problem("基准未知时不能自动三方合并，请逐文件明确选择。");
        const entry = required.get(name);
        if (["upstream-only", "same"].includes(entry.status))
          copyChoice(resultFiles, name);
        else {
          const merged = await textMerge(state, name);
          if (merged.status !== "merged")
            throw problem(
              "文件需要手动解决冲突：" + name,
              "PROJECT_MERGE_CONFLICT",
            );
          if (merged.buffer === null) resultFiles.delete(name);
          else generated(name, merged.buffer);
        }
      } else if (decision.choice === "manual") {
        if (
          typeof decision.text !== "string" ||
          Buffer.byteLength(decision.text) > LIMITS.textBytes ||
          decision.text.includes("\0")
        )
          throw problem("手动合并内容必须是不超过 1 MiB 的文本。");
        const merged = await textMerge(state, name);
        if (merged.binary || merged.status === "binary")
          throw problem("二进制文件只能整文件选择。");
        const buffer = encodeMergeText(decision.text, {
          encoding: merged.encoding,
          bom: merged.bom,
        });
        if (buffer.length > LIMITS.textBytes)
          throw problem("手动合并编码后的内容超过 1 MiB。");
        generated(name, buffer);
      }
    }
    if (!resultFiles.has("descriptor.mod") || !baseFiles.has("descriptor.mod"))
      throw problem("不能删除项目根目录的 descriptor.mod。");
    const descriptor = resultFiles.get("descriptor.mod");
    const bytes = Buffer.isBuffer(descriptor)
      ? descriptor
      : await readSmall(descriptor.filename, LIMITS.textBytes);
    resultFiles.set("descriptor.mod", sanitizedDescriptor(bytes, record.name));
    // Validate the selected namespace before any staging writes (e.g. file-to-directory conflicts).
    for (const tree of [resultFiles, baseFiles]) {
      const names = new Map();
      for (const name of tree.keys()) namespace(names, name);
    }
    return { required, chosen, resultFiles, baseFiles };
  }
  async function selectionChecks(files, original, decisions) {
    const counts = {
      files: files.size,
      added: 0,
      changed: 0,
      deleted: 0,
      unchanged: 0,
      deferred: decisions.filter((v) => v.choice === "defer").length,
    };
    const texts = [];
    let budget = 0,
      truncated = false;
    for (const [name, value] of [...files].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      const info = Buffer.isBuffer(value)
        ? { bytes: value.length, sha256: sha(value) }
        : value;
      const old = treeFile(original.files, name);
      if (!old) counts.added++;
      else if (old.bytes !== info.bytes || old.sha256 !== info.sha256)
        counts.changed++;
      else counts.unchanged++;
      if (!/\.(?:txt|yml|yaml|mod)$/i.test(name)) continue;
      if (
        info.bytes > LIMITS.textBytes ||
        texts.length >= 2000 ||
        budget + info.bytes > LIMITS.checksBytes
      ) {
        truncated = true;
        continue;
      }
      const content = Buffer.isBuffer(value)
        ? value
        : await readSmall(value.filename, LIMITS.textBytes);
      if (sha(content) !== info.sha256)
        throw problem("合并预览源发生变化。", "PROJECT_SOURCE_CHANGED");
      budget += content.length;
      const decoded = mergeTextBuffers({
        base: content,
        local: content,
        upstream: content,
        maxBytes: LIMITS.textBytes,
      });
      if (
        !decoded.binary &&
        decoded.status !== "binary" &&
        typeof decoded.localText === "string"
      )
        texts.push({ path: name, text: decoded.localText });
      else truncated = true;
    }
    counts.deleted = Object.keys(original.files).filter(
      (name) => !files.has(name),
    ).length;
    const checks = analyzeProjectFiles(texts);
    checks.truncated = Boolean(checks.truncated || truncated);
    return {
      counts,
      checks,
      decisions: decisions.map((v) => ({ path: v.path, choice: v.choice })),
    };
  }

  return {
    isBusy: () => busy > 0,
    list: () =>
      serial(false, async () => {
        const projects = [];
        if (await optional(projectsRoot))
          for (const item of await fs.readdir(projectsRoot, {
            withFileTypes: true,
          })) {
            if (uuid(item.name) && (await optional(recordPath(item.name))))
              projects.push(present((await readRecord(item.name)).value));
          }
        return {
          projects: projects.sort((a, b) =>
            b.updatedAt.localeCompare(a.updatedAt),
          ),
          busy: busy > 0,
        };
      }),
    get: (projectId) =>
      serial(false, async () =>
        present((await readRecord(id(projectId))).value),
      ),
    create: (input) => serial(true, () => createInner(input)),
    captureCandidate: (projectId, input) =>
      serial(true, async () => {
        const { value: record, bytes } = await readRecord(id(projectId)),
          ref = upstream(input?.upstreamRef);
        if (!sameUpstream(record.upstreamRef, ref))
          throw problem("候选来源与项目上游不一致，请先设置上游。");
        const candidate = await snapshot(
          record,
          absolute(input.sourcePath),
          "上游候选 " + (ref?.revision || now().slice(0, 10)),
          "candidate",
          context(record),
          input.checkSource,
          input.descriptorText,
        );
        record.candidateSnapshotId = candidate.entry.id;
        history(record, {
          type: "candidate",
          snapshotId: candidate.entry.id,
          upstreamRef: ref,
        });
        await input.checkSource?.();
        await gameGuard();
        await saveRecord(record, bytes);
        return present(record);
      }),
    setUpstream: (projectId, value) =>
      serial(true, async () => {
        const { value: record, bytes } = await readRecord(id(projectId)),
          ref = upstream(value);
        if (record.originRef === undefined)
          record.originRef = clone(record.upstreamRef);
        if (!sameUpstream(record.upstreamRef, ref)) {
          record.baselineKnown = false;
          record.knownBasePaths = [];
          record.candidateSnapshotId = null;
        }
        record.upstreamRef = ref;
        history(record, { type: "upstream-changed", upstreamRef: ref });
        await saveRecord(record, bytes);
        return present(record);
      }),
    inspect: (projectId) =>
      serial(false, async () => {
        const { value: record } = await readRecord(id(projectId)),
          base = await loadSnapshot(record, record.baseSnapshotId),
          work = await scan(paths(record).workPath);
        const entries = createMergePlan({
          base: base.manifest.files,
          local: work.files,
          upstream: base.manifest.files,
          baselineKnown: true,
        }).entries;
        const { checks } = await selectionChecks(
          mapping(paths(record).workPath, work),
          work,
          [],
        );
        await assertScan(paths(record).workPath, work);
        return {
          project: present(record),
          changes: entries
            .filter((e) => e.localChanged)
            .map((e) => ({
              path: e.path,
              status: !treeFile(work.files, e.path)
                ? "deleted"
                : !treeFile(base.manifest.files, e.path)
                  ? "added"
                  : "modified",
            })),
          digest: work.digest,
          checks,
        };
      }),
    checkpoint: (projectId, name) =>
      serial(true, async () => {
        const { value: record, bytes } = await readRecord(id(projectId));
        const saved = await snapshot(
          record,
          paths(record).workPath,
          name,
          "checkpoint",
        );
        history(record, { type: "checkpoint", snapshotId: saved.entry.id });
        await gameGuard();
        await saveRecord(record, bytes);
        return present(record);
      }),
    restore: (projectId, snapshotId) =>
      serial(true, async () => {
        const { value: previous } = await readRecord(id(projectId)),
          record = clone(previous),
          target = await loadSnapshot(record, snapshotId);
        if (["candidate", "merge-base"].includes(target.entry.kind))
          throw problem(
            "上游候选和逐文件比较基准不能作为可玩版本恢复，请选择检查点。",
          );
        const work = await scan(paths(record).workPath),
          before = await snapshot(
            record,
            paths(record).workPath,
            "恢复前检查点",
            "before-restore",
          );
        if (target.manifest.context) {
          const ctx = target.manifest.context;
          if (
            !object(ctx) ||
            typeof ctx.baselineKnown !== "boolean" ||
            !Array.isArray(ctx.history)
          )
            throw problem("检查点缺少有效的合并上下文。");
          for (const value of [
            ctx.baseSnapshotId,
            ctx.candidateSnapshotId,
          ].filter(Boolean))
            await loadSnapshot(record, value);
          record.baseSnapshotId = ctx.baseSnapshotId;
          record.candidateSnapshotId = ctx.candidateSnapshotId;
          record.baselineKnown = ctx.baselineKnown;
          record.knownBasePaths = clone(ctx.knownBasePaths || []);
          record.upstreamRef = upstream(ctx.upstreamRef);
          record.history = clone(ctx.history);
        } else if (target.entry.kind === "base") {
          record.baseSnapshotId = target.entry.id;
          record.candidateSnapshotId = null;
          record.baselineKnown =
            previous.history.find((v) => v.type === "created")?.baselineKnown ??
            previous.baselineKnown;
        } else throw problem("此快照缺少恢复上下文。");
        return transition(previous, record, target.contentPath, work, {
          type: "restored",
          snapshotId,
          beforeSnapshotId: before.entry.id,
        });
      }),
    prepareMerge: (projectId) =>
      serial(false, async () => {
        const { value: record, bytes } = await readRecord(id(projectId));
        if (!record.candidateSnapshotId)
          throw problem("请先取得上游候选版本。");
        const base = await loadSnapshot(record, record.baseSnapshotId),
          candidate = await loadSnapshot(record, record.candidateSnapshotId),
          work = await scan(paths(record).workPath);
        const result = mergePlan(
          record,
          base.manifest.files,
          work.files,
          candidate.manifest.files,
        );
        const plan = {
          id: randomUUID(),
          projectId,
          recordHash: sha(bytes),
          work,
          ...result,
        };
        let checkedBytes = 0,
          checkedFiles = 0;
        result.counts.merged = 0;
        if (record.baselineKnown)
          for (const entry of result.entries) {
            if (entry.status !== "conflict") continue;
            const bytes = [
              base.manifest.files,
              work.files,
              candidate.manifest.files,
            ].reduce(
              (sum, tree) => sum + (treeFile(tree, entry.path)?.bytes || 0),
              0,
            );
            if (
              checkedFiles >= 200 ||
              checkedBytes + bytes > LIMITS.checksBytes
            )
              continue;
            checkedBytes += bytes;
            checkedFiles++;
            const combined = await textMerge(
              { plan, record, base, candidate },
              entry.path,
            );
            if (combined.status === "merged" && !combined.binary) {
              entry.status = "merged";
              entry.suggested = "auto";
              result.counts.conflict--;
              result.counts.conflicts--;
              result.counts.merged++;
            }
          }
        plans.set(projectId, plan);
        return {
          id: plan.id,
          projectId,
          entries: clone(result.entries),
          counts: clone(result.counts),
        };
      }),
    readMergeFile: (projectId, planId, filename) =>
      serial(false, async () => {
        const state = await checkedPlan(id(projectId), planId),
          name = rel(filename);
        const entry = state.plan.entries.find((e) => e.path === name);
        if (!entry) throw problem("该文件不在合并计划中。");
        const merged = await textMerge(state, name, true);
        return {
          path: name,
          status: merged.status,
          baseText: merged.baseText ?? null,
          localText: merged.localText ?? null,
          upstreamText: merged.upstreamText ?? null,
          mergedText: merged.mergedText ?? null,
          binary: Boolean(merged.binary || merged.status === "binary"),
          encoding: merged.encoding,
          bom: merged.bom,
          chunks: merged.chunks || [],
          baselineKnown:
            state.record.baselineKnown ||
            Boolean(state.record.knownBasePaths?.includes(name)),
        };
      }),
    previewMerge: (projectId, planId, decisions) =>
      serial(false, async () => {
        const state = await checkedPlan(id(projectId), planId),
          selected = await selection(state, decisions);
        const result = await selectionChecks(
          selected.resultFiles,
          state.plan.work,
          decisions,
        );
        await checkedPlan(projectId, planId);
        return result;
      }),
    applyMerge: (projectId, planId, decisions) =>
      serial(true, async () => {
        const state = await checkedPlan(id(projectId), planId),
          { record: previous, plan, base, candidate } = state;
        const { required, resultFiles, baseFiles } = await selection(
          state,
          decisions,
        );
        if (!required.size && previous.baselineKnown) return present(previous);
        if (!required.size) {
          const record = clone(previous),
            before = await snapshot(
              record,
              paths(record).workPath,
              "建立基准前检查点",
              "before-merge",
            );
          record.baseSnapshotId = record.candidateSnapshotId;
          record.baselineKnown = true;
          record.knownBasePaths = [];
          history(record, {
            type: "baseline-established",
            snapshotId: record.baseSnapshotId,
            beforeSnapshotId: before.entry.id,
            scope: "future-comparisons",
            initialAncestryVerified: false,
          });
          await checkedPlan(projectId, planId);
          await gameGuard();
          await saveRecord(record, state.bytes);
          return present(record);
        }
        const record = clone(previous),
          before = await snapshot(
            record,
            paths(record).workPath,
            "合并前检查点",
            "before-merge",
          );
        const taskRoot = path.join(
          projectRoot(projectId),
          "operations",
          randomUUID(),
        );
        const newBase = path.join(taskRoot, "base"),
          resultRoot = path.join(taskRoot, "result");
        await materialize(newBase, baseFiles);
        await materialize(resultRoot, resultFiles);
        const establishing =
          !record.baselineKnown && decisions.every((v) => v.choice !== "defer");
        if (establishing) {
          record.baseSnapshotId = candidate.entry.id;
          record.baselineKnown = true;
          record.knownBasePaths = [];
          history(record, {
            type: "baseline-established",
            snapshotId: candidate.entry.id,
            beforeSnapshotId: before.entry.id,
            scope: "future-comparisons",
            initialAncestryVerified: false,
          });
        } else {
          const synthetic = await snapshot(
            record,
            newBase,
            "逐文件合并基准",
            "merge-base",
          );
          record.baseSnapshotId = synthetic.entry.id;
          if (!record.baselineKnown)
            record.knownBasePaths = [
              ...new Set([
                ...(record.knownBasePaths || []),
                ...decisions
                  .filter((v) => v.choice !== "defer")
                  .map((v) => v.path),
              ]),
            ].sort();
        }
        await checkedPlan(projectId, planId);
        return transition(previous, record, resultRoot, plan.work, {
          type: "merged",
          candidateSnapshotId: previous.candidateSnapshotId,
          beforeSnapshotId: before.entry.id,
          baseSnapshotId: record.baseSnapshotId,
          baselineEstablished: establishing,
          decisions: decisions.map((v) => ({ path: v.path, choice: v.choice })),
        });
      }),
    resolveVersion: (projectId, snapshotId) =>
      serial(false, async () => {
        const { value: record } = await readRecord(id(projectId));
        if (snapshotId === null || snapshotId === undefined) {
          const contentPath = paths(record).workPath;
          await chain(contentPath);
          const descriptor = sanitizedDescriptor(
            await readSmall(
              path.join(contentPath, "descriptor.mod"),
              LIMITS.textBytes,
            ),
            record.name,
          );
          return {
            contentPath,
            descriptorText: descriptor.toString("utf8"),
            snapshotId: null,
            name: record.name,
          };
        }
        const selected = await loadSnapshot(record, snapshotId);
        if (["candidate", "merge-base"].includes(selected.entry.kind))
          throw problem(
            "上游候选和逐文件比较基准不能固定为可玩版本，请选择检查点。",
          );
        const descriptor = sanitizedDescriptor(
          await readSmall(
            path.join(selected.contentPath, "descriptor.mod"),
            LIMITS.textBytes,
          ),
          record.name,
        );
        return {
          contentPath: selected.contentPath,
          descriptorText: descriptor.toString("utf8"),
          snapshotId,
          name: record.name,
          digest: selected.manifest.digest,
        };
      }),
    exportProject: (projectId, destinationPath) =>
      serial(true, async () => {
        const { value: record } = await readRecord(id(projectId)),
          destination = absolute(destinationPath);
        if (
          within(storage, destination) ||
          within(paths(record).workPath, destination)
        )
          throw problem("请把项目备份保存到工作区和项目管理目录之外。");
        if (await optional(destination))
          throw problem("备份目标已经存在，请选择新文件，未覆盖已有内容。");
        const taskRoot = path.join(
          projectRoot(projectId),
          "exports",
          randomUUID(),
        );
        await chain(taskRoot, true);
        const content = path.join(taskRoot, "package");
        await fs.mkdir(content);
        const work = await copyTree(
          paths(record).workPath,
          path.join(content, "work"),
        );
        const metadata = clone(record);
        delete metadata.userData;
        delete metadata.registrationText;
        metadata.retainedTrees = [];
        for (const s of record.snapshots) {
          const selected = await loadSnapshot(record, s.id),
            target = path.join(content, "snapshots", s.id);
          await chain(target, true);
          await copyTree(selected.contentPath, path.join(target, "content"));
          await exclusive(
            path.join(target, "manifest.json"),
            await readSmall(
              path.join(snapshotRoot(record.id, s.id), "manifest.json"),
            ),
          );
        }
        const backupMetadata = Buffer.from(
          JSON.stringify({
            format: "ironclad-mod-project",
            version: 1,
            project: metadata,
            workDigest: work.digest,
          }),
        );
        if (backupMetadata.length > LIMITS.jsonBytes)
          throw problem("项目备份记录超过 64 MiB。", "PROJECT_LIMIT");
        await exclusive(path.join(content, "backup.json"), backupMetadata);
        const tree = await scan(content);
        await chain(path.dirname(destination), true);
        const output = await fs.open(destination, "wx"),
          zip = new yazl.ZipFile();
        let zipError = null,
          bytes = 0;
        zip.on("error", (e) => {
          zipError = e;
          zip.outputStream.destroy(e);
        });
        zip.outputStream.on("error", () => {});
        try {
          for (const name of Object.keys(tree.files).sort())
            zip.addFile(path.join(content, ...name.split("/")), name);
          zip.end();
          for await (const chunk of zip.outputStream) {
            bytes += chunk.length;
            if (bytes > LIMITS.bytes)
              throw problem("项目备份 ZIP 超过 20 GiB。", "PROJECT_LIMIT");
            await output.writeFile(chunk);
          }
          if (zipError) throw zipError;
          await output.sync();
        } finally {
          zip.outputStream.destroy();
          await output.close();
        }
        await assertScan(content, tree);
        const verification = path.join(taskRoot, "verified");
        await unzip(destination, verification);
        await assertScan(verification, tree);
        return { path: destination };
      }),
    importProject: (sourcePath) =>
      serial(true, async () => {
        const imported = path.join(storage, "imports", randomUUID());
        await chain(path.dirname(imported), true);
        await unzip(absolute(sourcePath), imported);
        const backup = JSON.parse(
          await readSmall(path.join(imported, "backup.json")),
        );
        if (
          !object(backup) ||
          backup.format !== "ironclad-mod-project" ||
          backup.version !== 1 ||
          !object(backup.project)
        )
          throw problem("不是有效的 IRONCLAD 项目备份。");
        const userData = absolute(await getUserDataPath()),
          original = validateRecord({ ...backup.project, userData }),
          newId = randomUUID();
        const record = {
          ...clone(original),
          id: newId,
          userData,
          originRef: clone(
            original.originRef === undefined
              ? original.upstreamRef
              : original.originRef,
          ),
          retainedTrees: [],
          createdAt: now(),
          updatedAt: now(),
        };
        const work = await scan(path.join(imported, "work"));
        if (work.digest !== backup.workDigest)
          throw problem("备份工作区摘要不匹配。");
        for (const s of record.snapshots) {
          const source = path.join(imported, "snapshots", s.id),
            bytes = await readSmall(path.join(source, "manifest.json"));
          if (sha(bytes) !== s.manifestSha256)
            throw problem("备份快照清单摘要不匹配。");
          const manifest = validateManifest(JSON.parse(bytes));
          if (manifest.digest !== s.digest)
            throw problem("备份快照引用不匹配。");
          await assertScan(path.join(source, "content"), manifest);
          const target = snapshotRoot(newId, s.id);
          await chain(target, true);
          await copyTree(
            path.join(source, "content"),
            path.join(target, "content"),
          );
          await exclusive(path.join(target, "manifest.json"), bytes);
        }
        return transition(null, record, path.join(imported, "work"), null, {
          type: "imported",
          originalProjectId: original.id,
        });
      }),
  };
}

module.exports = { createModProjectService, PROJECT_LIMITS: LIMITS };
