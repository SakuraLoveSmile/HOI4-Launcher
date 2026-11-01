"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { createPdxContentService } = require("../electron/pdx-content.cjs");

const BLOCK = 64 * 1024;
const data = Buffer.alloc(BLOCK * 3 + 21, 43);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const plan = (bytes = data) => ({
  modId: "1",
  revision: "12",
  name: "fixture",
  platform: "Any__Any",
  filename: "fixture.zip",
  archiveUrl:
    "https://modscontent.paradox-interactive.com/hoi4/fixture/repo/Any__Any/12/complete/fixture.zip",
  bytes: bytes.length,
  sha256: digest(bytes),
  title: "Fixture",
});
const code = (expected) => (error) => error.code === expected;
const clone = (value) => JSON.parse(JSON.stringify(value));
const missing = (file) => assert.rejects(fs.lstat(file), { code: "ENOENT" });
function queue(replies, options = {}) {
  const calls = [];
  const service = createPdxContentService({
    ...options,
    fetchImpl: async (url, init) => {
      calls.push({ url, ...init });
      assert.ok(replies.length, "Unexpected network request");
      const next = replies.shift();
      if (next instanceof Error) throw next;
      return typeof next === "function" ? next(url, init) : next;
    },
  });
  return { service, calls };
}
async function fixture(t) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "ironclad-pdx-transfer-"),
  );
  t.after(() =>
    fs.rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    }),
  );
  return {
    root,
    source: path.join(root, "source.zip"),
    destination: path.join(root, "destination.zip"),
  };
}
function partial(bytes, offset, headers = {}) {
  return new Response(bytes.subarray(offset), {
    status: 206,
    headers: {
      "content-range": `bytes ${offset}-${bytes.length - 1}/${bytes.length}`,
      "content-length": String(bytes.length - offset),
      etag: '"fixture-v1"',
      ...headers,
    },
  });
}
async function pausedFixture(t, { bytes = data, etag = '"fixture-v1"' } = {}) {
  const f = await fixture(t),
    pause = new AbortController(),
    saved = [];
  const { service, calls } = queue([
    new Response(bytes, { headers: { etag } }),
  ]);
  const result = await service.download(plan(bytes), {
    destination: f.source,
    pauseSignal: pause.signal,
    onCheckpoint: async (checkpoint) => {
      saved.push(clone(checkpoint));
    },
    onProgress(progress) {
      if (progress.receivedBytes >= BLOCK) pause.abort();
    },
  });
  assert.equal(result.paused, true);
  assert.equal(result.bytes, BLOCK);
  assert.equal(saved[0].receivedBytes, 0);
  assert.deepEqual(result.checkpoint, saved.at(-1));
  return { ...f, checkpoint: result.checkpoint, saved, calls, bytes };
}

test("pause during a disk write reports the saved prefix and zero transfer speed", async (t) => {
  const f = await fixture(t),
    pause = new AbortController(),
    progress = [];
  const open = fs.open;
  t.mock.method(fs, "open", async (...args) => {
    const handle = await open(...args);
    if (args[0] === f.destination) {
      const write = handle.write.bind(handle);
      t.mock.method(handle, "write", async (...input) => {
        const result = await write(...input);
        pause.abort();
        return result;
      });
    }
    return handle;
  });
  const { service } = queue([new Response(data)]);
  const result = await service.download(plan(), {
    destination: f.destination,
    pauseSignal: pause.signal,
    onCheckpoint() {},
    onProgress: (value) => progress.push(value),
  });
  assert.equal(result.paused, true);
  assert.equal(result.bytes, BLOCK);
  assert.equal(progress.at(-1).receivedBytes, result.checkpoint.receivedBytes);
  assert.equal(progress.at(-1).bytesPerSecond, 0);
  assert.deepEqual(await fs.readFile(f.destination), data.subarray(0, BLOCK));
});

