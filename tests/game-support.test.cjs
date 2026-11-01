"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const {
  readGameMetadata,
  resolveUserDirectory,
  readGameOptions,
  planGameOptions,
  readDlc,
  readContinueGame,
} = require("../electron/game-support.cjs");

async function fixture(t) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "ironclad-game-support-"),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const game = path.join(root, "中文 Game"),
    user = path.join(root, "用户资料"),
    documents = path.join(root, "Documents");
  const write = async (filename, content) => {
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, content);
    return filename;
  };
  const metadata = (value) =>
    write(path.join(game, "launcher-settings.json"), JSON.stringify(value));
  return { root, game, user, documents, write, metadata };
}

const layout = [
  {
    category: "Graphics",
    label: "Graphics",
    settings: [
      {
        name: "display_mode",
        type: "radio",
        default: "borderless_fullscreen",
        options: [
          { value: "fullscreen" },
          { value: "borderless_fullscreen" },
          { value: "windowed" },
        ],
      },
      {
        name: "display_index",
        type: "select",
        provider: "sdl",
        providerArgs: "displayIndex",
      },
      { name: "fullscreen_resolution", type: "select", provider: "sdl" },
      { name: "windowed_resolution", type: "select", provider: "sdl" },
      { name: "refreshRate", type: "select", provider: "sdl" },
      { name: "vsync", type: "toggle", default: true },
      {
        name: "renderer",
        type: "radio",
        default: "dx11",
        options: [
          { value: "dx11" },
          { value: "dx9_compat" },
          { value: "opengl" },
        ],
      },
    ],
  },
  {
    category: "System",
    settings: [
      {
        name: "language",
        type: "select",
        default: "l_english",
        options: [{ value: "l_english" }, { value: "l_simp_chinese" }],
      },
    ],
  },
];

async function installLayout(f, metadata = {}) {
  await f.metadata({
    ingameSettingsPath: "pdx_settings.json",
    ingameSettingsLayoutPath: "settings-layout.json",
    ...metadata,
  });
  await f.write(
    path.join(f.game, "settings-layout.json"),
    JSON.stringify(layout),
  );
}

test("missing game and user files return defaults without creating directories", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await readGameMetadata(f.game), {
    version: null,
    displayVersion: null,
    normalArgs: [],
    debugArgs: ["-debug"],
  });
  assert.equal(
    await resolveUserDirectory(f.game, f.documents),
    path.join(f.documents, "Paradox Interactive", "Hearts of Iron IV"),
  );
  const options = await readGameOptions(f.game, f.user);
  assert.equal(options.values.renderer, "dx11");
  assert.deepEqual(options.sourcePaths, []);
  assert.deepEqual((await readDlc(f.game, f.user)).items, []);
  assert.equal((await readContinueGame(f.user)).available, false);
  const plan = await planGameOptions(f.game, f.user, { renderer: "opengl" });
  assert.equal(plan.writes[0].path, path.join(f.user, "pdx_settings.txt"));
  await assert.rejects(fs.stat(f.user), { code: "ENOENT" });
  await assert.rejects(fs.stat(f.game), { code: "ENOENT" });
});

test("metadata uses game-declared normal and debug args without accepting another executable", async (t) => {
  const f = await fixture(t);
  await f.metadata({
    rawVersion: "1.19.4.0",
    version: "Operation Postern",
    exePath: "./hoi4.exe",
    exeArgs: ["-gdpr-compliant"],
    alternativeExecutables: [
      { exePath: "./hoi4.exe", exeArgs: ["-gdpr-compliant", "-debug_mode"] },
    ],
  });
  assert.deepEqual(await readGameMetadata(f.game), {
    version: "1.19.4.0",
    displayVersion: "Operation Postern",
    normalArgs: ["-gdpr-compliant"],
    debugArgs: ["-gdpr-compliant", "-debug_mode"],
  });
  await f.metadata({ exePath: "other.exe", exeArgs: [] });
  await assert.rejects(readGameMetadata(f.game), /非 hoi4.exe/);
  await f.metadata({ exeArgs: ["-debug\n-injected"] });
  await assert.rejects(readGameMetadata(f.game), /启动参数无效/);
});

