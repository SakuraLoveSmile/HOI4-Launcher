"use strict";
const { diagnostic, sequence } = require("./diagnostic-message.cjs");
const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { parseDescriptor } = require("./mod-authoring.cjs");
const sanitizeHtml = require("sanitize-html");
const ACTIVE = new Set([
  "queued",
  "creating",
  "packing",
  "uploading",
  "publishing",
]);
const clone = (value) => JSON.parse(JSON.stringify(value));
const within = (root, file) => {
  const r = path.relative(root, file);
  return r !== ".." && !r.startsWith(".." + path.sep) && !path.isAbsolute(r);
};
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const remoteId = (value) =>
  typeof value === "string" &&
  /^[1-9]\d{0,19}$/.test(value) &&
  BigInt(value) <= 18446744073709551615n;
const ignored = (name) =>
  [".git", ".svn", ".hg", ".DS_Store", "Thumbs.db"].includes(name) ||
  /\.ironclad-(?:backup|tmp|restore|edit\.lock)/.test(name);
function fields(input, provider = "steam") {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some(
      (key) =>
        ![
          "modId",
          "title",
          "description",
          "tags",
          "visibility",
          "changeNote",
          "existingItemId",
          "thumbnail",
          ...(provider === "pdx"
            ? ["shortDescription", "recommendedVersion"]
            : []),
        ].includes(key),
    )
  )
    throw new Error("发布内容格式无效。");
  const result = {};
  for (const [key, max] of [
    ["title", provider === "pdx" ? 60 : 128],
    ["description", provider === "pdx" ? 1000000 : 8000],
    ["changeNote", provider === "pdx" ? 5000 : 8000],
  ]) {
    const value = input[key] ?? "";
    if (
      typeof value !== "string" ||
      (provider === "pdx" ? value.trim().length : Buffer.byteLength(value)) >
        max ||
      /[\0-\x08\x0b\x0c\x0e-\x1f]/.test(value) ||
      (key === "title" && !value.trim())
    )
      throw new Error(
        `${key === "title" ? (provider === "pdx" ? "标题（3–60字符）" : "标题（最多128字节）") : "发布说明"}格式无效。`,
      );
    result[key] = value.trim();
  }
  if (
    !Array.isArray(input.tags) ||
    input.tags.length > 100 ||
    input.tags.some(
      (tag) =>
        typeof tag !== "string" ||
        !tag.trim() ||
        (provider === "pdx"
          ? tag.length > 256
          : Buffer.byteLength(tag) > 255) ||
        /[\0-\x1f]/.test(tag),
    )
  )
    throw new Error("发布标签无效。");
  if (provider === "steam" && ![0, 1, 2, 3].includes(input.visibility))
    throw new Error("请选择有效的发布可见性。");
  if (
    input.existingItemId !== null &&
    input.existingItemId !== undefined &&
    !remoteId(input.existingItemId)
  )
    throw new Error("发布目标编号无效。");
  if (typeof input.modId !== "string" || input.modId.length > 4096)
    throw new Error("模组标识无效。");
  if (provider === "pdx") {
    if (result.title.length < 3)
      throw new Error("Paradox 模组标题须为3至60个字符。");
    if (sanitizeHtml(result.description, { allowedTags: [] }).length < 10)
      throw new Error("Paradox 模组描述至少需要10个字符。");
    if (input.tags.length > 10)
      throw new Error("Paradox 发布最多支持10个标签。");
    if (
      typeof input.shortDescription !== "string" ||
      input.shortDescription.length > 10000 ||
      sanitizeHtml(input.shortDescription.trim(), { allowedTags: [] }).length <
        10 ||
      sanitizeHtml(input.shortDescription.trim(), { allowedTags: [] }).length >
        200 ||
      /[\0-\x08\x0b\x0c\x0e-\x1f]/.test(input.shortDescription)
    )
      throw new Error("Paradox 模组简介清除格式后须为10至200个字符。");
    if (
      typeof input.recommendedVersion !== "string" ||
      !/^[A-Za-z0-9.*_+-]{1,12}$/.test(input.recommendedVersion)
    )
      throw new Error("推荐游戏版本须为1至12个字符。");
    result.shortDescription = input.shortDescription.trim();
    result.recommendedVersion = input.recommendedVersion;
  }
  return {
    ...result,
    tags: [...new Set(input.tags.map((tag) => tag.trim()))],
    visibility: provider === "pdx" ? "provider-default" : input.visibility,
    existingItemId: input.existingItemId || null,
  };
}
async function inspectTree(root) {
  const entries = [],
    omitted = [];
  let total = 0;
  async function walk(directory, depth) {
    if (depth > 64) throw new Error("模组目录层级过深。");
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("发布内容不能包含目录联接或符号链接。");
    if (!within(root, await fs.realpath(directory)))
      throw new Error("发布路径越出了模组目录。");
    for (const entry of (
      await fs.readdir(directory, { withFileTypes: true })
    ).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name),
        relative = path.relative(root, file);
      if (ignored(entry.name)) {
        omitted.push(relative);
        continue;
      }
      const info = await fs.lstat(file);
      if (info.isSymbolicLink())
        throw new Error("发布内容不能包含链接：" + relative);
      if (info.isDirectory()) {
        await walk(file, depth + 1);
        continue;
      }
      if (!info.isFile() || info.nlink > 1)
        throw new Error("发布内容必须是普通文件，不能使用硬链接：" + relative);
      total += info.size;
      if (entries.length >= 100000 || total > 200 * 1024 ** 3)
        throw new Error("发布内容超过100000个文件或200GB，请拆分模组。");
      entries.push({
        relative,
        size: info.size,
        mtimeMs: info.mtimeMs,
        ino: info.ino,
        dev: info.dev,
      });
    }
  }
  await walk(root, 0);
  return { entries, omitted, total };
}
async function digestFile(file) {
  const handle = await fs.open(file, "r");
  try {
    const h = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      h.update(buffer.subarray(0, bytesRead));
    }
    return h.digest("hex");
  } finally {
    await handle.close();
  }
}
function createPublishService({
  storageDirectory,
  resolveMod,
  isGameRunning,
  steam,
  provider = "steam",
}) {
  if (!["steam", "pdx"].includes(provider))
    throw new Error("不支持的发布平台。");
  if (!path.isAbsolute(storageDirectory || ""))
    throw new Error("发布存储目录须为绝对路径。");
  const staging = path.join(storageDirectory, "staging"),
    historyPath = path.join(storageDirectory, "history.json");
  let plan = null,
    job = null,
    history = null,
    reservations = 0,
    refreshing = false,
    historyDirty = false,
    queue = Promise.resolve();
  const serial = (fn) => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => {});
    return next;
  };
  const mutation = (fn) => {
    reservations++;
    return serial(fn).finally(() => {
      reservations--;
    });
  };
  async function load() {
    if (history) return;
    try {
      const info = await fs.lstat(historyPath);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 ** 2)
        throw new Error();
      const parsed = JSON.parse(await fs.readFile(historyPath, "utf8"));
      if (
        parsed.version !== 1 ||
        !Array.isArray(parsed.bindings) ||
        parsed.bindings.some(
          (item) =>
            typeof item.descriptorPath !== "string" || !remoteId(item.itemId),
        )
      )
        throw new Error();
      history = parsed;
      job = parsed.lastJob || null;
      if (job && ACTIVE.has(job.status))
        job = {
          ...job,
          status: "interrupted",
          error:
            "上次上传未能确认完成，请先检查发布目标，再决定是否更新同一项目。",
          errorDiagnostic: diagnostic(
            "上次上传未能确认完成，请先检查发布目标，再决定是否更新同一项目。",
          ),
        };
    } catch (error) {
      if (error.code !== "ENOENT")
        throw new Error(
          "发布记录无法读取，请先检查启动器的 publishing/history.json，避免重复创建项目。",
        );
      history = { version: 1, bindings: [], lastJob: null };
    }
  }
  async function save() {
    historyDirty = true;
    await fs.mkdir(storageDirectory, { recursive: true });
    const s = await fs.lstat(storageDirectory);
    if (s.isSymbolicLink()) throw new Error("发布记录目录不能是链接。");
    const temp = historyPath + ".tmp-" + randomUUID();
    try {
      await fs.writeFile(temp, JSON.stringify(history, null, 2), {
        flag: "wx",
      });
      await fs.rename(temp, historyPath);
      historyDirty = false;
    } finally {
      await fs.unlink(temp).catch(() => {});
    }
  }
  async function assertIdle() {
    await load();
    if (refreshing) throw new Error("正在核对发布状态，请等待查询结束。");
    if (job && ACTIVE.has(job.status))
      throw new Error("正在发布模组，请等待上传结束。");
    if (await isGameRunning())
      throw new Error("请先退出游戏，再准备或发布模组。");
  }
  const review = () =>
    plan
      ? {
          id: plan.id,
          modId: plan.modId,
          modName: plan.modName,
          ...plan.fields,
          fileCount: plan.entries.length,
          totalBytes: plan.totalBytes,
          files: plan.entries.map(({ relative, size }) => ({
            path: relative.replace(/\\/g, "/"),
            size,
          })),
          omitted: plan.omitted,
          thumbnail: plan.thumbnail || null,
          provider,
          actor: plan.actor?.displayName || plan.actor?.accountId || null,
          createdAt: plan.createdAt,
        }
      : null;
  async function drop() {
    if (!plan) return;
    async function safe(file) {
      if (!within(plan.directory, file)) return false;
      const expected = path.join(
        plan.realDirectory,
        path.relative(plan.directory, file),
      );
      try {
        if ((await fs.realpath(file)).toLowerCase() !== expected.toLowerCase())
          return false;
        let current = path.dirname(file);
        while (within(plan.directory, current)) {
          const stat = await fs.lstat(current);
          if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
          if (current === plan.directory) break;
          current = path.dirname(current);
        }
        return true;
      } catch {
        return false;
      }
    }
    const directories = new Set([plan.contentPath, plan.directory]);
    for (const entry of [...plan.entries].reverse()) {
      const file = path.join(plan.contentPath, entry.relative);
      if (!within(staging, file) || !(await safe(file))) continue;
      try {
        const s = await fs.lstat(file);
        if (
          s.isFile() &&
          !s.isSymbolicLink() &&
          s.nlink === 1 &&
          s.ino === entry.targetIno &&
          s.dev === entry.targetDev &&
          (await digestFile(file)) === entry.hash
        ) {
          if (await safe(file)) {
            const current = await fs.lstat(file);
            if (
              current.isFile() &&
              !current.isSymbolicLink() &&
              current.nlink === 1 &&
              current.ino === entry.targetIno &&
              current.dev === entry.targetDev
            )
              await fs.unlink(file);
          }
        }
      } catch {}
      let d = path.dirname(file);
      while (within(plan.contentPath, d)) {
        directories.add(d);
        if (d === plan.contentPath) break;
        d = path.dirname(d);
      }
    }
    for (const directory of [...directories].sort(
      (a, b) => b.length - a.length,
    ))
      if (await safe(directory)) await fs.rmdir(directory).catch(() => {});
    plan = null;
  }
  async function record(next) {
    await load();
    const context = plan || history.lastJob;
    if (!context || next?.id !== context.id) return job ? clone(job) : null;
    job = clone(next);
    if (next.itemId && remoteId(next.itemId)) {
      const index = history.bindings.findIndex(
        (item) =>
          item.descriptorPath.toLowerCase() ===
          context.descriptorPath.toLowerCase(),
      );
      const binding = {
        descriptorPath: context.descriptorPath,
        itemId: next.itemId,
        updatedAt: new Date().toISOString(),
      };
      if (index < 0) history.bindings.push(binding);
      else history.bindings[index] = binding;
    }
    const changed =
      history.lastJob?.status !== job.status ||
      history.lastJob?.itemId !== job.itemId ||
      history.lastJob?.publicationName !== job.publicationName ||
      history.lastJob?.accountId !== job.accountId ||
      history.lastJob?.commitSent !== job.commitSent ||
      history.lastJob?.baseRevision !== job.baseRevision ||
      history.lastJob?.visibility !== job.visibility ||
      history.lastJob?.error !== job.error ||
      JSON.stringify(history.lastJob?.errorDiagnostic) !==
        JSON.stringify(job.errorDiagnostic) ||
      history.lastJob?.needsAgreement !== job.needsAgreement ||
      history.lastJob?.id !== job.id;
    history.lastJob = {
      ...job,
      modName: context.modName,
      descriptorPath: context.descriptorPath,
    };
    if (changed || historyDirty)
      try {
        await save();
      } catch {
        job.errorDiagnostic = sequence([
          ...(job.error
            ? [job.errorDiagnostic ?? { kind: "literal", text: job.error }, " "]
            : []),
          diagnostic(
            "无法保存发布记录，请记下目标编号，并在来源页确认结果后再操作。",
          ),
        ]);
        job.error =
          (job.error ? job.error + " " : "") +
          "无法保存发布记录，请记下目标编号，并在来源页确认结果后再操作。";
        if (provider === "pdx") throw new Error(job.error);
      }
    return clone(job);
  }
  return {
    getDraft: (modId) =>
      serial(async () => {
        await load();
        const metadata = await resolveMod(modId);
        const binding = history.bindings.find(
          (item) =>
            item.descriptorPath.toLowerCase() ===
            metadata.descriptorPath.toLowerCase(),
        );
        return {
          metadata,
          existingItemId:
            binding?.itemId ||
            (provider === "steam" ? metadata.remoteFileId : null) ||
            null,
          lastJob:
            job &&
            history.lastJob?.descriptorPath?.toLowerCase() ===
              metadata.descriptorPath.toLowerCase()
              ? clone(job)
              : null,
        };
      }),
    prepare: (input) =>
      mutation(async () => {
        await assertIdle();
        const selected = fields(input, provider);
        if (provider === "pdx" && !selected.existingItemId && !input.thumbnail)
          throw new Error(
            "Paradox 新建模组需要缩略图，请填写模组目录内的图片路径。",
          );
        if (
          provider === "pdx" &&
          job?.commitSent &&
          !job.itemId &&
          ["pending", "interrupted"].includes(job.status)
        )
          throw new Error(
            "上次发布结果尚未确认，请先检查发布状态，避免重复创建项目。",
          );
        const metadata = await resolveMod(input.modId);
        let actor;
        if (selected.existingItemId)
          actor = await steam.call(
            "validatePublishTarget",
            selected.existingItemId,
          );
        else {
          actor = await steam.call("getState");
          if (!actor.connected)
            throw new Error(
              provider === "pdx"
                ? "请先在设置页登录 Paradox 账号，再准备发布。"
                : "请先连接 Steam，再准备发布。",
            );
        }
        if (
          provider === "pdx" &&
          (typeof actor?.accountId !== "string" || !actor.accountId)
        )
          throw new Error("无法确认 Paradox 发布账号，请重新登录。");
        const source = metadata.contentPath;
        const tree = await inspectTree(source);
        if (
          !tree.entries.some(
            (item) => item.relative.toLowerCase() === "descriptor.mod",
          )
        )
          throw new Error(
            "模组目录缺少 descriptor.mod，请先保存本地模组资料。",
          );
        let thumbnail = null;
        if (input.thumbnail) {
          if (
            typeof input.thumbnail !== "string" ||
            /[\0-\x1f:]/.test(input.thumbnail) ||
            path.isAbsolute(input.thumbnail) ||
            !within(source, path.resolve(source, input.thumbnail))
          )
            throw new Error("预览图须为模组目录内的相对路径。");
          thumbnail = path.normalize(input.thumbnail);
          const item = tree.entries.find(
            (entry) => entry.relative.toLowerCase() === thumbnail.toLowerCase(),
          );
          if (
            !item ||
            item.size > (provider === "pdx" ? 1000000 : 1024 ** 2) ||
            !/[.](png|jpe?g)$/i.test(thumbnail)
          )
            throw new Error(
              provider === "pdx"
                ? "Paradox 预览图须为模组目录内不超过1,000,000字节的PNG/JPEG文件。"
                : "预览图须为模组目录内不超过1MiB的PNG/JPEG文件。",
            );
          thumbnail = item.relative;
        }
        await drop();
        await fs.mkdir(staging, { recursive: true });
        if ((await fs.lstat(staging)).isSymbolicLink())
          throw new Error("发布暂存目录不能是链接。");
        const id = randomUUID(),
          directory = path.join(staging, id),
          contentPath = path.join(directory, "content");
        await fs.mkdir(directory);
        await fs.mkdir(contentPath);
        plan = {
          realDirectory: await fs.realpath(directory),
          id,
          modId: input.modId,
          modName: metadata.name,
          descriptorPath: metadata.descriptorPath,
          directory,
          contentPath,
          fields: selected,
          actor,
          entries: [],
          omitted: tree.omitted,
          totalBytes: tree.total,
          thumbnail,
          createdAt: new Date().toISOString(),
          committed: false,
        };
        try {
          for (const entry of tree.entries) {
            const sourceFile = path.join(source, entry.relative),
              target = path.join(contentPath, entry.relative);
            if (!within(source, await fs.realpath(sourceFile)))
              throw new Error("准备期间模组路径发生变化，请重新检查。");
            const from = await fs.open(sourceFile, "r");
            let to, copied, digest;
            try {
              const info = await from.stat();
              if (
                info.ino !== entry.ino ||
                info.dev !== entry.dev ||
                info.size !== entry.size ||
                info.mtimeMs !== entry.mtimeMs ||
                info.nlink > 1
              )
                throw new Error("准备期间模组文件发生变化，请重试。");
              await fs.mkdir(path.dirname(target), { recursive: true });
              to = await fs.open(target, "wx");
              const targetInfo = await to.stat();
              digest = createHash("sha256");
              copied = {
                ...entry,
                size: 0,
                hash: hash(Buffer.alloc(0)),
                targetIno: targetInfo.ino,
                targetDev: targetInfo.dev,
              };
              plan.entries.push(copied);
              const buffer = Buffer.allocUnsafe(1024 * 1024);
              while (true) {
                const { bytesRead } = await from.read(
                  buffer,
                  0,
                  buffer.length,
                  null,
                );
                if (!bytesRead) break;
                let offset = 0;
                while (offset < bytesRead) {
                  const { bytesWritten } = await to.write(
                    buffer,
                    offset,
                    bytesRead - offset,
                    null,
                  );
                  if (!bytesWritten) throw new Error("无法完成发布快照写入。");
                  digest.update(buffer.subarray(offset, offset + bytesWritten));
                  offset += bytesWritten;
                  copied.size += bytesWritten;
                }
              }
              const after = await from.stat();
              if (after.size !== info.size || after.mtimeMs !== info.mtimeMs)
                throw new Error("复制期间模组文件发生变化，请重新准备。");
              if (copied.size !== entry.size)
                throw new Error("复制期间文件大小发生变化。");
            } finally {
              if (copied) copied.hash = digest.digest("hex");
              await from.close();
              await to?.close();
            }
          }
          if (provider === "pdx") {
            const entry = plan.entries.find(
              (item) => item.relative.toLowerCase() === "descriptor.mod",
            );
            const target = path.join(plan.contentPath, entry.relative);
            if (entry.size > 1024 ** 2)
              throw new Error("descriptor.mod 超过1MiB，无法准备发布。");
            const descriptor = await fs.open(target, "r+");
            try {
              const info = await descriptor.stat(),
                link = await fs.lstat(target);
              if (
                info.ino !== entry.targetIno ||
                info.dev !== entry.targetDev ||
                info.nlink !== 1 ||
                link.isSymbolicLink() ||
                info.size !== entry.size ||
                (await fs.realpath(target)).toLowerCase() !==
                  path
                    .join(plan.realDirectory, "content", entry.relative)
                    .toLowerCase()
              )
                throw new Error("发布快照在准备期间发生变化。");
              let text = (await descriptor.readFile("utf8")).replace(
                /^\uFEFF/,
                "",
              );
              const matches = parseDescriptor(text).filter(
                (item) => item.key === "supported_version",
              );
              for (const item of matches.reverse())
                text = text.slice(0, item.start) + text.slice(item.end);
              text += `\nsupported_version="${selected.recommendedVersion}"\n`;
              const bytes = Buffer.from(text);
              let offset = 0;
              while (offset < bytes.length) {
                const result = await descriptor.write(
                  bytes,
                  offset,
                  bytes.length - offset,
                  offset,
                );
                if (!result.bytesWritten) throw new Error("无法更新发布快照。");
                offset += result.bytesWritten;
              }
              await descriptor.truncate(bytes.length);
              entry.size = bytes.length;
              entry.hash = hash(bytes);
            } finally {
              await descriptor.close();
            }
            plan.totalBytes = plan.entries.reduce(
              (sum, item) => sum + item.size,
              0,
            );
          }
          return review();
        } catch (error) {
          await drop();
          throw error;
        }
      }),
    cancel: () =>
      mutation(async () => {
        await assertIdle();
        await drop();
        return true;
      }),
    commit: (id) =>
      mutation(async () => {
        await assertIdle();
        if (!plan || plan.id !== id || plan.committed)
          throw new Error("发布准备已失效或已提交，请重新准备。");
        const actual = await inspectTree(plan.contentPath);
        if (
          actual.omitted.length ||
          actual.entries.length !== plan.entries.length
        )
          throw new Error("发布快照被修改，请重新准备。");
        for (const entry of plan.entries) {
          if (
            !actual.entries.some(
              (item) =>
                item.relative === entry.relative && item.size === entry.size,
            ) ||
            (await digestFile(path.join(plan.contentPath, entry.relative))) !==
              entry.hash
          )
            throw new Error("发布快照被修改，请重新准备。");
        }
        if (
          (await fs.realpath(plan.directory)).toLowerCase() !==
          plan.realDirectory.toLowerCase()
        )
          throw new Error("发布快照路径发生变化，请重新准备。");
        const finalTree = await inspectTree(plan.contentPath);
        if (
          finalTree.omitted.length ||
          finalTree.entries.length !== plan.entries.length ||
          finalTree.entries.some(
            (file) =>
              !plan.entries.some(
                (entry) =>
                  entry.relative === file.relative &&
                  entry.targetIno === file.ino &&
                  entry.targetDev === file.dev &&
                  entry.size === file.size,
              ),
          )
        )
          throw new Error("发布快照在核验期间发生变化，请重新准备。");
        if (await isGameRunning())
          throw new Error("游戏已开始运行，请退出后重新确认发布。");
        plan.committed = true;
        job = {
          id: plan.id,
          status: "queued",
          itemId: plan.fields.existingItemId,
          progress: null,
          needsAgreement: false,
          error: null,
        };
        history.lastJob = {
          ...job,
          modName: plan.modName,
          descriptorPath: plan.descriptorPath,
        };
        try {
          await save();
        } catch {
          plan.committed = false;
          job = {
            ...job,
            status: "failed",
            error: "无法保存发布记录，尚未提交上传。",
          };
          throw new Error(job.error);
        }
        try {
          const started = await steam.call("startPublish", {
            id: plan.id,
            ...plan.fields,
            contentPath: plan.contentPath,
            previewPath: plan.thumbnail
              ? path.join(plan.contentPath, plan.thumbnail)
              : undefined,
            ...(provider === "pdx"
              ? {
                  actorId: plan.actor.accountId,
                  files: plan.entries.map((entry) => ({ ...entry })),
                }
              : {}),
          });
          await record(started);
          return clone(job);
        } catch {
          job = {
            ...job,
            status: "interrupted",
            error: "提交结果未能确认，请先检查发布目标；不要直接重新创建项目。",
          };
          history.lastJob = {
            ...job,
            modName: plan.modName,
            descriptorPath: plan.descriptorPath,
          };
          await save();
          return clone(job);
        }
      }),
    recordStatus: (next) => serial(() => record(next)),
    getStatus: () =>
      serial(async () => {
        await load();
        if (provider === "pdx" && job && ACTIVE.has(job.status)) {
          const current = await steam.call("getPublishStatus");
          if (current?.id === job.id) return record(current);
        }
        return job ? clone(job) : null;
      }),
    refreshStatus: async () => {
      if (refreshing) throw new Error("正在核对发布状态，请等待查询结束。");
      refreshing = true;
      reservations++;
      try {
        const stored = await serial(async () => {
          await load();
          if (provider !== "pdx" || !job)
            throw new Error("没有可核对的 Paradox 发布记录。");
          if (ACTIVE.has(job.status))
            throw new Error("正在发布模组，请等待上传结束。");
          return clone(job);
        });
        // Provider status callbacks must be able to enter recordStatus's queue
        // while this read-only recovery is running.
        const next = await steam.call("refreshPublish", stored);
        return await serial(() => record(next));
      } finally {
        refreshing = false;
        reservations--;
      }
    },
    isPublishing: () =>
      reservations > 0 || Boolean(job && ACTIVE.has(job.status)),
  };
}
module.exports = { createPublishService };
