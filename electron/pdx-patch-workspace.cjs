"use strict";

const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");

const MAX_BYTES = 5 * 1024 ** 3;
const MAX_READ_BYTES = 8 * 1024 ** 2;
const MAX_WRITE_BYTES = 64 * 1024 ** 2;
const BLOCK = 64 * 1024;
const SAFE = Symbol("patch-workspace-error");
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const canonical = (value) =>
  process.platform === "win32" ? value.toLowerCase() : value;
const same = (left, right) =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.birthtimeNs === right.birthtimeNs;
const stable = (left, right) =>
  same(left, right) &&
  left.size === right.size &&
  left.mtimeNs === right.mtimeNs &&
  left.ctimeNs === right.ctimeNs &&
  right.nlink === 1n;

function failure(code) {
  return Object.assign(new Error("增量补丁暂存操作未完成。"), {
    code,
    ...(code === "CANCELLED" ? { name: "AbortError" } : {}),
    [SAFE]: true,
  });
}
function safe(error) {
  try {
    if (error?.[SAFE]) return error;
  } catch {
    // Untrusted exceptions cannot expose their properties or message.
  }
  return failure("PATCH_IO");
}
function absolute(value) {
  if (
    typeof value !== "string" ||
    !path.isAbsolute(value) ||
    value.length > 8192 ||
    /[\0-\x1f\x7f]/.test(value) ||
    (process.platform === "win32" && /^(?:\\\\|\/\/)/.test(value))
  )
    throw failure("PATCH_INVALID_INPUT");
  const result = path.resolve(value),
    root = path.parse(result).root;
  if (
    result === root ||
    result
      .slice(root.length)
      .split(path.sep)
      .some(
        (part) =>
          /[:<>"|?*]/.test(part) ||
          /[. ]$/.test(part) ||
          /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part),
      )
  )
    throw failure("PATCH_INVALID_INPUT");
  return result;
}
function selected(value) {
  if (
    !object(value) ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes < 1 ||
    value.bytes > MAX_BYTES ||
    typeof value.sha256 !== "string" ||
    value.sha256.length !== 64 ||
    !/^[a-f0-9]{64}$/.test(value.sha256)
  )
    throw failure("PATCH_INVALID_INPUT");
  return { bytes: value.bytes, sha256: value.sha256 };
}
function directoryPaths(directory) {
  const result = [];
  for (let current = directory; ; current = path.dirname(current)) {
    result.unshift(current);
    if (path.dirname(current) === current) return result;
  }
}
async function directoryStat(target) {
  const stat = await fs.lstat(target, { bigint: true });
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    canonical(await fs.realpath(target)) !== canonical(target)
  )
    throw failure("PATCH_CHANGED");
  return stat;
}
const archiveIdentity = (stat) => ({
  ino: stat.ino,
  dev: stat.dev,
  birthtimeMs: stat.birthtimeMs,
  size: stat.size,
  mtimeMs: stat.mtimeMs,
  ctimeMs: stat.ctimeMs,
});