test("pause persists a JSON checkpoint and a new service resumes an anonymous exact range", async (t) => {
  const f = await pausedFixture(t);
  const saved = [],
    progress = [];
  const { service, calls } = queue([partial(data, BLOCK)], {
    account: {
      request() {
        assert.fail("CDN must stay anonymous");
      },
    },
  });
  const result = await service.download(plan(), {
    destination: f.destination,
    resume: { source: f.source, checkpoint: clone(f.checkpoint) },
    onCheckpoint: async (cp) => saved.push(clone(cp)),
    onProgress: (p) => progress.push(p),
  });
  assert.deepEqual(result, {
    path: f.destination,
    bytes: data.length,
    sha256: digest(data),
  });
  assert.deepEqual(await fs.readFile(f.destination), data);
  assert.deepEqual(await fs.readFile(f.source), data.subarray(0, BLOCK));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers.Range, `bytes=${BLOCK}-`);
  assert.equal(calls[0].headers["If-Range"], '"fixture-v1"');
  assert.equal(calls[0].headers["Accept-Encoding"], "identity");
  assert.equal(calls[0].credentials, "omit");
  assert.equal(calls[0].redirect, "manual");
  assert.equal(new Headers(calls[0].headers).has("Authorization"), false);
  assert.equal(new Headers(calls[0].headers).has("Cookie"), false);
  assert.equal(saved[1].receivedBytes, BLOCK);
  assert.equal(saved[1].prefixSha256, f.checkpoint.prefixSha256);
  assert.notDeepEqual(saved[1].identity.file, f.checkpoint.identity.file);
  assert.ok(progress.some((p) => p.receivedBytes === BLOCK));
  assert.deepEqual(
    Object.keys(f.checkpoint).sort(),
    [
      "version",
      "planKey",
      "receivedBytes",
      "prefixSha256",
      "etag",
      "identity",
    ].sort(),
  );
  assert.match(f.checkpoint.planKey, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(
    JSON.stringify(f.checkpoint),
    /https:|token|password|authorization/i,
  );
});

test("resume copies only the registered prefix and leaves an unregistered crash tail untouched", async (t) => {
  const f = await pausedFixture(t);
  await fs.appendFile(f.source, "unregistered crash tail");
  const before = await fs.readFile(f.source);
  const { service } = queue([partial(data, BLOCK)]);
  await service.download(plan(), {
    destination: f.destination,
    resume: { source: f.source, checkpoint: f.checkpoint },
    onCheckpoint() {},
  });
  assert.deepEqual(await fs.readFile(f.source), before);
  assert.deepEqual(await fs.readFile(f.destination), data);
});

test("a verified copied prefix is published only after closing the old source", async (t) => {
  const f = await pausedFixture(t);
  let released = false;
  const { service } = queue([
    () => {
      assert.equal(released, true);
      return partial(data, BLOCK);
    },
  ]);
  await service.download(plan(), {
    destination: f.destination,
    resume: { source: f.source, checkpoint: f.checkpoint },
    async onCheckpoint(cp) {
      if (!released && cp.receivedBytes >= BLOCK) {
        await fs.unlink(f.source);
        released = true;
      }
    },
  });
  assert.equal(released, true);
  assert.deepEqual(await fs.readFile(f.destination), data);
});

