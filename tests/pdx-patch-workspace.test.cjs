"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");
const {
  createPdxPatchWorkspace,
} = require("../electron/pdx-patch-workspace.cjs");

const MIB = 1024 ** 2;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const expected = (bytes) => ({ bytes: bytes.length, sha256: hash(bytes) });
const code = (value) => (error) => {
  assert.equal(error.code, value);
  assert.equal(error.message, "增量补丁暂存操作未完成。");
  assert.equal(error.cause, undefined);
  assert.equal(Object.hasOwn(error, "path"), false);
  return true;
};
const identity = (stat) => ({
  ino: stat.ino,
  dev: stat.dev,
  birthtimeMs: stat.birthtimeMs,
  size: stat.size,
  mtimeMs: stat.mtimeMs,
  ctimeMs: stat.ctimeMs,
});
async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "ironclad-patch-workspace-"),
    ),
    directory = path.join(root, "staging"),
    patchPath = path.join(directory, "patch.zip"),
    scratchPath = path.join(directory, "patch-data.bin"),
    targetPath = path.join(directory, "content.zip");
  await fs.mkdir(directory);
  const workspaces = [];
  t.after(async () => {
    await Promise.allSettled(workspaces.map((workspace) => workspace.close()));
    const resolved = path.resolve(root);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(resolved, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 30,
    });
  });
  const make = async (changes = {}) => {
    const workspace = await createPdxPatchWorkspace({
      directory,
      ...options,
      ...changes,
    });
    workspaces.push(workspace);
    return workspace;
  };
  return {
    root,
    directory,
    patchPath,
    scratchPath,
    targetPath,
    make,
    workspace: await make(),
  };
}
function watchOpen(t, target, action) {
  const open = fs.open;
  t.mock.method(fs, "open", async function (file, ...args) {
    const handle = await open.call(this, file, ...args);
    if (file === target) {
      try {
        await action(handle);
      } catch (error) {
        await handle.close().catch(() => {});
        throw error;
      }
    }
    return handle;
  });
}
async function replaceDirectory(t, directory, saved) {
  try {
    await fs.rename(directory, saved);
    await fs.mkdir(directory);
    return true;
  } catch (error) {
    // Open files prevent directory renames on Windows. Also exercise the
    // changed-ancestor stat that a successful POSIX replacement exposes.
    if (process.platform !== "win32" || error.code !== "EPERM") throw error;
    const lstat = fs.lstat;
    t.mock.method(fs, "lstat", async function (file, ...args) {
      const stat = await lstat.call(this, file, ...args);
      if (file !== directory) return stat;
      return new Proxy(stat, {
        get(target, key) {
          if (key === "ino")
            return target.ino + (typeof target.ino === "bigint" ? 1n : 1);
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    });
    return false;
  }
}

test("workspace construction is inert, frozen and exposes only fixed file operations", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(Object.keys(f.workspace).sort(), [
    "close",
    "createScratch",
    "createTarget",
    "openPatch",
    "proofs",
  ]);
  assert.ok(Object.isFrozen(f.workspace));
  assert.equal(JSON.stringify(f.workspace), "{}");
  assert.deepEqual(await fs.readdir(f.directory), []);
  await f.workspace.close();
  await f.workspace.close();
  assert.deepEqual(await fs.readdir(f.directory), []);
});

test("only existing absolute directories without linked ancestors are accepted", async (t) => {
  const f = await fixture(t);
  for (const input of [
    null,
    {},
    { directory: "relative" },
    { directory: f.directory, signal: {} },
  ])
    await assert.rejects(
      createPdxPatchWorkspace(input),
      code("PATCH_INVALID_INPUT"),
    );
  const missing = path.join(f.root, "missing");
  await assert.rejects(
    createPdxPatchWorkspace({ directory: missing }),
    code("PATCH_CHANGED"),
  );
  await assert.rejects(fs.lstat(missing), { code: "ENOENT" });
  const linked = path.join(f.root, "linked");
  await fs.symlink(
    f.directory,
    linked,
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(
    createPdxPatchWorkspace({ directory: linked }),
    code("PATCH_CHANGED"),
  );
});

test("patch is fully verified before returning an exact bounded random reader", async (t) => {
  const f = await fixture(t),
    bytes = Buffer.from(Array.from({ length: 170007 }, (_, i) => i % 251));
  await fs.writeFile(f.patchPath, bytes);
  const patch = await f.workspace.openPatch(expected(bytes));
  assert.ok(Object.isFrozen(patch));
  assert.deepEqual(Object.keys(patch).sort(), ["bytes", "read", "sha256"]);
  assert.deepEqual(JSON.parse(JSON.stringify(patch)), expected(bytes));
  for (const [start, length] of [
    [0, bytes.length],
    [65537, 70001],
    [bytes.length, 0],
    [5, 0],
  ])
    assert.deepEqual(
      await patch.read(start, length),
      bytes.subarray(start, start + length),
    );
  await assert.rejects(
    f.workspace.openPatch(expected(bytes)),
    code("PATCH_STATE"),
  );
  await f.workspace.close();
  assert.deepEqual(await fs.readFile(f.patchPath), bytes);
});

test("incorrect patch hashes are rejected and their complete files are retained", async (t) => {
  const f = await fixture(t),
    bytes = Buffer.from("signed patch bytes");
  await fs.writeFile(f.patchPath, bytes);
  await assert.rejects(
    f.workspace.openPatch({ ...expected(bytes), sha256: "00".repeat(32) }),
    code("PATCH_HASH_MISMATCH"),
  );
  await assert.rejects(
    f.workspace.openPatch(expected(bytes)),
    code("PATCH_STATE"),
  );
  await f.workspace.close();
  assert.deepEqual(await fs.readFile(f.patchPath), bytes);
});

test("patch size changes and external hardlinks are rejected before content opens", async (t) => {
  const f = await fixture(t),
    bytes = Buffer.from("patch bytes");
  await fs.writeFile(f.patchPath, bytes);
  watchOpen(t, f.patchPath, async () =>
    assert.fail("Unsafe patch content must not be opened"),
  );
  await assert.rejects(
    f.workspace.openPatch({ ...expected(bytes), bytes: bytes.length + 1 }),
    code("PATCH_CHANGED"),
  );
  const second = await f.make();
  await fs.link(f.patchPath, path.join(f.root, "outside.zip"));
  await assert.rejects(
    second.openPatch(expected(bytes)),
    code("PATCH_CHANGED"),
  );
});

test("a patch replaced while opening is rejected before any read", async (t) => {
  const f = await fixture(t),
    bytes = Buffer.from("patch bytes"),
    saved = path.join(f.root, "saved.zip");
  await fs.writeFile(f.patchPath, bytes);
  let read = false;
  watchOpen(t, f.patchPath, async (handle) => {
    t.mock.method(handle, "read", async () => {
      read = true;
      assert.fail("Replacement must not be read");
    });
    await fs.rename(f.patchPath, saved);
    await fs.writeFile(f.patchPath, bytes);
  });
  await assert.rejects(
    f.workspace.openPatch(expected(bytes)),
    code("PATCH_CHANGED"),
  );
  assert.equal(read, false);
  assert.deepEqual(await fs.readFile(saved), bytes);
});

test("equal-size patch mutations invalidate every later read", async (t) => {
  const f = await fixture(t),
    bytes = Buffer.from("patch bytes");
  await fs.writeFile(f.patchPath, bytes);
  const patch = await f.workspace.openPatch(expected(bytes)),
    stat = await fs.stat(f.patchPath);
  await fs.writeFile(f.patchPath, Buffer.alloc(bytes.length, 0x51));
  await fs.utimes(f.patchPath, stat.atime, stat.mtime);
  await assert.rejects(patch.read(0, 1), code("PATCH_CHANGED"));
  await assert.rejects(patch.read(0, 1), code("PATCH_STATE"));
});

test("scratch writes append exactly and allow repeated VCDIFF-style random reads", async (t) => {
  const f = await fixture(t),
    scratch = await f.workspace.createScratch(),
    bytes = Buffer.alloc(140003, 0x50);
  assert.ok(Object.isFrozen(scratch));
  assert.deepEqual(Object.keys(scratch).sort(), ["read", "write"]);
  await scratch.write(bytes.subarray(0, 70001));
  assert.deepEqual(
    await scratch.read(65535, 4466),
    bytes.subarray(65535, 70001),
  );
  await scratch.write(bytes.subarray(70001));
  assert.deepEqual(await scratch.read(1, bytes.length - 1), bytes.subarray(1));
  assert.deepEqual(await scratch.read(0, bytes.length), bytes);
  await f.workspace.close();
  assert.deepEqual(await fs.readFile(f.scratchPath), bytes);
});

test("target finish syncs and re-reads bytes, returning the exact numeric staging identity", async (t) => {
  const f = await fixture(t),
    bytes = Buffer.alloc(180007, 0x50),
    target = await f.workspace.createTarget(expected(bytes));
  assert.deepEqual(Object.keys(target).sort(), ["finish", "read", "write"]);
  await target.write(bytes.subarray(0, 65537));
  assert.deepEqual(await target.read(100, 65437), bytes.subarray(100, 65537));
  await target.write(bytes.subarray(65537));
  const result = await target.finish();
  assert.deepEqual(result, identity(await fs.lstat(f.targetPath)));
  assert.ok(Object.values(result).every((value) => typeof value === "number"));
  assert.deepEqual(await target.finish(), result);
  assert.deepEqual(await target.read(0, bytes.length), bytes);
  await f.workspace.close();
  assert.deepEqual(await fs.readFile(f.targetPath), bytes);
});

test("empty writes and exact endpoint zero reads remain valid", async (t) => {
  const f = await fixture(t),
    scratch = await f.workspace.createScratch();
  await scratch.write(Buffer.alloc(0));
  assert.deepEqual(await scratch.read(0, 0), Buffer.alloc(0));
  await scratch.write(Buffer.from("x"));
  assert.deepEqual(await scratch.read(1, 0), Buffer.alloc(0));
});

test("incomplete targets fail finish permanently without removing their partial data", async (t) => {
  const f = await fixture(t),
    bytes = Buffer.from("complete"),
    target = await f.workspace.createTarget(expected(bytes));
  await target.write(bytes.subarray(0, 3));
  await assert.rejects(target.finish(), code("PATCH_SIZE_MISMATCH"));
  await assert.rejects(target.write(bytes.subarray(3)), code("PATCH_STATE"));
  await assert.rejects(target.read(0, 1), code("PATCH_STATE"));
  await f.workspace.close();
  assert.deepEqual(await fs.readFile(f.targetPath), bytes.subarray(0, 3));
});

test("same-size wrong target content fails its final expected hash", async (t) => {
  const f = await fixture(t),
    bytes = Buffer.from("complete"),
    target = await f.workspace.createTarget(expected(bytes));
  await target.write(Buffer.alloc(bytes.length, 0x51));
  await assert.rejects(target.finish(), code("PATCH_HASH_MISMATCH"));
  await assert.rejects(target.finish(), code("PATCH_STATE"));
  assert.deepEqual(
    await fs.readFile(f.targetPath),
    Buffer.alloc(bytes.length, 0x51),
  );
});

test("target overflow is rejected before any append and poisons the writer", async (t) => {
  const f = await fixture(t),
    target = await f.workspace.createTarget(expected(Buffer.from("x")));
  await assert.rejects(
    target.write(Buffer.from("too long")),
    code("PATCH_RESOURCE_LIMIT"),
  );
  assert.equal((await fs.lstat(f.targetPath)).size, 0);
  await assert.rejects(target.write(Buffer.from("x")), code("PATCH_STATE"));
});

test("invalid metadata and five-GiB bounds fail before opening any fixed file", async (t) => {
  const f = await fixture(t);
  for (const input of [
    null,
    {},
    { bytes: 0, sha256: "ff".repeat(32) },
    { bytes: 5 * 1024 ** 3 + 1, sha256: "ff".repeat(32) },
    { bytes: 1.5, sha256: "ff".repeat(32) },
    { bytes: 1, sha256: "FF".repeat(32) },
    { bytes: 1, sha256: "ff".repeat(32) + "\n" },
  ]) {
    await assert.rejects(
      f.workspace.openPatch(input),
      code("PATCH_INVALID_INPUT"),
    );
    await assert.rejects(
      f.workspace.createTarget(input),
      code("PATCH_INVALID_INPUT"),
    );
  }
  assert.deepEqual(await fs.readdir(f.directory), []);
});

test("read range failures are bounded and make that reader unusable", async (t) => {
  for (const [offset, length] of [
    [-1, 1],
    [0, -1],
    [0.5, 1],
    [NaN, 1],
    [0, 8 * MIB + 1],
    [2, 1],
  ]) {
    const f = await fixture(t),
      scratch = await f.workspace.createScratch();
    await scratch.write(Buffer.from("xy"));
    await assert.rejects(
      scratch.read(offset, length),
      code("PATCH_INVALID_INPUT"),
    );
    await assert.rejects(scratch.read(0, 1), code("PATCH_STATE"));
  }
});

test("writes snapshot caller buffers before yielding and preserve queued append order", async (t) => {
  const f = await fixture(t),
    scratch = await f.workspace.createScratch(),
    bytes = Buffer.alloc(140003, 0x50);
  const first = scratch.write(bytes),
    second = scratch.write(Buffer.from("tail"));
  bytes.fill(0x51);
  await Promise.all([first, second]);
  assert.deepEqual(await scratch.read(0, 140003), Buffer.alloc(140003, 0x50));
  assert.equal((await scratch.read(140003, 4)).toString(), "tail");
});

test("short filesystem reads and writes still preserve exact bytes and finish identity", async (t) => {
  const f = await fixture(t),
    bytes = Buffer.alloc(10009, 0x50);
  watchOpen(t, f.targetPath, async (handle) => {
    const write = handle.write.bind(handle),
      read = handle.read.bind(handle);
    t.mock.method(handle, "write", (buffer, offset, length, position) =>
      write(buffer, offset, Math.min(127, length), position),
    );
    t.mock.method(handle, "read", (buffer, offset, length, position) =>
      read(buffer, offset, Math.min(1021, length), position),
    );
  });
  const target = await f.workspace.createTarget(expected(bytes));
  await target.write(bytes);
  assert.deepEqual(await target.read(0, bytes.length), bytes);
  assert.deepEqual(
    await target.finish(),
    identity(await fs.lstat(f.targetPath)),
  );
});

test("zero progress filesystem writes fail without allowing reuse or deleting the file", async (t) => {
  const f = await fixture(t);
  watchOpen(t, f.scratchPath, async (handle) => {
    t.mock.method(handle, "write", async () => ({ bytesWritten: 0 }));
  });
  const scratch = await f.workspace.createScratch();
  await assert.rejects(scratch.write(Buffer.from("x")), code("PATCH_IO"));
  await assert.rejects(scratch.write(Buffer.from("x")), code("PATCH_STATE"));
  await f.workspace.close();
  assert.equal((await fs.lstat(f.scratchPath)).size, 0);
});

test("existing target and scratch files are never opened, overwritten or deleted", async (t) => {
  const f = await fixture(t),
    foreign = Buffer.from("unknown player-independent fixture");
  await fs.writeFile(f.targetPath, foreign);
  await fs.writeFile(f.scratchPath, foreign);
  await assert.rejects(
    f.workspace.createTarget(expected(foreign)),
    code("PATCH_EXISTS"),
  );
  await assert.rejects(f.workspace.createScratch(), code("PATCH_EXISTS"));
  await f.workspace.close();
  assert.deepEqual(await fs.readFile(f.targetPath), foreign);
  assert.deepEqual(await fs.readFile(f.scratchPath), foreign);
});

test("a path replacement invalidates target IO and both files survive close", async (t) => {
  const f = await fixture(t),
    bytes = Buffer.from("target bytes"),
    target = await f.workspace.createTarget(expected(bytes)),
    saved = path.join(f.root, "saved-content.zip");
  await target.write(bytes);
  await fs.rename(f.targetPath, saved);
  await fs.writeFile(f.targetPath, bytes);
  await assert.rejects(target.finish(), code("PATCH_CHANGED"));
  await f.workspace.close();
  assert.deepEqual(await fs.readFile(saved), bytes);
  assert.deepEqual(await fs.readFile(f.targetPath), bytes);
});

test("external hardlinks added after creation prevent scratch and target reads", async (t) => {
  const f = await fixture(t),
    scratch = await f.workspace.createScratch();
  await scratch.write(Buffer.from("contents"));
  await fs.link(f.scratchPath, path.join(f.root, "outside.bin"));
  await assert.rejects(scratch.read(0, 1), code("PATCH_CHANGED"));
  await assert.rejects(scratch.write(Buffer.from("x")), code("PATCH_STATE"));
});

test("same-size corruption after normal writes is rejected before returning bytes", async (t) => {
  const f = await fixture(t),
    scratch = await f.workspace.createScratch(),
    bytes = Buffer.from("contents");
  await scratch.write(bytes);
  const stat = await fs.stat(f.scratchPath);
  await fs.writeFile(f.scratchPath, Buffer.alloc(bytes.length, 0x51));
  await fs.utimes(f.scratchPath, stat.atime, stat.mtime);
  await assert.rejects(scratch.read(0, 1), code("PATCH_CHANGED"));
});

test("corruption during the writer's own stat refresh cannot become a trusted scratch prefix", async (t) => {
  const f = await fixture(t),
    bytes = Buffer.from("contents");
  watchOpen(t, f.scratchPath, async (handle) => {
    const write = handle.write.bind(handle);
    t.mock.method(handle, "write", async (...args) => {
      const result = await write(...args);
      await fs.writeFile(
        f.scratchPath,
        Buffer.alloc(result.bytesWritten, 0x51),
      );
      return result;
    });
  });
  const scratch = await f.workspace.createScratch();
  await scratch.write(bytes);
  await assert.rejects(scratch.read(0, bytes.length), code("PATCH_CHANGED"));
  await assert.rejects(scratch.read(0, 1), code("PATCH_STATE"));
});

test("mutation during target fsync or disk re-read cannot finish successfully", async (t) => {
  const f = await fixture(t),
    bytes = Buffer.from("contents");
  watchOpen(t, f.targetPath, async (handle) => {
    const sync = handle.sync.bind(handle);
    t.mock.method(handle, "sync", async () => {
      await sync();
      await fs.writeFile(f.targetPath, Buffer.alloc(bytes.length, 0x51));
    });
  });
  const target = await f.workspace.createTarget(expected(bytes));
  await target.write(bytes);
  await assert.rejects(target.finish(), code("PATCH_CHANGED"));
  assert.deepEqual(
    await fs.readFile(f.targetPath),
    Buffer.alloc(bytes.length, 0x51),
  );
});

test("replacing the captured directory invalidates IO without cleaning any moved data", async (t) => {
  const f = await fixture(t),
    scratch = await f.workspace.createScratch(),
    saved = path.join(f.root, "preserved-staging");
  await scratch.write(Buffer.from("preserve"));
  const moved = await replaceDirectory(t, f.directory, saved);
  await assert.rejects(scratch.read(0, 1), code("PATCH_CHANGED"));
  await assert.rejects(
    f.workspace.createTarget(expected(Buffer.from("x"))),
    code("PATCH_CHANGED"),
  );
  await f.workspace.close();
  assert.equal(
    await fs.readFile(
      path.join(moved ? saved : f.directory, "patch-data.bin"),
      "utf8",
    ),
    "preserve",
  );
});

test("pre-cancellation creates no files and cancellation during patch hashing closes its handle", async (t) => {
  const f = await fixture(t),
    controller = new AbortController();
  controller.abort();
  await assert.rejects(
    createPdxPatchWorkspace({
      directory: f.directory,
      signal: controller.signal,
    }),
    code("CANCELLED"),
  );
  assert.deepEqual(await fs.readdir(f.directory), []);
  const active = new AbortController(),
    workspace = await f.make({ signal: active.signal }),
    bytes = Buffer.alloc(140003, 0x50);
  await fs.writeFile(f.patchPath, bytes);
  let opened;
  watchOpen(t, f.patchPath, async (handle) => {
    opened = handle;
    const read = handle.read.bind(handle);
    t.mock.method(handle, "read", async (...args) => {
      const result = await read(...args);
      active.abort();
      return result;
    });
  });
  await assert.rejects(workspace.openPatch(expected(bytes)), code("CANCELLED"));
  await assert.rejects(opened.stat(), { code: "EBADF" });
  await workspace.close();
  assert.deepEqual(await fs.readFile(f.patchPath), bytes);
});

test("cancelling a multi-block write preserves the partial file and close still releases handles", async (t) => {
  const f = await fixture(t),
    controller = new AbortController(),
    workspace = await f.make({ signal: controller.signal });
  let opened;
  watchOpen(t, f.scratchPath, async (handle) => {
    opened = handle;
    const write = handle.write.bind(handle);
    t.mock.method(handle, "write", async (...args) => {
      const result = await write(...args);
      controller.abort();
      return result;
    });
  });
  const scratch = await workspace.createScratch();
  await assert.rejects(scratch.write(Buffer.alloc(140003)), code("CANCELLED"));
  await workspace.close();
  await assert.rejects(opened.stat(), { code: "EBADF" });
  assert.equal((await fs.lstat(f.scratchPath)).size, 65536);
});

test("closing queued operations is idempotent and never deletes fixed workspace files", async (t) => {
  const f = await fixture(t),
    scratch = await f.workspace.createScratch();
  const pending = scratch.write(Buffer.alloc(140003));
  const rejected = assert.rejects(pending, code("PATCH_CLOSED"));
  await Promise.all([f.workspace.close(), f.workspace.close(), rejected]);
  await assert.rejects(scratch.read(0, 0), code("PATCH_CLOSED"));
  await assert.rejects(f.workspace.createScratch(), code("PATCH_CLOSED"));
  assert.deepEqual(await fs.readdir(f.directory), ["patch-data.bin"]);
});

test("all handle close attempts run, errors are sanitized and failed close can retry", async (t) => {
  const f = await fixture(t);
  let opened;
  watchOpen(t, f.scratchPath, async (handle) => {
    opened = handle;
    const close = handle.close.bind(handle);
    let failed = false;
    t.mock.method(handle, "close", async () => {
      if (!failed) {
        failed = true;
        throw new Error("private path in close failure");
      }
      return close();
    });
  });
  await f.workspace.createScratch();
  await assert.rejects(f.workspace.close(), code("PATCH_IO"));
  await f.workspace.close();
  await f.workspace.close();
  await assert.rejects(opened.stat(), { code: "EBADF" });
});

test("64 MiB VCDIFF windows are accepted and larger writes are rejected before IO", async (t) => {
  const f = await fixture(t),
    bytes = Buffer.alloc(64 * MIB, 0x50),
    target = await f.workspace.createTarget(expected(bytes));
  await target.write(bytes);
  const result = await target.finish();
  assert.equal(result.size, bytes.length);
  assert.equal(
    (await target.read(bytes.length - 16, 16)).toString("hex"),
    bytes.subarray(bytes.length - 16).toString("hex"),
  );
  const scratch = await f.workspace.createScratch();
  await assert.rejects(
    scratch.write(Buffer.alloc(64 * MIB + 1)),
    code("PATCH_RESOURCE_LIMIT"),
  );
  assert.equal((await fs.lstat(f.scratchPath)).size, 0);
});

test("proofs return only immutable verified fixed-file metadata without deleting data", async (t) => {
  const f = await fixture(t),
    patchBytes = Buffer.from("patch contents"),
    scratchBytes = Buffer.from("decoded patch prefix"),
    targetBytes = Buffer.from("target contents");
  assert.deepEqual(await f.workspace.proofs(), []);
  await fs.writeFile(f.patchPath, patchBytes);
  await f.workspace.openPatch(expected(patchBytes));
  const scratch = await f.workspace.createScratch(),
    target = await f.workspace.createTarget(expected(targetBytes));
  await scratch.write(scratchBytes);
  await target.write(targetBytes);
  await target.finish();
  const proofs = await f.workspace.proofs();
  assert.ok(Object.isFrozen(proofs));
  assert.deepEqual(
    proofs.map((proof) => proof.name),
    ["patch.zip", "patch-data.bin", "content.zip"],
  );
  for (const [index, bytes] of [
    patchBytes,
    scratchBytes,
    targetBytes,
  ].entries()) {
    const proof = proofs[index],
      file = path.join(f.directory, proof.name);
    assert.ok(Object.isFrozen(proof));
    assert.ok(Object.isFrozen(proof.identity));
    assert.deepEqual(Object.keys(proof).sort(), [
      "bytes",
      "identity",
      "name",
      "sha256",
    ]);
    assert.deepEqual(proof, {
      name: proof.name,
      ...expected(bytes),
      identity: identity(await fs.lstat(file)),
    });
    assert.ok(
      Object.values(proof.identity).every((value) => typeof value === "number"),
    );
    assert.deepEqual(await fs.readFile(file), bytes);
  }
  assert.deepEqual(await f.workspace.proofs(), proofs);
  await f.workspace.close();
  assert.equal((await fs.readdir(f.directory)).length, 3);
});

test("proofs verify incomplete and empty writer prefixes against intended bytes", async (t) => {
  const f = await fixture(t),
    bytes = Buffer.from("complete"),
    target = await f.workspace.createTarget(expected(bytes));
  await target.write(bytes.subarray(0, 3));
  await f.workspace.createScratch();
  const proofs = await f.workspace.proofs();
  assert.deepEqual(
    proofs.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 })),
    [
      { name: "content.zip", ...expected(Buffer.from("com")) },
      { name: "patch-data.bin", ...expected(Buffer.alloc(0)) },
    ],
  );
  await target.write(bytes.subarray(3));
  await target.finish();
});

