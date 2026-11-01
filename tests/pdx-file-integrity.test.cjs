"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");
const {
  createPdxFileIntegrity,
} = require("../electron/pdx-file-integrity.cjs");

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const identity = (stat) => ({
  ino: stat.ino,
  dev: stat.dev,
  birthtimeMs: stat.birthtimeMs,
});
async function fixture(
  t,
  contents = {
    "descriptor.mod": 'name="Integrity fixture"\n',
    "events/start.txt": "event one\n",
    "common/rules.txt": "rules one\n",
  },
) {
  const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "ironclad-file-integrity-"),
    ),
    storage = path.join(root, "control"),
    contentPath = path.join(root, "content");
  t.after(async () => {
    const resolved = path.resolve(root);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(resolved, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 20,
    });
  });
  await fs.mkdir(contentPath);
  const files = [];
  for (const [relative, bytes] of Object.entries(contents)) {
    const target = path.join(contentPath, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes);
    files.push({
      path: target,
      hash: hash(bytes),
      identity: identity(await fs.lstat(target)),
    });
  }
  const service = createPdxFileIntegrity({ storageDirectory: storage }),
    record = {
      modId: "123",
      revision: "3",
      archiveSha256: hash("verified signed ZIP"),
      contentPath,
      contentIdentity: identity(await fs.lstat(contentPath)),
    };
  const input = () => ({ ...record, files });
  const create = async () => (record.integrity = await service.create(input()));
  const indexPath = () =>
    path.join(storage, "indexes", record.integrity.id + ".json");
  async function replaceIndex(change) {
    const index = JSON.parse(await fs.readFile(indexPath(), "utf8"));
    change(index);
    const bytes = Buffer.from(JSON.stringify(index));
    await fs.writeFile(indexPath(), bytes);
    record.integrity = {
      ...record.integrity,
      sha256: hash(bytes),
      bytes: bytes.length,
    };
  }
  return {
    root,
    storage,
    contentPath,
    files,
    record,
    service,
    input,
    create,
    indexPath,
    replaceIndex,
  };
}

test("construction and missing-reference verification do not create control files", async (t) => {
  const f = await fixture(t);
  await assert.rejects(fs.lstat(f.storage), { code: "ENOENT" });
  const result = await f.service.verify({ record: f.record });
  assert.equal(result.status, "unverified");
  assert.equal(result.baselineReason, "missing-reference");
  assert.equal(result.totalFiles, 0);
  await assert.rejects(fs.lstat(f.storage), { code: "ENOENT" });
});

test("a bound SHA-256 index verifies all files without changing content", async (t) => {
  const f = await fixture(t),
    ref = await f.create(),
    progress = [];
  assert.equal(ref.version, 1);
  assert.equal(f.service.validateReference(ref).id, ref.id);
  const original = await fs.readFile(f.indexPath());
  assert.equal(hash(original), ref.sha256);
  const result = await f.service.verify({
    record: f.record,
    onProgress: (value) => progress.push(value),
  });
  assert.equal(result.status, "intact");
  assert.equal(result.checkedFiles, 3);
  assert.equal(result.totalFiles, 3);
  assert.equal(
    result.missingFiles +
      result.changedFiles +
      result.extraFiles +
      result.unsafeFiles,
    0,
  );
  assert.deepEqual(result.issues, []);
  assert.equal(progress.at(-1).checkedFiles, 3);
  assert.equal(
    await fs.readFile(f.files[0].path, "utf8"),
    'name="Integrity fixture"\n',
  );
  assert.deepEqual(await fs.readFile(f.indexPath()), original);
});

test("equal-size content changes are found by digest, even with restored modification time", async (t) => {
  const f = await fixture(t);
  await f.create();
  const target = path.join(f.contentPath, "events/start.txt"),
    before = await fs.stat(target);
  await fs.writeFile(target, "event two\n");
  await fs.utimes(target, before.atime, before.mtime);
  const result = await f.service.verify({ record: f.record });
  assert.equal(result.status, "damaged");
  assert.equal(result.changedFiles, 1);
  assert.deepEqual(result.issues, [
    { path: "events/start.txt", kind: "changed" },
  ]);
});

