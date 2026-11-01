"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createLauncherService } = require("../electron/launcher-service.cjs");
const { createModProjectService } = require("../electron/mod-projects.cjs");
const {
  createPlaysetSnapshotService,
} = require("../electron/playset-snapshots.cjs");
const { zipFixture } = require("../scripts/pdx-fixture.cjs");
const data = require("../electron/managed-data.cjs");

async function fixture(t) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "ironclad-snapshot-test-"),
  );
  t.after(async () => {
    assert.equal(path.dirname(root), os.tmpdir());
    assert.ok(path.basename(root).startsWith("ironclad-snapshot-test-"));
    await fs.rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  });
  const game = path.join(root, "game"),
    user = path.join(root, "Paradox Interactive", "Hearts of Iron IV"),
    steam = path.join(root, "steam"),
    local = path.join(user, "mod", "original"),
    workshop = path.join(
      steam,
      "steamapps",
      "workshop",
      "content",
      "394360",
      "246",
    ),
    archive = path.join(root, "content.zip"),
    storage = path.join(root, "snapshots");
  const write = async (filename, bytes) => {
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, bytes);
    return filename;
  };
  await write(path.join(game, "hoi4.exe"), "not executable; never run");
  await write(
    path.join(game, "launcher-settings.json"),
    '{"rawVersion":"1.19.4.0"}',
  );
  await write(
    path.join(local, "descriptor.mod"),
    'name="Internal old name"\nversion="1"\nreplace_path="internal/incorrect"\n',
  );
  await write(path.join(local, "events", "sample.txt"), "local-original");
  await fs.mkdir(path.join(local, "empty-folder"));
  await write(
    path.join(user, "mod", "original.mod"),
    `name="Local author"\nversion="1"\npops_id="888"\nreplace_path="common/ideas"\npath=${JSON.stringify(local.replaceAll("\\", "/"))}\n`,
  );
  await write(
    path.join(workshop, "descriptor.mod"),
    'name="Steam author"\nversion="2"\nremote_file_id="246"\nreplace_path="history/states"\n',
  );
  await write(path.join(workshop, "history", "sample.txt"), "steam-original");
  await write(
    archive,
    zipFixture({
      "descriptor.mod":
        'name="Internal zip"\nreplace_path="internal/zip-wrong"\n',
      "events/zip.txt": "zip-original",
    }),
  );
  await write(
    path.join(user, "mod", "pdx_777_9.mod"),
    `name="PDX archive"\nversion="3"\npops_id="777"\nreplace_path="common/units"\narchive=${JSON.stringify(archive.replaceAll("\\", "/"))}\n`,
  );
  await write(
    path.join(user, "mod", "off.mod"),
    `name="Disabled"\npath=${JSON.stringify(path.join(root, "not-installed").replaceAll("\\", "/"))}\n`,
  );
  let projects,
    running = false;
  const launcher = createLauncherService({
    settingsPath: path.join(root, "settings.json"),
    documentsPath: root,
    steamRoots: [steam],
    processProbe: async () => null,
    spawnProcess: () => {
      throw Error("real game launch forbidden");
    },
    getModProjects: async () =>
      projects ? (await projects.list()).projects : [],
    resolveProjectVersion: (...args) => projects.resolveVersion(...args),
  });
  await launcher.saveSettings({ gameDirectory: game });
  projects = createModProjectService({
    storageDirectory: path.join(root, "projects"),
    getUserDataPath: async () =>
      (await launcher.getSourceState()).paths.userData,
    isGameRunning: async () => running,
  });
  await launcher.saveSettings({
    playsets: [
      {
        id: "default",
        name: "Original playset",
        modIds: ["workshop:246", "local:original.mod", "pdx:777"],
        modOrder: [
          "workshop:246",
          "local:off.mod",
          "local:original.mod",
          "pdx:777",
        ],
        modReferences: [
          {
            id: "pdx:777",
            name: "PDX archive",
            source: "pdx",
            remoteId: "777",
            version: "9",
          },
          {
            id: "local:off.mod",
            name: "Disabled",
            source: "local",
            remoteId: null,
          },
        ],
        disabledDlcIds: [],
        unmappedDlcIds: [],
      },
    ],
    activePlaysetId: "default",
  });
  const make = (extra = {}) =>
    createPlaysetSnapshotService({
      storageDirectory: storage,
      launcher,
      projects,
      isGameRunning: async () => running,
      ...extra,
    });
  return {
    root,
    game,
    user,
    local,
    workshop,
    archive,
    storage,
    launcher,
    projects,
    write,
    make,
    service: make(),
    setRunning: (value) => {
      running = value;
    },
  };
}