test("checkpoint plan, prefix hash, byte count and identity changes fail before HTTP", async (t) => {
  const f = await pausedFixture(t);
  for (const [change, expected] of [
    [
      (cp) => {
        cp.planKey = "0".repeat(64);
      },
      "INVALID_CHECKPOINT",
    ],
    [
      (cp) => {
        cp.prefixSha256 = "0".repeat(64);
      },
      "INVALID_CHECKPOINT",
    ],
    [
      (cp) => {
        cp.receivedBytes = data.length + 1;
      },
      "INVALID_CHECKPOINT",
    ],
    [
      (cp) => {
        cp.identity.file.ino = "0";
      },
      "SOURCE_CHANGED",
    ],
    [
      (cp) => {
        cp.identity.ancestors.at(-1).ino = "0";
      },
      "SOURCE_CHANGED",
    ],
    [
      (cp) => {
        cp.identity.ancestors.pop();
      },
      "INVALID_CHECKPOINT",
    ],
    [
      (cp) => {
        cp.etag = 'W/"weak"';
      },
      "INVALID_CHECKPOINT",
    ],
  ]) {
    const checkpoint = clone(f.checkpoint);
    change(checkpoint);
    const destination = path.join(f.root, `bad-${Math.random()}.zip`);
    const { service, calls } = queue([]);
    await assert.rejects(
      service.download(plan(), {
        destination,
        resume: { source: f.source, checkpoint },
      }),
      code(expected),
    );
    assert.equal(calls.length, 0);
    await missing(destination);
  }
  assert.deepEqual(await fs.readFile(f.source), data.subarray(0, BLOCK));
});

test("same-identity prefix corruption and source truncation cannot be resumed", async (t) => {
  const f = await pausedFixture(t);
  await fs.writeFile(f.source, Buffer.alloc(BLOCK, 0));
  const { service, calls } = queue([]);
  await assert.rejects(
    service.download(plan(), {
      destination: f.destination,
      resume: { source: f.source, checkpoint: f.checkpoint },
    }),
    code("INVALID_CHECKPOINT"),
  );
  await fs.truncate(f.source, BLOCK - 1);
  await assert.rejects(
    service.download(plan(), {
      destination: f.destination,
      resume: { source: f.source, checkpoint: f.checkpoint },
    }),
    code("SOURCE_CHANGED"),
  );
  assert.equal(calls.length, 0);
});

test("source replacement and hardlinks are refused without changing either file", async (t) => {
  const f = await pausedFixture(t);
  const original = path.join(f.root, "original.zip");
  await fs.rename(f.source, original);
  await fs.writeFile(f.source, data.subarray(0, BLOCK));
  const { service, calls } = queue([]);
  await assert.rejects(
    service.download(plan(), {
      destination: f.destination,
      resume: { source: f.source, checkpoint: f.checkpoint },
    }),
    code("SOURCE_CHANGED"),
  );
  await fs.unlink(f.source);
  await fs.rename(original, f.source);
  await fs.link(f.source, original);
  await assert.rejects(
    service.download(plan(), {
      destination: f.destination,
      resume: { source: f.source, checkpoint: f.checkpoint },
    }),
    code("SOURCE_CHANGED"),
  );
  assert.equal(calls.length, 0);
  assert.deepEqual(await fs.readFile(original), data.subarray(0, BLOCK));
});

test("source ancestor replaced by a directory junction is rejected before reading CDN", async (t) => {
  const f = await pausedFixture(t);
  const moved = `${f.root}-moved`;
  t.after(async () => {
    await fs.rm(f.root, { force: true, recursive: true });
    await fs.rm(moved, { recursive: true, force: true });
  });
  await fs.rename(f.root, moved);
  await fs.symlink(
    moved,
    f.root,
    process.platform === "win32" ? "junction" : "dir",
  );
  const destination = path.join(moved, "new.zip");
  const { service, calls } = queue([]);
  await assert.rejects(
    service.download(plan(), {
      destination,
      resume: { source: f.source, checkpoint: f.checkpoint },
    }),
    code("SOURCE_CHANGED"),
  );
  assert.equal(calls.length, 0);
  assert.deepEqual(
    await fs.readFile(path.join(moved, "source.zip")),
    data.subarray(0, BLOCK),
  );
});

