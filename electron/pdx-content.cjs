"use strict";

const path = require("node:path");
const { version } = require("../package.json");
const { createPdxTransfer } = require("./pdx-transfer.cjs");
const { createPdxRepository, fileResource } = require("./pdx-repository.cjs");
const { createPdxIntegrity } = require("./pdx-integrity.cjs");
const { parsePdxManifest } = require("./pdx-manifest.cjs");

const API = "https://api.paradox-interactive.com";
const CDN = "https://modscontent.paradox-interactive.com";
const MAX_METADATA = 2 * 1024 * 1024;
const MAX_MANIFEST = 64 * 1024;
const REVOCATION_ORIGIN = "https://revocation-prod.paradox-interactive.com";
const INTEGRITY_CODES = new Set([
  "SIGNATURE_INVALID",
  "SIGNATURE_UNAVAILABLE",
  "KEY_REVOKED",
  "INVALID_METADATA",
]);
const MESSAGES = {
  INVALID_INPUT: "Paradox 下载参数无效。",
  INVALID_METADATA: "Paradox 返回的模组信息无效或与请求版本不符。",
  INVALID_MANIFEST: "模组下载清单格式不受支持。",
  SIGNATURE_INVALID: "Paradox 内容签名验证失败，已停止下载。",
  SIGNATURE_UNAVAILABLE: "无法核对 Paradox 签名撤销状态，请检查网络后重试。",
  KEY_REVOKED: "Paradox 内容签署密钥已撤销，已停止下载。",
  INVALID_PLAN: "模组下载计划无效，请重新获取模组信息。",
  ACCESS_DENIED: "该模组或版本需要账号授权，当前匿名下载无法访问。",
  NOT_PUBLIC: "当前下载器仅支持公开的 Paradox 模组。",
  UNAVAILABLE: "该模组尚未发布、正在更新或不支持 Windows HOI4。",
  REGION_BLOCKED: "该模组在当前地区不可下载。",
  NOT_FOUND: "该模组版本或下载文件已不存在，请刷新后重试。",
  RATE_LIMITED: "Paradox 请求过于频繁，请稍后重试。",
  RESPONSE_TOO_LARGE: "模组信息或下载文件超过允许大小。",
  REDIRECT_NOT_ALLOWED: "模组服务返回了不允许的重定向。",
  NETWORK_ERROR: "无法读取 Paradox 模组内容，请检查网络后重试。",
  TIMEOUT: "Paradox 模组下载超时，请重试或调整下载限速。",
  CANCELLED: "模组下载已取消。",
  SIZE_MISMATCH: "下载文件大小与清单不符，请重新下载。",
  HASH_MISMATCH: "下载文件校验失败，请重新下载。",
  DESTINATION_EXISTS: "下载目标已存在，请使用新的临时文件。",
  DESTINATION_CHANGED: "下载目标已被其他操作替换，已停止下载。",
  FILE_ERROR: "无法写入模组下载文件，请检查磁盘空间和目录权限。",
  NOT_SIGNED_IN: "请先登录 Paradox 账号，再获取此版本。",
  SESSION_EXPIRED: "Paradox 登录已过期，请重新登录后重试。",
  ACCOUNT_CHANGED: "Paradox 登录会话已变化，请重新确认账号后重试。",
  SERVICE_ERROR: "Paradox 账号服务暂时不可用，请稍后重试。",
  INVALID_RESPONSE: "Paradox 账号服务返回了无法识别的数据，请稍后重试。",
  REQUEST_FAILED: "Paradox 账号请求未成功，请稍后重试。",
  STORAGE_ERROR: "无法清除本机登录信息，请检查启动器数据目录权限。",
  PAUSED: "模组下载已暂停。",
  CHECKPOINT_ERROR: "无法保存下载进度，下载已停止，请检查启动器数据目录。",
  INVALID_CHECKPOINT: "下载进度与当前文件或模组版本不符，请重新下载。",
  SOURCE_CHANGED: "续传源文件或所在目录已变化，请重新下载。",
  RANGE_MISMATCH: "服务器返回的续传范围不符，请重新下载。",
  RANGE_NOT_SATISFIABLE: "服务器无法继续此下载片段，请重新下载。",
  ETAG_MISMATCH: "服务器上的下载文件已变化，请重新下载。",
  ENCODING_NOT_ALLOWED: "服务器返回了不支持的压缩传输内容，请重新下载。",
};
const ACCOUNT_CODES = new Set([
  "NOT_SIGNED_IN",
  "SESSION_EXPIRED",
  "ACCOUNT_CHANGED",
  "ACCESS_DENIED",
  "CANCELLED",
  "TIMEOUT",
  "RATE_LIMITED",
  "NETWORK_ERROR",
  "SERVICE_ERROR",
  "INVALID_RESPONSE",
  "REQUEST_FAILED",
  "STORAGE_ERROR",
]);
const SAFE_ERROR = Symbol("pdx-content-error");