test(
  "a complete independent snapshot preserves Steam, PDX ZIP, local bytes, disabled order and empty directories",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t),
      settings = (await f.launcher.getState()).settings;
    const snapshot = await f.service.create({ name: "Long campaign" });
    assert.equal(snapshot.status, "complete");
    assert.equal(snapshot.modCount, 3);
    assert.equal((await f.projects.list()).projects.length, 0);
    assert.deepEqual(
      snapshot.environment.playset.modOrder,
      settings.playsets[0].modOrder,
    );
    assert.ok(
      snapshot.environment.mods.every((m) => m.contentStatus === "verified"),
    );
    const directory = await f.service.resolveDirectory(snapshot.id);
    assert.equal(
      (
        await fs.stat(
          path.join(directory, "mods", "00001", "content", "empty-folder"),
        )
      ).isDirectory(),
      true,
    );
    await f.write(path.join(f.local, "events", "sample.txt"), "author-updated");
    await f.write(f.archive, zipFixture({ "changed.txt": "new version" }));
    assert.equal(
      await fs.readFile(
        path.join(
          directory,
          "mods",
          "00001",
          "content",
          "events",
          "sample.txt",
        ),
        "utf8",
      ),
      "local-original",
    );
    assert.equal((await f.service.verify(snapshot.id)).valid, true);
    assert.equal((await f.make().list()).snapshots[0].id, snapshot.id);
    assert.deepEqual((await f.launcher.getState()).settings, settings);
  },
);

test(
  "restore creates fixed local projects and one new playset, preserves originals and honors external descriptors",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t),
      snapshot = await f.service.create({ name: "Restore set" }),
      before = (await f.launcher.getState()).settings;
    await f.write(path.join(f.local, "events", "sample.txt"), "author-new");
    const result = await f.service.restore(snapshot.id),
      current = result.state.settings.playsets.find(
        (p) => p.id === result.restoredPlaysetId,
      );
    assert.deepEqual(result.state.settings.playsets[0], before.playsets[0]);
    assert.equal(result.state.settings.playsets.length, 2);
    assert.equal(current.modIds.length, 3);
    assert.equal(current.modOrder[1], "local:off.mod");
    assert.ok(current.modReferences.some((r) => r.id === "local:off.mod"));
    assert.ok(
      current.modReferences
        .filter((r) => current.modIds.includes(r.id))
        .every((r) => r.source === "local" && data.UUID.test(r.version)),
    );
    const created = (await f.projects.list()).projects;
    assert.equal(created.length, 3);
    const restoredLocal = created.find(
        (p) => p.originModId === "local:original.mod",
      ),
      restoredZip = created.find((p) => p.originModId === "pdx:777");
    const localFixed = await f.projects.resolveVersion(
        restoredLocal.id,
        restoredLocal.baseSnapshotId,
      ),
      zipFixed = await f.projects.resolveVersion(
        restoredZip.id,
        restoredZip.baseSnapshotId,
      );
    assert.equal(
      await fs.readFile(
        path.join(localFixed.contentPath, "events", "sample.txt"),
        "utf8",
      ),
      "local-original",
    );
    assert.match(localFixed.descriptorText, /common\/ideas/);
    assert.doesNotMatch(
      localFixed.descriptorText,
      /internal\/incorrect|pops_id|remote_file_id/,
    );
    assert.match(zipFixed.descriptorText, /common\/units/);
    assert.doesNotMatch(
      zipFixed.descriptorText,
      /internal\/zip-wrong|pops_id|remote_file_id/,
    );
    assert.equal(
      await fs.readFile(
        path.join(zipFixed.contentPath, "events", "zip.txt"),
        "utf8",
      ),
      "zip-original",
    );
    assert.equal(
      await fs.readFile(path.join(f.local, "events", "sample.txt"), "utf8"),
      "author-new",
    );
    await f.write(
      path.join(restoredLocal.workPath, "events", "sample.txt"),
      "experiment",
    );
    assert.equal(
      (await f.launcher.getState()).mods.find(
        (m) => m.id === restoredLocal.modId,
      ).projectVersion,
      restoredLocal.baseSnapshotId,
    );
  },
);

