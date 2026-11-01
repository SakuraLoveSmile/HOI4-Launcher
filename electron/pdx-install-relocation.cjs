"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID, createHash } = require("node:crypto");
const { parseDescriptor } = require("./mod-authoring.cjs");
const {
  diagnostic,
  diagnosticError,
  errorDiagnostic,
  attachDiagnostic,
} = require("./diagnostic-message.cjs");

// This helper is called only under the installer's shared queue and disk lock.
function createRelocation(api) {
  const {
    root,
    journalPath,
    load,
    saveDatabase,
    validateDatabase,
    validateRecord,
    selectedRoot,
    assertContentRoot,
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
    jsonWrite,
    descriptorMatches,
    removeDescriptor,
  } = api;
  const plans = new Map();
  const uuid = (value) =>
    typeof value === "string" && /^[a-f0-9-]{36}$/.test(value);
  const registration = (record, retained) =>
    retained ? record.backupPath : record.descriptorPath;
  const versionPath = (record) => path.dirname(record.contentPath);
  const allRecords = (db) => [...db.records, ...db.retainedVersions];
  const error = (message) => diagnosticError(message);
  function ancestorPaths(directory) {
    const paths = [];
    let current = absolute(directory);
    while (true) {
      paths.unshift(current);
      const parent = path.dirname(current);
      if (parent === current) return paths;
      current = parent;
    }
  }
  async function captureLineage(directory) {
    await directoryChain(directory);
    const result = [];
    for (const current of ancestorPaths(directory)) {
      const stat = await fs.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw error("迁移目录链包含链接或特殊文件。");
      result.push({ path: current, identity: identity(stat) });
    }
    return result;
  }
  function validateLineage(directory, lineage) {
    const paths = ancestorPaths(directory);
    if (
      !Array.isArray(lineage) ||
      lineage.length !== paths.length ||
      lineage.some(
        (item, index) => item.path !== paths[index] || !item.identity,
      )
    )
      throw error("迁移目录身份链无效。");
  }
  async function assertLineage(lineage) {
    for (const item of lineage) {
      const stat = await fs.lstat(item.path);
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        !same(stat, item.identity) ||
        canonical(await fs.realpath(item.path)) !== canonical(item.path)
      )
        throw error("迁移目录身份链发生变化，已保留文件。");
    }
  }

  async function legacyPaths(db) {
    const known = new Set(
      allRecords(db).map((record) => canonical(versionPath(record))),
    );
    const retained = [];
    for (const item of db.roots) {
      try {
        await assertContentRoot(item);
        const versions = path.join(item.path, "versions");
        if (await optional(versions)) {
          await directoryChain(versions);
          for (const mod of await fs.readdir(versions, {
            withFileTypes: true,
          })) {
            const modPath = path.join(versions, mod.name);
            if (!mod.isDirectory() || mod.isSymbolicLink()) {
              retained.push(modPath);
              continue;
            }
            await directoryChain(modPath);
            for (const name of await fs.readdir(modPath)) {
              const candidate = path.join(modPath, name);
              if (!known.has(canonical(candidate))) retained.push(candidate);
            }
          }
        }
        const tasks = path.join(item.path, "tasks");
        if (await optional(tasks)) {
          await directoryChain(tasks);
          for (const name of await fs.readdir(tasks))
            retained.push(path.join(tasks, name));
        }
      } catch {
        retained.push(item.path);
      }
    }
    for (const record of db.retainedVersions) {
      try {
        await directoryChain(record.contentPath);
        if (
          !same(await fs.lstat(record.contentPath), record.contentIdentity) ||
          !(await descriptorMatches(record.backupPath, record.descriptor))
        )
          retained.push(versionPath(record));
      } catch {
        retained.push(versionPath(record));
      }
    }
    const userdirs = new Set([
      ...allRecords(db).map((r) => r.userDataPath),
      ...db.locations.map((r) => r.userDataPath),
    ]);
    for (const userdir of userdirs) {
      const directory = path.join(userdir, "mod");
      try {
        await directoryChain(directory);
        for (const name of await fs.readdir(directory))
          if (/\.ironclad-relocation-(?:tmp|backup)-[a-f0-9-]{36}$/.test(name))
            retained.push(path.join(directory, name));
      } catch {
        /* Existing installation diagnostics cover unavailable user folders. */
      }
    }
    return [...new Set(retained)].sort();
  }
  async function snapshot(directory, expected, signal) {
    const result = { directories: [], files: [], bytes: 0 };
    async function walk(current, relative) {
      abort(signal);
      await directoryChain(current);
      const info = await fs.lstat(current);
      if (!relative && !same(info, expected))
        throw error("迁移源目录身份发生变化。");
      result.directories.push({ relative, identity: identity(info) });
      if (result.directories.length + result.files.length > 100000)
        throw error("迁移目录文件数量超过限制。");
      const names = (await fs.readdir(current)).sort();
      for (const name of names) {
        const child = path.join(current, name),
          rel = path.join(relative, name);
        const stat = await fs.lstat(child);
        if (stat.isSymbolicLink()) throw error("迁移内容包含链接或目录联接。");
        if (stat.isDirectory()) await walk(child, rel);
        else {
          if (!stat.isFile() || stat.nlink !== 1)
            throw error("迁移内容包含硬链接或特殊文件。");
          const digest = await fileDigest(child, identity(stat), signal);
          result.files.push({ relative: rel, ...digest });
          if (result.directories.length + result.files.length > 100000)
            throw error("迁移目录文件数量超过限制。");
          result.bytes += digest.bytes;
          if (!Number.isSafeInteger(result.bytes))
            throw error("迁移内容大小超过限制。");
        }
      }
      if (!same(await fs.lstat(current), info))
        throw error("迁移目录在扫描时被替换。");
    }
    await walk(directory, "");
    return result;
  }
  function validateSnapshot(value) {
    if (
      !value ||
      !Array.isArray(value.files) ||
      !Array.isArray(value.directories) ||
      value.files.length + value.directories.length > 100000 ||
      !value.directories.length ||
      value.directories[0].relative !== ""
    )
      throw error("迁移文件清单无效。");
    const seen = new Set();
    for (const entry of [...value.directories, ...value.files]) {
      const relative = entry.relative;
      if (
        typeof relative !== "string" ||
        path.isAbsolute(relative) ||
        relative.split(/[\\/]/).some((part) => part === ".." || part === ".") ||
        /[\0-\x1f:]/.test(relative) ||
        seen.has(relative.toLowerCase()) ||
        !entry.identity
      )
        throw error("迁移文件清单路径无效。");
      seen.add(relative.toLowerCase());
    }
    for (const entry of value.files)
      if (
        !entry.relative ||
        !/^[a-f0-9]{64}$/.test(entry.hash) ||
        !Number.isSafeInteger(entry.bytes) ||
        entry.bytes < 0
      )
        throw error("迁移文件摘要无效。");
  }
  async function verifyTree(directory, expected, signal) {
    const current = await snapshot(
      directory,
      expected.directories[0].identity,
      signal,
    );
    if (JSON.stringify(current) !== JSON.stringify(expected))
      throw error("迁移内容在预检后发生变化，请重新预览。");
  }
  async function nearestAnchor(target) {
    let current = target;
    while (!(await optional(current))) {
      const parent = path.dirname(current);
      if (parent === current) throw error("目标目录不可用。");
      current = parent;
    }
    await directoryChain(current);
    return { path: current, identity: identity(await fs.lstat(current)) };
  }
  async function checkAnchor(anchor) {
    await directoryChain(anchor.path);
    if (!same(await fs.lstat(anchor.path), anchor.identity))
      throw error("迁移目标目录或磁盘在预检后发生变化。");
  }
  async function getStorageState({ userDataPath } = {}) {
    const userdir = absolute(userDataPath),
      db = await load(),
      location = selectedRoot(db, userdir);
    await assertContentRoot(location);
    return {
      location: location.path,
      defaultLocation: root,
      isDefault: location.id === "default",
      retainedLegacyPaths: await legacyPaths(db),
      recoveryRequired: false,
    };
  }
  async function plan({ userDataPath, targetParent } = {}) {
    const userdir = absolute(userDataPath),
      db = await load();
    if (targetParent !== null && typeof targetParent !== "string")
      throw error("请选择迁移目录或默认位置。");
    const parent = targetParent === null ? null : absolute(targetParent);
    if (parent) await directoryChain(parent);
    const to = parent ? path.join(parent, "hoi4", "ironclad") : root;
    const fromRoot = selectedRoot(db, userdir),
      conflicts = [],
      skipped = [];
    const knownTarget = db.roots.find(
      (item) => canonical(item.path) === canonical(to),
    );
    if (
      parent &&
      (within(root, to) ||
        within(to, root) ||
        within(userdir, to) ||
        within(to, userdir))
    )
      throw error("目标目录不能与安装记录目录或游戏用户目录重叠。");
    for (const item of db.roots)
      if (
        canonical(item.path) !== canonical(to) &&
        (within(item.path, to) || within(to, item.path))
      )
        throw error("目标目录不能嵌套于其他模组内容目录。");
    const anchor = await nearestAnchor(to),
      targetStat = await optional(to);
    if (knownTarget) {
      try {
        await assertContentRoot(knownTarget);
      } catch (e) {
        conflicts.push(e.message);
      }
    } else if (targetStat && (await fs.readdir(to)).length)
      conflicts.push("目标目录已有其他内容，请选择空目录。");
    const candidate = knownTarget || {
      id: randomUUID(),
      path: to,
      parent,
      identity: targetStat ? identity(targetStat) : null,
    };
    const items = [];
    for (const [records, retained] of [
      [db.records, false],
      [db.retainedVersions, true],
    ]) {
      for (const record of records.filter(
        (r) => canonical(r.userDataPath) === canonical(userdir),
      )) {
        try {
          await assertContentRoot(
            db.roots.find((r) => r.id === record.contentRootId),
          );
          if (
            !(await descriptorMatches(
              registration(record, retained),
              record.descriptor,
            ))
          )
            throw error("注册描述文件已改变或丢失。");
          const content = await snapshot(
            record.contentPath,
            record.contentIdentity,
          );
          const target = path.join(
            to,
            "versions",
            record.modId,
            record.revision + "-" + record.transactionId,
            "content",
          );
          if (
            canonical(target) !== canonical(record.contentPath) &&
            (await optional(path.dirname(target)))
          )
            conflicts.push(`目标版本目录已存在：${path.dirname(target)}`);
          items.push({
            record: clone(record),
            retained,
            content,
            sourceLineage: await captureLineage(record.contentPath),
            versionIdentity: identity(await fs.lstat(versionPath(record))),
          });
        } catch (e) {
          if (retained) skipped.push(versionPath(record));
          else conflicts.push(`${record.title || record.modId}：${e.message}`);
        }
      }
    }
    const movable = items.filter(
      (item) => item.record.contentRootId !== candidate.id,
    );
    const publicPlan = {
      planId: randomUUID(),
      from: fromRoot.path,
      to,
      installations: movable.map(({ record, retained }) => ({
        modId: record.modId,
        revision: record.revision,
        title: record.title,
        transactionId: record.transactionId,
        retained,
      })),
      files: movable.reduce((sum, item) => sum + item.content.files.length, 0),
      bytes: movable.reduce((sum, item) => sum + item.content.bytes, 0),
      retainedLegacyPaths: [
        ...new Set([...(await legacyPaths(db)), ...skipped]),
      ],
      conflicts,
      isDefault: candidate.id === "default",
    };
    const space = await fs.statfs(anchor.path, { bigint: true });
    if (BigInt(publicPlan.bytes) > space.bavail * space.bsize)
      conflicts.push("目标磁盘空间不足，复制校验期间需要保留原内容。");
    plans.clear();
    plans.set(publicPlan.planId, {
      publicPlan,
      userdir,
      candidate,
      anchor,
      targetExisted: !!targetStat,
      databaseHash: hash(JSON.stringify(db)),
      db: clone(db),
      items: movable,
    });
    return clone(publicPlan);
  }

  async function cleanTree(directory, content, parentIdentity, lineage) {
    if (!(await optional(directory))) return [];
    validateLineage(directory, lineage);
    async function guard(target) {
      await assertLineage(lineage);
      await directoryChain(path.dirname(target));
      for (const entry of content.directories) {
        const current = path.join(directory, entry.relative);
        if (!within(current, target)) continue;
        const stat = await fs.lstat(current);
        if (
          !stat.isDirectory() ||
          stat.isSymbolicLink() ||
          !same(stat, entry.identity)
        )
          throw error("迁移内容的父目录已被替换，已保留文件。");
      }
    }
    try {
      await guard(directory);
      if (!same(await fs.lstat(directory), content.directories[0].identity))
        return [directory];
    } catch {
      return [directory];
    }
    for (const file of [...content.files].reverse()) {
      const target = path.join(directory, file.relative);
      try {
        if (!(await optional(target))) continue;
        const actual = await fileDigest(target, file.identity);
        if (actual.hash !== file.hash || actual.bytes !== file.bytes) continue;
        // A newly inserted junction can retain the file's inode and timestamps.
        // Recheck the entire directory chain after hashing, before unlinking.
        await guard(target);
        const final = await fs.lstat(target);
        if (
          !same(final, file.identity) ||
          final.size !== actual.bytes ||
          final.mtimeMs !== actual.mtimeMs ||
          final.ctimeMs !== actual.ctimeMs
        )
          continue;
        await fs.unlink(target);
      } catch {
        /* Keep changed, replaced or inaccessible files. */
      }
    }
    for (const entry of [...content.directories].reverse()) {
      const target = path.join(directory, entry.relative);
      try {
        await guard(target);
        if (same(await fs.lstat(target), entry.identity))
          await fs.rmdir(target);
      } catch {}
    }
    if (await optional(directory)) return [directory];
    if (parentIdentity) {
      const parent = path.dirname(directory);
      try {
        await assertLineage(lineage.slice(0, -1));
        await directoryChain(parent);
        if (same(await fs.lstat(parent), parentIdentity))
          await fs.rmdir(parent);
      } catch {}
      if (await optional(parent)) return [parent];
    }
    return [];
  }
  async function copyTree(entry, tx, signal, report) {
    const { content, record } = entry;
    await assertContentRoot(tx.targetRoot);
    await directoryChain(tx.taskPath);
    if (!same(await fs.lstat(tx.taskPath), tx.taskIdentity))
      throw error("迁移暂存目录已被替换。");
    await fs.mkdir(path.dirname(entry.stagePath));
    entry.stageParentIdentity = identity(
      await fs.lstat(path.dirname(entry.stagePath)),
    );
    await fs.mkdir(entry.stagePath);
    const createdDirectories = [
        { relative: "", identity: identity(await fs.lstat(entry.stagePath)) },
      ],
      createdFiles = [];
    async function stageGuard() {
      await assertContentRoot(tx.targetRoot);
      await directoryChain(entry.stagePath);
      if (
        !same(await fs.lstat(tx.taskPath), tx.taskIdentity) ||
        !same(
          await fs.lstat(path.dirname(entry.stagePath)),
          entry.stageParentIdentity,
        ) ||
        !same(await fs.lstat(entry.stagePath), createdDirectories[0].identity)
      )
        throw error("迁移暂存目录已被替换。");
    }
    const sourceRoot = tx.oldDb.roots.find(
      (item) => item.id === record.contentRootId,
    );
    for (const directory of content.directories.slice(1)) {
      await stageGuard();
      const target = path.join(entry.stagePath, directory.relative);
      await directoryChain(path.dirname(target));
      await fs.mkdir(target);
      createdDirectories.push({
        relative: directory.relative,
        identity: identity(await fs.lstat(target)),
      });
    }
    entry.copied = { directories: createdDirectories, files: [], bytes: 0 };
    entry.stageLineage = await captureLineage(entry.stagePath);
    await jsonWrite(journalPath, tx);
    for (const file of content.files) {
      abort(signal);
      await assertContentRoot(sourceRoot);
      await stageGuard();
      const source = path.join(record.contentPath, file.relative),
        target = path.join(entry.stagePath, file.relative);
      await directoryChain(path.dirname(source));
      await directoryChain(path.dirname(target));
      const before = await fs.lstat(source);
      if (
        !same(before, file.identity) ||
        !before.isFile() ||
        before.isSymbolicLink() ||
        before.nlink !== 1
      )
        throw error("迁移源文件已被替换。");
      const input = await fs.open(source, "r");
      let output;
      try {
        if (!same(await input.stat(), file.identity))
          throw error("迁移源文件在打开时被替换。");
        output = await fs.open(target, "wx");
        const created = {
          relative: file.relative,
          identity: identity(await output.stat()),
          hash: hash(Buffer.alloc(0)),
          bytes: 0,
        };
        createdFiles.push(created);
        entry.copied.files.push(created);
        const digest = createHash("sha256"),
          writtenDigest = createHash("sha256"),
          buffer = Buffer.allocUnsafe(1024 * 1024);
        let bytes = 0;
        while (true) {
          abort(signal);
          const { bytesRead } = await input.read(
            buffer,
            0,
            buffer.length,
            null,
          );
          if (!bytesRead) break;
          bytes += bytesRead;
          if (bytes > file.bytes) throw error("迁移源文件大小发生变化。");
          digest.update(buffer.subarray(0, bytesRead));
          let written = 0;
          while (written < bytesRead) {
            const count = (
              await output.write(buffer, written, bytesRead - written, null)
            ).bytesWritten;
            if (!count) throw error("目标文件无法继续写入。");
            writtenDigest.update(buffer.subarray(written, written + count));
            written += count;
            created.bytes += count;
            entry.copied.bytes += count;
            created.hash = writtenDigest.copy().digest("hex");
          }
          await report(bytesRead, false);
        }
        const after = await input.stat();
        if (
          bytes !== file.bytes ||
          digest.digest("hex") !== file.hash ||
          !same(after, before) ||
          after.mtimeMs !== before.mtimeMs ||
          after.ctimeMs !== before.ctimeMs ||
          !same(await fs.lstat(source), before)
        )
          throw error("迁移源文件在复制期间发生变化。");
      } finally {
        await output?.close();
        await input.close();
      }
      await report(0, true);
    }
    const copied = await snapshot(
      entry.stagePath,
      createdDirectories[0].identity,
      signal,
    );
    await stageGuard();
    if (
      copied.directories.some(
        (item, i) => !same(item.identity, createdDirectories[i]?.identity),
      ) ||
      copied.files.some(
        (item, i) => !same(item.identity, createdFiles[i]?.identity),
      )
    )
      throw error("迁移目标文件或目录已被替换。");
    const reduced = (s) =>
      JSON.stringify({
        directories: s.directories.map((d) => d.relative),
        files: s.files.map(({ relative, bytes, hash }) => ({
          relative,
          bytes,
          hash,
        })),
      });
    if (reduced(copied) !== reduced(content)) throw error("目标副本校验失败。");
    return copied;
  }
  function newDescriptor(old, contentPath) {
    let text = old.descriptor.text;
    for (const field of parseDescriptor(text)
      .filter((f) => ["path", "archive"].includes(f.key.toLowerCase()))
      .sort((a, b) => b.start - a.start))
      text = text.slice(0, field.start) + text.slice(field.end);
    return text.trimEnd() + "\npath=" + quote(contentPath) + "\n";
  }
  function checkTransaction(tx) {
    if (
      tx.version !== 2 ||
      tx.type !== "relocate" ||
      !uuid(tx.id) ||
      !Array.isArray(tx.entries) ||
      (!uuid(tx.targetRoot?.id) && tx.targetRoot?.id !== "default")
    )
      throw error("迁移恢复记录无效。");
    validateDatabase(tx.oldDb);
    if (
      hash(JSON.stringify(tx.oldDb)) !== tx.databaseHash ||
      JSON.stringify(tx.oldDb.roots.find((r) => r.id === tx.targetRoot.id)) !==
        JSON.stringify(tx.targetRoot)
    )
      throw error("迁移恢复记录的数据库或目录快照不一致。");
    validateDatabase({
      ...clone(tx.oldDb),
      roots: tx.oldDb.roots.some((r) => r.id === tx.targetRoot.id)
        ? tx.oldDb.roots
        : [...tx.oldDb.roots, tx.targetRoot],
    });
    const task = path.join(tx.targetRoot.path, "tasks", "relocation-" + tx.id);
    if (tx.taskPath !== task || !tx.taskIdentity)
      throw error("迁移暂存路径无效。");
    validateLineage(tx.taskPath, tx.taskLineage);
    const seen = new Set();
    for (const entry of tx.entries) {
      validateRecord(entry.record, tx.oldDb);
      validateSnapshot(entry.content);
      validateLineage(entry.record.contentPath, entry.sourceLineage);
      const registered = registration(entry.record, entry.retained),
        id = entry.record.transactionId;
      const original = (
        entry.retained ? tx.oldDb.retainedVersions : tx.oldDb.records
      ).find((r) => r.transactionId === id);
      if (
        seen.has(id) ||
        typeof entry.retained !== "boolean" ||
        JSON.stringify(original) !== JSON.stringify(entry.record) ||
        !same(
          entry.content.directories[0].identity,
          entry.record.contentIdentity,
        ) ||
        canonical(entry.record.userDataPath) !== canonical(tx.userdir) ||
        entry.stagePath !== path.join(task, id, "content") ||
        entry.finalPath !==
          path.join(
            tx.targetRoot.path,
            "versions",
            entry.record.modId,
            entry.record.revision + "-" + id,
            "content",
          ) ||
        entry.temporary !== registered + ".ironclad-relocation-tmp-" + tx.id ||
        entry.backup !== registered + ".ironclad-relocation-backup-" + tx.id
      )
        throw error("迁移注册路径无效。");
      seen.add(id);
      if (entry.copied) validateSnapshot(entry.copied);
      if (entry.stageLineage)
        validateLineage(entry.stagePath, entry.stageLineage);
      if (entry.finalLineage)
        validateLineage(entry.finalPath, entry.finalLineage);
      if (entry.next) {
        validateRecord(entry.next, {
          ...tx.oldDb,
          roots: [
            ...tx.oldDb.roots.filter((r) => r.id !== tx.targetRoot.id),
            tx.targetRoot,
          ],
        });
        if (
          entry.next.transactionId !== id ||
          entry.next.contentPath !== entry.finalPath ||
          !entry.copied ||
          !same(
            entry.next.contentIdentity,
            entry.copied.directories[0].identity,
          ) ||
          entry.next.descriptor.text !==
            newDescriptor(entry.record, entry.finalPath)
        )
          throw error("迁移目标记录无效。");
      }
    }
  }
  async function finish(tx, db) {
    checkTransaction(tx);
    const committed = db.lastRelocationId === tx.id,
      retainedPaths = [];
    let targetTrusted = true;
    try {
      await assertContentRoot(tx.targetRoot);
    } catch (failure) {
      if (committed) throw failure;
      targetTrusted = false;
      retainedPaths.push(tx.targetRoot.path);
    }
    async function discard(file, descriptor) {
      if (!(await optional(file))) return;
      try {
        await removeDescriptor(file, descriptor, 2);
      } catch {
        retainedPaths.push(file);
      }
    }
    if (committed) {
      const expectedDb = clone(tx.oldDb);
      expectedDb.locations = expectedDb.locations.filter(
        (item) => canonical(item.userDataPath) !== canonical(tx.userdir),
      );
      expectedDb.locations.push({
        userDataPath: tx.userdir,
        rootId: tx.targetRoot.id,
      });
      for (const entry of tx.entries) {
        const records = entry.retained
          ? expectedDb.retainedVersions
          : expectedDb.records;
        records[
          records.findIndex(
            (item) => item.transactionId === entry.record.transactionId,
          )
        ] = entry.next;
      }
      expectedDb.lastRelocationId = tx.id;
      expectedDb.generation++;
      if (hash(JSON.stringify(expectedDb)) !== hash(JSON.stringify(db)))
        throw error("已提交的迁移与数据库快照不一致。");
      for (const entry of tx.entries) {
        const record = allRecords(db).find(
          (r) => r.transactionId === entry.record.transactionId,
        );
        if (
          !entry.next ||
          !record ||
          JSON.stringify(record) !== JSON.stringify(entry.next)
        )
          throw error("迁移已提交但安装记录不一致。");
        await verifyTree(entry.finalPath, entry.copied);
        if (
          !(await descriptorMatches(
            registration(record, entry.retained),
            record.descriptor,
          ))
        )
          throw error("迁移已提交但注册文件已改变。");
      }
      for (const entry of tx.entries) {
        try {
          await assertContentRoot(
            tx.oldDb.roots.find((r) => r.id === entry.record.contentRootId),
          );
          retainedPaths.push(
            ...(await cleanTree(
              entry.record.contentPath,
              entry.content,
              entry.versionIdentity,
              entry.sourceLineage,
            )),
          );
        } catch {
          retainedPaths.push(entry.record.contentPath);
        }
        await discard(entry.backup, entry.record.descriptor);
        await discard(entry.temporary, entry.next.descriptor);
      }
    } else {
      if (hash(JSON.stringify(db)) !== tx.databaseHash)
        throw error("安装记录在迁移恢复前发生变化。");
      for (const entry of [...tx.entries].reverse()) {
        const registered = registration(entry.record, entry.retained);
        if (
          entry.next &&
          (await descriptorMatches(registered, entry.next.descriptor, 2))
        )
          await removeDescriptor(registered, entry.next.descriptor, 2);
        if (await optional(entry.backup)) {
          if (
            !(await descriptorMatches(entry.backup, entry.record.descriptor, 2))
          )
            throw error("迁移注册备份已改变，已保留恢复记录。");
          if (await optional(registered)) {
            if (
              !(await descriptorMatches(registered, entry.record.descriptor, 2))
            )
              throw error("原注册位置被其他文件占用，未覆盖该文件。");
          } else {
            await directoryChain(path.dirname(registered));
            await fs.link(entry.backup, registered);
          }
          await removeDescriptor(entry.backup, entry.record.descriptor, 2);
        } else if (
          !(await descriptorMatches(registered, entry.record.descriptor))
        )
          throw error("原注册文件丢失或被修改，无法自动恢复。");
        if (entry.next && (await optional(entry.temporary)))
          await discard(entry.temporary, entry.next.descriptor);
        if (entry.copied && targetTrusted) {
          if (entry.finalLineage)
            retainedPaths.push(
              ...(await cleanTree(
                entry.finalPath,
                entry.copied,
                entry.finalParentIdentity || entry.stageParentIdentity,
                entry.finalLineage,
              )),
            );
          retainedPaths.push(
            ...(await cleanTree(
              entry.stagePath,
              entry.copied,
              entry.stageParentIdentity,
              entry.stageLineage,
            )),
          );
        }
      }
    }
    try {
      if (targetTrusted) {
        await assertLineage(tx.taskLineage);
        await directoryChain(tx.taskPath);
        if (same(await fs.lstat(tx.taskPath), tx.taskIdentity))
          await fs.rmdir(tx.taskPath);
      }
    } catch {}
    if (await optional(tx.taskPath)) retainedPaths.push(tx.taskPath);
    await directoryChain(path.dirname(journalPath));
    await fs.unlink(journalPath);
    return {
      recovered: true,
      action: committed ? "completed" : "rolled-back",
      retainedPaths: [...new Set(retainedPaths)],
    };
  }

  async function execute({ planId, signal, onProgress } = {}) {
    const selected = plans.get(planId);
    if (!selected) throw error("迁移预览已失效，请重新预览。");
    plans.delete(planId);
    const { publicPlan, userdir, candidate } = selected;
    if (publicPlan.conflicts.length)
      throw error("迁移预览存在冲突，请先处理后重新预览。");
    let db = await load();
    if (hash(JSON.stringify(db)) !== selected.databaseHash)
      throw error("安装记录已变化，请重新预览迁移。");
    abort(signal);
    await gameGuard();
    await validateUserDataPath(userdir);
    await checkAnchor(selected.anchor);
    const exists = await optional(candidate.path);
    if (
      (!selected.targetExisted && exists) ||
      (selected.targetExisted && (!exists || !same(exists, candidate.identity)))
    )
      throw error("目标目录在预览后被创建或替换，请重新预览。");
    for (const item of selected.items) {
      await verifyTree(item.record.contentPath, item.content, signal);
      if (
        !(await descriptorMatches(
          registration(item.record, item.retained),
          item.record.descriptor,
        ))
      )
        throw error("注册文件在预览后发生变化。");
    }
    const id = randomUUID(),
      createdDirectories = [];
    if (selected.targetExisted) {
      await directoryChain(candidate.path);
      if (!same(await fs.lstat(candidate.path), candidate.identity))
        throw error("目标目录在创建前被替换。");
    } else {
      await directoryChain(
        path.dirname(candidate.path),
        true,
        createdDirectories,
      );
      await checkAnchor(selected.anchor);
      await fs.mkdir(candidate.path);
    }
    const targetRoot = {
      ...candidate,
      identity: identity(await fs.lstat(candidate.path)),
    };
    // Register the owned root before creating payloads, so interrupted staging is
    // discoverable even when the location change never reaches its commit point.
    if (!db.roots.some((item) => item.id === targetRoot.id)) {
      db.roots.push(targetRoot);
      await saveDatabase(db);
    }
    const taskPath = path.join(candidate.path, "tasks", "relocation-" + id);
    await directoryChain(path.dirname(taskPath), true, createdDirectories);
    await fs.mkdir(taskPath);
    const tx = {
      version: 2,
      type: "relocate",
      id,
      userdir,
      oldDb: clone(db),
      databaseHash: hash(JSON.stringify(db)),
      targetRoot,
      taskPath,
      taskIdentity: identity(await fs.lstat(taskPath)),
      taskLineage: await captureLineage(taskPath),
      entries: selected.items.map((item) => {
        const registered = registration(item.record, item.retained);
        return {
          ...item,
          stagePath: path.join(taskPath, item.record.transactionId, "content"),
          finalPath: path.join(
            candidate.path,
            "versions",
            item.record.modId,
            item.record.revision + "-" + item.record.transactionId,
            "content",
          ),
          temporary: registered + ".ironclad-relocation-tmp-" + id,
          backup: registered + ".ironclad-relocation-backup-" + id,
          copied: null,
          next: null,
        };
      }),
    };
    if (Buffer.byteLength(JSON.stringify(tx)) > 60 * 1024 ** 2)
      throw error("迁移文件清单过大，请减少单次迁移数量。");
    let journaled = false,
      processedBytes = 0,
      filesDone = 0;
    async function progress(stage, cancellable) {
      if (typeof onProgress === "function") {
        try {
          await onProgress({
            stage,
            processedBytes,
            totalBytes: publicPlan.bytes,
            filesDone,
            totalFiles: publicPlan.files,
            cancellable,
          });
        } catch {}
      }
    }
    try {
      await jsonWrite(journalPath, tx);
      journaled = true;
      for (const entry of tx.entries) {
        entry.copied = await copyTree(
          entry,
          tx,
          signal,
          async (bytes, done) => {
            processedBytes += bytes;
            if (done) filesDone++;
            await progress("copying", true);
          },
        );
        entry.stageParentIdentity = identity(
          await fs.lstat(path.dirname(entry.stagePath)),
        );
        const text = newDescriptor(entry.record, entry.finalPath);
        const handle = await fs.open(entry.temporary, "wx");
        try {
          entry.next = {
            ...clone(entry.record),
            contentRootId: targetRoot.id,
            contentPath: entry.finalPath,
            contentIdentity: entry.copied.directories[0].identity,
            descriptor: {
              text,
              hash: hash(text),
              identity: identity(await handle.stat()),
            },
          };
          await jsonWrite(journalPath, tx);
          await handle.writeFile(text);
        } finally {
          await handle.close();
        }
      }
      await progress("verifying", true);
      abort(signal);
      for (const entry of tx.entries) {
        await verifyTree(entry.record.contentPath, entry.content, signal);
        await verifyTree(entry.stagePath, entry.copied, signal);
      }
      await progress("committing", false);
      abort(signal);
      await gameGuard();
      await validateUserDataPath(userdir);
      await checkAnchor(selected.anchor);
      await assertContentRoot(targetRoot);
      for (const entry of tx.entries) {
        await verifyTree(entry.record.contentPath, entry.content, signal);
        await verifyTree(entry.stagePath, entry.copied, signal);
        const registered = registration(entry.record, entry.retained);
        if (
          !(await descriptorMatches(registered, entry.record.descriptor)) ||
          !(await descriptorMatches(entry.temporary, entry.next.descriptor))
        )
          throw error("迁移提交前注册文件发生变化。");
        await directoryChain(path.dirname(path.dirname(entry.finalPath)), true);
        if (await optional(path.dirname(entry.finalPath)))
          throw error("目标版本目录在提交前被其他文件占用。");
        entry.finalParentIdentity = entry.stageParentIdentity;
        entry.finalLineage = [
          ...(await captureLineage(
            path.dirname(path.dirname(entry.finalPath)),
          )),
          {
            path: path.dirname(entry.finalPath),
            identity: entry.finalParentIdentity,
          },
          {
            path: entry.finalPath,
            identity: entry.copied.directories[0].identity,
          },
        ];
        await jsonWrite(journalPath, tx);
        await assertLineage(entry.stageLineage);
        await assertLineage(entry.finalLineage.slice(0, -2));
        // Rename only within the destination volume; sources remain intact until DB commit.
        await fs.rename(
          path.dirname(entry.stagePath),
          path.dirname(entry.finalPath),
        );
        await assertLineage(entry.finalLineage);
        await jsonWrite(journalPath, tx);
        await fs.link(registered, entry.backup);
        await removeDescriptor(registered, entry.record.descriptor, 2);
        await fs.link(entry.temporary, registered);
        await removeDescriptor(entry.temporary, entry.next.descriptor, 2);
      }
      db = clone(db);
      if (!db.roots.some((item) => item.id === targetRoot.id))
        db.roots.push(targetRoot);
      db.locations = db.locations.filter(
        (item) => canonical(item.userDataPath) !== canonical(userdir),
      );
      db.locations.push({ userDataPath: userdir, rootId: targetRoot.id });
      for (const entry of tx.entries) {
        const records = entry.retained ? db.retainedVersions : db.records;
        records[
          records.findIndex(
            (item) => item.transactionId === entry.record.transactionId,
          )
        ] = entry.next;
      }
      db.lastRelocationId = id;
      await saveDatabase(db);
      await progress("cleaning", false);
      const outcome = await finish(tx, db);
      journaled = false;
      return {
        moved: tx.entries.length,
        retainedPaths: [
          ...new Set([
            ...publicPlan.retainedLegacyPaths,
            ...outcome.retainedPaths,
          ]),
        ],
        warnings: outcome.retainedPaths.length
          ? ["部分原文件已变化或无法清理，已保留并列出路径。"]
          : [],
        location: targetRoot.path,
      };
    } catch (failure) {
      if (journaled) {
        try {
          const current = await load();
          const outcome = await finish(tx, current);
          if (outcome.action === "completed")
            return {
              moved: tx.entries.length,
              retainedPaths: outcome.retainedPaths,
              warnings: outcome.retainedPaths.length
                ? ["迁移已完成，部分原文件已保留。"]
                : [],
              location: targetRoot.path,
            };
          if (outcome.retainedPaths.length)
            failure.retainedPaths = outcome.retainedPaths;
        } catch (recovery) {
          failure.code = "RECOVERY_REQUIRED";
          const detail = diagnostic("{0} 迁移恢复记录已保留，请重试恢复：{1}", [
            errorDiagnostic(failure),
            errorDiagnostic(recovery),
          ]);
          failure.message +=
            " 迁移恢复记录已保留，请重试恢复：" + recovery.message;
          attachDiagnostic(failure, detail);
        }
      } else {
        try {
          await assertLineage(tx.taskLineage);
          if (same(await fs.lstat(taskPath), tx.taskIdentity))
            await fs.rmdir(taskPath);
        } catch {}
      }
      throw failure;
    }
  }
  return {
    plan,
    execute,
    getStorageState,
    recover: finish,
    cancel: (planId) => plans.delete(planId),
  };
}

module.exports = { createRelocation };
