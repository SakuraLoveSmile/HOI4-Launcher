"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const {
  createPdxArchiveCache,
  MAX_READ_BYTES,
} = require("../electron/pdx-archive-cache.cjs");

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const code = (expected) => (error) => {
  assert.equal(error.code, expected);
  assert.equal(error.message, "可信归档缓存操作未完成。");
  assert.equal(error.cause, undefined);
  assert.equal(Object.hasOwn(error, "path"), false);
  return true;
};
const planFor = (bytes, changes = {}) => ({
  modId: "123",
  revision: "3",
  bytes: bytes.length,
  sha256: hash(bytes),
  ...changes,
});
async function fixture(t, options = {}, bytes = Buffer.alloc(160001, 0x50)) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ironclad-zip-cache-")),
    storage = path.join(root, "control", "archives"),
    sourceDirectory = path.join(root, "source"),
    sourcePath = path.join(sourceDirectory, "verified.zip");
  t.after(async () => {
    const resolved = path.resolve(root);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(resolved, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 30,
    });
  });
  await fs.mkdir(sourceDirectory);
  await fs.writeFile(sourcePath, bytes);
  const plan = planFor(bytes),
    make = (changes = {}) =>
      createPdxArchiveCache({
        storageDirectory: storage,
        ...options,
        ...changes,
      }),
    service = make(),
    cached = path.join(storage, plan.sha256 + ".zip");
  return {
    root,
    sourceDirectory,
    sourcePath,
    storage,
    plan,
    bytes,
    make,
    service,
    cached,
    put: () => service.put(plan, { sourcePath }),
  };
}
async function missing(target) {
  await assert.rejects(fs.lstat(target), { code: "ENOENT" });
}
async function directoryLink(target, link) {
  await fs.symlink(
    target,
    link,
    process.platform === "win32" ? "junction" : "dir",
  );
}
async function replaceDirectory(t, directory, preserved) {
  try {
    await fs.rename(directory, preserved);
    await fs.mkdir(directory);
    return true;
  } catch (error) {
    // Windows prevents renaming a directory containing an open file. Exercise
    // the identity guard with the replacement stat that POSIX can observe.
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
function watchOpen(t, target, change) {
  const original = fs.open;
  t.mock.method(fs, "open", async function (file, ...args) {
    const handle = await original.call(this, file, ...args);
    if (file === target || (typeof target === "function" && target(file))) {
      try {
        await change(handle, file);
      } catch (error) {
        await handle.close().catch(() => {});
        throw error;
      }
    }
    return handle;
  });
}

test("construction and a cache miss are inert and disclose no private location", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(Object.keys(f.service).sort(), ["open", "put"]);
  assert.ok(Object.isFrozen(f.service));
  assert.equal(JSON.stringify(f.service), "{}");
  await missing(path.dirname(f.storage));
  assert.equal(await f.service.open(f.plan), null);
  await missing(path.dirname(f.storage));
});

test("put preserves exact original ZIP bytes and lease supports bounded repeated random reads", async (t) => {
  const bytes = Buffer.from(Array.from({ length: 190013 }, (_, i) => i % 251)),
    f = await fixture(t, {}, bytes);
  const stored = await f.put();
  assert.deepEqual(stored, { bytes: bytes.length, sha256: hash(bytes) });
  assert.deepEqual(await fs.readFile(f.cached), bytes);
  assert.deepEqual(await fs.readFile(f.sourcePath), bytes);
  assert.equal((await fs.lstat(f.cached)).nlink, 1);
  const lease = await f.service.open(f.plan);
  assert.ok(Object.isFrozen(lease));
  assert.deepEqual(Object.keys(lease).sort(), [
    "bytes",
    "close",
    "read",
    "sha256",
  ]);
  assert.equal(JSON.stringify(lease), JSON.stringify(stored));
  const requests = [
    [0, 65537],
    [65537, 70003],
    [177777, bytes.length - 177777],
    [0, bytes.length],
    [bytes.length, 0],
    [1, 0],
  ];
  const parts = await Promise.all(
    requests.map(([start, size]) => lease.read(start, size)),
  );
  parts.forEach((part, index) => {
    const [start, size] = requests[index];
    assert.deepEqual(part, bytes.subarray(start, start + size));
  });
  await lease.close();
  await lease.close();
  await assert.rejects(lease.read(0, 1), code("CACHE_CLOSED"));
  await missing(path.join(f.storage, ".archive-cache.lock"));
});

test("same digest reuses its verified entry across revisions and cache instances", async (t) => {
  const f = await fixture(t, { maxEntries: 1 });
  await f.put();
  const before = await fs.lstat(f.cached, { bigint: true });
  await f
    .make()
    .put(
      { ...f.plan, modId: "456", revision: "4" },
      { sourcePath: f.sourcePath },
    );
  const after = await fs.lstat(f.cached, { bigint: true });
  assert.equal(after.ino, before.ino);
  assert.equal(after.birthtimeNs, before.birthtimeNs);
  assert.equal(after.mtimeNs, before.mtimeNs);
  assert.equal(after.ctimeNs, before.ctimeNs);
  assert.deepEqual(await fs.readdir(f.storage), [path.basename(f.cached)]);
  const lease = await f.make().open(f.plan);
  await lease.close();
});

test("invalid constructor, plans, signals and source paths fail before filesystem IO", async (t) => {
  const f = await fixture(t);
  for (const value of [
    null,
    {},
    { storageDirectory: "relative" },
    { storageDirectory: f.storage, maxBytes: -1 },
    { storageDirectory: f.storage, maxEntries: 4097 },
  ])
    assert.throws(
      () => createPdxArchiveCache(value),
      code("CACHE_INVALID_INPUT"),
    );
  for (const changes of [
    { modId: "01" },
    { modId: 123 },
    { revision: "../3" },
    { bytes: 0 },
    { bytes: 1.5 },
    { sha256: "FF".repeat(32) },
    { sha256: f.plan.sha256 + "\n" },
  ]) {
    const plan = { ...f.plan, ...changes };
    await assert.rejects(f.service.open(plan), code("CACHE_INVALID_INPUT"));
    await assert.rejects(
      f.service.put(plan, { sourcePath: f.sourcePath }),
      code("CACHE_INVALID_INPUT"),
    );
  }
  await assert.rejects(
    f.service.put(f.plan, { sourcePath: "relative" }),
    code("CACHE_INVALID_INPUT"),
  );
  await assert.rejects(
    f.service.open(f.plan, { signal: {} }),
    code("CACHE_INVALID_INPUT"),
  );
  await assert.rejects(
    f.service.put(f.plan, null),
    code("CACHE_INVALID_INPUT"),
  );
  await missing(path.dirname(f.storage));
});

test("source size and same-size content mismatches never populate the cache", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.sourcePath, f.bytes.subarray(1));
  await assert.rejects(f.put(), code("CACHE_SOURCE_CHANGED"));
  await fs.writeFile(f.sourcePath, Buffer.alloc(f.bytes.length, 0x51));
  await assert.rejects(f.put(), code("CACHE_HASH_MISMATCH"));
  await missing(path.dirname(f.storage));
});

