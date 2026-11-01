"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const { createHash, randomBytes } = require("node:crypto");
const { createAccountService } = require("../electron/account-service.cjs");

const digest = (value) => createHash("sha256").update(value).digest("hex");
const response = (value) =>
  new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
  });
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function fixture(
  t,
  handler,
  { bytes = 1024 * 1024 + 7, uploadTimeoutMs = 5000 } = {},
) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "ironclad-upload-transport-"),
  );
  const filePath = path.join(root, "content.zip"),
    data = randomBytes(bytes);
  await fs.writeFile(filePath, data);
  const records = [],
    putOptions = [],
    transportErrors = [],
    fetchErrors = [],
    sourceHandles = [],
    sockets = new Set();
  let renewals = 0;
  const server = http.createServer((request, reply) => {
    const hasher = createHash("sha256");
    let endResolve;
    const record = {
      request,
      reply,
      index: records.length,
      headers: request.headers,
      receivedBytes: 0,
      hash: null,
      ended: false,
      responseClosed: false,
      done: new Promise((resolve) => {
        endResolve = resolve;
      }),
    };
    records.push(record);
    request.on("data", (chunk) => {
      record.receivedBytes += chunk.length;
      hasher.update(chunk);
    });
    request.once("end", () => {
      record.ended = true;
      record.hash = hasher.digest("hex");
      endResolve();
    });
    request.once("aborted", endResolve);
    request.on("error", () => {});
    reply.on("error", () => {});
    reply.once("close", () => {
      record.responseClosed = true;
    });
    Promise.resolve(handler(request, reply, record)).catch((error) => {
      transportErrors.push(error);
      reply.destroy();
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const endpoint = `http://127.0.0.1:${server.address().port}/upload`;
  const realOpen = fs.open;
  const openHook = t.mock.method(fs, "open", async (filename, ...args) => {
    const handle = await realOpen(filename, ...args);
    if (filename === filePath && args[0] === "r") sourceHandles.push(handle);
    return handle;
  });
  const service = createAccountService({
    sessionPath: path.join(root, "session.json"),
    uploadTimeoutMs,
    fetchImpl: async (url, options) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/accounts/sessions/launcher-v2") {
        const auth = JSON.parse(options.headers.Authorization);
        if (auth.renewal) renewals++;
        return response({
          session: {
            token: `fixture-access-${renewals}`,
            refresh_token: "fixture-renewal",
            userid: "fixture-user",
          },
        });
      }
      if (parsed.pathname === "/accountdetails")
        return response({
          account: { email: "fixture@example.invalid", username: "Fixture" },
        });
      assert.equal(parsed.origin, "https://api.paradox-interactive.com");
      assert.match(parsed.pathname, /^\/mods\/content\/hoi4\//);
      putOptions.push(options);
      let native;
      try {
        native = await fetch(endpoint, options);
      } catch (error) {
        fetchErrors.push(error);
        throw error;
      }
      // Only the URL assertion is adapted: the body, duplex, headers, signal and
      // native HTTP response stream all run through real Node fetch.
      return new Response(native.body, {
        status: native.status,
        headers: native.headers,
      });
    },
  });
  t.after(async () => {
    await service.logout().catch(() => {});
    openHook.mock.restore();
    const closed = new Promise((resolve) => server.close(resolve));
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections();
    await closed;
    await fs.rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
    assert.deepEqual(
      transportErrors,
      [],
      "the local HTTP fixture must not hide handler failures",
    );
  });
  await service.login({
    email: "fixture@example.invalid",
    password: "fixture-password",
  });
  const input = {
    path: "/mods/content/hoi4/fixture-publication/content/content.zip",
    filePath,
    bytes: data.length,
    sha256: digest(data),
    expectedAccountId: "fixture-user",
  };
  const assertClosed = () => {
    assert.ok(sourceHandles.length > 0);
    assert.ok(
      sourceHandles.every((handle) => handle.fd === -1),
      "all real source file handles must close when upload settles",
    );
  };
  return {
    root,
    filePath,
    data,
    input,
    service,
    records,
    putOptions,
    transportErrors,
    fetchErrors,
    sourceHandles,
    assertClosed,
    renewals: () => renewals,
  };
}

test(
  "native fetch sends exact Content-Length bytes and accepts a receipt immediately after request end",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t, async (_request, reply, record) => {
      await record.done;
      reply.writeHead(204);
      reply.end();
    });
    const progress = [];
    assert.equal(
      await f.service.uploadFile({
        ...f.input,
        onProgress: (value) => progress.push(value),
      }),
      null,
    );
    assert.equal(f.records.length, 1);
    assert.equal(f.records[0].headers["content-length"], String(f.data.length));
    assert.equal(f.records[0].headers["transfer-encoding"], undefined);
    assert.equal(f.records[0].receivedBytes, f.data.length);
    assert.equal(f.records[0].hash, f.input.sha256);
    assert.equal(f.putOptions[0].duplex, "half");
    assert.ok(progress.length > 1);
    assert.equal(progress.at(-1).processedBytes, f.data.length);
    assert.ok(
      progress.every(
        (value, index) =>
          value.totalBytes === f.data.length &&
          (!index ||
            value.processedBytes >= progress[index - 1].processedBytes),
      ),
    );
    f.assertClosed();
  },
);

