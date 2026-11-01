"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createPublishService } = require("../electron/publish-service.cjs");

const prepareInput = (patch = {}) => ({
  modId: "local-mod",
  title: "A local mod",
  description: "Reviewed description",
  tags: ["Gameplay"],
  visibility: 2,
  changeNote: "Initial release",
  existingItemId: null,
  thumbnail: "preview.png",
  ...patch,
});

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ironclad-publish-"));
  t.after(() =>
    fs.rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    }),
  );
  const source = path.join(root, "local-mod");
  const storage = path.join(root, "publishing");
  const outside = path.join(root, "outside");
  await fs.mkdir(path.join(source, "events"), { recursive: true });
  await fs.mkdir(outside);
  await fs.writeFile(
    path.join(source, "descriptor.mod"),
    'name="A local mod"\n',
  );
  await fs.writeFile(
    path.join(source, "events", "campaign.txt"),
    "original campaign\n",
  );
  await fs.writeFile(
    path.join(source, "preview.png"),
    Buffer.from("89504e470d0a1a0a", "hex"),
  );
  const descriptorPath = path.join(root, "registered.mod");
  await fs.writeFile(descriptorPath, 'name="A local mod"\n');
  const metadata = {
    id: "local-mod",
    name: "A local mod",
    descriptorPath,
    contentPath: source,
    remoteFileId: null,
  };
  const calls = [];
  const behavior = {
    running: false,
    connected: true,
    startError: null,
    ownerError: null,
  };
  const steam = {
    call: async (method, ...args) => {
      calls.push({ method, args });
      if (method === "getState") return { connected: behavior.connected };
      if (method === "validatePublishTarget") {
        if (behavior.ownerError) throw behavior.ownerError;
        return { id: args[0], name: "Remote mod", owned: true };
      }
      if (method === "startPublish") {
        if (behavior.startError) throw behavior.startError;
        return {
          id: args[0].id,
          status: "queued",
          itemId: args[0].existingItemId,
          progress: null,
          needsAgreement: false,
          error: null,
        };
      }
      throw new Error("Unexpected mocked Steam method: " + method);
    },
  };
  const options = {
    storageDirectory: storage,
    resolveMod: async (id) => {
      assert.equal(id, "local-mod");
      return { ...metadata };
    },
    isGameRunning: async () => behavior.running,
    steam,
  };
  const service = createPublishService(options);
  const content = (review) =>
    path.join(storage, "staging", review.id, "content");
  return {
    root,
    source,
    storage,
    outside,
    metadata,
    calls,
    behavior,
    steam,
    service,
    content,
    restart: () => createPublishService(options),
  };
}

function pdxFixture(f, onRefresh) {
  let current = null;
  const calls = [];
  const bridge = {
    call: async (method, ...args) => {
      calls.push({ method, args });
      if (method === "getState")
        return {
          connected: true,
          accountId: "author-a",
          displayName: "Fixture author",
        };
      if (method === "validatePublishTarget")
        return {
          itemId: args[0],
          accountId: "author-a",
          displayName: "Fixture author",
        };
      if (method === "startPublish")
        return (current = {
          id: args[0].id,
          status: "queued",
          itemId: args[0].existingItemId,
          publicationName: "11111111-2222-3333-4444-555555555555",
          accountId: args[0].actorId,
          commitSent: false,
        });
      if (method === "getPublishStatus") return current;
      if (method === "refreshPublish") {
        current = {
          ...args[0],
          status: "succeeded",
          itemId: "321",
          error: null,
        };
        await onRefresh?.(current);
        return current;
      }
      throw new Error("Unknown fixture method");
    },
  };
  const options = {
    provider: "pdx",
    storageDirectory: f.storage,
    resolveMod: async () => ({ ...f.metadata }),
    isGameRunning: async () => f.behavior.running,
    steam: bridge,
  };
  return {
    service: createPublishService(options),
    calls,
    restart: () => createPublishService(options),
    input: prepareInput({
      shortDescription: "A detailed fixture summary",
      recommendedVersion: "1.19.*",
    }),
  };
}

