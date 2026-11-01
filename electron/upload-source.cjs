"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { Readable } = require("node:stream");

function uploadError() {
  return Object.assign(
    new Error("上传文件发生变化或无法读取，请重新准备发布。"),
    { code: "UPLOAD_SOURCE_CHANGED" },
  );
}
async function openUploadSource({ filePath, bytes, sha256, check }) {
  if (
    !path.isAbsolute(filePath || "") ||
    /[\0-\x1f]/.test(filePath) ||
    !Number.isSafeInteger(bytes) ||
    bytes < 1 ||
    bytes >= 5 * 1024 ** 3 ||
    typeof sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(sha256)
  )
    throw uploadError();
  let handle;
  try {
    check();
    const before = await fs.lstat(filePath);
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1 ||
      before.size !== bytes
    )
      throw uploadError();
    handle = await fs.open(filePath, "r");
    const original = await handle.stat();
    const realPath = await fs.realpath(filePath);
    const same = (current) =>
      current.isFile() &&
      !current.isSymbolicLink() &&
      current.nlink === 1 &&
      current.ino === original.ino &&
      current.dev === original.dev &&
      current.size === bytes &&
      current.birthtimeMs === original.birthtimeMs &&
      current.mtimeMs === original.mtimeMs &&
      current.ctimeMs === original.ctimeMs;
    if (!same(before)) throw uploadError();
    async function validate() {
      check();
      if (
        !same(await handle.stat()) ||
        !same(await fs.lstat(filePath)) ||
        (await fs.realpath(filePath)) !== realPath
      )
        throw uploadError();
    }
    const digest = createHash("sha256"),
      buffer = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    while (offset < bytes) {
      check();
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, bytes - offset),
        offset,
      );
      if (!bytesRead) throw uploadError();
      offset += bytesRead;
      digest.update(buffer.subarray(0, bytesRead));
    }
    if (digest.digest("hex") !== sha256) throw uploadError();
    await validate();
    return {
      async bodyFactory(signal, onProgress) {
        await validate();
        let sent = 0,
          complete = false;
        const streamed = createHash("sha256");
        const body = Readable.from(
          (async function* () {
            while (sent < bytes) {
              check();
              signal.throwIfAborted();
              const chunk = Buffer.allocUnsafe(
                Math.min(64 * 1024, bytes - sent),
              );
              const { bytesRead } = await handle.read(
                chunk,
                0,
                chunk.length,
                sent,
              );
              if (!bytesRead) throw uploadError();
              streamed.update(chunk.subarray(0, bytesRead));
              sent += bytesRead;
              // Validate before handing fetch the final byte. A server may send
              // its success response as soon as Content-Length is satisfied.
              if (sent === bytes) {
                if (streamed.digest("hex") !== sha256) throw uploadError();
                await validate();
                complete = true;
              }
              try {
                Promise.resolve(
                  onProgress?.({ processedBytes: sent, totalBytes: bytes }),
                ).catch(() => {});
              } catch {}
              yield chunk.subarray(0, bytesRead);
            }
          })(),
          { objectMode: false, highWaterMark: 64 * 1024, signal },
        );
        // fetch owns the body but a rejected/early reply may leave an error unobserved.
        body.on("error", () => {});
        return {
          body,
          async verify() {
            if (!complete || sent !== bytes) throw uploadError();
            await validate();
          },
          dispose() {
            body.destroy();
          },
        };
      },
      close: () => handle.close(),
    };
  } catch (error) {
    await handle?.close().catch(() => {});
    throw error;
  }
}
module.exports = { openUploadSource };
