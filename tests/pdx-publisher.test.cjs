"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");
const { createPdxPublisher } = require("../electron/pdx-publisher.cjs");
const clone = (value) => structuredClone(value);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const code = (value) => (error) => error.code === value;
const failure = (value) =>
  Object.assign(new Error("fixture credential must not escape"), {
    code: value,
  });
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "ironclad-pdx-publish-"),
  );
  t.after(() =>
    fs.rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    }),
  );
  const contentPath = path.join(root, "content");
  await fs.mkdir(contentPath);
  const descriptor = Buffer.from(
    'name="Fixture mod"\nsupported_version="1.19.*"\n',
  );
  await fs.writeFile(path.join(contentPath, "descriptor.mod"), descriptor);
  const stat = await fs.lstat(path.join(contentPath, "descriptor.mod"));
  const archivePath = path.join(root, "fixture.zip"),
    zip = Buffer.from("tiny fixture ZIP stream");
  await fs.writeFile(archivePath, zip);
  const f = {
    root,
    contentPath,
    archivePath,
    current: "account-A",
    calls: [],
    uploads: [],
    events: [],
    timeline: [],
    publications: new Map(),
    cleanupCount: 0,
    packCount: 0,
    getAccountCount: 0,
    before: null,
    after: null,
    override: null,
    uploadHook: null,
    eventHook: null,
    packHook: null,
    input: {
      id: "task-1",
      actorId: "account-A",
      existingItemId: null,
      contentPath,
      files: [
        {
          relative: "descriptor.mod",
          size: descriptor.length,
          hash: hash(descriptor),
          targetIno: stat.ino,
          targetDev: stat.dev,
        },
      ],
      title: "Fixture mod",
      description: "A sufficiently detailed description.",
      shortDescription: "A short summary.",
      tags: ["Alternative History"],
      changeNote: "A change note",
      recommendedVersion: "1.19.*",
    },
  };
  f.account = {
    async getAccount() {
      f.getAccountCount++;
      return f.current
        ? {
            status: "signed-in",
            account: { id: f.current, displayName: "Fixture author" },
          }
        : { status: "signed-out", account: null };
    },
    async request(input) {
      const call = { method: "GET", ...input };
      f.calls.push(call);
      f.timeline.push(`${call.method} ${call.path}`);
      await f.before?.(call);
      if (call.expectedAccountId !== f.current)
        throw failure("ACCOUNT_CHANGED");
      if (call.signal?.aborted) throw failure("CANCELLED");
      const overridden = await f.override?.(call);
      let result;
      if (overridden) result = overridden.value;
      else if (call.method === "POST" && call.path === "/mods") {
        const rows = [...f.publications.values()]
          .filter((item) => item.owner === f.current)
          .map((item) => ({ modId: item.modId, name: item.name }));
        result = {
          result: "OK",
          mods: rows.slice(
            call.body.page * call.body.pageSize,
            (call.body.page + 1) * call.body.pageSize,
          ),
          totalCount: rows.length,
        };
      } else if (call.method === "GET" && call.path === "/mods") {
        const value = f.publications.get(call.query.modId);
        if (!value) throw failure("REQUEST_FAILED");
        result = { result: "OK", modDetail: clone(value) };
      } else if (["/mods/publish", "/mods/publishUpdate"].includes(call.path)) {
        const modId = call.body.modId || "123",
          old = f.publications.get(modId);
        f.publications.set(modId, {
          modId,
          name: call.body.modName,
          game: "hoi4",
          state: "published",
          updating: false,
          modVersion: old ? String(Number(old.modVersion) + 1) : "1",
          acl: "public",
          owner: f.current,
        });
        result = { modId, state: "publishing" };
      } else throw new Error(`Unexpected request ${call.method} ${call.path}`);
      await f.after?.(call, result);
      if (call.expectedAccountId !== f.current) throw failure("CANCELLED");
      return result;
    },
    async uploadFile(input) {
      f.uploads.push(input);
      f.timeline.push("PUT " + input.path);
      if (input.expectedAccountId !== f.current)
        throw failure("ACCOUNT_CHANGED");
      if (input.signal?.aborted) throw failure("CANCELLED");
      await f.uploadHook?.(input);
      input.onProgress({
        processedBytes: input.bytes,
        totalBytes: input.bytes,
      });
      if (input.expectedAccountId !== f.current) throw failure("CANCELLED");
      return { result: "OK" };
    },
  };
  f.config = {
    account: f.account,
    pollIntervalMs: 0,
    maxPolls: 3,
    async createArchive(input) {
      f.packCount++;
      f.packInput = input;
      const override = await f.packHook?.(input);
      if (override) return override;
      input.onProgress({
        processedBytes: descriptor.length,
        totalBytes: descriptor.length,
      });
      return {
        path: archivePath,
        bytes: zip.length,
        sha256: hash(zip),
        cleanup: async () => {
          f.cleanupCount++;
        },
      };
    },
    async onPublishStatus(value) {
      f.events.push(clone(value));
      f.timeline.push(`event ${value.status}`);
      await f.eventHook?.(value);
    },
    ...options,
  };
  f.service = createPdxPublisher(f.config);
  f.finish = async () => {
    for (let i = 0; i < 1000; i++) {
      const status = f.service.getPublishStatus();
      if (
        status &&
        !["queued", "packing", "uploading", "publishing"].includes(
          status.status,
        )
      ) {
        // Allow the provider's cleanup/finally microtasks to settle as well.
        await new Promise((resolve) => setImmediate(resolve));
        return f.service.getPublishStatus();
      }
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    throw new Error("Fixture publish did not finish");
  };
  f.existing = (id = "777", changes = {}) => {
    const value = {
      modId: id,
      name: "existing-publication",
      game: "hoi4",
      owner: "account-A",
      state: "published",
      updating: false,
      modVersion: "2",
      acl: "public",
      ...changes,
    };
    f.publications.set(id, value);
    return value;
  };
  return f;
}

