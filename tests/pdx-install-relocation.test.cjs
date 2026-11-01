"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createHash, randomBytes } = require("node:crypto");
const { ZipFile } = require("yazl");
const { createPdxInstallService } = require("../electron/pdx-install.cjs");

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ironclad-relocation-"));
  t.after(() =>
    fs.rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    }),
  );
  const storage = path.join(root, "control"),
    userDataPath = path.join(root, "user"),
    targetParent = path.join(root, "custom");
  await fs.mkdir(userDataPath);
  await fs.mkdir(targetParent);
  const flags = { running: false, valid: true };
  const options = {
    storageDirectory: storage,
    isGameRunning: async () => flags.running,
    validateUserDataPath: async () => {
      if (!flags.valid) throw new Error("用户目录已变化");
    },
  };
  const service = createPdxInstallService(options);
  async function install(
    revision = "1",
    modId = "123",
    userdir = userDataPath,
    content = "payload",
  ) {
    const zip = new ZipFile(),
      chunks = [];
    zip.outputStream.on("data", (chunk) => chunks.push(chunk));
    const done = new Promise((resolve, reject) => {
      zip.outputStream.once("end", resolve);
      zip.outputStream.once("error", reject);
    });
    zip.addBuffer(
      Buffer.from('name="Fixture mod"\nsupported_version="1.19.*"\n'),
      "descriptor.mod",
    );
    zip.addBuffer(Buffer.from(content), "events/fixture.txt");
    zip.addEmptyDirectory("empty");
    zip.end();
    await done;
    const bytes = Buffer.concat(chunks),
      archivePath = path.join(root, `${modId}-${revision}.zip`);
    await fs.writeFile(archivePath, bytes);
    return service.install({
      archivePath,
      userDataPath: userdir,
      plan: {
        modId,
        revision,
        title: "Fixture mod",
        platform: "Any__Any",
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    });
  }
  const plan = (parent = targetParent, using = service) =>
    using.planRelocation({ userDataPath, targetParent: parent });
  const database = () =>
    fs
      .readFile(path.join(storage, "installations.json"), "utf8")
      .then(JSON.parse);
  return {
    root,
    storage,
    userDataPath,
    targetParent,
    flags,
    service,
    install,
    plan,
    database,
    restart: () => createPdxInstallService(options),
  };
}
const missing = (file) => assert.rejects(fs.stat(file), { code: "ENOENT" });

test("default to custom to custom to default migrates current and retained revisions and releases sources", async (t) => {
  const f = await fixture(t),
    old = await f.install(),
    active = await f.install("2");
  const originalRegistration = active.descriptorPath,
    phases = [];
  const first = await f.plan();
  assert.equal(first.installations.length, 2);
  assert.equal(first.files, 4);
  assert.equal(first.conflicts.length, 0);
  const result = await f.service.relocate({
    planId: first.planId,
    onProgress: (p) => phases.push(p),
  });
  assert.equal(result.moved, 2);
  assert.deepEqual(result.retainedPaths, []);
  await missing(old.contentPath);
  await missing(active.contentPath);
  assert.equal(
    (await f.service.list())[0].descriptorPath,
    originalRegistration,
  );
  let db = await f.database();
  assert.equal(db.retainedVersions.length, 1);
  assert.match(
    await fs.readFile(db.retainedVersions[0].backupPath, "utf8"),
    /custom\/hoi4\/ironclad/,
  );
  assert.ok(
    phases.some((p) => p.stage === "committing" && p.cancellable === false),
  );
  assert.equal(phases.at(-1).processedBytes, first.bytes);
  const nextParent = path.join(f.root, "custom-two");
  await fs.mkdir(nextParent);
  const second = await f.plan(nextParent);
  await f.service.relocate({ planId: second.planId });
  await missing(db.records[0].contentPath);
  const third = await f.plan(null);
  await f.service.relocate({ planId: third.planId });
  const state = await f
    .restart()
    .getStorageState({ userDataPath: f.userDataPath });
  assert.equal(state.isDefault, true);
  assert.equal(state.location, f.storage);
  assert.deepEqual(state.retainedLegacyPaths, []);
  db = await f.database();
  assert.equal(db.records[0].revision, "2");
  assert.equal(db.retainedVersions[0].revision, "1");
});

