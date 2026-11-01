"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createHash, randomBytes } = require("node:crypto");
const { deflateRawSync } = require("node:zlib");
const yauzl = require("yauzl");
const {
  createPublishArchiveService,
} = require("../electron/publish-archive.cjs");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ironclad-archive-"));
  t.after(() =>
    fs.rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    }),
  );
  const contentPath = path.join(root, "snapshot"),
    storageDirectory = path.join(root, "archives");
  await fs.mkdir(path.join(contentPath, "events"), { recursive: true });
  await fs.writeFile(
    path.join(contentPath, "descriptor.mod"),
    'name="Sample"\nsupported_version="1.19.*"\n',
  );
  await fs.writeFile(
    path.join(contentPath, "events", "start.txt"),
    "country_event={id=sample.1}\n".repeat(500),
  );
  await fs.writeFile(path.join(contentPath, "empty.txt"), "");
  const filenames = ["descriptor.mod", "events/start.txt", "empty.txt"];
  async function reviewedFiles() {
    const files = [];
    for (const relative of filenames) {
      const filename = path.join(contentPath, relative),
        info = await fs.stat(filename),
        bytes = await fs.readFile(filename);
      files.push({
        relative: relative.split("/").join(path.sep),
        size: info.size,
        hash: hash(bytes),
        targetIno: info.ino,
        targetDev: info.dev,
      });
    }
    return files;
  }
  const files = await reviewedFiles();
  return {
    root,
    contentPath,
    storageDirectory,
    files,
    filenames,
    reviewedFiles,
    service: createPublishArchiveService({ storageDirectory, ...options }),
    input: { contentPath, files },
  };
}
async function readArchive(file) {
  const zip = await yauzl.openPromise(file, {
      autoClose: false,
      lazyEntries: true,
    }),
    result = [];
  try {
    for await (const entry of zip.eachEntry()) {
      const chunks = [];
      for await (const chunk of await zip.openReadStreamPromise(entry))
        chunks.push(chunk);
      const compressed = [];
      for await (const chunk of await zip.openReadStreamPromise(entry, {
        decompress: false,
      }))
        compressed.push(chunk);
      result.push({
        name: entry.fileName,
        bytes: Buffer.concat(chunks),
        compressed: Buffer.concat(compressed),
        method: entry.compressionMethod,
      });
    }
  } finally {
    await new Promise((resolve) => {
      zip.once("close", resolve);
      zip.close();
    });
  }
  return result;
}
async function noArtifacts(f) {
  try {
    assert.deepEqual(await fs.readdir(f.storageDirectory), []);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

test(
  "ZIP contains exactly reviewed root files, roundtrips metadata and uses deflate level one",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t),
      progress = [],
      result = await f.service.createArchive({
        ...f.input,
        onProgress: (state) => progress.push(state),
      });
    assert.ok(result.path.startsWith(f.storageDirectory + path.sep));
    const zip = await fs.readFile(result.path);
    assert.equal(result.bytes, zip.length);
    assert.equal(result.sha256, hash(zip));
    const entries = await readArchive(result.path);
    assert.deepEqual(
      entries.map((entry) => entry.name),
      f.filenames,
    );
    for (const entry of entries) {
      const bytes = await fs.readFile(path.join(f.contentPath, entry.name));
      assert.deepEqual(entry.bytes, bytes);
      assert.equal(entry.method, 8);
      assert.deepEqual(entry.compressed, deflateRawSync(bytes, { level: 1 }));
    }
    assert.ok(
      progress.some(
        (state) => state.stage === "verifying" && state.filesDone === 3,
      ),
    );
    assert.deepEqual(await result.cleanup(), {
      removed: true,
      retainedPath: null,
    });
    assert.deepEqual(await result.cleanup(), {
      removed: true,
      retainedPath: null,
    });
    await noArtifacts(f);
  },
);

test(
  "digest mismatch and same-size edited files cannot yield an archive",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    await assert.rejects(
      f.service.createArchive({
        ...f.input,
        files: f.files.map((file, index) =>
          index ? file : { ...file, hash: "0".repeat(64) },
        ),
      }),
      /摘要/,
    );
    const target = path.join(f.contentPath, "descriptor.mod"),
      bytes = await fs.readFile(target);
    bytes[0] = 35;
    await fs.writeFile(target, bytes);
    await assert.rejects(f.service.createArchive(f.input), /摘要/);
    await noArtifacts(f);
  },
);

test("a same-content replacement with a different inode is rejected", async (t) => {
  const f = await fixture(t),
    target = path.join(f.contentPath, "descriptor.mod"),
    replacement = path.join(f.root, "replacement.mod");
  await fs.writeFile(replacement, await fs.readFile(target));
  await fs.unlink(target);
  await fs.rename(replacement, target);
  await assert.rejects(f.service.createArchive(f.input), /替换|修改/);
  await noArtifacts(f);
});

