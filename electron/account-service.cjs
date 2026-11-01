const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { openUploadSource } = require("./upload-source.cjs");
const { isRepositoryResourcePath } = require("./pdx-repository.cjs");

const API_BASE = "https://api.paradox-interactive.com";
const SESSION_PATH = "/accounts/sessions/launcher-v2";
// Public protocol constant shipped in the account client, not a client secret.
const PASSWORD_SALT = "64DC4DC6508F4A9D823179D4D99DB4EE";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_SESSION_FILE_BYTES = 128 * 1024;
const MESSAGES = {
  INVALID_INPUT: "请输入有效的邮箱和密码。",
  INVALID_CREDENTIALS: "登录未成功，请检查邮箱和密码。",
  CANCELLED: "登录或账号请求已取消。",
  NETWORK_ERROR: "无法连接 Paradox 账号服务，请检查网络后重试。",
  TIMEOUT: "Paradox 账号服务响应超时，请重试。",
  RATE_LIMITED: "请求过于频繁，请稍后重试。",
  SERVICE_ERROR: "Paradox 服务暂时不可用，请稍后重试。",
  INVALID_RESPONSE: "Paradox 服务返回了无法识别的数据，请稍后重试。",
  NOT_SIGNED_IN: "请先登录 Paradox 账号。",
  SESSION_EXPIRED: "登录已过期，请重新登录。",
  ACCESS_DENIED: "当前账号没有执行此操作的权限。",
  REQUEST_FAILED: "Paradox 请求未成功，请检查操作内容后重试。",
  REQUEST_NOT_ALLOWED: "不支持此账号服务请求。",
  ACCOUNT_CHANGED: "Paradox 账号已切换，请刷新后重新确认操作。",
  UPLOAD_SOURCE_CHANGED: "上传文件发生变化或无法读取，请重新准备发布。",
  STORAGE_ERROR: "无法清除本机保存的登录信息，请检查启动器数据目录权限。",
};

function accountError(code) {
  const error = new Error(MESSAGES[code] || MESSAGES.REQUEST_FAILED);
  error.code = code;
  return error;
}

function secretString(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 16384;
}