test("construction is inert, statuses are synchronous, and new publication is persisted before PUT", async (t) => {
  const f = await fixture(t);
  assert.equal(f.getAccountCount, 0);
  assert.equal(f.calls.length, 0);
  assert.equal(f.service.getPublishStatus(), null);
  const queued = f.service.startPublish(f.input);
  assert.equal(queued.status, "queued");
  assert.equal(queued.then, undefined);
  assert.match(queued.publicationName, /^[\da-f-]{36}$/);
  assert.equal(f.calls.length, 0);
  const done = await f.finish();
  assert.equal(done.status, "succeeded");
  assert.equal(done.itemId, "123");
  assert.equal(done.visibility, "public");
  assert.equal(f.events[0].publicationName, queued.publicationName);
  assert.ok(
    f.timeline.indexOf("event queued") <
      f.timeline.findIndex((item) => item.startsWith("PUT ")),
  );
  const post = f.calls.find((call) => call.path === "/mods/publish");
  assert.equal(post.body.gameName, "hoi4");
  assert.equal(post.body.modName, queued.publicationName);
  assert.equal(post.body.changelogEntry, undefined);
  assert.equal(post.body.acl, undefined);
  assert.ok(f.calls.every((call) => call.expectedAccountId === "account-A"));
  assert.equal(f.uploads[0].filePath, f.archivePath);
  assert.equal(f.uploads[0].body, undefined);
  assert.equal(f.cleanupCount, 1);
  assert.equal(done.progress.processedBytes, done.progress.totalBytes);
});

test("status persistence failure prevents all uploads and publication", async (t) => {
  const f = await fixture(t);
  f.eventHook = () => {
    throw new Error("disk full secret");
  };
  f.service.startPublish(f.input);
  const done = await f.finish();
  assert.equal(done.status, "failed");
  assert.equal(f.uploads.length, 0);
  assert.equal(f.calls.length, 0);
  assert.equal(done.error.includes("secret"), false);
});

test("ownership validation is paginated from zero and never uses author display name", async (t) => {
  const f = await fixture(t);
  for (let i = 1; i <= 101; i++) f.existing(String(i));
  const result = await f.service.validatePublishTarget("101");
  assert.deepEqual(result, {
    itemId: "101",
    accountId: "account-A",
    displayName: "Fixture author",
    publicationName: "existing-publication",
  });
  assert.deepEqual(
    f.calls
      .filter((call) => call.method === "POST")
      .map((call) => call.body.page),
    [0, 1],
  );
  f.existing("999", { owner: "other-account", author: "Fixture author" });
  await assert.rejects(
    f.service.validatePublishTarget("999"),
    code("NOT_OWNER"),
  );
});

