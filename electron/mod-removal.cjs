"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { parseDescriptor } = require("./mod-authoring.cjs");
const { diagnosticError } = require("./diagnostic-message.cjs");

const MAX_DESCRIPTOR_BYTES = 1024 * 1024;
const locks = new Map();
const messages = {
  local: "仅支持移除用户目录内独立安装的本地模组。",
  location: "模组文件位置无效或超出了当前用户目录。",
  link: "模组路径包含链接、目录联接或重定向，无法安全移除。",
  shared: "此模组与其他模组共用内容目录，无法安全移除。",
  changed: "模组文件在操作过程中发生变化，请刷新后重试。",
};
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const canonical = (value) => path.resolve(value).toLowerCase();
const samePath = (a, b) => canonical(a) === canonical(b);
const sameIdentity = (a, b) =>
  !!(
    a &&
    b &&
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.birthtimeMs === b.birthtimeMs
  );
const unchanged = (a, b) =>
  sameIdentity(a, b) &&
  (a.isDirectory() || (a.size === b.size && a.mtimeMs === b.mtimeMs));
function inside(root, target) {
  const relative = path.relative(canonical(root), canonical(target));
  return (
    !!relative &&
    relative !== ".." &&
    !relative.startsWith(".." + path.sep) &&
    !path.isAbsolute(relative)
  );
}
const overlaps = (a, b) => samePath(a, b) || inside(a, b) || inside(b, a);

