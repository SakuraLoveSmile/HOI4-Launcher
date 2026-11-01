"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { EventEmitter } = require("node:events");
const { createHash } = require("node:crypto");
const { createLauncherService } = require("../electron/launcher-service.cjs");
const { createModProjectService } = require("../electron/mod-projects.cjs");
const {
  createModProjectController,
} = require("../electron/mod-project-controller.cjs");
const {
  createModProjectUpstream,
  verifyManagedProjectSource,
} = require("../electron/mod-project-upstream.cjs");
const { createPdxInstallService } = require("../electron/pdx-install.cjs");
const { zipFixture } = require("../scripts/pdx-fixture.cjs");

async function fixture(t) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "ironclad-project-integration-"),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const game = path.join(root, "game"),
    userData = path.join(root, "Paradox Interactive", "Hearts of Iron IV");
  const source = path.join(userData, "mod", "original");
  const steamRoot = path.join(root, "steam");
  const workshop = path.join(
    steamRoot,
    "steamapps",
    "workshop",
    "content",
    "394360",
    "123",
  );
  const write = async (file, value) => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, value);
  };
  await write(path.join(game, "hoi4.exe"), "not executable");
  await write(
    path.join(game, "launcher-settings.json"),
    '{"rawVersion":"1.19.4.0"}',
  );
  const descriptor =
    'name="Original"\nversion="1"\nremote_file_id="123"\npops_id="456"\nreplace_path="common/ideas"\nsupported_version="1.19.*"\n';
  await write(path.join(source, "descriptor.mod"), descriptor);
  await write(
    path.join(userData, "mod", "original.mod"),
    descriptor + `path="${source.replaceAll("\\", "/")}"\n`,
  );
  await write(
    path.join(source, "events", "sample.txt"),
    "alpha = 1\nbeta = 2\n",
  );
  await write(path.join(workshop, "descriptor.mod"), descriptor);
  await write(
    path.join(workshop, "events", "sample.txt"),
    "alpha = 1\nbeta = 2\n",
  );
  let projects, launcher;
  const launches = [];
  const options = {
    settingsPath: path.join(root, "settings.json"),
    documentsPath: root,
    steamRoots: [steamRoot],
    processProbe: async () => null,
    getModProjects: async () =>
      projects ? (await projects.list()).projects : [],
    resolveProjectVersion: (id, version) =>
      projects.resolveVersion(id, version),
    spawnProcess: (exe, args) => {
      launches.push({ exe, args });
      const child = new EventEmitter();
      child.pid = 54321;
      child.unref = () => {};
      process.nextTick(() => child.emit("spawn"));
      return child;
    },
  };
  launcher = createLauncherService(options);
  await launcher.saveSettings({ gameDirectory: game });
  projects = createModProjectService({
    storageDirectory: path.join(root, "projects"),
    getUserDataPath: async () =>
      (await launcher.getSourceState()).paths.userData,
    isGameRunning: async () => false,
  });
  let steamItem = {
    id: "123",
    installed: true,
    needsUpdate: false,
    downloading: false,
    pending: false,
    updatedAt: 1,
    account: { steamId: "account-one" },
    installation: { folder: workshop, timestamp: 1 },
  };
  const calls = [];
  const steam = {
    call: async (method, id) => {
      calls.push([method, id]);
      return structuredClone(steamItem);
    },
  };
  const upstream = createModProjectUpstream({
    projects,
    steam,
    getLauncherState: () => launcher.getSourceState(),
    storageDirectory: path.join(root, "downloads"),
    pollMs: 1,
    maxSteamWaitMs: 50,
  });
  const controller = createModProjectController({
    projects,
    upstream,
    launcher,
    chooseOpen: async () => null,
    chooseSave: async () => null,
    openPath: async () => "",
  });
  return {
    root,
    game,
    source,
    workshop,
    userData,
    write,
    projects,
    launcher,
    options,
    upstream,
    controller,
    calls,
    launches,
    setSteam: (patch) => {
      steamItem = { ...steamItem, ...patch };
    },
  };
}