test("owned-list duplicates and failed results cannot authorize an update", async (t) => {
  const f = await fixture(t);
  f.override = (call) =>
    call.method === "POST" ? { value: { mods: [{ modId: "7" }] } } : null;
  await assert.rejects(
    f.service.validatePublishTarget("7"),
    code("INVALID_RESPONSE"),
  );
  f.override = () => ({ value: { result: "Failure", mods: [{ modId: "7" }] } });
  await assert.rejects(
    f.service.validatePublishTarget("7"),
    code("REQUEST_REJECTED"),
  );
});

test("update requires owned HOI4 metadata and rejects busy or foreign targets", async (t) => {
  for (const [changes, expected] of [
    [{ game: "vic3" }, "WRONG_TARGET"],
    [{ updating: true }, "TARGET_BUSY"],
  ]) {
    const f = await fixture(t);
    f.existing("777", changes);
    await assert.rejects(
      f.service.validatePublishTarget("777"),
      code(expected),
    );
    assert.equal(f.uploads.length, 0);
  }
});

test("update sends publishUpdate metadata and waits for a revision newer than the old published record", async (t) => {
  const f = await fixture(t);
  f.existing();
  let reads = 0,
    submitted = false;
  f.after = (call) => {
    if (call.path === "/mods/publishUpdate") submitted = true;
  };
  f.override = (call) => {
    if (submitted && call.method === "GET" && reads++ === 0)
      return {
        value: {
          modDetail: {
            ...f.publications.get("777"),
            modVersion: "2",
            state: "published",
            updating: false,
          },
        },
      };
  };
  f.service.startPublish({ ...f.input, existingItemId: "777" });
  const done = await f.finish();
  assert.equal(done.status, "succeeded");
  assert.equal(done.baseRevision, "2");
  assert.ok(reads >= 2);
  const post = f.calls.find((call) => call.path === "/mods/publishUpdate");
  assert.equal(post.body.modId, "777");
  assert.equal(post.body.changelogEntry, "A change note");
  assert.equal(post.body.modName, "existing-publication");
});

test("persistent publishing state times out as pending with the confirmed ID", async (t) => {
  const f = await fixture(t);
  f.after = (call) => {
    if (call.path === "/mods/publish")
      f.publications.get("123").updating = true;
  };
  f.service.startPublish(f.input);
  const done = await f.finish();
  assert.equal(done.status, "pending");
  assert.equal(done.itemId, "123");
  assert.equal(done.commitSent, true);
  assert.equal(
    f.calls.filter((call) => call.path === "/mods/publish").length,
    1,
  );
  assert.equal(f.calls.filter((call) => call.method === "GET").length, 3);
});

test("a lost new-publication response is never replayed; read-only recovery matches publicationName", async (t) => {
  const f = await fixture(t);
  f.after = (call) => {
    if (call.path === "/mods/publish") throw failure("TIMEOUT");
  };
  f.service.startPublish(f.input);
  const pending = await f.finish();
  assert.equal(pending.status, "pending");
  assert.equal(pending.itemId, null);
  assert.equal(pending.commitSent, true);
  assert.throws(
    () => f.service.startPublish(f.input),
    code("ALREADY_SUBMITTED"),
  );
  f.after = null;
  const restored = createPdxPublisher(f.config);
  const recovered = await restored.refreshPublish(pending);
  assert.equal(recovered.status, "succeeded");
  assert.equal(recovered.itemId, "123");
  assert.equal(
    f.calls.filter((call) => call.path === "/mods/publish").length,
    1,
  );
  assert.equal(f.uploads.length, 1);
});

test("recovery without a matching owned publication remains pending and never uploads", async (t) => {
  const f = await fixture(t);
  const restored = {
    id: "old-job",
    status: "interrupted",
    accountId: "account-A",
    itemId: null,
    publicationName: "missing-publication",
    commitSent: true,
  };
  const pending = await f.service.refreshPublish(restored);
  assert.equal(pending.status, "pending");
  assert.equal(pending.publicationName, "missing-publication");
  assert.equal(f.uploads.length, 0);
  assert.equal(f.packCount, 0);
  assert.equal(
    f.calls.some((call) => /publish/.test(call.path)),
    false,
  );
});