test(
  "lazy reads recheck a later file after an earlier entry has started",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    let changed = false;
    await assert.rejects(
      f.service.createArchive({
        ...f.input,
        onProgress: async (state) => {
          if (state.stage !== "archiving" || changed) return;
          const filename = path.join(f.contentPath, "events", "start.txt"),
            replacement = path.join(f.root, "replace.txt");
          await fs.writeFile(replacement, await fs.readFile(filename));
          await fs.unlink(filename);
          await fs.rename(replacement, filename);
          changed = true;
        },
      }),
      /懒读取|替换|修改/,
    );
    assert.equal(changed, true);
    await noArtifacts(f);
  },
);

test(
  "file mutation during its streamed read rejects the bytes being archived",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t),
      target = path.join(f.contentPath, "events", "start.txt");
    await fs.writeFile(target, randomBytes(2 * 1024 * 1024));
    const files = await f.reviewedFiles();
    let changed = false;
    await assert.rejects(
      f.service.createArchive({
        contentPath: f.contentPath,
        files,
        onProgress: async (state) => {
          if (
            !changed &&
            state.stage === "archiving" &&
            state.processedBytes > files[0].size
          ) {
            const handle = await fs.open(target, "r+");
            try {
              await handle.write(Buffer.from("changed"), 0, 7, 1024 * 1024);
            } finally {
              await handle.close();
            }
            changed = true;
          }
        },
      }),
      /摘要|身份|变化/,
    );
    assert.equal(changed, true);
    await noArtifacts(f);
  },
);

test(
  "a root junction replacement between validation and opening a file is rejected",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t),
      originalOpen = fs.open,
      target = path.join(f.contentPath, "descriptor.mod");
    let changed = false;
    const hook = t.mock.method(fs, "open", async (filename, flags, ...args) => {
      if (!changed && filename === target && flags === "r") {
        changed = true;
        const displaced = path.join(f.root, "displaced");
        await fs.rename(f.contentPath, displaced);
        await fs.symlink(displaced, f.contentPath, "junction");
      }
      return originalOpen(filename, flags, ...args);
    });
    try {
      await assert.rejects(f.service.createArchive(f.input), /链接|联接|替换/);
    } finally {
      hook.mock.restore();
    }
    assert.equal(changed, true);
    await noArtifacts(f);
  },
);

test("replacing the root after reading still prevents delivery", async (t) => {
  const f = await fixture(t);
  let changed = false;
  await assert.rejects(
    f.service.createArchive({
      ...f.input,
      onProgress: async (state) => {
        if (state.stage !== "verifying") return;
        await fs.rename(f.contentPath, path.join(f.root, "displaced"));
        await fs.mkdir(f.contentPath);
        changed = true;
      },
    }),
    /根目录|替换/,
  );
  assert.equal(changed, true);
  await noArtifacts(f);
});

test("snapshot links and hardlinks are refused", async (t) => {
  const f = await fixture(t),
    external = path.join(f.root, "external");
  await fs.mkdir(external);
  await fs.writeFile(path.join(external, "private.txt"), "private");
  await fs.symlink(external, path.join(f.contentPath, "linked"), "junction");
  await assert.rejects(f.service.createArchive(f.input), /链接|联接/);
  await fs.unlink(path.join(f.contentPath, "linked"));
  const target = path.join(f.contentPath, "descriptor.mod");
  await fs.link(target, path.join(f.root, "outside-hardlink"));
  await assert.rejects(f.service.createArchive(f.input), /修改|替换|额外/);
  await noArtifacts(f);
});

test("extra files, including ignored names, are rejected instead of silently packed", async (t) => {
  for (const relative of [
    "extra.txt",
    ".git/config",
    "file.ironclad-backup-foreign",
  ]) {
    const f = await fixture(t),
      extra = path.join(f.contentPath, relative);
    await fs.mkdir(path.dirname(extra), { recursive: true });
    await fs.writeFile(extra, "not reviewed");
    await assert.rejects(f.service.createArchive(f.input), /额外|修改/);
    await noArtifacts(f);
  }
});

test("an extra file arriving after streaming invalidates the archive", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.service.createArchive({
      ...f.input,
      onProgress: async (state) => {
        if (state.stage === "verifying")
          await fs.writeFile(
            path.join(f.contentPath, "new.ironclad-backup-file"),
            "not reviewed",
          );
      },
    }),
    /额外|修改/,
  );
  await noArtifacts(f);
  assert.equal(
    await fs.readFile(
      path.join(f.contentPath, "new.ironclad-backup-file"),
      "utf8",
    ),
    "not reviewed",
  );
});

test("unreviewed empty directories, including ignored VCS folders, are refused", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.contentPath, ".git"));
  await assert.rejects(f.service.createArchive(f.input), /额外目录/);
  await noArtifacts(f);
});