test("200 after Range restarts only the new target and reports the restart", async (t) => {
  const f = await pausedFixture(t),
    progress = [],
    saved = [];
  const { service, calls } = queue([
    new Response(data, {
      headers: { etag: '"replacement"', "content-length": String(data.length) },
    }),
  ]);
  await service.download(plan(), {
    destination: f.destination,
    resume: { source: f.source, checkpoint: f.checkpoint },
    onCheckpoint(cp) {
      saved.push(clone(cp));
    },
    onProgress(p) {
      progress.push(p);
    },
  });
  assert.equal(calls.length, 1);
  assert.ok(
    progress.some((p) => p.restarted === true && p.receivedBytes === 0),
  );
  assert.equal(saved[2].receivedBytes, 0);
  assert.equal(saved[2].etag, '"replacement"');
  assert.deepEqual(await fs.readFile(f.source), data.subarray(0, BLOCK));
  assert.deepEqual(await fs.readFile(f.destination), data);
});

test("no strong ETag uses manifest-bound Range without If-Range", async (t) => {
  const f = await pausedFixture(t, { etag: 'W/"weak"' });
  assert.equal(f.checkpoint.etag, null);
  const { service, calls } = queue([
    partial(data, BLOCK, { etag: 'W/"weak"' }),
  ]);
  await service.download(plan(), {
    destination: f.destination,
    resume: { source: f.source, checkpoint: f.checkpoint },
  });
  assert.equal(calls[0].headers["If-Range"], undefined);
  assert.equal(calls[0].headers.Range, `bytes=${BLOCK}-`);
});

test("range, validators, encoding, length and final archive hash are enforced without retry", async (t) => {
  const f = await pausedFixture(t);
  const cases = [
    [() => new Response(null, { status: 416 }), "RANGE_NOT_SATISFIABLE"],
    [
      () =>
        partial(data, BLOCK, {
          "content-range": `bytes 0-${data.length - 1}/${data.length}`,
        }),
      "RANGE_MISMATCH",
    ],
    [
      () =>
        partial(data, BLOCK, {
          "content-range": `bytes ${BLOCK}-${data.length - 2}/${data.length}`,
        }),
      "RANGE_MISMATCH",
    ],
    [
      () =>
        partial(data, BLOCK, {
          "content-range": `bytes ${BLOCK}-${data.length - 1}/${data.length + 1}`,
        }),
      "RANGE_MISMATCH",
    ],
    [() => partial(data, BLOCK, { etag: '"different"' }), "ETAG_MISMATCH"],
    [
      () => {
        const r = partial(data, BLOCK);
        r.headers.delete("etag");
        return r;
      },
      "ETAG_MISMATCH",
    ],
    [() => partial(data, BLOCK, { etag: 'W/"fixture-v1"' }), "ETAG_MISMATCH"],
    [
      () => partial(data, BLOCK, { "content-encoding": "gzip" }),
      "ENCODING_NOT_ALLOWED",
    ],
    [() => partial(data, BLOCK, { "content-length": "1" }), "SIZE_MISMATCH"],
    [
      () => {
        const r = partial(data, BLOCK);
        r.headers.delete("content-length");
        return r;
      },
      "SIZE_MISMATCH",
    ],
    [
      () =>
        new Response(data.subarray(BLOCK, data.length - 1), {
          status: 206,
          headers: {
            "content-range": `bytes ${BLOCK}-${data.length - 1}/${data.length}`,
            "content-length": String(data.length - BLOCK),
            etag: '"fixture-v1"',
          },
        }),
      "SIZE_MISMATCH",
    ],
    [() => partial(Buffer.alloc(data.length), BLOCK), "HASH_MISMATCH"],
    [
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://elsewhere.invalid/" },
        }),
      "REDIRECT_NOT_ALLOWED",
    ],
  ];
  for (const [reply, expected] of cases) {
    const { service, calls } = queue([reply()]);
    await assert.rejects(
      service.download(plan(), {
        destination: f.destination,
        resume: { source: f.source, checkpoint: f.checkpoint },
      }),
      code(expected),
    );
    assert.equal(calls.length, 1);
    await missing(f.destination);
    assert.deepEqual(await fs.readFile(f.source), data.subarray(0, BLOCK));
  }
});