test("refresh refuses another account or a mismatching publication name", async (t) => {
  const f = await fixture(t);
  f.existing();
  const persisted = {
    id: "old-job",
    status: "pending",
    accountId: "account-B",
    itemId: "777",
    publicationName: "existing-publication",
    commitSent: true,
  };
  await assert.rejects(
    f.service.refreshPublish(persisted),
    code("ACCOUNT_CHANGED"),
  );
  const result = await f.service.refreshPublish({
    ...persisted,
    accountId: "account-A",
    publicationName: "wrong-name",
  });
  assert.equal(result.status, "pending");
  assert.match(result.error, /不一致/);
  assert.equal(f.uploads.length, 0);
});

test("actor changes before execution or before submit prevent publication under a different account", async (t) => {
  const first = await fixture(t);
  first.current = "account-B";
  first.service.startPublish(first.input);
  assert.equal((await first.finish()).status, "failed");
  assert.equal(first.uploads.length, 0);
  const second = await fixture(t);
  second.uploadHook = () => {
    second.current = "account-B";
  };
  second.service.startPublish(second.input);
  const done = await second.finish();
  assert.equal(done.status, "failed");
  assert.equal(
    second.calls.some((call) => call.path === "/mods/publish"),
    false,
  );
  assert.equal(second.cleanupCount, 1);
});

test("pre-submit journal failure prevents POST even after content upload", async (t) => {
  const f = await fixture(t);
  f.eventHook = (event) => {
    if (event.commitSent) throw new Error("journal unavailable");
  };
  f.service.startPublish(f.input);
  const done = await f.finish();
  assert.equal(done.status, "failed");
  assert.equal(done.commitSent, false);
  assert.equal(f.uploads.length, 1);
  assert.equal(
    f.calls.some((call) => call.path === "/mods/publish"),
    false,
  );
});

test("source metadata above 5GiB can be compressed but remains bounded before archive creation", async (t) => {
  const f = await fixture(t);
  const files = [{ ...f.input.files[0], size: 6 * 1024 ** 3 }];
  f.service.startPublish({ ...f.input, files });
  assert.equal((await f.finish()).status, "succeeded");
  assert.equal(f.packInput.files[0].size, 6 * 1024 ** 3);
  assert.equal(f.uploads[0].bytes, (await fs.stat(f.archivePath)).size);
  const tooLarge = [{ ...files[0], size: 200 * 1024 ** 3 + 1 }];
  assert.throws(
    () =>
      f.service.startPublish({ ...f.input, id: "oversized", files: tooLarge }),
    code("SOURCE_TOO_LARGE"),
  );
  assert.equal(f.packCount, 1);
});

test("archive size is strictly below 5GiB and cleanup runs on invalid output", async (t) => {
  const f = await fixture(t);
  f.packHook = () => ({
    path: f.archivePath,
    bytes: 5 * 1024 ** 3,
    sha256: hash("x"),
    cleanup: async () => {
      f.cleanupCount++;
    },
  });
  f.service.startPublish(f.input);
  assert.equal((await f.finish()).status, "failed");
  assert.equal(f.uploads.length, 0);
  assert.equal(f.cleanupCount, 1);
});

test("packing failures locate retained files without exposing raw errors or uploading", async (t) => {
  const f = await fixture(t);
  f.packHook = () => {
    throw Object.assign(new Error("fixture private detail"), {
      retainedPath: f.root,
    });
  };
  f.service.startPublish(f.input);
  const done = await f.finish();
  assert.equal(done.status, "failed");
  assert.match(done.error, /无法为审核内容生成 ZIP/);
  assert.ok(done.error.includes(f.root));
  assert.ok(!done.error.includes("fixture private detail"));
  assert.equal(f.uploads.length, 0);
});

test("retained archive cleanup is reported without changing confirmed remote success", async (t) => {
  const f = await fixture(t);
  f.packHook = () => ({
    path: f.archivePath,
    bytes: 10,
    sha256: hash("archive"),
    cleanup: async () => ({ removed: false, retainedPath: f.root }),
  });
  f.service.startPublish(f.input);
  const done = await f.finish();
  assert.equal(done.status, "succeeded");
  assert.equal(done.itemId, "123");
  assert.ok(done.error.includes(f.root));
  assert.equal(f.events.at(-1).error, done.error);
});