function failure(code, message = MESSAGES[code]) {
  const error = new Error(message);
  error.code = code;
  error[SAFE_ERROR] = true;
  return error;
}

function decimal(value, code = "INVALID_INPUT") {
  if (typeof value === "number" && Number.isSafeInteger(value))
    value = String(value);
  if (
    typeof value !== "string" ||
    !/^[1-9]\d{0,15}$/.test(value) ||
    !Number.isSafeInteger(Number(value))
  )
    throw failure(code);
  return value;
}

function segment(value, code) {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)
  )
    throw failure(code);
  return value;
}

function platformValue(value, code) {
  if (typeof value !== "string") throw failure(code);
  const parts = value.split("__");
  if (parts.length !== 2 || !["Any", "Windows"].includes(parts[0]))
    throw failure(code);
  segment(parts[1], code);
  return value;
}

function archiveName(value, code) {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,195}\.zip$/.test(value) ||
    value.includes("..") ||
    /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(value)
  )
    throw failure(code);
  return value;
}

function archiveRoot(name, platform, revision) {
  return `${CDN}/hoi4/${name}/repo/${platform}/${revision}/complete/`;
}

function boundedSize(value, maximum, code, zero = false) {
  if (!Number.isSafeInteger(value) || value < (zero ? 0 : 1) || value > maximum)
    throw failure(code);
  return value;
}

function operation(externalSignal, timeoutMs, pauseSignal) {
  if (
    (externalSignal !== undefined &&
      !(externalSignal instanceof AbortSignal)) ||
    (pauseSignal !== undefined && !(pauseSignal instanceof AbortSignal))
  )
    throw failure("INVALID_INPUT");
  const controller = new AbortController();
  let reason = "CANCELLED";
  const abort = () => controller.abort();
  const pause = () => {
    if (controller.signal.aborted) return;
    reason = "PAUSED";
    controller.abort();
  };
  const timer = setTimeout(() => {
    if (controller.signal.aborted) return;
    reason = "TIMEOUT";
    controller.abort();
  }, timeoutMs);
  if (externalSignal?.aborted) abort();
  else externalSignal?.addEventListener("abort", abort, { once: true });
  if (pauseSignal?.aborted) pause();
  else pauseSignal?.addEventListener("abort", pause, { once: true });
  const check = () => {
    if (externalSignal?.aborted) throw failure("CANCELLED");
    if (controller.signal.aborted) throw failure(reason);
  };
  return {
    signal: controller.signal,
    check,
    async wait(promise) {
      // A caller may have started an operation just as its signal was aborted.
      if (controller.signal.aborted) Promise.resolve(promise).catch(() => {});
      check();
      return new Promise((resolve, reject) => {
        const cancelled = () =>
          reject(failure(externalSignal?.aborted ? "CANCELLED" : reason));
        controller.signal.addEventListener("abort", cancelled, { once: true });
        Promise.resolve(promise)
          .then(resolve, reject)
          .finally(() => {
            controller.signal.removeEventListener("abort", cancelled);
          });
      });
    },
    async delay(milliseconds) {
      check();
      let delayTimer;
      try {
        await this.wait(
          new Promise((resolve) => {
            delayTimer = setTimeout(resolve, Math.min(milliseconds, 1000));
          }),
        );
      } finally {
        clearTimeout(delayTimer);
      }
    },
    dispose() {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", abort);
      pauseSignal?.removeEventListener("abort", pause);
    },
  };
}

