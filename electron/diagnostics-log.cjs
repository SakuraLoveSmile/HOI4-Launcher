"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { TextDecoder } = require("node:util");

const FORMAT = "IRONCLAD-DIAGNOSTIC-EVENTS";
const DEFAULT_BYTES = 2 * 1024 * 1024;
const UUID = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
const MANAGED = new RegExp(`^session-(${UUID})-(\\d{6})\\.jsonl$`);
const MAX_ENTRIES = 128;
const MAX_LINE_BYTES = 8192;
const MAX_RECORDS = 32768;

function timestamp(value) {
  if (typeof value !== "string" || value.length > 32) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function sanitizeDiagnosticEvent(raw) {
  if (!raw || typeof raw !== "object") return null;
  const at = timestamp(raw.at);
  if (
    !at ||
    typeof raw.action !== "string" ||
    !/^[a-z][a-z0-9:-]{0,63}$/.test(raw.action) ||
    !["ok", "error"].includes(raw.result)
  )
    return null;
  // Do not stringify objects: their properties may contain credentials, and
  // custom coercion may throw. Limit work before applying redaction patterns.
  let detail = typeof raw.detail === "string" ? raw.detail.slice(0, 8192) : "";
  if (raw.action.startsWith("account:")) detail = "";
  else {
    detail = detail
      .replace(
        /(["']?\b(?:proxy-)?authorization["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\\r\n])*(?:"|$)|'(?:\\.|[^'\\\r\n])*(?:'|$)|[^\r\n]+)/gi,
        "$1[redacted]",
      )
      .replace(/\b(Bearer|Basic)\s+[^\s,;"'<>]+/gi, "$1 [redacted]")
      .replace(
        /(["']?\b(?:password|passwd|pwd|access[_-]?token|refresh[_-]?token|id[_-]?token|token|api[_-]?key|client[_-]?secret)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\\r\n])*(?:"|$)|'(?:\\.|[^'\\\r\n])*(?:'|$)|[^\s,;&]+)/gi,
        "$1[redacted]",
      )
      .slice(0, 1000);
  }
  return { at, action: raw.action, result: raw.result, detail };
}

function createDiagnosticsLog(options = {}) {
  const io = { ...fs, ...options.fileOps };
  const limit = (value, fallback) =>
    Number.isInteger(value) && value > 0 ? Math.min(value, fallback) : fallback;
  const maxFileBytes = limit(options.maxFileBytes, DEFAULT_BYTES);
  const maxFiles = limit(options.maxFiles, 3);
  const maxPending = limit(options.maxPending, 64);
  const deadlineMs = limit(options.deadlineMs, 2000);
  const directory = path.resolve(options.storageDirectory);
  const now = options.now || Date.now;
  const sessionId = randomUUID();
  const createdAt = new Date(now()).toISOString();
  const limits = { maxFileBytes, maxFiles, maxPending };
  const status = {
    available: true,
    reason: null,
    closed: false,
    droppedEvents: 0,
    writeFailures: 0,
    issues: [],
  };
  let anchors,
    initialized = false,
    current,
    part = 0,
    pending = 0;
  let chain = Promise.resolve();
  let lastFiles = [];

  function issue(code, file) {
    if (status.issues.length >= 16) return;
    if (status.issues.some((item) => item.code === code && item.file === file))
      return;
    status.issues.push(file ? { code, file } : { code });
  }
  function failure(code, file) {
    const error = new Error(code);
    error.diagnosticCode = code;
    error.file = file;
    return error;
  }
  function disable(error) {
    if (!status.available) return;
    const code = error?.diagnosticCode || "io-failure";
    status.available = false;
    status.reason = code;
    status.writeFailures++;
    issue(code, error?.file);
    const old = current;
    current = null;
    if (old) detachClose(old.handle);
  }
  function detachClose(handle) {
    Promise.resolve()
      .then(() => handle.close())
      .catch(() => {});
  }
  function active() {
    if (!status.available) throw failure(status.reason);
  }
  async function checked(promise) {
    const value = await promise;
    active();
    return value;
  }
  function same(a, b) {
    return a.dev === b.dev && a.ino === b.ino;
  }
  function sameVersion(a, b) {
    return (
      same(a, b) &&
      a.size === b.size &&
      a.mtimeMs === b.mtimeMs &&
      a.ctimeMs === b.ctimeMs
    );
  }
  function regular(stat, name) {
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
      throw failure("unsafe-file", name);
    if (stat.size > maxFileBytes) throw failure("oversized-file", name);
  }
  async function anchorDirectory() {
    const root = path.parse(directory).root;
    const segments = path
      .relative(root, directory)
      .split(path.sep)
      .filter(Boolean);
    const result = [];
    let target = root;
    for (const segment of [null, ...segments]) {
      if (segment !== null) target = path.join(target, segment);
      let stat;
      try {
        stat = await checked(io.lstat(target));
      } catch (error) {
        if (error.code !== "ENOENT" || !status.available) throw error;
        try {
          await checked(io.mkdir(target));
        } catch (createError) {
          if (createError.code !== "EEXIST") throw createError;
        }
        stat = await checked(io.lstat(target));
      }
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw failure("unsafe-directory");
      result.push({ target, stat });
    }
    anchors = result;
  }
  async function verifyAnchors() {
    for (const anchor of anchors) {
      const stat = await checked(io.lstat(anchor.target));
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        !same(stat, anchor.stat)
      )
        throw failure("directory-replaced");
    }
  }
  async function identity(name, original, size, unchanged = false) {
    await verifyAnchors();
    const stat = await checked(io.lstat(path.join(directory, name)));
    regular(stat, name);
    if (
      !same(stat, original) ||
      stat.size !== size ||
      (unchanged && !sameVersion(stat, original))
    )
      throw failure("file-replaced", name);
    return stat;
  }
  async function readManaged(name) {
    const match = MANAGED.exec(name);
    const target = path.join(directory, name);
    await verifyAnchors();
    const before = await checked(io.lstat(target));
    regular(before, name);
    let handle;
    try {
      handle = await io.open(target, "r");
      active();
      const opened = await checked(handle.stat());
      regular(opened, name);
      if (!sameVersion(opened, before)) throw failure("file-replaced", name);
      // Fixed-size buffers and positional reads also bound a concurrently
      // growing file. readFile() could allocate until that writer stops.
      const buffer = Buffer.alloc(Math.min(maxFileBytes + 1, before.size + 1));
      let bytes = 0;
      while (bytes < buffer.length) {
        const read = await checked(
          handle.read(buffer, bytes, buffer.length - bytes, bytes),
        );
        if (
          !Number.isInteger(read.bytesRead) ||
          read.bytesRead < 0 ||
          read.bytesRead > buffer.length - bytes
        )
          throw failure("invalid-read", name);
        if (read.bytesRead === 0) break;
        bytes += read.bytesRead;
      }
      if (bytes !== before.size) throw failure("file-changed", name);
      const after = await checked(handle.stat());
      if (!sameVersion(after, before) || after.nlink !== 1)
        throw failure("file-changed", name);
      await identity(name, before, before.size, true);
      // An abrupt exit can tear a UTF-8 character as well as JSON. Decode only
      // newline-terminated records; the incomplete tail is never exported.
      const completeBytes = buffer.subarray(0, bytes).lastIndexOf(10) + 1;
      let text;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(
          buffer.subarray(0, completeBytes),
        );
      } catch {
        throw failure("invalid-encoding", name);
      }
      const lines = text.split("\n");
      lines.pop();
      if (!lines.length) throw failure("invalid-header", name);
      let header;
      try {
        header = JSON.parse(lines.shift());
      } catch {
        throw failure("invalid-header", name);
      }
      if (
        header?.format !== FORMAT ||
        header.schemaVersion !== 1 ||
        header.sessionId !== match[1] ||
        header.part !== Number(match[2]) ||
        !timestamp(header.createdAt) ||
        Object.keys(header).some(
          (key) =>
            ![
              "format",
              "schemaVersion",
              "sessionId",
              "part",
              "createdAt",
            ].includes(key),
        )
      )
        throw failure("invalid-header", name);
      if (lines.length > MAX_RECORDS) throw failure("too-many-records", name);
      const events = [];
      for (const line of lines) {
        if (Buffer.byteLength(line) > MAX_LINE_BYTES)
          throw failure("oversized-record", name);
        let event;
        try {
          event = sanitizeDiagnosticEvent(JSON.parse(line));
        } catch {
          throw failure("invalid-record", name);
        }
        if (!event) throw failure("invalid-record", name);
        events.push(event);
      }
      const truncated = completeBytes !== bytes;
      if (truncated) issue("truncated-tail", name);
      return {
        name,
        sessionId: header.sessionId,
        part: header.part,
        createdAt: timestamp(header.createdAt),
        events,
        truncated,
        stat: before,
      };
    } finally {
      if (handle) await handle.close();
    }
  }
  async function scan() {
    await verifyAnchors();
    const entries = [];
    let stream;
    try {
      stream = await io.opendir(directory);
      active();
      while (true) {
        const entry = await checked(stream.read());
        if (!entry) break;
        entries.push(entry.name);
        if (entries.length > MAX_ENTRIES) throw failure("too-many-files");
      }
    } finally {
      if (stream) await stream.close();
    }
    const files = [];
    for (const name of entries.sort()) {
      if (MANAGED.test(name)) files.push(await readManaged(name));
    }
    files.sort(
      (a, b) =>
        a.createdAt.localeCompare(b.createdAt) ||
        a.sessionId.localeCompare(b.sessionId) ||
        a.part - b.part,
    );
    return files;
  }
  function exported(files) {
    return files.map(({ stat, ...file }) => file);
  }
  async function prune(files, retain) {
    while (files.length > retain) {
      const oldest = files[0];
      await identity(oldest.name, oldest.stat, oldest.stat.size, true);
      await checked(io.unlink(path.join(directory, oldest.name)));
      files.shift();
    }
  }
  async function initialize() {
    if (initialized) return;
    await anchorDirectory();
    const files = await scan();
    await prune(files, maxFiles);
    lastFiles = exported(files);
    initialized = true;
  }
  async function writeComplete(handle, buffer, position, name) {
    let written = 0;
    while (written < buffer.length) {
      const result = await checked(
        handle.write(
          buffer,
          written,
          buffer.length - written,
          position + written,
        ),
      );
      if (
        !Number.isInteger(result.bytesWritten) ||
        result.bytesWritten < 1 ||
        result.bytesWritten > buffer.length - written
      )
        throw failure("incomplete-write", name);
      written += result.bytesWritten;
    }
  }
  async function createPart(eventBytes) {
    if (current) {
      const old = current;
      current = null;
      await checked(old.handle.close());
    }
    const header = {
      format: FORMAT,
      schemaVersion: 1,
      sessionId,
      part,
      createdAt,
    };
    const bytes = Buffer.from(JSON.stringify(header) + "\n");
    if (bytes.length + eventBytes > maxFileBytes)
      throw failure("record-exceeds-limit");
    const files = await scan();
    // Validate every candidate before deleting any; unknown/broken files are
    // preserved. Pruning first avoids a transient fourth managed file.
    await prune(files, maxFiles - 1);
    lastFiles = exported(files);
    if (part > 999999) throw failure("too-many-parts");
    const name = `session-${sessionId}-${String(part++).padStart(6, "0")}.jsonl`;
    await verifyAnchors();
    const handle = await io.open(path.join(directory, name), "wx", 0o600);
    try {
      active();
      const stat = await checked(handle.stat());
      regular(stat, name);
      if (stat.size !== 0) throw failure("file-replaced", name);
      await identity(name, stat, 0);
      current = { name, handle, stat, size: 0 };
      await writeComplete(handle, bytes, 0, name);
      current.size = bytes.length;
      await checked(handle.sync());
      current.stat = await checked(handle.stat());
      await identity(name, current.stat, current.size, true);
    } catch (error) {
      if (current?.handle === handle) current = null;
      detachClose(handle);
      throw error;
    }
  }
  async function persist(event) {
    active();
    await initialize();
    const bytes = Buffer.from(JSON.stringify(event) + "\n");
    if (!current || current.size + bytes.length > maxFileBytes)
      await createPart(bytes.length);
    const file = current;
    await identity(file.name, file.stat, file.size, true);
    const opened = await checked(file.handle.stat());
    regular(opened, file.name);
    if (!sameVersion(opened, file.stat))
      throw failure("file-replaced", file.name);
    await writeComplete(file.handle, bytes, file.size, file.name);
    file.size += bytes.length;
    await checked(file.handle.sync());
    file.stat = await checked(file.handle.stat());
    await identity(file.name, file.stat, file.size, true);
  }
  async function bounded(work) {
    let timer;
    try {
      return await Promise.race([
        work,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(failure("timeout")), deadlineMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  function enqueue(operation) {
    const task = chain.then(async () => {
      if (!status.available) return;
      try {
        return await bounded(Promise.resolve().then(operation));
      } catch (error) {
        disable(error);
      }
    });
    chain = task.then(() => undefined);
    return task;
  }
  const getStatus = () => structuredClone(status);
  async function waitFor(work) {
    try {
      await bounded(work);
    } catch (error) {
      disable(error);
    }
    return getStatus();
  }
  return {
    record(raw) {
      if (status.closed || !status.available) return false;
      let event;
      try {
        event = sanitizeDiagnosticEvent(raw);
      } catch {
        event = null;
      }
      if (!event || pending >= maxPending) {
        status.droppedEvents++;
        return false;
      }
      pending++;
      enqueue(() => persist(event)).finally(() => {
        pending--;
      });
      return true;
    },
    flush() {
      return waitFor(chain);
    },
    async snapshot() {
      const work = enqueue(async () => {
        await initialize();
        lastFiles = exported(await scan());
      });
      await waitFor(work);
      return structuredClone({
        schemaVersion: 1,
        directory,
        limits,
        status,
        files: lastFiles.slice(-maxFiles),
      });
    },
    async close() {
      status.closed = true;
      const work = enqueue(async () => {
        if (!current) return;
        const old = current;
        current = null;
        await checked(old.handle.close());
      });
      return waitFor(work);
    },
  };
}

module.exports = { createDiagnosticsLog, sanitizeDiagnosticEvent };