test("empty-library location changes direct future installs, updates and uninstall history to the new root", async (t) => {
  const f = await fixture(t),
    plan = await f.plan();
  assert.equal(plan.bytes, 0);
  assert.equal(plan.files, 0);
  await f.service.relocate({ planId: plan.planId });
  const one = await f.install(),
    two = await f.install("2");
  assert.ok(one.contentPath.startsWith(plan.to));
  assert.ok(two.contentPath.startsWith(plan.to));
  await f.service.uninstall("123", { userDataPath: f.userDataPath });
  assert.deepEqual(await f.service.list(), []);
  assert.equal((await f.database()).retainedVersions.length, 2);
  const restore = await f.plan(null);
  assert.equal(restore.installations.length, 2);
  assert.equal((await f.service.relocate({ planId: restore.planId })).moved, 2);
  await missing(one.contentPath);
  await missing(two.contentPath);
});

test("v1 active records upgrade while unindexed old versions and official files remain untouched", async (t) => {
  const f = await fixture(t),
    old = await f.install(),
    db = await f.database();
  delete db.records[0].contentRootId;
  await fs.writeFile(
    path.join(f.storage, "installations.json"),
    JSON.stringify({ version: 1, records: db.records }),
  );
  const legacy = path.join(f.storage, "versions", "123", "unindexed-old"),
    official = path.join(f.userDataPath, "mod", "pdx_123.mod");
  await fs.mkdir(legacy);
  await fs.writeFile(path.join(legacy, "keep.txt"), "legacy payload");
  await fs.writeFile(official, 'name="Official"\npath="mod/pdx_123"\n');
  const service = f.restart(),
    plan = await f.plan(f.targetParent, service);
  assert.ok(plan.retainedLegacyPaths.includes(legacy));
  await service.relocate({ planId: plan.planId });
  await missing(old.contentPath);
  assert.equal(
    await fs.readFile(path.join(legacy, "keep.txt"), "utf8"),
    "legacy payload",
  );
  assert.match(await fs.readFile(official, "utf8"), /Official/);
  assert.equal((await f.database()).version, 2);
});

test("separate user directories with the same remote ID retain independent locations and registrations", async (t) => {
  const f = await fixture(t),
    other = path.join(f.root, "other-user");
  await fs.mkdir(other);
  const a = await f.install(),
    b = await f.install("1", "123", other);
  const plan = await f.plan();
  assert.equal(plan.installations.length, 1);
  await f.service.relocate({ planId: plan.planId });
  await missing(a.contentPath);
  assert.ok(await fs.stat(b.contentPath));
  assert.equal(
    (await f.service.getStorageState({ userDataPath: other })).location,
    f.storage,
  );
  assert.equal((await f.service.list()).length, 2);
  await f.service.uninstall("123", { userDataPath: other });
  assert.equal((await f.service.list())[0].descriptorPath, a.descriptorPath);
});

test("previews are read only and reject occupied targets, nested roots and changed descriptors", async (t) => {
  const f = await fixture(t),
    installed = await f.install();
  const first = await f.plan();
  await missing(first.to);
  await fs.mkdir(first.to, { recursive: true });
  await fs.writeFile(path.join(first.to, "foreign"), "keep");
  const occupied = await f.plan();
  assert.ok(occupied.conflicts.length);
  await assert.rejects(f.service.relocate({ planId: occupied.planId }), /冲突/);
  await assert.rejects(f.plan(f.storage), /重叠|嵌套/);
  await fs.appendFile(installed.descriptorPath, "# user edited\n");
  const changed = await f.plan(null);
  assert.ok(changed.conflicts.some((s) => /注册/.test(s)));
  assert.equal(
    await fs.readFile(path.join(first.to, "foreign"), "utf8"),
    "keep",
  );
});

test("content changes after preview require a new preview without altering the installation", async (t) => {
  const f = await fixture(t),
    installed = await f.install(),
    plan = await f.plan();
  await fs.appendFile(
    path.join(installed.contentPath, "events", "fixture.txt"),
    "user edit",
  );
  await assert.rejects(f.service.relocate({ planId: plan.planId }), /变化/);
  assert.deepEqual(await f.service.list(), [installed]);
});