test("an existing valid cache cannot excuse an invalid put source", async (t) => {
  const f = await fixture(t);
  await f.put();
  await fs.writeFile(f.sourcePath, Buffer.alloc(f.bytes.length, 0x51));
  await assert.rejects(f.put(), code("CACHE_HASH_MISMATCH"));
  assert.deepEqual(await fs.readFile(f.cached), f.bytes);
});

test("source equal-size mutation between verification and copying is rejected", async (t) => {
  const f = await fixture(t);
  let starts = 0;
  watchOpen(t, f.sourcePath, async (handle) => {
    const read = handle.read.bind(handle);
    t.mock.method(handle, "read", async (...args) => {
      if (args[3] === 0 && ++starts === 2) {
        const before = await fs.stat(f.sourcePath);
        await fs.writeFile(f.sourcePath, Buffer.alloc(f.bytes.length, 0x51));
        await fs.utimes(f.sourcePath, before.atime, before.mtime);
      }
      return read(...args);
    });
  });
  await assert.rejects(f.put(), code("CACHE_SOURCE_CHANGED"));
  assert.equal(starts, 2);
  await missing(f.cached);
  assert.deepEqual(await fs.readdir(f.storage), []);
});

test("source replacement after opening is caught before its content is read", async (t) => {
  const f = await fixture(t),
    saved = path.join(f.root, "saved-source.zip");
  let read = false;
  watchOpen(t, f.sourcePath, async (handle) => {
    t.mock.method(handle, "read", async () => {
      read = true;
      assert.fail("Replaced source must not be read");
    });
    await fs.rename(f.sourcePath, saved);
    await fs.writeFile(f.sourcePath, f.bytes);
  });
  await assert.rejects(f.put(), code("CACHE_SOURCE_CHANGED"));
  assert.equal(read, false);
  assert.deepEqual(await fs.readFile(saved), f.bytes);
  await missing(path.dirname(f.storage));
});

