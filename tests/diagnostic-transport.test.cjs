"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {
  diagnostic,
  diagnosticError,
  plainDiagnostic,
  errorDiagnostic,
  sequence,
} = require("../electron/diagnostic-message.cjs");
const core = import("../src/i18n-core.mjs");
const mainSource = fs.readFileSync(
  path.join(__dirname, "../electron/main.cjs"),
  "utf8",
);
const preloadSource = fs.readFileSync(
  path.join(__dirname, "../electron/preload.cjs"),
  "utf8",
);

function loadPreload(invoke) {
  let api;
  vm.runInNewContext(
    preloadSource,
    {
      Error,
      require(name) {
        assert.equal(
          name,
          "electron",
          "sandbox preload must only use its Electron bridge",
        );
        return {
          contextBridge: {
            exposeInMainWorld(name, value) {
              assert.equal(name, "launcher");
              assert.equal(api, undefined);
              api = value;
            },
          },
          ipcRenderer: { invoke },
        };
      },
    },
    { filename: "electron/preload.cjs" },
  );
  return api;
}

function transport(callback, channel = "launcher:save") {
  const handlers = new Map(),
    events = [],
    replies = [],
    callbacks = [];
  const mainWindow = { webContents: { mainFrame: {} } };
  let sender = {
    sender: mainWindow.webContents,
    senderFrame: mainWindow.webContents.mainFrame,
  };
  // Execute the actual production handler registration. Full main boot and
  // native windows are tested elsewhere; no Electron runtime is loaded here.
  const start = mainSource.indexOf("    const handle = (name, callback) =>");
  const end = mainSource.indexOf(
    "    async function assertUpdateInstallAllowed()",
    start,
  );
  assert.ok(start >= 0 && end > start, "production IPC wrapper must be found");
  const register = vm.runInNewContext(
    `(function () { ${mainSource.slice(start, end)}; return handle; })()`,
    {
      Error,
      mainWindow,
      installingLauncherUpdate: false,
      activeMutations: 0,
      passiveChannels: new Set(),
      plainDiagnostic,
      recordEvent: (...args) => events.push(args),
      ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    },
    { filename: "electron/main.cjs:IPC-handler" },
  );
  register(channel, (...args) => {
    callbacks.push(args);
    return callback(...args);
  });
  const api = loadPreload(async (name, ...args) => {
    assert.equal(name, channel);
    try {
      const reply = await handlers.get(name)(sender, ...args);
      // Plain values cross IPC. Error custom properties, causes and codes do
      // not survive native invoke rejection, which is emulated below.
      const transmitted = structuredClone(reply);
      replies.push(transmitted);
      return transmitted;
    } catch (error) {
      throw new Error(
        `Error invoking remote method '${name}': Error: ${error.message}`,
      );
    }
  });
  return {
    api,
    events,
    replies,
    callbacks,
    untrustedSender() {
      sender = { ...sender, sender: {} };
    },
    untrustedFrame() {
      sender = { ...sender, senderFrame: {} };
    },
  };
}

const pathValue = "C:\\用户\\设置，但总览 {1}\\pdx_settings.txt";
const nested = () =>
  diagnosticError("无法安全修改游戏设置，请修复该文件：{0}。{1}", [
    pathValue,
    diagnostic("PDS 配置存在未闭合的块。"),
  ]);

test("nested application errors survive plain IPC transport and reject the public preload API", async () => {
  const { formatDiagnostic, translate } = await core;
  const source = Object.assign(nested(), {
    code: "SETTINGS_INVALID",
    cause: new Error("private provider cause"),
    credentials: "private provider credentials",
  });
  const f = transport(() => {
    throw source;
  });
  let success = 0,
    received;
  await f.api.saveSettings({ gameOptions: { vsync: true } }).then(
    () => success++,
    (error) => {
      received = error;
    },
  );
  assert.equal(
    success,
    0,
    "an error envelope must not trigger a success continuation",
  );
  assert.ok(received instanceof Error);
  assert.equal(received.message, source.message);
  assert.equal(received.code, "SETTINGS_INVALID");
  assert.deepEqual(received.diagnostic, source.diagnostic);
  assert.equal(received.cause, undefined);
  assert.equal(received.credentials, undefined);
  assert.equal(f.replies.length, 1);
  assert.deepEqual(Object.keys(f.replies[0]).sort(), [
    "__ironcladDiagnosticError",
    "code",
    "diagnostic",
    "message",
  ]);
  assert.doesNotMatch(JSON.stringify(f.replies), /private provider/);
  for (const language of ["en", "de", "fr"]) {
    assert.equal(
      formatDiagnostic(language, received.diagnostic, received.message),
      translate(language, "无法安全修改游戏设置，请修复该文件：{0}。{1}", [
        pathValue,
        translate(language, "PDS 配置存在未闭合的块。"),
      ]),
    );
    assert.ok(
      formatDiagnostic(language, received.diagnostic).includes(pathValue),
    );
  }
  assert.deepEqual(
    f.events.map(([name, status]) => [name, status]),
    [["launcher:save", "error"]],
  );
});

