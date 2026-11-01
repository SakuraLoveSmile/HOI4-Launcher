"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { EventEmitter } = require("node:events");
const { createLauncherService } = require("../electron/launcher-service.cjs");
const gameSupport = require("../electron/game-support.cjs");
const {
  captureEnvironment,
  compareEnvironments,
} = require("../electron/launch-environment.cjs");

async function fixture(t, { spawnError = false, keepAlive = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ironclad-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const documents = path.join(root, "中文 Documents");
  const userData = path.join(
    documents,
    "Paradox Interactive",
    "Hearts of Iron IV",
  );
  const steam = path.join(root, "Steam Client");
  const library = path.join(root, "第二 Steam Library");
  const game = path.join(library, "steamapps", "common", "Hearts of Iron IV");
  const settingsPath = path.join(root, "launcher", "settings.json");
  const calls = [];
  const write = async (target, text) => {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, text);
    return target;
  };
  const spawnProcess = (executable, args, options) => {
    calls.push({ executable, args, options });
    const child = new EventEmitter();
    calls.at(-1).child = child;
    child.pid = 43210;
    child.unref = () => {
      child.unreferenced = true;
      if (!keepAlive) queueMicrotask(() => child.emit("exit", 0));
    };
    process.nextTick(() =>
      spawnError
        ? child.emit(
            "error",
            Object.assign(new Error("fake spawn failure"), { code: "EACCES" }),
          )
        : child.emit("spawn"),
    );
    return child;
  };
  const serviceOptions = {
    settingsPath,
    documentsPath: documents,
    steamRoots: [steam],
    spawnProcess,
  };
  const service = createLauncherService(serviceOptions);
  const installGame = async () => {
    await write(
      path.join(steam, "steamapps", "libraryfolders.vdf"),
      '"libraryfolders" { "0" { "path" ' + JSON.stringify(library) + " } }",
    );
    await write(
      path.join(library, "steamapps", "appmanifest_394360.acf"),
      '"AppState" { "appid" "394360" "installdir" "Hearts of Iron IV" }',
    );
    await write(
      path.join(game, "hoi4.exe"),
      "not an executable; must never be run",
    );
    await write(
      path.join(game, "launcher-settings.json"),
      JSON.stringify({ rawVersion: "1.17.1" }),
    );
  };
  const workshop = async (id, extra = "") => {
    const folder = path.join(
      library,
      "steamapps",
      "workshop",
      "content",
      "394360",
      id,
    );
    await write(
      path.join(folder, "descriptor.mod"),
      'name="Workshop ' +
        id +
        '"\nsupported_version="1.17.*"\ntags={"Alternative History" "中文"}\n' +
        extra,
    );
    return folder;
  };
  return {
    root,
    documents,
    userData,
    steam,
    library,
    game,
    settingsPath,
    calls,
    write,
    service,
    serviceOptions,
    installGame,
    workshop,
  };
}

test("a missing installation is read-only and defaults to an empty playset", async (t) => {
  const f = await fixture(t);
  const result = await f.service.getState();
  assert.equal(result.game.found, false);
  assert.deepEqual(result.mods, []);
  assert.equal(result.settings.playsets[0].name, "默认预设");
  assert.deepEqual(result.settings.launcherPreferences, {
    closeOnLaunch: false,
    language: "zh-hans",
  });
  assert.equal(f.calls.length, 0);
  await assert.rejects(fs.stat(f.settingsPath), { code: "ENOENT" });
  await assert.rejects(fs.stat(f.userData), { code: "ENOENT" });
  await assert.rejects(f.service.launchGame(), /先选择/);
});

for (const source of ["workshop", "registered-workshop", "local", "pdx"]) {
  test(`descriptor load-order declarations are not required dependencies (${source})`, async (t) => {
    const f = await fixture(t);
    await f.installGame();
    const original = await fs.readFile(
      path.join(
        __dirname,
        "fixtures/mod-descriptors/fps-booster-cpu-ai-lite.mod",
      ),
      "utf8",
    );
    let descriptor;
    let id;
    if (source.includes("workshop")) {
      const content = await f.workshop("3766377228");
      descriptor = await f.write(
        path.join(content, "descriptor.mod"),
        original,
      );
      id = "workshop:3766377228";
      if (source === "registered-workshop") {
        descriptor = await f.write(
          path.join(f.userData, "mod", "ugc_3766377228.mod"),
          original + `path="${content.replace(/\\/g, "/")}"\n`,
        );
      }
    } else {
      const file = source === "pdx" ? "pdx_3766377228.mod" : "booster.mod";
      id = source === "pdx" ? "pdx:3766377228" : "local:booster.mod";
      descriptor = await f.write(
        path.join(f.userData, "mod", file),
        original.replace(/^remote_file_id=.*\n?/m, "") + 'path="mod/booster"\n',
      );
      await f.write(
        path.join(f.userData, "mod", "booster", "data.txt"),
        "fixture",
      );
    }
    for (const [file, name] of [
      ["road", "The Road to 56"],
      ["kaiser", "Kaiserreich"],
    ]) {
      await f.write(
        path.join(f.userData, "mod", `${file}.mod`),
        `name="${name}"\npath="mod/${file}"\n`,
      );
      await f.write(path.join(f.userData, "mod", file, "data.txt"), "fixture");
    }
    await f.service.saveSettings({
      playsets: [
        {
          id: "default",
          name: "Optional compatibility",
          modOrder: ["local:road.mod", id, "local:kaiser.mod"],
          modIds: ["local:road.mod", id],
        },
      ],
    });
    const descriptorBefore = await fs.readFile(descriptor);
    const settingsBefore = await fs.readFile(f.settingsPath);
    const result = await f.service.getState();
    const booster = result.mods.find((mod) => mod.id === id);
    assert.equal(booster.available, true);
    assert.equal(booster.dependencies.length, 50);
    assert.deepEqual(booster.dependencies.slice(0, 3), [
      "The Road to 56",
      "Kaiserreich",
      "Kaiserredux",
    ]);
    assert.deepEqual(booster.missingDependencies, []);
    assert.equal(
      result.warnings.some((message) => /依赖/.test(message)),
      false,
    );
    assert.deepEqual(result.settings.playsets[0].modIds, [
      "local:road.mod",
      id,
    ]);
    assert.deepEqual(await fs.readFile(descriptor), descriptorBefore);
    assert.deepEqual(await fs.readFile(f.settingsPath), settingsBefore);
    assert.equal(f.calls.length, 0);
    await assert.rejects(fs.stat(path.join(f.userData, "dlc_load.json")), {
      code: "ENOENT",
    });
  });
}

test("display aliases persist without rewriting mod metadata or source names", async (t) => {
  const f = await fixture(t);
  await f.installGame();
  const core = path.join(f.userData, "mod", "core.mod");
  const addon = path.join(f.userData, "mod", "addon.mod");
  await f.write(core, 'name="Core"\npath="mod/core"');
  await f.write(addon, 'name="Addon"\npath="mod/addon"\ndependencies={"Core"}');
  await f.write(path.join(f.userData, "mod", "core", "data.txt"), "core");
  await f.write(path.join(f.userData, "mod", "addon", "data.txt"), "addon");
  await f.service.saveSettings({
    playsets: [
      {
        id: "default",
        name: "campaign",
        modIds: ["local:core.mod", "local:addon.mod"],
      },
    ],
  });
  const bytes = await fs.readFile(core);
  const result = await f.service.setModDisplayName({
    modId: "local:core.mod",
    name: "  核心汉化  ",
    kind: "translated",
  });
  assert.equal(
    result.mods.find((mod) => mod.id === "local:core.mod").name,
    "核心汉化",
  );
  assert.equal(
    result.mods.find((mod) => mod.id === "local:core.mod").originalName,
    "Core",
  );
  assert.deepEqual(
    result.mods.find((mod) => mod.id === "local:addon.mod").missingDependencies,
    [],
  );
  assert.deepEqual(
    result.mods.find((mod) => mod.id === "local:addon.mod").dependencies,
    ["Core"],
  );
  assert.deepEqual(await fs.readFile(core), bytes);
  const reopened = createLauncherService(f.serviceOptions);
  assert.equal(
    (await reopened.getState()).mods.find((mod) => mod.id === "local:core.mod")
      .name,
    "核心汉化",
  );
  await f.write(core, 'name="Core updated by author"\npath="mod/core"');
  const reset = await reopened.resetModDisplayName("local:core.mod");
  assert.equal(
    reset.mods.find((mod) => mod.id === "local:core.mod").name,
    "Core updated by author",
  );
  assert.equal(
    reset.mods.find((mod) => mod.id === "local:core.mod").displayNameKind,
    null,
  );
});

