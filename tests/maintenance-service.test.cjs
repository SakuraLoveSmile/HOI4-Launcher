"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const {
  getCachePlan,
  backupAndClearCache,
  listCacheBackups,
  restoreCacheBackup,
} = require("../electron/maintenance-service.cjs");

async function fixture(
  t,
  gameCachePaths = [
    "cache/",
    "shadercache/",
    "naval_dist.cache",
    "mod/",
    "game rules/",
    "playlists/",
    "continue_game.json",
    "pops_filestorage/",
    "pops_filestorage.index",
  ],
) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "ironclad-maintenance-test-"),
  );
  const gameDirectory = path.join(root, "中文 Game");
  const userData = path.join(root, "中文 User Data");
  await fs.mkdir(gameDirectory, { recursive: true });
  await fs.mkdir(userData, { recursive: true });
  await fs.writeFile(
    path.join(gameDirectory, "launcher-settings.json"),
    JSON.stringify({ gameCachePaths }),
  );
  const write = async (relative, content = relative) => {
    const target = path.join(userData, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
    return target;
  };
  const read = (relative) => fs.readFile(path.join(userData, relative), "utf8");
  const options = { gameDirectory, userData };
  const store = path.join(userData, "ironclad-cache-backups");
  const backupPath = (id, relative) => path.join(store, id, "data", relative);
  t.after(() =>
    fs.rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    }),
  );
  return {
    root,
    gameDirectory,
    userData,
    write,
    read,
    options,
    store,
    backupPath,
  };
}

async function noPath(target) {
  await assert.rejects(fs.lstat(target), { code: "ENOENT" });
}

test("plan distinguishes safe default caches from local mods, rules, resume and cloud user content without writing", async (t) => {
  const f = await fixture(t);
  await f.write("cache/texture.bin", "cached");
  await f.write("naval_dist.cache", "distance");
  await f.write("mod/local.mod", "local mod");
  const before = (await fs.readdir(f.userData)).sort();
  const plan = await getCachePlan(f.options);
  assert.equal(
    plan.targets.find((target) => target.id === "cache").selectedByDefault,
    true,
  );
  assert.equal(
    plan.targets.find((target) => target.id === "shadercache")
      .selectedByDefault,
    false,
  );
  assert.equal(
    plan.targets.find((target) => target.id === "naval_dist.cache")
      .selectedByDefault,
    true,
  );
  for (const id of [
    "mod",
    "game rules",
    "playlists",
    "continue_game.json",
    "pops_filestorage",
    "pops_filestorage.index",
  ]) {
    assert.equal(
      plan.targets.find((target) => target.id === id).containsUserContent,
      true,
    );
    assert.equal(
      plan.targets.find((target) => target.id === id).selectedByDefault,
      false,
    );
  }
  assert.deepEqual((await fs.readdir(f.userData)).sort(), before);
  await noPath(f.store);
});

test("malicious metadata cannot target saves, account data, settings, databases, backups or traversal", async (t) => {
  const prohibited = [
    "../outside",
    "C:\\outside",
    "\\\\server\\share",
    "cache/../../saves",
    ".",
    "cache/",
    "cache/shaders",
    "CACHE",
    "save games",
    "accounts",
    "auth-token.json",
    "settings.txt",
    "pdx_settings.json",
    "settings_backup.txt",
    "userSettings.json",
    "launcher-v2.sqlite",
    "launcher-v2.sqlite-wal",
    "launcher-v2_backup.sqlite",
    "dlc_load.json",
    "playset_config.json",
    "playsets_backup",
    "ironclad-cache-backups",
    "dlc_load.json.ironclad-backup-original",
    "nul",
    "cache/evil ",
    "cache/evil.",
  ];
  const f = await fixture(t, prohibited);
  await f.write("cache/shaders/old.bin");
  await f.write("save games/campaign.hoi4", "save");
  const plan = await getCachePlan(f.options);
  assert.deepEqual(
    plan.targets.map((target) => target.id),
    ["cache"],
  );
  assert.ok(plan.warnings.length >= 15);
  assert.match(plan.warnings.join(" "), /重叠/);
  await assert.rejects(
    backupAndClearCache({ ...f.options, targetIds: ["save games"] }),
    /不安全|已变化/,
  );
  await assert.rejects(
    backupAndClearCache({
      ...f.options,
      targetIds: ["cache", "cache/shaders"],
    }),
    /不安全|已变化/,
  );
  assert.equal(await f.read("save games/campaign.hoi4"), "save");
  assert.equal(await f.read("cache/shaders/old.bin"), "cache/shaders/old.bin");
  await noPath(f.store);
});