test("a fully checkpointed archive is copied and verified with no network", async (t) => {
  const f = await fixture(t);
  let checkpoint;
  const initial = queue([new Response(data)]);
  await initial.service.download(plan(), {
    destination: f.source,
    onCheckpoint(cp) {
      checkpoint = clone(cp);
    },
  });
  assert.equal(checkpoint.receivedBytes, data.length);
  const resumed = queue([]);
  const result = await resumed.service.download(plan(), {
    destination: f.destination,
    resume: { source: f.source, checkpoint },
  });
  assert.equal(result.sha256, digest(data));
  assert.equal(resumed.calls.length, 0);
  assert.deepEqual(await fs.readFile(f.destination), data);
});

test("a completed but wrong manifest digest cannot bypass validation", async (t) => {
  const f = await fixture(t);
  let checkpoint;
  const badPlan = { ...plan(), sha256: "0".repeat(64) };
  const initial = queue([new Response(data)]);
  await assert.rejects(
    initial.service.download(badPlan, {
      destination: f.source,
      onCheckpoint(cp) {
        checkpoint = clone(cp);
      },
    }),
    code("HASH_MISMATCH"),
  );
  assert.equal(checkpoint.receivedBytes, data.length);
  const resumed = queue([]);
  await assert.rejects(
    resumed.service.download(badPlan, {
      destination: f.destination,
      resume: { source: f.source, checkpoint },
    }),
    code("HASH_MISMATCH"),
  );
  assert.equal(resumed.calls.length, 0);
});

test("pause before headers leaves a zero-byte checkpoint and aborts the request", async (t) => {
  const f = await fixture(t),
    pause = new AbortController();
  let request;
  const { service } = queue([
    (_url, init) => {
      request = init;
      pause.abort();
      return new Promise(() => {});
    },
  ]);
  const result = await service.download(plan(), {
    destination: f.source,
    pauseSignal: pause.signal,
    onCheckpoint() {},
  });
  assert.equal(result.paused, true);
  assert.equal(result.bytes, 0);
  assert.equal(result.checkpoint.prefixSha256, digest(Buffer.alloc(0)));
  assert.equal(request.signal.aborted, true);
  assert.equal((await fs.stat(f.source)).size, 0);
});

test("already paused creates a recoverable empty file without HTTP", async (t) => {
  const f = await fixture(t),
    pause = new AbortController();
  pause.abort();
  const { service, calls } = queue([]);
  const result = await service.download(plan(), {
    destination: f.source,
    pauseSignal: pause.signal,
    onCheckpoint() {},
  });
  assert.equal(result.paused, true);
  assert.equal(result.bytes, 0);
  assert.equal(calls.length, 0);
});

test("external cancellation outranks a simultaneous pause and keeps persisted bytes", async (t) => {
  const f = await fixture(t),
    pause = new AbortController(),
    cancel = new AbortController();
  const { service } = queue([new Response(data)]);
  await assert.rejects(
    service.download(plan(), {
      destination: f.source,
      signal: cancel.signal,
      pauseSignal: pause.signal,
      onCheckpoint() {},
      onProgress(p) {
        if (p.receivedBytes) {
          pause.abort();
          cancel.abort();
        }
      },
    }),
    (error) =>
      error.code === "CANCELLED" && error.checkpoint.receivedBytes === BLOCK,
  );
  assert.deepEqual(await fs.readFile(f.source), data.subarray(0, BLOCK));
});

test("network failure retains the last synced prefix and sanitizes provider errors", async (t) => {
  const f = await fixture(t);
  let read = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (read++ === 0) controller.enqueue(data.subarray(0, BLOCK));
      else controller.error(new Error("fixture-private-transport"));
    },
  });
  const { service } = queue([new Response(body)]);
  await assert.rejects(
    service.download(plan(), { destination: f.source, onCheckpoint() {} }),
    (error) => {
      assert.equal(error.code, "NETWORK_ERROR");
      assert.doesNotMatch(error.message, /fixture-private/);
      assert.equal(error.checkpoint.receivedBytes, BLOCK);
      return true;
    },
  );
  assert.deepEqual(await fs.readFile(f.source), data.subarray(0, BLOCK));
});