test(
  "fork identity, original protection, duplicate load guard and fixed playset version integrate",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    const original = await fs.readFile(path.join(f.source, "descriptor.mod"));
    const project = await f.controller.createModProject({
      modId: "workshop:123",
      name: "My fork",
      baselineKnown: true,
    });
    assert.equal(project.upstreamRef.remoteId, "123");
    let state = await f.launcher.getState();
    const fork = state.mods.find((mod) => mod.id === project.modId);
    assert.equal(fork.projectId, project.id);
    assert.equal(fork.source, "local");
    assert.equal(
      state.mods.filter((mod) => mod.id === "workshop:123").length,
      1,
    );
    await f.launcher.saveSettings({
      playsets: [
        {
          id: "default",
          name: "Campaign",
          modIds: ["workshop:123", project.modId],
        },
      ],
    });
    assert.match(
      (await f.launcher.getState()).launchBlockedReason,
      /原版不能同时启用/,
    );
    await assert.rejects(f.launcher.launchGame(), /原版不能同时启用/);
    assert.equal(f.launches.length, 0);
    await f.projects.checkpoint(project.id, "Stable one");
    const version = (await f.projects.get(project.id)).snapshots.find(
      (snapshot) => snapshot.name === "Stable one",
    );
    assert.ok(version);
    await f.write(
      path.join(project.workPath, "events", "sample.txt"),
      "experimental = 9\n",
    );
    state = await f.controller.pinModProject(project.id, version.id);
    const playset = state.settings.playsets[0];
    assert.deepEqual(playset.modIds, [project.modId]);
    assert.ok(
      playset.modOrder.includes("workshop:123"),
      "original remains as disabled member",
    );
    assert.equal(
      state.mods.find((mod) => mod.id === project.modId).projectVersion,
      version.id,
    );
    assert.equal(
      state.mods.find((mod) => mod.id === project.modId).canEdit,
      false,
    );
    await f.launcher.launchGame();
    const load = JSON.parse(
      await fs.readFile(path.join(f.userData, "dlc_load.json"), "utf8"),
    );
    assert.equal(load.enabled_mods.length, 1);
    const registered = await fs.readFile(
      path.join(f.userData, load.enabled_mods[0]),
      "utf8",
    );
    assert.match(registered, /Managed by IRONCLAD project version/);
    assert.match(registered, /replace_path="common\/ideas"/);
    assert.doesNotMatch(registered, /remote_file_id|pops_id/);
    assert.deepEqual(
      await fs.readFile(path.join(f.source, "descriptor.mod")),
      original,
    );
    const reopened = createLauncherService(f.options);
    assert.equal(
      (await reopened.getState()).mods.filter(
        (mod) => mod.projectId === project.id,
      ).length,
      1,
    );
  },
);

test("Steam candidate uses the SDK installation when a local author directory shadows the same workshop ID", async (t) => {
  const f = await fixture(t);
  f.setSteam({ downloading: true });
  await assert.rejects(
    f.controller.createModProject({
      modId: "workshop:123",
      name: "Blocked",
      baselineKnown: true,
    }),
    /尚未完成更新/,
  );
  assert.equal((await f.projects.list()).projects.length, 0);
  f.setSteam({ downloading: false });
  const project = await f.controller.createModProject({
    modId: "workshop:123",
    name: "Fork",
    baselineKnown: true,
  });
  await f.write(
    path.join(project.workPath, "events", "sample.txt"),
    "alpha = 7\nbeta = 2\n",
  );
  await f.write(
    path.join(f.source, "events", "sample.txt"),
    "author_only = 99\n",
  );
  await f.write(
    path.join(f.workshop, "events", "sample.txt"),
    "alpha = 1\nbeta = 8\n",
  );
  assert.equal(
    (await f.launcher.getSourceState()).mods.find(
      (mod) => mod.id === "workshop:123",
    ).contentPath,
    f.source,
  );
  f.setSteam({
    updatedAt: 2,
    installation: { folder: f.workshop, timestamp: 2 },
  });
  await f.upstream.start(project.id);
  const result = await f.upstream.settled();
  assert.equal(result.job.status, "succeeded", result.job.error);
  assert.ok((await f.projects.get(project.id)).candidateSnapshotId);
  assert.equal(
    await fs.readFile(
      path.join(project.workPath, "events", "sample.txt"),
      "utf8",
    ),
    "alpha = 7\nbeta = 2\n",
  );
  const plan = await f.controller.prepareModProjectMerge(project.id);
  const decisions = plan.entries
    .filter((entry) => entry.upstreamChanged)
    .map((entry) => ({ path: entry.path, choice: "auto" }));
  await f.controller.applyModProjectMerge(project.id, plan.id, decisions);
  assert.equal(
    await fs.readFile(
      path.join(project.workPath, "events", "sample.txt"),
      "utf8",
    ),
    "alpha = 7\nbeta = 8\n",
  );
  assert.equal(
    await fs.readFile(path.join(f.source, "events", "sample.txt"), "utf8"),
    "author_only = 99\n",
  );
  assert.equal(
    f.calls.some(([method]) => method === "download"),
    false,
  );
});