test("missing and extra files are counted and remain untouched", async (t) => {
  const f = await fixture(t);
  await f.create();
  await fs.unlink(path.join(f.contentPath, "common/rules.txt"));
  const foreign = path.join(f.contentPath, "custom.txt");
  await fs.writeFile(foreign, "user change");
  const result = await f.service.verify({ record: f.record });
  assert.equal(result.status, "damaged");
  assert.equal(result.missingFiles, 1);
  assert.equal(result.extraFiles, 1);
  assert.equal(result.checkedFiles, 2);
  assert.equal(await fs.readFile(foreign, "utf8"), "user change");
});

test("an entirely missing installation reports each expected file missing", async (t) => {
  const f = await fixture(t);
  await f.create();
  await fs.rename(f.contentPath, path.join(f.root, "preserved"));
  const result = await f.service.verify({ record: f.record });
  assert.equal(result.status, "damaged");
  assert.equal(result.missingFiles, 3);
  assert.equal(result.unsafeFiles, 0);
  assert.equal(result.checkedFiles, 0);
});

test("a replacement content root cannot pass with identical bytes", async (t) => {
  const f = await fixture(t);
  await f.create();
  const saved = path.join(f.root, "preserved");
  await fs.rename(f.contentPath, saved);
  await fs.cp(saved, f.contentPath, { recursive: true });
  const result = await f.service.verify({ record: f.record });
  assert.equal(result.status, "damaged");
  assert.equal(result.unsafeFiles, 1);
  assert.equal(result.checkedFiles, 0);
  assert.deepEqual(result.issues, [{ path: ".", kind: "unsafe" }]);
});

test("a root swapped between its first stat and lineage capture is rejected", async (t) => {
  const f = await fixture(t);
  await f.create();
  const realLstat = fs.lstat;
  let replaced = false;
  t.mock.method(fs, "lstat", async (target, ...args) => {
    const result = await realLstat(target, ...args);
    if (!replaced && target === f.contentPath) {
      replaced = true;
      const saved = path.join(f.root, "preserved");
      await fs.rename(f.contentPath, saved);
      await fs.cp(saved, f.contentPath, { recursive: true });
    }
    return result;
  });
  const result = await f.service.verify({ record: f.record });
  assert.equal(replaced, true);
  assert.equal(result.status, "damaged");
  assert.equal(result.unsafeFiles, 1);
  assert.equal(result.checkedFiles, 0);
});

test("file changes after an early progress callback are caught by final guards", async (t) => {
  const f = await fixture(t);
  await f.create();
  let changed = false;
  const result = await f.service.verify({
    record: f.record,
    onProgress: async (value) => {
      if (!changed && value.checkedFiles) {
        changed = true;
        await fs.writeFile(
          path.join(f.contentPath, "common/rules.txt"),
          "rules two\n",
        );
      }
    },
  });
  assert.equal(changed, true);
  assert.equal(result.status, "damaged");
  assert.ok(result.changedFiles + result.unsafeFiles > 0);
});

test("directory replacement during scanning cannot report intact", async (t) => {
  const f = await fixture(t);
  await f.create();
  let changed = false;
  const result = await f.service.verify({
    record: f.record,
    onProgress: async (value) => {
      if (!changed && value.checkedFiles) {
        changed = true;
        const saved = path.join(f.root, "preserved");
        await fs.rename(f.contentPath, saved);
        await fs.cp(saved, f.contentPath, { recursive: true });
      }
    },
  });
  assert.equal(result.status, "damaged");
  assert.ok(result.unsafeFiles > 0);
});