test("PDX review binds the author, edits only snapshot supported_version and retains independent provider IDs", async (t) => {
  const f = await fixture(t);
  f.metadata.remoteFileId = "999999";
  const descriptor = path.join(f.source, "descriptor.mod");
  await fs.writeFile(
    descriptor,
    'name="Original"\nsupported_version="1.18.*"\nreplace_path="history/states"\n',
  );
  const before = await fs.readFile(descriptor);
  const p = pdxFixture(f);
  assert.equal((await p.service.getDraft("local-mod")).existingItemId, null);
  const review = await p.service.prepare({
    ...p.input,
    title: "中文".repeat(30),
  });
  assert.equal(review.title.length, 60);
  assert.equal(review.actor, "Fixture author");
  assert.equal(review.visibility, "provider-default");
  const snapshot = await fs.readFile(
    path.join(f.content(review), "descriptor.mod"),
    "utf8",
  );
  assert.match(snapshot, /supported_version="1.19.\*"/);
  assert.match(snapshot, /replace_path="history\/states"/);
  assert.deepEqual(await fs.readFile(descriptor), before);
  await p.service.commit(review.id);
  const submitted = p.calls.find((call) => call.method === "startPublish")
    .args[0];
  assert.equal(submitted.actorId, "author-a");
  assert.equal(submitted.files.length, review.fileCount);
  const saved = JSON.parse(
    await fs.readFile(path.join(f.storage, "history.json"), "utf8"),
  );
  assert.equal(
    saved.lastJob.publicationName,
    "11111111-2222-3333-4444-555555555555",
  );
});

test("PDX official metadata limits and required new thumbnail fail before preparing content", async (t) => {
  const f = await fixture(t),
    p = pdxFixture(f);
  for (const patch of [
    { title: "ab" },
    { title: "a".repeat(61) },
    { shortDescription: "short" },
    { shortDescription: "a".repeat(201) },
    { description: "<script>hidden text</script>" },
    { recommendedVersion: "1".repeat(13) },
    { changeNote: "a".repeat(5001) },
    { tags: Array.from({ length: 11 }, (_, i) => `tag${i}`) },
    { thumbnail: "" },
  ])
    await assert.rejects(p.service.prepare({ ...p.input, ...patch }));
  assert.equal(p.calls.length, 0);
  await fs.writeFile(path.join(f.source, "preview.png"), Buffer.alloc(1000001));
  await assert.rejects(p.service.prepare(p.input), /1,000,000/);
});

test("PDX sanitized description limits accept formatted text without counting markup", async (t) => {
  const f = await fixture(t),
    p = pdxFixture(f);
  const review = await p.service.prepare({
    ...p.input,
    shortDescription:
      '<span class="' +
      "x".repeat(300) +
      '">This is a valid short description.</span>',
  });
  assert.match(review.shortDescription, /valid short description/);
});

test("PDX publication status journal failures cannot be bypassed by an identical retry", async (t) => {
  const f = await fixture(t),
    p = pdxFixture(f);
  const review = await p.service.prepare(p.input),
    job = await p.service.commit(review.id);
  const journal = path.join(f.storage, "history.json"),
    backup = path.join(f.storage, "saved-history.json");
  await fs.rename(journal, backup);
  await fs.mkdir(journal);
  const next = { ...job, status: "publishing", commitSent: true };
  await assert.rejects(p.service.recordStatus(next), /保存发布记录/);
  await assert.rejects(p.service.recordStatus(next), /保存发布记录/);
  await fs.rmdir(journal);
  await fs.rename(backup, journal);
  await p.service.recordStatus(next);
  assert.equal(
    JSON.parse(await fs.readFile(journal, "utf8")).lastJob.commitSent,
    true,
  );
});

test("PDX unknown submission survives restart, prevents duplicate creation and can recover its remote ID", async (t) => {
  const f = await fixture(t),
    p = pdxFixture(f);
  const review = await p.service.prepare(p.input),
    job = await p.service.commit(review.id);
  await p.service.recordStatus({
    ...job,
    status: "pending",
    commitSent: true,
    error: "unknown",
  });
  const restarted = p.restart();
  await assert.rejects(restarted.prepare(p.input), /避免重复创建/);
  assert.equal((await restarted.refreshStatus()).itemId, "321");
  assert.equal((await restarted.getDraft("local-mod")).existingItemId, "321");
  assert.equal(
    p.calls.filter((call) => call.method === "startPublish").length,
    1,
  );
});

test("publication preparation reserves the launch gate before its first async check", async (t) => {
  const f = await fixture(t);
  const preparing = f.service.prepare(prepareInput());
  assert.equal(f.service.isPublishing(), true);
  await preparing;
  assert.equal(f.service.isPublishing(), false);
});