test("display names remain private to their version instance", async (t) => {
  const f = await fixture(t);
  await f.installGame();
  await f.workshop("123");
  await f.service.getState();
  await f.service.setModDisplayName({
    modId: "workshop:123",
    name: "默认中文名",
    kind: "custom",
  });
  const created = await f.service.createGameInstance({
    name: "old",
    gameDirectory: f.game,
  });
  assert.deepEqual(created.settings.modDisplayNames, {});
  await f.service.setModDisplayName({
    modId: "workshop:123",
    name: "旧版中文名",
    kind: "translated",
  });
  const back = await f.service.switchGameInstance("default");
  assert.equal(
    back.mods.find((mod) => mod.id === "workshop:123").name,
    "默认中文名",
  );
  assert.equal(
    (await createLauncherService(f.serviceOptions).getState()).settings
      .modDisplayNames["workshop:123"].kind,
    "custom",
  );
});

test("invalid display names and unknown IDs leave settings untouched", async (t) => {
  const f = await fixture(t);
  await f.installGame();
  await f.workshop("123");
  await f.service.getState();
  const before = await fs.readFile(f.settingsPath, "utf8");
  for (const input of [
    { modId: "workshop:123", name: "", kind: "custom" },
    { modId: "workshop:123", name: "x".repeat(129), kind: "custom" },
    { modId: "workshop:123", name: "bad\nname", kind: "custom" },
    { modId: "workshop:123", name: "name", kind: "unknown" },
    { modId: "workshop:unknown", name: "name", kind: "custom" },
  ])
    await assert.rejects(f.service.setModDisplayName(input));
  assert.equal(await fs.readFile(f.settingsPath, "utf8"), before);
});

test("local mod deletion recycles files and removes all references only in the active instance", async (t) => {
  const f = await fixture(t);
  await f.installGame();
  const descriptor = path.join(f.userData, "mod", "a.mod");
  await f.write(descriptor, 'name="Local"\npath="mod/content"');
  await f.write(
    path.join(f.userData, "mod", "content", "data.txt"),
    "keep contents",
  );
  await f.service.saveSettings({
    playsets: [
      { id: "default", name: "one", modIds: ["local:a.mod"] },
      { id: "other", name: "two", modIds: [], modOrder: ["local:a.mod"] },
    ],
  });
  const result = await f.service.removeLocalMod("local:a.mod");
  assert.equal(
    result.state.mods.some((mod) => mod.id === "local:a.mod"),
    false,
  );
  assert.ok(
    result.state.settings.playsets.every(
      (playset) => !playset.modOrder.includes("local:a.mod"),
    ),
  );
  assert.equal(
    await fs.readFile(
      path.join(result.backupDirectory, "content", "data.txt"),
      "utf8",
    ),
    "keep contents",
  );
  assert.equal(
    await fs.readFile(
      path.join(result.backupDirectory, "registration.mod"),
      "utf8",
    ),
    'name="Local"\npath="mod/content"',
  );
  assert.deepEqual(
    JSON.parse(await fs.readFile(f.settingsPath, "utf8")),
    result.state.settings,
  );
});

test("local recycle rolls back file moves if the settings transaction cannot commit", async (t) => {
  const f = await fixture(t);
  await f.installGame();
  const descriptor = path.join(f.userData, "mod", "a.mod");
  await f.write(descriptor, 'name="Local"\npath="mod/content"');
  const content = await f.write(
    path.join(f.userData, "mod", "content", "data.txt"),
    "keep contents",
  );
  await f.service.saveSettings({
    playsets: [{ id: "default", name: "campaign", modIds: ["local:a.mod"] }],
  });
  const before = await fs.readFile(f.settingsPath, "utf8");
  const movedSettings = f.settingsPath + ".fixture-original";
  await fs.rename(f.settingsPath, movedSettings);
  await fs.mkdir(f.settingsPath);
  await assert.rejects(f.service.removeLocalMod("local:a.mod"), /已恢复原文件/);
  assert.equal(await fs.readFile(content, "utf8"), "keep contents");
  assert.equal(
    await fs.readFile(descriptor, "utf8"),
    'name="Local"\npath="mod/content"',
  );
  assert.equal(await fs.readFile(movedSettings, "utf8"), before);
  assert.deepEqual((await f.service.getState()).settings.playsets[0].modIds, [
    "local:a.mod",
  ]);
});

test("discovers an external Steam library with Unicode/spaces and persists first detection", async (t) => {
  const f = await fixture(t);
  await f.installGame();
  const result = await f.service.getState();
  assert.equal(result.game.found, true);
  assert.equal(result.game.directory, f.game);
  assert.equal(result.game.version, "1.17.1");
  assert.equal(
    JSON.parse(await fs.readFile(f.settingsPath, "utf8")).gameDirectory,
    f.game,
  );
  assert.equal(f.calls.length, 0);
  await assert.rejects(fs.stat(f.userData), { code: "ENOENT" });
});

test("manual directory and settings validation rejects invalid values without mutating saved data", async (t) => {
  const f = await fixture(t);
  await f.installGame();
  await f.service.getState();
  const before = await fs.readFile(f.settingsPath, "utf8");
  for (const patch of [
    { gameDirectory: f.root },
    { gameDirectory: "relative" },
    { launchMode: "shell" },
    { playsets: [] },
    { activePlaysetId: "absent" },
    { anything: true },
    { playsets: [{ id: "default", name: " ", modIds: [] }] },
    {
      playsets: [
        { id: "default", name: "a", modIds: [] },
        { id: "default", name: "b", modIds: [] },
      ],
    },
  ])
    await assert.rejects(f.service.saveSettings(patch));
  assert.equal(await fs.readFile(f.settingsPath, "utf8"), before);
  const saved = await f.service.saveSettings({
    launchMode: "debug",
    playsets: [
      {
        id: "custom",
        name: " 中国 战役 ",
        modIds: ["local:a.mod", "local:a.mod"],
      },
    ],
    activePlaysetId: "custom",
  });
  assert.equal(saved.launchMode, "debug");
  assert.equal(saved.playsets[0].name, "中国 战役");
  assert.deepEqual(saved.playsets[0].modIds, ["local:a.mod"]);
});

test("corrupted settings are reported and never overwritten by save, detect, or launch", async (t) => {
  const f = await fixture(t);
  await f.installGame();
  await f.write(f.settingsPath, "{ bad JSON");
  const result = await f.service.getState();
  assert.match(result.warnings.join(" "), /配置文件损坏/);
  await assert.rejects(
    f.service.saveSettings({ launchMode: "debug" }),
    /配置文件损坏/,
  );
  await assert.rejects(f.service.detectGame(), /配置文件损坏/);
  await assert.rejects(f.service.launchGame(), /配置文件损坏/);
  assert.equal(await fs.readFile(f.settingsPath, "utf8"), "{ bad JSON");
  assert.equal(f.calls.length, 0);
});