test("proofs reject corruption adopted during the writer's stat refresh", async (t) => {
  const f = await fixture(t),
    bytes = Buffer.from("contents");
  watchOpen(t, f.scratchPath, async (handle) => {
    const write = handle.write.bind(handle);
    t.mock.method(handle, "write", async (...args) => {
      const result = await write(...args);
      await fs.writeFile(
        f.scratchPath,
        Buffer.alloc(result.bytesWritten, 0x51),
      );
      return result;
    });
  });
  const scratch = await f.workspace.createScratch();
  await scratch.write(bytes);
  await assert.rejects(f.workspace.proofs(), code("PATCH_CHANGED"));
  await assert.rejects(scratch.write(Buffer.from("x")), code("PATCH_STATE"));
  await assert.rejects(f.workspace.proofs(), code("PATCH_STATE"));
});

test("proofs recheck earlier entries after hashing later entries", async (t) => {
  const f = await fixture(t),
    bytes = Buffer.from("contents");
  await fs.writeFile(f.patchPath, bytes);
  await f.workspace.openPatch(expected(bytes));
  let mutate = false;
  watchOpen(t, f.scratchPath, async (handle) => {
    const read = handle.read.bind(handle);
    t.mock.method(handle, "read", async (...args) => {
      const result = await read(...args);
      if (mutate) {
        mutate = false;
        await fs.writeFile(f.patchPath, Buffer.alloc(bytes.length, 0x51));
      }
      return result;
    });
  });
  const scratch = await f.workspace.createScratch();
  await scratch.write(bytes);
  mutate = true;
  await assert.rejects(f.workspace.proofs(), code("PATCH_CHANGED"));
  await assert.rejects(f.workspace.proofs(), code("PATCH_STATE"));
});