test("metadata fallback is bounded and absent user directory is not created during planning or listing", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(
    path.join(f.gameDirectory, "launcher-settings.json"),
    "{" + " ".repeat(1024 * 1024),
  );
  const userData = path.join(f.root, "missing-user");
  const result = await getCachePlan({
    gameDirectory: f.gameDirectory,
    userData,
  });
  assert.equal(result.targets.length, 4);
  assert.ok(
    result.targets.every(
      (target) => !target.exists && !target.selectedByDefault,
    ),
  );
  assert.equal(result.warnings.length, 1);
  assert.deepEqual(await listCacheBackups({ userData }), []);
  await noPath(userData);
});

test("explicitly selected files and directories move to a journaled backup and restore byte-for-byte", async (t) => {
  const f = await fixture(t);
  await f.write("cache/sub/texture.bin", "original cache");
  await f.write("naval_dist.cache", "original distance");
  await f.write("mod/local.mod", "untouched user mod");
  const backup = await backupAndClearCache({
    ...f.options,
    targetIds: ["cache", "naval_dist.cache"],
  });
  await noPath(path.join(f.userData, "cache"));
  await noPath(path.join(f.userData, "naval_dist.cache"));
  assert.equal(
    await fs.readFile(f.backupPath(backup.id, "cache/sub/texture.bin"), "utf8"),
    "original cache",
  );
  assert.equal(await f.read("mod/local.mod"), "untouched user mod");
  const journal = await fs.readFile(
    path.join(f.store, backup.id, "journal.ndjson"),
    "utf8",
  );
  assert.ok(
    journal.includes('"state":"pending"') && journal.includes('"state":"done"'),
  );
  const listed = await listCacheBackups({ userData: f.userData });
  assert.equal(listed[0].status, "completed");
  assert.equal(listed[0].targets.length, 2);
  assert.deepEqual(
    await restoreCacheBackup({ userData: f.userData, id: backup.id }),
    { id: backup.id, restored: true },
  );
  assert.equal(await f.read("cache/sub/texture.bin"), "original cache");
  assert.equal(await f.read("naval_dist.cache"), "original distance");
  assert.equal(
    (await listCacheBackups({ userData: f.userData }))[0].status,
    "restored",
  );
  await assert.rejects(
    restoreCacheBackup({ userData: f.userData, id: backup.id }),
    /已恢复/,
  );
});

test("user-content candidates are only moved after being explicitly selected", async (t) => {
  const f = await fixture(t);
  await f.write("mod/local.mod", "source");
  const backup = await backupAndClearCache({
    ...f.options,
    targetIds: ["mod"],
  });
  assert.equal(backup.targets[0].containsUserContent, true);
  assert.equal(
    await fs.readFile(f.backupPath(backup.id, "mod/local.mod"), "utf8"),
    "source",
  );
  await restoreCacheBackup({ userData: f.userData, id: backup.id });
  assert.equal(await f.read("mod/local.mod"), "source");
});

test("restore first preserves newly recreated current contents as a separate restorable backup", async (t) => {
  const f = await fixture(t);
  await f.write("cache/data.bin", "old-cache");
  const backup = await backupAndClearCache({
    ...f.options,
    targetIds: ["cache"],
  });
  await f.write("cache/data.bin", "new-cache");
  await f.write("cache/new-file.bin", "new-only");
  await restoreCacheBackup({ userData: f.userData, id: backup.id });
  assert.equal(await f.read("cache/data.bin"), "old-cache");
  await noPath(path.join(f.userData, "cache/new-file.bin"));
  const backups = await listCacheBackups({ userData: f.userData });
  const preserved = backups.find(
    (item) => item.id !== backup.id && item.status === "completed",
  );
  assert.ok(preserved);
  assert.equal(
    await fs.readFile(f.backupPath(preserved.id, "cache/data.bin"), "utf8"),
    "new-cache",
  );
  assert.equal(
    await fs.readFile(f.backupPath(preserved.id, "cache/new-file.bin"), "utf8"),
    "new-only",
  );
  await restoreCacheBackup({ userData: f.userData, id: preserved.id });
  assert.equal(await f.read("cache/data.bin"), "new-cache");
  assert.equal(await f.read("cache/new-file.bin"), "new-only");
});

test("a failure halfway through clearing rolls earlier moves back without losing source files", async (t) => {
  const f = await fixture(t);
  await f.write("cache/a.bin", "A");
  await f.write("shadercache/b.bin", "B");
  const fileOps = {
    rename: async (from, to) => {
      if (from === path.join(f.userData, "shadercache"))
        throw Object.assign(new Error("fixture failure"), { code: "EPERM" });
      return fs.rename(from, to);
    },
  };
  await assert.rejects(
    backupAndClearCache({
      ...f.options,
      targetIds: ["cache", "shadercache"],
      fileOps,
    }),
    /已恢复原有文件/,
  );
  assert.equal(await f.read("cache/a.bin"), "A");
  assert.equal(await f.read("shadercache/b.bin"), "B");
  assert.deepEqual(await listCacheBackups({ userData: f.userData }), []);
});