test("scans local/archive mods, tags and workshop without duplicate registered entries", async (t) => {
  const f = await fixture(t);
  await f.installGame();
  const remote = await f.workshop("1234");
  await f.workshop("5678");
  await f.write(
    path.join(f.userData, "mod", "本地.mod"),
    'name="本地模组"\npath="mod/中文 内容"\nsupported_version="1.16.*"\ntags={"Gameplay" "Balance"}\n',
  );
  await f.write(
    path.join(f.userData, "mod", "中文 内容", "data.txt"),
    "content",
  );
  await f.write(
    path.join(f.userData, "mod", "archive.mod"),
    'name="Archive"\narchive="mod/archive.zip"',
  );
  await f.write(path.join(f.userData, "mod", "archive.zip"), "archive");
  await f.write(
    path.join(f.userData, "mod", "ugc_1234.mod"),
    'name="已注册创意工坊"\npath=' +
      JSON.stringify(remote.replace(/\\/g, "/")) +
      '\nremote_file_id="1234"',
  );
  await f.write(
    path.join(f.userData, "mod", "missing.mod"),
    'name="Missing"\npath="mod/absent"',
  );
  const result = await f.service.getState();
  assert.equal(result.mods.length, 5);
  assert.equal(
    result.mods.filter((mod) => mod.id === "workshop:1234").length,
    1,
  );
  assert.equal(
    result.mods.find((mod) => mod.id === "workshop:1234").name,
    "已注册创意工坊",
  );
  assert.equal(
    result.mods.find((mod) => mod.id === "workshop:5678").available,
    true,
  );
  assert.deepEqual(
    result.mods.find((mod) => mod.id === "local:本地.mod").tags,
    ["Gameplay", "Balance"],
  );
  assert.equal(
    result.mods.find((mod) => mod.id === "local:archive.mod").available,
    true,
  );
  assert.equal(
    result.mods.find((mod) => mod.id === "local:missing.mod").available,
    false,
  );
  assert.equal(
    (await fs.readdir(path.join(f.userData, "mod"))).some((name) =>
      name.startsWith("ironclad_"),
    ),
    false,
  );
});

test("launch preserves DLC state, selected order, metadata, and exact backup while spawning only the configured executable", async (t) => {
  const f = await fixture(t);
  await f.installGame();
  await f.workshop(
    "5678",
    'replace_path="history/states"\ndependencies={"A dependency"}\npath="obsolete/path"\n',
  );
  await f.write(
    path.join(f.userData, "mod", "local.mod"),
    'name="Local"\npath="mod/local-content"',
  );
  await f.write(
    path.join(f.userData, "mod", "local-content", "content.txt"),
    "mod",
  );
  const loadPath = path.join(f.userData, "dlc_load.json");
  const previous =
    '{\n  "disabled_dlcs": ["dlc/a.dlc"], "enabled_mods": ["mod/old.mod"], "custom": {"keep": true}\n}\n';
  await f.write(loadPath, previous);
  await f.service.saveSettings({
    launchMode: "debug",
    playsets: [
      {
        id: "default",
        name: "战役",
        modIds: ["workshop:5678", "local:local.mod"],
      },
    ],
  });
  const result = await f.service.launchGame();
  const load = JSON.parse(await fs.readFile(loadPath, "utf8"));
  assert.deepEqual(load.disabled_dlcs, ["dlc/a.dlc"]);
  assert.deepEqual(load.custom, { keep: true });
  assert.deepEqual(load.enabled_mods, [
    "mod/ironclad_ugc_5678.mod",
    "mod/local.mod",
  ]);
  const files = await fs.readdir(f.userData);
  const backup = files.find((name) =>
    name.startsWith("dlc_load.json.ironclad-backup-"),
  );
  assert.equal(
    await fs.readFile(path.join(f.userData, backup), "utf8"),
    previous,
  );
  const generated = await fs.readFile(
    path.join(f.userData, "mod", "ironclad_ugc_5678.mod"),
    "utf8",
  );
  assert.match(generated, /replace_path="history\/states"/);
  assert.match(generated, /dependencies=\{"A dependency"\}/);
  assert.doesNotMatch(generated, /obsolete\/path/);
  assert.match(generated, /remote_file_id="5678"/);
  assert.equal((generated.match(/^path=/gm) || []).length, 1);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].executable, path.join(f.game, "hoi4.exe"));
  assert.deepEqual(f.calls[0].args, ["-debug"]);
  assert.equal(f.calls[0].options.cwd, f.game);
  assert.equal(f.calls[0].options.detached, true);
  assert.equal(result.pid, 43210);
  assert.equal(result.performanceContext.gameVersion, "1.17.1");
  assert.equal(result.performanceContext.playsetName, "战役");
  assert.equal(result.performanceContext.modCount, 2);
  assert.equal(result.performanceContext.launchMode, "debug");
  const environment = result.performanceContext.environment;
  assert.equal(environment.game.version, "1.17.1");
  assert.equal(environment.game.userData, f.userData);
  assert.deepEqual(
    environment.mods.map((mod) => mod.id),
    ["workshop:5678", "local:local.mod"],
  );
  assert.ok(
    environment.mods.every(
      (mod) =>
        mod.contentStatus === "not-recorded" && mod.contentDigest === null,
    ),
  );
  assert.equal(environment.launchMode, "debug");
  assert.equal(environment.playset.name, "战役");
  const rescanned = await f.service.getState();
  assert.equal(
    rescanned.mods.filter((mod) => mod.id === "workshop:5678").length,
    1,
  );
});

test("launching an empty playset disables previous mods and uses normal arguments", async (t) => {
  const f = await fixture(t);
  await f.installGame();
  await f.write(
    path.join(f.userData, "dlc_load.json"),
    '{"enabled_mods":["mod/stale.mod"],"disabled_dlcs":[]}',
  );
  await f.service.launchGame();
  const load = JSON.parse(
    await fs.readFile(path.join(f.userData, "dlc_load.json"), "utf8"),
  );
  assert.deepEqual(load.enabled_mods, []);
  assert.deepEqual(f.calls[0].args, []);
});

test("unavailable or removed selected mods prevent all launch writes", async (t) => {
  const f = await fixture(t);
  await f.installGame();
  const loadPath = path.join(f.userData, "dlc_load.json");
  await f.write(loadPath, '{"enabled_mods":[]}');
  await f.service.saveSettings({
    playsets: [
      { id: "default", name: "Default", modIds: ["workshop:missing"] },
    ],
  });
  assert.match(
    (await f.service.getState()).warnings.join(" "),
    /1 个模组不可用/,
  );
  await assert.rejects(f.service.launchGame(), /未安装/);
  assert.equal(await fs.readFile(loadPath, "utf8"), '{"enabled_mods":[]}');
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await fs.readdir(f.userData), ["dlc_load.json"]);
});

test("corrupted dlc_load.json is left intact and prevents spawn", async (t) => {
  const f = await fixture(t);
  await f.installGame();
  const loadPath = path.join(f.userData, "dlc_load.json");
  await f.write(loadPath, "invalid original content");
  await assert.rejects(f.service.launchGame(), /dlc_load.json 格式无效/);
  assert.equal(await fs.readFile(loadPath, "utf8"), "invalid original content");
  assert.equal(f.calls.length, 0);
});

test("spawn failure restores the original config and removes newly created workshop descriptors", async (t) => {
  const f = await fixture(t, { spawnError: true });
  await f.installGame();
  await f.workshop("5555");
  const original =
    '{ "enabled_mods": ["mod/old.mod"], "disabled_dlcs": ["old"] }';
  const loadPath = path.join(f.userData, "dlc_load.json");
  await f.write(loadPath, original);
  await f.service.saveSettings({
    playsets: [{ id: "default", name: "Default", modIds: ["workshop:5555"] }],
  });
  await assert.rejects(f.service.launchGame(), /已恢复原有模组配置/);
  assert.equal(await fs.readFile(loadPath, "utf8"), original);
  await assert.rejects(
    fs.stat(path.join(f.userData, "mod", "ironclad_ugc_5555.mod")),
    { code: "ENOENT" },
  );
  assert.equal(
    (await fs.readdir(f.userData)).filter((name) =>
      name.includes("ironclad-backup"),
    ).length,
    1,
  );
});

test("spawn failure on a first launch removes the new load configuration", async (t) => {
  const f = await fixture(t, { spawnError: true });
  await f.installGame();
  await assert.rejects(f.service.launchGame(), /已恢复原有模组配置/);
  await assert.rejects(fs.stat(path.join(f.userData, "dlc_load.json")), {
    code: "ENOENT",
  });
});