test("proof snapshots serialize pending writes and later file creation", async (t) => {
  const f = await fixture(t),
    bytes = Buffer.from("base"),
    tail = Buffer.from("tail");
  let reach,
    release,
    pause = true;
  const reached = new Promise((resolve) => {
      reach = resolve;
    }),
    hold = new Promise((resolve) => {
      release = resolve;
    });
  watchOpen(t, f.scratchPath, async (handle) => {
    const read = handle.read.bind(handle);
    t.mock.method(handle, "read", async (...args) => {
      if (pause) {
        pause = false;
        reach();
        await hold;
      }
      return read(...args);
    });
  });
  const scratch = await f.workspace.createScratch();
  const initial = scratch.write(bytes),
    snapshot = f.workspace.proofs();
  await initial;
  await reached;
  const append = scratch.write(tail),
    create = f.workspace.createTarget(expected(tail));
  try {
    assert.equal((await fs.lstat(f.scratchPath)).size, bytes.length);
    await assert.rejects(fs.lstat(f.targetPath), { code: "ENOENT" });
  } finally {
    release();
  }
  const proofs = await snapshot;
  assert.deepEqual(
    proofs.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 })),
    [{ name: "patch-data.bin", ...expected(bytes) }],
  );
  await append;
  const target = await create;
  await target.write(tail);
  const updated = await f.workspace.proofs();
  assert.equal(updated[0].sha256, hash(Buffer.concat([bytes, tail])));
  assert.equal(updated[1].sha256, hash(tail));
});