test("source parent replacement is caught even with identical file bytes", async (t) => {
  const f = await fixture(t),
    preserved = path.join(f.root, "preserved-source");
  watchOpen(t, f.sourcePath, async () => {
    if (await replaceDirectory(t, f.sourceDirectory, preserved))
      await fs.writeFile(f.sourcePath, f.bytes);
  });
  await assert.rejects(f.put(), code("CACHE_SOURCE_CHANGED"));
  await missing(path.dirname(f.storage));
});

test("source hardlinks are rejected without opening or reading their content", async (t) => {
  const f = await fixture(t);
  await fs.link(f.sourcePath, path.join(f.root, "outside-source.zip"));
  watchOpen(t, f.sourcePath, async () =>
    assert.fail("Hardlinked source must not be opened"),
  );
  await assert.rejects(f.put(), code("CACHE_SOURCE_CHANGED"));
  await missing(path.dirname(f.storage));
});

test("source junctions are rejected before following their content", async (t) => {
  const f = await fixture(t),
    linked = path.join(f.root, "linked-source");
  await directoryLink(f.sourceDirectory, linked);
  await assert.rejects(
    f.service.put(f.plan, { sourcePath: path.join(linked, "verified.zip") }),
    code("CACHE_CHANGED"),
  );
  await missing(path.dirname(f.storage));
});

test("cache same-size corruption is detected on every open and never overwritten", async (t) => {
  const f = await fixture(t);
  await f.put();
  const altered = Buffer.alloc(f.bytes.length, 0x51),
    before = await fs.stat(f.cached);
  await fs.writeFile(f.cached, altered);
  await fs.utimes(f.cached, before.atime, before.mtime);
  await assert.rejects(f.service.open(f.plan), code("CACHE_INVALID"));
  await assert.rejects(f.put(), code("CACHE_INVALID"));
  assert.deepEqual(await fs.readFile(f.cached), altered);
});

test("cache hardlinks are rejected without opening their contents", async (t) => {
  const f = await fixture(t);
  await f.put();
  await fs.link(f.cached, path.join(f.root, "outside-cache.zip"));
  watchOpen(t, f.cached, async () =>
    assert.fail("Hardlinked cache must not be opened"),
  );
  await assert.rejects(f.service.open(f.plan), code("CACHE_INVALID"));
});

test("cache root junctions and replaced ancestors never redirect reads or writes", async (t) => {
  const f = await fixture(t);
  await f.put();
  const preserved = path.join(f.root, "preserved-cache");
  await fs.rename(f.storage, preserved);
  await directoryLink(preserved, f.storage);
  await assert.rejects(f.service.open(f.plan), code("CACHE_CHANGED"));
  await assert.rejects(f.put(), code("CACHE_CHANGED"));
  await assert.rejects(f.make().open(f.plan), code("CACHE_CHANGED"));
  assert.deepEqual(
    await fs.readFile(path.join(preserved, path.basename(f.cached))),
    f.bytes,
  );
});

test("lease rejects in-place tampering and newly added external hardlinks", async (t) => {
  const f = await fixture(t);
  await f.put();
  const lease = await f.service.open(f.plan);
  await fs.writeFile(f.cached, Buffer.alloc(f.bytes.length, 0x51));
  await assert.rejects(lease.read(0, 32), code("CACHE_INVALID"));
  await lease.close();
  // A fresh, independent entry demonstrates that link count is checked after open.
  const next = await fixture(t);
  await next.put();
  const linked = await next.service.open(next.plan);
  await fs.link(next.cached, path.join(next.root, "external.zip"));
  await assert.rejects(linked.read(0, 32), code("CACHE_INVALID"));
  await linked.close();
});