test("userdir resolution supports BOM, relative Unicode paths and absolute overrides", async (t) => {
  const f = await fixture(t);
  const userdir = path.join(f.game, "userdir.txt");
  await f.write(userdir, "\uFEFF../定制存档\r\n");
  assert.equal(
    await resolveUserDirectory(f.game, f.documents),
    path.resolve(f.game, "../定制存档"),
  );
  await f.write(userdir, f.user);
  assert.equal(await resolveUserDirectory(f.game, f.documents), f.user);
  await f.write(userdir, "\uFEFF \r\n");
  assert.equal(
    await resolveUserDirectory(f.game, f.documents),
    path.join(f.documents, "Paradox Interactive", "Hearts of Iron IV"),
  );
  await f.write(userdir, "one\ntwo");
  await assert.rejects(resolveUserDirectory(f.game, f.documents), /单行/);
  await assert.rejects(fs.stat(f.user), { code: "ENOENT" });
});

test("LFV0 reads PDS text even when metadata names a JSON file", async (t) => {
  const f = await fixture(t);
  await installLayout(f);
  await f.write(
    path.join(f.user, "pdx_settings.txt"),
    '"Graphics"={ "renderer"={ value="opengl" version=3 } "vsync"={ enabled=no version=0 } }\n"System"={ "language"={ value="l_simp_chinese" version=0 } }\n',
  );
  await f.write(
    path.join(f.user, "pdx_settings.json"),
    JSON.stringify({ Graphics: { renderer: "dx11" } }),
  );
  const result = await readGameOptions(f.game, f.user);
  assert.equal(result.values.renderer, "opengl");
  assert.equal(result.values.vsync, false);
  assert.equal(result.values.language, "l_simp_chinese");
  assert.deepEqual(result.sourcePaths, [path.join(f.user, "pdx_settings.txt")]);
});

test("text write plans preserve comments, versions, unknown data and legacy files", async (t) => {
  const f = await fixture(t);
  await installLayout(f);
  const original =
    '# keep this header\r\n"Graphics"={\r\n\t"renderer"={ value="dx11" version=7 custom="untouched" } # renderer note\r\n\t"vsync"={ enabled=yes version=2 }\r\n\t"unknown_setting"={ value="keep { # literal }" version=9 }\r\n}\r\n"Unrelated"={ secret_setting="preserve" }\r\n';
  const primary = await f.write(
    path.join(f.user, "pdx_settings.txt"),
    original,
  );
  const legacy = await f.write(
    path.join(f.user, "settings.txt"),
    'language="l_english"\ngraphics={ size={ x=1920 y=1080 } fullScreen=no borderless=yes vsync=yes adapter=0 refreshRate=144 }\nmusic_volume=42\n',
  );
  const legacyBefore = await fs.readFile(legacy, "utf8");
  const plan = await planGameOptions(f.game, f.user, {
    renderer: "opengl",
    vsync: false,
    language: "l_simp_chinese",
    windowed_resolution: "1600x900",
    display_index: "1",
  });
  assert.equal(plan.writes.length, 1);
  assert.equal(plan.writes[0].path, primary);
  assert.match(
    plan.writes[0].content,
    /value="opengl" version=7 custom="untouched"/,
  );
  assert.match(plan.writes[0].content, /enabled=no version=2/);
  assert.ok(
    plan.writes[0].content.includes(
      '"unknown_setting"={ value="keep { # literal }" version=9 }',
    ),
  );
  assert.ok(
    plan.writes[0].content.includes(
      '"Unrelated"={ secret_setting="preserve" }',
    ),
  );
  assert.ok(plan.writes[0].content.startsWith("# keep this header\r\n"));
  assert.equal(
    plan.writes[0].content.replace(/\r\n/g, "").includes("\n"),
    false,
  );
  assert.equal(await fs.readFile(primary, "utf8"), original);
  assert.equal(await fs.readFile(legacy, "utf8"), legacyBefore);
  await f.write(primary, plan.writes[0].content);
  const reread = await readGameOptions(f.game, f.user);
  assert.equal(reread.values.renderer, "opengl");
  assert.equal(reread.values.vsync, false);
  assert.equal(reread.values.language, "l_simp_chinese");
  assert.equal(reread.values.windowed_resolution, "1600x900");
  assert.equal(reread.values.display_index, "1");
});

test("legacy settings supply initial values but are never included in write plans", async (t) => {
  const f = await fixture(t);
  await installLayout(f);
  const legacy = await f.write(
    path.join(f.user, "settings.txt"),
    'language="l_simp_chinese"\ngraphics={ size={ x=2560 y=1440 } adapter=2 refreshRate=165 vsync=no fullScreen=yes borderless=no }\n',
  );
  const result = await readGameOptions(f.game, f.user);
  assert.equal(result.values.language, "l_simp_chinese");
  assert.equal(result.values.display_mode, "fullscreen");
  assert.equal(result.values.display_index, "2");
  assert.equal(result.values.fullscreen_resolution, "2560x1440");
  assert.equal(result.values.refreshRate, "165");
  assert.equal(result.values.vsync, false);
  const plan = await planGameOptions(f.game, f.user, {
    display_mode: "windowed",
  });
  assert.equal(plan.writes.length, 1);
  assert.notEqual(plan.writes[0].path, legacy);
});