test("cancelled proofs release their barrier and close every handle without deleting files", async (t) => {
  const f = await fixture(t),
    controller = new AbortController(),
    workspace = await f.make({ signal: controller.signal });
  let opened;
  watchOpen(t, f.scratchPath, async (handle) => {
    opened = handle;
    const read = handle.read.bind(handle);
    t.mock.method(handle, "read", async (...args) => {
      const result = await read(...args);
      controller.abort();
      return result;
    });
  });
  const scratch = await workspace.createScratch();
  await scratch.write(Buffer.from("contents"));
  await assert.rejects(workspace.proofs(), code("CANCELLED"));
  await assert.rejects(workspace.proofs(), code("CANCELLED"));
  await workspace.close();
  await assert.rejects(opened.stat(), { code: "EBADF" });
  assert.equal(await fs.readFile(f.scratchPath, "utf8"), "contents");
});

test("close waits for an active proof snapshot before releasing its handles", async (t) => {
  const f = await fixture(t);
  let opened,
    reach,
    release,
    pause = true;
  const reached = new Promise((resolve) => {
      reach = resolve;
    }),
    hold = new Promise((resolve) => {
      release = resolve;
    });
  watchOpen(t, f.scratchPath, async (handle) => {
    opened = handle;
    const read = handle.read.bind(handle);
    t.mock.method(handle, "read", async (...args) => {
      if (pause) {
        pause = false;
        reach();
        await hold;
      }
      return read(...args);
    });
  });
  const scratch = await f.workspace.createScratch();
  await scratch.write(Buffer.from("contents"));
  const snapshot = f.workspace.proofs(),
    rejected = assert.rejects(snapshot, code("PATCH_CLOSED"));
  await reached;
  const closing = f.workspace.close();
  try {
    assert.equal((await opened.stat()).size, 8);
  } finally {
    release();
  }
  await Promise.all([rejected, closing]);
  await assert.rejects(opened.stat(), { code: "EBADF" });
});

test("failed open cleanup retains a handle when close must retry", async (t) => {
  const f = await fixture(t),
    bytes = Buffer.from("contents");
  await fs.writeFile(f.patchPath, bytes);
  let opened,
    closes = 0;
  watchOpen(t, f.patchPath, async (handle) => {
    opened = handle;
    const close = handle.close.bind(handle);
    t.mock.method(handle, "close", async () => {
      if (closes++ === 0) throw new Error("private close path");
      return close();
    });
  });
  await assert.rejects(
    f.workspace.openPatch({ ...expected(bytes), sha256: "00".repeat(32) }),
    code("PATCH_HASH_MISMATCH"),
  );
  assert.equal((await opened.stat()).size, bytes.length);
  await f.workspace.close();
  await assert.rejects(opened.stat(), { code: "EBADF" });
  assert.equal(closes, 2);
});