test("lease rejects a cache parent swap rather than reading through a new path", async (t) => {
  const f = await fixture(t);
  await f.put();
  const lease = await f.service.open(f.plan),
    saved = path.join(f.root, "saved-cache");
  t.after(() => lease.close());
  if (await replaceDirectory(t, f.storage, saved))
    await fs.copyFile(path.join(saved, path.basename(f.cached)), f.cached);
  await assert.rejects(lease.read(0, 32), code("CACHE_INVALID"));
  await lease.close();
  await assert.rejects(f.service.open(f.plan), code("CACHE_CHANGED"));
});

test("lease rejects mutation during a read and serializes close with pending reads", async (t) => {
  const f = await fixture(t);
  await f.put();
  let cachedHandle;
  watchOpen(t, f.cached, async (handle) => {
    cachedHandle = handle;
  });
  const lease = await f.service.open(f.plan),
    read = cachedHandle.read.bind(cachedHandle);
  t.mock.method(cachedHandle, "read", async (...args) => {
    const result = await read(...args);
    await fs.writeFile(f.cached, Buffer.alloc(f.bytes.length, 0x51));
    return result;
  });
  const pending = lease.read(0, 65537),
    closing = lease.close();
  await assert.rejects(pending, code("CACHE_INVALID"));
  await closing;
  await assert.rejects(lease.read(0, 1), code("CACHE_CLOSED"));
});

test("lease range and allocation limits are checked before any read", async (t) => {
  const f = await fixture(t);
  await f.put();
  const lease = await f.service.open(f.plan);
  for (const [offset, length] of [
    [-1, 1],
    [0, -1],
    [0.5, 1],
    [0, NaN],
    [Number.MAX_SAFE_INTEGER, 1],
    [f.bytes.length, 1],
    [0, MAX_READ_BYTES + 1],
  ])
    await assert.rejects(
      lease.read(offset, length),
      code("CACHE_INVALID_INPUT"),
    );
  assert.deepEqual(await lease.read(0, 1), f.bytes.subarray(0, 1));
  await lease.close();
});

test("byte and entry budgets refuse additions without evicting old or foreign files", async (t) => {
  const f = await fixture(t, { maxEntries: 1, maxBytes: 200000 });
  await f.put();
  const otherBytes = Buffer.alloc(30001, 0x51),
    other = path.join(f.sourceDirectory, "other.zip");
  await fs.writeFile(other, otherBytes);
  await assert.rejects(
    f.service.put(planFor(otherBytes), { sourcePath: other }),
    code("CACHE_FULL"),
  );
  await f.put();
  assert.deepEqual(await fs.readdir(f.storage), [path.basename(f.cached)]);
  const limited = f.make({
    maxEntries: 2,
    maxBytes: f.bytes.length + otherBytes.length - 1,
  });
  await assert.rejects(
    limited.put(planFor(otherBytes), { sourcePath: other }),
    code("CACHE_FULL"),
  );
  assert.deepEqual(await fs.readFile(f.cached), f.bytes);
  const foreign = path.join(f.storage, "unknown-fragment.tmp");
  await fs.writeFile(foreign, "preserve");
  await assert.rejects(
    limited.put(planFor(otherBytes), { sourcePath: other }),
    code("CACHE_FULL"),
  );
  assert.equal(await fs.readFile(foreign, "utf8"), "preserve");
});

test("a disabled or undersized cache fails without creating directories", async (t) => {
  const f = await fixture(t);
  for (const changes of [
    { maxEntries: 0 },
    { maxBytes: 0 },
    { maxBytes: f.bytes.length - 1 },
  ])
    await assert.rejects(
      f.make(changes).put(f.plan, { sourcePath: f.sourcePath }),
      code("CACHE_FULL"),
    );
  await missing(path.dirname(f.storage));
});

test("pre-cancelled operations and cancelled source hashing leave no control files", async (t) => {
  const f = await fixture(t),
    controller = new AbortController();
  controller.abort();
  await assert.rejects(
    f.service.open(f.plan, { signal: controller.signal }),
    code("CANCELLED"),
  );
  await assert.rejects(
    f.service.put(f.plan, {
      sourcePath: f.sourcePath,
      signal: controller.signal,
    }),
    code("CANCELLED"),
  );
  const active = new AbortController();
  watchOpen(t, f.sourcePath, async (handle) => {
    const read = handle.read.bind(handle);
    t.mock.method(handle, "read", async (...args) => {
      const result = await read(...args);
      active.abort();
      return result;
    });
  });
  await assert.rejects(
    f.service.put(f.plan, { sourcePath: f.sourcePath, signal: active.signal }),
    code("CANCELLED"),
  );
  await missing(path.dirname(f.storage));
});