async function createPdxPatchWorkspace(options) {
  let signal;
  try {
    if (!object(options)) throw failure("PATCH_INVALID_INPUT");
    const directory = absolute(options.directory);
    signal = options.signal;
    if (signal !== undefined && !(signal instanceof AbortSignal))
      throw failure("PATCH_INVALID_INPUT");
    const lineage = [],
      entries = new Map();
    let closed = false,
      closeTask,
      barrier = Promise.resolve();
    const check = () => {
      if (signal?.aborted) throw failure("CANCELLED");
      if (closed) throw failure("PATCH_CLOSED");
    };
    async function guardDirectory() {
      check();
      try {
        for (const item of lineage) {
          if (!same(await directoryStat(item.path), item.stat))
            throw failure("PATCH_CHANGED");
          check();
        }
      } catch (error) {
        check();
        if (error?.[SAFE]) throw error;
        throw failure("PATCH_CHANGED");
      }
    }
    for (const target of directoryPaths(directory)) {
      check();
      try {
        lineage.push({ path: target, stat: await directoryStat(target) });
      } catch {
        throw failure("PATCH_CHANGED");
      }
    }
    await guardDirectory();

    async function inspect(entry, expected = entry.stat) {
      check();
      try {
        await guardDirectory();
        const stat = await fs.lstat(entry.path, { bigint: true }),
          opened = await entry.handle.stat({ bigint: true });
        if (
          !stat.isFile() ||
          stat.isSymbolicLink() ||
          stat.nlink !== 1n ||
          !opened.isFile() ||
          !stable(stat, opened) ||
          (expected && !stable(expected, stat)) ||
          canonical(await fs.realpath(entry.path)) !== canonical(entry.path)
        )
          throw failure("PATCH_CHANGED");
        await guardDirectory();
        check();
        return stat;
      } catch (error) {
        check();
        if (error?.[SAFE]) throw error;
        throw failure("PATCH_CHANGED");
      }
    }
    function serial(entry, action) {
      const result = Promise.all([entry.tail, barrier]).then(async () => {
        try {
          check();
          if (entry.failed) throw failure("PATCH_STATE");
          return await action();
        } catch (error) {
          entry.failed = true;
          check();
          throw safe(error);
        }
      });
      entry.tail = result.catch(() => {});
      return result;
    }
    async function releaseFailedOpen(entry) {
      if (!entry?.handle) return;
      try {
        await entry.handle.close();
        entry.handle = null;
      } catch {
        // Keep the handle available so workspace.close() can retry.
      }
    }
    function register(name, limit, expected) {
      check();
      if (entries.has(name)) throw failure("PATCH_STATE");
      const entry = {
        path: path.join(directory, name),
        limit,
        expected,
        bytes: 0,
        digest: createHash("sha256"),
        dirty: false,
        failed: false,
        finished: false,
        handle: null,
        stat: null,
        tail: Promise.resolve(),
      };
      entries.set(name, entry);
      return entry;
    }
    async function hashContents(entry) {
      const digest = createHash("sha256"),
        buffer = Buffer.alloc(BLOCK);
      for (let offset = 0; offset < entry.bytes; ) {
        check();
        await inspect(entry);
        const { bytesRead } = await entry.handle.read(
          buffer,
          0,
          Math.min(BLOCK, entry.bytes - offset),
          offset,
        );
        if (!bytesRead) throw failure("PATCH_CHANGED");
        digest.update(buffer.subarray(0, bytesRead));
        offset += bytesRead;
        await inspect(entry);
      }
      await inspect(entry);
      check();
      return digest.digest("hex");
    }
    async function confirmWritten(entry) {
      if (entry.dirty) {
        if ((await hashContents(entry)) !== entry.digest.copy().digest("hex"))
          throw failure("PATCH_CHANGED");
        entry.dirty = false;
      }
    }
    function reader(entry) {
      return (offset, length) =>
        serial(entry, async () => {
          if (
            !Number.isSafeInteger(offset) ||
            !Number.isSafeInteger(length) ||
            offset < 0 ||
            length < 0 ||
            length > MAX_READ_BYTES ||
            offset > entry.bytes - length
          )
            throw failure("PATCH_INVALID_INPUT");
          await inspect(entry);
          await confirmWritten(entry);
          const result = Buffer.alloc(length);
          for (let count = 0; count < length; ) {
            check();
            await inspect(entry);
            const { bytesRead } = await entry.handle.read(
              result,
              count,
              Math.min(BLOCK, length - count),
              offset + count,
            );
            if (!bytesRead) throw failure("PATCH_CHANGED");
            count += bytesRead;
            await inspect(entry);
          }
          check();
          await inspect(entry);
          return result;
        });
    }
    function writer(entry) {
      const read = reader(entry);
      function write(input) {
        let snapshot;
        try {
          check();
          if (entry.failed || entry.finished) throw failure("PATCH_STATE");
          if (!Buffer.isBuffer(input)) throw failure("PATCH_INVALID_INPUT");
          if (input.length > MAX_WRITE_BYTES)
            throw failure("PATCH_RESOURCE_LIMIT");
          // Snapshot before the first yield, including time spent in the queue.
          snapshot = Buffer.from(input);
        } catch (error) {
          entry.failed = true;
          return Promise.reject(safe(error));
        }
        return serial(entry, async () => {
          if (entry.finished) throw failure("PATCH_STATE");
          if (snapshot.length > entry.limit - entry.bytes)
            throw failure("PATCH_RESOURCE_LIMIT");
          await inspect(entry);
          for (let offset = 0; offset < snapshot.length; ) {
            check();
            await inspect(entry);
            const { bytesWritten } = await entry.handle.write(
              snapshot,
              offset,
              Math.min(BLOCK, snapshot.length - offset),
              entry.bytes,
            );
            if (!bytesWritten) throw failure("PATCH_IO");
            entry.digest.update(
              snapshot.subarray(offset, offset + bytesWritten),
            );
            entry.bytes += bytesWritten;
            offset += bytesWritten;
            const next = await inspect(entry, null);
            if (!same(entry.stat, next) || next.size !== BigInt(entry.bytes))
              throw failure("PATCH_CHANGED");
            entry.stat = next;
            entry.dirty = true;
          }
          await inspect(entry);
          check();
        });
      }
      const result = { read, write };
      if (entry.expected) {
        result.finish = () =>
          serial(entry, async () => {
            await inspect(entry);
            if (entry.finished) return entry.identity;
            if (entry.bytes !== entry.expected.bytes)
              throw failure("PATCH_SIZE_MISMATCH");
            await entry.handle.sync();
            await inspect(entry);
            const digest = await hashContents(entry);
            if (
              digest !== entry.expected.sha256 ||
              entry.digest.copy().digest("hex") !== entry.expected.sha256
            )
              throw failure("PATCH_HASH_MISMATCH");
            const stat = await entry.handle.stat();
            await inspect(entry);
            check();
            entry.identity = Object.freeze(archiveIdentity(stat));
            entry.finished = true;
            entry.dirty = false;
            return entry.identity;
          });
      }
      return Object.freeze(result);
    }
    async function create(name, limit, expected) {
      const entry = register(name, limit, expected);
      try {
        return await serial(entry, async () => {
          await guardDirectory();
          try {
            entry.handle = await fs.open(entry.path, "wx+", 0o600);
          } catch (error) {
            if (error?.code === "EEXIST") throw failure("PATCH_EXISTS");
            throw error;
          }
          entry.stat = await entry.handle.stat({ bigint: true });
          if (entry.stat.size !== 0n) throw failure("PATCH_CHANGED");
          await inspect(entry);
          return writer(entry);
        });
      } catch (error) {
        await releaseFailedOpen(entry);
        throw error;
      }
    }
    return Object.freeze({
      async openPatch(input) {
        let entry;
        try {
          const expected = selected(input);
          entry = register("patch.zip", expected.bytes, expected);
          return await serial(entry, async () => {
            await guardDirectory();
            const before = await fs.lstat(entry.path, { bigint: true });
            if (
              !before.isFile() ||
              before.isSymbolicLink() ||
              before.nlink !== 1n ||
              before.size !== BigInt(expected.bytes) ||
              canonical(await fs.realpath(entry.path)) !== canonical(entry.path)
            )
              throw failure("PATCH_CHANGED");
            await guardDirectory();
            entry.handle = await fs.open(
              entry.path,
              constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
            );
            entry.stat = before;
            entry.bytes = expected.bytes;
            await inspect(entry);
            if ((await hashContents(entry)) !== expected.sha256)
              throw failure("PATCH_HASH_MISMATCH");
            check();
            return Object.freeze({
              bytes: expected.bytes,
              sha256: expected.sha256,
              read: reader(entry),
            });
          });
        } catch (error) {
          await releaseFailedOpen(entry);
          check();
          throw safe(error);
        }
      },
      async createScratch() {
        try {
          return await create("patch-data.bin", MAX_BYTES);
        } catch (error) {
          check();
          throw safe(error);
        }
      },
      async createTarget(input) {
        try {
          const expected = selected(input);
          return await create("content.zip", expected.bytes, expected);
        } catch (error) {
          check();
          throw safe(error);
        }
      },
      async proofs() {
        check();
        const captured = [...entries.entries()],
          pending = [barrier, ...captured.map(([, entry]) => entry.tail)];
        let release;
        barrier = new Promise((resolve) => {
          release = resolve;
        });
        try {
          await Promise.all(pending);
          await guardDirectory();
          const result = [];
          for (const [name, entry] of captured) {
            try {
              check();
              if (entry.failed || !entry.handle) throw failure("PATCH_STATE");
              await inspect(entry);
              const sha256 = await hashContents(entry),
                intended =
                  name === "patch.zip"
                    ? entry.expected.sha256
                    : entry.digest.copy().digest("hex");
              if (sha256 !== intended) throw failure("PATCH_CHANGED");
              const stat = await entry.handle.stat();
              await inspect(entry);
              result.push(
                Object.freeze({
                  name,
                  bytes: entry.bytes,
                  sha256,
                  identity: Object.freeze(archiveIdentity(stat)),
                }),
              );
            } catch (error) {
              entry.failed = true;
              throw error;
            }
          }
          for (const [, entry] of captured) {
            try {
              await inspect(entry);
            } catch (error) {
              entry.failed = true;
              throw error;
            }
          }
          await guardDirectory();
          check();
          return Object.freeze(result);
        } catch (error) {
          for (const [, entry] of captured) entry.failed = true;
          check();
          throw safe(error);
        } finally {
          release();
        }
      },
      close() {
        closed = true;
        if (!closeTask) {
          closeTask = (async () => {
            await Promise.allSettled([
              barrier,
              ...[...entries.values()].map((entry) => entry.tail),
            ]);
            let failed = false;
            for (const entry of entries.values()) {
              if (!entry.handle) continue;
              try {
                await entry.handle.close();
                entry.handle = null;
              } catch {
                failed = true;
              }
            }
            if (failed) throw failure("PATCH_IO");
          })();
          closeTask = closeTask.catch((error) => {
            closeTask = null;
            throw error;
          });
        }
        return closeTask;
      },
    });
  } catch (error) {
    if (signal?.aborted) throw failure("CANCELLED");
    throw safe(error);
  }
}

module.exports = { createPdxPatchWorkspace };