test("a file modified during a chunked read is rejected", async (t) => {
  const bytes = Buffer.alloc(3 * 1024 * 1024, 7),
    f = await fixture(t, { "large.bin": bytes });
  await f.create();
  const realOpen = fs.open;
  let modified = false;
  t.mock.method(fs, "open", async (...args) => {
    const handle = await realOpen(...args);
    if (args[0] === f.files[0].path) {
      const read = handle.read.bind(handle);
      t.mock.method(handle, "read", async (...readArgs) => {
        const result = await read(...readArgs);
        if (!modified && result.bytesRead) {
          modified = true;
          const writer = await realOpen(args[0], "r+");
          try {
            await writer.write(Buffer.from([8]), 0, 1, 0);
          } finally {
            await writer.close();
          }
        }
        return result;
      });
    }
    return handle;
  });
  const result = await f.service.verify({ record: f.record });
  assert.equal(modified, true);
  assert.equal(result.status, "damaged");
  assert.equal(result.unsafeFiles, 1);
});

test("extra directory junctions are not followed", async (t) => {
  const f = await fixture(t);
  await f.create();
  const external = path.join(f.root, "external");
  await fs.mkdir(external);
  await fs.writeFile(path.join(external, "private.txt"), "never read");
  const link = path.join(f.contentPath, "linked");
  try {
    await fs.symlink(
      external,
      link,
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch (error) {
    if (["EPERM", "EACCES"].includes(error.code)) {
      t.skip("Directory links unavailable");
      return;
    }
    throw error;
  }
  const realOpen = fs.open;
  let externalOpened = false;
  t.mock.method(fs, "open", async (target, ...args) => {
    if (String(target).includes("private.txt")) externalOpened = true;
    return realOpen(target, ...args);
  });
  const result = await f.service.verify({ record: f.record });
  assert.equal(result.status, "damaged");
  assert.equal(result.unsafeFiles, 1);
  assert.equal(result.extraFiles, 0);
  assert.equal(externalOpened, false);
  assert.equal(
    await fs.readFile(path.join(external, "private.txt"), "utf8"),
    "never read",
  );
});

test("hardlinked expected files are unsafe and never hashed", async (t) => {
  const f = await fixture(t);
  await f.create();
  await fs.link(f.files[0].path, path.join(f.root, "external-link"));
  const realOpen = fs.open;
  let linkedFileOpened = false;
  t.mock.method(fs, "open", async (target, ...args) => {
    if (target === f.files[0].path) linkedFileOpened = true;
    return realOpen(target, ...args);
  });
  const result = await f.service.verify({ record: f.record });
  assert.equal(result.status, "damaged");
  assert.equal(result.unsafeFiles, 1);
  assert.equal(linkedFileOpened, false);
});

test("tampered, missing and wrongly bound indexes remain unverified", async (t) => {
  const f = await fixture(t);
  await f.create();
  const original = await fs.readFile(f.indexPath());
  await fs.writeFile(
    f.indexPath(),
    Buffer.concat([original, Buffer.from(" ")]),
  );
  assert.equal(
    (await f.service.verify({ record: f.record })).status,
    "unverified",
  );
  await fs.writeFile(f.indexPath(), original);
  for (const patch of [
    { modId: "999" },
    { revision: "4" },
    { archiveSha256: hash("different ZIP") },
  ])
    assert.equal(
      (await f.service.verify({ record: { ...f.record, ...patch } })).status,
      "unverified",
    );
  await fs.unlink(f.indexPath());
  assert.equal(
    (await f.service.verify({ record: f.record })).status,
    "unverified",
  );
});

test("an index directory junction cannot grant trust to an external file", async (t) => {
  const f = await fixture(t);
  await f.create();
  const indexes = path.join(f.storage, "indexes"),
    external = path.join(f.root, "external-indexes");
  await fs.rename(indexes, external);
  try {
    await fs.symlink(
      external,
      indexes,
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch (error) {
    if (["EPERM", "EACCES"].includes(error.code)) {
      t.skip("Directory links unavailable");
      return;
    }
    throw error;
  }
  let indexOpened = false;
  const realOpen = fs.open;
  t.mock.method(fs, "open", async (target, ...args) => {
    if (String(target).endsWith(".json")) indexOpened = true;
    return realOpen(target, ...args);
  });
  assert.equal(
    (await f.service.verify({ record: f.record })).status,
    "unverified",
  );
  assert.equal(indexOpened, false);
});

test("authenticated indexes cannot exceed the total-byte or file-count budget", async (t) => {
  const f = await fixture(t);
  await f.create();
  const original = JSON.parse(await fs.readFile(f.indexPath(), "utf8"));
  for (const files of [
    Array.from({ length: 6 }, (_, i) => ({
      relative: `file-${i}.bin`,
      bytes: 4 * 1024 ** 3,
      hash: hash("test"),
    })),
    Array(100001).fill(original.files[0]),
  ]) {
    const bytes = Buffer.from(JSON.stringify({ ...original, files }));
    await fs.writeFile(f.indexPath(), bytes);
    f.record.integrity = {
      ...f.record.integrity,
      bytes: bytes.length,
      sha256: hash(bytes),
    };
    const result = await f.service.verify({ record: f.record });
    assert.equal(result.status, "unverified");
    assert.equal(result.checkedFiles, 0);
  }
});

test("reference traversal, extra fields and oversized references are rejected", async (t) => {
  const f = await fixture(t),
    ref = await f.create();
  for (const patch of [
    { id: "../../other" },
    { id: ref.id + "\n" },
    { sha256: "0".repeat(63) },
    { sha256: "0".repeat(64) + "\n" },
    { bytes: 0 },
    { bytes: 64 * 1024 ** 2 + 1 },
    { extra: true },
    JSON.parse('{"__proto__":{}}'),
  ]) {
    const value = { ...ref, ...patch };
    assert.throws(() => f.service.validateReference(value), {
      code: "INTEGRITY_INDEX_INVALID",
    });
    assert.equal(
      (await f.service.verify({ record: { ...f.record, integrity: value } }))
        .status,
      "unverified",
    );
  }
});

for (const relative of [
  "../escape.txt",
  "/absolute.txt",
  "C:/drive.txt",
  "bad:stream",
  "NUL.txt",
  "space .txt.",
  "a//b",
  "a/./b",
  "a\\b",
]) {
  test(`an authenticated but unsafe index path is rejected: ${relative}`, async (t) => {
    const f = await fixture(t);
    await f.create();
    await f.replaceIndex((index) => {
      index.files[0].relative = relative;
    });
    const result = await f.service.verify({ record: f.record });
    assert.equal(result.status, "unverified");
    assert.equal(result.checkedFiles, 0);
  });
}

test("case collisions, file/directory collisions and prototype fields invalidate indexes", async (t) => {
  const f = await fixture(t);
  await f.create();
  const original = JSON.parse(await fs.readFile(f.indexPath(), "utf8"));
  for (const mutate of [
    (index) =>
      index.files.push({
        ...index.files[0],
        relative: index.files[0].relative.toUpperCase(),
      }),
    (index) => index.files.push({ ...index.files[0], relative: "common" }),
    (index) =>
      Object.defineProperty(index.files[0], "__proto__", {
        value: "unsafe",
        enumerable: true,
      }),
    (index) => {
      index.files[0].bytes = 4 * 1024 ** 3 + 1;
    },
  ]) {
    const index = structuredClone(original);
    mutate(index);
    const bytes = Buffer.from(JSON.stringify(index));
    await fs.writeFile(f.indexPath(), bytes);
    f.record.integrity = {
      ...f.record.integrity,
      bytes: bytes.length,
      sha256: hash(bytes),
    };
    assert.equal(
      (await f.service.verify({ record: f.record })).status,
      "unverified",
    );
  }
});

test("creation rejects a changed source and does not trust its current digest", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.files[0].path, "foreign changes");
  await assert.rejects(f.service.create(f.input()), {
    code: "CONTENT_CHANGED",
  });
  await assert.rejects(fs.lstat(f.storage), { code: "ENOENT" });
});

test("creation rejects an out-of-root source and excess source count before reading", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.service.create({
      ...f.input(),
      files: [{ ...f.files[0], path: path.join(f.root, "foreign") }],
    }),
    { code: "INTEGRITY_INDEX_INVALID" },
  );
  await assert.rejects(
    f.service.create({ ...f.input(), files: Array(100001).fill(f.files[0]) }),
    { code: "VALIDATION_LIMIT" },
  );
});