test("an empty vanilla snapshot creates and restores without creating projects", async (t) => {
  const f = await fixture(t);
  await f.launcher.saveSettings({
    playsets: [{ id: "default", name: "Vanilla", modIds: [] }],
    activePlaysetId: "default",
  });
  const snapshot = await f.service.create({ name: "Vanilla set" });
  assert.equal(snapshot.modCount, 0);
  assert.equal(snapshot.totalBytes, 0);
  assert.equal((await f.service.verify(snapshot.id)).valid, true);
  const result = await f.service.restore(snapshot.id);
  assert.equal(result.state.settings.playsets.length, 2);
  assert.deepEqual(result.state.settings.playsets[1].modIds, []);
  assert.equal((await f.projects.list()).projects.length, 0);
});

test("a local mod without embedded descriptor restores using the saved external descriptor", async (t) => {
  const f = await fixture(t);
  await fs.unlink(path.join(f.local, "descriptor.mod"));
  await f.launcher.saveSettings({
    playsets: [
      { id: "default", name: "Legacy local", modIds: ["local:original.mod"] },
    ],
  });
  const snapshot = await f.service.create({ name: "Legacy set" });
  await f.service.restore(snapshot.id);
  const project = (await f.projects.list()).projects[0],
    fixed = await f.projects.resolveVersion(project.id, project.baseSnapshotId);
  assert.match(fixed.descriptorText, /common\/ideas/);
  assert.doesNotMatch(fixed.descriptorText, /pops_id/);
});

test("corrupt stored content and descriptors refuse verification and restoration without changing active configuration", async (t) => {
  const f = await fixture(t),
    snapshot = await f.service.create({ name: "Integrity" }),
    directory = await f.service.resolveDirectory(snapshot.id),
    before = (await f.launcher.getState()).settings;
  await f.write(
    path.join(directory, "mods", "00000", "content", "history", "sample.txt"),
    "tampered",
  );
  await assert.rejects(f.service.verify(snapshot.id), /变化|核验/);
  await assert.rejects(f.service.restore(snapshot.id));
  assert.deepEqual((await f.launcher.getState()).settings, before);
  assert.equal((await f.projects.list()).projects.length, 0);
  assert.equal(
    await fs.readFile(
      path.join(directory, "mods", "00000", "content", "history", "sample.txt"),
      "utf8",
    ),
    "tampered",
  );
});

test("incomplete captures are retained and reported after reopening", async (t) => {
  const f = await fixture(t),
    copy = data.copyFile;
  let copied = false;
  t.mock.method(data, "copyFile", async (...args) => {
    const result = await copy(...args);
    if (!copied && args[1].includes(path.sep + "mods" + path.sep)) {
      copied = true;
      throw Error("isolated copy interruption");
    }
    return result;
  });
  await assert.rejects(
    f.service.create({ name: "Interrupted" }),
    /interruption/,
  );
  const list = await f.make().list();
  assert.equal(list.snapshots.length, 0);
  assert.equal(list.retainedDirectories.length, 1);
  assert.equal(list.notices.length, 1);
  assert.equal(
    await f.service.resolveDirectory(list.retainedDirectories[0].id),
    list.retainedDirectories[0].path,
  );
  assert.equal((await f.projects.list()).projects.length, 0);
});

test(
  "resume reuses projects after a project creation succeeds but its response is lost",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t),
      snapshot = await f.service.create({ name: "Recover projects" });
    let first = true;
    const wrapped = {
      ...f.projects,
      create: async (input) => {
        const project = await f.projects.create(input);
        if (first) {
          first = false;
          throw Error("isolated lost create response");
        }
        return project;
      },
    };
    const interrupted = f.make({ projects: wrapped }),
      before = (await f.launcher.getState()).settings.activePlaysetId;
    await assert.rejects(
      interrupted.restore(snapshot.id),
      /lost create response/,
    );
    assert.equal(
      (await f.launcher.getState()).settings.activePlaysetId,
      before,
    );
    assert.equal((await f.projects.list()).projects.length, 1);
    const result = await f.make().restore(snapshot.id);
    assert.equal((await f.projects.list()).projects.length, 3);
    assert.equal(result.state.settings.playsets.length, 2);
  },
);