test("failed checkpoint persistence stops before downloading any further bytes", async (t) => {
  const f = await fixture(t);
  const noStart = queue([]);
  await assert.rejects(
    noStart.service.download(plan(), {
      destination: f.source,
      onCheckpoint() {
        throw new Error("fixture-private-disk-error");
      },
    }),
    (error) =>
      error.code === "CHECKPOINT_ERROR" &&
      !error.message.includes("fixture-private"),
  );
  assert.equal(noStart.calls.length, 0);
  assert.equal((await fs.stat(f.source)).size, 0);
  const large = Buffer.alloc(2 * 1024 * 1024, 7),
    paused = queue([new Response(large)]);
  let last;
  await assert.rejects(
    paused.service.download(plan(large), {
      destination: f.destination,
      onCheckpoint(cp) {
        if (cp.receivedBytes > 0) throw new Error("fixture-private-disk-error");
        last = cp;
      },
    }),
    (error) =>
      error.code === "CHECKPOINT_ERROR" && error.checkpoint.receivedBytes === 0,
  );
  assert.equal(last.receivedBytes, 0);
  assert.equal((await fs.stat(f.destination)).size, 1024 * 1024);
});

test("checkpoint persistence is awaited before more HTTP work", async (t) => {
  const f = await fixture(t);
  let finish,
    started = false;
  const { service, calls } = queue([
    () => {
      started = true;
      return new Response(data);
    },
  ]);
  const pending = service.download(plan(), {
    destination: f.source,
    onCheckpoint(cp) {
      if (cp.receivedBytes === 0)
        return new Promise((resolve) => {
          finish = resolve;
        });
    },
  });
  while (!finish) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(started, false);
  assert.equal(calls.length, 0);
  finish();
  await pending;
  assert.equal(started, true);
});

test("destination replacement during checkpoint does not delete the unknown replacement", async (t) => {
  const f = await fixture(t);
  let changed = false;
  const { service, calls } = queue([]);
  await assert.rejects(
    service.download(plan(), {
      destination: f.source,
      async onCheckpoint() {
        if (!changed) {
          changed = true;
          await fs.rename(f.source, path.join(f.root, "old.zip"));
          await fs.writeFile(f.source, "preserve replacement");
        }
      },
    }),
    code("DESTINATION_CHANGED"),
  );
  assert.equal(calls.length, 0);
  assert.equal(await fs.readFile(f.source, "utf8"), "preserve replacement");
});

test("legacy cleanup refuses a destination reached through a replaced ancestor junction", async (t) => {
  const f = await fixture(t),
    moved = `${f.root}-moved`;
  t.after(async () => {
    await fs.rm(f.root, { recursive: true, force: true });
    await fs.rm(moved, { recursive: true, force: true });
  });
  const originalOpen = fs.open;
  t.after(() => {
    fs.open = originalOpen;
  });
  fs.open = async (...args) => {
    const handle = await originalOpen(...args);
    if (args[0] === f.source) {
      const close = handle.close.bind(handle);
      handle.close = async () => {
        await close();
        await fs.rename(f.root, moved);
        await fs.symlink(
          moved,
          f.root,
          process.platform === "win32" ? "junction" : "dir",
        );
      };
    }
    return handle;
  };
  const { service } = queue([new Error("network failure")]);
  await assert.rejects(
    service.download(plan(), { destination: f.source }),
    code("NETWORK_ERROR"),
  );
  assert.equal((await fs.stat(path.join(moved, "source.zip"))).size, 0);
});