test("numeric identity fields cannot smuggle trailing newlines into an index binding", async (t) => {
  const f = await fixture(t);
  for (const patch of [{ modId: "123\n" }, { revision: "3\n" }])
    await assert.rejects(f.service.create({ ...f.input(), ...patch }), {
      code: "INTEGRITY_INDEX_INVALID",
    });
});

test("an unexpectedly huge directory enumeration stops at the entry budget", async (t) => {
  const f = await fixture(t, { "expected.txt": "known" });
  await f.create();
  const realOpendir = fs.opendir,
    realLstat = fs.lstat,
    stat = await fs.lstat(f.files[0].path);
  let yielded = 0;
  t.mock.method(fs, "opendir", async (directory, ...args) => {
    if (directory !== f.contentPath) return realOpendir(directory, ...args);
    return {
      async *[Symbol.asyncIterator]() {
        for (let i = 0; i < 100002; i++) {
          yielded++;
          yield { name: "unexpected.txt" };
        }
      },
    };
  });
  t.mock.method(fs, "lstat", (target, ...args) =>
    target === path.join(f.contentPath, "unexpected.txt")
      ? Promise.resolve(stat)
      : realLstat(target, ...args),
  );
  await assert.rejects(f.service.verify({ record: f.record }), {
    code: "VALIDATION_LIMIT",
  });
  assert.equal(yielded, 100001);
});

