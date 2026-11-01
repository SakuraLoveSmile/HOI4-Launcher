"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { createLauncherService } = require("../electron/launcher-service.cjs");

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ironclad-instances-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const write = async (filename, data) => {
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, data);
    return filename;
  };
  const game = path.join(root, "旧版 独立 game");
  await write(path.join(game, "hoi4.exe"), "inert fixture");
  await write(
    path.join(game, "launcher-settings.json"),
    JSON.stringify({ rawVersion: "1.10.8", exeArgs: ["-fixture"] }),
  );
  const options = {
    settingsPath: path.join(root, "app", "settings.json"),
    documentsPath: root,
    steamRoots: [],
    processProbe: async () => null,
    spawnProcess(executable, args, launchOptions) {
      const child = new EventEmitter();
      child.pid = 12345;
      child.unref = () => {};
      f.calls.push({ executable, args, options: launchOptions, child });
      process.nextTick(() =>
        child.emit(
          f.spawnError ? "error" : "spawn",
          f.spawnError ? new Error("fixture spawn failure") : undefined,
        ),
      );
      return child;
    },
  };
  const f = {
    root,
    game,
    options,
    write,
    calls: [],
    spawnError: false,
    service: createLauncherService(options),
  };
  await f.service.saveSettings({ gameDirectory: game });
  f.defaultState = await f.service.getState();
  return f;
}

test("legacy migration preserves the original userdir and file bytes until a mutation", async (t) => {
  const f = await fixture(t);
  const redirected = path.join(f.root, "自定义旧存档");
  await f.write(path.join(f.game, "userdir.txt"), redirected);
  const legacy = {
    schemaVersion: 2,
    gameDirectory: f.game,
    playsets: [{ id: "old", name: "历史战役", modIds: [] }],
    activePlaysetId: "old",
  };
  await f.write(f.options.settingsPath, JSON.stringify(legacy));
  const service = createLauncherService(f.options);
  const result = await service.getState();
  assert.equal(result.settings.schemaVersion, 3);
  assert.equal(result.paths.userData, redirected);
  assert.equal(result.settings.gameInstances[0].isolated, false);
  assert.equal(
    await fs.readFile(f.options.settingsPath, "utf8"),
    JSON.stringify(legacy),
  );
  await service.launchGame();
  assert.deepEqual(f.calls[0].args, ["-fixture"]);
});

test("instances retain independent playsets, DLC, options and launch mode across switch and restart", async (t) => {
  const f = await fixture(t);
  await f.service.saveSettings({
    launchMode: "debug",
    disabledDlcIds: ["dlc/original.dlc"],
    playsets: [{ id: "old", name: "原战役", modIds: [], modReferences: [] }],
    activePlaysetId: "old",
    gameOptions: { language: "l_english" },
  });
  const original = (await f.service.getState()).settings;
  const created = await f.service.createGameInstance({
    name: "  1.10 独立版  ",
    gameDirectory: f.game,
  });
  const id = created.settings.activeGameInstanceId;
  assert.equal(
    created.settings.gameInstances.find((item) => item.id === id).name,
    "1.10 独立版",
  );
  assert.deepEqual(created.settings.playsets[0].modIds, []);
  assert.deepEqual(created.settings.gameOptions, {});
  assert.equal(created.settings.disabledDlcIds, null);
  assert.equal(created.settings.launchMode, "normal");
  assert.equal(created.settings.activePlaysetId, "default");
  assert.notEqual(created.paths.userData, f.defaultState.paths.userData);
  await f.service.saveSettings({
    gameOptions: { language: "l_simp_chinese" },
    launcherPreferences: { closeOnLaunch: false, language: "en" },
  });
  const back = await f.service.switchGameInstance("default");
  for (const key of [
    "playsets",
    "activePlaysetId",
    "gameOptions",
    "disabledDlcIds",
    "launchMode",
  ])
    assert.deepEqual(back.settings[key], original[key], key);
  assert.equal(back.settings.launcherPreferences.language, "en");
  const reopened = createLauncherService(f.options);
  const again = await reopened.switchGameInstance(id);
  assert.deepEqual(again.settings.gameOptions, { language: "l_simp_chinese" });
  assert.equal(again.paths.userData, created.paths.userData);
});