test(
  "a failed final settings commit leaves the active playset unchanged and a retry reuses verified projects",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t),
      snapshot = await f.service.create({ name: "Commit recovery" }),
      before = (await f.launcher.getState()).settings;
    const wrapped = {
      ...f.launcher,
      saveSettings: async () => {
        throw Error("isolated settings commit failure");
      },
    };
    await assert.rejects(
      f.make({ launcher: wrapped }).restore(snapshot.id),
      /settings commit failure/,
    );
    assert.deepEqual((await f.launcher.getState()).settings, before);
    assert.equal((await f.projects.list()).projects.length, 3);
    const result = await f.make().restore(snapshot.id);
    assert.equal((await f.projects.list()).projects.length, 3);
    assert.equal(result.state.settings.playsets.length, 2);
  },
);

test(
  "an existing project is captured from its pinned checkpoint instead of its modified workspace",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t),
      project = await f.projects.create({
        sourcePath: f.local,
        name: "Existing fork",
        sourceModId: "local:original.mod",
        baselineKnown: false,
        upstreamRef: null,
      });
    const checkpoint = await f.projects.checkpoint(
        project.id,
        "Stable checkpoint",
      ),
      version = checkpoint.snapshots.find(
        (s) => s.name === "Stable checkpoint",
      ).id;
    await f.write(
      path.join(project.workPath, "events", "sample.txt"),
      "workspace-experiment",
    );
    await f.launcher.saveSettings({
      playsets: [
        {
          id: "default",
          name: "Pinned fork",
          modIds: [project.modId],
          modReferences: [
            {
              id: project.modId,
              name: project.name,
              source: "local",
              remoteId: null,
              version,
            },
          ],
        },
      ],
    });
    const snapshot = await f.service.create({ name: "Pinned snapshot" }),
      directory = await f.service.resolveDirectory(snapshot.id);
    assert.equal(snapshot.environment.mods[0].projectVersion, version);
    assert.equal(
      await fs.readFile(
        path.join(
          directory,
          "mods",
          "00000",
          "content",
          "events",
          "sample.txt",
        ),
        "utf8",
      ),
      "local-original",
    );
    await f.service.restore(snapshot.id);
    const created = (await f.projects.list()).projects.find(
        (p) => p.id !== project.id,
      ),
      fixed = await f.projects.resolveVersion(
        created.id,
        created.baseSnapshotId,
      );
    assert.equal(
      await fs.readFile(
        path.join(fixed.contentPath, "events", "sample.txt"),
        "utf8",
      ),
      "local-original",
    );
  },
);

test("cancelling a capture retains its incomplete directory and cannot publish a complete record", async (t) => {
  const f = await fixture(t),
    copy = data.copyFile;
  let acknowledged = false;
  t.mock.method(data, "copyFile", async (...args) => {
    const result = await copy(...args);
    if (!acknowledged && args[1].includes(path.sep + "mods" + path.sep)) {
      assert.equal(f.service.getProgress().canCancel, true);
      acknowledged = f.service.cancel();
    }
    return result;
  });
  const pending = f.service.create({ name: "Cancelled" });
  assert.equal(f.service.isBusy(), true);
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(acknowledged, true);
  assert.equal(f.service.isBusy(), false);
  const list = await f.make().list();
  assert.equal(list.snapshots.length, 0);
  assert.equal(list.retainedDirectories.length, 1);
});