test("concurrent saves serialize patches and playsets persist across service instances", async (t) => {
  const f = await fixture(t);
  await f.installGame();
  await Promise.all([
    f.service.saveSettings({ launchMode: "debug" }),
    f.service.saveSettings({
      playsets: [{ id: "second", name: "第二预设", modIds: [] }],
      activePlaysetId: "second",
    }),
  ]);
  const reloaded = createLauncherService(f.serviceOptions);
  const result = await reloaded.getState();
  assert.equal(result.settings.launchMode, "debug");
  assert.equal(result.settings.activePlaysetId, "second");
  assert.equal(result.settings.playsets[0].name, "第二预设");
  assert.equal(
    (await fs.readdir(path.dirname(f.settingsPath))).some((name) =>
      name.includes(".tmp-"),
    ),
    false,
  );
});

test("a deleted game produces a warning while retaining its saved path", async (t) => {
  const f = await fixture(t);
  await f.installGame();
  await f.service.getState();
  await fs.unlink(path.join(f.game, "hoi4.exe"));
  const state = await f.service.getState();
  assert.equal(state.game.found, false);
  assert.equal(state.settings.gameDirectory, f.game);
  assert.match(state.warnings.join(" "), /hoi4.exe 不存在/);
  await assert.rejects(f.service.launchGame(), /先选择/);
});

test("explicit detection discovers a Steam library added after the initial scan", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.service.getState()).game.found, false);
  await f.installGame();
  assert.equal((await f.service.detectGame()).game.directory, f.game);
  assert.equal(
    JSON.parse(await fs.readFile(f.settingsPath, "utf8")).gameDirectory,
    f.game,
  );
});

test("failed launch restores a stale generated descriptor and preserves a user-owned name collision", async (t) => {
  const f = await fixture(t, { spawnError: true });
  await f.installGame();
  await f.workshop("7777");
  await f.workshop("8888");
  const managedPath = path.join(f.userData, "mod", "ironclad_ugc_7777.mod");
  const managedText =
    '# Managed by IRONCLAD.\nname="Old"\npath="missing/old-path"\nremote_file_id="7777"\n';
  const userPath = path.join(f.userData, "mod", "ironclad_ugc_8888.mod");
  const userText =
    'name="User-owned file"\npath="missing/user-path"\nremote_file_id="8888"\n';
  await f.write(managedPath, managedText);
  await f.write(userPath, userText);
  await f.service.saveSettings({
    playsets: [
      {
        id: "default",
        name: "Default",
        modIds: ["workshop:7777", "workshop:8888"],
      },
    ],
  });
  await assert.rejects(f.service.launchGame(), /已恢复原有模组配置/);
  assert.equal(await fs.readFile(managedPath, "utf8"), managedText);
  assert.equal(await fs.readFile(userPath, "utf8"), userText);
  const descriptorFiles = await fs.readdir(path.join(f.userData, "mod"));
  const descriptorBackup = descriptorFiles.find((name) =>
    name.startsWith("ironclad_ugc_7777.mod.ironclad-backup-"),
  );
  assert.ok(descriptorBackup);
  assert.equal(
    await fs.readFile(path.join(f.userData, "mod", descriptorBackup), "utf8"),
    managedText,
  );
  assert.deepEqual(
    descriptorFiles.filter((name) => name.endsWith(".mod")).sort(),
    ["ironclad_ugc_7777.mod", "ironclad_ugc_8888.mod"],
  );
});

test("managed workshop descriptors pick up updates and regenerate only on explicit launch", async (t) => {
  const f = await fixture(t);
  await f.installGame();
  const workshop = await f.workshop(
    "2468",
    'replace_path="old/content"\ndependencies={"Old dependency"}\n',
  );
  await f.service.saveSettings({
    playsets: [{ id: "default", name: "Default", modIds: ["workshop:2468"] }],
  });
  await f.service.launchGame();
  const managedPath = path.join(f.userData, "mod", "ironclad_ugc_2468.mod");
  const before = await fs.readFile(managedPath, "utf8");
  await f.write(
    path.join(workshop, "descriptor.mod"),
    'name="Updated workshop mod"\nsupported_version="1.18.*"\nreplace_path="new/content"\ndependencies={"New dependency"}\n',
  );
  const refreshed = await f.service.getState();
  const mod = refreshed.mods.find((item) => item.id === "workshop:2468");
  assert.equal(mod.name, "Updated workshop mod");
  assert.equal(mod.supportedVersion, "1.18.*");
  assert.equal(await fs.readFile(managedPath, "utf8"), before);
  await f.service.launchGame();
  const after = await fs.readFile(managedPath, "utf8");
  assert.match(after, /replace_path="new\/content"/);
  assert.match(after, /dependencies=\{"New dependency"\}/);
  assert.doesNotMatch(after, /old\/content|Old dependency/);
  assert.equal(f.calls.length, 2);
});

test("an ordinary user workshop descriptor takes precedence over managed and live descriptors", async (t) => {
  const f = await fixture(t);
  await f.installGame();
  const workshop = await f.workshop(
    "2468",
    'replace_path="workshop/content"\n',
  );
  await f.service.saveSettings({
    playsets: [{ id: "default", name: "Default", modIds: ["workshop:2468"] }],
  });
  await f.service.launchGame();
  const managedPath = path.join(f.userData, "mod", "ironclad_ugc_2468.mod");
  const managedText = await fs.readFile(managedPath, "utf8");
  const userPath = path.join(f.userData, "mod", "ugc_2468.mod");
  const userText =
    'name="User custom metadata"\npath=' +
    JSON.stringify(workshop.replace(/\\/g, "/")) +
    '\nremote_file_id="2468"\nreplace_path="user/content"\n';
  await f.write(userPath, userText);
  const state = await f.service.getState();
  assert.equal(
    state.mods.find((item) => item.id === "workshop:2468").name,
    "User custom metadata",
  );
  await f.service.launchGame();
  const load = JSON.parse(
    await fs.readFile(path.join(f.userData, "dlc_load.json"), "utf8"),
  );
  assert.deepEqual(load.enabled_mods, ["mod/ugc_2468.mod"]);
  assert.equal(await fs.readFile(userPath, "utf8"), userText);
  assert.equal(await fs.readFile(managedPath, "utf8"), managedText);
});

test("custom userdir.txt is honored without changing the default profile", async (t) => {
  const f = await fixture(t);
  await f.installGame();
  const redirected = path.join(f.root, "Custom HOI4 Profile");
  const redirectPath = path.join(f.game, "userdir.txt");
  await f.write(redirectPath, "\uFEFF" + redirected + "\n");
  const original = '{"enabled_mods":["mod/original.mod"]}';
  await f.write(path.join(f.userData, "dlc_load.json"), original);
  await f.write(path.join(redirected, "dlc_load.json"), original);
  const state = await f.service.getState();
  assert.equal(state.paths.userData, redirected);
  await f.service.launchGame();
  assert.equal(f.calls.length, 1);
  assert.equal(
    await fs.readFile(path.join(f.userData, "dlc_load.json"), "utf8"),
    original,
  );
  assert.deepEqual(
    JSON.parse(
      await fs.readFile(path.join(redirected, "dlc_load.json"), "utf8"),
    ).enabled_mods,
    [],
  );
  assert.deepEqual(await fs.readdir(f.userData), ["dlc_load.json"]);
  assert.equal(
    await fs.readFile(redirectPath, "utf8"),
    "\uFEFF" + redirected + "\n",
  );
});

test("an empty userdir.txt permits the standard document directory", async (t) => {
  const f = await fixture(t);
  await f.installGame();
  await f.write(path.join(f.game, "userdir.txt"), "\uFEFF \n\r\n");
  const state = await f.service.getState();
  assert.equal(
    state.warnings.some((message) => message.includes("userdir.txt")),
    false,
  );
  await f.service.launchGame();
  assert.equal(f.calls.length, 1);
});

