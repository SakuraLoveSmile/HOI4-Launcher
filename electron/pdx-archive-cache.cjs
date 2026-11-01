"use strict";

const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");

const BLOCK = 64 * 1024;
const MAX_READ_BYTES = 8 * 1024 ** 2;
const LOCK = ".archive-cache.lock";
const SAFE_ERROR = Symbol("archive-cache-error");
const queues = new Map();
const canonical = (value) =>
  process.platform === "win32" ? value.toLowerCase() : value;
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
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
  return Object.assign(new Error("可信归档缓存操作未完成。"), {
    code,
    ...(code === "CANCELLED" ? { name: "AbortError" } : {}),
    [SAFE_ERROR]: true,
  });
}
function check(signal) {
  if (signal?.aborted) throw failure("CANCELLED");
}
function signalValue(signal) {
  if (signal !== undefined && !(signal instanceof AbortSignal))
    throw failure("CACHE_INVALID_INPUT");
  check(signal);
  return signal;
}
function absolute(value) {
  if (
    typeof value !== "string" ||
    !path.isAbsolute(value) ||
    value.length > 8192 ||
    /[\0-\x1f\x7f]/.test(value) ||
    (process.platform === "win32" && /^(?:\\\\|\/\/)/.test(value))
  )
    throw failure("CACHE_INVALID_INPUT");
  const resolved = path.resolve(value),
    root = path.parse(resolved).root;
  if (
    resolved === root ||
    resolved
      .slice(root.length)
      .split(path.sep)
      .some(
        (part) =>
          /[:<>"|?*]/.test(part) ||
          /[. ]$/.test(part) ||
          /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part),
      )
  )
    throw failure("CACHE_INVALID_INPUT");
  return resolved;
}
function selectedPlan(value) {
  if (
    !object(value) ||
    typeof value.modId !== "string" ||
    !/^[1-9]\d{0,19}$/.test(value.modId) ||
    /\D/.test(value.modId) ||
    typeof value.revision !== "string" ||
    !/^(?:0|[1-9]\d{0,19})$/.test(value.revision) ||
    /\D/.test(value.revision) ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes < 1 ||
    typeof value.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.sha256) ||
    value.sha256.length !== 64
  )
    throw failure("CACHE_INVALID_INPUT");
  return { bytes: value.bytes, sha256: value.sha256 };
}
function directoryPaths(directory) {
  const result = [];
  for (let current = directory; ; current = path.dirname(current)) {
    result.unshift(current);
    if (path.dirname(current) === current) return result;
  }
}
async function directoryStat(target, code) {
  const stat = await fs.lstat(target, { bigint: true });
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    canonical(await fs.realpath(target)) !== canonical(target)
  )
    throw failure(code);
  return stat;
}
async function verifyLineage(lineage, code) {
  try {
    for (const item of lineage) {
      if (!same(await directoryStat(item.path, code), item.stat))
        throw failure(code);
    }
  } catch {
    throw failure(code);
  }
}
async function captureLineage(directory, create, signal) {
  const lineage = [];
  for (const target of directoryPaths(directory)) {
    check(signal);
    let stat;
    try {
      stat = await directoryStat(target, "CACHE_CHANGED");
    } catch (error) {
      if (error.code !== "ENOENT") throw failure("CACHE_CHANGED");
      if (!create) return null;
      await verifyLineage(lineage, "CACHE_CHANGED");
      check(signal);
      try {
        await fs.mkdir(target, { mode: 0o700 });
      } catch (mkdirError) {
        if (mkdirError.code !== "EEXIST") throw mkdirError;
      }
      stat = await directoryStat(target, "CACHE_CHANGED");
    }
    lineage.push({ path: target, stat });
  }
  await verifyLineage(lineage, "CACHE_CHANGED");
  check(signal);
  return lineage;
}
async function inspectFile(file, lineage, handle, expected, code) {
  try {
    await verifyLineage(lineage, code);
    const stat = await fs.lstat(file, { bigint: true });
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1n ||
      (expected && !stable(expected, stat)) ||
      canonical(await fs.realpath(file)) !== canonical(file)
    )
      throw failure(code);
    if (handle) {
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || !stable(stat, opened)) throw failure(code);
    }
    await verifyLineage(lineage, code);
    return stat;
  } catch {
    throw failure(code);
  }
}
async function openFile(file, lineage, bytes, code) {
  let handle;
  try {
    const before = await inspectFile(file, lineage, null, null, code);
    if (before.size !== BigInt(bytes)) throw failure(code);
    handle = await fs.open(
      file,
      constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
    );
    await inspectFile(file, lineage, handle, before, code);
    return {
      handle,
      stat: before,
      verify: () => inspectFile(file, lineage, handle, before, code),
    };
  } catch (error) {
    await handle?.close().catch(() => {});
    throw error;
  }
}
async function digestFile(handle, bytes, verify, signal) {
  const hash = createHash("sha256"),
    buffer = Buffer.alloc(BLOCK);
  for (let offset = 0; offset < bytes; ) {
    check(signal);
    await verify();
    const { bytesRead } = await handle.read(
      buffer,
      0,
      Math.min(BLOCK, bytes - offset),
      offset,
    );
    if (!bytesRead) throw failure("CACHE_CHANGED");
    hash.update(buffer.subarray(0, bytesRead));
    offset += bytesRead;
    await verify();
  }
  check(signal);
  await verify();
  return hash.digest("hex");
}
function waitFor(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const cancel = () => reject(failure("CANCELLED"));
    signal.addEventListener("abort", cancel, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        signal.removeEventListener("abort", cancel);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", cancel);
        reject(error);
      },
    );
    if (signal.aborted) cancel();
  });
}
async function serialized(key, signal, action) {
  const previous = queues.get(key) || Promise.resolve();
  let release;
  const done = new Promise((resolve) => (release = resolve)),
    tail = previous.then(() => done);
  queues.set(key, tail);
  try {
    await waitFor(previous, signal);
    check(signal);
    return await action();
  } finally {
    release();
    void tail.then(() => {
      if (queues.get(key) === tail) queues.delete(key);
    });
  }
}

