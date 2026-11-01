"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createCampaignService } = require("../electron/campaigns.cjs");

async function fixture(t) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "ironclad-campaign-test-"),
  );
  t.after(async () => {
    assert.equal(path.dirname(root), os.tmpdir());
    assert.ok(path.basename(root).startsWith("ironclad-campaign-test-"));
    await fs.rm(root, {
      recursive: true,
      force: true,
      maxRetries: 8,
      retryDelay: 75,
    });
  });
  const user = path.join(root, "user"),
    save = path.join(user, "save games", "China.hoi4"),
    mod = path.join(root, "mod");
  await fs.mkdir(path.dirname(save), { recursive: true });
  await fs.mkdir(mod);
  await fs.writeFile(save, "save-one");
  await fs.writeFile(path.join(mod, "events.txt"), "one");
  const state = {
    settings: {
      activeGameInstanceId: "default",
      gameInstances: [{ id: "default", name: "默认版本" }],
      activePlaysetId: "a",
      playsets: [
        {
          id: "a",
          name: "战役组合",
          modIds: ["workshop:1"],
          modOrder: ["workshop:1"],
          modReferences: [],
          disabledDlcIds: null,
          unmappedDlcIds: [],
        },
      ],
      gameOptions: {},
      launchMode: "normal",
    },
    game: { found: true, version: "1.19.4", directory: root },
    paths: { userData: user },
    mods: [
      {
        id: "workshop:1",
        name: "Test Mod",
        source: "workshop",
        remoteId: "1",
        version: "1",
        available: true,
        contentPath: mod,
      },
    ],
    dlc: { items: [{ id: "D1", installed: true, enabled: true }] },
    gameOptions: { values: { language: "l_english" } },
    continueGame: { available: true, remote: false, filename: "China.hoi4" },
  };
  let running = false;
  const launcher = {
    getState: async () => structuredClone(state),
    saveSettings: async (patch) => {
      Object.assign(state.settings, structuredClone(patch));
      if (patch.gameOptions) state.gameOptions.values = patch.gameOptions;
      return state.settings;
    },
  };
  const options = {
    storageDirectory: path.join(root, "campaigns"),
    launcher,
    isGameRunning: async () => running,
  };
  return {
    root,
    user,
    save,
    mod,
    state,
    options,
    service: createCampaignService(options),
    setRunning: (v) => {
      running = v;
    },
  };
}
test("campaign binding persists a complete environment, notes, and a verified rescue save", async (t) => {
  const f = await fixture(t),
    c = await f.service.bind({
      savePath: f.save,
      name: "中国 1936",
      notes: "先发展工业",
    });
  assert.equal(c.environment.mods[0].contentStatus, "verified");
  assert.ok(c.environment.mods[0].contentDigest);
  assert.deepEqual(c.environment.dlcIds, ["D1"]);
  assert.equal(c.backups.length, 1);
  const reopened = createCampaignService(f.options),
    list = await reopened.list();
  assert.equal(list.campaigns[0].notes, "先发展工业");
  assert.equal(list.campaigns[0].available, true);
  const backup = path.join(
    f.root,
    "campaigns",
    "backups",
    c.id,
    c.backups[0].id + ".hoi4",
  );
  assert.equal(await fs.readFile(backup, "utf8"), "save-one");
  await assert.rejects(reopened.bind({ savePath: f.save }), /已经/);
  await reopened.update(c.id, { name: "新名字", notes: "继续" });
  assert.equal((await reopened.list()).campaigns[0].name, "新名字");
});
test("same-version content changes are reviewed and changing after review prevents continue", async (t) => {
  const f = await fixture(t),
    c = await f.service.bind({ savePath: f.save });
  await fs.writeFile(path.join(f.mod, "events.txt"), "two");
  const review = await f.service.reviewCurrent();
  assert.equal(review.campaign.id, c.id);
  assert.ok(review.changes.some((v) => v.kind === "mod-content"));
  await fs.writeFile(path.join(f.mod, "events.txt"), "new");
  await assert.rejects(
    f.service.resolveContinue(c.id, review.reviewId),
    /配置已变化/,
  );
  const checked = await f.service.review(c.id),
    result = await f.service.resolveContinue(c.id, checked.reviewId);
  assert.equal(result.filename, "China.hoi4");
  await assert.rejects(
    f.service.resolveContinue(c.id, checked.reviewId),
    /过期/,
  );
});
test("restoring save backup preserves the current save, validates digest and supports missing targets", async (t) => {
  const f = await fixture(t),
    c = await f.service.bind({ savePath: f.save });
  await fs.writeFile(f.save, "save-two");
  const restored = await f.service.restoreBackup(c.id, c.backups[0].id);
  assert.equal(await fs.readFile(f.save, "utf8"), "save-one");
  assert.equal(restored.backups.length, 2);
  assert.equal(
    await fs.readFile(
      path.join(
        f.root,
        "campaigns",
        "backups",
        c.id,
        restored.backups[1].id + ".hoi4",
      ),
      "utf8",
    ),
    "save-two",
  );
  await fs.unlink(f.save);
  await f.service.restoreBackup(c.id, c.backups[0].id);
  assert.equal(await fs.readFile(f.save, "utf8"), "save-one");
  await fs.writeFile(
    path.join(f.root, "campaigns", "backups", c.id, c.backups[0].id + ".hoi4"),
    "corrupt",
  );
  await assert.rejects(f.service.restoreBackup(c.id, c.backups[0].id), /摘要/);
  assert.equal(await fs.readFile(f.save, "utf8"), "save-one");
});
test("configuration restoration creates a new playset and preserves the existing one", async (t) => {
  const f = await fixture(t),
    c = await f.service.bind({ savePath: f.save });
  f.state.settings.playsets[0].modIds = [];
  f.state.dlc.items[0].enabled = false;
  const result = await f.service.restoreConfiguration(c.id);
  assert.equal(result.settings.playsets.length, 2);
  assert.deepEqual(result.settings.playsets[0].modIds, []);
  assert.deepEqual(result.settings.playsets[1].modIds, ["workshop:1"]);
  assert.notEqual(result.settings.activePlaysetId, "a");
});
test("campaign files are scoped to their instance, and unsafe paths or live game mutations are rejected", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.service.bind({ savePath: path.join(f.root, "outside.hoi4") }),
    /当前版本/,
  );
  const c = await f.service.bind({ savePath: f.save });
  f.state.settings.activeGameInstanceId = "other";
  assert.deepEqual((await f.service.list()).campaigns, []);
  await assert.rejects(f.service.backup(c.id), /其他版本/);
  f.state.settings.activeGameInstanceId = "default";
  f.setRunning(true);
  await assert.rejects(
    f.service.restoreBackup(c.id, c.backups[0].id),
    /退出游戏/,
  );
  await assert.rejects(
    f.service.update(c.id, { name: "a", notes: "b" }),
    /退出游戏/,
  );
});
test("corrupt records are retained and never silently overwritten", async (t) => {
  const f = await fixture(t),
    c = await f.service.bind({ savePath: f.save });
  const record = path.join(f.root, "campaigns", "records", c.id + ".json");
  await fs.writeFile(record, "broken");
  const list = await f.service.list();
  assert.equal(list.campaigns.length, 0);
  assert.equal(list.notices.length, 1);
  await assert.rejects(f.service.reviewCurrent(), /部分战役档案无法读取/);
  await assert.rejects(f.service.update(c.id, { name: "a", notes: "" }));
  assert.equal(await fs.readFile(record, "utf8"), "broken");
});
test("unbound continue is allowed only after a complete scan, while a valid matching record can still be reviewed", async (t) => {
  const f = await fixture(t);
  assert.equal(await f.service.reviewCurrent(), null);
  const c = await f.service.bind({ savePath: f.save });
  const broken = path.join(
    f.root,
    "campaigns",
    "records",
    "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa.json",
  );
  await fs.writeFile(broken, "broken unrelated record");
  assert.equal((await f.service.reviewCurrent()).campaign.id, c.id);
  f.state.continueGame.filename = "unbound.hoi4";
  await assert.rejects(f.service.reviewCurrent(), /部分战役档案无法读取/);
  assert.equal(await fs.readFile(broken, "utf8"), "broken unrelated record");
});
test("hardlinked save files cannot be bound or replaced", async (t) => {
  const f = await fixture(t);
  await fs.link(f.save, path.join(f.root, "linked.hoi4"));
  await assert.rejects(f.service.bind({ savePath: f.save }), /链接/);
  assert.equal(await fs.readFile(f.save, "utf8"), "save-one");
});