test("same installation can have two isolated instances with separate mods, saves and launch targets", async (t) => {
  const f = await fixture(t);
  const a = await f.service.createGameInstance({
    name: "战役甲",
    gameDirectory: f.game,
  });
  const idA = a.settings.activeGameInstanceId;
  const b = await f.service.createGameInstance({
    name: "战役乙",
    gameDirectory: f.game,
  });
  assert.notEqual(a.paths.userData, b.paths.userData);
  const custom = path.join(f.root, "game-userdir");
  await f.write(path.join(f.game, "userdir.txt"), custom);
  await f.write(
    path.join(a.paths.userData, "mod", "a.mod"),
    'name="仅甲"\npath="mod/a"',
  );
  await f.write(
    path.join(a.paths.userData, "mod", "a", "content.txt"),
    "mod content",
  );
  await f.write(
    path.join(a.paths.userData, "continue_game.json"),
    JSON.stringify({ title: "战役甲存档", filename: "甲.hoi4" }),
  );
  await f.write(path.join(a.paths.userData, "save games", "甲.hoi4"), "save");
  assert.equal((await f.service.getState()).mods.length, 0);
  assert.equal((await f.service.getState()).continueGame.available, false);
  await f.service.switchGameInstance(idA);
  const active = await f.service.getState();
  assert.deepEqual(
    active.mods.map((item) => item.name),
    ["仅甲"],
  );
  assert.equal(active.continueGame.available, true);
  assert.equal(active.continueGame.title, "战役甲存档");
  await f.service.launchGame({ resume: true });
  assert.deepEqual(f.calls[0].args, [
    "-fixture",
    "-userdir=" + a.paths.userData.replace(/\\/g, "/"),
    "--continuelastsave",
  ]);
  assert.equal(f.calls[0].options.cwd, f.game);
  assert.ok(await fs.stat(path.join(a.paths.userData, "dlc_load.json")));
  await assert.rejects(fs.stat(path.join(b.paths.userData, "dlc_load.json")), {
    code: "ENOENT",
  });
  await assert.rejects(fs.stat(path.join(custom, "dlc_load.json")), {
    code: "ENOENT",
  });
  assert.equal(
    await fs.readFile(path.join(f.game, "userdir.txt"), "utf8"),
    custom,
  );
});

test("isolated launch failure rolls back only that instance and metadata userdir conflicts fail before writes", async (t) => {
  const f = await fixture(t);
  const active = await f.service.createGameInstance({
    name: "回滚",
    gameDirectory: f.game,
  });
  const target = path.join(active.paths.userData, "dlc_load.json");
  const original = '{"enabled_mods":[],"custom":"keep"}';
  await f.write(target, original);
  f.spawnError = true;
  await assert.rejects(f.service.launchGame(), /已恢复/);
  assert.equal(await fs.readFile(target, "utf8"), original);
  await assert.rejects(
    fs.stat(path.join(f.defaultState.paths.userData, "dlc_load.json")),
    { code: "ENOENT" },
  );
  await f.write(
    path.join(f.game, "launcher-settings.json"),
    JSON.stringify({ exeArgs: ["--userdir", "elsewhere"] }),
  );
  await assert.rejects(f.service.launchGame(), /已指定用户目录/);
  assert.equal(await fs.readFile(target, "utf8"), original);
  assert.equal(f.calls.length, 1);
});

test("rename and removal preserve game files and user data, and default remains selectable", async (t) => {
  const f = await fixture(t);
  const active = await f.service.createGameInstance({
    name: "旧版",
    gameDirectory: f.game,
  });
  const id = active.settings.activeGameInstanceId;
  const save = await f.write(
    path.join(active.paths.userData, "save games", "save.hoi4"),
    "keep this save",
  );
  await f.service.renameGameInstance({ id, name: "改名" });
  const renamed = await f.service.getState();
  assert.equal(renamed.paths.userData, active.paths.userData);
  assert.equal(
    renamed.settings.gameInstances.find((item) => item.id === id).name,
    "改名",
  );
  const removed = await f.service.removeGameInstance(id);
  assert.equal(removed.settings.activeGameInstanceId, "default");
  assert.equal(removed.settings.gameInstances.length, 1);
  assert.equal(await fs.readFile(save, "utf8"), "keep this save");
  assert.equal(
    await fs.readFile(path.join(f.game, "hoi4.exe"), "utf8"),
    "inert fixture",
  );
  await assert.rejects(f.service.removeGameInstance("default"), /不能移除/);
  await assert.rejects(f.service.switchGameInstance(id), /不存在/);
});

test("invalid mutations preserve persisted settings and cannot inject profiles or paths", async (t) => {
  const f = await fixture(t);
  const before = await fs.readFile(f.options.settingsPath, "utf8");
  for (const input of [
    { name: "", gameDirectory: f.game },
    { name: "x", gameDirectory: "relative" },
    { name: "x", gameDirectory: f.root },
    { name: "x", gameDirectory: f.game, id: "../../escape" },
  ])
    await assert.rejects(f.service.createGameInstance(input));
  await assert.rejects(
    f.service.saveSettings({ activeGameInstanceId: "default" }),
    /版本实例操作/,
  );
  await assert.rejects(
    f.service.saveSettings({ gameInstances: [] }),
    /版本实例操作/,
  );
  assert.equal(await fs.readFile(f.options.settingsPath, "utf8"), before);
});