test("target replacement after preview is rejected, including a different ordinary directory", async (t) => {
  const f = await fixture(t);
  await f.install();
  const plan = await f.plan();
  await fs.rename(f.targetParent, f.targetParent + "-original");
  await fs.mkdir(f.targetParent);
  await assert.rejects(f.service.relocate({ planId: plan.planId }), /变化/);
  assert.equal(
    (await f.service.getStorageState({ userDataPath: f.userDataPath }))
      .isDefault,
    true,
  );
});

test("game launch, user-directory change and cancellation before commit preserve original registration", async (t) => {
  const f = await fixture(t),
    installed = await f.install();
  let p = await f.plan();
  f.flags.running = true;
  await assert.rejects(f.service.relocate({ planId: p.planId }), /退出游戏/);
  f.flags.running = false;
  p = await f.plan();
  f.flags.valid = false;
  await assert.rejects(f.service.relocate({ planId: p.planId }), /用户目录/);
  f.flags.valid = true;
  p = await f.plan();
  const controller = new AbortController();
  await assert.rejects(
    f.service.relocate({
      planId: p.planId,
      signal: controller.signal,
      onProgress: (progress) => {
        if (progress.stage === "committing") controller.abort();
      },
    }),
    { name: "AbortError" },
  );
  assert.deepEqual(await f.service.list(), [installed]);
  assert.ok(await fs.stat(installed.contentPath));
});

test("new files and user edits during committed cleanup are retained and reported", async (t) => {
  const f = await fixture(t),
    installed = await f.install(),
    plan = await f.plan();
  const result = await f.service.relocate({
    planId: plan.planId,
    onProgress: async (p) => {
      if (p.stage === "cleaning") {
        await fs.appendFile(
          path.join(installed.contentPath, "events", "fixture.txt"),
          "user changed",
        );
        await fs.writeFile(
          path.join(installed.contentPath, "new.txt"),
          "user file",
        );
      }
    },
  });
  assert.ok(result.retainedPaths.includes(installed.contentPath));
  assert.ok(result.warnings.length);
  assert.match(
    await fs.readFile(
      path.join(installed.contentPath, "events", "fixture.txt"),
      "utf8",
    ),
    /user changed/,
  );
  assert.equal(
    await fs.readFile(path.join(installed.contentPath, "new.txt"), "utf8"),
    "user file",
  );
  assert.ok((await f.service.list())[0].contentPath.startsWith(plan.to));
});

for (const boundary of [
  "rename-target",
  "backup-registration",
  "remove-registration",
  "activate-registration",
  "database-commit",
]) {
  test(`failure at ${boundary} rolls back registration and location`, async (t) => {
    const f = await fixture(t),
      installed = await f.install(),
      plan = await f.plan();
    const method =
      boundary === "rename-target" || boundary === "database-commit"
        ? "rename"
        : boundary === "remove-registration"
          ? "unlink"
          : "link";
    const original = fs[method];
    let failed = false;
    const hook = t.mock.method(fs, method, async (...args) => {
      const [source, target] = args;
      const matches =
        boundary === "rename-target"
          ? String(source).includes("relocation-") &&
            String(target).includes(`${path.sep}versions${path.sep}`)
          : boundary === "database-commit"
            ? target === path.join(f.storage, "installations.json") &&
              (await fs.readFile(source, "utf8")).includes('"lastRelocationId"')
            : boundary === "backup-registration"
              ? String(target).includes(".ironclad-relocation-backup-")
              : boundary === "remove-registration"
                ? source === installed.descriptorPath
                : target === installed.descriptorPath &&
                  String(source).includes(".ironclad-relocation-tmp-");
      if (!failed && matches) {
        failed = true;
        throw new Error("fixture boundary failure");
      }
      return original(...args);
    });
    try {
      await assert.rejects(
        f.service.relocate({ planId: plan.planId }),
        /boundary failure/,
      );
    } finally {
      hook.mock.restore();
    }
    assert.equal(failed, true);
    assert.deepEqual(await f.restart().list(), [installed]);
    assert.equal(
      (await f.restart().getStorageState({ userDataPath: f.userDataPath }))
        .isDefault,
      true,
    );
    assert.ok(await fs.stat(installed.contentPath));
  });
}