function cancelBody(response) {
  try {
    Promise.resolve(response?.body?.cancel()).catch(() => {});
  } catch {
    /* A reader may already own this body. */
  }
}

function responseUrl(value, expectedOrigin) {
  try {
    const url = new URL(value);
    if (
      url.origin !== expectedOrigin ||
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hash
    )
      throw new Error();
    return url;
  } catch {
    throw failure("REDIRECT_NOT_ALLOWED");
  }
}

async function* chunks(response, context) {
  if (!response.body || typeof response.body.getReader !== "function")
    throw failure("NETWORK_ERROR");
  const reader = response.body.getReader();
  let complete = false;
  try {
    while (true) {
      context.check();
      const { done, value } = await context.wait(reader.read());
      context.check();
      if (done) {
        complete = true;
        return;
      }
      if (!(value instanceof Uint8Array)) throw failure("NETWORK_ERROR");
      if (value.byteLength)
        yield Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    }
  } finally {
    if (!complete) {
      try {
        Promise.resolve(reader.cancel()).catch(() => {});
      } catch {
        /* best effort */
      }
    }
    try {
      reader.releaseLock();
    } catch {
      /* Cancellation can leave a pending read. */
    }
  }
}

function contentLength(response) {
  const value = response.headers.get("content-length");
  if (value === null) return null;
  if (
    !/^(?:0|[1-9]\d{0,15})$/.test(value) ||
    !Number.isSafeInteger(Number(value))
  )
    throw failure("SIZE_MISMATCH");
  return Number(value);
}

async function readBytes(response, limit, context) {
  const buffers = [];
  let length = 0;
  try {
    if (contentLength(response) > limit) throw failure("RESPONSE_TOO_LARGE");
    for await (const chunk of chunks(response, context)) {
      length += chunk.length;
      if (length > limit) throw failure("RESPONSE_TOO_LARGE");
      buffers.push(chunk);
    }
    return Buffer.concat(buffers);
  } finally {
    cancelBody(response);
  }
}

function decodeText(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw failure("INVALID_METADATA");
  }
}
async function readText(response, limit, context) {
  return decodeText(await readBytes(response, limit, context));
}

function parseManifest(text, platform, maxArchiveBytes, expectedFilename) {
  let parsed;
  try {
    parsed = parsePdxManifest(text, {
      expectedName: platform,
      maxBytes: MAX_MANIFEST,
      maxFileBytes: 20 * 1024 ** 3,
      maxTotalBytes: 20 * 1024 ** 3,
    });
  } catch (error) {
    throw failure(
      error?.code === "RESPONSE_TOO_LARGE" ? error.code : "INVALID_MANIFEST",
    );
  }
  if (parsed.entries.length !== 1) throw failure("INVALID_MANIFEST");
  const entry = parsed.entries[0];
  if (entry.type !== "file" || entry.compression !== "zip")
    throw failure("INVALID_MANIFEST");
  const filename =
    expectedFilename === undefined
      ? archiveName(entry.path, "INVALID_MANIFEST")
      : entry.path;
  if (expectedFilename !== undefined && filename !== expectedFilename)
    throw failure("INVALID_MANIFEST");
  const bytes = boundedSize(entry.bytes, maxArchiveBytes, "RESPONSE_TOO_LARGE");
  return {
    filename,
    bytes,
    sha256: entry.sha256,
    ...(expectedFilename === undefined
      ? {}
      : {
          unpackedBytes: boundedSize(
            entry.unpackedBytes,
            maxArchiveBytes + MAX_MANIFEST,
            "RESPONSE_TOO_LARGE",
            true,
          ),
        }),
  };
}