test("source changes during prefix verification cannot publish copied bytes", async (t) => {
  const f = await pausedFixture(t),
    saved = [];
  const originalOpen = fs.open;
  t.after(() => {
    fs.open = originalOpen;
  });
  fs.open = async (...args) => {
    const handle = await originalOpen(...args);
    if (args[0] === f.source && args[1] === "r") {
      const read = handle.read.bind(handle);
      let changed = false;
      handle.read = async (...readArgs) => {
        const result = await read(...readArgs);
        if (!changed) {
          changed = true;
          await fs.appendFile(f.source, "concurrent source change");
        }
        return result;
      };
    }
    return handle;
  };
  const { service, calls } = queue([]);
  await assert.rejects(
    service.download(plan(), {
      destination: f.destination,
      resume: { source: f.source, checkpoint: f.checkpoint },
      onCheckpoint(cp) {
        saved.push(cp);
      },
    }),
    code("SOURCE_CHANGED"),
  );
  assert.equal(calls.length, 0);
  assert.ok(saved.every((cp) => cp.receivedBytes === 0));
});

test("source ancestor becomes a junction during prefix read and is rejected", async (t) => {
  const f = await pausedFixture(t),
    sourceDir = path.join(f.root, "source-dir"),
    moved = path.join(f.root, "moved-dir");
  await fs.mkdir(sourceDir);
  // Produce a checkpoint bound to the nested source directory.
  const nestedSource = path.join(sourceDir, "source.zip"),
    pause = new AbortController();
  let checkpoint;
  const initial = queue([new Response(data)]);
  await initial.service.download(plan(), {
    destination: nestedSource,
    pauseSignal: pause.signal,
    onCheckpoint(cp) {
      checkpoint = cp;
    },
    onProgress(p) {
      if (p.receivedBytes) pause.abort();
    },
  });
  const originalOpen = fs.open;
  t.after(() => {
    fs.open = originalOpen;
  });
  fs.open = async (...args) => {
    const handle = await originalOpen(...args);
    if (args[0] === nestedSource && args[1] === "r") {
      const read = handle.read.bind(handle);
      let changed = false;
      handle.read = async (...readArgs) => {
        const result = await read(...readArgs);
        if (!changed) {
          changed = true;
          const outside = path.join(f.root, "temporary-source.zip");
          await fs.rename(nestedSource, outside);
          await fs.rename(sourceDir, moved);
          await fs.rename(outside, path.join(moved, "source.zip"));
          await fs.symlink(
            moved,
            sourceDir,
            process.platform === "win32" ? "junction" : "dir",
          );
        }
        return result;
      };
    }
    return handle;
  };
  const { service, calls } = queue([]);
  await assert.rejects(
    service.download(plan(), {
      destination: f.destination,
      resume: { source: nestedSource, checkpoint },
      onCheckpoint() {},
    }),
    code("SOURCE_CHANGED"),
  );
  assert.equal(calls.length, 0);
  assert.deepEqual(
    await fs.readFile(path.join(moved, "source.zip")),
    data.subarray(0, BLOCK),
  );
});

test("a source change during the copy pass never publishes an unverified copied prefix", async (t) => {
  const f = await pausedFixture(t),
    saved = [];
  const originalOpen = fs.open;
  t.after(() => {
    fs.open = originalOpen;
  });
  fs.open = async (...args) => {
    const handle = await originalOpen(...args);
    if (args[0] === f.source && args[1] === "r") {
      const read = handle.read.bind(handle);
      let reads = 0;
      handle.read = async (...readArgs) => {
        const result = await read(...readArgs);
        if (++reads === 2)
          await fs.appendFile(f.source, "copy-time source mutation");
        return result;
      };
    }
    return handle;
  };
  const { service, calls } = queue([]);
  await assert.rejects(
    service.download(plan(), {
      destination: f.destination,
      resume: { source: f.source, checkpoint: f.checkpoint },
      onCheckpoint(cp) {
        saved.push(cp);
      },
    }),
    code("SOURCE_CHANGED"),
  );
  assert.equal(calls.length, 0);
  assert.ok(saved.every((cp) => cp.receivedBytes === 0));
  assert.ok((await fs.stat(f.destination)).size > 0);
});