test("an interrupted rollback blocks state until restart recovery restores original registration", async (t) => {
  const f = await fixture(t),
    installed = await f.install(),
    plan = await f.plan();
  const rename = fs.rename,
    unlink = fs.unlink;
  const a = t.mock.method(fs, "rename", async (source, target) => {
    if (
      target === path.join(f.storage, "installations.json") &&
      (await fs.readFile(source, "utf8")).includes('"lastRelocationId"')
    )
      throw new Error("commit failure");
    return rename(source, target);
  });
  const b = t.mock.method(fs, "unlink", async (file) => {
    if (
      file === installed.descriptorPath &&
      (await fs.readFile(file, "utf8")).includes("/custom/")
    )
      throw new Error("locked registration");
    return unlink(file);
  });
  try {
    const { original } = require("../electron/diagnostic-message.cjs");
    const { formatDiagnostic } = await import("../src/i18n-core.mjs");
    await assert.rejects(
      f.service.relocate({ planId: plan.planId }),
      (error) => {
        assert.equal(error.code, "RECOVERY_REQUIRED");
        assert.equal(original(error.diagnostic), error.message);
        const rendered = formatDiagnostic(
          "en",
          error.diagnostic,
          error.message,
        );
        assert.match(rendered, /commit failure/);
        assert.match(rendered, /locked registration/);
        assert.match(rendered, /The move recovery record has been kept/);
        assert.doesNotMatch(rendered, /[\u3400-\u9fff]/);
        return true;
      },
    );
    await assert.rejects(
      f.restart().getStorageState({ userDataPath: f.userDataPath }),
      { code: "RECOVERY_REQUIRED" },
    );
  } finally {
    a.mock.restore();
    b.mock.restore();
  }
  assert.equal((await f.restart().recover()).action, "rolled-back");
  assert.deepEqual(await f.restart().list(), [installed]);
});

test("restart recognizes a committed migration and finishes cleanup idempotently", async (t) => {
  const f = await fixture(t),
    installed = await f.install(),
    plan = await f.plan(),
    unlink = fs.unlink;
  const hook = t.mock.method(fs, "unlink", async (file) => {
    if (file === path.join(f.storage, "transaction.json"))
      throw new Error("journal locked");
    return unlink(file);
  });
  try {
    await assert.rejects(f.service.relocate({ planId: plan.planId }), {
      code: "RECOVERY_REQUIRED",
    });
  } finally {
    hook.mock.restore();
  }
  assert.equal((await f.restart().recover()).action, "completed");
  await missing(installed.contentPath);
  assert.equal(
    (await f.restart().getStorageState({ userDataPath: f.userDataPath }))
      .location,
    plan.to,
  );
  assert.deepEqual(await f.restart().recover(), {
    recovered: false,
    action: null,
  });
});

test("directory and hard links in source content block migration without touching linked data", async (t) => {
  const f = await fixture(t),
    installed = await f.install(),
    outside = path.join(f.root, "outside");
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "keep"), "foreign");
  const link = path.join(installed.contentPath, "linked");
  await fs.symlink(outside, link, "junction");
  const plan = await f.plan();
  assert.ok(plan.conflicts.some((s) => /链接|联接/.test(s)));
  await fs.unlink(link);
  await fs.link(path.join(outside, "keep"), link);
  const hard = await f.plan();
  assert.ok(hard.conflicts.some((s) => /链接/.test(s)));
  assert.equal(
    await fs.readFile(path.join(outside, "keep"), "utf8"),
    "foreign",
  );
});

test("insufficient destination space is reported in the preview", async (t) => {
  const f = await fixture(t);
  await f.install();
  const hook = t.mock.method(fs, "statfs", async () => ({
    bavail: 0n,
    bsize: 4096n,
  }));
  try {
    assert.ok((await f.plan()).conflicts.some((s) => /空间不足/.test(s)));
  } finally {
    hook.mock.restore();
  }
});