test("thumbnail upload uses the reviewed small file identity and hash", async (t) => {
  const f = await fixture(t),
    imagePath = path.join(f.contentPath, "preview.png"),
    data = Buffer.from("fixture thumbnail");
  await fs.writeFile(imagePath, data);
  const stat = await fs.lstat(imagePath);
  f.input.files.push({
    relative: "preview.png",
    size: data.length,
    hash: hash(data),
    targetIno: stat.ino,
    targetDev: stat.dev,
  });
  f.input.previewPath = imagePath;
  f.service.startPublish(f.input);
  assert.equal((await f.finish()).status, "succeeded");
  assert.equal(f.uploads.length, 2);
  assert.match(f.uploads[1].path, /\/thumbnail\/thumbnail.png$/);
  assert.equal(f.uploads[1].sha256, hash(data));
  assert.equal(
    f.calls.find((call) => call.path === "/mods/publish").body.thumbnail,
    "thumbnail.png",
  );
});

test("a changed thumbnail fails before any upload", async (t) => {
  const f = await fixture(t),
    filename = path.join(f.contentPath, "preview.jpg");
  await fs.writeFile(filename, "old");
  const stat = await fs.lstat(filename);
  f.input.files.push({
    relative: "preview.jpg",
    size: 3,
    hash: hash("old"),
    targetIno: stat.ino,
    targetDev: stat.dev,
  });
  f.input.previewPath = filename;
  await fs.writeFile(filename, "new");
  f.service.startPublish(f.input);
  assert.equal((await f.finish()).status, "failed");
  assert.equal(f.uploads.length, 0);
});

test("PDX thumbnail maxSize is 1,000,000 bytes, not one MiB", async (t) => {
  const f = await fixture(t),
    filename = path.join(f.contentPath, "preview.jpeg"),
    data = Buffer.alloc(1_000_000, 1);
  await fs.writeFile(filename, data);
  const stat = await fs.lstat(filename);
  const reviewed = {
    relative: "preview.jpeg",
    size: data.length,
    hash: hash(data),
    targetIno: stat.ino,
    targetDev: stat.dev,
  };
  f.input.previewPath = filename;
  assert.throws(
    () =>
      f.service.startPublish({
        ...f.input,
        files: [...f.input.files, { ...reviewed, size: 1_000_001 }],
      }),
    code("INVALID_INPUT"),
  );
  f.input.files.push(reviewed);
  f.service.startPublish(f.input);
  assert.equal((await f.finish()).status, "succeeded");
  assert.equal(f.uploads[1].bytes, 1_000_000);
});

test("an HTTP failure after submit keeps the publication pending without replay", async (t) => {
  const f = await fixture(t);
  f.after = (call) => {
    if (call.path === "/mods/publish") throw failure("REQUEST_FAILED");
  };
  f.service.startPublish(f.input);
  const done = await f.finish();
  assert.equal(done.status, "pending");
  assert.equal(done.commitSent, true);
  assert.equal(done.itemId, null);
  const { formatDiagnostic } = await import("../src/i18n-core.mjs");
  const translated = formatDiagnostic("en", done.errorDiagnostic, done.error);
  assert.match(translated, /publishing request has been sent/);
  assert.match(
    translated,
    /publishing request did not complete|publishing request was not completed|publishing request did not finish/,
  );
  assert.doesNotMatch(translated, /[\u3400-\u9fff]|fixture credential/);
  assert.throws(
    () => f.service.startPublish(f.input),
    code("ALREADY_SUBMITTED"),
  );
  assert.equal(
    f.calls.filter((call) => call.path === "/mods/publish").length,
    1,
  );
});

test("temporary metadata errors after accepted submit never imply publication failure", async (t) => {
  for (const errorCode of ["REQUEST_FAILED", "ACCESS_DENIED", "RATE_LIMITED"]) {
    const f = await fixture(t);
    f.before = (call) => {
      if (call.method === "GET") throw failure(errorCode);
    };
    f.service.startPublish(f.input);
    const done = await f.finish();
    assert.equal(done.status, "pending", errorCode);
    assert.equal(done.itemId, "123");
    assert.equal(done.commitSent, true);
    f.before = null;
    assert.equal((await f.service.refreshPublish(done)).status, "succeeded");
    assert.equal(f.uploads.length, 1);
    assert.equal(
      f.calls.filter((call) => call.path === "/mods/publish").length,
      1,
    );
  }
});

