"use strict";

const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { TextDecoder } = require("node:util");
const yauzl = require("yauzl");
const data = require("./managed-data.cjs");
const { captureEnvironment } = require("./launch-environment.cjs");
const { inspectModScript } = require("./mod-project-checks.cjs");
const {
  normalizePdxPatchPath,
  pdxPatchPathKey,
} = require("./pdx-patch-path.cjs");

const COVERAGE_LIMITS = Object.freeze({
  modFiles: 20000,
  totalFiles: 100000,
  modEntries: 30000,
  totalEntries: 150000,
  textFileBytes: 1024 ** 2,
  totalTextBytes: 32 * 1024 ** 2,
  archiveReadBytes: 64 * 1024 ** 2,
  modBytes: 20 * 1024 ** 3,
  totalBytes: 100 * 1024 ** 3,
  groups: 1000,
  evidence: 10000,
  groupEvidence: 200,
  definitions: 50000,
  notices: 100,
});
const clone = (value) => structuredClone(value);
const stampStat = (stat) => [
  stat.dev,
  stat.ino,
  stat.birthtimeNs,
  stat.size,
  stat.mtimeNs,
  stat.ctimeNs,
  stat.nlink,
];
const stableStat = (a, b) => {
  const x = stampStat(a),
    y = stampStat(b);
  return x.every((v, i) => v === y[i]);
};
const cleanRoot = (name) =>
  !name.includes("/") &&
  /^(?:[^/]+\.mod|(?:thumbnail|preview)\.(?:png|jpe?g|webp|dds))$/i.test(name);
const textual = (name) =>
  /\.(?:txt|gui|gfx|asset|lua|ya?ml|mod|json|csv)$/i.test(name);
const semantic = (name) =>
  /^(?:events\/|common\/national_focus\/).*\.txt$/i.test(name);