test("unsafe names, collisions, missing descriptors and source budgets fail before writing", async (t) => {
  const f = await fixture(t),
    first = f.files[0];
  for (const relative of [
    "../outside",
    "C:/absolute",
    "//server/file",
    "a:stream",
    "CON.txt",
    "dir/NUL",
    "trailing./x",
    "a//b",
    "a/../b",
  ])
    await assert.rejects(
      f.service.createArchive({
        ...f.input,
        files: [first, { ...first, relative }],
      }),
    );
  for (const files of [
    [...f.files, { ...first, relative: "DESCRIPTOR.MOD" }],
    f.files.slice(1),
    Array(100001).fill(first),
    [{ ...first, size: 200 * 1024 ** 3 + 1 }],
  ])
    await assert.rejects(f.service.createArchive({ ...f.input, files }));
  await noArtifacts(f);
});

test(
  "already cancelled or streaming cancellation leaves the snapshot unchanged",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t),
      before = await f.reviewedFiles(),
      early = new AbortController();
    early.abort();
    await assert.rejects(
      f.service.createArchive({ ...f.input, signal: early.signal }),
      { name: "AbortError" },
    );
    const controller = new AbortController();
    await assert.rejects(
      f.service.createArchive({
        ...f.input,
        signal: controller.signal,
        onProgress: () => controller.abort(),
      }),
      { name: "AbortError" },
    );
    assert.deepEqual(await f.reviewedFiles(), before);
    await noArtifacts(f);
  },
);

test(
  "archive size is strictly below the cap, including the ZIP footer",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t),
      first = await f.service.createArchive(f.input),
      limit = first.bytes;
    await first.cleanup();
    const exact = createPublishArchiveService({
      storageDirectory: f.storageDirectory,
      maxArchiveBytes: limit,
    });
    await assert.rejects(exact.createArchive(f.input), /严格小于/);
    await noArtifacts(f);
    const allowed = await createPublishArchiveService({
      storageDirectory: f.storageDirectory,
      maxArchiveBytes: limit + 1,
    }).createArchive(f.input);
    assert.equal(allowed.bytes, limit);
    await allowed.cleanup();
    assert.throws(
      () =>
        createPublishArchiveService({
          storageDirectory: f.storageDirectory,
          maxArchiveBytes: 5 * 1024 ** 3 + 1,
        }),
      /5 GiB/,
    );
  },
);

test("cleanup preserves a same-content foreign replacement and reports its directory", async (t) => {
  const f = await fixture(t),
    result = await f.service.createArchive(f.input),
    bytes = await fs.readFile(result.path),
    replacement = path.join(f.root, "replacement.zip");
  await fs.writeFile(replacement, bytes);
  await fs.unlink(result.path);
  await fs.rename(replacement, result.path);
  assert.deepEqual(await result.cleanup(), {
    removed: false,
    retainedPath: path.dirname(result.path),
  });
  assert.deepEqual(await fs.readFile(result.path), bytes);
});

test("cleanup removes only the owned ZIP and retains foreign neighboring files", async (t) => {
  const f = await fixture(t),
    result = await f.service.createArchive(f.input),
    foreign = path.join(path.dirname(result.path), "foreign.txt");
  await fs.writeFile(foreign, "keep");
  assert.deepEqual(await result.cleanup(), {
    removed: false,
    retainedPath: path.dirname(result.path),
  });
  assert.equal(await fs.readFile(foreign, "utf8"), "keep");
  await assert.rejects(fs.stat(result.path), { code: "ENOENT" });
});

test("cleanup refuses a replaced private directory and cannot follow it outside storage", async (t) => {
  const f = await fixture(t),
    result = await f.service.createArchive(f.input),
    directory = path.dirname(result.path),
    outside = path.join(f.root, "foreign");
  await fs.mkdir(outside);
  await fs.writeFile(
    path.join(outside, "content.zip"),
    await fs.readFile(result.path),
  );
  await fs.rename(directory, path.join(f.root, "displaced-archive"));
  await fs.symlink(outside, directory, "junction");
  assert.deepEqual(await result.cleanup(), {
    removed: false,
    retainedPath: directory,
  });
  assert.ok(await fs.stat(path.join(outside, "content.zip")));
});

test("a changed completed ZIP is never returned for upload and a retained artifact is located", async (t) => {
  const f = await fixture(t);
  let changed;
  await assert.rejects(
    f.service.createArchive({
      ...f.input,
      onProgress: async (state) => {
        if (state.stage !== "verifying") return;
        const [folder] = await fs.readdir(f.storageDirectory);
        changed = path.join(f.storageDirectory, folder, "content.zip");
        await fs.appendFile(changed, "foreign addition");
      },
    }),
    (error) =>
      /ZIP|摘要/.test(error.message) &&
      error.retainedPath === path.dirname(changed),
  );
  assert.ok((await fs.readFile(changed, "utf8")).endsWith("foreign addition"));
});
