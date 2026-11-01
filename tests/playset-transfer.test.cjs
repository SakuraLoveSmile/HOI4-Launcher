"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { DatabaseSync } = require("node:sqlite");
const { createHash } = require("node:crypto");
const {
  readOfficialPlaysets,
  parsePlaysetDocument,
  serializePlayset,
} = require("../electron/playset-transfer.cjs");

async function fixture(t, { wal = false } = {}) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "ironclad-transfer-test-"),
  );
  const userData = path.join(root, "中文 用户目录");
  await fs.mkdir(userData, { recursive: true });
  const filename = path.join(userData, "launcher-v2.sqlite");
  const db = new DatabaseSync(filename);
  if (wal) db.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
  db.exec(`
    CREATE TABLE playsets(id TEXT PRIMARY KEY, name TEXT, isActive INTEGER, loadOrder TEXT, isRemoved INTEGER DEFAULT 0);
    CREATE TABLE mods(id TEXT PRIMARY KEY, steamId TEXT, pdxId TEXT, gameRegistryId TEXT, name TEXT, displayName TEXT, dirPath TEXT, archivePath TEXT, source TEXT, version TEXT, keepLatest INTEGER);
    CREATE TABLE playsets_mods(playsetId TEXT, modId TEXT, enabled INTEGER, position INTEGER);
    CREATE TABLE playsets_dlcs(playsetId TEXT, dlcId TEXT, enabled INTEGER);
    CREATE TABLE unrelated_account_data(secret TEXT);
    INSERT INTO unrelated_account_data VALUES('must-not-be-read-or-returned');
  `);
  let closed = false;
  const close = () => {
    if (!closed) {
      db.close();
      closed = true;
    }
  };
  t.after(async () => {
    close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const playset = (id, name = id, active = false, removed = false) =>
    db
      .prepare("INSERT INTO playsets VALUES(?, ?, ?, 'custom', ?)")
      .run(id, name, Number(active), Number(removed));
  const mod = (id, values = {}) =>
    db
      .prepare("INSERT INTO mods VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .run(
        id,
        values.steamId || null,
        values.pdxId || null,
        values.gameRegistryId || null,
        values.name || id,
        values.displayName || null,
        values.dirPath || null,
        values.archivePath || null,
        values.source || "local",
        values.version || null,
        values.keepLatest ?? 1,
      );
  const member = (playsetId, modId, enabled, position) =>
    db
      .prepare("INSERT INTO playsets_mods VALUES(?,?,?,?)")
      .run(playsetId, modId, Number(enabled), position);
  const dlc = (playsetId, dlcId, enabled) =>
    db
      .prepare("INSERT INTO playsets_dlcs VALUES(?,?,?)")
      .run(playsetId, dlcId, Number(enabled));
  return { root, userData, filename, db, close, playset, mod, member, dlc };
}

async function digest(filename) {
  const data = await fs.readFile(filename);
  const stat = await fs.stat(filename, { bigint: true });
  return {
    hash: createHash("sha256").update(data).digest("hex"),
    size: stat.size,
    mtime: stat.mtimeNs,
  };
}

function document(mods, name = "中文作战预设") {
  return JSON.stringify({ game: "hoi4", name, mods });
}
function steam(steamId, position = 0, enabled = true) {
  return { steamId, position, enabled, displayName: `Workshop ${steamId}` };
}

test("official JSON preserves disabled membership, ordering, missing identities and pinned Paradox versions", () => {
  const parsed = parsePlaysetDocument(
    document([
      steam("200", 8, false),
      {
        pdxId: "300",
        position: 4,
        enabled: true,
        displayName: "Pinned mod",
        version: "1.2.3",
      },
      steam("100", 1),
    ]),
    { mods: [{ id: "workshop:100", name: "本机名称", source: "workshop" }] },
  );
  assert.deepEqual(parsed.modOrder, [
    "workshop:100",
    "pdx:300",
    "workshop:200",
  ]);
  assert.deepEqual(parsed.modIds, ["workshop:100", "pdx:300"]);
  assert.equal(parsed.disabledDlcIds, null);
  assert.deepEqual(parsed.modReferences[2], {
    id: "workshop:200",
    name: "Workshop 200",
    source: "workshop",
    remoteId: "200",
  });
  assert.equal(parsed.modReferences[0].name, "本机名称");
  assert.equal(parsed.modReferences[1].version, "1.2.3");
});

test("JSON interchange roundtrip omits local files explicitly and retains missing remote members", () => {
  const playset = {
    name: "导出测试",
    modOrder: ["local:test.mod", "workshop:200", "pdx:300"],
    modIds: ["local:test.mod", "pdx:300"],
    modReferences: [
      {
        id: "pdx:300",
        name: "Missing pinned mod",
        source: "pdx",
        remoteId: "300",
        version: "2.4",
      },
    ],
  };
  const result = serializePlayset({
    playset,
    mods: [
      { id: "local:test.mod", name: "本地资料", source: "local" },
      { id: "workshop:200", name: "Steam 名称", source: "workshop" },
    ],
  });
  assert.deepEqual(result.omittedLocalMods, [
    { id: "local:test.mod", name: "本地资料" },
  ]);
  assert.deepEqual(result.document, {
    game: "hoi4",
    name: "导出测试",
    mods: [
      {
        displayName: "Steam 名称",
        steamId: "200",
        position: 0,
        enabled: false,
      },
      {
        displayName: "Missing pinned mod",
        pdxId: "300",
        position: 1,
        enabled: true,
        version: "2.4",
      },
    ],
  });
  const parsed = parsePlaysetDocument(JSON.stringify(result.document));
  assert.deepEqual(parsed.modOrder, ["workshop:200", "pdx:300"]);
  assert.deepEqual(parsed.modIds, ["pdx:300"]);
  assert.equal(parsed.modReferences[1].version, "2.4");
});

test("official JSON accepts BOM, optional extras and an empty vanilla playset", () => {
  const empty = parsePlaysetDocument(
    "\uFEFF" +
      JSON.stringify({
        game: "hoi4",
        name: "原版",
        mods: [],
        extra: { retainedByOtherApp: true },
      }),
  );
  assert.deepEqual(empty.modOrder, []);
  assert.deepEqual(empty.modIds, []);
  assert.equal(empty.name, "原版");
  const both = parsePlaysetDocument(
    document([{ ...steam("100"), pdxId: "200", version: "7" }]),
  );
  assert.deepEqual(both.modOrder, ["workshop:100"]);
  assert.equal(both.modReferences[0].source, "workshop");
  assert.equal(both.modReferences[0].version, undefined);
});

test("malformed interchange is rejected before any effects", () => {
  const invalid = [
    "{not json",
    "null",
    "[]",
    JSON.stringify({ game: "eu4", name: "X", mods: [] }),
    document([], ""),
    document([], "x".repeat(256)),
    document([{ ...steam("100"), enabled: "true" }]),
    document([{ ...steam("100"), position: -1 }]),
    document([{ ...steam("100"), position: 1.5 }]),
    document([{ ...steam("100"), position: 9007199254740992 }]),
    document([{ ...steam("100"), displayName: "bad\nname" }]),
    document([steam("100"), steam("100", 1)]),
    document([steam("100"), steam("200")]),
    document([steam("00100")]),
    document([steam("../100")]),
    document([{ displayName: "no ID", position: 0, enabled: true }]),
    document([
      {
        displayName: "bad pin",
        position: 0,
        enabled: true,
        pdxId: "200",
        version: {},
      },
    ]),
    document(Array(10001).fill(steam("100"))),
    " ".repeat(8 * 1024 * 1024 + 1),
  ];
  for (const text of invalid) assert.throws(() => parsePlaysetDocument(text));
  assert.throws(
    () =>
      serializePlayset({
        playset: {
          name: "Broken",
          modOrder: ["workshop:100"],
          modIds: ["workshop:200"],
        },
      }),
    /成员|顺序/,
  );
  assert.throws(
    () =>
      serializePlayset({
        playset: { name: "Broken", modOrder: ["workshop:invalid"], modIds: [] },
      }),
    /远程 ID/,
  );
});

test("official SQLite imports Unicode names, selected order, disabled and missing members without touching original", async (t) => {
  const f = await fixture(t);
  f.playset("p1", "中文预设", true);
  f.playset("p2", "Original");
  f.playset("deleted", "Removed", false, true);
  f.mod("m1", { steamId: "100", name: "Steam one", source: "steam" });
  f.mod("m2", { gameRegistryId: "mod/本地.mod", name: "Local one" });
  f.mod("m3", {
    pdxId: "300",
    name: "PDX missing",
    source: "pdx",
    version: "2.1",
    keepLatest: 0,
  });
  f.mod("m4", { steamId: "400", name: "Steam missing", source: "steam" });
  f.member("p1", "m1", false, 2);
  f.member("p1", "m2", true, 0);
  f.member("p1", "m3", true, 3);
  f.member("p1", "m4", false, 1);
  f.dlc("p1", "hoi4_test", false);
  f.dlc("p1", "hoi4_enabled", true);
  f.dlc("p2", "hoi4_test", true);
  f.close();
  const before = await digest(f.filename);
  const result = await readOfficialPlaysets({
    userData: f.userData,
    mods: [
      {
        id: "local:本地.mod",
        name: "Installed local",
        source: "local",
        descriptorPath: path.join(f.userData, "mod", "本地.mod"),
      },
      { id: "workshop:100", name: "Installed Steam", source: "workshop" },
    ],
    dlc: [{ id: "dlc/test/test.dlc", popsId: "hoi4_test" }],
  });
  assert.equal(result.playsets.length, 2);
  const imported = result.playsets.find((item) => item.sourceId === "p1");
  assert.equal(imported.name, "中文预设");
  assert.equal(imported.isActive, true);
  assert.deepEqual(imported.modOrder, [
    "local:本地.mod",
    "workshop:400",
    "workshop:100",
    "pdx:300",
  ]);
  assert.deepEqual(imported.modIds, ["local:本地.mod", "pdx:300"]);
  assert.equal(imported.modReferences[1].name, "Steam missing");
  assert.equal(imported.modReferences[3].version, "2.1");
  assert.deepEqual(imported.disabledDlcIds, ["dlc/test/test.dlc"]);
  assert.deepEqual(
    result.playsets.find((item) => item.sourceId === "p2").disabledDlcIds,
    [],
  );
  assert.equal(
    JSON.stringify(result).includes("must-not-be-read-or-returned"),
    false,
  );
  assert.deepEqual(await digest(f.filename), before);
  assert.deepEqual(await fs.readdir(f.userData), ["launcher-v2.sqlite"]);
});

test("WAL snapshot includes committed rows while official connection remains open", async (t) => {
  const f = await fixture(t, { wal: true });
  f.playset("wal", "Still in WAL", true);
  f.mod("m", { steamId: "999", name: "WAL mod", source: "steam" });
  f.member("wal", "m", true, 0);
  const originalDb = await digest(f.filename);
  const originalWal = await digest(`${f.filename}-wal`);
  const result = await readOfficialPlaysets({ userData: f.userData });
  assert.equal(result.playsets[0].name, "Still in WAL");
  assert.deepEqual(result.playsets[0].modIds, ["workshop:999"]);
  assert.deepEqual(await digest(f.filename), originalDb);
  assert.deepEqual(await digest(`${f.filename}-wal`), originalWal);
  assert.equal(
    f.db.prepare("SELECT count(*) AS count FROM playsets").get().count,
    1,
  );
});

test("explicit Paradox database sources override inherited Steam IDs and retain version pins", async (t) => {
  const f = await fixture(t);
  f.playset("p", "PDX source priority");
  for (const [index, source] of ["pdx", "pdx_mods"].entries()) {
    const id = `pdx-entry-${index}`;
    f.mod(id, {
      source,
      steamId: "100",
      pdxId: String(200 + index),
      version: String(7 + index),
      keepLatest: 0,
    });
    f.member("p", id, index === 0, index);
  }
  f.mod("steam-entry", {
    source: "steam_workshop",
    steamId: "100",
    pdxId: "999",
    version: "9",
    keepLatest: 0,
  });
  f.member("p", "steam-entry", true, 2);
  f.close();
  const before = await digest(f.filename);
  const result = await readOfficialPlaysets({ userData: f.userData });
  const imported = result.playsets[0];
  assert.deepEqual(imported.modOrder, ["pdx:200", "pdx:201", "workshop:100"]);
  assert.deepEqual(imported.modIds, ["pdx:200", "workshop:100"]);
  assert.deepEqual(
    imported.modReferences.map(({ source, remoteId, version }) => ({
      source,
      remoteId,
      version,
    })),
    [
      { source: "pdx", remoteId: "200", version: "7" },
      { source: "pdx", remoteId: "201", version: "8" },
      { source: "workshop", remoteId: "100", version: undefined },
    ],
  );
  assert.deepEqual(await digest(f.filename), before);
});

test("unknown disabled DLC is retained with warning instead of enabling all DLC", async (t) => {
  const f = await fixture(t);
  f.playset("p", "Unknown DLC");
  f.dlc("p", "missing_pops_id", false);
  f.dlc("p", "known", false);
  const result = await readOfficialPlaysets({
    userData: f.userData,
    dlc: [{ id: "dlc/known.dlc", popsId: "known" }],
  });
  assert.equal(result.playsets[0].disabledDlcIds, null);
  assert.deepEqual(result.playsets[0].unmappedDlcIds, ["missing_pops_id"]);
  assert.match(result.warnings.join(" "), /停用 DLC 无法映射/);
});

test("an active rollback-journal transaction is rejected instead of reading uncommitted state", async (t) => {
  const f = await fixture(t);
  f.playset("p", "Committed");
  f.db.exec("BEGIN IMMEDIATE; UPDATE playsets SET name = 'Uncommitted';");
  await assert.rejects(
    readOfficialPlaysets({ userData: f.userData }),
    /正在写入|正在更新/,
  );
  f.db.exec("ROLLBACK;");
  const result = await readOfficialPlaysets({ userData: f.userData });
  assert.equal(result.playsets[0].name, "Committed");
});

test("missing local descriptor and orphan database membership are retained as disabled or enabled unresolved identities", async (t) => {
  const f = await fixture(t);
  f.playset("p");
  f.mod("bad", { name: "Lost local", dirPath: "D:/missing" });
  f.member("p", "bad", false, 0);
  f.member("p", "orphan", true, 1);
  const one = await readOfficialPlaysets({ userData: f.userData });
  const two = await readOfficialPlaysets({ userData: f.userData });
  assert.equal(one.playsets[0].modOrder.length, 2);
  assert.equal(one.playsets[0].modIds.length, 1);
  assert.match(one.playsets[0].modOrder[0], /^local:unresolved-.*\.mod$/);
  assert.deepEqual(one.playsets[0].modOrder, two.playsets[0].modOrder);
  assert.match(one.warnings.join(" "), /缺失项/);
});

test("older registry-only Workshop identity and local content-path matching resolve correctly", async (t) => {
  const f = await fixture(t);
  f.playset("p");
  f.mod("old", {
    gameRegistryId: "mod\\ugc_123.mod",
    name: "Old Steam",
    source: "steam",
  });
  f.mod("local", { dirPath: "D:\\local\\My Mod", name: "Local folder" });
  f.member("p", "old", true, 0);
  f.member("p", "local", true, 1);
  const result = await readOfficialPlaysets({
    userData: f.userData,
    mods: [
      {
        id: "local:custom.mod",
        source: "local",
        contentPath: "d:/LOCAL/My Mod/",
        name: "Mapped local",
      },
    ],
  });
  assert.deepEqual(result.playsets[0].modOrder, [
    "workshop:123",
    "local:custom.mod",
  ]);
});

test("duplicate identities and unsupported or corrupt official databases fail without mutation", async (t) => {
  const f = await fixture(t);
  f.playset("p");
  f.mod("m1", { steamId: "100", source: "steam" });
  f.mod("m2", { steamId: "100", source: "steam" });
  f.member("p", "m1", true, 0);
  f.member("p", "m2", false, 1);
  f.close();
  const before = await digest(f.filename);
  await assert.rejects(
    readOfficialPlaysets({ userData: f.userData }),
    /重复模组/,
  );
  assert.deepEqual(await digest(f.filename), before);
  await fs.writeFile(f.filename, "corrupt database fixture");
  const corrupt = await digest(f.filename);
  await assert.rejects(
    readOfficialPlaysets({ userData: f.userData }),
    /无法读取官方预设数据库|结构不受支持/,
  );
  assert.deepEqual(await digest(f.filename), corrupt);
});

test("absent database is reported without creating game-user files", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ironclad-no-db-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const userData = path.join(root, "not-created");
  const result = await readOfficialPlaysets({ userData });
  assert.deepEqual(result.playsets, []);
  assert.match(result.warnings[0], /没有官方启动器预设数据库/);
  await assert.rejects(fs.stat(userData), { code: "ENOENT" });
});