test("an aborted partial copy removes its own bytes and leaves the original complete", async (t) => {
  const f = await fixture(t),
    payload = randomBytes(1024 * 1024 + 17).toString("hex"),
    installed = await f.install("1", "123", f.userDataPath, payload);
  const plan = await f.plan(),
    controller = new AbortController();
  await assert.rejects(
    f.service.relocate({
      planId: plan.planId,
      signal: controller.signal,
      onProgress: (p) => {
        if (p.processedBytes > 1024 * 1024) controller.abort();
      },
    }),
    { name: "AbortError" },
  );
  assert.equal(
    await fs.readFile(
      path.join(installed.contentPath, "events", "fixture.txt"),
      "utf8",
    ),
    payload,
  );
  assert.deepEqual(await f.service.list(), [installed]);
  assert.deepEqual(
    (await f.service.getStorageState({ userDataPath: f.userDataPath }))
      .retainedLegacyPaths,
    [],
  );
});

for (const replacement of ["directory", "file"]) {
  test(`an identically populated replacement ${replacement} during copying is not adopted`, async (t) => {
    const f = await fixture(t),
      installed = await f.install(),
      plan = await f.plan();
    let replaced = false,
      target;
    await assert.rejects(
      f.service.relocate({
        planId: plan.planId,
        onProgress: async (p) => {
          if (replaced || p.stage !== "copying" || p.filesDone !== p.totalFiles)
            return;
          const task = (await fs.readdir(path.join(plan.to, "tasks")))[0];
          const version = (
            await fs.readdir(path.join(plan.to, "tasks", task))
          )[0];
          target = path.join(plan.to, "tasks", task, version, "content");
          if (replacement === "file")
            target = path.join(target, "events", "fixture.txt");
          await fs.rename(target, target + "-original");
          await fs.cp(target + "-original", target, { recursive: true });
          replaced = true;
        },
      }),
      /替换|变化/,
    );
    assert.equal(replaced, true);
    assert.ok(await fs.stat(target));
    assert.deepEqual(await f.service.list(), [installed]);
  });
}

test("loss of the destination before commit rolls back without waiting for that volume to return", async (t) => {
  const f = await fixture(t),
    installed = await f.install(),
    plan = await f.plan();
  await assert.rejects(
    f.service.relocate({
      planId: plan.planId,
      onProgress: async (p) => {
        if (p.stage === "committing")
          await fs.rename(plan.to, plan.to + "-disconnected");
      },
    }),
    /ENOENT|变化|目录/,
  );
  assert.deepEqual(await f.restart().list(), [installed]);
  const state = await f
    .restart()
    .getStorageState({ userDataPath: f.userDataPath });
  assert.equal(state.isDefault, true);
  assert.ok(state.retainedLegacyPaths.includes(plan.to));
});

test("unverifiable retained history is shown and kept while the active version moves", async (t) => {
  const f = await fixture(t),
    old = await f.install();
  await f.install("2");
  const db = await f.database();
  await fs.appendFile(db.retainedVersions[0].backupPath, "# edited backup\n");
  const plan = await f.plan();
  assert.equal(plan.installations.length, 1);
  assert.ok(plan.retainedLegacyPaths.includes(path.dirname(old.contentPath)));
  await f.service.relocate({ planId: plan.planId });
  assert.ok(await fs.stat(old.contentPath));
  assert.ok(
    (
      await f.service.getStorageState({ userDataPath: f.userDataPath })
    ).retainedLegacyPaths.includes(path.dirname(old.contentPath)),
  );
});

test("foreign files adjacent to a migrated content tree are preserved and reported", async (t) => {
  const f = await fixture(t),
    installed = await f.install(),
    foreign = path.join(path.dirname(installed.contentPath), "user-note.txt");
  await fs.writeFile(foreign, "user data");
  const plan = await f.plan();
  const result = await f.service.relocate({ planId: plan.planId });
  await missing(installed.contentPath);
  assert.equal(await fs.readFile(foreign, "utf8"), "user data");
  assert.ok(result.retainedPaths.includes(path.dirname(installed.contentPath)));
});