test("a partial restore failure restores both the original backup and current recreated files", async (t) => {
  const f = await fixture(t);
  await f.write("cache/a.bin", "old-A");
  await f.write("shadercache/b.bin", "old-B");
  const backup = await backupAndClearCache({
    ...f.options,
    targetIds: ["cache", "shadercache"],
  });
  await f.write("cache/a.bin", "new-A");
  await f.write("shadercache/b.bin", "new-B");
  const fileOps = {
    rename: async (from, to) => {
      if (from === f.backupPath(backup.id, "shadercache"))
        throw Object.assign(new Error("restore failure"), { code: "EPERM" });
      return fs.rename(from, to);
    },
  };
  await assert.rejects(
    restoreCacheBackup({ userData: f.userData, id: backup.id, fileOps }),
    /已回退到恢复前状态/,
  );
  assert.equal(await f.read("cache/a.bin"), "new-A");
  assert.equal(await f.read("shadercache/b.bin"), "new-B");
  assert.equal(
    await fs.readFile(f.backupPath(backup.id, "cache/a.bin"), "utf8"),
    "old-A",
  );
  assert.equal(
    await fs.readFile(f.backupPath(backup.id, "shadercache/b.bin"), "utf8"),
    "old-B",
  );
  assert.equal(
    (await listCacheBackups({ userData: f.userData })).find(
      (entry) => entry.id === backup.id,
    ).status,
    "completed",
  );
});

test("if rollback is blocked the original payload remains in an explicit recovery-required backup", async (t) => {
  const f = await fixture(t);
  await f.write("cache/a.bin", "preserve-A");
  await f.write("shadercache/b.bin", "preserve-B");
  const fileOps = {
    rename: async (from, to) => {
      if (
        from === path.join(f.userData, "shadercache") ||
        (to === path.join(f.userData, "cache") && from.includes(f.store))
      )
        throw Object.assign(new Error("locked by fixture"), { code: "EPERM" });
      return fs.rename(from, to);
    },
  };
  await assert.rejects(
    backupAndClearCache({
      ...f.options,
      targetIds: ["cache", "shadercache"],
      fileOps,
    }),
    /部分文件仍保留在备份/,
  );
  assert.equal(await f.read("shadercache/b.bin"), "preserve-B");
  const backups = await listCacheBackups({ userData: f.userData });
  assert.equal(backups[0].status, "recovery-required");
  assert.equal(
    await fs.readFile(f.backupPath(backups[0].id, "cache/a.bin"), "utf8"),
    "preserve-A",
  );
});

test("junction escapes in a target, nested target or backup store are rejected without touching the outside tree", async (t) => {
  const f = await fixture(t, ["cache", "mod"]);
  const outside = path.join(f.root, "outside");
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "keep.txt"), "outside");
  try {
    await fs.symlink(outside, path.join(f.userData, "cache"), "junction");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
      t.skip("Junction creation is unavailable on this host");
      return;
    }
    throw error;
  }
  await fs.mkdir(path.join(f.userData, "mod"));
  await fs.symlink(outside, path.join(f.userData, "mod", "link"), "junction");
  const plan = await getCachePlan(f.options);
  assert.deepEqual(plan.targets, []);
  assert.match(plan.warnings.join(" "), /链接|联接/);
  await assert.rejects(
    backupAndClearCache({ ...f.options, targetIds: ["cache"] }),
    /不安全|已变化/,
  );
  await fs.unlink(path.join(f.userData, "cache"));
  await f.write("cache/file.bin", "real cache");
  await fs.symlink(outside, f.store, "junction");
  await assert.rejects(
    backupAndClearCache({ ...f.options, targetIds: ["cache"] }),
    /链接|联接/,
  );
  assert.equal(
    await fs.readFile(path.join(outside, "keep.txt"), "utf8"),
    "outside",
  );
  assert.equal(await f.read("cache/file.bin"), "real cache");
});