test(
  "verification cancellation preserves a valid snapshot and project creation is explicitly not cancellable",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    await f.launcher.saveSettings({
      playsets: [
        { id: "default", name: "One", modIds: ["local:original.mod"] },
      ],
    });
    const snapshot = await f.service.create({ name: "Cancel phases" }),
      directory = await f.service.resolveDirectory(snapshot.id),
      filename = path.join(
        directory,
        "mods",
        "00000",
        "content",
        "events",
        "sample.txt",
      ),
      open = fs.open;
    let cancel = false;
    const mock = t.mock.method(fs, "open", async (...args) => {
      const handle = await open(...args);
      if (args[0] === filename && !cancel) cancel = f.service.cancel();
      return handle;
    });
    await assert.rejects(f.service.verify(snapshot.id), { name: "AbortError" });
    mock.mock.restore();
    assert.equal(cancel, true);
    assert.equal((await f.service.verify(snapshot.id)).valid, true);
    let service;
    service = f.make({
      projects: {
        ...f.projects,
        create: async (input) => {
          assert.equal(service.getProgress().phase, "restoring");
          assert.equal(service.getProgress().canCancel, false);
          assert.equal(service.cancel(), false);
          return f.projects.create(input);
        },
      },
    });
    await service.restore(snapshot.id);
  },
);

test("source changes during copying prevent a complete snapshot and preserve the changed original", async (t) => {
  const f = await fixture(t),
    copy = data.copyFile;
  let changed = false;
  t.mock.method(data, "copyFile", async (...args) => {
    const result = await copy(...args);
    if (!changed && args[1].includes(path.sep + "mods" + path.sep)) {
      changed = true;
      await f.write(
        path.join(f.workshop, "history", "sample.txt"),
        "source-changed",
      );
    }
    return result;
  });
  await assert.rejects(f.service.create({ name: "Changed source" }), /变化/);
  assert.equal((await f.service.list()).snapshots.length, 0);
  assert.equal(
    await fs.readFile(path.join(f.workshop, "history", "sample.txt"), "utf8"),
    "source-changed",
  );
});

test(
  "configuration changes during capture or restore reject the stale operation without replacing the active playset",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t),
      copy = data.copyFile;
    let changed = false;
    const copyMock = t.mock.method(data, "copyFile", async (...args) => {
      const result = await copy(...args);
      if (!changed && args[1].includes(path.sep + "mods" + path.sep)) {
        changed = true;
        await f.launcher.saveSettings({ launchMode: "debug" });
      }
      return result;
    });
    await assert.rejects(
      f.service.create({ name: "Stale capture" }),
      /配置.*变化/,
    );
    copyMock.mock.restore();
    assert.equal((await f.launcher.getState()).settings.launchMode, "debug");
    assert.equal((await f.service.list()).snapshots.length, 0);
    const snapshot = await f.service.create({ name: "Restore conflict" }),
      wrapped = {
        ...f.projects,
        create: async (input) => {
          const project = await f.projects.create(input);
          await f.launcher.saveSettings({ launchMode: "normal" });
          return project;
        },
      };
    await assert.rejects(
      f.make({ projects: wrapped }).restore(snapshot.id),
      /配置.*变化/,
    );
    assert.equal(
      (await f.launcher.getState()).settings.activePlaysetId,
      "default",
    );
    assert.equal((await f.launcher.getState()).settings.playsets.length, 1);
  },
);

test("game guards and instance boundaries protect snapshot changes and directory resolution", async (t) => {
  const f = await fixture(t),
    snapshot = await f.service.create({ name: "Scoped" });
  f.setRunning(true);
  await assert.rejects(f.service.create({ name: "Running" }), /退出游戏/);
  await assert.rejects(f.service.restore(snapshot.id), /退出游戏/);
  assert.equal((await f.service.verify(snapshot.id)).valid, true);
  f.setRunning(false);
  const other = await f.launcher.createGameInstance({
    name: "Other",
    gameDirectory: f.game,
  });
  await f.launcher.switchGameInstance(other.settings.activeGameInstanceId);
  assert.deepEqual((await f.service.list()).snapshots, []);
  await assert.rejects(f.service.verify(snapshot.id), /其他版本/);
  await assert.rejects(f.service.resolveDirectory(snapshot.id), /其他版本/);
});