test(
  "PDX recovery can await persisted callbacks without locking its status queue",
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t);
    let entered, release;
    const ready = new Promise((resolve) => {
      entered = resolve;
    });
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const p = pdxFixture(f, async (next) => {
      await p.service.recordStatus(next);
      entered();
      await gate;
    });
    const review = await p.service.prepare(p.input);
    const queued = await p.service.commit(review.id);
    await p.service.recordStatus({
      ...queued,
      status: "pending",
      commitSent: true,
    });
    const recovery = p.service.refreshStatus();
    try {
      assert.equal(p.service.isPublishing(), true);
      await ready;
      assert.equal((await p.service.getStatus()).itemId, "321");
      await assert.rejects(p.service.refreshStatus(), /核对发布状态/);
      await assert.rejects(p.service.prepare(p.input), /核对发布状态/);
    } finally {
      release();
    }
    assert.equal((await recovery).status, "succeeded");
    assert.equal(p.service.isPublishing(), false);
    assert.equal(
      (await p.restart().getDraft("local-mod")).existingItemId,
      "321",
    );
  },
);

test(
  "prepare completes without uploading and makes independent snapshot files",
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t);
    const review = await f.service.prepare(prepareInput());
    assert.equal(review.fileCount, 3);
    assert.equal(
      f.calls.some((call) => call.method === "startPublish"),
      false,
    );
    assert.equal(f.service.isPublishing(), false);
    const original = path.join(f.source, "events", "campaign.txt");
    const copied = path.join(f.content(review), "events", "campaign.txt");
    assert.equal(await fs.readFile(copied, "utf8"), "original campaign\n");
    await fs.writeFile(original, "changed original\n");
    assert.equal(await fs.readFile(copied, "utf8"), "original campaign\n");
    assert.equal((await fs.stat(copied)).nlink, 1);
    assert.notEqual((await fs.stat(original)).ino, (await fs.stat(copied)).ino);
    const job = await f.service.commit(review.id);
    assert.equal(job.status, "queued");
    const submitted = f.calls.find((call) => call.method === "startPublish")
      .args[0];
    assert.equal(submitted.contentPath, f.content(review));
    assert.equal(
      submitted.previewPath,
      path.join(f.content(review), "preview.png"),
    );
    assert.notEqual(submitted.contentPath, f.source);
  },
);

test(
  "prepare omits VCS and launcher backup files from reviewed content",
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t);
    await fs.mkdir(path.join(f.source, ".git"));
    await fs.writeFile(
      path.join(f.source, ".git", "config"),
      "private repository metadata",
    );
    await fs.writeFile(
      path.join(f.source, "events", "campaign.txt.ironclad-backup-old"),
      "backup",
    );
    await fs.writeFile(
      path.join(f.source, "descriptor.mod.ironclad-edit.lock"),
      "lock",
    );
    const review = await f.service.prepare(prepareInput());
    assert.equal(review.fileCount, 3);
    assert.ok(review.omitted.includes(".git"));
    assert.ok(review.omitted.some((name) => name.includes("ironclad-backup")));
    assert.ok(review.files.every((file) => !/\.git|ironclad-/.test(file.path)));
    await assert.rejects(fs.stat(path.join(f.content(review), ".git")), {
      code: "ENOENT",
    });
  },
);

test("missing descriptor prevents preparing or submitting", async (t) => {
  const f = await fixture(t);
  await fs.unlink(path.join(f.source, "descriptor.mod"));
  await assert.rejects(f.service.prepare(prepareInput()), /descriptor[.]mod/);
  assert.equal(
    f.calls.some((call) => call.method === "startPublish"),
    false,
  );
});

test("source junctions and hardlinks are rejected before a snapshot is trusted", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.outside, "private.txt"), "must not publish");
  const junction = path.join(f.source, "linked-directory");
  await fs.symlink(f.outside, junction, "junction");
  await assert.rejects(f.service.prepare(prepareInput()), /链接|联接/);
  await fs.unlink(junction);
  await fs.link(
    path.join(f.outside, "private.txt"),
    path.join(f.source, "hardlinked.txt"),
  );
  await assert.rejects(f.service.prepare(prepareInput()), /硬链接|普通文件/);
  assert.equal(
    f.calls.some((call) => call.method === "startPublish"),
    false,
  );
});

