"use strict";

const { isIP } = require("node:net");

const MIN_VALIDITY_MS = 60_000;
const MAX_GRANT_PART = 4096;
const ROOT_RESOURCES = new Set([
  "repository.json",
  "repository.json.asc",
  "_keys/public.gpg",
]);
const WINDOWS_ALIAS = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i;
const UNSAFE_URL_CHARACTER = /[\u0000-\u0020\u007f-\u009f\\]/;
const ACCOUNT_CODES = new Set([
  "INVALID_INPUT",
  "INVALID_CREDENTIALS",
  "CANCELLED",
  "NETWORK_ERROR",
  "TIMEOUT",
  "RATE_LIMITED",
  "SERVICE_ERROR",
  "INVALID_RESPONSE",
  "NOT_SIGNED_IN",
  "SESSION_EXPIRED",
  "ACCESS_DENIED",
  "REQUEST_FAILED",
  "REQUEST_NOT_ALLOWED",
  "ACCOUNT_CHANGED",
  "STORAGE_ERROR",
]);
const MESSAGES = {
  INVALID_INPUT: "Paradox 下载参数无效。",
  INVALID_RESPONSE: "Paradox 账号服务返回了无法识别的数据，请稍后重试。",
  CANCELLED: "模组下载已取消。",
};

function failure(code) {
  const error = new Error(
    MESSAGES[code] || "Paradox 账号请求未成功，请稍后重试。",
  );
  error.code = code;
  return error;
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeSegment(value) {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value) &&
    !/[\r\n]/.test(value) &&
    !WINDOWS_ALIAS.test(value)
  );
}

function validRepositoryPath(value) {
  if (typeof value !== "string" || value.length > 400) return false;
  const parts = /^mods\/hoi4\/([^/]+)\/repo\/(Any|Windows)__([^/]+)$/.exec(
    value,
  );
  return !!parts && safeSegment(parts[1]) && safeSegment(parts[3]);
}

function validRevision(value) {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) return false;
    value = String(value);
  }
  return (
    typeof value === "string" &&
    /^[1-9]\d{0,15}$/.test(value) &&
    !/\D/.test(value) &&
    Number.isSafeInteger(Number(value))
  );
}

function validFilename(value) {
  return (
    value === "manifest" ||
    value === "manifest.asc" ||
    (typeof value === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,195}\.zip$/.test(value) &&
      !/[\r\n]/.test(value) &&
      !value.includes("..") &&
      !WINDOWS_ALIAS.test(value))
  );
}

function patchResource(patch) {
  if (
    !object(patch) ||
    Object.keys(patch).some(
      (key) => !["fromRevision", "revision", "filename"].includes(key),
    ) ||
    !validRevision(patch.revision) ||
    !(patch.fromRevision === "-1" || validRevision(patch.fromRevision)) ||
    String(patch.fromRevision) === String(patch.revision)
  )
    return null;
  const stem = `${patch.fromRevision}_to_${patch.revision}`;
  if (!["manifest", "manifest.asc", `${stem}.zip`].includes(patch.filename))
    return null;
  return `${patch.revision}/${stem}/${patch.filename}`;
}

function fileResource(bytes, sha256) {
  if (
    !Number.isSafeInteger(bytes) ||
    bytes < 1 ||
    typeof sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(sha256)
  )
    throw failure("INVALID_INPUT");
  // CPatch stores padded URL-safe SHA-256 in its content-addressed file name.
  return `files/${bytes}_${Buffer.from(sha256, "hex").toString("base64url")}=`;
}

function validFileResource(value) {
  const match =
    typeof value === "string" &&
    /^files\/([1-9]\d{0,15})_([A-Za-z0-9_-]{43}=)$/.exec(value);
  if (!match || !Number.isSafeInteger(Number(match[1]))) return false;
  return (
    fileResource(
      Number(match[1]),
      Buffer.from(match[2], "base64url").toString("hex"),
    ) === value
  );
}

// Shared with the account service's route allowlist. This accepts a logical
// resource only; neither a CDN URL nor any caller-provided query is a route.
function isRepositoryResourcePath(value) {
  if (typeof value !== "string" || value.length > 1024 || /[\r\n]/.test(value))
    return false;
  const parts = /^\/patch\/repo\/(mods\/hoi4\/[^/]+\/repo\/[^/]+)\/(.+)$/.exec(
    value,
  );
  if (!parts || !validRepositoryPath(parts[1])) return false;
  if (ROOT_RESOURCES.has(parts[2])) return true;
  if (validFileResource(parts[2])) return true;
  const complete = /^([^/]+)\/complete\/([^/]+)$/.exec(parts[2]);
  if (complete) return validRevision(complete[1]) && validFilename(complete[2]);
  const patch = /^([^/]+)\/(-1|[1-9]\d*)_to_([^/]+)\/([^/]+)$/.exec(parts[2]);
  return (
    !!patch &&
    patch[1] === patch[3] &&
    patchResource({
      revision: patch[1],
      fromRevision: patch[2],
      filename: patch[4],
    }) === parts[2]
  );
}