test("Steam candidates reject missing or mismatched SDK installation paths and changed installations", async (t) => {
  const f = await fixture(t);
  const project = await f.controller.createModProject({
    modId: "workshop:123",
    name: "Fork",
    baselineKnown: true,
  });
  for (const installation of [
    null,
    { folder: f.source, timestamp: 1 },
    { folder: path.dirname(f.workshop), timestamp: 1 },
  ]) {
    f.setSteam({ installation });
    await f.upstream.start(project.id);
    assert.equal((await f.upstream.settled()).job.status, "failed");
    assert.equal((await f.projects.get(project.id)).candidateSnapshotId, null);
  }
  f.setSteam({ installation: { folder: f.workshop, timestamp: 1 } });
  const source = await f.upstream.sourceForMod("workshop:123", {
    requireStable: true,
    workshopInstall: true,
  });
  f.setSteam({ installation: { folder: f.workshop, timestamp: 2 } });
  await assert.rejects(source.checkSource(), /Steam 来源或账号发生变化/);
});

test(
  "verified PDX projects validate the actual managed installation and reject mismatched or modified sources",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const installer = createPdxInstallService({
      storageDirectory: path.join(f.root, "pdx-installer"),
      validateUserDataPath: async (target) =>
        assert.equal(
          target,
          (await f.launcher.getSourceState()).paths.userData,
        ),
    });
    const bytes = zipFixture({
      "descriptor.mod": 'name="PDX original"\nversion="3"\n',
      "events/test.txt": "verified = 1\n",
    });
    const archivePath = path.join(f.root, "pdx-original.zip");
    await fs.writeFile(archivePath, bytes);
    const installed = await installer.install({
      archivePath,
      userDataPath: f.userData,
      plan: {
        modId: "123",
        name: "publication-id",
        title: "PDX original",
        revision: "3",
        platform: "Any__Any",
        archiveUrl:
          "https://modscontent.paradox-interactive.com/hoi4/id/repo/Any__Any/3/complete/mod.zip",
        filename: "mod.zip",
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    });
    assert.ok(installed.installationId);
    const verifyOriginal = (id, source) =>
      verifyManagedProjectSource(
        { installer, getLauncherState: () => f.launcher.getSourceState() },
        id,
        source,
      );
    const controller = createModProjectController({
      projects: f.projects,
      upstream: f.upstream,
      launcher: f.launcher,
      verifyOriginal,
    });
    const project = await controller.createModProject({
      modId: "pdx:123",
      name: "Verified fork",
      baselineKnown: true,
    });
    assert.equal(project.baselineKnown, true);
    assert.equal(
      await fs.readFile(
        path.join(project.workPath, "events", "test.txt"),
        "utf8",
      ),
      "verified = 1\n",
    );
    const source = await f.upstream.sourceForMod("pdx:123");
    await assert.rejects(
      verifyOriginal("pdx:123", { ...source, sourcePath: f.source }),
      /尚未通过原版验证/,
    );
    await assert.rejects(
      verifyOriginal("pdx:123", {
        ...source,
        upstreamRef: { ...source.upstreamRef, revision: "2" },
      }),
      /尚未通过原版验证/,
    );
    await f.write(
      path.join(installed.contentPath, "events", "test.txt"),
      "personal = 2\n",
    );
    await assert.rejects(
      controller.createModProject({
        modId: "pdx:123",
        name: "Modified fork",
        baselineKnown: true,
      }),
      /尚未通过原版验证/,
    );
    assert.equal((await f.projects.list()).projects.length, 1);
  },
);

test("desktop project boundary rejects renderer paths and cancelled native imports leave no project", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.controller.createModProject({
      modId: "workshop:123",
      name: "Bad",
      sourcePath: f.source,
      baselineKnown: true,
    }),
    /参数无效/,
  );
  await assert.rejects(
    f.controller.importModProject({
      kind: "folder",
      name: "Bad",
      path: f.source,
    }),
    /参数无效/,
  );
  assert.equal(
    await f.controller.importModProject({
      kind: "folder",
      name: "Cancelled",
      baselineKnown: false,
    }),
    null,
  );
  assert.equal((await f.projects.list()).projects.length, 0);
});