test("v0.1 settings migrate in memory with enabled order and no destructive rewrite", async (t) => {
  const f = await fixture(t);
  const old = {
    gameDirectory: "",
    launchMode: "normal",
    activePlaysetId: "a",
    playsets: [
      { id: "a", name: "旧预设", modIds: ["local:b.mod", "local:a.mod"] },
    ],
  };
  const bytes = JSON.stringify(old);
  await f.write(f.settingsPath, bytes);
  const result = await f.service.getState();
  assert.equal(result.settings.schemaVersion, 3);
  assert.deepEqual(
    result.settings.playsets[0].modOrder,
    old.playsets[0].modIds,
  );
  assert.equal(result.settings.playsets[0].disabledDlcIds, null);
  assert.deepEqual(result.settings.gameOptions, {});
  assert.equal(await fs.readFile(f.settingsPath, "utf8"), bytes);
});

test("v1/v2 preferences without a language migrate without changing their existing preference or rewriting on read", async (t) => {
  for (const schemaVersion of [1, 2]) {
    for (const closeOnLaunch of [undefined, false, true]) {
      await t.test(`${schemaVersion}: ${closeOnLaunch}`, async (t) => {
        const f = await fixture(t);
        const previous = JSON.stringify({
          schemaVersion,
          ...(closeOnLaunch === undefined
            ? {}
            : { launcherPreferences: { closeOnLaunch } }),
        });
        await f.write(f.settingsPath, previous);
        const state = await f.service.getState();
        const expected = {
          closeOnLaunch: closeOnLaunch ?? false,
          language: "zh-hans",
        };
        assert.deepEqual(state.settings.launcherPreferences, expected);
        assert.equal(state.settings.schemaVersion, 3);
        assert.equal(await fs.readFile(f.settingsPath, "utf8"), previous);
        await f.service.saveSettings({ launchMode: "debug" });
        const reopened = await createLauncherService(
          f.serviceOptions,
        ).getState();
        assert.deepEqual(reopened.settings.launcherPreferences, expected);
        assert.equal(reopened.settings.schemaVersion, 3);
        assert.equal(f.calls.length, 0);
      });
    }
  }
});

test("all official launcher languages persist across service instances and unrelated saves", async (t) => {
  const f = await fixture(t);
  for (const language of [
    "en",
    "de",
    "es",
    "fr",
    "ja",
    "ko",
    "pl",
    "pt",
    "ru",
    "tr",
    "zh-hans",
    "zh-hant",
  ]) {
    const preferences = { closeOnLaunch: true, language };
    const saved = await f.service.saveSettings({
      launcherPreferences: preferences,
    });
    assert.deepEqual(saved.launcherPreferences, preferences);
    await f.service.saveSettings({ launchMode: "debug" });
    const reopened = await createLauncherService(f.serviceOptions).getState();
    assert.deepEqual(reopened.settings.launcherPreferences, preferences);
    assert.equal(reopened.settings.schemaVersion, 3);
    assert.deepEqual(
      JSON.parse(await fs.readFile(f.settingsPath, "utf8")).launcherPreferences,
      preferences,
    );
  }
  assert.equal(f.calls.length, 0);
  await assert.rejects(fs.stat(f.userData), { code: "ENOENT" });
});

test("full and compact home layouts persist across reopening, language changes and close-on-launch updates", async (t) => {
  for (const homeLayout of ["full", "compact"])
    await t.test(homeLayout, async (t) => {
      const f = await fixture(t);
      let preferences = {
        closeOnLaunch: false,
        language: "zh-hans",
        homeLayout,
      };
      await f.service.saveSettings({ launcherPreferences: preferences });
      assert.deepEqual(
        (await createLauncherService(f.serviceOptions).getState()).settings
          .launcherPreferences,
        preferences,
      );
      preferences = { ...preferences, language: "en" };
      await f.service.saveSettings({ launcherPreferences: preferences });
      assert.deepEqual(
        (await createLauncherService(f.serviceOptions).getState()).settings
          .launcherPreferences,
        preferences,
      );
      preferences = { ...preferences, closeOnLaunch: true };
      await f.service.saveSettings({ launcherPreferences: preferences });
      await f.service.saveSettings({ launchMode: "debug" });
      assert.deepEqual(
        (await createLauncherService(f.serviceOptions).getState()).settings
          .launcherPreferences,
        preferences,
      );
      assert.deepEqual(
        JSON.parse(await fs.readFile(f.settingsPath, "utf8"))
          .launcherPreferences,
        preferences,
      );
      assert.equal(f.calls.length, 0);
      await assert.rejects(fs.stat(f.userData), { code: "ENOENT" });
    });
});

test("invalid home layouts cannot modify persisted preferences or existing game files", async (t) => {
  const f = await fixture(t);
  await f.installGame();
  const preferences = {
    closeOnLaunch: true,
    language: "en",
    homeLayout: "compact",
  };
  await f.service.saveSettings({ launcherPreferences: preferences });
  const loadFile = await f.write(
    path.join(f.userData, "dlc_load.json"),
    '{"disabled_dlcs":[],"enabled_mods":[]}\n',
  );
  const previous = await fs.readFile(f.settingsPath),
    gameBytes = await fs.readFile(loadFile);
  for (const homeLayout of [
    undefined,
    null,
    "",
    "Compact",
    "side",
    0,
    1,
    true,
    {},
    [],
  ]) {
    await assert.rejects(
      f.service.saveSettings({
        launcherPreferences: { ...preferences, homeLayout },
      }),
      /启动器偏好格式无效/,
    );
    assert.deepEqual(await fs.readFile(f.settingsPath), previous);
    assert.deepEqual(await fs.readFile(loadFile), gameBytes);
    assert.deepEqual(
      (await f.service.getState()).settings.launcherPreferences,
      preferences,
    );
  }
  assert.equal(f.calls.length, 0);
});

test("home layout affects neither captured game environment nor actual launch configuration", async (t) => {
  const f = await fixture(t);
  await f.installGame();
  await f.write(
    path.join(f.userData, "mod", "fixture.mod"),
    'name="Fixture"\npath="mod/fixture"',
  );
  await f.write(
    path.join(f.userData, "mod", "fixture", "content.txt"),
    "fixture",
  );
  await f.service.saveSettings({
    playsets: [
      { id: "default", name: "Campaign", modIds: ["local:fixture.mod"] },
    ],
    launcherPreferences: {
      closeOnLaunch: false,
      language: "en",
      homeLayout: "full",
    },
  });
  const full = captureEnvironment(await f.service.getState()),
    fullLaunch = await f.service.launchGame();
  const loadFile = path.join(f.userData, "dlc_load.json"),
    gameBytes = await fs.readFile(loadFile);
  await f.service.saveSettings({
    launcherPreferences: {
      closeOnLaunch: true,
      language: "zh-hant",
      homeLayout: "compact",
    },
  });
  assert.deepEqual(await fs.readFile(loadFile), gameBytes);
  const compact = captureEnvironment(await f.service.getState()),
    compactLaunch = await f.service.launchGame();
  assert.deepEqual(compact, full);
  assert.deepEqual(
    compactLaunch.performanceContext.environment,
    fullLaunch.performanceContext.environment,
  );
  assert.deepEqual(await fs.readFile(loadFile), gameBytes);
  assert.equal(fullLaunch.closeOnLaunch, false);
  assert.equal(compactLaunch.closeOnLaunch, true);
  assert.equal(f.calls.length, 2);
});