test("LFV1 JSON uses scalar categories and preserves unknown keys", async (t) => {
  const f = await fixture(t);
  await installLayout(f, { formatVersion: 1.1 });
  const original = {
    formatVersion: 1,
    Graphics: { renderer: "dx11", vsync: true, custom: { value: 77 } },
    System: { language: "l_english" },
    Future: { preserved: true },
  };
  const filename = await f.write(
    path.join(f.user, "pdx_settings.json"),
    JSON.stringify(original),
  );
  await f.write(
    path.join(f.user, "pdx_settings.txt"),
    '"Graphics"={"renderer"={value="opengl" version=0}}',
  );
  assert.equal((await readGameOptions(f.game, f.user)).values.renderer, "dx11");
  const plan = await planGameOptions(f.game, f.user, {
    vsync: false,
    language: "l_simp_chinese",
  });
  assert.equal(plan.writes[0].path, filename);
  const result = JSON.parse(plan.writes[0].content);
  assert.equal(result.Graphics.vsync, false);
  assert.deepEqual(result.Graphics.custom, { value: 77 });
  assert.deepEqual(result.Future, { preserved: true });
  assert.equal(result.System.language, "l_simp_chinese");
  assert.equal(result.formatVersion, 1);
  assert.deepEqual(JSON.parse(await fs.readFile(filename, "utf8")), original);
});

test("new LFV1 files include formatVersion and an empty patch creates no plan", async (t) => {
  const f = await fixture(t);
  await installLayout(f, { formatVersion: 1 });
  assert.deepEqual((await planGameOptions(f.game, f.user, {})).writes, []);
  const plan = await planGameOptions(f.game, f.user, { vsync: false });
  assert.deepEqual(JSON.parse(plan.writes[0].content), {
    Graphics: { vsync: false },
    formatVersion: 1,
  });
  await assert.rejects(fs.stat(f.user), { code: "ENOENT" });
});

test("invalid and unsupported options fail before proposing a write", async (t) => {
  const f = await fixture(t);
  await installLayout(f);
  for (const patch of [
    { hacked: "yes" },
    { vsync: "yes" },
    { renderer: "vulkan" },
    { display_mode: "bad" },
    { display_index: "-1" },
    { refreshRate: "0" },
    { fullscreen_resolution: "1x2" },
    { windowed_resolution: "1920x1080\nfoo=yes" },
    [],
  ]) {
    await assert.rejects(planGameOptions(f.game, f.user, patch));
  }
  const plan = await planGameOptions(f.game, f.user, {
    refreshRate: "143.999",
    display_index: 2,
  });
  assert.equal(plan.values.refreshRate, "143.999");
  assert.equal(plan.values.display_index, "2");
  await assert.rejects(fs.stat(f.user), { code: "ENOENT" });
});

test("malformed settings are read with a warning and cannot be overwritten", async (t) => {
  const f = await fixture(t);
  f.user = path.join(f.root, "用户 设置，但 {1}");
  await installLayout(f);
  const filename = await f.write(
    path.join(f.user, "pdx_settings.txt"),
    '"Graphics"={"renderer"={value="unclosed',
  );
  assert.match(
    (await readGameOptions(f.game, f.user)).warnings.join(" "),
    /无法解析/,
  );
  await assert.rejects(
    planGameOptions(f.game, f.user, { renderer: "opengl" }),
    (error) => {
      assert.match(error.message, /无法安全修改/);
      assert.equal(error.diagnostic.values[0], filename);
      assert.equal(
        error.diagnostic.values[1].key,
        "PDS 配置包含无法识别的字符。",
      );
      return true;
    },
  );
  assert.equal(
    await fs.readFile(filename, "utf8"),
    '"Graphics"={"renderer"={value="unclosed',
  );
});

test("metadata paths cannot escape the selected game and user directories", async (t) => {
  const f = await fixture(t);
  await f.metadata({ ingameSettingsLayoutPath: "../secret.json" });
  await assert.rejects(readGameOptions(f.game, f.user), /超出/);
  await installLayout(f, {
    formatVersion: 1,
    ingameSettingsPath: "../secret.json",
  });
  await assert.rejects(
    planGameOptions(f.game, f.user, { vsync: false }),
    /超出/,
  );
});

