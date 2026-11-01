"use strict";

const PAGE_SIZE = 100;
const MAX_PAGES = 101;
const MAX_ITEMS = 10000;
const MESSAGES = {
  INVALID_INPUT: "Paradox 订阅参数无效。",
  NOT_SIGNED_IN: "请先主动登录 Paradox 账号。",
  ACCOUNT_CHANGED: "Paradox 账号已切换，本次订阅操作已停止，请刷新。",
  ACCOUNT_UNKNOWN: "无法确认当前 Paradox 账号，请检查网络后刷新。",
  INVALID_RESPONSE: "Paradox 返回的订阅信息无法识别，请刷新后重试。",
  WRONG_GAME: "该模组不属于 HOI4，未执行订阅操作。",
  UNAVAILABLE: "该模组或版本当前不可订阅。",
  DEFAULT_SET_UNAVAILABLE: "无法确定 HOI4 默认订阅集合，未选择或创建云预设。",
  GAME_RUNNING: "请先退出游戏，再修改 Paradox 模组订阅。",
  NETWORK_ERROR: "无法读取 Paradox 订阅列表，请检查网络后刷新。",
  TIMEOUT: "Paradox 订阅请求超时，请稍后刷新。",
  ACCESS_DENIED: "当前账号无权访问该模组或订阅信息。",
  SESSION_EXPIRED: "Paradox 登录已过期，请重新登录。",
  RATE_LIMITED: "Paradox 请求过于频繁，请稍后刷新。",
  SERVICE_ERROR: "Paradox 服务暂时不可用，请稍后刷新。",
  REQUEST_REJECTED: "Paradox 未接受本次订阅变更，请检查模组状态后重试。",
  MUTATION_UNKNOWN:
    "订阅请求已经发出，但无法确认结果。请刷新列表核对，勿重复提交。",
  REFRESH_FAILED_AFTER_WRITE:
    "订阅变更已成功，但当前列表暂不可用。请刷新列表，勿重复提交。",
  ACCOUNT_CHANGED_AFTER_WRITE:
    "订阅变更已成功，但账号随后发生变化。请刷新当前账号的订阅列表，勿重复提交。",
  WRITE_NOT_YET_VISIBLE:
    "订阅变更已成功，但列表尚未反映该变更。请稍后刷新，勿重复提交。",
};
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const clone = (value) => structuredClone(value);
function failure(code) {
  const error = new Error(MESSAGES[code]);
  error.code = code;
  return error;
}
function safeError(error) {
  const code = Object.hasOwn(MESSAGES, error?.code)
    ? error.code
    : error?.code === "CANCELLED"
      ? "ACCOUNT_CHANGED"
      : error?.code === "REQUEST_FAILED"
        ? "REQUEST_REJECTED"
        : "NETWORK_ERROR";
  return { code, message: MESSAGES[code] };
}
function numeric(value, code = "INVALID_INPUT") {
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
function text(value, fallback) {
  if (typeof value !== "string") return fallback;
  return (
    value
      .replace(/[\0-\x1f\x7f]/g, " ")
      .trim()
      .slice(0, 200) || fallback
  );
}
function checkResult(data, { empty = false } = {}) {
  if (empty && data === null) return;
  if (!object(data)) throw failure("INVALID_RESPONSE");
  if (
    (data.result !== undefined && data.result !== "OK") ||
    data.error ||
    (data.errors && (!Array.isArray(data.errors) || data.errors.length))
  )
    throw failure("REQUEST_REJECTED");
}

function createPdxSubscriptions({
  account,
  isGameRunning = async () => false,
} = {}) {
  if (
    typeof account?.request !== "function" ||
    typeof account?.getAccount !== "function" ||
    typeof isGameRunning !== "function"
  )
    throw failure("INVALID_INPUT");
  let queue = Promise.resolve();
  let sequence = 0;
  let cache = null;
  let lastMutation = null;

  async function readAccount() {
    const snapshot = await account.getAccount();
    if (snapshot?.status !== "signed-in") return null;
    const id = snapshot.account?.id;
    if (
      typeof id !== "string" ||
      !id ||
      id.length > 200 ||
      /[\0-\x1f\x7f]/.test(id)
    )
      throw failure("ACCOUNT_UNKNOWN");
    return id;
  }
  async function assertAccount(expected) {
    const current = await readAccount();
    if (current !== expected) {
      cache = null;
      throw failure("ACCOUNT_CHANGED");
    }
    return current;
  }
  function schedule(work) {
    const ticket = ++sequence;
    // Capture the account when called, before waiting behind another operation.
    // Actual API requests remain serialized; account.request enforces this ID atomically.
    const binding = readAccount();
    binding.catch(() => {});
    const result = queue.then(() => work(binding, ticket));
    queue = result.catch(() => {});
    return result;
  }
  function request(owner, input) {
    return account.request({ ...input, expectedAccountId: owner });
  }
  async function metadata(owner, modId, revision) {
    const data = await request(owner, {
      path: "/mods",
      query: { modId, ...(revision ? { modVersion: revision } : {}) },
    });
    checkResult(data);
    const detail = data.modDetail;
    if (!object(detail) || numeric(detail.modId, "INVALID_RESPONSE") !== modId)
      throw failure("INVALID_RESPONSE");
    if (detail.game !== "hoi4") throw failure("WRONG_GAME");
    if (revision && numeric(detail.modVersion, "INVALID_RESPONSE") !== revision)
      throw failure("INVALID_RESPONSE");
    return detail;
  }
  async function defaultSet(owner) {
    const data = await request(owner, {
      path: "/mods/sets/list/hoi4",
      query: { includeShared: true },
    });
    checkResult(data);
    if (!Array.isArray(data.sets) || data.sets.length > 1000)
      throw failure("INVALID_RESPONSE");
    if (!data.sets.length) return null;
    // The official HOI4 default is the sole returned set, not a name or an isDefault flag.
    if (data.sets.length !== 1) throw failure("DEFAULT_SET_UNAVAILABLE");
    const set = data.sets[0];
    if (!object(set)) throw failure("INVALID_RESPONSE");
    if (
      set.owned === false ||
      ["removedByUser", "disabledByManager"].includes(set.state) ||
      (set.game !== undefined && set.game !== "hoi4") ||
      (set.gameName !== undefined && set.gameName !== "hoi4")
    )
      throw failure("DEFAULT_SET_UNAVAILABLE");
    return {
      id: numeric(set.id, "INVALID_RESPONSE"),
      ...(set.preferredVersion != null
        ? { revision: numeric(set.preferredVersion, "INVALID_RESPONSE") }
        : {}),
    };
  }
  async function load(owner) {
    const set = await defaultSet(owner);
    const items = [];
    const seen = new Set();
    if (set) {
      let ended = false;
      for (let page = 1; page <= MAX_PAGES; page++) {
        const data = await request(owner, {
          path: `/mods/sets/${set.id}/mods`,
          query: {
            limit: PAGE_SIZE,
            page,
            ...(set.revision ? { version: set.revision } : {}),
          },
        });
        checkResult(data);
        if (
          !Array.isArray(data.mods) ||
          data.mods.length > PAGE_SIZE ||
          (data.count !== undefined &&
            (!Number.isSafeInteger(data.count) ||
              data.count < 0 ||
              data.count > MAX_ITEMS))
        )
          throw failure("INVALID_RESPONSE");
        if (!data.mods.length) {
          ended = true;
          break;
        }
        for (const row of data.mods) {
          if (!object(row)) throw failure("INVALID_RESPONSE");
          const modId = numeric(row.modId, "INVALID_RESPONSE");
          if (seen.has(modId) || seen.size >= MAX_ITEMS)
            throw failure("INVALID_RESPONSE");
          seen.add(modId);
          if (row.game !== undefined && row.game !== "hoi4")
            throw failure("WRONG_GAME");
          // Older set responses do not expose game; verify their IDs through metadata.
          if (row.game === undefined) await metadata(owner, modId);
          if (row.preferredVersion === undefined)
            throw failure("INVALID_RESPONSE");
          const title = text(row.displayName, "");
          items.push({
            modId,
            title: title || `Paradox 模组 ${modId}`,
            ...(!title ? { titleIsFallback: true } : {}),
            ...(row.preferredVersion !== null
              ? { revision: numeric(row.preferredVersion, "INVALID_RESPONSE") }
              : {}),
          });
        }
      }
      if (!ended) throw failure("INVALID_RESPONSE");
    }
    await assertAccount(owner);
    cache = { accountId: owner, items };
    return { state: clone(cache), set };
  }
  async function errorState(owner, error, extra) {
    let current = null;
    try {
      current = await readAccount();
    } catch {
      /* No previous account's cached list is exposed. */
    }
    cache = null;
    const state = {
      accountId: current === owner ? owner : null,
      items: [],
      error: { ...safeError(error), ...extra },
    };
    return state;
  }
  async function getState(options = {}) {
    if (
      !object(options) ||
      Object.keys(options).some((key) => key !== "refresh") ||
      (options.refresh !== undefined && typeof options.refresh !== "boolean")
    )
      throw failure("INVALID_INPUT");
    return schedule(async (binding) => {
      let owner = null;
      try {
        owner = await binding;
        if (!owner) {
          cache = null;
          return { accountId: null, items: [] };
        }
        await assertAccount(owner);
        if (!options.refresh && cache?.accountId === owner) return clone(cache);
        return (await load(owner)).state;
      } catch (error) {
        return errorState(owner, error);
      }
    });
  }
  async function mutate(action, modId, revision) {
    return schedule(async (binding, ticket) => {
      const owner = await binding;
      if (!owner) {
        cache = null;
        throw failure("NOT_SIGNED_IN");
      }
      await assertAccount(owner);
      const key = JSON.stringify([owner, action, modId, revision]);
      // Calls queued during the same write share its result, even if its refresh failed.
      if (lastMutation?.key === key && ticket <= lastMutation.through) {
        if (lastMutation.error) throw failure(lastMutation.error.code);
        return clone(lastMutation.state);
      }
      if (await isGameRunning()) throw failure("GAME_RUNNING");
      const detail = await metadata(
        owner,
        modId,
        action === "subscribe" ? revision : undefined,
      );
      if (
        action === "subscribe" &&
        (detail.state !== "published" ||
          detail.isRegionBlocked === true ||
          detail.actions?.canInstall === false)
      )
        throw failure("UNAVAILABLE");
      const { state: before, set } = await load(owner);
      const existing = before.items.find((item) => item.modId === modId);
      if (
        (action === "unsubscribe" && !existing) ||
        (action === "subscribe" && existing && existing.revision === revision)
      )
        return before;
      await assertAccount(owner);
      if (await isGameRunning()) throw failure("GAME_RUNNING");
      let accepted = false;
      let sent = false;
      let state;
      try {
        sent = true;
        const reply =
          action === "subscribe"
            ? await request(owner, {
                method: "POST",
                path: "/mods/installed",
                body: {
                  ...(set ? { activationSetId: Number(set.id) } : {}),
                  mods: [
                    {
                      id: Number(modId),
                      ...(revision ? { version: Number(revision) } : {}),
                    },
                  ],
                },
              })
            : await request(owner, {
                method: "DELETE",
                path: "/mods/installed",
                query: { modId, ...(set ? { activationSetId: set.id } : {}) },
              });
        checkResult(reply, { empty: action === "unsubscribe" });
        if (action === "subscribe") {
          if (
            !Array.isArray(reply.mods) ||
            !reply.mods.some(
              (item) =>
                object(item) &&
                numeric(item.id, "INVALID_RESPONSE") === modId &&
                !item.error,
            )
          )
            throw failure("INVALID_RESPONSE");
        }
        accepted = true;
        cache = null;
        const refreshed = await load(owner);
        state = refreshed.state;
        const after = state.items.find((item) => item.modId === modId);
        if (
          (action === "subscribe" && (!after || after.revision !== revision)) ||
          (action === "unsubscribe" && after)
        )
          state.error = {
            code: "WRITE_NOT_YET_VISIBLE",
            message: MESSAGES.WRITE_NOT_YET_VISIBLE,
            writeSucceeded: true,
            operation: action,
            modId,
          };
        cache = clone(state);
      } catch (error) {
        if (accepted) {
          const code = [
            "ACCOUNT_CHANGED",
            "CANCELLED",
            "NOT_SIGNED_IN",
            "SESSION_EXPIRED",
          ].includes(error?.code)
            ? "ACCOUNT_CHANGED_AFTER_WRITE"
            : "REFRESH_FAILED_AFTER_WRITE";
          state = await errorState(owner, failure(code), {
            writeSucceeded: true,
            operation: action,
            modId,
          });
        } else if (
          sent &&
          ![
            "REQUEST_REJECTED",
            "REQUEST_FAILED",
            "ACCESS_DENIED",
            "NOT_SIGNED_IN",
            "SESSION_EXPIRED",
            "ACCOUNT_CHANGED",
            "RATE_LIMITED",
          ].includes(error?.code)
        ) {
          state = await errorState(owner, failure("MUTATION_UNKNOWN"), {
            outcomeUnknown: true,
            operation: action,
            modId,
          });
        } else {
          cache = null;
          lastMutation = { key, through: sequence, error: safeError(error) };
          throw failure(safeError(error).code);
        }
      }
      lastMutation = { key, through: sequence, state: clone(state) };
      return state;
    }).catch((error) => {
      throw failure(safeError(error).code);
    });
  }
  return {
    getState,
    subscribe(input) {
      if (
        !object(input) ||
        Object.keys(input).some((key) => !["modId", "revision"].includes(key))
      )
        return Promise.reject(failure("INVALID_INPUT"));
      try {
        return mutate(
          "subscribe",
          numeric(input.modId),
          input.revision === undefined ? undefined : numeric(input.revision),
        );
      } catch (error) {
        return Promise.reject(error);
      }
    },
    unsubscribe(modId) {
      try {
        return mutate("unsubscribe", numeric(modId));
      } catch (error) {
        return Promise.reject(error);
      }
    },
  };
}

module.exports = { createPdxSubscriptions };
