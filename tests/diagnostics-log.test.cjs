"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { randomUUID } = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const {
  createDiagnosticsLog,
  sanitizeDiagnosticEvent,
} = require("../electron/diagnostics-log.cjs");

const execFileAsync = promisify(execFile);
const TEMP_PREFIX = "ironclad-diagnostics-log-test-";
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const AT = "2026-10-29T01:02:03.000Z";
const MANAGED_NAME =
  /^session-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-(\d{6})\.jsonl$/i;

function event(detail = "saved", overrides = {}) {
  return {
    at: AT,
    action: "launcher:save",
    result: "ok",
    detail,
    ...overrides,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function bounded(promise, ms = 1000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`diagnostic operation exceeded ${ms} ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function handleProxy(handle, overrides) {
  return new Proxy(handle, {
    get(target, name) {
      if (Object.hasOwn(overrides, name)) return overrides[name];
      const value = Reflect.get(target, name, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function openWith(wrap) {
  return {
    async open(...args) {
      const handle = await fs.open(...args);
      return wrap(handle, ...args);
    },
  };
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), TEMP_PREFIX));
  const logs = [];
  const beforeCleanup = [];
  const storageDirectory = path.join(root, "logs");
  t.after(async () => {
    for (const clean of beforeCleanup.reverse()) await clean();
    for (const log of logs) await bounded(log.close(), 3000);
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith(TEMP_PREFIX));
    await fs.rm(resolved, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  });
  return {
    root,
    storageDirectory,
    beforeCleanup,
    create(options = {}) {
      const log = createDiagnosticsLog({ storageDirectory, ...options });
      logs.push(log);
      return log;
    },
  };
}

async function history(directory, events, options = {}) {
  await fs.mkdir(directory, { recursive: true });
  const sessionId = options.sessionId || randomUUID();
  const part = options.part ?? 1;
  const name = `session-${sessionId}-${String(part).padStart(6, "0")}.jsonl`;
  const header = {
    format: "IRONCLAD-DIAGNOSTIC-EVENTS",
    schemaVersion: 1,
    sessionId,
    part,
    createdAt: options.createdAt || AT,
    ...options.header,
  };
  const text =
    [header, ...events].map((item) => JSON.stringify(item)).join("\n") +
    "\n" +
    (options.tail || "");
  const file = path.join(directory, name);
  await fs.writeFile(file, text, { flag: "wx" });
  return { name, file, text, sessionId, part };
}

function allEvents(snapshot) {
  return snapshot.files.flatMap((file) => file.events);
}

async function overwriteSameLength(file, bytes) {
  const before = await fs.stat(file);
  assert.equal(bytes.length, before.size);
  const handle = await fs.open(file, "r+");
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  // Make the metadata change deterministic even on coarse timestamp filesystems.
  await fs.utimes(file, before.atime, new Date(before.mtimeMs + 10000));
  const after = await fs.stat(file);
  assert.equal(after.dev, before.dev);
  assert.equal(after.ino, before.ino);
  assert.equal(after.size, before.size);
  assert.notEqual(after.mtimeMs, before.mtimeMs);
}

function assertUnavailable(status) {
  assert.equal(status.available, false);
  assert.equal(typeof status.reason, "string");
  assert.ok(status.reason.length > 0);
  assert.ok(Array.isArray(status.issues));
}

async function symlinkOrSkip(t, target, link, type) {
  try {
    await fs.symlink(target, link, type);
    return true;
  } catch (error) {
    if (["EPERM", "EACCES", "ENOSYS"].includes(error.code)) {
      t.skip(`This filesystem does not permit ${type} links (${error.code})`);
      return false;
    }
    throw error;
  }
}

test("construction performs no filesystem I/O and limits cannot exceed defaults", async (t) => {
  const f = await fixture(t);
  let ioCalls = 0;
  const fileOps = Object.fromEntries(
    Object.entries(fs)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => [
        name,
        async () => {
          ioCalls += 1;
          throw new Error("construction must not touch storage");
        },
      ]),
  );
  f.create({ fileOps });
  assert.equal(ioCalls, 0);
  await assert.rejects(fs.stat(f.storageDirectory), { code: "ENOENT" });

  const log = f.create({
    maxFileBytes: MAX_FILE_BYTES * 2,
    maxFiles: 99,
    maxPending: 9999,
  });
  assert.equal(log.record(event()), true);
  const snapshot = await log.snapshot();
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.directory, f.storageDirectory);
  assert.ok(snapshot.limits.maxFileBytes <= MAX_FILE_BYTES);
  assert.ok(snapshot.limits.maxFiles <= 3);
  assert.ok(snapshot.limits.maxPending <= 64);
});

test("sanitization keeps only canonical fields and strips account details", () => {
  for (const input of [null, undefined, false, "raw IPC input", [], {}]) {
    assert.equal(sanitizeDiagnosticEvent(input), null);
  }
  const raw = {
    ...event("ordinary failure", { result: "error" }),
    password: "outside-field-password",
    input: { token: "raw-ipc-token" },
    account: "private account",
  };
  const sanitized = sanitizeDiagnosticEvent(raw);
  assert.deepEqual(sanitized, event("ordinary failure", { result: "error" }));
  assert.notEqual(sanitized, raw);
  for (const action of ["account:login", "account:logout", "account:state"]) {
    const clean = sanitizeDiagnosticEvent(
      event("person@example.invalid password=account-secret", { action }),
    );
    assert.ok(clean);
    assert.ok(!clean.detail);
    assert.doesNotMatch(JSON.stringify(clean), /person@|account-secret/);
  }
});

test("credential patterns are removed and diagnostic text is bounded", () => {
  const secrets = [
    "bearerCanary123",
    "passwordCanary123",
    "tokenCanary123",
    "accessCanary123",
    "refreshCanary123",
    "jsonCanary123",
  ];
  const clean = sanitizeDiagnosticEvent(
    event(
      'request failed: Bearer bearerCanary123 password=passwordCanary123 token=tokenCanary123 access_token=accessCanary123 refresh_token=refreshCanary123 {"password":"jsonCanary123"}',
      { result: "error" },
    ),
  );
  assert.ok(clean);
  for (const secret of secrets)
    assert.ok(!JSON.stringify(clean).includes(secret));
  assert.match(clean.detail, /request failed/);
  const long = sanitizeDiagnosticEvent(event("甲😀".repeat(1200)));
  assert.ok(long.detail.length <= 1000);
  assert.equal(Buffer.from(long.detail).toString("utf8"), long.detail);
});

test("authorization variants and escaped JSON credentials never expose remaining secret bytes", () => {
  const cases = [
    ["Authorization: Basic CANARY_BASIC_123", "CANARY_BASIC_123"],
    ["Proxy-Authorization: Basic CANARY_PROXY_123", "CANARY_PROXY_123"],
    ["client_secret=CANARY_CLIENT_123", "CANARY_CLIENT_123"],
    [
      JSON.stringify({ password: 'prefix"CANARY_QUOTED_123' }),
      "CANARY_QUOTED_123",
    ],
    [
      JSON.stringify({ password: 'prefix\\path"CANARY_BACKSLASH_123' }),
      "CANARY_BACKSLASH_123",
    ],
    [
      JSON.stringify({ client_secret: 'prefix\\"CANARY_CLIENT_ESC_123' }),
      "CANARY_CLIENT_ESC_123",
    ],
  ];
  for (const [credential, secret] of cases) {
    const clean = sanitizeDiagnosticEvent(
      event(`request failed: ${credential}`, { result: "error" }),
    );
    assert.ok(clean);
    assert.ok(!JSON.stringify(clean).includes(secret), secret);
    assert.match(clean.detail, /request failed/);
  }
});

test("accepted events are copied, written in order, and synced before flush resolves", async (t) => {
  const f = await fixture(t);
  let syncs = 0;
  const log = f.create({
    fileOps: openWith((handle) =>
      handleProxy(handle, {
        async sync() {
          syncs += 1;
          return handle.sync();
        },
        async datasync() {
          syncs += 1;
          return handle.datasync();
        },
      }),
    ),
  });
  const input = event("first");
  assert.equal(log.record(input), true);
  input.detail = "mutated-after-record";
  assert.equal(log.record(event("second")), true);
  assert.equal(log.record(event("third")), true);
  const status = await log.flush();
  assert.equal(status.available, true);
  assert.equal(status.reason, null);
  assert.equal(status.writeFailures, 0);
  assert.ok(syncs > 0);
  const names = await fs.readdir(f.storageDirectory);
  assert.equal(names.length, 1);
  const match = MANAGED_NAME.exec(names[0]);
  assert.ok(match);
  const text = await fs.readFile(
    path.join(f.storageDirectory, names[0]),
    "utf8",
  );
  assert.ok(text.endsWith("\n"));
  const [header, ...written] = text.trimEnd().split("\n").map(JSON.parse);
  assert.equal(header.format, "IRONCLAD-DIAGNOSTIC-EVENTS");
  assert.equal(header.schemaVersion, 1);
  assert.equal(header.sessionId, match[1]);
  assert.equal(header.part, Number(match[2]));
  assert.ok(Number.isFinite(Date.parse(header.createdAt)));
  assert.deepEqual(written, [event("first"), event("second"), event("third")]);
  assert.deepEqual(allEvents(await log.snapshot()), written);
});

test("a new instance recovers earlier sessions without duplicating their events", async (t) => {
  const f = await fixture(t);
  const first = f.create({ now: () => Date.parse(AT) });
  first.record(event("previous-session"));
  const before = await first.snapshot();
  await first.close();
  const oldFile = path.join(f.storageDirectory, before.files[0].name);
  const oldBytes = await fs.readFile(oldFile);
  const second = f.create({ now: () => Date.parse(AT) + 1000 });
  second.record(event("current-session"));
  const after = await second.snapshot();
  assert.equal(after.status.available, true);
  assert.equal(new Set(after.files.map((file) => file.sessionId)).size, 2);
  assert.deepEqual(
    allEvents(after)
      .map((item) => item.detail)
      .sort(),
    ["current-session", "previous-session"],
  );
  assert.deepEqual(await fs.readFile(oldFile), oldBytes);
  assert.deepEqual(allEvents(await second.snapshot()), allEvents(after));
});

test("flushed data survives a separate system Node process exiting without close", async (t) => {
  const f = await fixture(t);
  const modulePath = path.resolve(__dirname, "../electron/diagnostics-log.cjs");
  const source = [
    "const { createDiagnosticsLog } = require(process.argv[1]);",
    "const log = createDiagnosticsLog({ storageDirectory: process.argv[2] });",
    `log.record(${JSON.stringify(event("child-flushed"))});`,
    "log.flush().then(status => process.exit(status.available ? 0 : 2), () => process.exit(3));",
  ].join("\n");
  await execFileAsync(
    process.execPath,
    ["-e", source, modulePath, f.storageDirectory],
    {
      windowsHide: true,
      timeout: 5000,
      maxBuffer: 8192,
    },
  );
  const log = f.create();
  const snapshot = await log.snapshot();
  assert.equal(snapshot.status.available, true);
  assert.deepEqual(allEvents(snapshot), [event("child-flushed")]);
});

test("rotation stays within byte and file limits while preserving unknown files", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(f.storageDirectory);
  const unknown = path.join(
    f.storageDirectory,
    "session-not-a-uuid-000001.jsonl",
  );
  await fs.writeFile(unknown, "not owned by the logger");
  const log = f.create({ maxFileBytes: 1024, maxFiles: 2 });
  for (let i = 0; i < 12; i += 1) {
    assert.equal(log.record(event(`${i}: ${"x".repeat(300)}`)), true);
  }
  const snapshot = await log.snapshot();
  assert.equal(snapshot.status.available, true);
  assert.deepEqual(snapshot.limits, {
    maxFileBytes: 1024,
    maxFiles: 2,
    maxPending: 64,
  });
  assert.equal(snapshot.files.length, 2);
  assert.ok(allEvents(snapshot).at(-1).detail.startsWith("11: "));
  const parts = snapshot.files.map((file) => file.part).sort((a, b) => a - b);
  assert.equal(parts[1], parts[0] + 1);
  const managed = (await fs.readdir(f.storageDirectory)).filter((name) =>
    MANAGED_NAME.test(name),
  );
  assert.equal(managed.length, 2);
  for (const name of managed) {
    assert.ok(
      (await fs.stat(path.join(f.storageDirectory, name))).size <= 1024,
    );
  }
  assert.equal(await fs.readFile(unknown, "utf8"), "not owned by the logger");
});

test("retention removes oldest verified sessions and leaves unknown files intact", async (t) => {
  const f = await fixture(t);
  const records = [];
  for (let i = 0; i < 3; i += 1) {
    records.push(
      await history(f.storageDirectory, [event(`old-${i}`)], {
        createdAt: new Date(Date.parse(AT) + i * 1000).toISOString(),
      }),
    );
  }
  const unknown = path.join(f.storageDirectory, "notes.txt");
  await fs.writeFile(unknown, "preserve me");
  const log = f.create({ maxFiles: 2, now: () => Date.parse(AT) + 5000 });
  log.record(event("latest"));
  const snapshot = await log.snapshot();
  assert.equal(snapshot.status.available, true);
  assert.equal(snapshot.files.length, 2);
  assert.deepEqual(
    allEvents(snapshot)
      .map((item) => item.detail)
      .sort(),
    ["latest", "old-2"],
  );
  await assert.rejects(fs.stat(records[0].file), { code: "ENOENT" });
  await assert.rejects(fs.stat(records[1].file), { code: "ENOENT" });
  assert.equal(await fs.readFile(unknown, "utf8"), "preserve me");
});

test("retention preserves a log changed in place after scanning instead of unlinking it", async (t) => {
  const f = await fixture(t);
  const records = [];
  for (let index = 0; index < 3; index += 1) {
    records.push(
      await history(f.storageDirectory, [event(`history-${index}`)], {
        createdAt: new Date(Date.parse(AT) + index * 1000).toISOString(),
      }),
    );
  }
  const oldest = records[0];
  const corruptBytes = Buffer.from(oldest.text);
  corruptBytes[0] = 0x21;
  const managedPaths = new Set(records.map((item) => item.file));
  const scanned = new Set();
  const unlinks = [];
  let changed = false;
  const log = f.create({
    maxFiles: 2,
    fileOps: {
      ...openWith((handle, file, flags) => {
        if (flags !== "r" || !managedPaths.has(String(file))) return handle;
        return handleProxy(handle, {
          async close() {
            await handle.close();
            scanned.add(String(file));
          },
        });
      }),
      async lstat(file, ...args) {
        // All history handles have closed: inject at the next oldest-file
        // identity check, between the completed scan and its retention unlink.
        if (
          !changed &&
          String(file) === oldest.file &&
          scanned.size === records.length
        ) {
          changed = true;
          await overwriteSameLength(oldest.file, corruptBytes);
        }
        return fs.lstat(file, ...args);
      },
      async unlink(file, ...args) {
        unlinks.push(String(file));
        return fs.unlink(file, ...args);
      },
    },
  });
  assert.equal(log.record(event("must-not-persist-after-tampering")), true);
  const status = await bounded(log.flush());
  assert.equal(changed, true, "the scan-to-prune race was exercised");
  assertUnavailable(status);
  assert.deepEqual(unlinks, []);
  assert.deepEqual(await fs.readFile(oldest.file), corruptBytes);
  assert.deepEqual(
    (await fs.readdir(f.storageDirectory)).sort(),
    records.map((item) => item.name).sort(),
  );
});

test("an incomplete final line exposes only the verified prefix and is not rewritten", async (t) => {
  const f = await fixture(t);
  const previous = await history(f.storageDirectory, [event("complete")], {
    tail: '{"at":"2026-10-29',
  });
  const log = f.create();
  log.record(event("new-session"));
  const snapshot = await log.snapshot();
  assert.equal(snapshot.status.available, true);
  const recovered = snapshot.files.find((file) => file.name === previous.name);
  assert.ok(recovered);
  assert.equal(recovered.truncated, true);
  assert.deepEqual(recovered.events, [event("complete")]);
  assert.equal(await fs.readFile(previous.file, "utf8"), previous.text);
  assert.deepEqual(
    allEvents(snapshot)
      .map((item) => item.detail)
      .sort(),
    ["complete", "new-session"],
  );
});

test("a final UTF-8 character cut after one or two bytes preserves the complete event prefix", async (t) => {
  for (const byteCount of [1, 2]) {
    const f = await fixture(t);
    const previous = await history(f.storageDirectory, [
      event("complete-prefix"),
    ]);
    const tail = Buffer.concat([
      Buffer.from(JSON.stringify(event("unfinished-tail-")).slice(0, -2)),
      Buffer.from("😀").subarray(0, byteCount),
    ]);
    await fs.appendFile(previous.file, tail);
    const originalBytes = await fs.readFile(previous.file);
    const log = f.create();
    assert.equal(log.record(event("new-session")), true);
    const snapshot = await log.snapshot();
    assert.equal(
      snapshot.status.available,
      true,
      `${byteCount}-byte UTF-8 tail`,
    );
    const recovered = snapshot.files.find(
      (file) => file.name === previous.name,
    );
    assert.ok(recovered);
    assert.equal(recovered.truncated, true);
    assert.deepEqual(recovered.events, [event("complete-prefix")]);
    assert.deepEqual(
      allEvents(snapshot)
        .map((item) => item.detail)
        .sort(),
      ["complete-prefix", "new-session"],
    );
    assert.doesNotMatch(
      JSON.stringify(snapshot.files),
      /unfinished-tail|\ufffd/,
    );
    assert.deepEqual(await fs.readFile(previous.file), originalBytes);
  }
});

test("the oldest verified truncated log can expire under normal retention pressure", async (t) => {
  const f = await fixture(t);
  const oldest = await history(f.storageDirectory, [event("old-truncated")], {
    tail: '{"detail":"unfinished',
    createdAt: AT,
  });
  const newer = await history(f.storageDirectory, [event("newer-complete")], {
    createdAt: new Date(Date.parse(AT) + 1000).toISOString(),
  });
  const unknown = path.join(f.storageDirectory, "not-a-managed-log.jsonl");
  await fs.writeFile(unknown, "unknown content must remain");
  const log = f.create({ maxFiles: 2, now: () => Date.parse(AT) + 5000 });
  const before = await log.snapshot();
  assert.equal(before.status.available, true);
  assert.equal(
    before.files.find((file) => file.name === oldest.name).truncated,
    true,
  );
  assert.equal(await fs.readFile(oldest.file, "utf8"), oldest.text);

  assert.equal(log.record(event("latest-session")), true);
  const after = await log.snapshot();
  assert.equal(after.status.available, true);
  assert.equal(after.files.length, 2);
  assert.deepEqual(
    allEvents(after)
      .map((item) => item.detail)
      .sort(),
    ["latest-session", "newer-complete"],
  );
  await assert.rejects(fs.stat(oldest.file), { code: "ENOENT" });
  assert.equal(await fs.readFile(newer.file, "utf8"), newer.text);
  assert.equal(
    await fs.readFile(unknown, "utf8"),
    "unknown content must remain",
  );
});

test("complete corruption and unknown headers are preserved and stop further writes", async (t) => {
  for (const kind of [
    "malformed-line",
    "unknown-header",
    "mismatched-identity",
  ]) {
    await t.test(kind, async (t) => {
      const f = await fixture(t);
      const options =
        kind === "malformed-line"
          ? { tail: "{not-valid-json}\n" }
          : kind === "unknown-header"
            ? { header: { format: "UNRELATED-FORMAT" } }
            : { header: { sessionId: randomUUID() } };
      const previous = await history(
        f.storageDirectory,
        [event("verified-prefix")],
        options,
      );
      const log = f.create({ maxFiles: 1 });
      assert.doesNotThrow(() => log.record(event("must-not-persist")));
      const status = await bounded(log.flush());
      assertUnavailable(status);
      const snapshot = await bounded(log.snapshot());
      assert.ok(
        allEvents(snapshot).every((item) => item.detail === "verified-prefix"),
      );
      if (kind !== "malformed-line") assert.equal(snapshot.files.length, 0);
      assert.equal(await fs.readFile(previous.file, "utf8"), previous.text);
      assert.deepEqual(await fs.readdir(f.storageDirectory), [previous.name]);
    });
  }
});

test("directory junctions and linked ancestors cannot redirect diagnostic writes", async (t) => {
  for (const ancestor of [false, true]) {
    await t.test(
      ancestor ? "linked parent" : "linked log directory",
      async (t) => {
        const f = await fixture(t);
        const target = path.join(f.root, "untouched-target");
        await fs.mkdir(target);
        const sentinel = path.join(target, "sentinel.txt");
        await fs.writeFile(sentinel, "external marker");
        const link = path.join(f.root, "redirect");
        if (!(await symlinkOrSkip(t, target, link, "junction"))) return;
        const log = f.create({
          storageDirectory: ancestor ? path.join(link, "nested") : link,
        });
        log.record(event("must-not-follow-link"));
        assertUnavailable(await bounded(log.flush()));
        assert.deepEqual(await fs.readdir(target), ["sentinel.txt"]);
        assert.equal(await fs.readFile(sentinel, "utf8"), "external marker");
        assert.equal(allEvents(await bounded(log.snapshot())).length, 0);
      },
    );
  }
});

test("managed file symlinks and hard links are never read as trusted history or modified", async (t) => {
  for (const kind of ["symlink", "hard-link"]) {
    await t.test(kind, async (t) => {
      const f = await fixture(t);
      const targetDirectory = path.join(f.root, "untouched-files");
      const previous = await history(targetDirectory, [
        event("linked-private-history"),
      ]);
      await fs.mkdir(f.storageDirectory);
      const link = path.join(f.storageDirectory, previous.name);
      if (kind === "symlink") {
        if (!(await symlinkOrSkip(t, previous.file, link, "file"))) return;
      } else {
        await fs.link(previous.file, link);
        assert.ok((await fs.stat(link)).nlink > 1);
      }
      const log = f.create();
      log.record(event("must-not-write-through-link"));
      assertUnavailable(await bounded(log.flush()));
      assert.equal(allEvents(await bounded(log.snapshot())).length, 0);
      assert.equal(await fs.readFile(previous.file, "utf8"), previous.text);
      assert.deepEqual(await fs.readdir(f.storageDirectory), [previous.name]);
    });
  }
});

test("replacing an active log file stops writes without touching either file", async (t) => {
  const f = await fixture(t);
  const log = f.create();
  log.record(event("original"));
  const before = await log.snapshot();
  const file = path.join(f.storageDirectory, before.files[0].name);
  const saved = path.join(f.root, "saved-original.jsonl");
  const original = await fs.readFile(file);
  await fs.rename(file, saved);
  await fs.writeFile(file, "replacement must stay intact");
  log.record(event("must-not-append"));
  assertUnavailable(await bounded(log.flush()));
  assert.equal(await fs.readFile(file, "utf8"), "replacement must stay intact");
  assert.deepEqual(await fs.readFile(saved), original);
});

test("same-inode same-length edits to an active log stop the next accepted write", async (t) => {
  const f = await fixture(t);
  const log = f.create();
  assert.equal(log.record(event("original")), true);
  const before = await log.snapshot();
  const file = path.join(f.storageDirectory, before.files[0].name);
  const corruptBytes = await fs.readFile(file);
  corruptBytes[0] = 0x21;
  await overwriteSameLength(file, corruptBytes);

  assert.equal(log.record(event("must-not-append-after-tampering")), true);
  assertUnavailable(await bounded(log.flush()));
  assert.deepEqual(await fs.readFile(file), corruptBytes);
  assert.equal(log.record(event("after-disable")), false);
});

test("a closed session rejects a replaced directory instead of trusting its new identity", async (t) => {
  const f = await fixture(t);
  const log = f.create();
  log.record(event("original"));
  const before = await log.snapshot();
  const saved = path.join(f.root, "saved-directory");
  const original = await fs.readFile(
    path.join(f.storageDirectory, before.files[0].name),
  );
  await log.close();
  await fs.rename(f.storageDirectory, saved);
  await fs.mkdir(f.storageDirectory);
  const marker = path.join(f.storageDirectory, "marker.txt");
  await fs.writeFile(marker, "new directory content");
  assert.equal(log.record(event("must-not-adopt-replacement")), false);
  assertUnavailable((await bounded(log.snapshot())).status);
  assert.deepEqual(await fs.readdir(f.storageDirectory), ["marker.txt"]);
  assert.equal(await fs.readFile(marker, "utf8"), "new directory content");
  assert.deepEqual(
    await fs.readFile(path.join(saved, before.files[0].name)),
    original,
  );
});

test("write and sync failures become diagnostic status rather than business errors", async (t) => {
  for (const operation of ["write", "sync"]) {
    await t.test(operation, async (t) => {
      const f = await fixture(t);
      let injected = 0;
      const fail = async () => {
        injected += 1;
        throw Object.assign(new Error("injected disk failure"), {
          code: "EIO",
        });
      };
      const log = f.create({
        fileOps: openWith((handle) =>
          handleProxy(
            handle,
            operation === "write"
              ? { write: fail, writeFile: fail, appendFile: fail }
              : { sync: fail, datasync: fail },
          ),
        ),
      });
      assert.doesNotThrow(() =>
        assert.equal(log.record(event("disk-failure")), true),
      );
      const status = await bounded(log.flush());
      assert.ok(injected > 0);
      assertUnavailable(status);
      assert.ok(status.writeFailures >= 1);
      await bounded(log.snapshot());
      assert.equal((await bounded(log.close())).closed, true);
    });
  }
});

test("short writes are retried without missing or duplicating bytes", async (t) => {
  const f = await fixture(t);
  let shortWrites = 0;
  const log = f.create({
    fileOps: openWith((handle) =>
      handleProxy(handle, {
        async write(buffer, offset, length, position) {
          shortWrites += 1;
          if (typeof buffer === "string") {
            const encoding = typeof length === "string" ? length : "utf8";
            const bytes = Buffer.from(buffer, encoding);
            const result = await handle.write(
              bytes,
              0,
              Math.min(7, bytes.length),
              offset ?? null,
            );
            return { bytesWritten: result.bytesWritten, buffer };
          }
          if (offset && typeof offset === "object") {
            const options = offset;
            offset = options.offset ?? 0;
            length = options.length ?? buffer.byteLength - offset;
            position = options.position ?? null;
          }
          offset ??= 0;
          length ??= buffer.byteLength - offset;
          return handle.write(
            buffer,
            offset,
            Math.min(7, length),
            position ?? null,
          );
        },
      }),
    ),
  });
  const expected = [event("中文 😀 UTF-8"), event("second")];
  for (const item of expected) assert.equal(log.record(item), true);
  assert.equal((await bounded(log.flush())).available, true);
  assert.ok(shortWrites > 4);
  assert.deepEqual(allEvents(await log.snapshot()), expected);
});

test("zero-byte writes fail within a bound instead of looping forever", async (t) => {
  const f = await fixture(t);
  const log = f.create({
    deadlineMs: 40,
    fileOps: openWith((handle) =>
      handleProxy(handle, {
        async write(buffer) {
          return { bytesWritten: 0, buffer };
        },
      }),
    ),
  });
  assert.equal(log.record(event("zero-write")), true);
  assertUnavailable(await bounded(log.flush()));
  assert.equal((await bounded(log.close())).closed, true);
});

test("pending capacity includes the in-flight event and rejected events are counted", async (t) => {
  const f = await fixture(t);
  const gate = deferred();
  const entered = deferred();
  f.beforeCleanup.push(() => gate.resolve());
  let block = true;
  const log = f.create({
    maxPending: 2,
    fileOps: openWith((handle) =>
      handleProxy(handle, {
        async sync() {
          if (block) {
            block = false;
            entered.resolve();
            await gate.promise;
          }
          return handle.sync();
        },
      }),
    ),
  });
  assert.equal(log.record(event("accepted-1")), true);
  await bounded(entered.promise);
  assert.equal(log.record(event("accepted-2")), true);
  assert.equal(log.record(event("rejected-3")), false);
  gate.resolve();
  const status = await bounded(log.flush());
  assert.equal(status.available, true);
  assert.equal(status.droppedEvents, 1);
  assert.deepEqual(
    allEvents(await log.snapshot()).map((item) => item.detail),
    ["accepted-1", "accepted-2"],
  );
});

test("hung storage gives bounded flush, snapshot and close with explicit timeout status", async (t) => {
  const f = await fixture(t);
  const gate = deferred();
  const entered = deferred();
  const released = deferred();
  f.beforeCleanup.push(async () => {
    gate.resolve();
    await bounded(released.promise);
  });
  const log = f.create({
    maxPending: 2,
    deadlineMs: 20,
    fileOps: {
      async mkdir(...args) {
        entered.resolve();
        await gate.promise;
        try {
          return await fs.mkdir(...args);
        } finally {
          released.resolve();
        }
      },
    },
  });
  assert.equal(log.record(event("hung-write")), true);
  await bounded(entered.promise);
  const flushStatus = await bounded(log.flush());
  assertUnavailable(flushStatus);
  assert.equal(flushStatus.reason, "timeout");
  const snapshot = await bounded(log.snapshot());
  assertUnavailable(snapshot.status);
  assert.equal(snapshot.status.reason, "timeout");
  const status = await bounded(log.close());
  assert.equal(status.available, false);
  assert.equal(status.reason, "timeout");
  assert.equal(status.closed, true);
  assert.equal(log.record(event("after-close")), false);
});

test("close drains accepted events and immediately prevents new acceptance", async (t) => {
  const f = await fixture(t);
  const log = f.create();
  assert.equal(log.record(event("before-close")), true);
  const closing = log.close();
  assert.equal(log.record(event("after-close")), false);
  const status = await bounded(closing);
  assert.equal(status.closed, true);
  assert.equal(status.available, true);
  const snapshot = await bounded(log.snapshot());
  assert.deepEqual(allEvents(snapshot), [event("before-close")]);
  assert.equal((await log.close()).closed, true);
});

test("a synchronous handle-close error still yields a closed status without escaping", async (t) => {
  const f = await fixture(t);
  const realCloses = [];
  let armed = false;
  let injected = 0;
  f.beforeCleanup.push(async () => {
    await Promise.all(realCloses);
  });
  const log = f.create({
    fileOps: openWith((handle) =>
      handleProxy(handle, {
        close() {
          const completion = handle.close();
          realCloses.push(completion);
          if (armed) {
            injected += 1;
            throw Object.assign(new Error("synchronous close failure"), {
              code: "EIO",
            });
          }
          return completion;
        },
      }),
    ),
  });
  log.record(event("durable-before-close"));
  assert.equal((await log.flush()).available, true);
  armed = true;
  const status = await bounded(log.close());
  assert.ok(injected > 0);
  assert.equal(status.closed, true);
  assert.equal(log.record(event("after-close")), false);
  const recovered = f.create();
  assert.deepEqual(allEvents(await recovered.snapshot()), [
    event("durable-before-close"),
  ]);
});

test("oversized history is preserved without reading or exporting its body", async (t) => {
  const f = await fixture(t);
  const previous = await history(f.storageDirectory, [], {
    tail: "x".repeat(MAX_FILE_BYTES + 1),
  });
  let oversizedReads = 0;
  const log = f.create({
    fileOps: {
      async readFile(file, ...args) {
        if (String(file) === previous.file) oversizedReads += 1;
        return fs.readFile(file, ...args);
      },
      ...openWith((handle, file) =>
        handleProxy(handle, {
          async read(...args) {
            if (String(file) === previous.file) oversizedReads += 1;
            return handle.read(...args);
          },
          async readFile(...args) {
            if (String(file) === previous.file) oversizedReads += 1;
            return handle.readFile(...args);
          },
        }),
      ),
    },
  });
  log.record(event("must-not-write"));
  assertUnavailable(await bounded(log.flush()));
  const snapshot = await bounded(log.snapshot());
  assert.equal(snapshot.files.length, 0);
  assert.equal(oversizedReads, 0);
  assert.equal(await fs.readFile(previous.file, "utf8"), previous.text);
});

test("the 128-entry directory cap counts unknown files and leaves them untouched", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(f.storageDirectory);
  const names = Array.from(
    { length: 129 },
    (_, index) => `unmanaged-${index}.txt`,
  );
  await Promise.all(
    names.map((name) =>
      fs.writeFile(path.join(f.storageDirectory, name), "keep"),
    ),
  );
  const log = f.create();
  log.record(event("over-enumeration-cap"));
  assertUnavailable(await bounded(log.flush()));
  const snapshot = await bounded(log.snapshot());
  assert.equal(snapshot.files.length, 0);
  assert.deepEqual((await fs.readdir(f.storageDirectory)).sort(), names.sort());
  assert.equal(
    await fs.readFile(path.join(f.storageDirectory, names[0]), "utf8"),
    "keep",
  );
});

test("mutating returned snapshots cannot affect future snapshots or durable data", async (t) => {
  const f = await fixture(t);
  const log = f.create();
  log.record(event("immutable"));
  const original = await log.snapshot();
  const expected = structuredClone(original);
  original.files[0].events[0].detail = "caller mutation";
  original.files[0].events.push(event("injected"));
  original.files[0].sessionId = "caller-session";
  original.files.push({ name: "fake", events: [] });
  original.limits.maxFiles = 100000;
  original.status.issues.push({ code: "CALLER" });
  original.status.available = false;
  const current = await log.snapshot();
  assert.deepEqual(current, expected);
  const bytes = await fs.readFile(
    path.join(f.storageDirectory, current.files[0].name),
    "utf8",
  );
  assert.doesNotMatch(bytes, /caller mutation|injected|caller-session/);
});

test("persisted and recovered events never contain account details or raw IPC fields", async (t) => {
  const f = await fixture(t);
  const log = f.create();
  log.record({
    ...event("account-secret", { action: "account:login" }),
    input: { password: "raw-ipc-secret" },
  });
  log.record(
    event("failed with Bearer diskBearerCanary token=diskTokenCanary", {
      result: "error",
    }),
  );
  const snapshot = await log.snapshot();
  const serialized = JSON.stringify(snapshot);
  assert.doesNotMatch(
    serialized,
    /account-secret|raw-ipc-secret|diskBearerCanary|diskTokenCanary/,
  );
  const bytes = await fs.readFile(
    path.join(f.storageDirectory, snapshot.files[0].name),
    "utf8",
  );
  assert.doesNotMatch(
    bytes,
    /account-secret|raw-ipc-secret|diskBearerCanary|diskTokenCanary/,
  );
  await log.close();
  const restarted = f.create();
  assert.deepEqual(allEvents(await restarted.snapshot()), allEvents(snapshot));
});