test("invalid languages, unknown preferences, and incomplete preference replacements never mutate saved state", async (t) => {
  const f = await fixture(t);
  const preferences = { closeOnLaunch: true, language: "en" };
  await f.service.saveSettings({ launcherPreferences: preferences });
  const previous = await fs.readFile(f.settingsPath, "utf8");
  const invalid = [
    ...[
      "",
      "en-US",
      "zh-CN",
      "EN",
      "l_english",
      "unknown",
      null,
      undefined,
      1,
      {},
    ].map((language) => ({ closeOnLaunch: true, language })),
    { ...preferences, locale: "fr" },
    { language: "fr" },
    { closeOnLaunch: "true", language: "fr" },
    {},
    null,
    [],
  ];
  for (const launcherPreferences of invalid) {
    await assert.rejects(f.service.saveSettings({ launcherPreferences }));
    assert.equal(await fs.readFile(f.settingsPath, "utf8"), previous);
    assert.deepEqual(
      (await f.service.getState()).settings.launcherPreferences,
      preferences,
    );
  }
  assert.equal(f.calls.length, 0);
});

test("launcher language saves preserve staged game language, user playsets, and game files", async (t) => {
  const f = await fixture(t);
  await f.installGame();
  const gameFiles = [
    ["pdx_settings.txt", '"System"={"language"={value="l_english"}}\n'],
    ["settings.txt", 'language="l_english"\n'],
    ["dlc_load.json", '{"disabled_dlcs":["custom"],"enabled_mods":[]}'],
  ];
  for (const [name, bytes] of gameFiles)
    await f.write(path.join(f.userData, name), bytes);
  const before = await f.service.saveSettings({
    gameOptions: { language: "l_english" },
    playsets: [{ id: "campaign", name: "我的战役 · Campaign", modIds: [] }],
    activePlaysetId: "campaign",
    launcherPreferences: { closeOnLaunch: true, language: "en" },
  });
  const filesBefore = await fs.readdir(f.userData);
  const saved = await f.service.saveSettings({
    launcherPreferences: { ...before.launcherPreferences, language: "zh-hant" },
  });
  const reopened = await createLauncherService(f.serviceOptions).getState();
  for (const settings of [saved, reopened.settings]) {
    assert.deepEqual(settings.gameOptions, before.gameOptions);
    assert.deepEqual(settings.playsets, before.playsets);
    assert.equal(settings.activePlaysetId, before.activePlaysetId);
    assert.deepEqual(settings.launcherPreferences, {
      closeOnLaunch: true,
      language: "zh-hant",
    });
  }
  assert.deepEqual(await fs.readdir(f.userData), filesBefore);
  for (const [name, bytes] of gameFiles)
    assert.equal(await fs.readFile(path.join(f.userData, name), "utf8"), bytes);
  assert.equal(f.calls.length, 0);
});

test("disabled members keep position when re-enabled and each playset keeps DLC choices", async (t) => {
  const f = await fixture(t);
  await f.service.saveSettings({
    playsets: [
      {
        id: "default",
        name: "A",
        modOrder: ["local:a.mod", "local:b.mod"],
        modIds: ["local:b.mod"],
        disabledDlcIds: ["dlc/a.dlc"],
      },
      { id: "other", name: "B", modIds: [], disabledDlcIds: [] },
    ],
  });
  let settings = (await f.service.getState()).settings;
  settings.playsets[0].modIds.push("local:a.mod");
  settings = await f.service.saveSettings({ playsets: settings.playsets });
  assert.deepEqual(settings.playsets[0].modIds, ["local:a.mod", "local:b.mod"]);
  await f.service.saveSettings({ activePlaysetId: "other" });
  settings = (await f.service.getState()).settings;
  assert.deepEqual(settings.playsets[0].disabledDlcIds, ["dlc/a.dlc"]);
  assert.deepEqual(settings.playsets[1].disabledDlcIds, []);
});