test("checkpoint failure cannot be reported as a successful pause", async (t) => {
  const f = await fixture(t),
    pause = new AbortController();
  const { service, calls } = queue([]);
  await assert.rejects(
    service.download(plan(), {
      destination: f.source,
      pauseSignal: pause.signal,
      onCheckpoint() {
        pause.abort();
        throw new Error("fixture-private-checkpoint-failure");
      },
    }),
    (error) =>
      error.code === "CHECKPOINT_ERROR" &&
      !error.message.includes("fixture-private"),
  );
  assert.equal(calls.length, 0);
});

test("pause while throttling checkpoints the received prefix and aborts promptly", async (t) => {
  const f = await fixture(t),
    pause = new AbortController();
  const { service } = queue([
    () => {
      setTimeout(() => pause.abort(), 20);
      return new Response(data);
    },
  ]);
  const before = Date.now();
  const result = await service.download(plan(), {
    destination: f.source,
    pauseSignal: pause.signal,
    bytesPerSecond: 1,
    onCheckpoint() {},
  });
  assert.equal(result.paused, true);
  assert.equal(result.bytes, 0);
  assert.ok(Date.now() - before < 1000);
});

test("timeout keeps a durable zero checkpoint while cancelling the pending headers", async (t) => {
  const f = await fixture(t);
  let pending;
  const { service } = queue(
    [
      (_url, init) => {
        pending = init;
        return new Promise(() => {});
      },
    ],
    { timeoutMs: 50 },
  );
  await assert.rejects(
    service.download(plan(), { destination: f.source, onCheckpoint() {} }),
    (error) => error.code === "TIMEOUT" && error.checkpoint.receivedBytes === 0,
  );
  assert.equal(pending.signal.aborted, true);
  assert.equal((await fs.stat(f.source)).size, 0);
});

test("already cancelled plus paused never creates a destination", async (t) => {
  const f = await fixture(t),
    pause = new AbortController(),
    cancel = new AbortController();
  pause.abort();
  cancel.abort();
  const { service, calls } = queue([]);
  await assert.rejects(
    service.download(plan(), {
      destination: f.source,
      signal: cancel.signal,
      pauseSignal: pause.signal,
      onCheckpoint() {
        assert.fail("No checkpoint before cancellation");
      },
    }),
    code("CANCELLED"),
  );
  assert.equal(calls.length, 0);
  await missing(f.source);
});

test("invalid checkpoint options fail without HTTP or destination changes", async (t) => {
  const f = await fixture(t),
    { service, calls } = queue([]);
  for (const options of [
    { onCheckpoint: true },
    { pauseSignal: {} },
    { resume: {} },
    { resume: { source: f.source, checkpoint: {} } },
    { resume: { source: "relative.zip", checkpoint: {} } },
  ]) {
    await assert.rejects(
      service.download(plan(), { destination: f.source, ...options }),
      code("INVALID_INPUT"),
    );
  }
  await missing(f.source);
  assert.equal(calls.length, 0);
});

test("time spent copying a resume prefix does not create an unthrottled network allowance", async (t) => {
  const bytes = Buffer.alloc(BLOCK + 22, 4),
    f = await pausedFixture(t, { bytes });
  let requested;
  const { service } = queue([
    () => {
      requested = Date.now();
      return partial(bytes, BLOCK);
    },
  ]);
  await service.download(plan(bytes), {
    destination: f.destination,
    resume: { source: f.source, checkpoint: f.checkpoint },
    bytesPerSecond: 220,
    async onCheckpoint(cp) {
      if (cp.receivedBytes === BLOCK)
        await new Promise((resolve) => setTimeout(resolve, 120));
    },
  });
  assert.ok(Date.now() - requested >= 90);
});