function createPdxContentService({
  account,
  fetchImpl = globalThis.fetch,
  timeoutMs = 30 * 60 * 1000,
  maxArchiveBytes = 5 * 1024 * 1024 * 1024,
  now = Date.now,
  integrity = createPdxIntegrity({ now }),
} = {}) {
  if (
    typeof fetchImpl !== "function" ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 2147483647 ||
    (account !== undefined && typeof account?.request !== "function") ||
    typeof integrity?.getManifest !== "function"
  )
    throw failure("INVALID_INPUT");
  boundedSize(maxArchiveBytes, Number.MAX_SAFE_INTEGER, "INVALID_INPUT");
  // These capabilities are deliberately absent from serializable plans,
  // checkpoints and IPC state. A resumed task resolves and authorizes anew.
  const capabilities = new WeakMap();

  async function repositoryUrl(
    repository,
    revision,
    filename,
    context,
    fromRevision,
  ) {
    try {
      return await context.wait(
        repository.urlFor(
          fromRevision === undefined
            ? { revision, filename, signal: context.signal }
            : {
                patch: { revision, fromRevision, filename },
                signal: context.signal,
              },
        ),
      );
    } catch (error) {
      context.check();
      throw failure(
        ACCOUNT_CODES.has(error?.code) ? error.code : "INVALID_RESPONSE",
      );
    }
  }

  async function request(
    url,
    context,
    accept,
    { headers = {}, statuses = [200], content = false } = {},
  ) {
    context.check();
    const origin = new URL(url).origin;
    let response;
    try {
      // Refuse every redirect: the proven endpoints need none. No ambient cookies or API token.
      const pending = Promise.resolve(
        fetchImpl(url, {
          method: "GET",
          redirect: "manual",
          credentials: "omit",
          headers: {
            Accept: accept,
            "User-Agent": `IRONCLAD/${version}`,
            ...headers,
          },
          signal: context.signal,
        }),
      ).then((result) => {
        if (context.signal.aborted) cancelBody(result);
        return result;
      });
      response = await context.wait(pending);
      context.check();
      if (
        !response ||
        !Number.isInteger(response.status) ||
        typeof response.headers?.get !== "function"
      )
        throw failure("NETWORK_ERROR");
      if (
        response.redirected ||
        (response.status >= 300 && response.status < 400)
      )
        throw failure("REDIRECT_NOT_ALLOWED");
      if (response.url) responseUrl(response.url, origin);
      if (response.status === 401 || response.status === 403)
        throw failure(
          "ACCESS_DENIED",
          content || origin === CDN
            ? "该版本的下载文件无权访问，请稍后重试或联系模组作者。"
            : MESSAGES.ACCESS_DENIED,
        );
      if (response.status === 404 && !statuses.includes(404))
        throw failure("NOT_FOUND");
      if (response.status === 429) throw failure("RATE_LIMITED");
      if (!statuses.includes(response.status)) throw failure("NETWORK_ERROR");
      return response;
    } catch (error) {
      cancelBody(response);
      context.check();
      if (error?.[SAFE_ERROR]) throw error;
      throw failure("NETWORK_ERROR");
    }
  }

  async function signedManifest({
    revision,
    fromRevision,
    repository,
    repositoryRoot,
    context,
  }) {
    const folder =
      fromRevision === undefined
        ? "complete"
        : `${fromRevision}_to_${revision}`;
    try {
      return await context.wait(
        integrity.getManifest({
          revision,
          ...(fromRevision === undefined ? {} : { fromRevision }),
          loadResource: async (resource, limit) => {
            const rootResource = [
              "repository.json",
              "repository.json.asc",
              "_keys/public.gpg",
            ].includes(resource);
            if (
              !rootResource &&
              resource !== `${revision}/${folder}/manifest` &&
              resource !== `${revision}/${folder}/manifest.asc`
            )
              throw failure("INVALID_INPUT");
            if (
              !Number.isSafeInteger(limit) ||
              limit < 1 ||
              limit > MAX_METADATA
            )
              throw failure("INVALID_INPUT");
            let url = `${repositoryRoot}${resource}`;
            if (repository) {
              if (rootResource) {
                try {
                  url = await context.wait(
                    repository.urlFor({ resource, signal: context.signal }),
                  );
                } catch (error) {
                  context.check();
                  throw failure(
                    ACCOUNT_CODES.has(error?.code)
                      ? error.code
                      : "INVALID_RESPONSE",
                  );
                }
              } else
                url = await repositoryUrl(
                  repository,
                  revision,
                  resource.split("/").at(-1),
                  context,
                  fromRevision,
                );
            }
            return readBytes(
              await request(url, context, "application/octet-stream", {
                content: true,
              }),
              limit,
              context,
            );
          },
          lookupRevocation: async (fingerprint) => {
            if (
              typeof fingerprint !== "string" ||
              !/^[0-9a-f]{40}$/i.test(fingerprint)
            )
              throw failure("SIGNATURE_INVALID");
            const response = await request(
              `${REVOCATION_ORIGIN}/${fingerprint.toUpperCase()}.asc`,
              context,
              "application/octet-stream",
              { content: true, statuses: [200, 204, 404] },
            );
            if (response.status === 204 || response.status === 404) {
              cancelBody(response);
              return { status: response.status, bytes: Buffer.alloc(0) };
            }
            return {
              status: response.status,
              bytes: await readBytes(response, MAX_MANIFEST, context),
            };
          },
        }),
      );
    } catch (error) {
      context.check();
      if (error?.[SAFE_ERROR]) throw error;
      if (INTEGRITY_CODES.has(error?.code)) throw failure(error.code);
      throw failure("SIGNATURE_INVALID");
    }
  }

  async function resolve({
    modId,
    revision,
    expectedAccountId,
    repair = false,
    signal,
  } = {}) {
    modId = decimal(modId);
    if (revision !== undefined) revision = decimal(revision);
    if (typeof repair !== "boolean") throw failure("INVALID_INPUT");
    if (
      expectedAccountId !== undefined &&
      (typeof expectedAccountId !== "string" ||
        !expectedAccountId ||
        expectedAccountId.length > 200 ||
        /[\0-\x1f\x7f]/.test(expectedAccountId))
    )
      throw failure("INVALID_INPUT");
    const context = operation(signal, timeoutMs);
    try {
      let metadata;
      if (expectedAccountId !== undefined) {
        if (!account) throw failure("NOT_SIGNED_IN");
        context.check();
        try {
          metadata = await context.wait(
            account.request({
              method: "GET",
              path: "/mods",
              query: {
                modId,
                ...(revision !== undefined ? { modVersion: revision } : {}),
              },
              expectedAccountId,
              signal: context.signal,
            }),
          );
          context.check();
        } catch (error) {
          context.check();
          const code = ACCOUNT_CODES.has(error?.code)
            ? error.code
            : "NETWORK_ERROR";
          throw failure(
            code,
            code === "ACCESS_DENIED"
              ? "当前 Paradox 账号没有读取该模组版本的权限。"
              : MESSAGES[code],
          );
        }
      } else {
        const query = new URLSearchParams({ modId });
        if (revision !== undefined) query.set("modVersion", revision);
        const response = await request(
          `${API}/mods?${query}`,
          context,
          "application/json",
        );
        try {
          metadata = JSON.parse(
            await readText(response, MAX_METADATA, context),
          );
        } catch (error) {
          if (error?.[SAFE_ERROR]) throw error;
          throw failure("INVALID_METADATA");
        }
      }
      const detail = metadata?.modDetail;
      if (
        metadata?.result !== "OK" ||
        !detail ||
        decimal(detail.modId, "INVALID_METADATA") !== modId ||
        detail.game !== "hoi4"
      )
        throw failure("INVALID_METADATA");
      if (!["public", "unlisted", "private", "hidden"].includes(detail.acl))
        throw failure("INVALID_METADATA");
      if (
        ["private", "hidden"].includes(detail.acl) &&
        expectedAccountId === undefined
      )
        throw failure("ACCESS_DENIED");
      if (detail.isRegionBlocked !== false) throw failure("REGION_BLOCKED");
      if (
        detail.state !== "published" ||
        detail.updating !== false ||
        !["Any", "Windows"].includes(detail.os) ||
        detail.actions?.canDownload === false
      )
        throw failure("UNAVAILABLE");
      const actualRevision = decimal(detail.modVersion, "INVALID_METADATA");
      if (revision !== undefined && revision !== actualRevision)
        throw failure("INVALID_METADATA");
      const name = segment(detail.name, "INVALID_METADATA");
      const platform = platformValue(
        `${detail.os}__${segment(detail.arch, "INVALID_METADATA")}`,
        "INVALID_METADATA",
      );
      if (
        typeof detail.displayName !== "string" ||
        !detail.displayName.trim() ||
        detail.displayName.length > 1000
      )
        throw failure("INVALID_METADATA");
      const title = detail.displayName
        .replace(/[\0-\x1f\x7f]/g, " ")
        .trim()
        .slice(0, 200);
      if (!title) throw failure("INVALID_METADATA");
      const root = archiveRoot(name, platform, actualRevision);
      let repository;
      if (detail.acl !== "public" && expectedAccountId !== undefined) {
        const repositoryPath = `mods/hoi4/${name}/repo/${platform}`;
        if (detail.repositoryPath !== repositoryPath)
          throw failure("INVALID_METADATA");
        repository = createPdxRepository({
          account,
          expectedAccountId,
          repositoryPath,
          now,
        });
      }
      const repositoryRoot = `${CDN}/hoi4/${name}/repo/${platform}/`;
      const signed = await signedManifest({
        revision: actualRevision,
        repository,
        repositoryRoot,
        context,
      });
      const parsed = parseManifest(
        decodeText(signed.manifest),
        platform,
        maxArchiveBytes,
      );
      if (
        signed.completeSize !== undefined &&
        signed.completeSize !== parsed.bytes
      )
        throw failure("INVALID_MANIFEST");
      context.check();
      const requiredVersion =
        detail.requiredVersion ?? detail.recommendedGameVersion;
      const plan = {
        modId,
        name,
        title,
        revision: actualRevision,
        platform,
        archiveUrl: `${root}${parsed.filename}`,
        ...parsed,
        ...(repository ? { access: "repository" } : {}),
        ...(typeof requiredVersion === "string" &&
        /^[A-Za-z0-9.*_+-]{1,80}$/.test(requiredVersion)
          ? { supportedVersion: requiredVersion }
          : {}),
      };
      capabilities.set(plan, {
        repository,
        repair,
        patches: signed.patches,
        plan: { ...plan },
      });
      return plan;
    } catch (error) {
      context.check();
      if (error?.[SAFE_ERROR]) throw error;
      throw failure("NETWORK_ERROR");
    } finally {
      context.dispose();
    }
  }

  async function download(plan, options = {}) {
    const { destination, onProgress, bytesPerSecond = 0 } = options;
    if (!plan || typeof plan !== "object") throw failure("INVALID_PLAN");
    const modId = decimal(plan.modId, "INVALID_PLAN");
    const revision = decimal(plan.revision, "INVALID_PLAN");
    const name = segment(plan.name, "INVALID_PLAN");
    const platform = platformValue(plan.platform, "INVALID_PLAN");
    const patch = plan.kind === "patch";
    const fromRevision = patch
      ? plan.fromRevision === "-1"
        ? "-1"
        : decimal(plan.fromRevision, "INVALID_PLAN")
      : undefined;
    if (
      (plan.kind !== undefined && !patch) ||
      (!patch && plan.fromRevision !== undefined) ||
      fromRevision === revision
    )
      throw failure("INVALID_PLAN");
    const filename = patch
      ? `${fromRevision}_to_${revision}.zip`
      : archiveName(plan.filename, "INVALID_PLAN");
    if (patch && plan.filename !== filename) throw failure("INVALID_PLAN");
    const bytes = boundedSize(plan.bytes, maxArchiveBytes, "INVALID_PLAN");
    const sha256 = plan.sha256;
    const archiveUrl = patch
      ? `${CDN}/hoi4/${name}/repo/${platform}/${revision}/${fromRevision}_to_${revision}/${filename}`
      : `${archiveRoot(name, platform, revision)}${filename}`;
    if (
      !modId ||
      plan.archiveUrl !== archiveUrl ||
      (plan.access !== undefined && plan.access !== "repository") ||
      typeof sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(sha256)
    )
      throw failure("INVALID_PLAN");
    if (
      typeof destination !== "string" ||
      !path.isAbsolute(destination) ||
      /[\0-\x1f]/.test(destination) ||
      /[:<>"|?*]/.test(path.basename(destination)) ||
      /[. ]$/.test(path.basename(destination)) ||
      /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(
        path.basename(destination),
      ) ||
      (onProgress !== undefined && typeof onProgress !== "function") ||
      !Number.isSafeInteger(bytesPerSecond) ||
      bytesPerSecond < 0
    )
      throw failure("INVALID_INPUT");
    const canonicalPlan = {
      modId,
      revision,
      name,
      platform,
      filename,
      archiveUrl,
      bytes,
      sha256,
      ...(plan.access === "repository" ? { access: "repository" } : {}),
      ...(patch
        ? {
            kind: "patch",
            fromRevision,
            unpackedBytes: boundedSize(
              plan.unpackedBytes,
              maxArchiveBytes + MAX_MANIFEST,
              "INVALID_PLAN",
              true,
            ),
          }
        : {}),
    };
    const capability = capabilities.get(options.resolvedPlan || plan);
    if (
      (plan.access === "repository" && !capability?.repository) ||
      (patch && !capability?.target)
    )
      throw failure("INVALID_PLAN");
    let activeTransfer = transfer;
    if (capability) {
      if (
        (capability.repository && plan.access !== "repository") ||
        Object.entries(canonicalPlan).some(
          ([key, value]) => capability.plan[key] !== value,
        )
      )
        throw failure("INVALID_PLAN");
      activeTransfer = createPdxTransfer({
        ...transferOptions,
        request: async (url, context, accept, requestOptions) => {
          if (url !== archiveUrl) throw failure("INVALID_PLAN");
          if (capability.repair && !patch) {
            let fileUrl = `${CDN}/hoi4/${name}/repo/${platform}/${fileResource(bytes, sha256)}`;
            if (capability.repository) {
              try {
                fileUrl = await context.wait(
                  capability.repository.urlFor({
                    file: { bytes, sha256 },
                    signal: context.signal,
                  }),
                );
              } catch (error) {
                context.check();
                throw failure(
                  ACCOUNT_CODES.has(error?.code)
                    ? error.code
                    : "INVALID_RESPONSE",
                );
              }
            }
            const response = await request(fileUrl, context, accept, {
              ...requestOptions,
              content: true,
              statuses: [...requestOptions.statuses, 404],
            });
            if (response.status !== 404) return response;
            cancelBody(response);
            context.check();
            if (capability.filesOnly) throw failure("NOT_FOUND");
          }
          const sourceUrl = capability.repository
            ? await repositoryUrl(
                capability.repository,
                revision,
                filename,
                context,
                fromRevision,
              )
            : archiveUrl;
          return request(sourceUrl, context, accept, {
            ...requestOptions,
            content: true,
          });
        },
      });
    }
    return activeTransfer(canonicalPlan, options);
  }

  const transferOptions = {
    request,
    operation,
    chunks,
    contentLength,
    cancelBody,
    failure,
    isSafeError: (error) => Boolean(error?.[SAFE_ERROR]),
    timeoutMs,
  };
  const transfer = createPdxTransfer(transferOptions);

  function completeCapability(plan, resolvedPlan) {
    const cap = capabilities.get(resolvedPlan || plan);
    if (
      !cap ||
      cap.target ||
      Object.entries(cap.plan).some(([key, value]) => plan?.[key] !== value) ||
      plan.kind !== undefined ||
      plan.fromRevision !== undefined
    )
      throw failure("INVALID_PLAN");
    return cap;
  }

  function getPatchSize(plan, { resolvedPlan, fromRevision } = {}) {
    const cap = completeCapability(plan, resolvedPlan);
    fromRevision =
      fromRevision === "-1" ? "-1" : decimal(fromRevision, "INVALID_INPUT");
    if (fromRevision === plan.revision) throw failure("INVALID_INPUT");
    if (!cap.patches || !Object.hasOwn(cap.patches, fromRevision)) return null;
    const row = cap.patches[fromRevision];
    if (
      !row ||
      typeof row !== "object" ||
      Array.isArray(row) ||
      typeof row.sizePacked !== "string" ||
      !/^[1-9]\d{0,15}$/.test(row.sizePacked) ||
      /\D/.test(row.sizePacked)
    )
      throw failure("INVALID_METADATA");
    return boundedSize(
      Number(row.sizePacked),
      maxArchiveBytes,
      "RESPONSE_TOO_LARGE",
    );
  }

  async function resolvePatch(
    plan,
    { resolvedPlan, fromRevision, signal } = {},
  ) {
    const cap = completeCapability(plan, resolvedPlan);
    fromRevision =
      fromRevision === "-1" ? "-1" : decimal(fromRevision, "INVALID_INPUT");
    if (fromRevision === plan.revision) throw failure("INVALID_INPUT");
    if (!cap.patches || !Object.hasOwn(cap.patches, fromRevision)) return null;
    const advertised = cap.patches[fromRevision];
    if (
      !advertised ||
      typeof advertised !== "object" ||
      Array.isArray(advertised) ||
      [advertised.sizePacked, advertised.sizeUnpacked].some(
        (value, index) =>
          typeof value !== "string" ||
          !(index === 1 ? /^(?:0|[1-9]\d{0,15})$/ : /^[1-9]\d{0,15}$/).test(
            value,
          ) ||
          /\D/.test(value) ||
          !Number.isSafeInteger(Number(value)),
      )
    )
      throw failure("INVALID_METADATA");
    const context = operation(signal, timeoutMs);
    try {
      const repositoryRoot = `${CDN}/hoi4/${plan.name}/repo/${plan.platform}/`;
      const signed = await signedManifest({
        revision: plan.revision,
        fromRevision,
        repository: cap.repository,
        repositoryRoot,
        context,
      });
      const filename = `${fromRevision}_to_${plan.revision}.zip`;
      const parsed = parseManifest(
        decodeText(signed.manifest),
        plan.platform,
        maxArchiveBytes,
        filename,
      );
      if (
        signed.completeSize !== plan.bytes ||
        signed.patchSize !== parsed.bytes ||
        signed.patchSize !== Number(advertised.sizePacked) ||
        signed.patchUnpackedSize !== Number(advertised.sizeUnpacked) ||
        signed.patchUnpackedSize > maxArchiveBytes + MAX_MANIFEST ||
        parsed.unpackedBytes !== signed.patchUnpackedSize
      )
        throw failure("INVALID_MANIFEST");
      const result = {
        modId: plan.modId,
        revision: plan.revision,
        name: plan.name,
        platform: plan.platform,
        filename,
        archiveUrl: `${repositoryRoot}${plan.revision}/${fromRevision}_to_${plan.revision}/${filename}`,
        bytes: parsed.bytes,
        sha256: parsed.sha256,
        ...(plan.access ? { access: plan.access } : {}),
        kind: "patch",
        fromRevision,
        unpackedBytes: parsed.unpackedBytes,
      };
      capabilities.set(result, {
        repository: cap.repository,
        plan: { ...result },
        target: { ...cap.plan },
        unpackedBytes: signed.patchUnpackedSize,
      });
      return result;
    } catch (error) {
      context.check();
      if (error?.[SAFE_ERROR]) throw error;
      throw failure("INVALID_MANIFEST");
    } finally {
      context.dispose();
    }
  }

  async function prepareRepair(plan, { resolvedPlan, signal } = {}) {
    const cap = completeCapability(plan, resolvedPlan);
    if (!cap.repair || !cap.patches || !Object.hasOwn(cap.patches, "-1"))
      return resolvedPlan || plan;
    const context = operation(signal, timeoutMs);
    try {
      let url = `${CDN}/hoi4/${plan.name}/repo/${plan.platform}/${fileResource(plan.bytes, plan.sha256)}`;
      if (cap.repository) {
        try {
          url = await context.wait(
            cap.repository.urlFor({
              file: { bytes: plan.bytes, sha256: plan.sha256 },
              signal: context.signal,
            }),
          );
        } catch (error) {
          context.check();
          throw failure(
            ACCOUNT_CODES.has(error?.code) ? error.code : "INVALID_RESPONSE",
          );
        }
      }
      const response = await request(url, context, "application/zip", {
        content: true,
        statuses: [200, 404],
      });
      cancelBody(response);
      context.check();
      if (response.status === 404)
        return resolvePatch(plan, { resolvedPlan, fromRevision: "-1", signal });
      const result = { ...cap.plan };
      capabilities.set(result, { ...cap, filesOnly: true });
      return result;
    } finally {
      context.dispose();
    }
  }

  return { resolve, download, resolvePatch, prepareRepair, getPatchSize };
}

module.exports = { createPdxContentService };