test("DLC scan uses descriptor ids, installed state and original disabled list", async (t) => {
  const f = await fixture(t);
  await f.write(
    path.join(f.game, "dlc", "music pack", "music.dlc"),
    'name="Sabaton 音乐"\npath="dlc/music pack"\nsteam_id="461800"\npops_id="hoi4_dlc013_sabaton"\ncategory="music"\n',
  );
  await f.write(
    path.join(f.game, "dlc", "missing", "missing.dlc"),
    'name="Missing payload"\npath="dlc/absent"\ncategory="content"\n',
  );
  await f.write(
    path.join(f.game, "dlc", "expansion", "expansion.dlc"),
    'name="Expansion"\npath="dlc/expansion"\nsteam_id="1234"\n',
  );
  const disabledIds = ["dlc/music pack/music.dlc", "dlc/unknown/unknown.dlc"];
  const original = JSON.stringify({
    disabled_dlcs: disabledIds,
    enabled_mods: ["mod/keep.mod"],
    custom: 7,
  });
  const load = await f.write(path.join(f.user, "dlc_load.json"), original);
  const result = await readDlc(f.game, f.user);
  const music = result.items.find((item) => item.steamId === "461800");
  assert.equal(music.id, "dlc/music pack/music.dlc");
  assert.equal(music.popsId, "hoi4_dlc013_sabaton");
  assert.equal(music.installed, true);
  assert.equal(music.enabled, false);
  assert.equal(music.category, "music");
  assert.equal(
    result.items.find((item) => item.name === "Missing payload").installed,
    false,
  );
  assert.equal(
    result.items.find((item) => item.name === "Expansion").enabled,
    true,
  );
  assert.deepEqual(result.disabledIds, disabledIds);
  assert.equal(await fs.readFile(load, "utf8"), original);
  assert.ok(result.items.every((item) => !own(item, "owned")));
});

function own(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

test("DLC scan reports malformed or escaped descriptors without modifying them", async (t) => {
  const f = await fixture(t);
  const filename = await f.write(
    path.join(f.game, "dlc", "bad.dlc"),
    'name="Outside"\npath="../outside"',
  );
  await f.write(path.join(f.user, "dlc_load.json"), "not-json");
  const result = await readDlc(f.game, f.user);
  assert.deepEqual(result.items, []);
  assert.equal(result.warnings.length, 2);
  assert.equal(
    await fs.readFile(filename, "utf8"),
    'name="Outside"\npath="../outside"',
  );
});

test("local continue metadata requires the referenced save but never parses its body", async (t) => {
  const f = await fixture(t);
  const value = {
    title: "战役 1940",
    desc: "My campaign",
    date: "Wed Oct 28 20:23:08 2026\n",
    filename: "autosave.hoi4",
    is_remote: false,
  };
  await f.write(path.join(f.user, "continue_game.json"), JSON.stringify(value));
  assert.equal((await readContinueGame(f.user)).available, false);
  await f.write(
    path.join(f.user, "save games", "autosave.hoi4"),
    "intentionally not a parsed savegame",
  );
  const result = await readContinueGame(f.user);
  assert.equal(result.available, true);
  assert.equal(result.filename, "autosave.hoi4");
  assert.equal(result.title, "战役 1940");
  assert.equal(result.date.endsWith("\n"), false);
  assert.equal(result.remote, false);
});

test("cloud continue metadata delegates retrieval to the game without a local save", async (t) => {
  const f = await fixture(t);
  await f.write(
    path.join(f.user, "continue_game.json"),
    JSON.stringify({
      title: "Cloud",
      filename: "cloud campaign.hoi4",
      is_remote: true,
    }),
  );
  const result = await readContinueGame(f.user);
  assert.equal(result.available, true);
  assert.equal(result.remote, true);
  assert.equal(result.filename, "cloud campaign.hoi4");
  await assert.rejects(fs.stat(path.join(f.user, "save games")), {
    code: "ENOENT",
  });
});

test("continue metadata rejects traversal, absolute paths and malformed records", async (t) => {
  const f = await fixture(t);
  const filename = path.join(f.user, "continue_game.json");
  for (const value of [
    { filename: "../../outside.hoi4", is_remote: true },
    { filename: path.join(f.root, "outside.hoi4") },
    { filename: "a.hoi4", is_remote: "false" },
    { filename: "" },
  ]) {
    await f.write(filename, JSON.stringify(value));
    const result = await readContinueGame(f.user);
    assert.equal(result.available, false);
    assert.match(result.reason, /无效/);
  }
  await f.write(filename, "{not-json");
  assert.equal((await readContinueGame(f.user)).available, false);
});