function failure(message, code = "COVERAGE_INVALID") {
  return Object.assign(new Error(message), { code });
}
function checkAbort(signal) {
  if (signal?.aborted)
    throw Object.assign(failure("已取消覆盖证据检查。", "ABORT_ERR"), {
      name: "AbortError",
    });
}
function safeName(value) {
  try {
    const name = normalizePdxPatchPath(value);
    if (name !== value) throw failure();
    return name;
  } catch {
    throw failure("模组包含不安全路径或路径名称冲突。");
  }
}
function addName(names, name, directory, explicit = true) {
  const parts = name.split("/");
  for (let i = 1; i <= parts.length; i++) {
    const n = parts.slice(0, i).join("/"),
      key = pdxPatchPathKey(n),
      leaf = i === parts.length,
      type = !leaf || directory ? "directory" : "file",
      old = names.get(key);
    if (
      old &&
      (old.name !== n ||
        old.type !== type ||
        (leaf && explicit && old.explicit))
    )
      throw failure("模组包含重复名称、大小写冲突或文件与目录冲突。");
    names.set(key, {
      name: n,
      type,
      explicit: Boolean(old?.explicit || (leaf && explicit)),
    });
  }
}
async function safeStat(filename) {
  await data.directory(path.dirname(filename));
  const stat = await fs.lstat(filename, { bigint: true });
  if (
    stat.isSymbolicLink() ||
    (!stat.isDirectory() && !stat.isFile()) ||
    (stat.isFile() && stat.nlink !== 1n)
  )
    throw failure("来源包含链接、硬链接或特殊文件。");
  return stat;
}
async function assertStat(filename, expected) {
  const actual = await safeStat(filename);
  if (!stableStat(expected, actual))
    throw failure("证据文件已变化，请重新检查覆盖证据。");
  return actual;
}
async function readTextFile(filename, signal, expected = null) {
  checkAbort(signal);
  const before = await safeStat(filename);
  if (!before.isFile() || before.size > BigInt(COVERAGE_LIMITS.textFileBytes))
    throw failure("文件超过文本证据读取上限。", "COVERAGE_LIMIT");
  if (expected && !stableStat(before, expected))
    throw failure("证据文件已变化，请重新检查覆盖证据。");
  const handle = await fs.open(
    filename,
    constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
  );
  try {
    if (!stableStat(before, await handle.stat({ bigint: true })))
      throw failure("读取前文件发生变化。");
    const chunks = [];
    let bytes = 0;
    for (;;) {
      checkAbort(signal);
      const buffer = Buffer.allocUnsafe(65536),
        result = await handle.read(buffer, 0, buffer.length, null);
      if (!result.bytesRead) break;
      bytes += result.bytesRead;
      if (bytes > Number(before.size) || bytes > COVERAGE_LIMITS.textFileBytes)
        throw failure("文件在读取期间增长。");
      chunks.push(buffer.subarray(0, result.bytesRead));
    }
    checkAbort(signal);
    if (
      bytes !== Number(before.size) ||
      !stableStat(before, await handle.stat({ bigint: true }))
    )
      throw failure("读取期间文件发生变化。");
    await assertStat(filename, before);
    const buffer = Buffer.concat(chunks);
    return { stat: before, buffer, hash: data.sha256(buffer) };
  } finally {
    await handle.close();
  }
}
function decode(buffer) {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  if (text.includes("\0")) throw failure("文件不是可读取的 UTF-8 文本。");
  return text;
}
const crcTable = Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function crcUpdate(crc, bytes) {
  for (const b of bytes) crc = crcTable[(crc ^ b) & 255] ^ (crc >>> 8);
  return crc >>> 0;
}
async function zipBytes(zip, entry, signal) {
  const stream = await zip.openReadStreamPromise(entry),
    hash = createHash("sha256"),
    chunks = [];
  let bytes = 0,
    crc = 0xffffffff;
  for await (const chunk of stream) {
    checkAbort(signal);
    bytes += chunk.length;
    if (
      bytes > entry.uncompressedSize ||
      bytes > COVERAGE_LIMITS.archiveReadBytes
    )
      throw failure("ZIP 文件解压读取超限。", "COVERAGE_LIMIT");
    hash.update(chunk);
    crc = crcUpdate(crc, chunk);
    if (bytes <= COVERAGE_LIMITS.textFileBytes) chunks.push(chunk);
  }
  checkAbort(signal);
  if (
    bytes !== entry.uncompressedSize ||
    (crc ^ 0xffffffff) >>> 0 !== entry.crc32
  )
    throw failure("ZIP 文件大小或 CRC 校验失败。");
  return {
    hash: hash.digest("hex"),
    buffer:
      bytes <= COVERAGE_LIMITS.textFileBytes ? Buffer.concat(chunks) : null,
  };
}
function zipEntry(entry) {
  const directory = entry.fileName.endsWith("/"),
    type = (entry.externalFileAttributes >>> 16) & 0xf000;
  if (
    (type && ![0x8000, 0x4000].includes(type)) ||
    (type === 0x4000 && !directory) ||
    entry.generalPurposeBitFlag & 1 ||
    ![0, 8].includes(entry.compressionMethod)
  )
    throw failure("ZIP 包含链接、特殊文件、加密内容或不支持的条目。");
  const name = safeName(
    directory ? entry.fileName.slice(0, -1) : entry.fileName,
  );
  if (
    !Number.isSafeInteger(entry.uncompressedSize) ||
    entry.uncompressedSize < 0 ||
    entry.uncompressedSize > COVERAGE_LIMITS.modBytes ||
    entry.uncompressedSize > Math.max(1024 ** 2, entry.compressedSize * 1000) ||
    (directory && entry.uncompressedSize)
  )
    throw failure("ZIP 单文件大小或膨胀比例超过检查上限。", "COVERAGE_LIMIT");
  return { name, directory };
}