test("continue review is bound to the exact campaign record", async (t) => {
  const f = await fixture(t),
    c = await f.service.bind({ savePath: f.save });
  const review = await f.service.review(c.id);
  const recordPath = path.join(f.root, "campaigns", "records", c.id + ".json");
  const record = JSON.parse(await fs.readFile(recordPath));
  record.filename = "Other.hoi4";
  await fs.writeFile(
    path.join(path.dirname(f.save), "Other.hoi4"),
    "another-save",
  );
  await fs.writeFile(recordPath, JSON.stringify(record));
  await assert.rejects(
    f.service.resolveContinue(c.id, review.reviewId),
    /记录已变化/,
  );
});

test("an external write at save replacement is preserved and aborts restoration", async (t) => {
  const f = await fixture(t),
    c = await f.service.bind({ savePath: f.save });
  await fs.writeFile(f.save, "current-before-restore");
  const rename = fs.rename;
  let injected = false;
  fs.rename = async (source, target) => {
    if (
      source === f.save &&
      path.basename(target).startsWith(".ironclad-before-restore-")
    ) {
      injected = true;
      await fs.writeFile(f.save, "external-new-write");
    }
    return rename(source, target);
  };
  try {
    await assert.rejects(
      f.service.restoreBackup(c.id, c.backups[0].id),
      /外部修改/,
    );
  } finally {
    fs.rename = rename;
  }
  assert.ok(injected);
  assert.equal(await fs.readFile(f.save, "utf8"), "external-new-write");
});