test("hardlinks and junctions in enabled source content are rejected", async (t) => {
  const f = await fixture(t),
    source = path.join(f.workshop, "history", "sample.txt"),
    hardlink = path.join(f.root, "hardlink.txt");
  await fs.link(source, hardlink);
  await assert.rejects(
    f.service.create({ name: "Unsafe hardlink" }),
    /核验|链接/,
  );
  await fs.unlink(hardlink);
  await fs.symlink(
    f.local,
    path.join(f.workshop, "linked-local"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(
    f.service.create({ name: "Unsafe junction" }),
    /核验|链接/,
  );
  assert.equal((await f.service.list()).snapshots.length, 0);
});

test("ZIP traversal, case collisions, symlinks and CRC damage cannot become complete snapshots", async (t) => {
  const f = await fixture(t);
  await f.launcher.saveSettings({
    playsets: [{ id: "default", name: "ZIP", modIds: ["pdx:777"] }],
  });
  const linkZip = zipFixture({ "link.txt": "target" }),
    central = linkZip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  linkZip.writeUInt32LE((0xa1ff << 16) >>> 0, central + 38);
  const corrupt = zipFixture({ "file.txt": "original" }),
    localNameLength = corrupt.readUInt16LE(26);
  corrupt[30 + localNameLength] ^= 1;
  for (const bytes of [
    zipFixture({ "../outside.txt": "bad" }),
    zipFixture({ "A.txt": "one", "a.txt": "two" }),
    linkZip,
    corrupt,
  ]) {
    await f.write(f.archive, bytes);
    await assert.rejects(f.service.create({ name: "Invalid ZIP" }));
  }
  const list = await f.service.list();
  assert.equal(list.snapshots.length, 0);
  assert.equal(list.retainedDirectories.length, 4);
  await assert.rejects(fs.stat(path.join(f.root, "outside.txt")), {
    code: "ENOENT",
  });
});

test("external descriptor corruption is detected while all snapshot content files remain intact", async (t) => {
  const f = await fixture(t),
    snapshot = await f.service.create({ name: "Descriptor integrity" }),
    directory = await f.service.resolveDirectory(snapshot.id);
  await f.write(
    path.join(directory, "mods", "00000", "descriptor.mod"),
    'name="Other"\nreplace_path="wrong"\n',
  );
  await assert.rejects(f.service.verify(snapshot.id), /描述文件摘要/);
  assert.equal(
    (await f.launcher.getState()).settings.activePlaysetId,
    "default",
  );
});

test(
  "a committed restoration is idempotent and never duplicates its projects or original playsets",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t),
      snapshot = await f.service.create({ name: "Repeat" }),
      first = await f.service.restore(snapshot.id),
      second = await f.make().restore(snapshot.id);
    assert.equal(first.restoredPlaysetId, second.restoredPlaysetId);
    assert.equal(second.state.settings.playsets.length, 2);
    assert.equal((await f.projects.list()).projects.length, 3);
  },
);

test("DLC choices and effective game options restore explicitly and unavailable DLC remains visible", async (t) => {
  const f = await fixture(t);
  await f.launcher.saveSettings({
    playsets: [{ id: "default", name: "Vanilla DLC", modIds: [] }],
  });
  await f.write(
    path.join(f.game, "dlc", "one", "one.dlc"),
    'name="One"\npath="dlc/one"\n',
  );
  await f.write(
    path.join(f.user, "pdx_settings.txt"),
    'language="l_english"\ngraphics={fullScreen=yes borderless=no vsync=yes}\n',
  );
  const snapshot = await f.service.create({ name: "DLC baseline" });
  await fs.unlink(path.join(f.game, "dlc", "one", "one.dlc"));
  await f.launcher.saveSettings({
    launchMode: "debug",
    gameOptions: { language: "l_french" },
  });
  const result = await f.service.restore(snapshot.id),
    playset = result.state.settings.playsets.find(
      (p) => p.id === result.restoredPlaysetId,
    );
  assert.ok(playset.unmappedDlcIds.includes("dlc/one/one.dlc"));
  assert.equal(result.state.settings.gameOptions.language, "l_english");
  assert.equal(result.state.settings.launchMode, "normal");
});

test("an unreadable record and capture header are retained explicitly as unknown metadata", async (t) => {
  const f = await fixture(t),
    snapshot = await f.service.create({ name: "Unknown retained" }),
    directory = await f.service.resolveDirectory(snapshot.id);
  await f.write(path.join(directory, "snapshot.json"), "broken record");
  await f.write(path.join(directory, "capture.json"), "broken header");
  const list = await f.make().list();
  assert.equal(list.snapshots.length, 0);
  assert.equal(list.retainedDirectories[0].status, "unknown");
  assert.match(list.notices[0], /所属版本未知/);
  assert.equal(await f.make().resolveDirectory(snapshot.id), directory);
  assert.equal(
    await fs.readFile(path.join(directory, "snapshot.json"), "utf8"),
    "broken record",
  );
});