function createModCoverageService({ launcher }) {
  let busy = false,
    controller = null,
    progress = { index: 0, total: 0 },
    latest = null;
  function stamp(state) {
    const environment = captureEnvironment(state);
    return data.sha256(
      JSON.stringify({
        environment,
        paths: state.paths,
        mods: environment.mods.map((m) => {
          const mod = state.mods.find((v) => v.id === m.id);
          return {
            id: m.id,
            contentPath: mod?.contentPath,
            descriptorPath: mod?.descriptorPath,
          };
        }),
      }),
    );
  }
  return {
    isBusy: () => busy,
    getProgress: () => ({
      busy,
      ...progress,
      canCancel: busy && Boolean(controller) && !controller.signal.aborted,
    }),
    cancel: () => {
      if (!busy || !controller || controller.signal.aborted) return false;
      controller.abort();
      return true;
    },
    scan: async () => {
      if (busy) throw failure("覆盖证据正在检查，请等待完成。");
      busy = true;
      controller = new AbortController();
      latest = null;
      const signal = controller.signal;
      try {
        const state = await launcher.getState(),
          environment = captureEnvironment(state),
          startStamp = stamp(state),
          report = {
            id: randomUUID(),
            checkedAt: new Date().toISOString(),
            configurationId: environment.configurationId,
            playsetId: environment.playset.id,
            playsetName: environment.playset.name,
            partial: false,
            mods: [],
            groups: [],
            notices: [],
            counts: { files: 0, mods: environment.mods.length, groups: 0 },
          };
        const notices = new Set(),
          files = [],
          definitions = { events: new Map(), focuses: new Map() },
          declarations = [],
          descriptorProofs = [],
          observedAll = [],
          evidenceMap = new Map();
        let discardedNotices = 0,
          evidenceCount = 0,
          work = 0;
        const budget = {
          entries: 0,
          files: 0,
          bytes: 0,
          text: 0,
          zipRead: 0,
          definitions: 0,
        };
        const notice = (message) => {
          report.partial = true;
          if (notices.size < COVERAGE_LIMITS.notices) notices.add(message);
          else discardedNotices++;
        };
        const tick = async () => {
          if (++work % 2048 === 0)
            await new Promise((resolve) => setImmediate(resolve));
          checkAbort(signal);
        };
        const reserve = (local, stat, file) => {
          local.entries++;
          budget.entries++;
          if (file) {
            local.files++;
            budget.files++;
            local.bytes += Number(stat.size);
            budget.bytes += Number(stat.size);
          }
          if (
            local.entries > COVERAGE_LIMITS.modEntries ||
            budget.entries > COVERAGE_LIMITS.totalEntries ||
            local.files > COVERAGE_LIMITS.modFiles ||
            budget.files > COVERAGE_LIMITS.totalFiles ||
            local.bytes > COVERAGE_LIMITS.modBytes ||
            budget.bytes > COVERAGE_LIMITS.totalBytes
          )
            throw failure("文件数量或大小超过覆盖检查上限。", "COVERAGE_LIMIT");
        };
        const inspect = (mod, file, text, local) => {
          if (!semantic(file.path) && !file.descriptor) return;
          const parsed = inspectModScript(
            file.descriptor ? "descriptor.mod" : file.path,
            text,
          );
          if (parsed.error) {
            local.partial = true;
            notice(`模组「${mod.name}」：${file.path} 无法完成脚本结构检查。`);
            return;
          }
          for (const [field, target] of [
            ["events", local.events],
            ["focuses", local.focuses],
          ])
            for (const item of parsed[field]) {
              if (++budget.definitions > COVERAGE_LIMITS.definitions) {
                local.partial = true;
                notice("事件和国策定义数量超过检查上限。");
                break;
              }
              target.push({ ...item, file });
            }
          for (const item of parsed.replacePaths) {
            if (
              declarations.length + local.declarations.length >=
              COVERAGE_LIMITS.groups
            ) {
              local.partial = true;
              notice("replace_path 声明数量超过检查上限。");
              break;
            }
            try {
              let value = item.value.replaceAll("\\", "/").replace(/\/$/, "");
              value = safeName(value);
              local.declarations.push({ value, line: item.line, file });
            } catch {
              local.partial = true;
              notice(`模组「${mod.name}」：replace_path 路径无法安全解释。`);
            }
          }
        };
        for (const [order, selected] of environment.mods.entries()) {
          checkAbort(signal);
          progress = {
            index: order + 1,
            total: environment.mods.length,
            name: selected.name,
          };
          const scanned = state.mods.find((m) => m.id === selected.id),
            mod = {
              id: selected.id,
              name: selected.name,
              order: order + 1,
              status: "complete",
              fileCount: 0,
            };
          report.mods.push(mod);
          const local = {
              entries: 0,
              files: 0,
              bytes: 0,
              events: [],
              focuses: [],
              declarations: [],
              partial: false,
            },
            ownFiles = [],
            observed = [];
          try {
            if (
              !scanned?.available ||
              !path.isAbsolute(scanned.contentPath || "")
            )
              throw failure("模组缺失或没有可读取的本地内容。");
            const descriptorPath = scanned.projectId
              ? path.join(scanned.contentPath, "descriptor.mod")
              : scanned.descriptorPath;
            if (!path.isAbsolute(descriptorPath || ""))
              throw failure("无法确定可信的模组登记描述文件。");
            try {
              const stat = await safeStat(descriptorPath);
              if (
                budget.text + Number(stat.size) >
                COVERAGE_LIMITS.totalTextBytes
              )
                throw failure(
                  "描述文件文本总量超过检查上限。",
                  "COVERAGE_LIMIT",
                );
              const raw = await readTextFile(descriptorPath, signal, stat);
              budget.text += raw.buffer.length;
              const text = decode(raw.buffer),
                file = {
                  path: path.basename(descriptorPath),
                  absolutePath: descriptorPath,
                  stat: raw.stat,
                  hash: raw.hash,
                  textAvailable: true,
                  descriptor: true,
                  storage: "directory",
                  mod,
                };
              observed.push({ filename: descriptorPath, stat: raw.stat });
              descriptorProofs.push({
                filename: descriptorPath,
                stat: raw.stat,
              });
              inspect(mod, file, text, local);
            } catch (error) {
              checkAbort(signal);
              local.partial = true;
              notice(`模组「${mod.name}」：登记描述文件无法完整检查。`);
            }
            const rootStat = await safeStat(scanned.contentPath);
            if (rootStat.isDirectory()) {
              const names = new Map();
              async function walk(filename, prefix = "") {
                await tick();
                const stat = await safeStat(filename);
                reserve(local, stat, stat.isFile());
                observed.push({ filename, stat });
                if (stat.isDirectory()) {
                  const directory = await fs.opendir(filename);
                  for await (const child of directory) {
                    const name = safeName(
                      prefix ? `${prefix}/${child.name}` : child.name,
                    );
                    const childStat = await safeStat(
                      path.join(filename, child.name),
                    );
                    addName(names, name, childStat.isDirectory());
                    await walk(path.join(filename, child.name), name);
                  }
                  return;
                }
                if (cleanRoot(prefix)) return;
                const file = {
                  path: prefix,
                  key: pdxPatchPathKey(prefix),
                  absolutePath: filename,
                  stat,
                  hash: null,
                  textAvailable: false,
                  descriptor: false,
                  storage: "directory",
                  mod,
                };
                ownFiles.push(file);
                if (!textual(prefix)) return;
                if (
                  stat.size > BigInt(COVERAGE_LIMITS.textFileBytes) ||
                  budget.text + Number(stat.size) >
                    COVERAGE_LIMITS.totalTextBytes
                ) {
                  local.partial = true;
                  notice(
                    `模组「${mod.name}」：部分文本超过检查预算，仅登记文件路径。`,
                  );
                  return;
                }
                const raw = await readTextFile(filename, signal, stat);
                budget.text += raw.buffer.length;
                file.hash = raw.hash;
                try {
                  const text = decode(raw.buffer);
                  file.textAvailable = true;
                  inspect(mod, file, text, local);
                } catch {
                  local.partial = true;
                  notice(
                    `模组「${mod.name}」：部分文件不是可读取的 UTF-8 文本。`,
                  );
                }
              }
              await walk(scanned.contentPath);
            } else {
              if (rootStat.size > BigInt(COVERAGE_LIMITS.modBytes))
                throw failure("ZIP 归档大小超过检查上限。", "COVERAGE_LIMIT");
              const zip = await yauzl.openPromise(scanned.contentPath, {
                lazyEntries: true,
                autoClose: false,
                strictFileNames: true,
                validateEntrySizes: true,
              });
              zip.on("error", () => {});
              const names = new Map();
              observed.push({ filename: scanned.contentPath, stat: rootStat });
              try {
                if (zip.entryCount > COVERAGE_LIMITS.modEntries)
                  throw failure("ZIP 条目超过检查上限。", "COVERAGE_LIMIT");
                for await (const entry of zip.eachEntry()) {
                  await tick();
                  const { name, directory } = zipEntry(entry);
                  const previousPaths = names.size;
                  addName(names, name, directory);
                  const implicitEntries = names.size - previousPaths - 1;
                  local.entries += implicitEntries;
                  budget.entries += implicitEntries;
                  if (names.size > COVERAGE_LIMITS.modEntries)
                    throw failure(
                      "ZIP 路径数量超过检查上限。",
                      "COVERAGE_LIMIT",
                    );
                  reserve(
                    local,
                    { size: BigInt(entry.uncompressedSize) },
                    !directory,
                  );
                  if (directory) continue;
                  const file = {
                    path: name,
                    key: pdxPatchPathKey(name),
                    absolutePath: scanned.contentPath,
                    stat: rootStat,
                    hash: null,
                    textAvailable: false,
                    descriptor: false,
                    storage: "archive",
                    mod,
                  };
                  if (!cleanRoot(name)) ownFiles.push(file);
                  if (
                    budget.zipRead + entry.uncompressedSize >
                    COVERAGE_LIMITS.archiveReadBytes
                  ) {
                    local.partial = true;
                    notice(
                      `模组「${mod.name}」：ZIP 内容超过读取预算，部分条目仅登记路径。`,
                    );
                    continue;
                  }
                  const raw = await zipBytes(zip, entry, signal);
                  budget.zipRead += entry.uncompressedSize;
                  file.hash = raw.hash;
                  if (cleanRoot(name) || !textual(name)) continue;
                  if (
                    !raw.buffer ||
                    budget.text + entry.uncompressedSize >
                      COVERAGE_LIMITS.totalTextBytes
                  ) {
                    local.partial = true;
                    notice(
                      `模组「${mod.name}」：部分文本超过检查预算，仅登记文件路径。`,
                    );
                    continue;
                  }
                  budget.text += raw.buffer.length;
                  try {
                    const text = decode(raw.buffer);
                    file.textAvailable = true;
                    inspect(mod, file, text, local);
                  } catch {
                    local.partial = true;
                    notice(
                      `模组「${mod.name}」：部分文件不是可读取的 UTF-8 文本。`,
                    );
                  }
                }
              } finally {
                zip.close();
              }
            }
            for (const item of observed) {
              await tick();
              await assertStat(item.filename, item.stat);
            }
            mod.fileCount = ownFiles.length;
            mod.status = local.partial ? "partial" : "complete";
            files.push(...ownFiles);
            declarations.push(...local.declarations);
            observedAll.push(...observed);
            for (const [field, map] of Object.entries(definitions))
              for (const item of local[field]) {
                const values = map.get(item.id) || [];
                values.push(item);
                map.set(item.id, values);
              }
          } catch (error) {
            checkAbort(signal);
            mod.status =
              error.code === "COVERAGE_LIMIT" ? "partial" : "unavailable";
            notice(
              error.code === "COVERAGE_LIMIT"
                ? `模组「${mod.name}」：文件检查未完成（超过检查预算）。`
                : `模组「${mod.name}」：文件检查未完成（来源不可读取、不安全或在检查期间变化）。`,
            );
          }
        }
        function addGroup(kind, value, items) {
          if (report.groups.length >= COVERAGE_LIMITS.groups) {
            notice("覆盖证据分组超过显示上限。");
            return;
          }
          const evidence = [];
          const ordered = [...items].sort((a, b) => {
            const x = a.file || a,
              y = b.file || b;
            return (
              x.mod.order - y.mod.order ||
              x.path.localeCompare(y.path) ||
              (a.line || 1) - (b.line || 1)
            );
          });
          for (const item of ordered) {
            if (
              evidence.length >= COVERAGE_LIMITS.groupEvidence ||
              evidenceCount >= COVERAGE_LIMITS.evidence
            ) {
              notice("覆盖证据条目超过显示上限。");
              break;
            }
            const file = item.file || item,
              id = randomUUID(),
              entry = {
                id,
                modId: file.mod.id,
                modName: file.mod.name,
                order: file.mod.order,
                path: file.path,
                line: item.line || 1,
                ...(item.role ? { role: item.role } : {}),
              };
            evidence.push(entry);
            evidenceMap.set(id, { ...entry, file });
            evidenceCount++;
          }
          if (evidence.length)
            report.groups.push({ id: randomUUID(), kind, value, evidence });
        }
        const paths = new Map();
        for (const file of files) {
          await tick();
          const values = paths.get(file.key) || [];
          values.push(file);
          paths.set(file.key, values);
        }
        for (const values of paths.values()) {
          await tick();
          if (new Set(values.map((file) => file.mod.id)).size > 1)
            addGroup("same-path", values[0].path, values);
        }
        for (const declaration of declarations) {
          await tick();
          const prefix = pdxPatchPathKey(declaration.value) + "/",
            items = [
              {
                file: declaration.file,
                line: declaration.line,
                role: "declaration",
              },
            ];
          for (const file of files) {
            await tick();
            if (
              file.mod.id !== declaration.file.mod.id &&
              file.key.startsWith(prefix)
            ) {
              items.push({ file, line: 1, role: "affected" });
              if (items.length > COVERAGE_LIMITS.groupEvidence) {
                notice("replace_path 匹配文件超过显示上限。");
                break;
              }
            }
          }
          addGroup("replace-path", declaration.value, items);
        }
        for (const [field, kind] of [
          ["events", "event-id"],
          ["focuses", "focus-id"],
        ])
          for (const [value, items] of definitions[field]) {
            await tick();
            if (new Set(items.map((item) => item.file.mod.id)).size > 1)
              addGroup(kind, value, items);
          }
        checkAbort(signal);
        for (const proof of observedAll) {
          await tick();
          await assertStat(proof.filename, proof.stat);
        }
        for (const proof of descriptorProofs) {
          await tick();
          await assertStat(proof.filename, proof.stat);
        }
        const current = await launcher.getState();
        checkAbort(signal);
        if (stamp(current) !== startStamp)
          throw failure("播放集或配置已变化，请重新检查覆盖证据。");
        if (discardedNotices)
          notices.add("另有检查未完成的项目，提示数量已达到上限。");
        report.notices = [...notices];
        report.counts.files = files.length;
        report.counts.groups = report.groups.length;
        latest = {
          report: clone(report),
          stamp: startStamp,
          evidence: evidenceMap,
          descriptorProofs,
        };
        return report;
      } finally {
        busy = false;
        controller = null;
        progress = { index: 0, total: 0 };
      }
    },
    readEvidence: async (reportId, evidenceId) => {
      const saved = latest;
      if (
        busy ||
        !saved ||
        saved.report.id !== reportId ||
        !saved.evidence.has(evidenceId)
      )
        throw failure("证据报告已失效，请重新检查。");
      const evidence = saved.evidence.get(evidenceId),
        file = evidence.file;
      const assertCurrent = async () => {
        if (
          latest !== saved ||
          stamp(await launcher.getState()) !== saved.stamp
        )
          throw failure("播放集或配置已变化，请重新检查覆盖证据。");
        await assertStat(file.absolutePath, file.stat);
        for (const proof of saved.descriptorProofs)
          await assertStat(proof.filename, proof.stat);
        if (latest !== saved || busy)
          throw failure("证据报告已失效，请重新检查。");
      };
      await assertCurrent();
      const base = {
        path: evidence.path,
        line: evidence.line,
        modName: evidence.modName,
        text: "",
        firstLine: Math.max(1, evidence.line - 6),
      };
      if (!file.textAvailable) {
        await assertCurrent();
        return { ...base, unavailable: true };
      }
      let raw;
      if (file.storage === "directory")
        raw = await readTextFile(file.absolutePath, null, file.stat);
      else {
        const zip = await yauzl.openPromise(file.absolutePath, {
          lazyEntries: true,
          autoClose: false,
          strictFileNames: true,
          validateEntrySizes: true,
        });
        zip.on("error", () => {});
        try {
          let count = 0;
          for await (const entry of zip.eachEntry()) {
            if (++count > COVERAGE_LIMITS.modEntries)
              throw failure("ZIP 证据超出读取上限。");
            const checked = zipEntry(entry);
            if (!checked.directory && checked.name === file.path) {
              if (entry.uncompressedSize > COVERAGE_LIMITS.textFileBytes)
                throw failure("ZIP 证据已变化，请重新检查。");
              raw = await zipBytes(zip, entry, null);
              break;
            }
          }
        } finally {
          zip.close();
        }
        if (!raw) throw failure("ZIP 证据文件已变化，请重新检查。");
        await assertStat(file.absolutePath, file.stat);
      }
      if (raw.hash !== file.hash)
        throw failure("证据文件内容已变化，请重新检查覆盖证据。");
      const text = decode(raw.buffer),
        lines = text.split(/\r\n|\n|\r/),
        firstLine = Math.max(1, evidence.line - 6),
        lastLine = Math.min(lines.length, evidence.line + 6),
        excerpt = lines.slice(firstLine - 1, lastLine).join("\n"),
        truncated = excerpt.length > 12000;
      await assertCurrent();
      return {
        ...base,
        firstLine,
        text: excerpt.slice(0, 12000),
        ...(truncated ? { truncated: true } : {}),
      };
    },
  };
}

module.exports = { createModCoverageService, COVERAGE_LIMITS };