test("broken installation metadata cannot persist a failed creation or switch", async (t) => {
  const f = await fixture(t);
  const otherGame = path.join(f.root, "broken-install");
  await f.write(path.join(otherGame, "hoi4.exe"), "inert");
  await f.write(path.join(otherGame, "launcher-settings.json"), "{broken");
  const before = await fs.readFile(f.options.settingsPath, "utf8");
  await assert.rejects(
    f.service.createGameInstance({ name: "broken", gameDirectory: otherGame }),
  );
  assert.equal(
    (await f.service.getState()).settings.activeGameInstanceId,
    "default",
  );
  assert.equal(await fs.readFile(f.options.settingsPath, "utf8"), before);
  // The registered alternate installation can also be damaged externally.
  const second = await f.service.createGameInstance({
    name: "other",
    gameDirectory: f.game,
  });
  await f.service.saveSettings({ gameDirectory: otherGame });
  await f.service.switchGameInstance("default");
  const saved = await fs.readFile(f.options.settingsPath, "utf8");
  await assert.rejects(
    f.service.switchGameInstance(second.settings.activeGameInstanceId),
  );
  assert.equal(await fs.readFile(f.options.settingsPath, "utf8"), saved);
  assert.equal(
    (await f.service.getState()).settings.activeGameInstanceId,
    "default",
  );
  assert.equal(
    (await createLauncherService(f.options).getState()).settings
      .activeGameInstanceId,
    "default",
  );
});

test("running game blocks switches, instance mutations and installation path changes", async (t) => {
  const f = await fixture(t);
  const active = await f.service.createGameInstance({
    name: "运行中",
    gameDirectory: f.game,
  });
  await f.service.launchGame();
  const before = await fs.readFile(f.options.settingsPath, "utf8");
  await assert.rejects(f.service.switchGameInstance("default"), /退出游戏/);
  await assert.rejects(
    f.service.createGameInstance({ name: "另一个", gameDirectory: f.game }),
    /退出游戏/,
  );
  await assert.rejects(
    f.service.removeGameInstance(active.settings.activeGameInstanceId),
    /退出游戏/,
  );
  await assert.rejects(
    f.service.saveSettings({ gameDirectory: "" }),
    /退出游戏/,
  );
  assert.equal(await fs.readFile(f.options.settingsPath, "utf8"), before);
  f.calls[0].child.emit("exit", 0);
  assert.equal(
    (await f.service.switchGameInstance("default")).settings
      .activeGameInstanceId,
    "default",
  );
});

test("settings write failure restores the active instance and leaves the queue usable", async (t) => {
  const f = await fixture(t);
  const created = await f.service.createGameInstance({
    name: "alternate",
    gameDirectory: f.game,
  });
  await f.service.switchGameInstance("default");
  const saved = await fs.readFile(f.options.settingsPath, "utf8");
  const backup = f.options.settingsPath + ".fixture-backup";
  await fs.rename(f.options.settingsPath, backup);
  await fs.mkdir(f.options.settingsPath);
  await assert.rejects(
    f.service.switchGameInstance(created.settings.activeGameInstanceId),
  );
  assert.equal(
    (await f.service.getState()).settings.activeGameInstanceId,
    "default",
  );
  assert.equal(
    (await f.service.getState()).paths.userData,
    f.defaultState.paths.userData,
  );
  assert.equal(await fs.readFile(backup, "utf8"), saved);
  await fs.rmdir(f.options.settingsPath);
  await fs.rename(backup, f.options.settingsPath);
  assert.equal(
    (await f.service.switchGameInstance(created.settings.activeGameInstanceId))
      .settings.activeGameInstanceId,
    created.settings.activeGameInstanceId,
  );
});

test("managed user directory links are refused before launch or selection writes", async (t) => {
  const f = await fixture(t);
  const active = await f.service.createGameInstance({
    name: "链接防护",
    gameDirectory: f.game,
  });
  await f.service.switchGameInstance("default");
  const outside = path.join(f.root, "outside");
  await fs.mkdir(outside);
  await fs.mkdir(path.dirname(active.paths.userData), { recursive: true });
  await fs.symlink(
    outside,
    active.paths.userData,
    process.platform === "win32" ? "junction" : "dir",
  );
  const before = await fs.readFile(f.options.settingsPath, "utf8");
  await assert.rejects(
    f.service.switchGameInstance(active.settings.activeGameInstanceId),
    /隔离目录/,
  );
  assert.equal(await fs.readFile(f.options.settingsPath, "utf8"), before);
  assert.deepEqual(await fs.readdir(outside), []);
});