test("cancelled and stale plans cannot change a location", async (t) => {
  const f = await fixture(t);
  await f.install();
  let plan = await f.plan();
  assert.equal(f.service.cancelRelocationPlan(plan.planId), true);
  await assert.rejects(f.service.relocate({ planId: plan.planId }), /失效/);
  plan = await f.plan();
  await f.install("2");
  await assert.rejects(
    f.service.relocate({ planId: plan.planId }),
    /记录已变化/,
  );
});

test("copying across content roots never uses a cross-root rename", async (t) => {
  const f = await fixture(t),
    installed = await f.install(),
    plan = await f.plan(),
    rename = fs.rename;
  const hook = t.mock.method(fs, "rename", async (source, destination) => {
    if (
      source.startsWith(f.storage + path.sep) &&
      destination.startsWith(plan.to + path.sep)
    )
      throw Object.assign(new Error("EXDEV"), { code: "EXDEV" });
    return rename(source, destination);
  });
  try {
    assert.equal((await f.service.relocate({ planId: plan.planId })).moved, 1);
  } finally {
    hook.mock.restore();
  }
  await missing(installed.contentPath);
});

for (const boundary of [
  "rename-target",
  "backup-registration",
  "remove-registration",
  "activate-registration",
  "database-commit",
]) {
  test(`restart after a completed ${boundary} operation and interruption recovers deterministically`, async (t) => {
    const f = await fixture(t),
      installed = await f.install(),
      plan = await f.plan();
    const rename = fs.rename,
      link = fs.link,
      unlink = fs.unlink;
    let interrupted = false;
    const hooks = ["rename", "link", "unlink"].map((method) =>
      t.mock.method(fs, method, async (...args) => {
        const [source, target] = args;
        if (
          method === "unlink" &&
          source === path.join(f.storage, "transaction.json")
        )
          throw new Error("crash leaves journal");
        const match =
          boundary === "rename-target"
            ? method === "rename" &&
              String(source).includes("relocation-") &&
              String(target).includes(`${path.sep}versions${path.sep}`)
            : boundary === "backup-registration"
              ? method === "link" &&
                String(target).includes(".ironclad-relocation-backup-")
              : boundary === "remove-registration"
                ? method === "unlink" && source === installed.descriptorPath
                : boundary === "activate-registration"
                  ? method === "link" &&
                    target === installed.descriptorPath &&
                    String(source).includes(".ironclad-relocation-tmp-")
                  : method === "rename" &&
                    target === path.join(f.storage, "installations.json") &&
                    (await fs.readFile(source, "utf8")).includes(
                      '"lastRelocationId"',
                    );
        const result = await { rename, link, unlink }[method](...args);
        if (match && !interrupted) {
          interrupted = true;
          throw new Error("simulated completed operation interruption");
        }
        return result;
      }),
    );
    try {
      await assert.rejects(f.service.relocate({ planId: plan.planId }), {
        code: "RECOVERY_REQUIRED",
      });
    } finally {
      hooks.forEach((h) => h.mock.restore());
    }
    assert.equal(interrupted, true);
    const expected =
      boundary === "database-commit" ? "completed" : "rolled-back";
    assert.equal((await f.restart().recover()).action, expected);
    const state = await f
      .restart()
      .getStorageState({ userDataPath: f.userDataPath });
    assert.equal(state.isDefault, expected === "rolled-back");
    if (expected === "rolled-back")
      assert.deepEqual(await f.restart().list(), [installed]);
    else await missing(installed.contentPath);
  });
}

test("tampered recovery paths are rejected without touching an external file", async (t) => {
  const f = await fixture(t);
  await f.install();
  const plan = await f.plan(),
    unlink = fs.unlink,
    journal = path.join(f.storage, "transaction.json");
  const hook = t.mock.method(fs, "unlink", async (file) => {
    if (file === journal) throw new Error("journal locked");
    return unlink(file);
  });
  try {
    await assert.rejects(f.service.relocate({ planId: plan.planId }), {
      code: "RECOVERY_REQUIRED",
    });
  } finally {
    hook.mock.restore();
  }
  const original = await fs.readFile(journal, "utf8"),
    tampered = JSON.parse(original),
    outside = path.join(f.root, "keep.txt");
  await fs.writeFile(outside, "untouched");
  tampered.entries[0].content.files[0].relative = "../../../../keep.txt";
  await fs.writeFile(journal, JSON.stringify(tampered));
  await assert.rejects(f.restart().recover(), { code: "RECOVERY_REQUIRED" });
  assert.equal(await fs.readFile(outside, "utf8"), "untouched");
  await fs.writeFile(journal, original);
  await f.restart().recover();
});