test(
  "an early native HTTP 401 causes one renewal and a complete independent PUT replay",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(
      t,
      async (_request, reply, record) => {
        if (record.index === 0) {
          reply.writeHead(401, { "Content-Type": "application/json" });
          reply.end('{"error":"expired"}');
          return;
        }
        await record.done;
        reply.writeHead(204);
        reply.end();
      },
      { bytes: 8 * 1024 * 1024 },
    );
    assert.equal(await f.service.uploadFile(f.input), null);
    assert.equal(f.renewals(), 1);
    assert.equal(f.records.length, 2);
    assert.notEqual(f.putOptions[0].body, f.putOptions[1].body);
    assert.ok(f.records[0].receivedBytes < f.data.length);
    assert.equal(f.records[1].receivedBytes, f.data.length);
    assert.equal(f.records[1].hash, f.input.sha256);
    assert.equal(
      JSON.parse(f.records[1].headers.authorization).session.token,
      "fixture-access-1",
    );
    f.assertClosed();
  },
);

test(
  "an early native HTTP success cannot accept a body that was not sent completely",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(
      t,
      (_request, reply) => {
        reply.writeHead(204);
        reply.end();
      },
      { bytes: 8 * 1024 * 1024 },
    );
    await assert.rejects(f.service.uploadFile(f.input), {
      code: "UPLOAD_SOURCE_CHANGED",
    });
    assert.equal(f.records.length, 1);
    assert.ok(f.records[0].receivedBytes < f.data.length);
    assert.equal(f.renewals(), 0);
    f.assertClosed();
  },
);

test(
  "cancelling after real socket traffic aborts transfer and closes the source FD",
  { timeout: 10000 },
  async (t) => {
    const controller = new AbortController();
    const f = await fixture(
      t,
      (request) => {
        request.once("data", () => controller.abort());
      },
      { bytes: 8 * 1024 * 1024 },
    );
    await assert.rejects(
      f.service.uploadFile({ ...f.input, signal: controller.signal }),
      { code: "CANCELLED" },
    );
    assert.equal(f.records.length, 1);
    assert.ok(f.records[0].receivedBytes > 0);
    assert.ok(f.records[0].receivedBytes < f.data.length);
    f.assertClosed();
  },
);

test(
  "native fetch timeout after a consumed body terminates the waiting request and closes the FD",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(
      t,
      async (_request, _reply, record) => {
        await record.done;
      },
      { uploadTimeoutMs: 120 },
    );
    await assert.rejects(f.service.uploadFile(f.input), { code: "TIMEOUT" });
    assert.equal(f.records[0].receivedBytes, f.data.length);
    f.assertClosed();
  },
);

test(
  "a native socket failure stays a network error and closes the source FD",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(
      t,
      (request) => {
        request.once("data", () => request.socket.destroy());
      },
      { bytes: 8 * 1024 * 1024 },
    );
    await assert.rejects(f.service.uploadFile(f.input), {
      code: "NETWORK_ERROR",
    });
    assert.equal(f.records.length, 1);
    assert.equal(f.renewals(), 0);
    f.assertClosed();
  },
);

test(
  "file mutation during native transfer reports a source change rather than a network failure",
  { timeout: 10000 },
  async (t) => {
    let f,
      mutated = false;
    f = await fixture(
      t,
      async (request, reply, record) => {
        await new Promise((resolve) => {
          request.once("data", () => {
            request.pause();
            resolve();
          });
        });
        const handle = await fs.open(f.filePath, "r+");
        try {
          await handle.write(
            Buffer.from("altered source bytes"),
            0,
            20,
            f.data.length - 4096,
          );
          mutated = true;
        } finally {
          await handle.close();
          request.resume();
        }
        await record.done;
        if (record.ended) {
          await new Promise((resolve) => setTimeout(resolve, 25));
          if (!reply.destroyed) {
            reply.writeHead(204);
            reply.end();
          }
        }
      },
      { bytes: 8 * 1024 * 1024 },
    );
    await assert.rejects(f.service.uploadFile(f.input), (error) => {
      assert.equal(
        error.code,
        "UPLOAD_SOURCE_CHANGED",
        `native fetch causes: ${f.fetchErrors.map((nativeError) => nativeError.cause?.code || nativeError.cause?.name || nativeError.name).join(", ")}`,
      );
      return true;
    });
    assert.equal(mutated, true);
    f.assertClosed();
  },
);

test(
  "a source changed before a native 401 response cannot be retransmitted",
  { timeout: 10000 },
  async (t) => {
    let f;
    f = await fixture(
      t,
      async (request, reply) => {
        request.pause();
        const handle = await fs.open(f.filePath, "r+");
        try {
          await handle.write(
            Buffer.from("changed"),
            0,
            7,
            f.data.length - 4096,
          );
        } finally {
          await handle.close();
        }
        reply.writeHead(401);
        reply.end();
        request.resume();
      },
      { bytes: 8 * 1024 * 1024 },
    );
    await assert.rejects(f.service.uploadFile(f.input), {
      code: "UPLOAD_SOURCE_CHANGED",
    });
    assert.equal(f.records.length, 1);
    assert.equal(f.renewals(), 1);
    f.assertClosed();
  },
);

test(
  "a 401 response body is cancelled before replay so its unfinished socket is released",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t, async (_request, reply, record) => {
      await record.done;
      if (record.index === 0) {
        reply.writeHead(401, { "Content-Type": "application/json" });
        reply.write('{"error":"expired",');
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
      reply.writeHead(204);
      reply.end();
    });
    assert.equal(await f.service.uploadFile(f.input), null);
    for (let i = 0; i < 20 && !f.records[0].responseClosed; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(
      f.records[0].responseClosed,
      true,
      "an unconsumed 401 body must not keep a request alive until the upload timeout",
    );
    assert.equal(f.records[1].receivedBytes, f.data.length);
    f.assertClosed();
    await tick();
  },
);
