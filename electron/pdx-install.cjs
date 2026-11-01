"use strict";

const fs = require("node:fs/promises");
const nativeFs = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { promisify, TextDecoder } = require("node:util");
const yauzl = require("yauzl");
const { parseDescriptor } = require("./mod-authoring.cjs");
const { createRelocation } = require("./pdx-install-relocation.cjs");
const { createPdxFileIntegrity } = require("./pdx-file-integrity.cjs");

const openFd = promisify(nativeFs.open),
  closeFd = promisify(nativeFs.close),
  readFd = promisify(nativeFs.read),
  statFd = promisify(nativeFs.fstat);
const LIMITS = Object.freeze({
  archiveBytes: 5 * 1024 ** 3,
  entries: 100000,
  fileBytes: 4 * 1024 ** 3,
  totalBytes: 20 * 1024 ** 3,
  ratio: 1000,
  descriptorBytes: 1024 ** 2,
});
const clone = (value) => JSON.parse(JSON.stringify(value));
const hash = (value) => createHash("sha256").update(value).digest("hex");
const canonical = (value) => path.resolve(value).toLowerCase();
const within = (root, target) => {
  const r = path.relative(root, target);
  return r !== ".." && !r.startsWith(".." + path.sep) && !path.isAbsolute(r);
};
const identity = (s) => ({
  ino: s.ino,
  dev: s.dev,
  birthtimeMs: s.birthtimeMs,
});
const same = (a, b) =>
  a &&
  b &&
  a.ino === b.ino &&
  a.dev === b.dev &&
  a.birthtimeMs === b.birthtimeMs;
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const quote = (value) =>
  '"' + value.replace(/\\/g, "/").replace(/"/g, '\\"') + '"';
const marker = (id) => `# Managed by IRONCLAD PDX installer: ${id}\n`;
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let i = 0; i < 8; i++)
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crcUpdate(crc, bytes) {
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return crc >>> 0;
}
function abort(signal) {
  if (signal?.aborted) {
    const error = new Error("模组安装已取消，原版本保持不变。");
    error.name = "AbortError";
    throw error;
  }
}
function numeric(value, allowZero = false) {
  if (Number.isSafeInteger(value)) value = String(value);
  if (
    typeof value !== "string" ||
    !(allowZero ? /^(?:0|[1-9]\d{0,19})$/ : /^[1-9]\d{0,19}$/).test(value)
  )
    throw new Error("Paradox 模组编号或版本无效。");
  return value;
}
function absolute(value) {
  if (
    typeof value !== "string" ||
    !path.isAbsolute(value) ||
    /[\0-\x1f]/.test(value)
  )
    throw new Error("安装目录必须是有效的绝对路径。");
  return path.resolve(value);
}
async function optional(file) {
  try {
    return await fs.lstat(file);
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}
async function directoryChain(directory, create = false, tracked = []) {
  const absolutePath = absolute(directory),
    parsed = path.parse(absolutePath);
  let current = parsed.root;
  for (const part of absolutePath
    .slice(parsed.root.length)
    .split(path.sep)
    .filter(Boolean)) {
    current = path.join(current, part);
    let s = await optional(current),
      made = false;
    if (!s && create) {
      try {
        await fs.mkdir(current);
        made = true;
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
      }
      s = await fs.lstat(current);
    }
    if (
      !s?.isDirectory() ||
      s.isSymbolicLink() ||
      canonical(await fs.realpath(current)) !== canonical(current)
    )
      throw new Error("安装目录包含链接、目录联接或路径重定向。");
    if (made) tracked.push({ path: current, identity: identity(s) });
  }
}
async function fileDigest(file, expected, signal, links = 1) {
  await directoryChain(path.dirname(file));
  const before = await fs.lstat(file);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink > links ||
    (expected && !same(before, expected))
  )
    throw new Error("安装文件身份发生变化或包含链接。");
  const handle = await fs.open(file, "r");
  try {
    if (!same(await handle.stat(), before))
      throw new Error("安装文件在读取时发生变化。");
    const h = createHash("sha256"),
      buffer = Buffer.allocUnsafe(1024 * 1024);
    let bytes = 0;
    while (true) {
      abort(signal);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      h.update(buffer.subarray(0, bytesRead));
      bytes += bytesRead;
      if (bytes > before.size) throw new Error("安装文件在读取时发生变化。");
    }
    const after = await handle.stat();
    if (
      !same(after, before) ||
      after.size !== before.size ||
      after.nlink > links ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      !same(await fs.lstat(file), before)
    )
      throw new Error("安装文件在读取时发生变化。");
    return {
      hash: h.digest("hex"),
      bytes,
      identity: identity(after),
      mtimeMs: after.mtimeMs,
      ctimeMs: after.ctimeMs,
    };
  } finally {
    await handle.close();
  }
}
async function jsonRead(file) {
  const s = await optional(file);
  if (!s) return null;
  if (
    !s.isFile() ||
    s.isSymbolicLink() ||
    s.nlink !== 1 ||
    s.size > 64 * 1024 ** 2
  )
    throw new Error("安装记录无效，已停止操作以保留现有模组。");
  return JSON.parse(await fs.readFile(file, "utf8"));
}
async function jsonWrite(file, value) {
  await directoryChain(path.dirname(file));
  const current = await optional(file);
  if (
    current &&
    (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1)
  )
    throw new Error("安装记录目标不是独立普通文件。");
  const tmp = file + ".tmp-" + randomUUID();
  try {
    await fs.writeFile(tmp, JSON.stringify(value), { flag: "wx" });
    await directoryChain(path.dirname(file));
    await fs.rename(tmp, file);
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
}
function zipName(entry) {
  const value = entry.fileName;
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 1024 ||
    value.includes("\\") ||
    value.startsWith("/") ||
    /[\0-\x1f\x7f<>:"|?*]/.test(value)
  )
    throw new Error("ZIP 包含不安全的文件路径。");
  const directory = value.endsWith("/"),
    parts = (directory ? value.slice(0, -1) : value).split("/");
  if (
    parts.length > 64 ||
    parts.some(
      (p) =>
        !p ||
        p === "." ||
        p === ".." ||
        /[. ]$/.test(p) ||
        p.length > 255 ||
        /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³]|CONIN\$|CONOUT\$|CLOCK\$)(?:\.|$)/i.test(
          p,
        ),
    )
  )
    throw new Error("ZIP 包含 Windows 保留名称或越界路径。");
  const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
  if (
    (mode && mode !== (directory ? 0x4000 : 0x8000)) ||
    entry.externalFileAttributes & 0x400 ||
    (entry.extraFields || []).some((field) =>
      [0x000d, 0x5855, 0x756e].includes(field.id),
    )
  )
    throw new Error("ZIP 不能包含符号链接、硬链接或特殊文件。");
  if (
    entry.generalPurposeBitFlag & 1 ||
    ![0, 8].includes(entry.compressionMethod)
  )
    throw new Error("ZIP 不能加密或使用不支持的压缩格式。");
  return {
    relative: parts.join(path.sep),
    directory,
    key: parts.join("/").toLowerCase(),
  };
}
function checkedPlan(plan) {
  if (!object(plan)) throw new Error("缺少已验证的下载计划。");
  const modId = numeric(plan.modId),
    revision = numeric(plan.revision, true);
  if (
    !Number.isSafeInteger(plan.bytes) ||
    plan.bytes <= 0 ||
    plan.bytes > LIMITS.archiveBytes
  )
    throw new Error("ZIP 长度无效或超过 5 GiB。");
  let sha256 = plan.sha256;
  if (typeof sha256 === "string" && /^[A-Fa-f0-9]{64}$/.test(sha256))
    sha256 = sha256.toLowerCase();
  else if (
    typeof sha256 === "string" &&
    /^[A-Za-z0-9+/]{43}=$/.test(sha256) &&
    Buffer.from(sha256, "base64").toString("base64") === sha256
  )
    sha256 = Buffer.from(sha256, "base64").toString("hex");
  else throw new Error("ZIP 缺少有效的 SHA-256 摘要。");
  const title = typeof plan.title === "string" ? plan.title.trim() : "";
  if (!title || title.length > 200 || /[\0-\x1f\x7f]/.test(title))
    throw new Error("模组标题无效。");
  if (
    typeof plan.platform !== "string" ||
    !/^[A-Za-z0-9_-]{1,80}$/.test(plan.platform)
  )
    throw new Error("模组平台无效。");
  return {
    modId,
    revision,
    title,
    bytes: plan.bytes,
    sha256,
    platform: plan.platform,
  };
}