function absolute(value) {
  if (
    typeof value !== "string" ||
    !value ||
    !path.isAbsolute(value) ||
    /[\0-\x1f\x7f]/.test(value)
  )
    throw new Error(messages.location);
  const resolved = path.resolve(value);
  if (
    resolved
      .slice(path.parse(resolved).root.length)
      .split(path.sep)
      .some((part) => /[<>:"|?*]|[. ]$/.test(part))
  )
    throw new Error(messages.location);
  return resolved;
}

async function optional(io, target) {
  try {
    return await io.lstat(target);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function chain(io, directory) {
  const root = path.parse(directory).root;
  const entries = [];
  let current = root;
  for (const part of directory
    .slice(root.length)
    .split(path.sep)
    .filter(Boolean)) {
    current = path.join(current, part);
    const stat = await io.lstat(current);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      !samePath(await io.realpath(current), current)
    )
      throw new Error(messages.link);
    entries.push({ path: current, identity: stat });
  }
  return entries;
}

async function anchors(io, entries) {
  for (const entry of entries) {
    const current = await io.lstat(entry.path);
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      !sameIdentity(entry.identity, current) ||
      !samePath(await io.realpath(entry.path), entry.path)
    )
      throw new Error(messages.changed);
  }
}

async function descriptor(io, filename) {
  const before = await io.lstat(filename);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size > MAX_DESCRIPTOR_BYTES
  )
    throw new Error(messages.local);
  const handle = await io.open(filename, "r");
  try {
    if (!sameIdentity(before, await handle.stat()))
      throw new Error(messages.changed);
    const bytes = await handle.readFile();
    if (
      bytes.length > MAX_DESCRIPTOR_BYTES ||
      !unchanged(before, await io.lstat(filename))
    )
      throw new Error(messages.changed);
    const fields = parseDescriptor(
      bytes.toString("utf8").replace(/^\uFEFF/, ""),
    );
    const get = (key) => fields.findLast((item) => item.key === key)?.value;
    const pathValue = get("path");
    const selected = pathValue || get("archive");
    if (typeof selected !== "string" || !selected || /[\0-\x1f]/.test(selected))
      throw new Error(messages.location);
    return { rawPath: selected, archive: !pathValue, identity: before };
  } finally {
    await handle.close();
  }
}

async function validate(
  { userData, mod, mods },
  io,
  readRegistrations = false,
) {
  if (
    !object(mod) ||
    mod.source !== "local" ||
    mod.projectId ||
    mod.available === false
  )
    throw new Error(messages.local);
  const root = absolute(userData),
    modRoot = path.join(root, "mod");
  const registration = absolute(mod.localDescriptor || mod.descriptorPath);
  const content = absolute(mod.contentPath);
  if (
    !samePath(path.dirname(registration), modRoot) ||
    path.extname(registration).toLowerCase() !== ".mod" ||
    !inside(root, registration) ||
    !inside(modRoot, content) ||
    overlaps(registration, content)
  )
    throw new Error(messages.location);
  const ancestry = [
    ...(await chain(io, modRoot)),
    ...(await chain(io, path.dirname(content))),
  ];
  const existingTrash = await optional(
    io,
    path.join(root, "ironclad-mod-trash"),
  );
  if (existingTrash) await chain(io, path.join(root, "ironclad-mod-trash"));
  const selected = await descriptor(io, registration);
  if (!samePath(path.resolve(root, selected.rawPath), content))
    throw new Error(messages.changed);
  const contentStat = await io.lstat(content);
  if (
    contentStat.isSymbolicLink() ||
    (!contentStat.isDirectory() && !contentStat.isFile()) ||
    !samePath(await io.realpath(content), content)
  )
    throw new Error(messages.link);
  if (selected.archive !== contentStat.isFile())
    throw new Error(messages.local);
  if (mods !== undefined && !Array.isArray(mods))
    throw new Error(messages.local);
  const references = mods ? [...mods] : [];
  // The renderer catalog deduplicates remote IDs and may omit registrations.
  // Actual removal must also inspect every on-disk descriptor before moving
  // content; the catalog alone is sufficient only for a capability preview.
  if (mods === undefined || readRegistrations) {
    for (const entry of await io.readdir(modRoot, { withFileTypes: true })) {
      if (path.extname(entry.name).toLowerCase() !== ".mod") continue;
      const otherRegistration = path.join(modRoot, entry.name);
      if (samePath(otherRegistration, registration)) continue;
      const other = await descriptor(io, otherRegistration);
      references.push({
        descriptorPath: otherRegistration,
        contentPath: path.resolve(root, other.rawPath),
      });
    }
  }
  for (const other of references) {
    if (!object(other) || other === mod) continue;
    const otherRegistration = other.localDescriptor || other.descriptorPath;
    if (
      typeof otherRegistration === "string" &&
      path.isAbsolute(otherRegistration) &&
      samePath(otherRegistration, registration)
    )
      continue;
    if (
      typeof other.contentPath === "string" &&
      other.contentPath &&
      overlaps(content, absolute(other.contentPath))
    )
      throw new Error(messages.shared);
  }
  await anchors(io, ancestry);
  return {
    root,
    modRoot,
    ancestry,
    sourceAncestry: [...ancestry],
    entries: [
      {
        originalPath: content,
        backupName: contentStat.isDirectory() ? "content" : "archive.zip",
        identity: contentStat,
      },
      {
        originalPath: registration,
        backupName: "registration.mod",
        identity: selected.identity,
      },
    ],
  };
}

async function canRemoveLocalMod(input = {}) {
  try {
    await validate(input, { ...fs, ...input.fileOps });
    return true;
  } catch {
    return false;
  }
}

async function removeLocalMod(input = {}) {
  const root = absolute(input.userData);
  if (input.commit !== undefined && typeof input.commit !== "function")
    throw new Error(messages.local);
  const previous = locks.get(canonical(root)) || Promise.resolve();
  const operation = previous.catch(() => {}).then(() => remove(input));
  locks.set(canonical(root), operation);
  operation
    .finally(() => {
      if (locks.get(canonical(root)) === operation)
        locks.delete(canonical(root));
    })
    .catch(() => {});
  return operation;
}

async function remove(input) {
  const io = { ...fs, ...input.fileOps };
  const ctx = await validate(input, io, true);
  const trash = path.join(ctx.root, "ironclad-mod-trash");
  const backupDirectory = path.join(trash, randomUUID());
  let backupIdentity;
  try {
    await anchors(io, ctx.ancestry);
    try {
      await io.mkdir(trash);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    ctx.ancestry.push(...(await chain(io, trash)));
    // mkdir has no recursive/existing-directory fallback: this UUID must be new.
    await io.mkdir(backupDirectory);
    backupIdentity = await io.lstat(backupDirectory);
    ctx.ancestry.push(...(await chain(io, backupDirectory)));
    if (!sameIdentity(backupIdentity, await io.lstat(backupDirectory)))
      throw new Error(messages.changed);
    const manifest = path.join(backupDirectory, "manifest.json");
    const handle = await io.open(manifest, "wx");
    try {
      const manifestIdentity = await handle.stat();
      await handle.writeFile(
        JSON.stringify(
          {
            schemaVersion: 1,
            operation: "remove-local-mod",
            createdAt: new Date().toISOString(),
            modId: typeof input.mod.id === "string" ? input.mod.id : null,
            userData: ctx.root,
            entries: ctx.entries.map(({ originalPath, backupName }) => ({
              originalPath,
              backupName,
            })),
          },
          null,
          2,
        ),
      );
      await handle.sync();
      const written = await io.lstat(manifest);
      if (
        !written.isFile() ||
        written.isSymbolicLink() ||
        !sameIdentity(manifestIdentity, written)
      )
        throw new Error(messages.changed);
    } finally {
      await handle.close();
    }
    for (const entry of ctx.entries) {
      await anchors(io, ctx.ancestry);
      const current = await io.lstat(entry.originalPath);
      if (current.isSymbolicLink() || !unchanged(entry.identity, current))
        throw new Error(messages.changed);
      const destination = path.join(backupDirectory, entry.backupName);
      if (await optional(io, destination)) throw new Error(messages.changed);
      await io.rename(entry.originalPath, destination);
      if (!sameIdentity(entry.identity, await io.lstat(destination)))
        throw new Error(messages.changed);
    }
    await anchors(
      io,
      ctx.ancestry.filter(
        (entry) =>
          !ctx.entries.some((target) =>
            samePath(target.originalPath, entry.path),
          ),
      ),
    );
    if (input.commit) await input.commit({ backupDirectory });
    // The settings transaction has committed; no fallible IO follows it.
    return { backupDirectory };
  } catch (error) {
    let restored = true;
    for (const entry of [...ctx.entries].reverse()) {
      try {
        // Never overwrite concurrent replacements or follow redirected ancestors.
        await anchors(io, ctx.sourceAncestry);
        await chain(io, path.dirname(entry.originalPath));
        const original = await optional(io, entry.originalPath);
        const backup = await optional(
          io,
          path.join(backupDirectory, entry.backupName),
        );
        if (original) {
          if (!unchanged(entry.identity, original) || backup) restored = false;
          continue;
        }
        if (
          !backupIdentity ||
          !backup ||
          !sameIdentity(entry.identity, backup)
        ) {
          restored = false;
          continue;
        }
        await chain(io, backupDirectory);
        if (!sameIdentity(backupIdentity, await io.lstat(backupDirectory))) {
          restored = false;
          continue;
        }
        await io.rename(
          path.join(backupDirectory, entry.backupName),
          entry.originalPath,
        );
        if (!sameIdentity(entry.identity, await io.lstat(entry.originalPath)))
          restored = false;
      } catch {
        restored = false;
      }
    }
    if (!restored)
      throw diagnosticError(
        "本地模组回收失败，部分文件保留在回收目录，请检查：{0}",
        [backupDirectory],
      );
    const failure = new Error("本地模组回收失败，已恢复原文件。", {
      cause: error,
    });
    throw failure;
  }
}

module.exports = { canRemoveLocalMod, removeLocalMod };