for (const replacement of [
  "content-root",
  "nested-directory",
  "storage-root",
]) {
  test(`cleanup retains files when ${replacement} becomes a junction during digest`, async (t) => {
    const f = await fixture(t);
    await f.install();
    let targetParent = f.targetParent;
    if (replacement === "storage-root") {
      const first = await f.plan();
      await f.service.relocate({ planId: first.planId });
      targetParent = path.join(f.root, "second-target");
      await fs.mkdir(targetParent);
    }
    const installed = (await f.service.list())[0],
      plan = await f.plan(targetParent);
    const payload = path.join(installed.contentPath, "events", "fixture.txt");
    const displaced = path.join(f.root, "displaced-owned-directory");
    const target =
      replacement === "content-root"
        ? installed.contentPath
        : replacement === "nested-directory"
          ? path.dirname(payload)
          : (await f.service.getStorageState({ userDataPath: f.userDataPath }))
              .location;
    const open = fs.open;
    let cleaning = false,
      replaced = false;
    const hook = t.mock.method(fs, "open", async (filename, ...args) => {
      if (cleaning && !replaced && filename === payload && args[0] === "r") {
        await fs.rename(target, displaced);
        await fs.symlink(displaced, target, "junction");
        replaced = true;
      }
      return open(filename, ...args);
    });
    let result;
    try {
      result = await f.service.relocate({
        planId: plan.planId,
        onProgress: (p) => {
          if (p.stage === "cleaning") cleaning = true;
        },
      });
    } finally {
      hook.mock.restore();
    }
    assert.equal(replaced, true);
    assert.equal(
      await fs.readFile(
        path.join(displaced, path.relative(target, payload)),
        "utf8",
      ),
      "payload",
    );
    assert.ok(result.retainedPaths.includes(installed.contentPath));
    assert.ok(result.warnings.length);
    assert.equal((await fs.lstat(target)).isSymbolicLink(), true);
    assert.equal(
      (await f.service.list())[0].contentPath.startsWith(plan.to),
      true,
    );
  });
}

test("rollback cleanup does not follow a staging junction inserted during digest", async (t) => {
  const f = await fixture(t),
    installed = await f.install(),
    plan = await f.plan();
  const open = fs.open,
    link = fs.link,
    displaced = path.join(f.root, "displaced-staging");
  let rollingBack = false,
    replaced = false,
    stagePath;
  const failCommit = t.mock.method(fs, "link", async (source, target) => {
    if (String(target).includes(".ironclad-relocation-backup-")) {
      rollingBack = true;
      throw new Error("fixture registration failure");
    }
    return link(source, target);
  });
  const replaceDuringRead = t.mock.method(
    fs,
    "open",
    async (filename, ...args) => {
      if (
        rollingBack &&
        !replaced &&
        filename.startsWith(plan.to + path.sep) &&
        filename.endsWith(path.join("events", "fixture.txt"))
      ) {
        stagePath = path.dirname(path.dirname(filename));
        await fs.rename(stagePath, displaced);
        await fs.symlink(displaced, stagePath, "junction");
        replaced = true;
      }
      return open(filename, ...args);
    },
  );
  let failure;
  try {
    await assert.rejects(f.service.relocate({ planId: plan.planId }), (e) => {
      failure = e;
      return /fixture registration failure/.test(e.message);
    });
  } finally {
    failCommit.mock.restore();
    replaceDuringRead.mock.restore();
  }
  assert.equal(replaced, true);
  assert.equal(
    await fs.readFile(path.join(displaced, "events", "fixture.txt"), "utf8"),
    "payload",
  );
  assert.ok(failure.retainedPaths.includes(stagePath));
  assert.deepEqual(await f.service.list(), [installed]);
});