test("an explicitly rejected commit preserves its ID and recovery reports remote failure", async (t) => {
  const f = await fixture(t);
  f.after = (call, result) => {
    if (call.path === "/mods/publish") {
      result.state = "rejected";
      f.publications.get("123").state = "rejected";
    }
  };
  f.service.startPublish(f.input);
  const done = await f.finish();
  assert.equal(done.status, "failed");
  assert.equal(done.itemId, "123");
  assert.equal(done.commitSent, true);
  const queried = await f.service.refreshPublish(done);
  assert.equal(queried.status, "failed");
  assert.equal(queried.itemId, "123");
  assert.equal(f.uploads.length, 1);
});

test("dispose interrupts polling promptly and preserves recovery identifiers", async (t) => {
  const f = await fixture(t, { pollIntervalMs: 1000 });
  const reached = deferred();
  f.after = (call) => {
    if (call.path === "/mods/publish")
      f.publications.get("123").updating = true;
    if (call.method === "GET") reached.resolve();
  };
  f.service.startPublish(f.input);
  await reached.promise;
  f.service.dispose();
  const done = await f.finish();
  assert.equal(done.status, "interrupted");
  assert.equal(done.itemId, "123");
  assert.equal(done.commitSent, true);
  assert.equal(f.cleanupCount, 1);
});

test("only one publication can run and caller mutations cannot alter its reviewed fields", async (t) => {
  const f = await fixture(t);
  const original = clone(f.input);
  f.service.startPublish(f.input);
  f.input.title = "Changed afterwards";
  f.input.tags.push("Changed");
  assert.throws(() => f.service.startPublish(original), code("BUSY"));
  await assert.rejects(f.service.refreshPublish({}), code("BUSY"));
  await f.finish();
  assert.equal(
    f.calls.find((call) => call.path === "/mods/publish").body.displayName,
    original.title,
  );
  assert.deepEqual(f.packInput.files, original.files);
});

test("server-declared failed publication is not reported as succeeded", async (t) => {
  const f = await fixture(t);
  f.after = (call) => {
    if (call.path === "/mods/publish")
      f.publications.get("123").state = "rejected";
  };
  f.service.startPublish(f.input);
  const done = await f.finish();
  assert.equal(done.status, "failed");
  assert.equal(done.itemId, "123");
});

test("official character limits are distinct from Steam byte limits", async (t) => {
  const f = await fixture(t);
  for (const changes of [
    { title: "ab" },
    { title: "a".repeat(61) },
    { shortDescription: "short" },
    { shortDescription: "x".repeat(201) },
    { description: "<b></b>" },
    { changeNote: "x".repeat(5001) },
    { tags: Array(11).fill("History") },
    { recommendedVersion: "1234567890123" },
  ])
    assert.throws(
      () => f.service.startPublish({ ...f.input, ...changes }),
      code("INVALID_INPUT"),
    );
  f.service.startPublish({
    ...f.input,
    title: "中".repeat(60),
    description: "中".repeat(9000),
  });
  assert.equal((await f.finish()).status, "succeeded");
});

test("getState is explicit and signed-out does not initialize login", async (t) => {
  const f = await fixture(t);
  f.current = null;
  assert.deepEqual(await f.service.getState(), {
    connected: false,
    accountId: null,
    displayName: null,
  });
  assert.equal(f.calls.length, 0);
  assert.equal(f.uploads.length, 0);
});

test("description limits match official sanitize-html behavior for tags, scripts, and entities", async (t) => {
  const f = await fixture(t);
  for (const changes of [
    {
      description:
        "<script>long hidden script content</script><style>long hidden style content</style>short",
    },
    { shortDescription: "<b>123456789</b>" },
    // sanitize-html keeps the escaped &amp; form: 41 entities are 205 characters.
    { shortDescription: "&amp;".repeat(41) },
    { shortDescription: "<script>1234567890</script>" },
  ])
    assert.throws(
      () => f.service.startPublish({ ...f.input, ...changes }),
      code("INVALID_INPUT"),
    );
  f.service.startPublish({
    ...f.input,
    description:
      "<p>1234567890</p><script>discarded</script><style>discarded</style>",
    shortDescription: "<p>" + "&#38;".repeat(40) + "</p>",
  });
  assert.equal((await f.finish()).status, "succeeded");
  const submitted = f.calls.find((call) => call.path === "/mods/publish").body;
  assert.equal(submitted.shortDescription, "<p>" + "&#38;".repeat(40) + "</p>");
});