test("preview must be an included PNG or JPEG within the local mod", async (t) => {
  const f = await fixture(t);
  for (const thumbnail of [
    "..\\outside\\private.png",
    path.join(f.outside, "private.png"),
    "missing.png",
    "events/campaign.txt",
  ])
    await assert.rejects(
      f.service.prepare(prepareInput({ thumbnail })),
      /预览图/,
    );
  await fs.writeFile(
    path.join(f.source, "large.png"),
    Buffer.alloc(1024 * 1024 + 1),
  );
  await assert.rejects(
    f.service.prepare(prepareInput({ thumbnail: "large.png" })),
    /预览图/,
  );
  assert.equal(
    f.calls.some((call) => call.method === "startPublish"),
    false,
  );
});

test("an unowned target or disconnected Steam prevents preparation", async (t) => {
  const f = await fixture(t);
  f.behavior.ownerError = new Error("此模组不属于当前 Steam 账号");
  await assert.rejects(
    f.service.prepare(prepareInput({ existingItemId: "123" })),
    /不属于/,
  );
  f.behavior.connected = false;
  await assert.rejects(f.service.prepare(prepareInput()), /连接 Steam/);
  assert.equal(
    f.calls.some((call) => call.method === "startPublish"),
    false,
  );
});

test(
  "commit rejects same-sized changed snapshot files even with restored timestamps",
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t);
    const review = await f.service.prepare(prepareInput());
    const file = path.join(f.content(review), "events", "campaign.txt");
    const info = await fs.stat(file);
    await fs.writeFile(file, "modified campaign\n");
    await fs.utimes(file, info.atime, info.mtime);
    assert.equal((await fs.stat(file)).size, info.size);
    await assert.rejects(f.service.commit(review.id), /快照|修改/);
    assert.equal(
      f.calls.some((call) => call.method === "startPublish"),
      false,
    );
  },
);

for (const relative of [
  "added.txt",
  ".git/private.txt",
  "events/campaign.txt.ironclad-backup-foreign",
]) {
  test(
    `commit rejects extra snapshot content including ignored names: ${relative}`,
    { timeout: 5000 },
    async (t) => {
      const f = await fixture(t);
      const review = await f.service.prepare(prepareInput());
      const foreign = path.join(f.content(review), relative);
      await fs.mkdir(path.dirname(foreign), { recursive: true });
      await fs.writeFile(foreign, "foreign content must never be submitted");
      await assert.rejects(f.service.commit(review.id), /快照|修改|额外|内容/);
      assert.equal(
        f.calls.some((call) => call.method === "startPublish"),
        false,
      );
    },
  );
}

test(
  "commit rejects replacement links and hardlinks in staged content",
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t);
    const review = await f.service.prepare(prepareInput());
    const copied = path.join(f.content(review), "events", "campaign.txt");
    const external = path.join(f.outside, "foreign.txt");
    await fs.writeFile(external, "original campaign\n");
    await fs.unlink(copied);
    await fs.link(external, copied);
    await assert.rejects(f.service.commit(review.id), /硬链接|普通文件|快照/);
    assert.equal(
      f.calls.some((call) => call.method === "startPublish"),
      false,
    );
  },
);

test(
  "commit is single use even after a completed job",
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t);
    const review = await f.service.prepare(prepareInput());
    const first = await f.service.commit(review.id);
    await assert.rejects(f.service.commit(review.id), /正在发布|已提交/);
    await f.service.recordStatus({
      ...first,
      status: "succeeded",
      itemId: "777",
    });
    await assert.rejects(f.service.commit(review.id), /已失效|已提交/);
    assert.equal(
      f.calls.filter((call) => call.method === "startPublish").length,
      1,
    );
  },
);

test(
  "the game-running guard prevents both preparation and commit",
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t);
    f.behavior.running = true;
    await assert.rejects(f.service.prepare(prepareInput()), /退出游戏/);
    assert.equal(f.calls.length, 0);
    f.behavior.running = false;
    const review = await f.service.prepare(prepareInput());
    f.behavior.running = true;
    await assert.rejects(f.service.commit(review.id), /退出游戏/);
    assert.equal(
      f.calls.some((call) => call.method === "startPublish"),
      false,
    );
  },
);