function createAccountService({
  fetchImpl = globalThis.fetch,
  sessionPath,
  encryptString,
  decryptString,
  isEncryptionAvailable = () => false,
  now = () => Date.now(),
  timeoutMs = 20000,
  uploadTimeoutMs = 30 * 60 * 1000,
} = {}) {
  if (typeof fetchImpl !== "function" || !path.isAbsolute(sessionPath || "")) {
    throw new Error("账号服务需要网络实现与绝对路径的会话文件。");
  }

  let session = null;
  let account = null;
  let remembered = false;
  let notice = null;
  let epoch = 0;
  let initialized = false;
  let initialization = null;
  let refreshInFlight = null;
  let loginContext = null;
  let storageQueue = Promise.resolve();
  const controllers = new Set();
  const bindings = new Set();
  const secrets = new Set();

  function canRemember() {
    try {
      return (
        typeof encryptString === "function" &&
        typeof decryptString === "function" &&
        isEncryptionAvailable() === true
      );
    } catch {
      return false;
    }
  }

  function snapshot() {
    return {
      status: session?.token && account ? "signed-in" : "signed-out",
      account: account ? { ...account } : null,
      remembered,
      canRemember: canRemember(),
      notice,
    };
  }

  function check(currentEpoch, signal) {
    if (currentEpoch !== epoch || signal?.aborted)
      throw accountError("CANCELLED");
  }

  function context(signal) {
    if (signal !== undefined && !(signal instanceof AbortSignal)) {
      throw accountError("INVALID_INPUT");
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener("abort", abort, { once: true });
    controllers.add(controller);
    return {
      epoch,
      signal: controller.signal,
      controller,
      dispose() {
        controllers.delete(controller);
        signal?.removeEventListener("abort", abort);
      },
    };
  }

  function invalidateBindings(code) {
    for (const binding of [...bindings]) binding.invalidate(code);
  }

  function reset() {
    epoch += 1;
    invalidateBindings("ACCOUNT_CHANGED");
    for (const controller of controllers) controller.abort();
    controllers.clear();
    session = null;
    account = null;
    remembered = false;
    notice = null;
    initialized = true;
    initialization = null;
    refreshInFlight = null;
    loginContext = null;
    secrets.clear();
  }

  function storage(operation) {
    const result = storageQueue.then(operation);
    storageQueue = result.catch(() => {});
    return result;
  }

  async function clearSaved(currentEpoch) {
    return storage(async () => {
      check(currentEpoch);
      try {
        await fs.unlink(sessionPath);
      } catch (error) {
        if (error.code !== "ENOENT") throw accountError("STORAGE_ERROR");
      }
    });
  }

  async function persist(currentEpoch) {
    if (!remembered || !session?.refreshToken) return;
    if (!canRemember()) {
      remembered = false;
      notice = "系统加密不可用，本次登录仅保留到启动器退出。";
      await clearSaved(currentEpoch);
      return;
    }
    const refreshToken = session.refreshToken;
    try {
      await storage(async () => {
        check(currentEpoch);
        const encrypted = await encryptString(
          JSON.stringify({ version: 1, refreshToken, storedAt: now() }),
        );
        if (!Buffer.isBuffer(encrypted) || encrypted.length === 0) {
          throw accountError("STORAGE_ERROR");
        }
        const data = JSON.stringify({
          version: 1,
          ciphertext: encrypted.toString("base64"),
        });
        if (Buffer.byteLength(data) > MAX_SESSION_FILE_BYTES) {
          throw accountError("STORAGE_ERROR");
        }
        const temporary = `${sessionPath}.tmp-${randomUUID()}`;
        try {
          await fs.mkdir(path.dirname(sessionPath), {
            recursive: true,
            mode: 0o700,
          });
          await fs.writeFile(temporary, data, { flag: "wx", mode: 0o600 });
          check(currentEpoch);
          await fs.rename(temporary, sessionPath);
        } finally {
          await fs.unlink(temporary).catch(() => {});
        }
      });
      check(currentEpoch);
    } catch (error) {
      check(currentEpoch);
      remembered = false;
      notice = "无法安全保存登录信息，本次登录仅保留到启动器退出。";
      await clearSaved(currentEpoch);
    }
  }

  async function initialize() {
    if (initialized) return initialization;
    initialized = true;
    const currentEpoch = epoch;
    initialization = storage(async () => {
      let file;
      try {
        const stat = await fs.lstat(sessionPath);
        check(currentEpoch);
        if (
          !stat.isFile() ||
          stat.isSymbolicLink() ||
          stat.size > MAX_SESSION_FILE_BYTES
        ) {
          throw accountError("INVALID_RESPONSE");
        }
        if (!canRemember()) {
          notice = "系统加密不可用，请重新登录；本次不会保存登录信息。";
          return;
        }
        file = JSON.parse(await fs.readFile(sessionPath, "utf8"));
        if (
          file.version !== 1 ||
          typeof file.ciphertext !== "string" ||
          !/^[A-Za-z0-9+/]+={0,2}$/.test(file.ciphertext) ||
          file.ciphertext.length % 4 !== 0
        )
          throw accountError("INVALID_RESPONSE");
        const decrypted = await decryptString(
          Buffer.from(file.ciphertext, "base64"),
        );
        const data = JSON.parse(decrypted);
        check(currentEpoch);
        if (data.version !== 1 || !secretString(data.refreshToken)) {
          throw accountError("INVALID_RESPONSE");
        }
        session = {
          token: null,
          refreshToken: data.refreshToken,
          userid: null,
        };
        secrets.add(data.refreshToken);
        remembered = true;
      } catch (error) {
        check(currentEpoch);
        if (error.code === "ENOENT") return;
        notice = "已保存的登录信息无法读取，请重新登录。";
        // This is only our own session file, never the official launcher's store.
        await fs.unlink(sessionPath).catch(() => {});
      }
    });
    return initialization;
  }

  async function http(
    {
      method,
      requestPath,
      query,
      body,
      authorization,
      version2,
      binary,
      bodyFactory,
      contentLength,
      requestTimeoutMs,
    },
    ctx,
  ) {
    check(ctx.epoch, ctx.signal);
    const url = new URL(requestPath, API_BASE);
    for (const [key, value] of Object.entries(query || {})) {
      url.searchParams.set(key, String(value));
    }
    const headers = {
      Accept: "application/json",
      "User-Agent": `IRONCLAD/${require("../package.json").version}`,
      "x-pdx-game-name": "hoi4",
      Authorization: JSON.stringify(authorization),
    };
    if (body !== undefined || bodyFactory)
      headers["Content-Type"] = binary
        ? "application/octet-stream"
        : "application/json";
    if (version2) headers["X-Accept-Version"] = "2";
    if (bodyFactory) headers["Content-Length"] = String(contentLength);
    const timeout = AbortSignal.timeout(requestTimeoutMs ?? timeoutMs);
    const signal = AbortSignal.any([ctx.signal, timeout]);
    let response, upload;
    try {
      if (bodyFactory) upload = await bodyFactory(signal);
      response = await fetchImpl(url.href, {
        method,
        headers,
        body: upload
          ? upload.body
          : body === undefined
            ? undefined
            : binary
              ? body
              : JSON.stringify(body),
        ...(upload ? { duplex: "half" } : {}),
        redirect: "error",
        signal,
      });
      check(ctx.epoch, ctx.signal);
      if (timeout.aborted) throw accountError("TIMEOUT");
      if (
        response.redirected ||
        (response.url && new URL(response.url).origin !== API_BASE)
      ) {
        throw accountError("INVALID_RESPONSE");
      }
      if (!response.ok) {
        const code =
          response.status === 401
            ? "SESSION_EXPIRED"
            : response.status === 403
              ? "ACCESS_DENIED"
              : response.status === 429
                ? "RATE_LIMITED"
                : response.status >= 500
                  ? "SERVICE_ERROR"
                  : "REQUEST_FAILED";
        // Never attach the response body, headers, request config or original error.
        throw accountError(code);
      }
      if (upload) await upload.verify();
      if (response.status === 204) return null;
      if (
        Number(response.headers?.get("content-length")) > MAX_RESPONSE_BYTES
      ) {
        throw accountError("INVALID_RESPONSE");
      }
      let text;
      if (response.body?.getReader) {
        const reader = response.body.getReader();
        const chunks = [];
        let size = 0;
        try {
          while (true) {
            const { value, done } = await reader.read();
            check(ctx.epoch, ctx.signal);
            if (done) break;
            size += value.byteLength;
            if (size > MAX_RESPONSE_BYTES) {
              await reader.cancel();
              throw accountError("INVALID_RESPONSE");
            }
            chunks.push(Buffer.from(value));
          }
        } finally {
          reader.releaseLock();
        }
        text = Buffer.concat(chunks).toString("utf8");
      } else text = await response.text();
      check(ctx.epoch, ctx.signal);
      if (timeout.aborted) throw accountError("TIMEOUT");
      if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES)
        throw accountError("INVALID_RESPONSE");
      if (upload && !text.trim()) return null;
      try {
        return JSON.parse(text);
      } catch {
        throw accountError("INVALID_RESPONSE");
      }
    } catch (error) {
      check(ctx.epoch, ctx.signal);
      if (timeout.aborted) throw accountError("TIMEOUT");
      if (Object.hasOwn(MESSAGES, error?.code)) throw accountError(error.code);
      // Native fetch wraps errors from a request body in TypeError.cause.
      if (error?.cause?.code === "UPLOAD_SOURCE_CHANGED")
        throw accountError("UPLOAD_SOURCE_CHANGED");
      throw accountError("NETWORK_ERROR");
    } finally {
      upload?.dispose();
      // An early 401/403 may have a still-streaming response. Release it before
      // authenticated() renews credentials and creates another upload body.
      await Promise.resolve(response?.body?.cancel?.()).catch(() => {});
    }
  }

  function readSession(data, previousRefreshToken = null) {
    const value = data?.session;
    if (!secretString(value?.token)) throw accountError("INVALID_RESPONSE");
    const refreshToken = secretString(value.refresh_token)
      ? value.refresh_token
      : previousRefreshToken;
    const userid = ["string", "number"].includes(typeof value.userid)
      ? String(value.userid)
      : null;
    if (userid !== null && userid.length > 200) {
      throw accountError("INVALID_RESPONSE");
    }
    secrets.add(value.token);
    if (refreshToken) secrets.add(refreshToken);
    return { token: value.token, refreshToken, userid };
  }

  function redactString(value) {
    let output = value;
    for (const secret of secrets)
      if (secret.length >= 4) output = output.split(secret).join("[已隐藏]");
    return output;
  }

  function readAccount(data) {
    const value = data?.account;
    if (
      !value ||
      typeof value !== "object" ||
      typeof value.email !== "string" ||
      value.email.length > 320
    ) {
      throw accountError("INVALID_RESPONSE");
    }
    const name = [value.displayName, value.username].find(
      (item) => typeof item === "string" && item.length <= 200,
    );
    return {
      id: session?.userid ? redactString(session.userid) : null,
      email: redactString(value.email),
      displayName: name ? redactString(name) : null,
    };
  }

  async function expire(currentEpoch) {
    check(currentEpoch);
    invalidateBindings("SESSION_EXPIRED");
    session = null;
    account = null;
    remembered = false;
    notice = "登录已过期，请重新登录。";
    await clearSaved(currentEpoch);
  }

  async function refresh() {
    if (refreshInFlight) return refreshInFlight;
    if (!session?.refreshToken) throw accountError("SESSION_EXPIRED");
    const ctx = context();
    const refreshToken = session.refreshToken;
    const operation = (async () => {
      try {
        const data = await http(
          {
            method: "PUT",
            requestPath: SESSION_PATH,
            authorization: { renewal: { token: refreshToken } },
          },
          ctx,
        );
        check(ctx.epoch, ctx.signal);
        const next = readSession(data, refreshToken);
        if (session?.userid && next.userid && session.userid !== next.userid) {
          await expire(ctx.epoch);
          throw accountError("SESSION_EXPIRED");
        }
        session = { ...next, userid: next.userid || session?.userid };
        await persist(ctx.epoch);
      } catch (error) {
        check(ctx.epoch, ctx.signal);
        if (["SESSION_EXPIRED", "ACCESS_DENIED"].includes(error.code)) {
          await expire(ctx.epoch);
          throw accountError("SESSION_EXPIRED");
        }
        throw error;
      } finally {
        ctx.dispose();
        if (ctx.epoch === epoch) refreshInFlight = null;
      }
    })();
    refreshInFlight = operation;
    return operation;
  }

  async function authenticated(options, ctx) {
    check(ctx.epoch, ctx.signal);
    if (!session) throw accountError("NOT_SIGNED_IN");
    if (!session.token) await refresh();
    check(ctx.epoch, ctx.signal);
    const originalToken = session.token;
    try {
      return await http(
        { ...options, authorization: { session: { token: originalToken } } },
        ctx,
      );
    } catch (error) {
      if (error.code !== "SESSION_EXPIRED") throw error;
      check(ctx.epoch, ctx.signal);
      if (!session?.refreshToken) {
        await expire(ctx.epoch);
        throw accountError("SESSION_EXPIRED");
      }
      // Another request may already have refreshed the same expired access token.
      if (session.token === originalToken) await refresh();
      check(ctx.epoch, ctx.signal);
      try {
        return await http(
          { ...options, authorization: { session: { token: session.token } } },
          ctx,
        );
      } catch (retryError) {
        if (retryError.code === "SESSION_EXPIRED") await expire(ctx.epoch);
        throw retryError;
      }
    }
  }

  async function login(input = {}) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw accountError("INVALID_INPUT");
    }
    const { email, password, remember = false, signal } = input;
    if (
      typeof email !== "string" ||
      email.trim().length > 320 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) ||
      typeof password !== "string" ||
      password.length === 0 ||
      password.length > 4096 ||
      typeof remember !== "boolean" ||
      (signal !== undefined && !(signal instanceof AbortSignal))
    )
      throw accountError("INVALID_INPUT");
    reset();
    const ctx = context(signal);
    loginContext = ctx;
    try {
      await clearSaved(ctx.epoch);
      const digest = createHash("sha256")
        .update(password + PASSWORD_SALT, "utf8")
        .digest("hex");
      secrets.add(digest);
      // Plaintext passwords never enter state, files, diagnostics, or responses.
      const data = await http(
        {
          method: "PUT",
          requestPath: SESSION_PATH,
          authorization: {
            hawk: { email: email.trim(), "sha256(password+salt)": digest },
          },
        },
        ctx,
      ).catch((error) => {
        if (
          ["SESSION_EXPIRED", "ACCESS_DENIED", "REQUEST_FAILED"].includes(
            error.code,
          )
        ) {
          throw accountError("INVALID_CREDENTIALS");
        }
        throw error;
      });
      check(ctx.epoch, ctx.signal);
      session = readSession(data);
      const details = await authenticated(
        { method: "GET", requestPath: "/accountdetails" },
        ctx,
      );
      check(ctx.epoch, ctx.signal);
      account = readAccount(details);
      remembered = remember && canRemember() && Boolean(session.refreshToken);
      if (remember && !remembered) {
        notice = canRemember()
          ? "账号服务未提供刷新令牌，本次登录仅保留到启动器退出。"
          : "系统加密不可用，本次登录仅保留到启动器退出。";
      }
      await persist(ctx.epoch);
      check(ctx.epoch, ctx.signal);
      return snapshot();
    } catch (error) {
      if (ctx.epoch === epoch) {
        session = null;
        account = null;
        remembered = false;
        secrets.clear();
        await clearSaved(ctx.epoch);
      }
      throw Object.hasOwn(MESSAGES, error?.code)
        ? accountError(error.code)
        : accountError("REQUEST_FAILED");
    } finally {
      ctx.dispose();
      if (loginContext === ctx) loginContext = null;
    }
  }

  async function getAccount({ signal } = {}) {
    await initialize();
    if (!session || loginContext) return snapshot();
    const ctx = context(signal);
    try {
      const data = await authenticated(
        { method: "GET", requestPath: "/accountdetails" },
        ctx,
      );
      check(ctx.epoch, ctx.signal);
      if (!session?.token) throw accountError("SESSION_EXPIRED");
      account = readAccount(data);
      return snapshot();
    } finally {
      ctx.dispose();
    }
  }

  async function logout() {
    reset();
    await clearSaved(epoch);
    return snapshot();
  }

  async function cancelLogin() {
    return loginContext ? logout() : snapshot();
  }

  // A main-process lease binds the whole operation, including unauthenticated
  // CDN work after metadata. It never exposes the access token or session epoch.
  async function bindSession({ signal, expectedAccountId } = {}) {
    if (
      expectedAccountId !== undefined &&
      (typeof expectedAccountId !== "string" ||
        !expectedAccountId ||
        expectedAccountId.length > 200)
    )
      throw accountError("INVALID_INPUT");
    // Capture before initialization: a pending decrypt must not adopt a later login.
    const ctx = context(signal);
    let accountId = null;
    const binding = {
      reason: null,
      invalidate(code) {
        if (ctx.signal.aborted) return;
        binding.reason = code;
        ctx.controller.abort(accountError(code));
      },
    };
    const release = () => {
      bindings.delete(binding);
      ctx.signal.removeEventListener("abort", release);
      ctx.dispose();
    };
    bindings.add(binding);
    ctx.signal.addEventListener("abort", release, { once: true });
    if (ctx.signal.aborted) release();
    function checkEpoch() {
      if (ctx.signal.aborted) throw accountError(binding.reason || "CANCELLED");
      if (ctx.epoch !== epoch) throw accountError("ACCOUNT_CHANGED");
    }
    function checkBinding() {
      checkEpoch();
      if (!session?.token || !account) {
        binding.invalidate("SESSION_EXPIRED");
        throw accountError("SESSION_EXPIRED");
      }
      if (loginContext || session.userid !== accountId) {
        binding.invalidate("ACCOUNT_CHANGED");
        throw accountError("ACCOUNT_CHANGED");
      }
    }
    function dispose() {
      binding.invalidate("CANCELLED");
      release();
    }
    function waitFor(pending) {
      return new Promise((resolve, reject) => {
        const cancelled = () =>
          reject(accountError(binding.reason || "CANCELLED"));
        Promise.resolve(pending)
          .then(resolve, reject)
          .finally(() => ctx.signal.removeEventListener("abort", cancelled));
        if (ctx.signal.aborted) cancelled();
        else ctx.signal.addEventListener("abort", cancelled, { once: true });
      });
    }
    try {
      checkEpoch();
      await waitFor(initialize());
      checkEpoch();
      if (!session || loginContext) throw accountError("NOT_SIGNED_IN");
      if (
        expectedAccountId !== undefined &&
        session.userid &&
        session.userid !== expectedAccountId
      )
        throw accountError("ACCOUNT_CHANGED");
      const current = await waitFor(getAccount({ signal: ctx.signal }));
      checkEpoch();
      accountId = current.account?.id;
      if (
        current.status !== "signed-in" ||
        !accountId ||
        accountId !== session?.userid
      )
        throw accountError("INVALID_RESPONSE");
      if (expectedAccountId !== undefined && accountId !== expectedAccountId)
        throw accountError("ACCOUNT_CHANGED");
      checkBinding();
      return Object.freeze({
        accountId,
        signal: ctx.signal,
        check: checkBinding,
        dispose,
      });
    } catch (error) {
      try {
        checkEpoch();
        throw accountError(
          Object.hasOwn(MESSAGES, error?.code) ? error.code : "REQUEST_FAILED",
        );
      } finally {
        dispose();
      }
    }
  }

  // Main-process providers only. Do not expose this method as a generic IPC.
  async function request({
    method = "GET",
    path: requestPath,
    query = {},
    body,
    signal,
    expectedAccountId,
  } = {}) {
    const routes = {
      "GET /accountdetails": [],
      "GET /accounts/connections/u": [],
      "GET /profiles": ["namespace"],
      "GET /mods": ["modId", "modVersion"],
      "GET /mods/versions": ["modId"],
      "GET /mods/sets/list/hoi4": ["includeShared"],
      "POST /mods": [],
      "POST /mods/installed": [],
      "POST /mods/directDependencies": [],
      "POST /mods/publish": [],
      "POST /mods/publishUpdate": [],
      "DELETE /mods/installed": ["modId", "activationSetId"],
    };
    const binary =
      method === "PUT" &&
      typeof requestPath === "string" &&
      /^\/mods\/content\/hoi4\/[A-Za-z0-9_-]+\/(content|thumbnail|screenshot|descriptionImage)\/[A-Za-z0-9_-]+\.[A-Za-z0-9]+$/.test(
        requestPath,
      );
    const setMods =
      method === "GET" && /^\/mods\/sets\/\d+\/mods$/.test(requestPath);
    const repositoryResource =
      method === "GET" && isRepositoryResourcePath(requestPath);
    const allowedQuery = binary
      ? []
      : setMods
        ? ["limit", "page", "version"]
        : repositoryResource
          ? []
          : routes[`${method} ${requestPath}`];
    if (
      !allowedQuery ||
      !query ||
      typeof query !== "object" ||
      Array.isArray(query) ||
      Object.entries(query).some(
        ([key, value]) =>
          !allowedQuery.includes(key) ||
          !["string", "number", "boolean"].includes(typeof value) ||
          String(value).length > 200,
      ) ||
      (requestPath === "/profiles" && query.namespace !== "social") ||
      (binary && !Buffer.isBuffer(body) && !(body instanceof Uint8Array)) ||
      (!binary &&
        body !== undefined &&
        (body === null || typeof body !== "object" || Buffer.isBuffer(body))) ||
      (method === "GET" && body !== undefined)
    )
      throw accountError("REQUEST_NOT_ALLOWED");
    await initialize();
    if (loginContext) throw accountError("NOT_SIGNED_IN");
    if (
      expectedAccountId !== undefined &&
      (typeof expectedAccountId !== "string" ||
        !expectedAccountId ||
        session?.userid !== expectedAccountId)
    )
      throw accountError("ACCOUNT_CHANGED");
    const ctx = context(signal);
    try {
      const data = await authenticated(
        {
          method,
          requestPath,
          query,
          body,
          binary,
          version2: method === "POST" && requestPath === "/mods/installed",
        },
        ctx,
      );
      function redact(value) {
        if (typeof value === "string") return redactString(value);
        if (Array.isArray(value)) return value.map(redact);
        if (!value || typeof value !== "object") return value;
        return Object.fromEntries(
          Object.entries(value)
            .filter(
              ([key]) =>
                !/token|password|authorization|secret|cookie/i.test(key),
            )
            .map(([key, item]) => [key, redact(item)]),
        );
      }
      return redact(data);
    } finally {
      ctx.dispose();
    }
  }

  async function uploadFile({
    path: requestPath,
    filePath,
    bytes,
    sha256,
    expectedAccountId,
    signal,
    onProgress,
  } = {}) {
    if (
      typeof requestPath !== "string" ||
      !/^\/mods\/content\/hoi4\/[A-Za-z0-9_-]+\/(content|thumbnail)\/[A-Za-z0-9_-]+\.(zip|png|jpe?g)$/.test(
        requestPath,
      ) ||
      typeof expectedAccountId !== "string" ||
      !expectedAccountId ||
      (onProgress !== undefined && typeof onProgress !== "function")
    )
      throw accountError("REQUEST_NOT_ALLOWED");
    await initialize();
    if (loginContext || !session) throw accountError("NOT_SIGNED_IN");
    if (session.userid !== expectedAccountId)
      throw accountError("ACCOUNT_CHANGED");
    const ctx = context(signal);
    let source;
    try {
      source = await openUploadSource({
        filePath,
        bytes,
        sha256,
        check: () => check(ctx.epoch, ctx.signal),
      });
      check(ctx.epoch, ctx.signal);
      const reply = await authenticated(
        {
          method: "PUT",
          requestPath,
          binary: true,
          contentLength: bytes,
          requestTimeoutMs: uploadTimeoutMs,
          bodyFactory: (requestSignal) =>
            source.bodyFactory(requestSignal, onProgress),
        },
        ctx,
      );
      // Upload receipts are control data, not credentials or arbitrary provider JSON.
      if (reply === null) return null;
      if (!reply || typeof reply !== "object" || Array.isArray(reply))
        throw accountError("INVALID_RESPONSE");
      return Object.fromEntries(
        ["result", "state", "fileName", "filename", "url"]
          .filter(
            (key) => typeof reply[key] === "string" && reply[key].length < 2048,
          )
          .map((key) => [key, redactString(reply[key])]),
      );
    } catch (error) {
      check(ctx.epoch, ctx.signal);
      if (Object.hasOwn(MESSAGES, error?.code)) throw accountError(error.code);
      throw accountError("UPLOAD_SOURCE_CHANGED");
    } finally {
      await source?.close().catch(() => {});
      ctx.dispose();
    }
  }

  return {
    login,
    getAccount,
    logout,
    cancelLogin,
    bindSession,
    request,
    uploadFile,
  };
}

module.exports = { createAccountService };
