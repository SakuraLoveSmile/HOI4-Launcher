"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { performance } = require("node:perf_hooks");

const BLOCK = 64 * 1024;
const CHECKPOINT_BYTES = 1024 * 1024;
const canonical = (value) =>
  process.platform === "win32"
    ? path.resolve(value).toLowerCase()
    : path.resolve(value);
const identity = (stat) => ({
  dev: String(stat.dev),
  ino: String(stat.ino),
  birthtimeNs: String(stat.birthtimeNs),
});
const same = (stat, expected) =>
  expected &&
  stat.dev.toString() === expected.dev &&
  stat.ino.toString() === expected.ino &&
  stat.birthtimeNs.toString() === expected.birthtimeNs;
const stable = (left, right) =>
  same(right, identity(left)) &&
  left.size === right.size &&
  left.mtimeNs === right.mtimeNs &&
  left.ctimeNs === right.ctimeNs &&
  right.nlink === 1n;
const validIdentity = (value) =>
  value &&
  [value.dev, value.ino, value.birthtimeNs].every(
    (part) => typeof part === "string" && /^\d{1,30}$/.test(part),
  );
const strongEtag = (value) =>
  typeof value === "string" &&
  value.length <= 1024 &&
  /^"[\x21\x23-\x7e\x80-\xff]*"$/.test(value);