test("untrusted backup manifests reject traversal, protected paths, overlap, identity changes and invalid IDs", async (t) => {
  const f = await fixture(t);
  await f.write("cache/data.bin", "original");
  await f.write("save games/campaign.hoi4", "protected");
  const backup = await backupAndClearCache({
    ...f.options,
    targetIds: ["cache"],
  });
  const manifestPath = path.join(f.store, backup.id, "manifest.json");
  const original = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const mutations = [
    (value) => {
      value.targets[0].relativePath = "../outside";
    },
    (value) => {
      value.targets[0].relativePath = "save games";
      value.targets[0].id = "save games";
    },
    (value) => {
      value.targets.push({
        ...value.targets[0],
        id: "cache/nested",
        relativePath: "cache/nested",
      });
    },
    (value) => {
      value.id = "different";
    },
    (value) => {
      value.targets[0].id = "different";
    },
    (value) => {
      value.targets[0].kind = "symlink";
    },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(original);
    mutate(changed);
    await fs.writeFile(manifestPath, JSON.stringify(changed));
    await assert.rejects(
      restoreCacheBackup({ userData: f.userData, id: backup.id }),
    );
    assert.equal(await f.read("save games/campaign.hoi4"), "protected");
    assert.equal(
      await fs.readFile(f.backupPath(backup.id, "cache/data.bin"), "utf8"),
      "original",
    );
  }
  assert.equal(
    (await listCacheBackups({ userData: f.userData }))[0].status,
    "invalid",
  );
  await assert.rejects(
    restoreCacheBackup({ userData: f.userData, id: "../outside" }),
    /标识无效/,
  );
});

test("a forged symlink in backup data cannot escape on restore", async (t) => {
  const f = await fixture(t);
  await f.write("cache/data.bin", "original");
  const backup = await backupAndClearCache({
    ...f.options,
    targetIds: ["cache"],
  });
  const outside = path.join(f.root, "outside");
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "keep.txt"), "keep");
  try {
    await fs.symlink(
      outside,
      f.backupPath(backup.id, "cache/junction"),
      "junction",
    );
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
      t.skip("Junction creation is unavailable on this host");
      return;
    }
    throw error;
  }
  await f.write("cache/current.bin", "current");
  await assert.rejects(
    restoreCacheBackup({ userData: f.userData, id: backup.id }),
    /链接|联接/,
  );
  assert.equal(await f.read("cache/current.bin"), "current");
  assert.equal(
    await fs.readFile(path.join(outside, "keep.txt"), "utf8"),
    "keep",
  );
});

test("protected content nested under a cache target is excluded before any move", async (t) => {
  const f = await fixture(t, ["cache"]);
  await f.write("cache/accounts/private.json", "private fixture");
  const plan = await getCachePlan(f.options);
  assert.deepEqual(plan.targets, []);
  assert.match(plan.warnings[0], /受保护资料/);
  await assert.rejects(
    backupAndClearCache({ ...f.options, targetIds: ["cache"] }),
    /不安全|已变化/,
  );
  assert.equal(await f.read("cache/accounts/private.json"), "private fixture");
});

test("an untrusted hard-linked journal is atomically replaced without modifying its outside counterpart", async (t) => {
  const f = await fixture(t);
  await f.write("cache/data.bin", "original");
  const backup = await backupAndClearCache({
    ...f.options,
    targetIds: ["cache"],
  });
  const journal = path.join(f.store, backup.id, "journal.ndjson");
  const outside = path.join(f.root, "outside-journal.txt");
  await fs.writeFile(outside, "untouched outside contents\n");
  await fs.unlink(journal);
  await fs.link(outside, journal);
  await restoreCacheBackup({ userData: f.userData, id: backup.id });
  assert.equal(await f.read("cache/data.bin"), "original");
  assert.equal(
    await fs.readFile(outside, "utf8"),
    "untouched outside contents\n",
  );
  assert.ok(
    (await fs.readFile(journal, "utf8")).includes('"action":"restore"'),
  );
});

test("invalid selections do not create a backup and concurrent clears serialize safely", async (t) => {
  const f = await fixture(t);
  await f.write("cache/data.bin", "one source");
  for (const targetIds of [[], ["cache", "cache"], ["missing"], [null]]) {
    await assert.rejects(backupAndClearCache({ ...f.options, targetIds }));
  }
  await noPath(f.store);
  const results = await Promise.allSettled([
    backupAndClearCache({ ...f.options, targetIds: ["cache"] }),
    backupAndClearCache({ ...f.options, targetIds: ["cache"] }),
  ]);
  assert.equal(
    results.filter((entry) => entry.status === "fulfilled").length,
    1,
  );
  assert.equal(
    results.filter((entry) => entry.status === "rejected").length,
    1,
  );
  const backups = await listCacheBackups({ userData: f.userData });
  assert.equal(backups.length, 1);
  assert.equal(
    await fs.readFile(f.backupPath(backups[0].id, "cache/data.bin"), "utf8"),
    "one source",
  );
});