test("cancelling a copy removes only its verified temporary and releases its lock", async (t) => {
  const f = await fixture(t),
    controller = new AbortController();
  watchOpen(
    t,
    (file) => file.endsWith(".tmp"),
    async (handle) => {
      const write = handle.write.bind(handle);
      t.mock.method(handle, "write", async (...args) => {
        const result = await write(...args);
        controller.abort();
        return result;
      });
    },
  );
  await assert.rejects(
    f.service.put(f.plan, {
      sourcePath: f.sourcePath,
      signal: controller.signal,
    }),
    code("CANCELLED"),
  );
  assert.deepEqual(await fs.readdir(f.storage), []);
  assert.deepEqual(await fs.readFile(f.sourcePath), f.bytes);
});

test("lease cancellation stops subsequent reads but still allows idempotent close", async (t) => {
  const f = await fixture(t),
    controller = new AbortController();
  await f.put();
  const lease = await f.service.open(f.plan, { signal: controller.signal });
  controller.abort();
  await assert.rejects(lease.read(0, 1), code("CANCELLED"));
  await lease.close();
  await lease.close();
});

test("a replaced temporary is preserved, along with the original uncertain fragment", async (t) => {
  const f = await fixture(t),
    foreign = Buffer.from("external replacement"),
    saved = path.join(f.root, "retained-fragment.tmp");
  let target;
  watchOpen(
    t,
    (file) => file.endsWith(".tmp"),
    async (handle, file) => {
      const write = handle.write.bind(handle);
      let replaced = false;
      t.mock.method(handle, "write", async (...args) => {
        const result = await write(...args);
        if (!replaced) {
          replaced = true;
          target = file;
          await fs.rename(file, saved);
          await fs.writeFile(file, foreign);
        }
        return result;
      });
    },
  );
  await assert.rejects(f.put(), code("CACHE_CHANGED"));
  assert.deepEqual(await fs.readFile(target), foreign);
  assert.ok((await fs.lstat(saved)).size > 0);
  await missing(f.cached);
});

test("a cache ancestor replaced during copying preserves moved temporary evidence", async (t) => {
  const f = await fixture(t),
    saved = path.join(f.root, "retained-cache");
  let physicallyMoved = false;
  watchOpen(
    t,
    (file) => file.endsWith(".tmp"),
    async (handle) => {
      const write = handle.write.bind(handle);
      let replaced = false;
      t.mock.method(handle, "write", async (...args) => {
        const result = await write(...args);
        if (!replaced) {
          replaced = true;
          physicallyMoved = await replaceDirectory(t, f.storage, saved);
        }
        return result;
      });
    },
  );
  await assert.rejects(f.put(), code("CACHE_CHANGED"));
  if (physicallyMoved) assert.deepEqual(await fs.readdir(f.storage), []);
  const retained = await fs.readdir(physicallyMoved ? saved : f.storage);
  assert.ok(retained.some((file) => file.endsWith(".tmp")));
  assert.ok(retained.includes(".archive-cache.lock"));
});

test("same-size temporary tampering is retained rather than cleaned as an owned fragment", async (t) => {
  const f = await fixture(t);
  let target;
  watchOpen(
    t,
    (file) => file.endsWith(".tmp"),
    async (handle, file) => {
      const write = handle.write.bind(handle);
      let changed = false;
      t.mock.method(handle, "write", async (...args) => {
        const result = await write(...args);
        if (!changed) {
          changed = true;
          target = file;
          await fs.writeFile(file, Buffer.alloc(result.bytesWritten, 0x51));
        }
        return result;
      });
    },
  );
  await assert.rejects(f.put(), code("CACHE_CHANGED"));
  assert.ok((await fs.lstat(target)).size > 0);
  assert.equal((await fs.readFile(target))[0], 0x51);
  await missing(f.cached);
});