test(
  "a created item ID is durable and an interrupted job never replays after restart",
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t);
    const review = await f.service.prepare(prepareInput());
    const queued = await f.service.commit(review.id);
    await f.service.recordStatus({
      ...queued,
      status: "creating",
      itemId: "777",
    });
    const disk = JSON.parse(
      await fs.readFile(path.join(f.storage, "history.json"), "utf8"),
    );
    assert.equal(disk.bindings[0].itemId, "777");
    assert.equal(disk.bindings[0].descriptorPath, f.metadata.descriptorPath);
    const registeredBefore = await fs.readFile(
      f.metadata.descriptorPath,
      "utf8",
    );
    f.metadata.remoteFileId = "111";
    const restored = f.restart();
    const draft = await restored.getDraft("local-mod");
    assert.equal(draft.existingItemId, "777");
    assert.equal(draft.lastJob.itemId, "777");
    assert.equal(draft.lastJob.status, "interrupted");
    assert.equal((await restored.getStatus()).status, "interrupted");
    assert.equal(restored.isPublishing(), false);
    assert.equal(
      f.calls.filter((call) => call.method === "startPublish").length,
      1,
    );
    assert.equal(
      await fs.readFile(f.metadata.descriptorPath, "utf8"),
      registeredBefore,
    );
  },
);

test(
  "an uncertain submit is recorded as interrupted and cannot replay its old review",
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t);
    const review = await f.service.prepare(prepareInput());
    f.behavior.startError = new Error(
      "worker crashed after possible acceptance",
    );
    const job = await f.service.commit(review.id);
    assert.equal(job.status, "interrupted");
    assert.match(job.error, /未能确认/);
    await assert.rejects(f.service.commit(review.id), /失效|已提交/);
    assert.equal(
      (await f.restart().getDraft("local-mod")).lastJob.status,
      "interrupted",
    );
    assert.equal(
      f.calls.filter((call) => call.method === "startPublish").length,
      1,
    );
  },
);

test(
  "unrelated status events cannot bind a new remote item to the reviewed mod",
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t);
    const review = await f.service.prepare(prepareInput());
    const queued = await f.service.commit(review.id);
    await f.service.recordStatus({
      ...queued,
      id: "other-job",
      status: "succeeded",
      itemId: "999",
    });
    assert.equal((await f.service.getStatus()).itemId, null);
    assert.equal((await f.service.getDraft("local-mod")).existingItemId, null);
  },
);

test(
  "cancel removes unchanged owned files but preserves modified and additional foreign content",
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t);
    const review = await f.service.prepare(prepareInput());
    const changed = path.join(f.content(review), "events", "campaign.txt");
    const extra = path.join(f.content(review), "foreign.txt");
    await fs.writeFile(changed, "user changed staged copy");
    await fs.writeFile(extra, "user owned file");
    await f.service.cancel();
    assert.equal(
      await fs.readFile(changed, "utf8"),
      "user changed staged copy",
    );
    assert.equal(await fs.readFile(extra, "utf8"), "user owned file");
    await assert.rejects(
      fs.stat(path.join(f.content(review), "descriptor.mod")),
      { code: "ENOENT" },
    );
    assert.equal(
      await fs.readFile(path.join(f.source, "events", "campaign.txt"), "utf8"),
      "original campaign\n",
    );
    await assert.rejects(f.service.commit(review.id), /失效|已提交/);
  },
);

test(
  "cancel must not follow a replaced content junction into an unrelated directory",
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t);
    const review = await f.service.prepare(prepareInput());
    const originalContent = f.content(review);
    const displaced = path.join(f.root, "displaced-snapshot");
    await fs.rename(originalContent, displaced);
    await fs.cp(f.source, f.outside, { recursive: true });
    await fs.symlink(f.outside, originalContent, "junction");
    await f.service.cancel();
    assert.equal(
      await fs.readFile(path.join(f.outside, "descriptor.mod"), "utf8"),
      'name="A local mod"\n',
    );
    assert.equal(
      await fs.readFile(path.join(f.outside, "events", "campaign.txt"), "utf8"),
      "original campaign\n",
    );
    assert.equal((await fs.lstat(originalContent)).isSymbolicLink(), true);
    assert.equal(
      await fs.readFile(path.join(displaced, "descriptor.mod"), "utf8"),
      'name="A local mod"\n',
    );
  },
);

test(
  "cancel preserves a foreign replacement even when it has the original content",
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t);
    const review = await f.service.prepare(prepareInput());
    const copied = path.join(f.content(review), "descriptor.mod");
    const original = await fs.readFile(copied);
    const prior = await fs.stat(copied);
    const replacement = path.join(f.root, "foreign-replacement.mod");
    await fs.writeFile(replacement, original);
    await fs.unlink(copied);
    await fs.rename(replacement, copied);
    assert.notEqual((await fs.stat(copied)).ino, prior.ino);
    await f.service.cancel();
    assert.deepEqual(await fs.readFile(copied), original);
  },
);