test("staged game options and per-playset DLC apply only on launch with exact backups", async (t) => {
  const f = await fixture(t);
  await f.installGame();
  const optionPath = path.join(f.userData, "pdx_settings.txt");
  const optionBefore =
    '# keep\n"Graphics"={"renderer"={value="dx11" version=7} custom="preserve"}\n';
  await f.write(optionPath, optionBefore);
  const loadPath = path.join(f.userData, "dlc_load.json");
  const loadBefore = '{"disabled_dlcs":["old"],"enabled_mods":[],"custom":123}';
  await f.write(loadPath, loadBefore);
  await f.service.saveSettings({
    gameOptions: { renderer: "opengl" },
    playsets: [
      {
        id: "default",
        name: "A",
        modIds: [],
        disabledDlcIds: ["dlc/test.dlc"],
      },
    ],
  });
  assert.equal(await fs.readFile(optionPath, "utf8"), optionBefore);
  assert.equal(await fs.readFile(loadPath, "utf8"), loadBefore);
  await f.service.launchGame();
  const after = await fs.readFile(optionPath, "utf8");
  assert.match(after, /opengl/);
  assert.match(after, /version=7/);
  assert.match(after, /custom="preserve"/);
  assert.match(after, /# keep/);
  assert.deepEqual(JSON.parse(await fs.readFile(loadPath, "utf8")), {
    disabled_dlcs: ["dlc/test.dlc"],
    enabled_mods: [],
    custom: 123,
  });
  const backups = (await fs.readdir(f.userData)).filter((name) =>
    name.startsWith("pdx_settings.txt.ironclad-backup-"),
  );
  assert.equal(backups.length, 1);
  assert.equal(
    await fs.readFile(path.join(f.userData, backups[0]), "utf8"),
    optionBefore,
  );
});

test("launch context and DLC state honor slash and case variants through inherited, global and playset choices", async (t) => {
  for (const scenario of [
    {
      name: "inherit dlc_load",
      global: null,
      playset: null,
      expectedDisabled: ["DLC\\test.DLC"],
      expectedEnabled: ["dlc/second.dlc"],
    },
    {
      name: "global overrides inherited",
      global: ["DLC\\second.DLC"],
      playset: null,
      expectedDisabled: ["DLC\\second.DLC"],
      expectedEnabled: ["dlc/test.dlc"],
    },
    {
      name: "playset overrides global",
      global: ["DLC\\second.DLC"],
      playset: ["DLC\\test.DLC"],
      expectedDisabled: ["DLC\\test.DLC"],
      expectedEnabled: ["dlc/second.dlc"],
    },
    {
      name: "empty playset enables all",
      global: ["DLC\\second.DLC"],
      playset: [],
      expectedDisabled: [],
      expectedEnabled: ["dlc/second.dlc", "dlc/test.dlc"],
    },
  ])
    await t.test(scenario.name, async (t) => {
      const f = await fixture(t);
      await f.installGame();
      await f.write(path.join(f.game, "dlc", "test.dlc"), 'name="Test"\n');
      await f.write(path.join(f.game, "dlc", "second.dlc"), 'name="Second"\n');
      const loadPath = path.join(f.userData, "dlc_load.json");
      await f.write(
        loadPath,
        JSON.stringify({
          disabled_dlcs: ["DLC\\test.DLC"],
          enabled_mods: [],
          preserved: true,
        }),
      );
      await f.service.saveSettings({
        disabledDlcIds: scenario.global,
        playsets: [
          {
            id: "default",
            name: "DLC scenario",
            modIds: [],
            disabledDlcIds: scenario.playset,
          },
        ],
      });
      const before = await f.service.getState();
      assert.deepEqual(
        before.dlc.items
          .filter((item) => item.enabled)
          .map((item) => item.id)
          .sort(),
        scenario.expectedEnabled,
      );
      const launched = await f.service.launchGame();
      const written = JSON.parse(await fs.readFile(loadPath, "utf8"));
      assert.deepEqual(written.disabled_dlcs, scenario.expectedDisabled);
      assert.equal(written.preserved, true);
      assert.deepEqual(
        launched.performanceContext.environment.dlcIds,
        scenario.expectedEnabled,
      );
      const effective = await gameSupport.readDlc(f.game, f.userData);
      assert.deepEqual(
        effective.items
          .filter((item) => item.enabled)
          .map((item) => item.id)
          .sort(),
        launched.performanceContext.environment.dlcIds,
      );
      assert.equal(f.calls.length, 1);
    });
});

test("launch context records normalized effective option values and stays stable after pending options are cleared", async (t) => {
  const f = await fixture(t);
  await f.installGame();
  const optionPath = path.join(f.userData, "pdx_settings.txt");
  await f.write(
    optionPath,
    '"Graphics"={"vsync"={enabled=yes version=3} custom="keep"}\n',
  );
  await f.service.saveSettings({
    gameOptions: { display_index: 0, refreshRate: 60, vsync: false },
  });
  const first = await f.service.launchGame();
  const context = first.performanceContext.environment;
  assert.equal(context.gameOptions.display_index, "0");
  assert.equal(context.gameOptions.refreshRate, "60");
  assert.equal(context.gameOptions.vsync, false);
  const actual = await gameSupport.readGameOptions(f.game, f.userData);
  assert.deepEqual(context.gameOptions, actual.values);
  assert.match(await fs.readFile(optionPath, "utf8"), /custom="keep"/);
  await f.service.saveSettings({ gameOptions: {} });
  const second = await f.service.launchGame();
  assert.deepEqual(
    second.performanceContext.environment.gameOptions,
    actual.values,
  );
  assert.equal(
    second.performanceContext.environment.configurationId,
    context.configurationId,
  );
  assert.ok(
    !compareEnvironments(context, second.performanceContext.environment).some(
      (change) => change.kind === "settings",
    ),
  );
  assert.equal(f.calls.length, 2);
});

test("launch context follows actual enabled descriptor order with disabled members interleaved", async (t) => {
  const f = await fixture(t);
  await f.installGame();
  for (const name of ["alpha", "beta"]) {
    await f.write(
      path.join(f.userData, "mod", name + ".mod"),
      `name="${name}"\npath="mod/${name}"\n`,
    );
    await f.write(path.join(f.userData, "mod", name, "content.txt"), "fixture");
  }
  await f.service.saveSettings({
    playsets: [
      {
        id: "default",
        name: "Ordered",
        modIds: ["local:alpha.mod", "local:beta.mod"],
        modOrder: ["local:beta.mod", "local:off.mod", "local:alpha.mod"],
      },
    ],
  });
  const result = await f.service.launchGame();
  const load = JSON.parse(
    await fs.readFile(path.join(f.userData, "dlc_load.json"), "utf8"),
  );
  assert.deepEqual(load.enabled_mods, ["mod/beta.mod", "mod/alpha.mod"]);
  assert.deepEqual(
    result.performanceContext.environment.mods.map((mod) => mod.id),
    ["local:beta.mod", "local:alpha.mod"],
  );
  assert.deepEqual(result.performanceContext.environment.playset.modOrder, [
    "local:beta.mod",
    "local:off.mod",
    "local:alpha.mod",
  ]);
});

test("failed game spawn restores game options and loadout together", async (t) => {
  const f = await fixture(t, { spawnError: true });
  await f.installGame();
  const optionPath = path.join(f.userData, "pdx_settings.txt");
  const original = '"Graphics"={"vsync"={enabled=yes version=3}}';
  await f.write(optionPath, original);
  await f.service.saveSettings({ gameOptions: { vsync: false } });
  await assert.rejects(f.service.launchGame(), /已恢复/);
  assert.equal(await fs.readFile(optionPath, "utf8"), original);
  await assert.rejects(fs.stat(path.join(f.userData, "dlc_load.json")), {
    code: "ENOENT",
  });
});

test("resume uses official metadata arguments and rejects missing save before mutation", async (t) => {
  const f = await fixture(t);
  await f.installGame();
  await f.write(
    path.join(f.game, "launcher-settings.json"),
    JSON.stringify({
      rawVersion: "1.19.4",
      exePath: "./hoi4.exe",
      exeArgs: ["-gdpr-compliant"],
      alternativeExecutables: [
        { exePath: "./hoi4.exe", exeArgs: ["-gdpr-compliant", "-debug_mode"] },
      ],
    }),
  );
  await f.service.saveSettings({ launchMode: "debug" });
  await f.write(
    path.join(f.userData, "continue_game.json"),
    JSON.stringify({
      title: "Campaign",
      filename: "test.hoi4",
      is_remote: false,
    }),
  );
  await assert.rejects(f.service.launchGame({ resume: true }), /存档/);
  assert.equal(f.calls.length, 0);
  await assert.rejects(fs.stat(path.join(f.userData, "dlc_load.json")), {
    code: "ENOENT",
  });
  await f.write(
    path.join(f.userData, "save games", "test.hoi4"),
    "fixture-only",
  );
  await f.service.launchGame({ resume: true });
  assert.deepEqual(f.calls[0].args, [
    "-gdpr-compliant",
    "-debug_mode",
    "--continuelastsave",
  ]);
});

test("running game blocks duplicate launches until the child exits", async (t) => {
  const f = await fixture(t, { keepAlive: true });
  await f.installGame();
  await f.service.launchGame();
  assert.equal((await f.service.getLaunchStatus()).running, true);
  await assert.rejects(f.service.launchGame(), /仍在运行/);
  assert.equal(f.calls.length, 1);
  f.calls[0].child.emit("exit", 7);
  assert.equal((await f.service.getLaunchStatus()).running, false);
  assert.equal((await f.service.getLaunchStatus()).lastExitCode, 7);
});

test("campaign resume selects an exact local save and rolls continuation metadata back on spawn failure", async (t) => {
  for (const spawnError of [false, true]) {
    const f = await fixture(t, { spawnError });
    await f.installGame();
    const target = path.join(f.userData, "continue_game.json"),
      original = '{"filename":"previous.hoi4","is_remote":true}';
    await f.write(target, original);
    await f.write(
      path.join(f.userData, "save games", "Selected.hoi4"),
      "isolated fixture",
    );
    const operation = f.service.launchGame({
      resume: true,
      saveFilename: "Selected.hoi4",
    });
    if (spawnError) {
      await assert.rejects(operation, /已恢复/);
      assert.equal(await fs.readFile(target, "utf8"), original);
    } else {
      await operation;
      assert.equal(
        JSON.parse(await fs.readFile(target, "utf8")).filename,
        "Selected.hoi4",
      );
      assert.equal(f.calls[0].args.at(-1), "--continuelastsave");
    }
    assert.ok(
      (await fs.readdir(f.userData)).some((name) =>
        name.startsWith("continue_game.json.ironclad-backup-"),
      ),
    );
  }
});

test("campaign resume rejects unsafe and missing saves before changing continuation metadata", async (t) => {
  const f = await fixture(t);
  await f.installGame();
  const target = path.join(f.userData, "continue_game.json");
  await f.write(target, "original");
  for (const saveFilename of [
    "../outside.hoi4",
    "missing.hoi4",
    "C:/outside.hoi4",
    "bad.txt",
  ])
    await assert.rejects(f.service.launchGame({ resume: true, saveFilename }));
  assert.equal(await fs.readFile(target, "utf8"), "original");
  assert.equal(f.calls.length, 0);
});

test("official JSON import/export persists unavailable members and version pins", async (t) => {
  const f = await fixture(t);
  await f.installGame();
  const input = {
    game: "hoi4",
    name: "完整的预设名称".repeat(10),
    mods: [
      {
        displayName: "Missing",
        steamId: "9000001",
        position: 1,
        enabled: false,
      },
      {
        displayName: "Pinned",
        pdxId: "9000002",
        position: 0,
        enabled: true,
        version: "3.2",
      },
    ],
  };
  const result = await f.service.importPlayset(JSON.stringify(input));
  const active = result.settings.playsets.find(
    (item) => item.id === result.settings.activePlaysetId,
  );
  assert.deepEqual(active.modOrder, ["pdx:9000002", "workshop:9000001"]);
  assert.deepEqual(active.modIds, ["pdx:9000002"]);
  assert.equal(
    active.modReferences.find((ref) => ref.id === "pdx:9000002").version,
    "3.2",
  );
  const exported = await f.service.exportPlayset(active.id);
  assert.equal(exported.document.mods[0].version, "3.2");
  assert.equal(exported.document.mods[1].enabled, false);
  await assert.rejects(f.service.launchGame(), /模组已移动或未安装/);
});

test("a detected external game prevents changing game configuration", async (t) => {
  const f = await fixture(t);
  await f.installGame();
  const service = createLauncherService({
    ...f.serviceOptions,
    processProbe: async () => ({ pid: 6789 }),
  });
  assert.equal((await service.getState()).launchStatus.external, true);
  await assert.rejects(service.launchGame(), /仍在运行/);
  await assert.rejects(fs.stat(path.join(f.userData, "dlc_load.json")), {
    code: "ENOENT",
  });
});

test("local authoring integrates discovery, ID-based metadata editing and launch", async (t) => {
  const f = await fixture(t);
  await f.installGame();
  const created = await f.service.createLocalMod({
    name: "My local mod",
    folder: "my_local_mod",
    version: "1.0",
    supportedVersion: "1.17.*",
    tags: ["Gameplay"],
    description: "Local fixture",
  });
  const mod = created.state.mods.find((item) => item.name === "My local mod");
  assert.ok(mod.canEdit);
  assert.equal(mod.source, "local");
  assert.equal(
    (await f.service.getLocalModMetadata(mod.id)).folder,
    "my_local_mod",
  );
  const old = await fs.readFile(mod.descriptorPath);
  const edited = await f.service.updateLocalModMetadata(mod.id, {
    name: "Updated local mod",
  });
  assert.equal(
    edited.state.mods.find((item) => item.id === mod.id).name,
    "Updated local mod",
  );
  assert.ok(edited.mod.backups.length);
  const outerBackup = edited.mod.backups.find((filename) =>
    filename.startsWith(mod.descriptorPath + ".ironclad-backup-"),
  );
  assert.deepEqual(await fs.readFile(outerBackup), old);
  const current = edited.state.settings;
  await f.service.saveSettings({
    playsets: current.playsets.map((item) => ({
      ...item,
      modIds: [mod.id],
      modOrder: [mod.id],
    })),
  });
  await f.service.launchGame();
  const load = JSON.parse(
    await fs.readFile(path.join(f.userData, "dlc_load.json"), "utf8"),
  );
  assert.deepEqual(load.enabled_mods, ["mod/my_local_mod.mod"]);
  await assert.rejects(
    f.service.getLocalModMetadata("local:../outside.mod"),
    /模组/,
  );
});

test("running game blocks local authoring before files are created", async (t) => {
  const f = await fixture(t);
  await f.installGame();
  const service = createLauncherService({
    ...f.serviceOptions,
    processProbe: async () => ({ pid: 6789 }),
  });
  await assert.rejects(
    service.createLocalMod({
      name: "Fixture",
      folder: "blocked",
      version: "1.0",
      supportedVersion: "1.17.*",
      tags: [],
    }),
    /退出游戏/,
  );
  await assert.rejects(fs.stat(path.join(f.userData, "mod", "blocked.mod")), {
    code: "ENOENT",
  });
});

test("registered Paradox mods resolve their paths and match official imported identities", async (t) => {
  const f = await fixture(t);
  await f.installGame();
  const descriptor = await f.write(
    path.join(f.userData, "mod", "pdx_12345.mod"),
    'name="PDX fixture"\npath="mod/pdx_12345_2.0"\nversion="2.0"\nsupported_version="1.17.*"\nremote_file_id="98765"\n',
  );
  await f.write(
    path.join(f.userData, "mod", "pdx_12345_2.0", "descriptor.mod"),
    'name="PDX fixture"',
  );
  const before = await fs.readFile(descriptor);
  const state = await f.service.importPlayset(
    JSON.stringify({
      game: "hoi4",
      name: "PDX preset",
      mods: [
        {
          displayName: "PDX fixture",
          pdxId: "12345",
          enabled: true,
          position: 0,
        },
      ],
    }),
  );
  const mod = state.mods.find((item) => item.id === "pdx:12345");
  assert.equal(mod.source, "pdx");
  assert.equal(mod.remoteId, "12345");
  assert.equal(mod.version, "2.0");
  assert.equal(mod.available, true);
  assert.equal(mod.canEdit, false);
  assert.equal(state.settings.playsets.at(-1).modIds[0], mod.id);
  await f.service.launchGame();
  assert.deepEqual(
    JSON.parse(
      await fs.readFile(path.join(f.userData, "dlc_load.json"), "utf8"),
    ).enabled_mods,
    ["mod/pdx_12345.mod"],
  );
  await assert.rejects(
    f.service.updateLocalModMetadata(mod.id, {
      name: "Do not overwrite subscription",
    }),
    /提供方/,
  );
  assert.deepEqual(await fs.readFile(descriptor), before);
});

test("Paradox version pins choose the matching installed descriptor and block mismatches before writes", async (t) => {
  const f = await fixture(t);
  await f.installGame();
  for (const [suffix, version] of [
    ["", "3.0"],
    ["_2", "2.0"],
  ]) {
    await f.write(
      path.join(f.userData, "mod", `pdx_54321${suffix}.mod`),
      `name="Pinned mod"\npath="mod/pdx_54321${suffix}"\nversion="${version}"`,
    );
    await f.write(
      path.join(f.userData, "mod", `pdx_54321${suffix}`, "descriptor.mod"),
      'name="Pinned mod"',
    );
  }
  const document = {
    game: "hoi4",
    name: "Pinned fixture",
    mods: [
      {
        displayName: "Pinned mod",
        pdxId: "54321",
        enabled: true,
        position: 0,
        version: "2",
      },
    ],
  };
  const imported = await f.service.importPlayset(JSON.stringify(document));
  assert.equal(
    imported.mods.find((mod) => mod.id === "pdx:54321").installedRevision,
    "2",
  );
  await f.service.launchGame();
  const loadPath = path.join(f.userData, "dlc_load.json");
  const previous = await fs.readFile(loadPath);
  assert.deepEqual(JSON.parse(previous).enabled_mods, ["mod/pdx_54321_2.mod"]);
  document.mods[0].version = "9";
  const missing = await f.service.importPlayset(JSON.stringify(document));
  assert.match(missing.launchBlockedReason, /版本未安装/);
  await assert.rejects(f.service.launchGame(), /Paradox 版本 9/);
  assert.deepEqual(await fs.readFile(loadPath), previous);
  assert.equal(f.calls.length, 1);
});

test("managed PDX installs take precedence over old official registrations while exact pins and fallback remain intact", async (t) => {
  const f = await fixture(t);
  await f.installGame();
  for (const suffix of ["", "_1", "_2"]) {
    await f.write(
      path.join(f.userData, "mod", `pdx_123${suffix}`, "descriptor.mod"),
      'name="Fixture"',
    );
    await f.write(
      path.join(f.userData, "mod", `pdx_123${suffix}.mod`),
      (suffix === "_2"
        ? "# Managed by IRONCLAD PDX installer: 11111111-2222-3333-4444-555555555555\n"
        : "") + `name="Fixture${suffix}"\npath="mod/pdx_123${suffix}"`,
    );
  }
  const official = path.join(f.userData, "mod", "pdx_123.mod");
  const before = await fs.readFile(official);
  const current = await f.service.getState();
  assert.equal(
    current.mods.find((mod) => mod.id === "pdx:123").installedRevision,
    "2",
  );
  const document = {
    game: "hoi4",
    name: "Pinned",
    mods: [
      {
        displayName: "Fixture",
        pdxId: "123",
        enabled: true,
        position: 0,
        version: "1",
      },
    ],
  };
  assert.equal(
    (await f.service.importPlayset(JSON.stringify(document))).mods.find(
      (mod) => mod.id === "pdx:123",
    ).installedRevision,
    "1",
  );
  delete document.mods[0].version;
  assert.equal(
    (await f.service.importPlayset(JSON.stringify(document))).mods.find(
      (mod) => mod.id === "pdx:123",
    ).installedRevision,
    "2",
  );
  await fs.unlink(path.join(f.userData, "mod", "pdx_123_2.mod"));
  assert.equal(
    (await f.service.getState()).mods.find((mod) => mod.id === "pdx:123")
      .installedRevision,
    null,
  );
  assert.deepEqual(await fs.readFile(official), before);
});