test("short reads and short writes still copy and verify every exact source byte", async (t) => {
  const f = await fixture(t, {}, Buffer.alloc(11003, 0x50));
  watchOpen(t, f.sourcePath, async (handle) => {
    const read = handle.read.bind(handle);
    t.mock.method(handle, "read", (buffer, offset, length, position) =>
      read(buffer, offset, Math.min(length, 1021), position),
    );
  });
  watchOpen(
    t,
    (file) => file.endsWith(".tmp"),
    async (handle) => {
      const write = handle.write.bind(handle);
      t.mock.method(handle, "write", (buffer, offset, length, position) =>
        write(buffer, offset, Math.min(length, 127), position),
      );
    },
  );
  await f.put();
  assert.deepEqual(await fs.readFile(f.cached), f.bytes);
});

test("atomic destination collisions reuse only a fully verified existing archive", async (t) => {
  const f = await fixture(t),
    realLink = fs.link;
  t.mock.method(fs, "link", async (source, destination) => {
    if (destination === f.cached) {
      await fs.writeFile(destination, f.bytes, { flag: "wx" });
      throw Object.assign(new Error("fixture destination race"), {
        code: "EEXIST",
      });
    }
    return realLink(source, destination);
  });
  await f.put();
  assert.deepEqual(await fs.readdir(f.storage), [path.basename(f.cached)]);
  assert.deepEqual(await fs.readFile(f.cached), f.bytes);
});

test("an invalid atomic destination collision is preserved without replacement", async (t) => {
  const f = await fixture(t),
    foreign = Buffer.alloc(f.bytes.length, 0x51);
  t.mock.method(fs, "link", async (source, destination) => {
    assert.equal(destination, f.cached);
    await fs.writeFile(destination, foreign, { flag: "wx" });
    throw Object.assign(new Error("fixture collision"), { code: "EEXIST" });
  });
  await assert.rejects(f.put(), code("CACHE_INVALID"));
  assert.deepEqual(await fs.readFile(f.cached), foreign);
  assert.deepEqual(await fs.readdir(f.storage), [path.basename(f.cached)]);
});

test("a changed lock is retained and a failed open closes its unreturned lease handle", async (t) => {
  const f = await fixture(t);
  await f.put();
  let cachedHandle,
    changed = false;
  watchOpen(t, f.cached, async (handle) => {
    cachedHandle = handle;
    const read = handle.read.bind(handle);
    t.mock.method(handle, "read", async (...args) => {
      const result = await read(...args);
      if (!changed) {
        changed = true;
        await fs.writeFile(
          path.join(f.storage, ".archive-cache.lock"),
          "foreign lock mutation",
        );
      }
      return result;
    });
  });
  await assert.rejects(f.service.open(f.plan), code("CACHE_CHANGED"));
  await assert.rejects(cachedHandle.stat(), { code: "EBADF" });
  assert.equal(
    await fs.readFile(path.join(f.storage, ".archive-cache.lock"), "utf8"),
    "foreign lock mutation",
  );
  assert.deepEqual(await fs.readFile(f.cached), f.bytes);
});

test("cancellation while releasing the open lock closes the unreturned handle", async (t) => {
  const f = await fixture(t),
    controller = new AbortController();
  await f.put();
  let cachedHandle;
  watchOpen(t, f.cached, async (handle) => {
    cachedHandle = handle;
  });
  const unlink = fs.unlink;
  t.mock.method(fs, "unlink", async (file) => {
    const result = await unlink(file);
    if (file === path.join(f.storage, ".archive-cache.lock"))
      controller.abort();
    return result;
  });
  await assert.rejects(
    f.service.open(f.plan, { signal: controller.signal }),
    code("CANCELLED"),
  );
  await assert.rejects(cachedHandle.stat(), { code: "EBADF" });
  assert.deepEqual(await fs.readFile(f.cached), f.bytes);
});