test("literal strings and raw errors are not recursively recognized as translation keys", async () => {
  const { formatDiagnostic, translate } = await core;
  const literal = "设置";
  const looksLikeDiagnostic = "PDS 配置存在未闭合的块。";
  const input = diagnostic("{0} 当前显示上次缓存。", [
    sequence([
      literal,
      " / ",
      pathValue,
      " / ",
      errorDiagnostic(new Error(looksLikeDiagnostic)),
    ]),
  ]);
  for (const language of ["en", "de", "fr", "zh-hant"]) {
    assert.equal(
      formatDiagnostic(language, input),
      translate(language, "{0} 当前显示上次缓存。", [
        literal + " / " + pathValue + " / " + looksLikeDiagnostic,
      ]),
    );
  }
});

function invalidDiagnostics() {
  const cyclic = { kind: "sequence", parts: [] };
  cyclic.parts.push(cyclic);
  let deep = { kind: "literal", text: "literal" };
  for (let i = 0; i < 10; i++) deep = { kind: "sequence", parts: [deep] };
  return [
    undefined,
    null,
    "设置",
    [],
    { kind: "message", key: "unknown application text", values: [] },
    ...["constructor", "__proto__", "toString"].map((key) => ({
      kind: "message",
      key,
      values: [],
    })),
    { kind: "literal", text: "x".repeat(8193) },
    { kind: "message", key: "设置", values: null },
    { kind: "message", key: "设置", values: Array(65).fill("x") },
    { kind: "message", key: "设置", values: [Infinity] },
    {
      kind: "sequence",
      parts: Array(64).fill({ kind: "sequence", parts: ["a", "b"] }),
    },
    {
      get kind() {
        throw new Error("private getter failure");
      },
    },
    deep,
    cyclic,
  ];
}

test("invalid metadata falls back through ordinary invoke rejection and renderer fallback", async () => {
  const { formatDiagnostic } = await core;
  for (const value of invalidDiagnostics()) {
    assert.equal(plainDiagnostic(value), null);
    assert.equal(
      formatDiagnostic("en", value, "unchanged fallback 设置"),
      "unchanged fallback 设置",
    );
    const f = transport(() => {
      throw Object.assign(new Error("unchanged legacy message 设置"), {
        diagnostic: value,
        cause: "private cause",
        code: "PRIVATE_CODE",
      });
    });
    await assert.rejects(f.api.saveSettings({}), (error) => {
      assert.match(error.message, /unchanged legacy message 设置$/);
      assert.equal(error.diagnostic, undefined);
      assert.equal(error.code, undefined);
      assert.equal(error.cause, undefined);
      assert.doesNotMatch(
        JSON.stringify(error),
        /private cause|getter failure/,
      );
      return true;
    });
    assert.deepEqual(f.replies, []);
  }
});

test("valid diagnostic cloning strips extra properties without interpreting their values", async () => {
  const { formatDiagnostic } = await core;
  const input = {
    kind: "message",
    key: "{0} 当前显示上次缓存。",
    values: [{ kind: "literal", text: pathValue, secret: "private extra" }],
    cause: "private cause",
    token: "private credential",
  };
  const checked = plainDiagnostic(input);
  assert.deepEqual(checked, {
    kind: "message",
    key: input.key,
    values: [{ kind: "literal", text: pathValue }],
  });
  assert.doesNotMatch(JSON.stringify(checked), /private/);
  assert.equal(
    formatDiagnostic("en", checked),
    `${pathValue} Showing the previous cached data.`,
  );
});

test("all exposed preload methods use a fixed named channel and preserve normal success values", async () => {
  const calls = [];
  const api = loadPreload(async (channel, ...args) => {
    calls.push({ channel, args });
    return {
      channel,
      ok: true,
      __ironcladDiagnosticError: 0,
      error: "ordinary result field",
    };
  });
  assert.equal(api.invoke, undefined);
  assert.equal(api.ipcRenderer, undefined);
  assert.equal(api.request, undefined);
  for (const method of Object.values(api)) {
    assert.equal(typeof method, "function");
    const result = await method(
      "user-controlled:not-an-ipc-route",
      { path: "C:\\设置" },
      "extra",
    );
    assert.equal(result.ok, true);
    assert.equal(result.error, "ordinary result field");
  }
  assert.equal(calls.length, Object.keys(api).length);
  assert.equal(new Set(calls.map(({ channel }) => channel)).size, calls.length);
  for (const { channel } of calls) {
    assert.match(channel, /^[a-z][a-z-]*:[a-z][a-z-]*$/);
    assert.notEqual(channel, "user-controlled:not-an-ipc-route");
  }
});

test("the real main wrapper rejects an untrusted sender or frame before executing a callback", async () => {
  for (const change of ["untrustedSender", "untrustedFrame"]) {
    const f = transport(() => {
      throw nested();
    });
    f[change]();
    await assert.rejects(f.api.saveSettings({}), /无法识别的窗口请求/);
    assert.deepEqual(f.callbacks, []);
    assert.deepEqual(f.events, []);
    assert.deepEqual(f.replies, []);
  }
});

test("unsafe error codes are omitted from otherwise valid diagnostic envelopes", async () => {
  for (const code of [
    "private code with spaces",
    "token=secret",
    "x",
    "A".repeat(81),
    9,
    null,
  ]) {
    const f = transport(() => {
      throw Object.assign(nested(), { code });
    });
    await assert.rejects(f.api.saveSettings({}), (error) => {
      assert.equal(error.code, undefined);
      assert.ok(error.diagnostic);
      return true;
    });
    assert.equal(Object.hasOwn(f.replies[0], "code"), false);
  }
});
