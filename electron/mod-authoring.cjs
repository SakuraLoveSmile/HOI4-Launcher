"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { TextDecoder } = require("node:util");
const {
  diagnostic,
  diagnosticError,
  errorDiagnostic,
  attachDiagnostic,
} = require("./diagnostic-message.cjs");

const MAX_DESCRIPTOR_BYTES = 1024 * 1024;
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const has = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const forward = (value) => value.replace(/\\/g, "/");
const canonical = (value) => path.resolve(value).toLowerCase();
const quote = (value) =>
  '"' + value.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';

function validateFolder(value) {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 80 ||
    value !== value.trim() ||
    /[<>:"/\\|?*\0-\x1f\x7f]/.test(value) ||
    /[. ]$/.test(value) ||
    [".", ".."].includes(value) ||
    /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³]|CONIN\$|CONOUT\$|CLOCK\$)(?:\.|$)/i.test(
      value,
    )
  )
    throw new Error(
      "模组文件夹名称无效：请使用单个普通名称，不含路径、Windows 保留名称或结尾的点与空格。",
    );
  return value;
}

function cleanText(
  value,
  name,
  max,
  { optional = false, multiline = false } = {},
) {
  if (
    typeof value !== "string" ||
    value.length > max ||
    (multiline ? /[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/ : /[\0-\x1f\x7f]/).test(value)
  )
    throw diagnosticError("{0}格式无效。", [diagnostic(name) || name]);
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  if (!optional && !normalized)
    throw diagnosticError("{0}不能为空。", [diagnostic(name) || name]);
  return normalized;
}

function validateInput(input, creating) {
  const allowed = new Set([
    "name",
    "folder",
    "version",
    "supportedVersion",
    "tags",
    "description",
  ]);
  if (!object(input) || Object.keys(input).some((key) => !allowed.has(key)))
    throw diagnosticError("模组元数据包含不支持的字段。");
  const result = {};
  if (creating || has(input, "folder"))
    result.folder = validateFolder(input.folder);
  if (creating || has(input, "name"))
    result.name = cleanText(input.name, "模组名称", 120);
  if (creating || has(input, "version"))
    result.version = cleanText(input.version, "模组版本", 60);
  if (creating || has(input, "supportedVersion")) {
    const value = input.supportedVersion;
    if (
      typeof value !== "string" ||
      value.length > 40 ||
      !/^\d+(?:\.\d+){0,2}\.(?:\d+|\*)$/.test(value)
    )
      throw diagnosticError("支持的游戏版本格式无效，例如 1.19.* 或 1.19.4。");
    result.supportedVersion = value;
  }
  if (creating || has(input, "tags")) {
    if (!Array.isArray(input.tags) || input.tags.length > 32)
      throw diagnosticError("模组标签须为最多 32 个名称。");
    result.tags = [
      ...new Set(input.tags.map((tag) => cleanText(tag, "模组标签", 80))),
    ];
  }
  if (has(input, "description"))
    result.description = cleanText(input.description, "模组描述", 10000, {
      optional: true,
      multiline: true,
    });
  else if (creating) result.description = "";
  return result;
}

function validUserData(userData) {
  if (
    typeof userData !== "string" ||
    !path.isAbsolute(userData) ||
    /[\0-\x1f]/.test(userData)
  )
    throw diagnosticError("无法确定游戏用户目录。");
  return path.resolve(userData);
}

function isWithin(root, filename) {
  const relative = path.relative(root, filename);
  return (
    relative !== ".." &&
    !relative.startsWith(".." + path.sep) &&
    !path.isAbsolute(relative)
  );
}

async function statOptional(io, filename) {
  try {
    return await io.lstat(filename);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function sameIdentity(a, b) {
  return (
    a &&
    b &&
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.birthtimeMs === b.birthtimeMs
  );
}

// Every path component is checked: junctions and symbolic links are not authoring roots.
// Missing directories are created individually so rollback only considers our own ones.
async function directoryChain(io, directory, create = false, created = []) {
  const absolute = path.resolve(directory);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const segment of absolute
    .slice(parsed.root.length)
    .split(path.sep)
    .filter(Boolean)) {
    current = path.join(current, segment);
    let stat = await statOptional(io, current);
    if (!stat && create) {
      let made = false;
      try {
        await io.mkdir(current);
        made = true;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      stat = await io.lstat(current);
      if (made) created.push({ path: current, identity: stat });
    }
    if (!stat || !stat.isDirectory() || stat.isSymbolicLink())
      throw new Error(
        "模组目录不存在或含有符号链接／目录联接，不能安全写入：" + current,
      );
    if (canonical(await io.realpath(current)) !== canonical(current))
      throw new Error("模组目录经过了路径重定向，不能安全写入：" + current);
  }
  return absolute;
}

async function assertParent(io, root, filename) {
  const target = path.resolve(filename);
  if (!isWithin(root, target) || canonical(root) === canonical(target))
    throw diagnosticError("模组文件超出了本地模组目录。");
  await directoryChain(io, path.dirname(target));
  const realParent = await io.realpath(path.dirname(target));
  if (!isWithin(root, realParent))
    throw diagnosticError("模组文件指向了目录外的位置。");
}

async function writeExclusive(io, root, filename, bytes, tracked) {
  await assertParent(io, root, filename);
  const handle = await io.open(filename, "wx");
  const entry = {
    path: filename,
    identity: null,
    bytes: Buffer.from(bytes),
    retain: false,
  };
  tracked.push(entry);
  try {
    entry.identity = await handle.stat();
    await assertParent(io, root, filename);
    const current = await io.lstat(filename);
    if (current.isSymbolicLink() || !sameIdentity(current, entry.identity))
      throw diagnosticError("文件在创建过程中发生变化，已取消写入。");
    await handle.writeFile(bytes);
    return entry;
  } finally {
    await handle.close();
  }
}

async function removeOwnedFile(io, root, entry) {
  const current = await statOptional(io, entry.path);
  if (!current) return true;
  if (
    current.isSymbolicLink() ||
    !current.isFile() ||
    !sameIdentity(current, entry.identity)
  )
    return false;
  await assertParent(io, root, entry.path);
  const bytes = await io.readFile(entry.path);
  // Partial writes can be removed, but later content from another writer is preserved.
  if (
    bytes.length > entry.bytes.length ||
    !bytes.equals(entry.bytes.subarray(0, bytes.length))
  )
    return false;
  await io.unlink(entry.path);
  return true;
}

async function cleanTracked(io, root, files, directories = []) {
  const leftovers = [];
  for (const entry of [...files].reverse()) {
    if (entry.retain) continue;
    try {
      if (!(await removeOwnedFile(io, root, entry))) leftovers.push(entry.path);
    } catch {
      leftovers.push(entry.path);
    }
  }
  for (const entry of [...directories].reverse()) {
    try {
      const stat = await statOptional(io, entry.path);
      if (!stat) continue;
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        !sameIdentity(stat, entry.identity) ||
        canonical(await io.realpath(entry.path)) !== canonical(entry.path)
      ) {
        leftovers.push(entry.path);
        continue;
      }
      // rmdir removes empty directories only; concurrent content is never traversed.
      await io.rmdir(entry.path);
    } catch {
      leftovers.push(entry.path);
    }
  }
  return leftovers;
}

function baseDescriptor(input, { externalPath } = {}) {
  const entries = [
    "version=" + quote(input.version),
    "tags={" +
      (input.tags.length
        ? "\n" + input.tags.map((tag) => "\t" + quote(tag)).join("\n") + "\n"
        : "") +
      "}",
    "name=" + quote(input.name),
    "supported_version=" + quote(input.supportedVersion),
  ];
  if (input.description)
    entries.push("description=" + quote(input.description));
  if (externalPath) entries.push("path=" + quote(externalPath));
  return entries.join("\n") + "\n";
}

function publicError(error, operation) {
  if (error.code === "EEXIST")
    return diagnosticError(
      "同名模组、文件或编辑锁已经存在，未覆盖任何已有内容。",
    );
  if (["EACCES", "EPERM"].includes(error.code))
    return diagnosticError("{0}失败，请检查模组目录的访问权限。", [
      diagnostic(operation) || operation,
    ]);
  if (error.code === "ENAMETOOLONG")
    return diagnosticError("模组路径过长，请使用更短的文件夹名称。");
  return attachDiagnostic(
    new Error(error.message || operation + "失败。"),
    errorDiagnostic(error),
  );
}

async function createLocalMod({ userData, input, fsImpl = fs } = {}) {
  const root = validUserData(userData);
  const metadata = validateInput(input, true);
  const modRoot = path.join(root, "mod");
  const contentPath = path.join(modRoot, metadata.folder);
  const descriptorPath = path.join(modRoot, metadata.folder + ".mod");
  const files = [],
    directories = [];
  try {
    await directoryChain(fsImpl, modRoot, true, directories);
    if (await statOptional(fsImpl, descriptorPath))
      throw Object.assign(new Error("exists"), { code: "EEXIST" });
    await fsImpl.mkdir(contentPath);
    directories.push({
      path: contentPath,
      identity: await fsImpl.lstat(contentPath),
    });
    await directoryChain(fsImpl, contentPath);
    await writeExclusive(
      fsImpl,
      modRoot,
      path.join(contentPath, "descriptor.mod"),
      Buffer.from(baseDescriptor(metadata), "utf8"),
      files,
    );
    await writeExclusive(
      fsImpl,
      modRoot,
      descriptorPath,
      Buffer.from(
        baseDescriptor(metadata, { externalPath: "mod/" + metadata.folder }),
        "utf8",
      ),
      files,
    );
    return {
      id: "local:" + path.basename(descriptorPath).toLowerCase(),
      name: metadata.name,
      contentPath,
      descriptorPath,
    };
  } catch (error) {
    const leftovers = await cleanTracked(fsImpl, modRoot, files, directories);
    const reported = publicError(error, "创建模组");
    if (leftovers.length) {
      const paths = [...new Set(leftovers)].join("、");
      const detail = diagnostic(
        "{0} 部分新建内容因其他写入或权限变化被保留，请检查：{1}",
        [errorDiagnostic(reported), paths],
      );
      reported.message +=
        " 部分新建内容因其他写入或权限变化被保留，请检查：" + paths;
      attachDiagnostic(reported, detail);
    }
    throw reported;
  }
}

function parseDescriptor(text) {
  const tokens = [],
    pattern = /\s+|#[^\r\n]*|\/\/[^\r\n]*|"(?:\\.|[^"\\])*"|[{}=]|[^\s{}="#]+/g;
  let end = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index !== end) throw diagnosticError("模组描述文件格式无效。");
    end = match.index + match[0].length;
    if (/^\s|^#|^\/\//.test(match[0])) continue;
    tokens.push({ raw: match[0], start: match.index, end });
  }
  if (end !== text.length)
    throw diagnosticError("模组描述文件包含未闭合的字符串。");
  const decode = (raw) =>
    raw.startsWith('"') ? raw.slice(1, -1).replace(/\\(["\\])/g, "$1") : raw;
  const entries = [];
  for (let index = 0; index < tokens.length; ) {
    const key = tokens[index++];
    if (["{", "}", "="].includes(key.raw) || tokens[index++]?.raw !== "=")
      throw diagnosticError("模组描述文件的字段格式无效。");
    const first = tokens[index++];
    if (!first || ["}", "="].includes(first.raw))
      throw diagnosticError("模组描述文件字段缺少值。");
    let value = decode(first.raw),
      valueEnd = first.end;
    if (first.raw === "{") {
      const values = [];
      let depth = 1;
      while (index < tokens.length && depth) {
        const token = tokens[index++];
        valueEnd = token.end;
        if (token.raw === "{") depth++;
        if (token.raw === "}") depth--;
        if (depth) values.push(decode(token.raw));
      }
      if (depth) throw diagnosticError("模组描述文件包含未闭合的块。");
      value = values;
    }
    entries.push({
      key: decode(key.raw),
      value,
      start: key.start,
      end: valueEnd,
      valueStart: first.start,
      valueEnd,
    });
  }
  return entries;
}

function getField(fields, key) {
  return fields.findLast((field) => field.key === key)?.value;
}

async function readSnapshot(io, modRoot, filename, optional = false) {
  await assertParent(io, modRoot, filename);
  const before = await statOptional(io, filename);
  if (!before && optional) return null;
  if (
    !before ||
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size > MAX_DESCRIPTOR_BYTES
  )
    throw diagnosticError("模组描述文件不存在、过大或不是普通文件。");
  const handle = await io.open(filename, "r");
  try {
    const identity = await handle.stat();
    if (!sameIdentity(before, identity))
      throw diagnosticError("模组描述文件在读取时发生变化，请重试。");
    const bytes = await handle.readFile();
    if (bytes.length > MAX_DESCRIPTOR_BYTES)
      throw diagnosticError("模组描述文件超过 1 MB。");
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        bytes,
      );
    } catch {
      throw diagnosticError("模组描述文件不是有效 UTF-8，未作修改。");
    }
    return {
      path: filename,
      bytes,
      identity,
      text,
      fields: parseDescriptor(text),
    };
  } finally {
    await handle.close();
  }
}

async function context({ userData, descriptorPath, fsImpl = fs }) {
  const root = validUserData(userData),
    modRoot = path.join(root, "mod");
  if (
    typeof descriptorPath !== "string" ||
    !path.isAbsolute(descriptorPath) ||
    path.extname(descriptorPath).toLowerCase() !== ".mod" ||
    canonical(path.dirname(descriptorPath)) !== canonical(modRoot)
  )
    throw diagnosticError("只能编辑游戏用户 mod 目录中的本地模组描述文件。");
  await directoryChain(fsImpl, modRoot);
  const outer = await readSnapshot(
    fsImpl,
    modRoot,
    path.resolve(descriptorPath),
  );
  const rawPath = getField(outer.fields, "path");
  if (
    typeof rawPath !== "string" ||
    !rawPath ||
    /[\0-\x1f]/.test(rawPath) ||
    getField(outer.fields, "archive")
  )
    throw new Error(
      "只能编辑本地文件夹模组，压缩包或远程管理的模组不能在这里编辑。",
    );
  const contentPath = path.resolve(root, rawPath);
  if (
    !isWithin(modRoot, contentPath) ||
    canonical(contentPath) === canonical(modRoot)
  )
    throw diagnosticError(
      "该模组内容位于本地创作目录之外，创意工坊或远程缓存只读。",
    );
  const folder = validateFolder(path.basename(contentPath));
  await directoryChain(fsImpl, contentPath);
  const innerPath = path.join(contentPath, "descriptor.mod");
  const inner = await readSnapshot(fsImpl, modRoot, innerPath, true);
  const get = (key) =>
    getField(outer.fields, key) ??
    (inner ? getField(inner.fields, key) : undefined);
  const remoteFileId =
    typeof get("remote_file_id") === "string" ? get("remote_file_id") : null;
  const registeredRemoteId = getField(outer.fields, "remote_file_id");
  const metadata = {
    id:
      typeof registeredRemoteId === "string" && /^\d+$/.test(registeredRemoteId)
        ? "workshop:" + registeredRemoteId
        : "local:" + path.basename(descriptorPath).toLowerCase(),
    name: typeof get("name") === "string" ? get("name") : folder,
    folder,
    version: typeof get("version") === "string" ? get("version") : "",
    supportedVersion:
      typeof get("supported_version") === "string"
        ? get("supported_version")
        : "",
    tags: Array.isArray(get("tags")) ? get("tags") : [],
    description:
      typeof get("description") === "string" ? get("description") : "",
    contentPath,
    descriptorPath: outer.path,
    remoteFileId,
    popsId: typeof get("pops_id") === "string" ? get("pops_id") : null,
    editable: true,
  };
  return { root, modRoot, outer, inner, innerPath, metadata };
}

async function readLocalModMetadata(options = {}) {
  return (await context(options)).metadata;
}

function patchDescriptor(snapshot, patch) {
  const fields = {
    name: "name",
    version: "version",
    supportedVersion: "supported_version",
    tags: "tags",
    description: "description",
  };
  const values = new Map(
    Object.entries(patch)
      .filter(([key]) => fields[key])
      .map(([key, value]) => [
        fields[key],
        key === "tags" ? "{" + value.map(quote).join(" ") + "}" : quote(value),
      ]),
  );
  const edits = snapshot.fields
    .filter((field) => values.has(field.key))
    .map((field) => ({
      start: field.valueStart,
      end: field.valueEnd,
      value: values.get(field.key),
    }))
    .sort((a, b) => b.start - a.start);
  let result = snapshot.text;
  for (const edit of edits)
    result = result.slice(0, edit.start) + edit.value + result.slice(edit.end);
  const newline = snapshot.text.includes("\r\n") ? "\r\n" : "\n";
  for (const [key, value] of values)
    if (!snapshot.fields.some((field) => field.key === key))
      result +=
        (result && !result.endsWith("\n") ? newline : "") +
        key +
        "=" +
        value +
        newline;
  return Buffer.from(result, "utf8");
}

function innerFromOuter(outer, patch) {
  let text = patchDescriptor(outer, patch).toString("utf8");
  for (const field of parseDescriptor(text)
    .filter((field) => ["path", "archive"].includes(field.key))
    .sort((a, b) => b.start - a.start))
    text = text.slice(0, field.start) + text.slice(field.end);
  return Buffer.from(text, "utf8");
}

async function unchanged(io, modRoot, filename, expected) {
  await assertParent(io, modRoot, filename);
  const current = await statOptional(io, filename);
  if (expected === null) {
    if (current)
      throw diagnosticError("另一个程序已创建模组描述文件，已取消覆盖。");
    return;
  }
  if (
    !current ||
    current.isSymbolicLink() ||
    !current.isFile() ||
    !sameIdentity(current, expected.identity) ||
    !(await io.readFile(filename)).equals(expected.bytes)
  )
    throw diagnosticError("模组文件被其他程序修改，已取消覆盖。请刷新后重试。");
}

async function updateLocalModMetadata({
  userData,
  descriptorPath,
  input,
  fsImpl = fs,
} = {}) {
  const patch = validateInput(input, false);
  let ctx = await context({ userData, descriptorPath, fsImpl });
  if (has(patch, "folder") && patch.folder !== ctx.metadata.folder)
    throw diagnosticError("元数据编辑不能重命名模组文件夹。");
  delete patch.folder;
  if (!Object.keys(patch).length) return { ...ctx.metadata, backups: [] };
  const tracked = [],
    applied = [],
    backups = [];
  let result, failure;
  try {
    await writeExclusive(
      fsImpl,
      ctx.modRoot,
      ctx.outer.path + ".ironclad-edit.lock",
      Buffer.from(randomUUID()),
      tracked,
    );
    // Reread after acquiring our lock to avoid applying a stale editor snapshot.
    ctx = await context({ userData, descriptorPath, fsImpl });
    const merged = { ...ctx.metadata, ...patch };
    const proposed = [
      {
        path: ctx.outer.path,
        previous: ctx.outer,
        bytes: patchDescriptor(ctx.outer, patch),
      },
      {
        path: ctx.innerPath,
        previous: ctx.inner,
        bytes: ctx.inner
          ? patchDescriptor(ctx.inner, patch)
          : innerFromOuter(ctx.outer, patch),
      },
    ].filter(
      (item) => !item.previous || !item.bytes.equals(item.previous.bytes),
    );
    const stamp =
      new Date().toISOString().replace(/[:.]/g, "-") +
      "-" +
      randomUUID().slice(0, 8);
    for (const item of proposed) {
      if (item.previous) {
        const backupPath = item.path + ".ironclad-backup-" + stamp;
        const backup = await writeExclusive(
          fsImpl,
          ctx.modRoot,
          backupPath,
          item.previous.bytes,
          tracked,
        );
        backup.retain = true;
        backups.push(backupPath);
      }
      item.temporary = await writeExclusive(
        fsImpl,
        ctx.modRoot,
        item.path + ".ironclad-tmp-" + randomUUID(),
        item.bytes,
        tracked,
      );
    }
    for (const item of proposed)
      await unchanged(fsImpl, ctx.modRoot, item.path, item.previous);
    for (const item of proposed) {
      await unchanged(fsImpl, ctx.modRoot, item.path, item.previous);
      await fsImpl.rename(item.temporary.path, item.path);
      applied.push({ ...item, identity: item.temporary.identity });
    }
    result = { ...merged, backups };
  } catch (error) {
    let restored = true;
    for (const item of [...applied].reverse()) {
      try {
        await unchanged(fsImpl, ctx.modRoot, item.path, {
          identity: item.identity,
          bytes: item.bytes,
        });
        if (!item.previous) await fsImpl.unlink(item.path);
        else {
          const restore = await writeExclusive(
            fsImpl,
            ctx.modRoot,
            item.path + ".ironclad-restore-" + randomUUID(),
            item.previous.bytes,
            tracked,
          );
          await unchanged(fsImpl, ctx.modRoot, item.path, {
            identity: item.identity,
            bytes: item.bytes,
          });
          await fsImpl.rename(restore.path, item.path);
        }
      } catch {
        restored = false;
      }
    }
    failure = publicError(error, "更新模组");
    if (applied.length) {
      const detail = diagnostic(
        restored
          ? "{0} 已恢复修改前的描述文件。"
          : "{0} 为保留其他写入，部分文件未回滚；请检查 .ironclad-backup-* 备份。",
        [errorDiagnostic(failure)],
      );
      failure.message += restored
        ? " 已恢复修改前的描述文件。"
        : " 为保留其他写入，部分文件未回滚；请检查 .ironclad-backup-* 备份。";
      attachDiagnostic(failure, detail);
    }
  }
  const leftovers = await cleanTracked(fsImpl, ctx.modRoot, tracked);
  if (leftovers.length) {
    if (failure) {
      const detail = diagnostic(
        "{0} 临时文件因权限或其他写入被保留，请检查：{1}",
        [errorDiagnostic(failure), leftovers.join("、")],
      );
      failure.message +=
        " 临时文件因权限或其他写入被保留，请检查：" + leftovers.join("、");
      attachDiagnostic(failure, detail);
    } else
      result.warnings = [
        "元数据已更新，但部分临时文件无法清理：" + leftovers.join("、"),
      ];
  }
  if (failure) throw failure;
  return result;
}

module.exports = {
  parseDescriptor,
  createLocalMod,
  readLocalModMetadata,
  updateLocalModMetadata,
};