test("lease close failures stay sanitized and can retry releasing the handle", async (t) => {
  const f = await fixture(t);
  await f.put();
  let cachedHandle;
  watchOpen(t, f.cached, async (handle) => {
    cachedHandle = handle;
  });
  const lease = await f.service.open(f.plan),
    close = cachedHandle.close.bind(cachedHandle);
  let failed = false;
  t.mock.method(cachedHandle, "close", async () => {
    if (!failed) {
      failed = true;
      throw new Error("fixture private path and account details");
    }
    return close();
  });
  await assert.rejects(lease.close(), code("CACHE_IO"));
  await assert.rejects(lease.read(0, 1), code("CACHE_CLOSED"));
  await lease.close();
  await lease.close();
  await assert.rejects(cachedHandle.stat(), { code: "EBADF" });
});

test("same-process parallel puts and opens remain atomic and do not invalidate old leases", async (t) => {
  const f = await fixture(t, { maxEntries: 2 });
  await Promise.all(
    Array.from({ length: 6 }, (_, i) =>
      f.make().put(f.plan, { sourcePath: f.sourcePath }),
    ),
  );
  const leases = await Promise.all(
    Array.from({ length: 5 }, () => f.make().open(f.plan)),
  );
  const otherBytes = Buffer.alloc(70003, 0x51),
    other = path.join(f.sourceDirectory, "other.zip");
  await fs.writeFile(other, otherBytes);
  await f.make().put(planFor(otherBytes), { sourcePath: other });
  const values = await Promise.all(
    leases.map((lease) => lease.read(100, 65537)),
  );
  values.forEach((bytes) =>
    assert.deepEqual(bytes, f.bytes.subarray(100, 65637)),
  );
  await Promise.all(leases.map((lease) => lease.close()));
  assert.equal((await fs.readdir(f.storage)).length, 2);
  assert.equal((await fs.lstat(f.cached)).nlink, 1);
});

const childCode = `
const { createPdxArchiveCache } = require(process.argv[1]);
const cache = createPdxArchiveCache({ storageDirectory: process.argv[2], maxEntries: 1 });
cache.put(JSON.parse(process.argv[4]), { sourcePath: process.argv[3] }).then(
 () => process.stdout.write('OK'),
 e => { process.stdout.write(e.code || 'UNKNOWN'); if (e.code !== 'CACHE_FULL') process.exitCode = 1; }
);
`;
async function childPut(storage, source, plan) {
  const result = await promisify(execFile)(
    process.execPath,
    [
      "--no-warnings",
      "-e",
      childCode,
      path.resolve(__dirname, "../electron/pdx-archive-cache.cjs"),
      storage,
      source,
      JSON.stringify(plan),
    ],
    { windowsHide: true, timeout: 15000 },
  );
  assert.equal(result.stderr, "");
  return result.stdout;
}

test("independent Node processes safely race the same no-overwrite commit", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(
    await Promise.all([
      childPut(f.storage, f.sourcePath, f.plan),
      childPut(f.storage, f.sourcePath, f.plan),
    ]),
    ["OK", "OK"],
  );
  assert.deepEqual(await fs.readdir(f.storage), [path.basename(f.cached)]);
  const lease = await f.service.open(f.plan);
  assert.deepEqual(await lease.read(0, f.bytes.length), f.bytes);
  await lease.close();
});

test("independent Node processes cannot race past the shared entry budget", async (t) => {
  const f = await fixture(t),
    otherBytes = Buffer.alloc(f.bytes.length, 0x51),
    other = path.join(f.sourceDirectory, "other.zip");
  await fs.writeFile(other, otherBytes);
  const results = await Promise.all([
    childPut(f.storage, f.sourcePath, f.plan),
    childPut(f.storage, other, planFor(otherBytes)),
  ]);
  assert.deepEqual(results.sort(), ["CACHE_FULL", "OK"]);
  assert.equal((await fs.readdir(f.storage)).length, 1);
});

test("unknown lock owners are retained and waiting remains cancellable", async (t) => {
  const f = await fixture(t),
    controller = new AbortController();
  await fs.mkdir(f.storage, { recursive: true });
  const lock = path.join(f.storage, ".archive-cache.lock");
  await fs.writeFile(lock, "unknown owner");
  const pending = f.service.put(f.plan, {
    sourcePath: f.sourcePath,
    signal: controller.signal,
  });
  const timer = setTimeout(() => controller.abort(), 50);
  try {
    await assert.rejects(pending, code("CANCELLED"));
  } finally {
    clearTimeout(timer);
  }
  assert.equal(await fs.readFile(lock, "utf8"), "unknown owner");
  await missing(f.cached);
});