test("ZIP copy cancellation stops on its first chunk and leaves only an incomplete capture", async (t) => {
  const f = await fixture(t);
  await f.launcher.saveSettings({
    playsets: [{ id: "default", name: "Large ZIP", modIds: ["pdx:777"] }],
  });
  await f.write(
    f.archive,
    zipFixture({ "data.bin": Buffer.alloc(3 * 1024 ** 2, 71) }),
  );
  const open = fs.open;
  let acknowledged = false,
    readBytes = 0;
  t.mock.method(fs, "open", async (...args) => {
    const handle = await open(...args);
    if (args[0] === f.archive && f.service.getProgress().phase === "copying") {
      const read = handle.read.bind(handle);
      handle.read = async (...readArgs) => {
        const result = await read(...readArgs);
        readBytes += result.bytesRead;
        if (result.bytesRead && !acknowledged)
          acknowledged = f.service.cancel();
        return result;
      };
    }
    return handle;
  });
  await assert.rejects(f.service.create({ name: "Chunk cancel" }), {
    name: "AbortError",
  });
  assert.equal(acknowledged, true);
  assert.ok(readBytes > 0 && readBytes < 3 * 1024 ** 2);
  const list = await f.service.list();
  assert.equal(list.snapshots.length, 0);
  assert.equal(list.retainedDirectories.length, 1);
});

test(
  "a project journal write failure after creation is recovered without duplicating that project",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    await f.launcher.saveSettings({
      playsets: [
        { id: "default", name: "One project", modIds: ["local:original.mod"] },
      ],
    });
    const snapshot = await f.service.create({ name: "Journal recovery" }),
      atomic = data.atomic;
    let writes = 0;
    const mock = t.mock.method(data, "atomic", async (...args) => {
      if (
        args[0].includes(path.sep + "restore" + path.sep) &&
        args[0].endsWith("00000.json") &&
        ++writes === 2
      )
        throw Error("isolated journal write failure");
      return atomic(...args);
    });
    await assert.rejects(
      f.service.restore(snapshot.id),
      /journal write failure/,
    );
    assert.equal((await f.projects.list()).projects.length, 1);
    assert.equal(
      (await f.launcher.getState()).settings.activePlaysetId,
      "default",
    );
    mock.mock.restore();
    const result = await f.make().restore(snapshot.id);
    assert.equal((await f.projects.list()).projects.length, 1);
    assert.equal(result.state.settings.playsets.length, 2);
  },
);

test("an externally created complete-record target cannot be overwritten at capture commit", async (t) => {
  const f = await fixture(t),
    atomic = data.atomic;
  let filename;
  t.mock.method(data, "atomic", async (...args) => {
    if (args[0].endsWith(path.sep + "snapshot.json")) {
      filename = args[0];
      await f.write(filename, "external target bytes");
    }
    return atomic(...args);
  });
  await assert.rejects(
    f.service.create({ name: "Commit conflict" }),
    /外部修改/,
  );
  assert.equal(await fs.readFile(filename, "utf8"), "external target bytes");
  assert.equal((await f.service.list()).snapshots.length, 0);
});

test("directory files larger than the project restore limit fail before reading their content", async (t) => {
  const f = await fixture(t),
    filename = path.join(f.workshop, "history", "sample.txt"),
    lstat = fs.lstat,
    open = fs.open;
  t.mock.method(fs, "lstat", async (...args) => {
    const stat = await lstat(...args);
    if (args[0] === filename && typeof stat.size === "bigint")
      stat.size = BigInt(4 * 1024 ** 3 + 1);
    return stat;
  });
  t.mock.method(fs, "open", async (...args) => {
    assert.notEqual(
      args[0],
      filename,
      "oversize source content must not be opened",
    );
    return open(...args);
  });
  await assert.rejects(
    f.service.create({ name: "Oversize single file" }),
    /4 GiB/,
  );
  assert.equal((await f.service.list()).snapshots.length, 0);
  assert.equal((await f.projects.list()).projects.length, 0);
});