test(
  "a failed copy removes its owned partial file while retaining unrelated staged files",
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t);
    const realOpen = fs.open;
    let partial, foreign;
    const hook = t.mock.method(fs, "open", async (file, flags, ...args) => {
      const handle = await realOpen(file, flags, ...args);
      if (
        !partial &&
        flags === "wx" &&
        typeof file === "string" &&
        file.startsWith(path.join(f.storage, "staging")) &&
        path.basename(file) === "descriptor.mod"
      ) {
        partial = file;
        foreign = path.join(path.dirname(file), "foreign-during-copy.txt");
        await fs.writeFile(foreign, "created by another actor");
        await fs.writeFile(
          path.join(f.source, "descriptor.mod"),
          'name="modified while copying source"\n',
        );
      }
      return handle;
    });
    try {
      await assert.rejects(f.service.prepare(prepareInput()), /变化|修改/);
    } finally {
      hook.mock.restore();
    }
    assert.ok(
      partial,
      "the injected source change must happen after target creation",
    );
    await assert.rejects(fs.stat(partial), { code: "ENOENT" });
    assert.equal(
      await fs.readFile(foreign, "utf8"),
      "created by another actor",
    );
    assert.equal(
      f.calls.some((call) => call.method === "startPublish"),
      false,
    );
  },
);

test(
  "cancel rechecks directory identity after hashing before unlinking",
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t);
    const review = await f.service.prepare(prepareInput());
    const content = f.content(review);
    const displaced = path.join(f.root, "displaced-during-cleanup");
    await fs.cp(f.source, f.outside, { recursive: true });
    const realOpen = fs.open;
    let replaced = false;
    const hook = t.mock.method(fs, "open", async (file, flags, ...args) => {
      if (
        !replaced &&
        flags === "r" &&
        typeof file === "string" &&
        file.startsWith(content + path.sep)
      ) {
        replaced = true;
        await fs.rename(content, displaced);
        await fs.symlink(f.outside, content, "junction");
      }
      return realOpen(file, flags, ...args);
    });
    try {
      await f.service.cancel();
    } finally {
      hook.mock.restore();
    }
    assert.equal(
      replaced,
      true,
      "replace the snapshot only after the first cleanup identity checks",
    );
    assert.equal(
      await fs.readFile(path.join(f.outside, "descriptor.mod"), "utf8"),
      'name="A local mod"\n',
    );
    assert.equal(
      await fs.readFile(path.join(f.outside, "events", "campaign.txt"), "utf8"),
      "original campaign\n",
    );
    assert.deepEqual(
      await fs.readFile(path.join(f.outside, "preview.png")),
      Buffer.from("89504e470d0a1a0a", "hex"),
    );
  },
);

test(
  "commit rejects a snapshot directory replaced while its files are being hashed",
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t);
    const review = await f.service.prepare(prepareInput());
    const content = f.content(review);
    await fs.cp(f.source, f.outside, { recursive: true });
    await fs.writeFile(
      path.join(f.outside, "private.txt"),
      "must never reach Steam",
    );
    const realOpen = fs.open;
    let replaced = false;
    const hook = t.mock.method(fs, "open", async (file, flags, ...args) => {
      if (
        !replaced &&
        flags === "r" &&
        typeof file === "string" &&
        file.startsWith(content + path.sep)
      ) {
        replaced = true;
        await fs.rename(content, path.join(f.root, "displaced-during-commit"));
        await fs.symlink(f.outside, content, "junction");
      }
      return realOpen(file, flags, ...args);
    });
    try {
      await assert.rejects(
        f.service.commit(review.id),
        /快照|路径|链接|联接|修改/,
      );
    } finally {
      hook.mock.restore();
    }
    assert.equal(replaced, true);
    assert.equal(
      f.calls.some((call) => call.method === "startPublish"),
      false,
    );
    assert.equal(
      await fs.readFile(path.join(f.outside, "private.txt"), "utf8"),
      "must never reach Steam",
    );
  },
);

test("corrupt publication history fails closed instead of risking duplicate remote creation", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(f.storage);
  await fs.writeFile(path.join(f.storage, "history.json"), "{broken json");
  await assert.rejects(f.service.getDraft("local-mod"), /发布记录无法读取/);
  await assert.rejects(f.service.prepare(prepareInput()), /发布记录无法读取/);
  assert.equal(f.calls.length, 0);
});