test("cancel before or during validation propagates AbortError", async (t) => {
  const f = await fixture(t);
  await f.create();
  const before = AbortSignal.abort();
  await assert.rejects(f.service.verify({ record: f.record, signal: before }), {
    name: "AbortError",
  });
  await assert.rejects(f.service.create({ ...f.input(), signal: before }), {
    name: "AbortError",
  });
  const controller = new AbortController();
  await assert.rejects(
    f.service.verify({
      record: f.record,
      signal: controller.signal,
      onProgress: () => controller.abort(),
    }),
    { name: "AbortError" },
  );
});

test("issue output is bounded while total extra-file counts remain complete", async (t) => {
  const f = await fixture(t);
  await f.create();
  for (let i = 0; i < 110; i++)
    await fs.writeFile(path.join(f.contentPath, `extra-${i}.txt`), "extra");
  const result = await f.service.verify({ record: f.record });
  assert.equal(result.status, "damaged");
  assert.equal(result.extraFiles, 110);
  assert.equal(result.issues.length, 100);
  assert.equal(result.issuesTruncated, true);
});

test("a trusted extracted source compares an old installation without writing an index", async (t) => {
  const f = await fixture(t),
    installed = path.join(f.root, "legacy");
  await fs.cp(f.contentPath, installed, { recursive: true });
  const record = {
    ...f.record,
    contentPath: installed,
    contentIdentity: identity(await fs.lstat(installed)),
  };
  assert.equal(
    (
      await f.service.compare({
        record,
        contentPath: f.contentPath,
        files: f.files,
      })
    ).status,
    "intact",
  );
  await fs.writeFile(path.join(installed, "events/start.txt"), "event two\n");
  const result = await f.service.compare({
    record,
    contentPath: f.contentPath,
    files: f.files,
  });
  assert.equal(result.status, "damaged");
  assert.equal(result.changedFiles, 1);
  await assert.rejects(fs.lstat(f.storage), { code: "ENOENT" });
});

test("caller mutation during an awaited operation cannot change the expected trusted baseline", async (t) => {
  const f = await fixture(t),
    input = f.input(),
    realOpen = fs.open;
  let changed = false;
  t.mock.method(fs, "open", async (...args) => {
    const handle = await realOpen(...args);
    if (!changed && args[0] === f.files[0].path) {
      changed = true;
      input.files[0].hash = hash("forged");
      input.modId = "999";
    }
    return handle;
  });
  f.record.integrity = await f.service.create(input);
  assert.equal(changed, true);
  assert.equal((await f.service.verify({ record: f.record })).status, "intact");
});