function createPdxInstallService({
  storageDirectory,
  isGameRunning = async () => false,
  validateUserDataPath = async () => {},
} = {}) {
  const root = absolute(storageDirectory),
    databasePath = path.join(root, "installations.json"),
    journalPath = path.join(root, "transaction.json"),
    lockPath = path.join(root, "install.lock");
  const fileIntegrity = createPdxFileIntegrity({ storageDirectory: root });
  let queue = Promise.resolve();
  const serial = (fn) => {
    const result = queue.then(fn);
    queue = result.catch(() => {});
    return result;
  };
  const publicRecord = (record) => ({
    modId: record.modId,
    revision: record.revision,
    contentPath: record.contentPath,
    descriptorPath: record.descriptorPath,
    title: record.title,
    archiveSha256: record.archiveSha256,
    installationId: record.transactionId,
  });
  async function gameGuard() {
    if (await isGameRunning())
      throw new Error("请先退出游戏，再安装或卸载模组。");
  }
  function validateRecord(r, db) {
    if (
      !object(r) ||
      numeric(r.modId) !== r.modId ||
      numeric(r.revision, true) !== r.revision ||
      typeof r.transactionId !== "string" ||
      !/^[a-f0-9-]{36}$/.test(r.transactionId)
    )
      throw new Error("安装记录格式无效。");
    r.contentRootId ??= "default";
    const contentRoot = db.roots.find((item) => item.id === r.contentRootId);
    if (!contentRoot) throw new Error("安装记录引用了未知内容目录。");
    const directory = path.join(
      contentRoot.path,
      "versions",
      r.modId,
      r.revision + "-" + r.transactionId,
    );
    if (
      canonical(r.contentPath) !== canonical(path.join(directory, "content")) ||
      canonical(r.descriptorPath) !==
        canonical(
          path.join(
            absolute(r.userDataPath),
            "mod",
            `pdx_${r.modId}_${r.revision}.mod`,
          ),
        ) ||
      !object(r.descriptor) ||
      r.descriptor.hash !== hash(r.descriptor.text) ||
      !r.descriptor.text.startsWith(marker(r.transactionId)) ||
      !object(r.contentIdentity)
    )
      throw new Error("安装记录路径或描述文件校验无效。");
    if (r.integrity !== undefined) fileIntegrity.validateReference(r.integrity);
    return r;
  }
  function validateDatabase(db) {
    if (
      db.version !== 2 ||
      !Number.isSafeInteger(db.generation) ||
      db.generation < 0 ||
      !Array.isArray(db.roots) ||
      !Array.isArray(db.locations) ||
      !Array.isArray(db.records) ||
      !Array.isArray(db.retainedVersions) ||
      db.records.length + db.retainedVersions.length > 10000 ||
      db.roots.length > 1000
    )
      throw new Error("安装数据库格式无效。");
    const ids = new Set(),
      paths = new Set();
    for (const item of db.roots) {
      if (
        !object(item) ||
        !object(item.identity) ||
        (item.id !== "default" && !/^[a-f0-9-]{36}$/.test(item.id)) ||
        canonical(item.path) !==
          canonical(
            item.id === "default"
              ? root
              : path.join(absolute(item.parent), "hoi4", "ironclad"),
          ) ||
        ids.has(item.id) ||
        paths.has(canonical(item.path))
      )
        throw new Error("内容目录登记无效。");
      ids.add(item.id);
      paths.add(canonical(item.path));
    }
    if (!ids.has("default")) throw new Error("缺少默认内容目录登记。");
    const profiles = new Set();
    for (const item of db.locations) {
      const profile = canonical(absolute(item.userDataPath));
      if (!ids.has(item.rootId) || profiles.has(profile))
        throw new Error("游戏目录的位置设置无效。");
      profiles.add(profile);
    }
    const transactions = new Set();
    for (const record of [...db.records, ...db.retainedVersions]) {
      validateRecord(record, db);
      if (transactions.has(record.transactionId))
        throw new Error("安装版本记录重复。");
      transactions.add(record.transactionId);
    }
    for (const record of db.retainedVersions)
      if (
        !/^[a-f0-9-]{36}$/.test(record.backupId) ||
        record.backupPath !==
          record.descriptorPath + ".ironclad-backup-" + record.backupId
      )
        throw new Error("保留版本的注册备份无效。");
    return db;
  }
  async function load() {
    await directoryChain(root, true);
    let db = (await jsonRead(databasePath)) || { version: 1, records: [] };
    if (db.version === 1) {
      if (!Array.isArray(db.records)) throw new Error("安装数据库格式无效。");
      db = {
        version: 2,
        generation: 0,
        roots: [
          {
            id: "default",
            path: root,
            identity: identity(await fs.lstat(root)),
          },
        ],
        locations: [],
        records: db.records,
        retainedVersions: [],
      };
    }
    validateDatabase(db);
    await assertContentRoot(db.roots.find((item) => item.id === "default"));
    return db;
  }
  async function saveDatabase(db) {
    db.generation++;
    validateDatabase(db);
    await jsonWrite(databasePath, db);
  }
  function selectedRoot(db, userdir) {
    const id =
      db.locations.find(
        (item) => canonical(item.userDataPath) === canonical(userdir),
      )?.rootId || "default";
    return db.roots.find((item) => item.id === id);
  }
  async function assertContentRoot(item) {
    await directoryChain(item.path);
    if (!same(await fs.lstat(item.path), item.identity))
      throw new Error("内容目录身份发生变化，请检查位置或恢复记录。");
  }
  function retain(db, record, backupId) {
    if (record)
      db.retainedVersions.push({
        ...clone(record),
        backupId,
        backupPath: record.descriptorPath + ".ironclad-backup-" + backupId,
      });
  }
  async function locked(fn) {
    await directoryChain(root, true);
    let lock;
    try {
      lock = await fs.open(lockPath, "wx");
      await lock.writeFile(String(process.pid));
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const s = await fs.lstat(lockPath);
      if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.size > 20)
        throw new Error("安装锁无效，请检查安装记录。");
      const pid = Number(await fs.readFile(lockPath, "utf8"));
      let alive = true;
      if (!Number.isSafeInteger(pid) || pid < 1)
        throw new Error("安装锁无效，请检查安装记录。");
      try {
        process.kill(pid, 0);
      } catch (e) {
        if (e.code === "ESRCH") alive = false;
      }
      if (alive) throw new Error("另一项模组安装正在进行，请稍后重试。");
      if (!same(await fs.lstat(lockPath), s))
        throw new Error("安装锁在恢复期间发生变化。");
      await fs.unlink(lockPath);
      lock = await fs.open(lockPath, "wx");
      await lock.writeFile(String(process.pid));
    }
    const own = identity(await lock.stat());
    try {
      return await fn();
    } finally {
      await lock.close();
      const s = await optional(lockPath);
      if (same(s, own) && s.isFile() && !s.isSymbolicLink())
        await fs.unlink(lockPath);
    }
  }
  async function descriptorMatches(file, descriptor, links = 1) {
    try {
      await directoryChain(path.dirname(file));
      const s = await fs.lstat(file);
      if (
        !s.isFile() ||
        s.isSymbolicLink() ||
        s.nlink > links ||
        !same(s, descriptor.identity) ||
        s.size !==
          (typeof descriptor.text === "string"
            ? Buffer.byteLength(descriptor.text)
            : descriptor.bytes)
      )
        return false;
      const checked = await fileDigest(
        file,
        descriptor.identity,
        undefined,
        links,
      );
      return checked.hash === descriptor.hash && checked.bytes === s.size;
    } catch {
      return false;
    }
  }
  function validateRegistration(value) {
    if (
      value !== null &&
      (!object(value) ||
        !object(value.identity) ||
        !Number.isSafeInteger(value.bytes) ||
        value.bytes < 0 ||
        value.bytes > LIMITS.descriptorBytes ||
        typeof value.hash !== "string" ||
        !/^[a-f0-9]{64}$/.test(value.hash))
    )
      throw new Error("修复注册文件的恢复记录无效。");
    return value;
  }
  async function captureRegistration(record, signal) {
    await directoryChain(path.dirname(record.descriptorPath), true);
    const current = await optional(record.descriptorPath);
    if (!current) return null;
    if (
      !current.isFile() ||
      current.isSymbolicLink() ||
      current.nlink !== 1 ||
      current.size > LIMITS.descriptorBytes
    )
      throw new Error("注册描述文件不是可安全备份的普通文件，已停止修复。");
    const snapshot = await fileDigest(
      record.descriptorPath,
      identity(current),
      signal,
    );
    return {
      identity: snapshot.identity,
      hash: snapshot.hash,
      bytes: snapshot.bytes,
    };
  }
  async function removeDescriptor(file, descriptor, links = 1) {
    if (!(await optional(file))) return;
    if (!(await descriptorMatches(file, descriptor, links)))
      throw new Error("描述文件已被其他程序修改，已保留该文件。");
    await directoryChain(path.dirname(file));
    const current = await fs.lstat(file);
    if (!same(current, descriptor.identity) || current.isSymbolicLink())
      throw new Error("描述文件在删除前发生变化。");
    await fs.unlink(file);
  }
  async function activeRecord(record) {
    try {
      await directoryChain(record.contentPath);
      return (
        same(await fs.lstat(record.contentPath), record.contentIdentity) &&
        (await descriptorMatches(record.descriptorPath, record.descriptor))
      );
    } catch {
      return false;
    }
  }
  async function recoverInner() {
    const db = await load(),
      tx = await jsonRead(journalPath);
    if (!tx) return { recovered: false, action: null };
    await gameGuard();
    if (tx.type === "relocate") return relocation.recover(tx, db);
    if (
      !object(tx) ||
      tx.version !== 1 ||
      !["install", "uninstall"].includes(tx.type)
    )
      throw new Error("安装事务记录无效，已保留恢复文件。");
    const record = validateRecord(tx.record, db),
      old = tx.old ? validateRecord(tx.old, db) : null;
    const repairRegistration = Object.hasOwn(tx, "repairRegistration");
    if (repairRegistration && (tx.type !== "install" || !old))
      throw new Error("修复注册文件的恢复记录无效。");
    const oldDescriptor = repairRegistration
      ? validateRegistration(tx.repairRegistration)
      : old?.descriptor;
    const backupId = tx.backupId || record.transactionId;
    if (typeof backupId !== "string" || !/^[a-f0-9-]{36}$/.test(backupId))
      throw new Error("安装备份记录无效。");
    const backup =
      old && oldDescriptor
        ? old.descriptorPath + ".ironclad-backup-" + backupId
        : null;
    const temp =
      record.descriptorPath + ".ironclad-tmp-" + record.transactionId;
    if (
      tx.type === "uninstall" &&
      (!old || old.transactionId !== record.transactionId)
    )
      throw new Error("卸载恢复记录无效。");
    const committed =
      tx.type === "install"
        ? db.records.some((r) => r.transactionId === record.transactionId)
        : !db.records.some((r) => r.transactionId === record.transactionId);
    if (committed) {
      if (tx.type === "install" && !(await activeRecord(record)))
        throw new Error("安装已提交但文件已改变，请保留备份并检查安装。");
      if (await optional(temp))
        await removeDescriptor(temp, record.descriptor, 2);
      await fs.unlink(journalPath);
      return { recovered: true, action: "completed" };
    }
    if (tx.type === "install") {
      if (await descriptorMatches(record.descriptorPath, record.descriptor, 2))
        await removeDescriptor(record.descriptorPath, record.descriptor, 2);
      if (await optional(temp))
        await removeDescriptor(temp, record.descriptor, 2);
    }
    if (backup && (await optional(backup))) {
      if (!(await descriptorMatches(backup, oldDescriptor, 2)))
        throw new Error("旧版恢复描述文件已改变，未覆盖任何文件。");
      if (await optional(old.descriptorPath)) {
        if (!(await descriptorMatches(old.descriptorPath, oldDescriptor, 2)))
          throw new Error("旧版注册位置已被占用，未覆盖任何文件。");
        await removeDescriptor(backup, oldDescriptor, 2);
      } else {
        if ((await fs.lstat(backup)).nlink !== 1)
          throw new Error("旧版备份包含不明硬链接，已停止恢复。");
        await directoryChain(path.dirname(old.descriptorPath));
        await fs.link(backup, old.descriptorPath);
        await fs.unlink(backup);
      }
    }
    await fs.unlink(journalPath);
    return { recovered: true, action: "rolled-back" };
  }
  async function moveOld(old, transactionId, registration = old?.descriptor) {
    if (!old) return;
    if (registration === null) {
      if (await optional(old.descriptorPath))
        throw new Error("注册描述文件在修复前发生变化，已停止操作。");
      return;
    }
    if (!(await descriptorMatches(old.descriptorPath, registration)))
      throw new Error("旧版描述文件不是未修改的应用管理文件，已停止更新。");
    const backup = old.descriptorPath + ".ironclad-backup-" + transactionId;
    if (await optional(backup))
      throw new Error("恢复备份位置已存在，未覆盖文件。");
    await fs.link(old.descriptorPath, backup);
    try {
      await removeDescriptor(old.descriptorPath, registration, 2);
    } catch (error) {
      await removeDescriptor(backup, registration, 2).catch(() => {});
      throw error;
    }
  }
  async function cleanOwned(files, directories, contentRoot = root) {
    for (const file of [...files].reverse()) {
      try {
        if (!within(contentRoot, file.path)) continue;
        const check = await fileDigest(file.path, file.identity);
        if (check.hash !== file.hash) continue;
        await directoryChain(path.dirname(file.path));
        const now = await fs.lstat(file.path);
        if (
          same(now, file.identity) &&
          now.nlink === 1 &&
          !now.isSymbolicLink()
        )
          await fs.unlink(file.path);
      } catch {
        /* Foreign changes and unowned content are preserved. */
      }
    }
    for (const dir of [...directories].reverse()) {
      try {
        await directoryChain(dir.path);
        if (same(await fs.lstat(dir.path), dir.identity))
          await fs.rmdir(dir.path);
      } catch {}
    }
  }
  async function installInner({
    archivePath,
    plan,
    userDataPath,
    signal,
    onProgress,
    repair,
  } = {}) {
    const selected = checkedPlan(plan),
      userdir = absolute(userDataPath),
      archive = absolute(archivePath);
    await recoverInner();
    const db = await load();
    await gameGuard();
    abort(signal);
    const contentRoot = selectedRoot(db, userdir);
    await assertContentRoot(contentRoot);
    const old =
      db.records.find(
        (r) =>
          r.modId === selected.modId &&
          canonical(r.userDataPath) === canonical(userdir),
      ) || null;
    if (
      repair !== undefined &&
      (!object(repair) ||
        Object.keys(repair).some((key) => key !== "installationId") ||
        !old ||
        repair.installationId !== old.transactionId ||
        old.revision !== selected.revision)
    )
      throw new Error("待修复的安装已变化，请重新验证。");
    const repairing = repair !== undefined;
    const registration = repairing
      ? await captureRegistration(old, signal)
      : old?.descriptor;
    if (
      !repairing &&
      old &&
      !(await descriptorMatches(old.descriptorPath, old.descriptor))
    )
      throw new Error("旧版描述文件已改变，请先检查恢复备份。");
    const descriptorPath = path.join(
      userdir,
      "mod",
      `pdx_${selected.modId}_${selected.revision}.mod`,
    );
    if (old?.revision === selected.revision) {
      if (old.archiveSha256 !== selected.sha256)
        throw new Error("相同版本的归档摘要发生变化，请检查下载来源。");
      if (!repairing && (await activeRecord(old))) {
        const verified = await fileDigest(archive, null, signal);
        if (
          verified.bytes !== selected.bytes ||
          verified.hash !== selected.sha256
        )
          throw new Error("ZIP 长度或 SHA-256 校验失败。");
        return publicRecord(old);
      }
    }
    await directoryChain(path.dirname(descriptorPath), true);
    if (
      (await optional(descriptorPath)) &&
      (!old || canonical(old.descriptorPath) !== canonical(descriptorPath))
    )
      throw new Error("同名模组描述文件已存在，未覆盖用户或官方安装。");
    const taskId = randomUUID(),
      taskPath = path.join(contentRoot.path, "tasks", taskId),
      contentPath = path.join(taskPath, "content"),
      versionPath = path.join(
        contentRoot.path,
        "versions",
        selected.modId,
        selected.revision + "-" + taskId,
      );
    const files = [],
      directories = [];
    let journaled = false,
      fd,
      zip;
    const progress = async (value) => {
      if (typeof onProgress === "function") {
        try {
          await onProgress(clone(value));
        } catch {}
      }
    };
    await directoryChain(contentPath, true, directories);
    const taskIdentity = identity(await fs.lstat(taskPath)),
      contentIdentity = identity(await fs.lstat(contentPath));
    async function stageSafe() {
      await assertContentRoot(contentRoot);
      await directoryChain(contentPath);
      if (
        !same(await fs.lstat(taskPath), taskIdentity) ||
        !same(await fs.lstat(contentPath), contentIdentity)
      )
        throw new Error("解压暂存目录已被替换，已停止安装。");
    }
    async function verifyExtractedTree() {
      await stageSafe();
      const expectedFiles = new Map(
          files.map((file) => [canonical(file.path), file]),
        ),
        expectedDirectories = new Map(
          directories.map((dir) => [canonical(dir.path), dir.identity]),
        );
      let checked = 0;
      async function walk(directory) {
        await directoryChain(directory);
        if (
          !same(
            await fs.lstat(directory),
            expectedDirectories.get(canonical(directory)),
          )
        )
          throw new Error("解压目录身份发生变化。");
        for (const item of await fs.readdir(directory, {
          withFileTypes: true,
        })) {
          abort(signal);
          const file = path.join(directory, item.name),
            s = await fs.lstat(file);
          if (s.isSymbolicLink()) throw new Error("解压内容出现外来链接。");
          if (s.isDirectory()) {
            await walk(file);
            continue;
          }
          const expected = expectedFiles.get(canonical(file));
          if (
            !expected ||
            !s.isFile() ||
            s.nlink !== 1 ||
            !same(s, expected.identity) ||
            (await fileDigest(file, expected.identity, signal)).hash !==
              expected.hash
          )
            throw new Error("解压内容被修改或出现外来文件。");
          checked++;
        }
      }
      await walk(contentPath);
      await stageSafe();
      if (checked !== files.length) throw new Error("解压内容有文件丢失。");
    }
    try {
      await directoryChain(path.dirname(archive));
      const initial = await fs.lstat(archive);
      if (
        !initial.isFile() ||
        initial.isSymbolicLink() ||
        initial.nlink !== 1 ||
        initial.size !== selected.bytes
      )
        throw new Error("ZIP 长度不符或不是独立普通文件。");
      fd = await openFd(archive, "r");
      if (!same(await statFd(fd), initial))
        throw new Error("ZIP 在打开时发生变化。");
      async function verifyArchive() {
        const digest = createHash("sha256"),
          buffer = Buffer.allocUnsafe(1024 * 1024);
        let bytes = 0;
        while (bytes < selected.bytes) {
          abort(signal);
          const { bytesRead } = await readFd(
            fd,
            buffer,
            0,
            Math.min(buffer.length, selected.bytes - bytes),
            bytes,
          );
          if (!bytesRead) break;
          bytes += bytesRead;
          digest.update(buffer.subarray(0, bytesRead));
        }
        const after = await statFd(fd);
        if (
          bytes !== selected.bytes ||
          after.size !== selected.bytes ||
          !same(after, initial) ||
          digest.digest("hex") !== selected.sha256
        )
          throw new Error("ZIP 长度或 SHA-256 校验失败，未安装内容。");
      }
      await progress({ stage: "verifying", cancellable: true });
      await verifyArchive();
      zip = await yauzl.fromFdPromise(fd, {
        autoClose: false,
        lazyEntries: true,
        strictFileNames: true,
        validateEntrySizes: true,
      });
      zip.on("error", () => {});
      if (zip.entryCount > LIMITS.entries)
        throw new Error("ZIP 文件数量超过 100000 项。");
      const names = new Map();
      let total = 0,
        declared = 0,
        count = 0;
      for await (const entry of zip.eachEntry()) {
        abort(signal);
        await stageSafe();
        const name = zipName(entry);
        if (++count > LIMITS.entries) throw new Error("ZIP 文件数量超过限制。");
        const parts = name.relative.split(path.sep);
        for (let depth = 1; depth <= parts.length; depth++) {
          const original = parts.slice(0, depth).join("/"),
            key = original.toLowerCase(),
            leaf = depth === parts.length,
            kind = leaf && !name.directory ? "file" : "directory",
            prior = names.get(key);
          if (
            prior &&
            (prior.original !== original ||
              prior.kind !== kind ||
              (leaf && prior.explicit))
          )
            throw new Error("ZIP 包含重复、大小写冲突或文件目录冲突。");
          names.set(key, {
            original,
            kind,
            explicit: Boolean(prior?.explicit || leaf),
          });
        }
        if (
          !Number.isSafeInteger(entry.uncompressedSize) ||
          entry.uncompressedSize < 0 ||
          entry.uncompressedSize > LIMITS.fileBytes ||
          entry.uncompressedSize >
            Math.max(1024 * 1024, entry.compressedSize * LIMITS.ratio)
        )
          throw new Error("ZIP 单文件大小或压缩膨胀比例超出限制。");
        declared += entry.uncompressedSize;
        if (declared > LIMITS.totalBytes)
          throw new Error("ZIP 解压总体积超过 20 GiB。");
        const target = path.join(contentPath, name.relative);
        if (name.directory) {
          if (entry.uncompressedSize !== 0)
            throw new Error("ZIP 目录包含异常数据。");
          await directoryChain(target, true, directories);
          continue;
        }
        await directoryChain(path.dirname(target), true, directories);
        await stageSafe();
        const output = await fs.open(target, "wx"),
          tracked = {
            path: target,
            identity: identity(await output.stat()),
            hash: hash(Buffer.alloc(0)),
          };
        files.push(tracked);
        const digest = createHash("sha256");
        let bytes = 0,
          crc = 0xffffffff,
          stream;
        try {
          await stageSafe();
          if (!same(await fs.lstat(target), tracked.identity))
            throw new Error("解压目标被替换。");
          stream = await zip.openReadStreamPromise(entry);
          const cancel = () =>
            stream.destroy(
              Object.assign(new Error("模组安装已取消。"), {
                name: "AbortError",
              }),
            );
          signal?.addEventListener("abort", cancel, { once: true });
          try {
            for await (const chunk of stream) {
              abort(signal);
              await stageSafe();
              bytes += chunk.length;
              total += chunk.length;
              if (
                bytes > entry.uncompressedSize ||
                bytes > LIMITS.fileBytes ||
                total > LIMITS.totalBytes
              )
                throw new Error("ZIP 实际解压字节超出声明或安全限制。");
              let offset = 0;
              while (offset < chunk.length) {
                const { bytesWritten } = await output.write(
                  chunk,
                  offset,
                  chunk.length - offset,
                  null,
                );
                if (!bytesWritten) throw new Error("无法写入解压内容。");
                digest.update(chunk.subarray(offset, offset + bytesWritten));
                offset += bytesWritten;
              }
              crc = crcUpdate(crc, chunk);
              await progress({
                stage: "extracting",
                cancellable: true,
                files: count,
                extractedBytes: total,
              });
            }
          } finally {
            signal?.removeEventListener("abort", cancel);
            stream.destroy();
          }
          if (
            bytes !== entry.uncompressedSize ||
            (crc ^ 0xffffffff) >>> 0 !== entry.crc32
          )
            throw new Error("ZIP 文件大小或 CRC 校验失败。");
        } finally {
          tracked.hash = digest.digest("hex");
          await output.close();
        }
      }
      await verifyArchive();
      await stageSafe();
      abort(signal);
      const descriptor = files.find(
        (file) =>
          path.relative(contentPath, file.path).toLowerCase() ===
          "descriptor.mod",
      );
      if (
        !descriptor ||
        (await fs.stat(descriptor.path)).size > LIMITS.descriptorBytes
      )
        throw new Error("ZIP 根目录缺少有效的 descriptor.mod。");
      let sourceText;
      try {
        sourceText = new TextDecoder("utf-8", { fatal: true })
          .decode(await fs.readFile(descriptor.path))
          .replace(/^\uFEFF/, "");
      } catch {
        throw new Error("模组描述文件不是有效 UTF-8。");
      }
      let sanitized = sourceText;
      for (const field of parseDescriptor(sourceText)
        .filter((field) =>
          ["path", "archive", "remote_file_id"].includes(
            field.key.toLowerCase(),
          ),
        )
        .sort((a, b) => b.start - a.start))
        sanitized =
          sanitized.slice(0, field.start) + sanitized.slice(field.end);
      const metadata = parseDescriptor(sanitized);
      if (
        !metadata.some(
          (field) =>
            field.key === "name" &&
            typeof field.value === "string" &&
            field.value.trim(),
        )
      )
        sanitized += "\nname=" + quote(selected.title) + "\n";
      await stageSafe();
      if (
        (await fileDigest(descriptor.path, descriptor.identity)).hash !==
        descriptor.hash
      )
        throw new Error("模组描述文件在验证后发生变化。");
      const descriptorHandle = await fs.open(descriptor.path, "r+");
      try {
        await stageSafe();
        if (
          !same(await descriptorHandle.stat(), descriptor.identity) ||
          !same(await fs.lstat(descriptor.path), descriptor.identity)
        )
          throw new Error("模组描述文件被替换。");
        await descriptorHandle.truncate(0);
        await descriptorHandle.writeFile(sanitized);
        descriptor.hash = hash(sanitized);
      } finally {
        await descriptorHandle.close();
      }
      let validation;
      if (repairing) {
        validation = await fileIntegrity.compare({
          record: old,
          contentPath,
          files,
          signal,
          onProgress: (value) =>
            progress({ stage: "validating", cancellable: true, ...value }),
        });
        validation.registrationIntact = await descriptorMatches(
          old.descriptorPath,
          old.descriptor,
        );
        if (validation.status === "intact" && validation.registrationIntact) {
          const integrity = await fileIntegrity.create({
            ...selected,
            archiveSha256: selected.sha256,
            contentPath,
            files,
            signal,
          });
          abort(signal);
          await gameGuard();
          await validateUserDataPath(userdir);
          await verifyExtractedTree();
          const rechecked = await fileIntegrity.verify({
            record: { ...old, integrity },
            signal,
          });
          if (
            rechecked.status !== "intact" ||
            !(await descriptorMatches(old.descriptorPath, old.descriptor))
          )
            throw new Error("待修复的安装已变化，请重新验证。");
          // A legacy install obtains a trusted baseline from the signed ZIP,
          // while retaining its registration, content path and preset IDs.
          old.integrity = integrity;
          await saveDatabase(db);
          return {
            ...publicRecord(old),
            repair: { repaired: false, validation },
          };
        }
        if (!validation.registrationIntact) validation.status = "damaged";
      }
      const integrity = await fileIntegrity.create({
        ...selected,
        archiveSha256: selected.sha256,
        contentPath,
        files,
        signal,
      });
      const finalContent = path.join(versionPath, "content"),
        descriptorText =
          marker(taskId) +
          sanitized.trimEnd() +
          "\npath=" +
          quote(finalContent) +
          "\n";
      abort(signal);
      await gameGuard();
      await stageSafe();
      const temporary = descriptorPath + ".ironclad-tmp-" + taskId;
      await directoryChain(path.dirname(temporary));
      const temporaryHandle = await fs.open(temporary, "wx");
      let descriptorIdentity;
      try {
        descriptorIdentity = identity(await temporaryHandle.stat());
        await directoryChain(path.dirname(temporary));
        if (!same(await fs.lstat(temporary), descriptorIdentity))
          throw new Error("暂存描述文件被替换。");
        await temporaryHandle.writeFile(descriptorText);
      } finally {
        await temporaryHandle.close();
      }
      const record = {
        ...selected,
        transactionId: taskId,
        contentRootId: contentRoot.id,
        archiveSha256: selected.sha256,
        userDataPath: userdir,
        contentPath: finalContent,
        contentIdentity,
        integrity,
        descriptorPath,
        descriptor: {
          identity: descriptorIdentity,
          text: descriptorText,
          hash: hash(descriptorText),
        },
      };
      const tx = {
        version: 1,
        type: "install",
        record,
        old,
        ...(repairing ? { repairRegistration: registration } : {}),
      };
      const result = () => ({
        ...publicRecord(record),
        ...(repairing
          ? {
              repair: {
                repaired: true,
                validation,
                retainedContentPath: old.contentPath,
                ...(registration
                  ? {
                      retainedDescriptorPath:
                        old.descriptorPath + ".ironclad-backup-" + taskId,
                    }
                  : {}),
              },
            }
          : {}),
      });
      try {
        abort(signal);
        await gameGuard();
        await stageSafe();
        await progress({ stage: "committing", cancellable: false });
        abort(signal);
        await gameGuard();
        await validateUserDataPath(userdir);
        await verifyExtractedTree();
        abort(signal);
        await jsonWrite(journalPath, tx);
        journaled = true;
        abort(signal);
        await directoryChain(path.dirname(versionPath), true);
        await stageSafe();
        await fs.rename(taskPath, versionPath);
        await directoryChain(path.dirname(descriptorPath));
        if (!(await descriptorMatches(temporary, record.descriptor)))
          throw new Error("暂存描述文件发生变化。");
        const sameDescriptor =
          old && canonical(old.descriptorPath) === canonical(descriptorPath);
        if (sameDescriptor) await moveOld(old, taskId, registration);
        await fs.link(temporary, descriptorPath);
        await removeDescriptor(temporary, record.descriptor, 2);
        if (!sameDescriptor) await moveOld(old, taskId, registration);
        db.records = db.records.filter((r) => r !== old);
        db.records.push(record);
        retain(db, old, taskId);
        await saveDatabase(db);
        await fs.unlink(journalPath);
        journaled = false;
        return result();
      } catch (error) {
        if (journaled) {
          try {
            const recovery = await recoverInner();
            journaled = false;
            if (recovery.action === "completed") return result();
          } catch {
            error.message += " 安装恢复记录已保留，请先执行恢复。";
            error.code = "RECOVERY_REQUIRED";
          }
        } else
          await removeDescriptor(temporary, record.descriptor, 2).catch(
            () => {},
          );
        throw error;
      }
    } finally {
      if (zip) {
        await new Promise((resolve) => {
          zip.once("close", resolve);
          zip.close();
        }).catch(() => {});
        fd = undefined;
      }
      if (fd !== undefined) await closeFd(fd).catch(() => {});
      if (!journaled) await cleanOwned(files, directories, contentRoot.path);
    }
  }
  const relocation = createRelocation({
    root,
    journalPath,
    load,
    saveDatabase,
    validateDatabase,
    validateRecord,
    selectedRoot,
    assertContentRoot,
    recoverInner,
    gameGuard,
    validateUserDataPath,
    directoryChain,
    optional,
    fileDigest,
    identity,
    same,
    canonical,
    within,
    absolute,
    hash,
    quote,
    clone,
    abort,
    jsonRead,
    jsonWrite,
    descriptorMatches,
    removeDescriptor,
  });
  async function recover() {
    try {
      return await recoverInner();
    } catch (error) {
      error.code = "RECOVERY_REQUIRED";
      throw error;
    }
  }
  return {
    install: (input) => serial(() => locked(() => installInner(input))),
    verify: (
      modId,
      { userDataPath, installationId, signal, onProgress } = {},
    ) =>
      serial(() =>
        locked(async () => {
          await recoverInner();
          const db = await load(),
            userdir = absolute(userDataPath);
          await gameGuard();
          await validateUserDataPath(userdir);
          abort(signal);
          const record = db.records.find(
            (r) =>
              r.modId === numeric(modId) &&
              canonical(r.userDataPath) === canonical(userdir),
          );
          if (!record || record.transactionId !== installationId)
            throw new Error("待修复的安装已变化，请重新验证。");
          await assertContentRoot(
            db.roots.find((item) => item.id === record.contentRootId),
          );
          const report = await fileIntegrity.verify({
            record,
            signal,
            onProgress,
          });
          report.registrationIntact = await descriptorMatches(
            record.descriptorPath,
            record.descriptor,
          );
          if (!report.registrationIntact && report.status === "intact")
            report.status = "damaged";
          abort(signal);
          await validateUserDataPath(userdir);
          return report;
        }),
      ),
    list: ({ includeDamaged = false } = {}) =>
      serial(async () => {
        const db = await load(),
          records = [];
        for (const record of db.records) {
          const active = await activeRecord(record);
          if (active || includeDamaged)
            records.push({
              ...publicRecord(record),
              ...(!active ? { installationDamaged: true } : {}),
            });
        }
        return records;
      }),
    recover: () => serial(() => locked(recover)),
    getStorageState: (input) =>
      serial(() =>
        locked(async () => {
          await recover();
          return relocation.getStorageState(input);
        }),
      ),
    planRelocation: (input) =>
      serial(() =>
        locked(async () => {
          await recover();
          return relocation.plan(input);
        }),
      ),
    relocate: (input) =>
      serial(() =>
        locked(async () => {
          await recover();
          return relocation.execute(input);
        }),
      ),
    cancelRelocationPlan: (planId) => relocation.cancel(planId),
    uninstall: (modId, { userDataPath } = {}) =>
      serial(() =>
        locked(async () => {
          const id = numeric(modId),
            userdir = absolute(userDataPath);
          await recoverInner();
          const db = await load();
          await gameGuard();
          const record = db.records.find(
            (r) =>
              r.modId === id &&
              canonical(r.userDataPath) === canonical(userdir),
          );
          if (!record) return { modId: id, removed: false };
          if (canonical(record.userDataPath) !== canonical(userdir))
            throw new Error("卸载目录与本应用安装记录不一致。");
          if (!(await activeRecord(record)))
            throw new Error("安装内容或描述文件已改变，未删除用户文件。");
          const backupId = randomUUID();
          await jsonWrite(journalPath, {
            version: 1,
            type: "uninstall",
            record,
            old: record,
            backupId,
          });
          try {
            await moveOld(record, backupId);
            db.records = db.records.filter((r) => r !== record);
            retain(db, record, backupId);
            await saveDatabase(db);
            await fs.unlink(journalPath);
            return {
              modId: id,
              removed: true,
              retainedContentPath: record.contentPath,
            };
          } catch (error) {
            try {
              await recoverInner();
            } catch {
              error.message += " 卸载恢复记录已保留。";
              error.code = "RECOVERY_REQUIRED";
            }
            throw error;
          }
        }),
      ),
  };
}

module.exports = { createPdxInstallService, INSTALL_LIMITS: LIMITS };