test("missing or tampered fixed snapshot blocks launch without changing the previous loadout", async (t) => {
  const f = await fixture(t);
  const project = await f.controller.createModProject({
    modId: "workshop:123",
    name: "Fork",
    baselineKnown: true,
  });
  await f.projects.checkpoint(project.id, "Pinned");
  const version = (await f.projects.get(project.id)).snapshots.find(
    (s) => s.name === "Pinned",
  );
  await f.controller.pinModProject(project.id, version.id);
  const resolved = await f.projects.resolveVersion(project.id, version.id);
  await f.write(
    path.join(resolved.contentPath, "events", "sample.txt"),
    "tampered",
  );
  await f.write(
    path.join(f.userData, "dlc_load.json"),
    '{"enabled_mods":[],"keep":"old"}',
  );
  const before = await fs.readFile(path.join(f.userData, "dlc_load.json"));
  assert.equal(
    (await f.launcher.getState()).mods.find((mod) => mod.id === project.modId)
      .available,
    false,
  );
  await assert.rejects(f.launcher.launchGame(), /已移动或未安装/);
  assert.deepEqual(
    await fs.readFile(path.join(f.userData, "dlc_load.json")),
    before,
  );
});

test(
  "concurrent launcher refresh cannot deadlock source validation inside a project capture",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    const project = await f.controller.createModProject({
      modId: "workshop:123",
      name: "Fork",
      baselineKnown: true,
    });
    let entered, release;
    const checkpoint = new Promise((resolve) => {
      entered = resolve;
    });
    const continueCapture = new Promise((resolve) => {
      release = resolve;
    });
    const capture = f.projects.captureCandidate(project.id, {
      sourcePath: f.source,
      upstreamRef: project.upstreamRef,
      checkSource: async () => {
        entered();
        await continueCapture;
        await f.launcher.getSourceState();
      },
    });
    await checkpoint;
    const refreshing = f.launcher.getState();
    release();
    await Promise.all([capture, refreshing]);
    assert.ok((await f.projects.get(project.id)).candidateSnapshotId);
  },
);

test("working descriptor changes apply at launch while the managed registration stays owned by the project", async (t) => {
  const f = await fixture(t);
  const project = await f.controller.createModProject({
    modId: "workshop:123",
    name: "Fork",
    baselineKnown: true,
  });
  const registration = await fs.readFile(project.descriptorPath);
  await fs.appendFile(
    path.join(project.workPath, "descriptor.mod"),
    '\nreplace_path="events"\ndependencies={"Needed mod"}\n',
  );
  const state = await f.controller.pinModProject(project.id, null);
  const mod = state.mods.find((item) => item.id === project.modId);
  assert.equal(mod.canEdit, false);
  assert.ok(mod.dependencies.includes("Needed mod"));
  await assert.rejects(
    f.launcher.updateLocalModMetadata(project.modId, { name: "Wrong editor" }),
    /项目管理/,
  );
  await f.launcher.launchGame();
  const load = JSON.parse(
    await fs.readFile(path.join(f.userData, "dlc_load.json"), "utf8"),
  );
  const generated = await fs.readFile(
    path.join(f.userData, load.enabled_mods[0]),
    "utf8",
  );
  assert.match(generated, /replace_path="events"/);
  assert.deepEqual(await fs.readFile(project.descriptorPath), registration);
});

test("outer-only local mods retain original identity for duplicate prevention after fork", async (t) => {
  const f = await fixture(t);
  await fs.unlink(path.join(f.source, "descriptor.mod"));
  await f.write(
    path.join(f.userData, "mod", "original.mod"),
    `name="Local original"\npath="${f.source.replaceAll("\\", "/")}"\nreplace_path="events"\n`,
  );
  const project = await f.controller.createModProject({
    modId: "local:original.mod",
    name: "Local fork",
    baselineKnown: false,
  });
  assert.equal(project.originModId, "local:original.mod");
  assert.equal(project.upstreamRef, null);
  assert.match(
    await fs.readFile(path.join(project.workPath, "descriptor.mod"), "utf8"),
    /replace_path="events"/,
  );
  await f.launcher.saveSettings({
    playsets: [
      {
        id: "default",
        name: "Both",
        modIds: ["local:original.mod", project.modId],
      },
    ],
  });
  await assert.rejects(f.launcher.launchGame(), /原版不能同时启用/);
  const state = await f.controller.pinModProject(project.id, null);
  assert.deepEqual(state.settings.playsets[0].modIds, [project.modId]);
  await assert.rejects(fs.stat(path.join(f.source, "descriptor.mod")), {
    code: "ENOENT",
  });
});