function buildCache(options) {
  if (!object(options)) throw failure("CACHE_INVALID_INPUT");
  const {
    storageDirectory,
    maxBytes = 10 * 1024 ** 3,
    maxEntries = 32,
  } = options;
  const storage = absolute(storageDirectory);
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 0 ||
    !Number.isSafeInteger(maxEntries) ||
    maxEntries < 0 ||
    maxEntries > 4096
  )
    throw failure("CACHE_INVALID_INPUT");
  let anchor;
  async function storageLineage(create, signal) {
    if (!anchor) anchor = await captureLineage(storage, create, signal);
    if (anchor) await verifyLineage(anchor, "CACHE_CHANGED");
    check(signal);
    return anchor;
  }
  async function diskLock(lineage, signal) {
    const target = path.join(storage, LOCK),
      deadline = Date.now() + 5000;
    let handle;
    for (;;) {
      check(signal);
      await verifyLineage(lineage, "CACHE_CHANGED");
      try {
        handle = await fs.open(target, "wx+", 0o600);
        break;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        // A crashed or foreign owner is never removed or guessed stale.
        if (Date.now() >= deadline) throw failure("CACHE_BUSY");
        let timer;
        try {
          await waitFor(
            new Promise((resolve) => (timer = setTimeout(resolve, 25))),
            signal,
          );
        } finally {
          clearTimeout(timer);
        }
      }
    }
    let expected;
    try {
      const opened = await handle.stat({ bigint: true });
      expected = await inspectFile(
        target,
        lineage,
        handle,
        opened,
        "CACHE_CHANGED",
      );
    } catch (error) {
      await handle.close().catch(() => {});
      throw error;
    }
    return {
      verify: () =>
        inspectFile(target, lineage, handle, expected, "CACHE_CHANGED"),
      async release() {
        try {
          await inspectFile(target, lineage, handle, expected, "CACHE_CHANGED");
          await handle.close();
          handle = null;
          await inspectFile(target, lineage, null, expected, "CACHE_CHANGED");
          await fs.unlink(target);
        } finally {
          await handle?.close().catch(() => {});
        }
      },
    };
  }
  async function storedFile(plan, lineage, signal) {
    const file = path.join(storage, plan.sha256 + ".zip");
    await verifyLineage(lineage, "CACHE_CHANGED");
    try {
      await fs.lstat(file);
    } catch (error) {
      if (error.code === "ENOENT") {
        await verifyLineage(lineage, "CACHE_CHANGED");
        return null;
      }
      throw error;
    }
    const opened = await openFile(file, lineage, plan.bytes, "CACHE_INVALID");
    try {
      if (
        (await digestFile(opened.handle, plan.bytes, opened.verify, signal)) !==
        plan.sha256
      )
        throw failure("CACHE_INVALID");
      return opened;
    } catch (error) {
      await opened.handle.close().catch(() => {});
      throw error;
    }
  }
  async function capacity(plan, lineage, lock, signal) {
    let count = 0,
      bytes = 0;
    await lock.verify();
    const directory = await fs.opendir(storage);
    try {
      for await (const entry of directory) {
        check(signal);
        await lock.verify();
        if (entry.name === LOCK) continue;
        const stat = await fs.lstat(path.join(storage, entry.name), {
          bigint: true,
        });
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n)
          throw failure("CACHE_INVALID");
        count++;
        bytes += Number(stat.size);
        if (
          !Number.isSafeInteger(bytes) ||
          count >= maxEntries ||
          bytes > maxBytes - plan.bytes
        )
          throw failure("CACHE_FULL");
      }
    } finally {
      await directory.close().catch(() => {});
    }
    await verifyLineage(lineage, "CACHE_CHANGED");
    await lock.verify();
    if (count >= maxEntries || bytes > maxBytes - plan.bytes)
      throw failure("CACHE_FULL");
  }
  async function copyAndCommit(plan, source, lineage, lock, signal) {
    const temporary = path.join(storage, `.archive-cache-${randomUUID()}.tmp`),
      destination = path.join(storage, plan.sha256 + ".zip");
    let output,
      state,
      count = 0,
      linked = false,
      temporaryExists = false;
    const copied = createHash("sha256");
    const verifyTemp = () =>
      inspectFile(temporary, lineage, output, state, "CACHE_CHANGED");
    try {
      check(signal);
      await lock.verify();
      await source.verify();
      output = await fs.open(temporary, "wx+", 0o600);
      temporaryExists = true;
      state = await output.stat({ bigint: true });
      await verifyTemp();
      const buffer = Buffer.alloc(BLOCK);
      while (count < plan.bytes) {
        check(signal);
        await lock.verify();
        await source.verify();
        await verifyTemp();
        const { bytesRead } = await source.handle.read(
          buffer,
          0,
          Math.min(BLOCK, plan.bytes - count),
          count,
        );
        if (!bytesRead) throw failure("CACHE_SOURCE_CHANGED");
        await source.verify();
        let offset = 0;
        while (offset < bytesRead) {
          check(signal);
          await verifyTemp();
          const { bytesWritten } = await output.write(
            buffer,
            offset,
            bytesRead - offset,
            count,
          );
          if (!bytesWritten) throw failure("CACHE_IO");
          copied.update(buffer.subarray(offset, offset + bytesWritten));
          count += bytesWritten;
          offset += bytesWritten;
          const next = await inspectFile(
            temporary,
            lineage,
            output,
            null,
            "CACHE_CHANGED",
          );
          if (!same(next, state) || next.size !== BigInt(count))
            throw failure("CACHE_CHANGED");
          state = next;
        }
      }
      await source.verify();
      if (copied.copy().digest("hex") !== plan.sha256)
        throw failure("CACHE_SOURCE_CHANGED");
      await verifyTemp();
      await output.sync();
      await verifyTemp();
      if (
        (await digestFile(output, plan.bytes, verifyTemp, signal)) !==
        plan.sha256
      )
        throw failure("CACHE_CHANGED");
      await lock.verify();
      check(signal);
      try {
        await fs.link(temporary, destination);
        linked = true;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        const existing = await storedFile(plan, lineage, signal);
        if (!existing) throw failure("CACHE_CHANGED");
        await existing.handle.close();
        return;
      }
      // link is an atomic no-overwrite commit. Its own two links exist only
      // while this verified writer holds the cross-process cache lock.
      await lock.verify();
      const left = await fs.lstat(temporary, { bigint: true }),
        right = await fs.lstat(destination, { bigint: true }),
        opened = await output.stat({ bigint: true });
      if (
        !left.isFile() ||
        !right.isFile() ||
        left.isSymbolicLink() ||
        right.isSymbolicLink() ||
        !same(left, state) ||
        !same(right, state) ||
        !same(opened, state) ||
        left.nlink !== 2n ||
        right.nlink !== 2n ||
        opened.nlink !== 2n ||
        left.size !== state.size ||
        right.size !== state.size ||
        left.mtimeNs !== state.mtimeNs ||
        right.mtimeNs !== state.mtimeNs
      )
        throw failure("CACHE_CHANGED");
      await fs.unlink(temporary);
      temporaryExists = false;
      const committed = await inspectFile(
        destination,
        lineage,
        output,
        null,
        "CACHE_CHANGED",
      );
      if (!same(committed, state)) throw failure("CACHE_CHANGED");
      const verify = () =>
        inspectFile(destination, lineage, output, committed, "CACHE_CHANGED");
      if (
        (await digestFile(output, plan.bytes, verify, signal)) !== plan.sha256
      )
        throw failure("CACHE_INVALID");
      await lock.verify();
      check(signal);
    } finally {
      // Unknown, replaced, linked or changed temporary files are retained.
      if (temporaryExists && !linked && output && state) {
        try {
          await verifyTemp();
          if (
            state.size === BigInt(count) &&
            (await digestFile(output, count, verifyTemp)) ===
              copied.copy().digest("hex")
          ) {
            await output.close();
            output = null;
            await verifyTemp();
            await fs.unlink(temporary);
          }
        } catch {
          /* A fragment with uncertain ownership is never removed. */
        }
      }
      await output?.close().catch(() => {});
    }
  }
  async function locked(create, signal, action) {
    return serialized(canonical(storage), signal, async () => {
      const lineage = await storageLineage(create, signal);
      if (!lineage) return null;
      const lock = await diskLock(lineage, signal);
      try {
        check(signal);
        return await action(lineage, lock);
      } finally {
        await lock.release();
      }
    });
  }
  async function boundary(action, getSignal) {
    try {
      return await action();
    } catch (error) {
      check(getSignal?.());
      if (error?.[SAFE_ERROR]) throw error;
      throw failure("CACHE_IO");
    }
  }
  return Object.freeze({
    async put(input, options = {}) {
      let source, signal;
      return boundary(
        async () => {
          // The caller must hold a freshly verified/authorized complete plan.
          // Cache identity proves bytes only; it never grants content access.
          const plan = selectedPlan(input);
          if (!object(options)) throw failure("CACHE_INVALID_INPUT");
          const sourcePath = absolute(options.sourcePath);
          signal = signalValue(options.signal);
          if (plan.bytes > maxBytes || !maxEntries) throw failure("CACHE_FULL");
          const sourceLineage = await captureLineage(
            path.dirname(sourcePath),
            false,
            signal,
          );
          if (!sourceLineage) throw failure("CACHE_SOURCE_CHANGED");
          try {
            source = await openFile(
              sourcePath,
              sourceLineage,
              plan.bytes,
              "CACHE_SOURCE_CHANGED",
            );
            if (
              (await digestFile(
                source.handle,
                plan.bytes,
                source.verify,
                signal,
              )) !== plan.sha256
            )
              throw failure("CACHE_HASH_MISMATCH");
            await locked(true, signal, async (lineage, lock) => {
              await source.verify();
              const existing = await storedFile(plan, lineage, signal);
              if (existing) {
                await existing.handle.close();
                return;
              }
              await capacity(plan, lineage, lock, signal);
              await copyAndCommit(plan, source, lineage, lock, signal);
            });
            check(signal);
            return { bytes: plan.bytes, sha256: plan.sha256 };
          } finally {
            await source?.handle.close().catch(() => {});
          }
        },
        () => signal,
      );
    },
    async open(input, options = {}) {
      let signal;
      return boundary(
        async () => {
          const plan = selectedPlan(input);
          if (!object(options)) throw failure("CACHE_INVALID_INPUT");
          signal = signalValue(options.signal);
          let opened;
          try {
            await locked(false, signal, async (lineage, lock) => {
              opened = await storedFile(plan, lineage, signal);
              await lock.verify();
            });
            check(signal);
          } catch (error) {
            await opened?.handle.close().catch(() => {});
            throw error;
          }
          if (!opened) return null;
          let closed = false,
            released = false,
            tail = Promise.resolve();
          const serial = (action) => {
            const result = tail.then(action);
            tail = result.catch(() => {});
            return result;
          };
          return Object.freeze({
            bytes: plan.bytes,
            sha256: plan.sha256,
            read(offset, length) {
              return serial(() =>
                boundary(
                  async () => {
                    if (closed) throw failure("CACHE_CLOSED");
                    check(signal);
                    if (
                      !Number.isSafeInteger(offset) ||
                      !Number.isSafeInteger(length) ||
                      offset < 0 ||
                      length < 0 ||
                      length > MAX_READ_BYTES ||
                      offset > plan.bytes - length
                    )
                      throw failure("CACHE_INVALID_INPUT");
                    await opened.verify();
                    const buffer = Buffer.alloc(length);
                    for (let count = 0; count < length; ) {
                      check(signal);
                      await opened.verify();
                      const { bytesRead } = await opened.handle.read(
                        buffer,
                        count,
                        Math.min(BLOCK, length - count),
                        offset + count,
                      );
                      if (!bytesRead) throw failure("CACHE_CHANGED");
                      count += bytesRead;
                      await opened.verify();
                    }
                    check(signal);
                    await opened.verify();
                    return buffer;
                  },
                  () => signal,
                ),
              );
            },
            close() {
              return serial(async () => {
                if (!released) {
                  closed = true;
                  try {
                    await opened.handle.close();
                    released = true;
                  } catch {
                    throw failure("CACHE_IO");
                  }
                }
              });
            },
          });
        },
        () => signal,
      );
    },
  });
}

function createPdxArchiveCache(options = {}) {
  try {
    return buildCache(options);
  } catch {
    throw failure("CACHE_INVALID_INPUT");
  }
}

module.exports = { createPdxArchiveCache, MAX_READ_BYTES };
