"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createDisplayService } = require("../electron/display-service.cjs");

const record = (patch = {}) => ({
  deviceName: "\\\\.\\DISPLAY1",
  name: "测试显示器",
  primary: true,
  width: 1920,
  height: 1080,
  refreshRate: 144,
  modes: [
    { width: 1920, height: 1080, refreshRate: 60 },
    { width: 1920, height: 1080, refreshRate: 144 },
    { width: 1920, height: 1080, refreshRate: 144 },
    { width: 1280, height: 720, refreshRate: 60 },
  ],
  ...patch,
});

function serviceFor(records, captured = []) {
  return createDisplayService({
    execFileImpl: (file, args, options, callback) => {
      captured.push({ file, args, options });
      queueMicrotask(() =>
        callback(
          null,
          typeof records === "string" ? records : JSON.stringify(records),
        ),
      );
    },
  });
}

test("display query is fixed, hidden, noninteractive and bounded", async () => {
  const captured = [];
  await serviceFor([record()], captured).getDisplays();
  const call = captured[0];
  assert.match(call.file, /WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/);
  assert.equal(call.options.windowsHide, true);
  assert.equal(call.options.timeout, 12000);
  assert.equal(call.options.shell, undefined);
  assert.ok(call.args.includes("-NoProfile"));
  assert.ok(call.args.includes("-NonInteractive"));
  const script = Buffer.from(call.args.at(-1), "base64").toString("utf16le");
  assert.match(script, /EnumDisplaySettingsExW/);
  assert.match(script, /EnumDisplayMonitors/);
  assert.doesNotMatch(
    script,
    /ChangeDisplaySettings|SetDisplayConfig|SendKeys|Start-Process/,
  );
});

test("modes retain physical dimensions and Hz with deterministic deduplication", async () => {
  const [display] = await serviceFor([
    record({
      modes: [
        ...record().modes,
        { width: 2560, height: 1440, refreshRate: 59.94 },
        { width: 2560, height: 1440, refreshRate: 60 },
        { width: 1, height: 1, refreshRate: 60 },
        { width: 1920, height: 1080, refreshRate: 99999 },
      ],
    }),
  ]).getDisplays();
  assert.equal(display.index, 0);
  assert.equal(display.currentResolution, "1920x1080");
  assert.equal(display.currentRefreshRate, 144);
  assert.deepEqual(display.resolutions, ["2560x1440", "1920x1080", "1280x720"]);
  assert.deepEqual(display.refreshRatesByResolution["1920x1080"], [144, 60]);
  assert.deepEqual(display.refreshRatesByResolution["2560x1440"], [60, 59.94]);
  assert.ok(display.name.includes("测试显示器"));
});

test("primary monitor is first and remaining monitors retain native enumeration order", async () => {
  const results = await serviceFor([
    record({ deviceName: "\\\\.\\DISPLAY3", name: "Left", primary: false }),
    record({ deviceName: "\\\\.\\DISPLAY2", name: "Main", primary: true }),
    record({ deviceName: "\\\\.\\DISPLAY1", name: "Right", primary: false }),
  ]).getDisplays();
  assert.match(results[0].name, /^Main/);
  assert.match(results[1].name, /^Left/);
  assert.match(results[2].name, /^Right/);
  assert.deepEqual(
    results.map((item) => item.index),
    [0, 1, 2],
  );
});

test("current mode is retained when driver omits it and default rates are not invented", async () => {
  const [display] = await serviceFor([
    record({
      width: 3840,
      height: 2160,
      refreshRate: 1,
      modes: [{ width: 3840, height: 2160, refreshRate: 0 }],
    }),
  ]).getDisplays();
  assert.equal(display.currentRefreshRate, 0);
  assert.deepEqual(display.resolutions, ["3840x2160"]);
  assert.deepEqual(display.refreshRatesByResolution["3840x2160"], []);
});

test("successful queries cache for sixty seconds and callers cannot mutate the cache", async () => {
  const captured = [];
  const service = serviceFor([record()], captured);
  const first = await service.getDisplays();
  first[0].name = "mutated";
  first[0].resolutions.push("999x999");
  first[0].refreshRatesByResolution["1920x1080"].push(333);
  const second = await service.getDisplays();
  assert.equal(captured.length, 1);
  assert.notEqual(second[0].name, "mutated");
  assert.ok(!second[0].resolutions.includes("999x999"));
  assert.deepEqual(second[0].refreshRatesByResolution["1920x1080"], [144, 60]);
});

test("concurrent callers share a single query and receive independent results", async () => {
  let callback,
    calls = 0;
  const service = createDisplayService({
    execFileImpl: (_file, _args, _options, cb) => {
      calls++;
      callback = cb;
    },
  });
  const first = service.getDisplays(),
    second = service.getDisplays();
  assert.equal(calls, 1);
  callback(null, JSON.stringify([record()]));
  const [a, b] = await Promise.all([first, second]);
  a[0].primary = false;
  assert.equal(b[0].primary, true);
});

test("cached modes are re-enumerated after sixty seconds", async (t) => {
  let now = 1_000_000;
  t.mock.method(Date, "now", () => now);
  const captured = [];
  const service = serviceFor([record()], captured);
  await service.getDisplays();
  now += 59_999;
  await service.getDisplays();
  assert.equal(captured.length, 1);
  now += 1;
  await service.getDisplays();
  assert.equal(captured.length, 2);
});

test("invalid output and empty monitor lists reject with actionable messages", async () => {
  for (const output of [
    "not json",
    "{}",
    "[]",
    [record({ width: 0 })],
    [record({ modes: null })],
    [record({ deviceName: "fake" })],
    [record(), record()],
  ]) {
    await assert.rejects(serviceFor(output).getDisplays(), /Windows|显示器/);
  }
  const [withBom] = await serviceFor(
    "\uFEFF" + JSON.stringify([record()]),
  ).getDisplays();
  assert.equal(withBom.index, 0);
});

test("timeouts and failures are not cached and stderr is not exposed", async () => {
  let calls = 0;
  const service = createDisplayService({
    execFileImpl: (_file, _args, _options, callback) => {
      calls++;
      if (calls === 1)
        callback(
          Object.assign(new Error("raw system detail"), { killed: true }),
          "",
          "secret-like stderr",
        );
      else callback(null, JSON.stringify([record()]));
    },
  });
  await assert.rejects(service.getDisplays(), (error) => {
    assert.match(error.message, /超时/);
    assert.doesNotMatch(error.message, /raw|stderr/);
    return true;
  });
  assert.equal((await service.getDisplays()).length, 1);
  assert.equal(calls, 2);
});

test("missing runtime and synchronous execution errors remain actionable", async () => {
  const missing = createDisplayService({
    execFileImpl: (_file, _args, _options, callback) =>
      callback(Object.assign(new Error("missing"), { code: "ENOENT" })),
  });
  await assert.rejects(missing.getDisplays(), /找不到 Windows PowerShell/);
  const failed = createDisplayService({
    execFileImpl: () => {
      throw new Error("do not expose me");
    },
  });
  await assert.rejects(failed.getDisplays(), /检查显示驱动/);
});