const safePath = (value) =>
  typeof value === "string" &&
  path.isAbsolute(value) &&
  !/[\0-\x1f]/.test(value) &&
  !/[:<>"|?*]/.test(path.basename(value)) &&
  !/[. ]$/.test(value) &&
  !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(path.basename(value));
const clone = (value) => JSON.parse(JSON.stringify(value));

function ancestorPaths(file) {
  const result = [];
  for (
    let current = path.dirname(path.resolve(file));
    ;
    current = path.dirname(current)
  ) {
    result.unshift(current);
    if (path.dirname(current) === current) return result;
  }
}

function createPdxTransfer({
  request,
  operation,
  chunks,
  contentLength,
  cancelBody,
  failure,
  isSafeError,
  timeoutMs,
}) {
  async function ancestors(file, expected, code) {
    const paths = ancestorPaths(file);
    if (
      expected &&
      (!Array.isArray(expected) ||
        expected.length !== paths.length ||
        expected.some(
          (item, i) => item?.path !== paths[i] || !validIdentity(item),
        ))
    )
      throw failure(code);
    const result = [];
    try {
      for (let i = 0; i < paths.length; i++) {
        const stat = await fs.lstat(paths[i], { bigint: true });
        if (
          !stat.isDirectory() ||
          stat.isSymbolicLink() ||
          (expected && !same(stat, expected[i])) ||
          canonical(await fs.realpath(paths[i])) !== canonical(paths[i])
        )
          throw failure(code);
        result.push({ path: paths[i], ...identity(stat) });
      }
    } catch {
      throw failure(code);
    }
    return result;
  }

  async function inspect(file, expected, handle, code, previous) {
    try {
      await ancestors(file, expected.ancestors, code);
      const stat = await fs.lstat(file, { bigint: true });
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink !== 1n ||
        !same(stat, expected.file) ||
        canonical(await fs.realpath(file)) !== canonical(file)
      )
        throw failure(code);
      if (handle) {
        const opened = await handle.stat({ bigint: true });
        if (
          !opened.isFile() ||
          opened.nlink !== 1n ||
          !same(opened, expected.file) ||
          !stable(stat, opened)
        )
          throw failure(code);
      }
      if (previous && !stable(previous, stat)) throw failure(code);
      return stat;
    } catch {
      throw failure(code);
    }
  }

  function validateCheckpoint(checkpoint, planKey, bytes, source) {
    if (
      !checkpoint ||
      checkpoint.version !== 1 ||
      checkpoint.planKey !== planKey ||
      !Number.isSafeInteger(checkpoint.receivedBytes) ||
      checkpoint.receivedBytes < 0 ||
      checkpoint.receivedBytes > bytes ||
      !/^[0-9a-f]{64}$/.test(checkpoint.prefixSha256) ||
      (checkpoint.etag !== null && !strongEtag(checkpoint.etag)) ||
      !validIdentity(checkpoint.identity?.file)
    )
      throw failure("INVALID_CHECKPOINT");
    const paths = ancestorPaths(source);
    if (
      !Array.isArray(checkpoint.identity.ancestors) ||
      paths.length !== checkpoint.identity.ancestors.length ||
      checkpoint.identity.ancestors.some(
        (item, i) => item?.path !== paths[i] || !validIdentity(item),
      )
    )
      throw failure("INVALID_CHECKPOINT");
    return clone(checkpoint);
  }

  async function hashPrefix(handle, count, verify, check) {
    const digest = createHash("sha256"),
      buffer = Buffer.alloc(BLOCK);
    for (let offset = 0; offset < count; ) {
      check();
      await verify();
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, count - offset),
        offset,
      );
      if (!bytesRead) throw failure("SOURCE_CHANGED");
      digest.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    await verify();
    check();
    return digest;
  }

  return async function download(
    plan,
    {
      destination,
      signal,
      pauseSignal,
      onProgress,
      onCheckpoint,
      resume,
      bytesPerSecond = 0,
    } = {},
  ) {
    if (
      (onCheckpoint !== undefined && typeof onCheckpoint !== "function") ||
      (resume !== undefined &&
        (!resume ||
          !safePath(resume.source) ||
          canonical(resume.source) === canonical(destination)))
    )
      throw failure("INVALID_INPUT");
    const planKey = createHash("sha256")
      .update(JSON.stringify(plan))
      .digest("hex");
    const resumed = resume
      ? validateCheckpoint(
          resume.checkpoint,
          planKey,
          plan.bytes,
          resume.source,
        )
      : null;
    const context = operation(signal, timeoutMs, pauseSignal);
    let handle,
      own,
      currentStat,
      response,
      completed = false,
      paused = false,
      restarted = false;
    let receivedBytes = 0,
      physicalBytes = 0,
      networkBytes = 0;
    let hash = createHash("sha256"),
      etag = null,
      checkpoint = null,
      checkpointFailed = false;
    let lastSavedBytes = -1,
      lastSavedAt = performance.now();
    let networkStarted = performance.now();
    const notify = (extra = {}) => {
      try {
        const pending = onProgress?.({
          receivedBytes,
          totalBytes: plan.bytes,
          bytesPerSecond: Math.round(
            networkBytes /
              Math.max((performance.now() - networkStarted) / 1000, 0.001),
          ),
          ...(restarted ? { restarted: true } : {}),
          ...extra,
        });
        if (typeof pending?.catch === "function") pending.catch(() => {});
      } catch {
        /* Progress observers do not control integrity. */
      }
    };
    const verifyOwn = () =>
      inspect(destination, own, handle, "DESTINATION_CHANGED", currentStat);
    async function refreshOwn() {
      currentStat = await inspect(
        destination,
        own,
        handle,
        "DESTINATION_CHANGED",
      );
      if (currentStat.size !== BigInt(physicalBytes))
        throw failure("DESTINATION_CHANGED");
    }
    async function save() {
      await verifyOwn();
      await handle.sync();
      await verifyOwn();
      const next = {
        version: 1,
        planKey,
        receivedBytes,
        prefixSha256: hash.copy().digest("hex"),
        etag,
        identity: clone(own),
      };
      if (onCheckpoint) {
        try {
          await onCheckpoint(clone(next));
        } catch {
          checkpointFailed = true;
          throw failure("CHECKPOINT_ERROR");
        }
      }
      await verifyOwn();
      checkpoint = next;
      lastSavedBytes = receivedBytes;
      lastSavedAt = performance.now();
      return next;
    }
    async function writePiece(piece, countAsNetwork) {
      context.check();
      await verifyOwn();
      let offset = 0;
      while (offset < piece.length) {
        const { bytesWritten } = await handle.write(
          piece,
          offset,
          piece.length - offset,
          physicalBytes,
        );
        if (!bytesWritten) throw failure("FILE_ERROR");
        physicalBytes += bytesWritten;
        if (countAsNetwork) {
          hash.update(piece.subarray(offset, offset + bytesWritten));
          receivedBytes += bytesWritten;
          networkBytes += bytesWritten;
        }
        offset += bytesWritten;
        await refreshOwn();
        context.check();
      }
    }
    async function copyResume() {
      let input;
      try {
        const before = await inspect(
          resume.source,
          resumed.identity,
          null,
          "SOURCE_CHANGED",
        );
        if (before.size < BigInt(resumed.receivedBytes))
          throw failure("SOURCE_CHANGED");
        input = await fs.open(resume.source, "r");
        const verify = () =>
          inspect(
            resume.source,
            resumed.identity,
            input,
            "SOURCE_CHANGED",
            before,
          );
        const prefix = await hashPrefix(
          input,
          resumed.receivedBytes,
          verify,
          context.check,
        );
        if (prefix.copy().digest("hex") !== resumed.prefixSha256)
          throw failure("INVALID_CHECKPOINT");
        const copied = createHash("sha256"),
          buffer = Buffer.alloc(BLOCK);
        for (let offset = 0; offset < resumed.receivedBytes; ) {
          context.check();
          await verify();
          const { bytesRead } = await input.read(
            buffer,
            0,
            Math.min(buffer.length, resumed.receivedBytes - offset),
            offset,
          );
          if (!bytesRead) throw failure("SOURCE_CHANGED");
          const piece = buffer.subarray(0, bytesRead);
          await writePiece(piece, false);
          copied.update(piece);
          offset += bytesRead;
        }
        await verify();
        if (copied.copy().digest("hex") !== resumed.prefixSha256)
          throw failure("SOURCE_CHANGED");
        // The coordinator may remove the old source after the following save.
        await input.close();
        input = null;
        hash = copied;
        receivedBytes = resumed.receivedBytes;
        etag = resumed.etag;
        await save();
        notify();
      } finally {
        await input?.close().catch(() => {});
      }
    }
    try {
      if (signal?.aborted || !pauseSignal?.aborted) context.check();
      const chain = await ancestors(destination, null, "DESTINATION_CHANGED");
      try {
        handle = await fs.open(destination, "wx+", 0o600);
      } catch (error) {
        throw failure(
          error.code === "EEXIST" ? "DESTINATION_EXISTS" : "FILE_ERROR",
        );
      }
      own = {
        file: identity(await handle.stat({ bigint: true })),
        ancestors: chain,
      };
      await refreshOwn();
      // Zero is useful even when headers never arrive or a process dies early.
      if (onCheckpoint || pauseSignal) await save();
      context.check();
      notify();
      if (resumed) await copyResume();
      context.check();
      if (receivedBytes < plan.bytes) {
        const offset = receivedBytes;
        const headers = { "Accept-Encoding": "identity" };
        if (offset) {
          headers.Range = `bytes=${offset}-`;
          if (etag) headers["If-Range"] = etag;
        }
        networkStarted = performance.now();
        response = await request(
          plan.archiveUrl,
          context,
          "application/octet-stream",
          { headers, statuses: [200, 206, 416] },
        );
        if (response.status === 416) throw failure("RANGE_NOT_SATISFIABLE");
        const encoding = response.headers.get("content-encoding");
        if (encoding !== null && encoding.trim().toLowerCase() !== "identity")
          throw failure("ENCODING_NOT_ALLOWED");
        const responseEtag = response.headers.get("etag");
        const nextEtag = strongEtag(responseEtag) ? responseEtag : null;
        if (response.status === 206) {
          if (
            !offset ||
            response.headers.get("content-range") !==
              `bytes ${offset}-${plan.bytes - 1}/${plan.bytes}`
          )
            throw failure("RANGE_MISMATCH");
          if (contentLength(response) !== plan.bytes - offset)
            throw failure("SIZE_MISMATCH");
          if (etag && responseEtag !== etag) throw failure("ETAG_MISMATCH");
          etag = etag || nextEtag;
        } else {
          if (response.headers.get("content-range") !== null)
            throw failure("RANGE_MISMATCH");
          const length = contentLength(response);
          if (length !== null && length !== plan.bytes)
            throw failure("SIZE_MISMATCH");
          etag = nextEtag;
          if (offset) {
            await verifyOwn();
            await handle.truncate(0);
            receivedBytes = 0;
            physicalBytes = 0;
            hash = createHash("sha256");
            restarted = true;
            await refreshOwn();
            if (onCheckpoint) await save();
            notify({ restarted: true });
          }
        }
        for await (const chunk of chunks(response, context)) {
          if (receivedBytes + chunk.length > plan.bytes)
            throw failure("SIZE_MISMATCH");
          for (let offset = 0; offset < chunk.length; offset += BLOCK) {
            const piece = chunk.subarray(offset, offset + BLOCK);
            if (bytesPerSecond) {
              const target =
                ((networkBytes + piece.length) / bytesPerSecond) * 1000;
              while (target > performance.now() - networkStarted)
                await context.delay(
                  target - (performance.now() - networkStarted),
                );
            }
            await writePiece(piece, true);
            notify();
            if (
              onCheckpoint &&
              (receivedBytes - lastSavedBytes >= CHECKPOINT_BYTES ||
                performance.now() - lastSavedAt >= 1000)
            )
              await save();
          }
        }
      }
      context.check();
      if (receivedBytes !== plan.bytes) throw failure("SIZE_MISMATCH");
      if (hash.copy().digest("hex") !== plan.sha256)
        throw failure("HASH_MISMATCH");
      // Re-read the file, so successful completion verifies disk bytes too.
      const actual = await hashPrefix(
        handle,
        receivedBytes,
        verifyOwn,
        context.check,
      );
      if (actual.digest("hex") !== plan.sha256) throw failure("HASH_MISMATCH");
      if (onCheckpoint) await save();
      else {
        await handle.sync();
        await verifyOwn();
      }
      context.check();
      await handle.close();
      handle = null;
      await verifyOwn();
      context.check();
      completed = true;
      return { path: destination, bytes: receivedBytes, sha256: plan.sha256 };
    } catch (error) {
      let result = isSafeError(error)
        ? error
        : failure(
            [
              "ENOENT",
              "ENOSPC",
              "EACCES",
              "EPERM",
              "EIO",
              "EBADF",
              "EDQUOT",
              "EROFS",
              "EMFILE",
              "ENFILE",
              "ENOTDIR",
              "EISDIR",
            ].includes(error?.code)
              ? "FILE_ERROR"
              : "NETWORK_ERROR",
          );
      if (!checkpointFailed) {
        try {
          context.check();
        } catch (cancelled) {
          result = cancelled;
        }
      }
      if (
        handle &&
        own &&
        !checkpointFailed &&
        (onCheckpoint || result.code === "PAUSED")
      ) {
        try {
          await save();
        } catch (saveError) {
          result = isSafeError(saveError)
            ? saveError
            : failure("CHECKPOINT_ERROR");
        }
      }
      if (signal?.aborted) result = failure("CANCELLED");
      if (result.code === "PAUSED" && checkpoint) {
        // A pause can arrive after a write but before its normal progress event.
        // Publish the durable prefix so reopening and the visible count agree.
        notify({ bytesPerSecond: 0 });
        paused = true;
        return {
          paused: true,
          checkpoint: clone(checkpoint),
          bytes: checkpoint.receivedBytes,
        };
      }
      if (checkpoint) result.checkpoint = clone(checkpoint);
      throw result;
    } finally {
      cancelBody(response);
      await handle?.close().catch(() => {});
      handle = null;
      if (!completed && !paused && !onCheckpoint && own) {
        try {
          await inspect(destination, own, null, "DESTINATION_CHANGED");
          await fs.unlink(destination);
        } catch {
          /* Never remove a replacement or a path through changed ancestors. */
        }
      }
      context.dispose();
    }
  };
}

module.exports = { createPdxTransfer };