function parseGrant(data) {
  try {
    if (
      !object(data) ||
      (data.result !== undefined && data.result !== "OK") ||
      typeof data.prepend !== "string" ||
      !data.prepend ||
      data.prepend.length > MAX_GRANT_PART ||
      typeof data.append !== "string" ||
      data.append.length > MAX_GRANT_PART ||
      UNSAFE_URL_CHARACTER.test(data.prepend) ||
      UNSAFE_URL_CHARACTER.test(data.append) ||
      /[?#]/.test(data.prepend) ||
      data.append.includes("#") ||
      (data.append !== "" && !data.append.startsWith("?")) ||
      typeof data.ttl !== "string" ||
      !/^[1-9]\d{0,12}$/.test(data.ttl) ||
      /\D/.test(data.ttl)
    )
      throw failure("INVALID_RESPONSE");
    const authority = /^https:\/\/([^/?#]+)/i.exec(data.prepend)?.[1];
    if (!authority || authority.includes("@"))
      throw failure("INVALID_RESPONSE");
    const url = new URL(data.prepend);
    const host = url.hostname;
    if (
      url.protocol !== "https:" ||
      url.port !== "" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      host.length > 253 ||
      !host.includes(".") ||
      isIP(host) ||
      /(?:^|\.)(?:localhost|local|internal)$/.test(host) ||
      host
        .split(".")
        .some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    )
      throw failure("INVALID_RESPONSE");
    const expiresAt = Number(data.ttl) * 1000;
    if (!Number.isSafeInteger(expiresAt)) throw failure("INVALID_RESPONSE");
    // The grant already names the complete logical resource. Appending a
    // filename here, or reusing a manifest grant for its ZIP, invalidates it.
    return { url: data.prepend + data.append, expiresAt };
  } catch {
    // URL parser errors may include their input. Never expose those errors.
    throw failure("INVALID_RESPONSE");
  }
}

function checkSignal(signal) {
  if (signal?.aborted) throw failure("CANCELLED");
}

function requestGrant(request, options) {
  const { signal } = options;
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", cancel);
    const cancel = () => {
      cleanup();
      reject(failure("CANCELLED"));
    };
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      checkSignal(signal);
      Promise.resolve(request(options)).then(
        (data) => {
          cleanup();
          resolve(data);
        },
        (error) => {
          cleanup();
          reject(error);
        },
      );
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

function createPdxRepository(options = {}) {
  if (!object(options)) throw failure("INVALID_INPUT");
  const {
    account,
    expectedAccountId,
    repositoryPath,
    now = Date.now,
  } = options;
  if (
    !account ||
    typeof account.request !== "function" ||
    typeof expectedAccountId !== "string" ||
    !expectedAccountId.trim() ||
    expectedAccountId.length > 200 ||
    /[\u0000-\u001f\u007f]/.test(expectedAccountId) ||
    !validRepositoryPath(repositoryPath) ||
    typeof now !== "function"
  )
    throw failure("INVALID_INPUT");
  const request = account.request.bind(account);
  const grants = new Map();
  function currentTime() {
    try {
      const value = now();
      if (!Number.isSafeInteger(value) || value < 0)
        throw failure("INVALID_INPUT");
      return value;
    } catch {
      throw failure("INVALID_INPUT");
    }
  }
  async function urlFor(input = {}) {
    if (!object(input)) throw failure("INVALID_INPUT");
    const { resource, revision, filename, file, patch, signal } = input;
    const rootResource = Object.hasOwn(input, "resource");
    const addressedFile = Object.hasOwn(input, "file");
    const patchFile = Object.hasOwn(input, "patch");
    if (
      [rootResource, addressedFile, patchFile].filter(Boolean).length > 1 ||
      (rootResource
        ? !ROOT_RESOURCES.has(resource) ||
          Object.hasOwn(input, "revision") ||
          Object.hasOwn(input, "filename") ||
          addressedFile
        : patchFile
          ? !patchResource(patch) ||
            Object.hasOwn(input, "revision") ||
            Object.hasOwn(input, "filename")
          : addressedFile
            ? !object(file) ||
              Object.keys(file).some(
                (key) => !["bytes", "sha256"].includes(key),
              ) ||
              Object.hasOwn(input, "revision") ||
              Object.hasOwn(input, "filename")
            : !validRevision(revision) || !validFilename(filename)) ||
      (signal !== undefined && !(signal instanceof AbortSignal))
    )
      throw failure("INVALID_INPUT");
    checkSignal(signal);
    const relative = rootResource
      ? resource
      : patchFile
        ? patchResource(patch)
        : addressedFile
          ? fileResource(file.bytes, file.sha256)
          : `${revision}/complete/${filename}`;
    const resourcePath = `/patch/repo/${repositoryPath}/${relative}`;
    const cached = grants.get(resourcePath);
    const time = currentTime();
    if (cached && cached.expiresAt - time >= MIN_VALIDITY_MS) {
      grants.delete(resourcePath);
      grants.set(resourcePath, cached);
      return cached.url;
    }
    grants.delete(resourcePath);
    let data;
    try {
      data = await requestGrant(request, {
        method: "GET",
        path: resourcePath,
        expectedAccountId,
        signal,
      });
      checkSignal(signal);
    } catch (error) {
      checkSignal(signal);
      let code = "NETWORK_ERROR";
      try {
        const candidate = error?.code;
        if (ACCOUNT_CODES.has(candidate)) code = candidate;
        else if (error?.name === "AbortError") code = "CANCELLED";
      } catch {
        // Untrusted error properties must not escape this boundary either.
      }
      throw failure(code);
    }
    const grant = parseGrant(data);
    if (grant.expiresAt - currentTime() < MIN_VALIDITY_MS)
      throw failure("INVALID_RESPONSE");
    grants.set(resourcePath, grant);
    if (grants.size > 2) grants.delete(grants.keys().next().value);
    return grant.url;
  }
  return Object.freeze({ urlFor });
}

module.exports = {
  createPdxRepository,
  isRepositoryResourcePath,
  fileResource,
};
