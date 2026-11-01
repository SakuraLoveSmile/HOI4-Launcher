"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createHash, randomUUID } = require("node:crypto");
const { deflateRawSync } = require("node:zlib");
const crc32 = require("yauzl/crc32");
const {
  createPdxInstallService,
  INSTALL_LIMITS,
} = require("../electron/pdx-install.cjs");

function zipBytes(entries) {
  const locals = [],
    central = [];
  let offset = 0;
  for (const input of entries) {
    const name = Buffer.from(input.name),
      bytes = Buffer.from(input.content || ""),
      method = input.method ?? 0;
    const packed = method === 8 ? deflateRawSync(bytes) : bytes;
    const checksum = input.crc ?? crc32(bytes),
      size = input.size ?? bytes.length;
    const extra = input.extra || Buffer.alloc(0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(extra.length, 28);
    locals.push(local, name, extra, packed);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50);
    header.writeUInt16LE((3 << 8) | 20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x800, 8);
    header.writeUInt16LE(method, 10);
    header.writeUInt32LE(checksum, 16);
    header.writeUInt32LE(packed.length, 20);
    header.writeUInt32LE(size, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt16LE(extra.length, 30);
    header.writeUInt32LE(
      input.attributes ??
        ((input.name.endsWith("/") ? 0x41ed : 0x81a4) * 65536) >>> 0,
      38,
    );
    header.writeUInt32LE(offset, 42);
    central.push(header, name, extra);
    offset += local.length + name.length + extra.length + packed.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
const descriptor =
  '# author metadata\nname="Sample mod"\nversion="1.0"\nsupported_version="1.19.*"\ntags={"Gameplay"}\nreplace_path="history/states"\ndependencies={"Base Mod"}\npath="C:/private"\narchive="../private.zip"\nremote_file_id="999"\n';
const entries = (extra = []) => [
  { name: "descriptor.mod", content: descriptor },
  { name: "events/", content: "" },
  {
    name: "events/start.txt",
    content: "country_event={ id=sample.1 }\n",
    method: 8,
  },
  ...extra,
];

const repairInput = (input, record) => ({
  ...input,
  repair: { installationId: record.installationId },
});
const verifyInput = (f, record) => ({
  userDataPath: f.userData,
  installationId: record.installationId,
});

test("installed files use an archive-derived index, including sanitized descriptor bytes", async (t) => {
  const f = await fixture(t),
    input = await f.archive();
  const record = await f.service.install(input);
  const report = await f.restart().verify("123", verifyInput(f, record));
  assert.equal(report.status, "intact");
  assert.equal(report.totalFiles, 2);
  assert.equal(report.checkedFiles, 2);
  assert.equal(report.registrationIntact, true);
  assert.deepEqual(report.issues, []);
});

test("same-size edits and extra files are detected and repaired at the pinned revision", async (t) => {
  const f = await fixture(t),
    input = await f.archive();
  const old = await f.service.install(input);
  const target = path.join(old.contentPath, "events/start.txt"),
    original = await fs.readFile(target);
  await fs.writeFile(target, Buffer.alloc(original.length, 120));
  await fs.writeFile(
    path.join(old.contentPath, "extra.txt"),
    "local edits kept",
  );
  const report = await f.service.verify("123", verifyInput(f, old));
  assert.equal(report.status, "damaged");
  assert.equal(report.changedFiles, 1);
  assert.equal(report.extraFiles, 1);
  const result = await f.service.install(repairInput(input, old));
  assert.equal(result.revision, old.revision);
  assert.equal(result.repair.repaired, true);
  assert.equal(result.repair.validation.changedFiles, 1);
  assert.notEqual(result.installationId, old.installationId);
  assert.notEqual(result.contentPath, old.contentPath);
  assert.deepEqual(
    await fs.readFile(path.join(result.contentPath, "events/start.txt")),
    original,
  );
  assert.equal(
    await fs.readFile(path.join(old.contentPath, "extra.txt"), "utf8"),
    "local edits kept",
  );
  assert.equal(
    (await f.restart().verify("123", verifyInput(f, result))).status,
    "intact",
  );
});

for (const kind of ["missing", "modified"]) {
  test(`repair restores a ${kind} registration and preserves prior bytes`, async (t) => {
    const f = await fixture(t),
      input = await f.archive();
    const old = await f.service.install(input),
      modified = Buffer.from([0xff, 0, 0xfe, 10]);
    if (kind === "missing") await fs.unlink(old.descriptorPath);
    else await fs.writeFile(old.descriptorPath, modified);
    assert.deepEqual(await f.service.list(), []);
    assert.equal(
      (await f.service.list({ includeDamaged: true }))[0].installationDamaged,
      true,
    );
    const report = await f.service.verify("123", verifyInput(f, old));
    assert.equal(report.registrationIntact, false);
    assert.equal(report.status, "damaged");
    const result = await f.service.install(repairInput(input, old));
    assert.equal(result.repair.repaired, true);
    assert.equal(
      (await f.service.verify("123", verifyInput(f, result))).status,
      "intact",
    );
    if (kind === "modified")
      assert.deepEqual(
        await fs.readFile(result.repair.retainedDescriptorPath),
        modified,
      );
    else assert.equal(result.repair.retainedDescriptorPath, undefined);
    assert.equal(
      (await f.restart().list())[0].installationId,
      result.installationId,
    );
  });
}

test("a legacy healthy installation obtains a trusted baseline without replacing its files", async (t) => {
  const f = await fixture(t),
    input = await f.archive(),
    old = await f.service.install(input);
  const database = path.join(f.storage, "installations.json"),
    db = JSON.parse(await fs.readFile(database, "utf8"));
  delete db.records[0].integrity;
  await fs.writeFile(database, JSON.stringify(db));
  assert.equal(
    (await f.service.verify("123", verifyInput(f, old))).status,
    "unverified",
  );
  const before = await fs.readFile(old.descriptorPath);
  const result = await f.service.install(repairInput(input, old));
  assert.equal(result.repair.repaired, false);
  assert.equal(result.contentPath, old.contentPath);
  assert.equal(result.installationId, old.installationId);
  assert.deepEqual(await fs.readFile(old.descriptorPath), before);
  assert.equal(
    (await f.restart().verify("123", verifyInput(f, old))).status,
    "intact",
  );
});

test("missing content stays discoverable for repair and is rebuilt in a new version directory", async (t) => {
  const f = await fixture(t),
    input = await f.archive(),
    old = await f.service.install(input);
  await fs.rename(old.contentPath, old.contentPath + "-preserved");
  const report = await f.service.verify("123", verifyInput(f, old));
  assert.equal(report.status, "damaged");
  assert.equal(report.missingFiles, 2);
  assert.equal(
    (await f.service.list({ includeDamaged: true }))[0].installationDamaged,
    true,
  );
  const result = await f.service.install(repairInput(input, old));
  assert.equal(result.repair.repaired, true);
  assert.equal(
    (await f.service.verify("123", verifyInput(f, result))).status,
    "intact",
  );
  assert.equal(
    (await fs.stat(old.contentPath + "-preserved")).isDirectory(),
    true,
  );
});

test("repair rollback restores a modified registration byte-for-byte after link failure", async (t) => {
  const f = await fixture(t),
    input = await f.archive(),
    old = await f.service.install(input),
    bytes = Buffer.from([0xff, 0, 0x61]);
  await fs.writeFile(old.descriptorPath, bytes);
  const link = fs.link;
  let injected = false;
  t.mock.method(fs, "link", async (source, target) => {
    if (
      !injected &&
      target === old.descriptorPath &&
      source.includes(".ironclad-tmp-")
    ) {
      injected = true;
      throw new Error("injected repair link failure");
    }
    return link(source, target);
  });
  await assert.rejects(
    f.service.install(repairInput(input, old)),
    /injected repair link failure/,
  );
  assert.equal(injected, true);
  assert.deepEqual(await fs.readFile(old.descriptorPath), bytes);
  assert.equal(
    (await f.restart().list({ includeDamaged: true }))[0].installationId,
    old.installationId,
  );
  await assert.rejects(fs.stat(path.join(f.storage, "transaction.json")), {
    code: "ENOENT",
  });
});

test("repair does not replace a hard-linked foreign registration", async (t) => {
  const f = await fixture(t),
    input = await f.archive(),
    old = await f.service.install(input),
    external = path.join(f.root, "foreign.mod");
  await fs.writeFile(external, "foreign bytes");
  await fs.unlink(old.descriptorPath);
  await fs.link(external, old.descriptorPath);
  await assert.rejects(f.service.install(repairInput(input, old)), /安全备份/);
  assert.equal(await fs.readFile(external, "utf8"), "foreign bytes");
  assert.equal((await fs.stat(external)).nlink, 2);
});

test("repair is bound to the exact managed installation and refuses changed archive digests", async (t) => {
  const f = await fixture(t),
    input = await f.archive(),
    old = await f.service.install(input);
  await assert.rejects(
    f.service.install({ ...input, repair: { installationId: randomUUID() } }),
    /安装已变化/,
  );
  await assert.rejects(
    f.service.install(
      repairInput(
        await f.archive(
          entries([{ name: "new.txt", content: "different archive" }]),
        ),
        old,
      ),
    ),
    /相同版本的归档摘要/,
  );
  assert.equal((await f.service.list())[0].installationId, old.installationId);
});

test("cancelling installed-file validation keeps registration and index unchanged", async (t) => {
  const f = await fixture(t),
    input = await f.archive(),
    old = await f.service.install(input),
    controller = new AbortController();
  const before = await fs.readFile(path.join(f.storage, "installations.json"));
  await assert.rejects(
    f.service.verify("123", {
      ...verifyInput(f, old),
      signal: controller.signal,
      onProgress: () => controller.abort(),
    }),
    { name: "AbortError" },
  );
  assert.deepEqual(
    await fs.readFile(path.join(f.storage, "installations.json")),
    before,
  );
  assert.deepEqual(await f.service.list(), [old]);
});

test("a game user directory change before final registration preserves the old installation", async (t) => {
  const f = await fixture(t);
  const original = await f.service.install(await f.archive());
  const service = createPdxInstallService({
    storageDirectory: f.storage,
    validateUserDataPath: async () => {
      throw new Error("游戏用户目录已变化");
    },
  });
  await assert.rejects(
    service.install(await f.archive(entries(), "2")),
    /用户目录已变化/,
  );
  assert.equal((await f.service.list())[0].revision, "1");
  assert.equal(
    await fs.readFile(original.descriptorPath, "utf8"),
    await fs.readFile((await f.service.list())[0].descriptorPath, "utf8"),
  );
});

for (const phase of ["final-validation", "journal-written"]) {
  test(`session cancellation at ${phase} cannot activate an installation`, async (t) => {
    const f = await fixture(t);
    const original = await f.service.install(await f.archive());
    const controller = new AbortController();
    const service = createPdxInstallService({
      storageDirectory: f.storage,
      validateUserDataPath: async () => {
        if (phase === "final-validation") controller.abort();
      },
    });
    let intercepted = false;
    const rename = fs.rename;
    if (phase === "journal-written")
      t.mock.method(fs, "rename", async (...args) => {
        const result = await rename(...args);
        if (args[1] === path.join(f.storage, "transaction.json")) {
          intercepted = true;
          controller.abort();
        }
        return result;
      });
    await assert.rejects(
      service.install({
        ...(await f.archive(entries(), "2")),
        signal: controller.signal,
      }),
      { name: "AbortError" },
    );
    if (phase === "journal-written") assert.equal(intercepted, true);
    assert.deepEqual(await f.service.list(), [original]);
    assert.equal(
      await fs.readFile(original.descriptorPath, "utf8"),
      await fs.readFile((await f.service.list())[0].descriptorPath, "utf8"),
    );
    await assert.rejects(fs.lstat(path.join(f.storage, "transaction.json")), {
      code: "ENOENT",
    });
    await assert.rejects(
      fs.lstat(path.join(f.userData, "mod", "pdx_123_2.mod")),
      { code: "ENOENT" },
    );
  });
}

async function fixture(t) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "ironclad-pdx-install-"),
  );
  t.after(() =>
    fs.rm(root, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 20,
    }),
  );
  const storage = path.join(root, "installer"),
    userData = path.join(root, "game-user");
  await fs.mkdir(userData);
  const state = { running: false };
  const options = {
    storageDirectory: storage,
    isGameRunning: async () => state.running,
  };
  const service = createPdxInstallService(options);
  async function archive(items = entries(), revision = "1", patch = {}) {
    const bytes = zipBytes(items),
      archivePath = path.join(root, `archive-${revision}-${Math.random()}.zip`);
    await fs.writeFile(archivePath, bytes);
    return {
      archivePath,
      userDataPath: userData,
      plan: {
        modId: "123",
        name: "publication-id",
        title: "Sample mod",
        revision,
        platform: "Any__Any",
        archiveUrl:
          "https://modscontent.paradox-interactive.com/hoi4/id/repo/Any__Any/1/complete/mod.zip",
        filename: "mod.zip",
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        ...patch,
      },
    };
  }
  return {
    root,
    storage,
    userData,
    state,
    service,
    archive,
    restart: () => createPdxInstallService(options),
  };
}

test(
  "verified ZIP installs metadata and registers a safe revision-specific PDX descriptor",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t),
      phases = [],
      input = await f.archive();
    const record = await f.service.install({
      ...input,
      onProgress: (progress) => phases.push(progress),
    });
    assert.equal(record.modId, "123");
    assert.equal(record.revision, "1");
    assert.equal(
      record.descriptorPath,
      path.join(f.userData, "mod", "pdx_123_1.mod"),
    );
    assert.ok(
      record.contentPath.startsWith(
        path.join(f.storage, "versions", "123") + path.sep,
      ),
    );
    const inner = await fs.readFile(
        path.join(record.contentPath, "descriptor.mod"),
        "utf8",
      ),
      outer = await fs.readFile(record.descriptorPath, "utf8");
    assert.match(inner, /replace_path="history\/states"/);
    assert.match(inner, /dependencies=\{"Base Mod"\}/);
    assert.doesNotMatch(inner, /(?:^|\n)(?:path|archive|remote_file_id)=/);
    assert.doesNotMatch(outer, /C:\/private|remote_file_id|archive=/);
    assert.ok(
      outer.includes('path="' + record.contentPath.replace(/\\/g, "/") + '"'),
    );
    assert.equal(
      await fs.readFile(
        path.join(record.contentPath, "events", "start.txt"),
        "utf8",
      ),
      "country_event={ id=sample.1 }\n",
    );
    assert.deepEqual(await f.service.list(), [record]);
    assert.deepEqual(await f.restart().list(), [record]);
    assert.ok(phases.some((value) => value.stage === "extracting"));
    assert.ok(
      phases.some(
        (value) => value.stage === "committing" && value.cancellable === false,
      ),
    );
  },
);

test("archive length and hash are revalidated before installation, including a repeated revision", async (t) => {
  const f = await fixture(t),
    input = await f.archive();
  await assert.rejects(
    f.service.install({
      ...input,
      plan: { ...input.plan, bytes: input.plan.bytes + 1 },
    }),
    /长度/,
  );
  await assert.rejects(
    f.service.install({
      ...input,
      plan: { ...input.plan, sha256: "0".repeat(64) },
    }),
    /校验/,
  );
  const installed = await f.service.install(input);
  await fs.appendFile(input.archivePath, "changed");
  await assert.rejects(f.service.install(input), /校验/);
  assert.deepEqual(await f.service.list(), [installed]);
});

test("malicious ZIP path forms are rejected without writing outside staging", async (t) => {
  const f = await fixture(t);
  for (const name of [
    "../escape.txt",
    "/absolute.txt",
    "C:/drive.txt",
    "//server/share.txt",
    "events\\backslash.txt",
    "events/a:b",
    "CON.txt",
    "dir/NUL",
    "a./file",
    "a /file",
    "events/../escape",
    "events//file",
  ]) {
    await assert.rejects(
      f.service.install(await f.archive(entries([{ name, content: "bad" }]))),
      undefined,
      name,
    );
  }
  assert.deepEqual(await f.service.list(), []);
  await assert.rejects(fs.stat(path.join(f.root, "escape.txt")), {
    code: "ENOENT",
  });
});

test("case collisions, repeated files and file-directory conflicts are rejected", async (t) => {
  const f = await fixture(t);
  for (const extra of [
    [{ name: "DESCRIPTOR.MOD", content: "name=x" }],
    [{ name: "events/start.txt", content: "duplicate" }],
    [{ name: "Events/other.txt", content: "case alias" }],
    [{ name: "events", content: "file replaces directory" }],
    [
      { name: "file", content: "a" },
      { name: "file/child", content: "b" },
    ],
  ])
    await assert.rejects(
      f.service.install(await f.archive(entries(extra))),
      /冲突|重复/,
    );
});

test("symlink, special-file and hardlink ZIP metadata are rejected", async (t) => {
  const f = await fixture(t);
  const unixExtra = Buffer.alloc(8);
  unixExtra.writeUInt16LE(0x000d);
  unixExtra.writeUInt16LE(4, 2);
  for (const entry of [
    { name: "link", content: "../outside", attributes: (0xa1ff * 65536) >>> 0 },
    { name: "pipe", attributes: (0x11a4 * 65536) >>> 0 },
    { name: "hardlink", content: "target", extra: unixExtra },
    { name: "reparse", attributes: (0x81a4 * 65536 + 0x400) >>> 0 },
  ])
    await assert.rejects(
      f.service.install(await f.archive(entries([entry]))),
      /链接|特殊文件/,
    );
});

test("declared sizes, compression expansion, actual bytes and CRC are enforced", async (t) => {
  const f = await fixture(t);
  for (const entry of [
    { name: "oversize", content: "x", size: 0xffffffff, method: 8 },
    { name: "expansion", content: "x", size: 2 * 1024 * 1024, method: 8 },
    { name: "wrong-size", content: "too much output", size: 2, method: 8 },
    { name: "wrong-crc", content: "text", crc: 0 },
  ])
    await assert.rejects(f.service.install(await f.archive(entries([entry]))));
  assert.deepEqual(await f.service.list(), []);
});

test("ZIP64 entry counts and archive byte budgets are rejected before extraction", async (t) => {
  const f = await fixture(t),
    input = await f.archive();
  const zip64 = Buffer.alloc(56),
    locator = Buffer.alloc(20),
    end = Buffer.alloc(22);
  zip64.writeUInt32LE(0x06064b50);
  zip64.writeBigUInt64LE(44n, 4);
  zip64.writeUInt16LE(45, 12);
  zip64.writeUInt16LE(45, 14);
  zip64.writeBigUInt64LE(100001n, 24);
  zip64.writeBigUInt64LE(100001n, 32);
  locator.writeUInt32LE(0x07064b50);
  locator.writeUInt32LE(1, 16);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(65535, 8);
  end.writeUInt16LE(65535, 10);
  const bytes = Buffer.concat([zip64, locator, end]);
  await fs.writeFile(input.archivePath, bytes);
  input.plan.bytes = bytes.length;
  input.plan.sha256 = createHash("sha256").update(bytes).digest("hex");
  await assert.rejects(f.service.install(input), /数量/);
  await assert.rejects(
    f.service.install({
      ...input,
      plan: { ...input.plan, bytes: INSTALL_LIMITS.archiveBytes + 1 },
    }),
    /5 GiB/,
  );
});

test("a valid root descriptor is required and malformed metadata is rejected", async (t) => {
  const f = await fixture(t);
  for (const items of [
    [{ name: "nested/descriptor.mod", content: "name=x" }],
    [{ name: "descriptor.mod", content: 'name="unterminated' }],
    [{ name: "descriptor.mod", content: Buffer.from([255, 254, 253]) }],
  ])
    await assert.rejects(
      f.service.install(await f.archive(items)),
      /descriptor|描述|字符串/,
    );
});

test("cancellation during extraction preserves the previous active revision", async (t) => {
  const f = await fixture(t),
    old = await f.service.install(await f.archive()),
    controller = new AbortController();
  await assert.rejects(
    f.service.install({
      ...(await f.archive(
        entries([{ name: "large.txt", content: "a".repeat(50000), method: 8 }]),
        "2",
      )),
      signal: controller.signal,
      onProgress: (progress) => {
        if (progress.stage === "extracting") controller.abort();
      },
    }),
    { name: "AbortError" },
  );
  assert.deepEqual(await f.service.list(), [old]);
  assert.ok(await fs.stat(old.descriptorPath));
  await assert.rejects(fs.stat(path.join(f.userData, "mod", "pdx_123_2.mod")), {
    code: "ENOENT",
  });
});

test("an already aborted signal creates no registration", async (t) => {
  const f = await fixture(t),
    controller = new AbortController();
  controller.abort();
  await assert.rejects(
    f.service.install({ ...(await f.archive()), signal: controller.signal }),
    { name: "AbortError" },
  );
  assert.deepEqual(await f.service.list(), []);
});

test("updates activate the new revision and retain the old content and registration backup", async (t) => {
  const f = await fixture(t),
    old = await f.service.install(await f.archive()),
    current = await f.service.install(await f.archive(entries(), "2"));
  assert.deepEqual(await f.service.list(), [current]);
  assert.ok(await fs.stat(old.contentPath));
  await assert.rejects(fs.stat(old.descriptorPath), { code: "ENOENT" });
  const files = await fs.readdir(path.dirname(old.descriptorPath));
  assert.ok(
    files.some((name) => name.startsWith("pdx_123_1.mod.ironclad-backup-")),
  );
});

test("an existing official or user descriptor is never replaced", async (t) => {
  const f = await fixture(t),
    old = await f.service.install(await f.archive());
  const conflict = path.join(f.userData, "mod", "pdx_123_2.mod");
  await fs.writeFile(conflict, "user-owned descriptor");
  await assert.rejects(
    f.service.install(await f.archive(entries(), "2")),
    /已存在/,
  );
  assert.equal(await fs.readFile(conflict, "utf8"), "user-owned descriptor");
  assert.deepEqual(await f.service.list(), [old]);
});

test("an incoming conflicting descriptor during commit is preserved and the old version survives", async (t) => {
  const f = await fixture(t),
    old = await f.service.install(await f.archive()),
    target = path.join(f.userData, "mod", "pdx_123_2.mod");
  await assert.rejects(
    f.service.install({
      ...(await f.archive(entries(), "2")),
      onProgress: async (progress) => {
        if (progress.stage === "committing")
          await fs.writeFile(target, "foreign arriving descriptor");
      },
    }),
  );
  assert.equal(
    await fs.readFile(target, "utf8"),
    "foreign arriving descriptor",
  );
  assert.deepEqual(await f.service.list(), [old]);
});

test("a database commit failure rolls back registration while preserving the old version", async (t) => {
  const f = await fixture(t),
    old = await f.service.install(await f.archive()),
    originalRename = fs.rename;
  const hook = t.mock.method(fs, "rename", async (source, target) => {
    if (target === path.join(f.storage, "installations.json"))
      throw Object.assign(new Error("simulated disk error"), { code: "EIO" });
    return originalRename(source, target);
  });
  try {
    await assert.rejects(
      f.service.install(await f.archive(entries(), "2")),
      /disk error/,
    );
  } finally {
    hook.mock.restore();
  }
  assert.deepEqual(await f.service.list(), [old]);
  assert.ok(await fs.stat(old.descriptorPath));
  assert.deepEqual(await f.restart().recover(), {
    recovered: false,
    action: null,
  });
});

test("restart recovery restores the prior registration after an interrupted rollback", async (t) => {
  const f = await fixture(t),
    old = await f.service.install(await f.archive()),
    originalRename = fs.rename,
    originalUnlink = fs.unlink;
  const target = path.join(f.userData, "mod", "pdx_123_2.mod");
  const rename = t.mock.method(fs, "rename", async (source, dest) => {
    if (dest === path.join(f.storage, "installations.json"))
      throw new Error("simulated interruption");
    return originalRename(source, dest);
  });
  const unlink = t.mock.method(fs, "unlink", async (file) => {
    if (file === target)
      throw Object.assign(new Error("temporarily locked"), { code: "EPERM" });
    return originalUnlink(file);
  });
  try {
    await assert.rejects(
      f.service.install(await f.archive(entries(), "2")),
      (error) =>
        error.code === "RECOVERY_REQUIRED" && /恢复记录/.test(error.message),
    );
  } finally {
    rename.mock.restore();
    unlink.mock.restore();
  }
  assert.ok(await fs.stat(path.join(f.storage, "transaction.json")));
  assert.deepEqual(await f.restart().recover(), {
    recovered: true,
    action: "rolled-back",
  });
  assert.deepEqual(await f.restart().list(), [old]);
  await assert.rejects(fs.stat(target), { code: "ENOENT" });
});

test("restart recovery recognizes a committed install without registering twice", async (t) => {
  const f = await fixture(t),
    originalUnlink = fs.unlink,
    journal = path.join(f.storage, "transaction.json");
  const hook = t.mock.method(fs, "unlink", async (file) => {
    if (file === journal)
      throw Object.assign(new Error("journal locked"), { code: "EPERM" });
    return originalUnlink(file);
  });
  try {
    await assert.rejects(f.service.install(await f.archive()), /恢复记录/);
  } finally {
    hook.mock.restore();
  }
  const restarted = f.restart();
  assert.deepEqual(await restarted.recover(), {
    recovered: true,
    action: "completed",
  });
  assert.equal((await restarted.list()).length, 1);
});

test("game-running guard blocks commit and uninstall", async (t) => {
  const f = await fixture(t),
    old = await f.service.install(await f.archive());
  f.state.running = true;
  await assert.rejects(
    f.service.install(await f.archive(entries(), "2")),
    /退出游戏/,
  );
  await assert.rejects(
    f.service.uninstall("123", { userDataPath: f.userData }),
    /退出游戏/,
  );
  f.state.running = false;
  await assert.rejects(
    f.service.install({
      ...(await f.archive(entries(), "2")),
      onProgress: (progress) => {
        if (progress.stage === "committing") f.state.running = true;
      },
    }),
    /退出游戏/,
  );
  assert.deepEqual(await f.service.list(), [old]);
});

test("uninstall only deregisters owned files and retains content for recovery", async (t) => {
  const f = await fixture(t),
    old = await f.service.install(await f.archive());
  const result = await f.service.uninstall("123", { userDataPath: f.userData });
  assert.equal(result.removed, true);
  assert.equal(result.retainedContentPath, old.contentPath);
  assert.deepEqual(await f.service.list(), []);
  assert.ok(await fs.stat(old.contentPath));
  await assert.rejects(fs.stat(old.descriptorPath), { code: "ENOENT" });
});

test("recovery handles a crash between creating the owned registration backup and unlinking the original", async (t) => {
  const f = await fixture(t),
    installed = await f.service.install(await f.archive());
  const db = JSON.parse(
      await fs.readFile(path.join(f.storage, "installations.json"), "utf8"),
    ),
    record = db.records[0],
    backupId = randomUUID();
  const backup = record.descriptorPath + ".ironclad-backup-" + backupId;
  await fs.writeFile(
    path.join(f.storage, "transaction.json"),
    JSON.stringify({
      version: 1,
      type: "uninstall",
      record,
      old: record,
      backupId,
    }),
  );
  await fs.link(record.descriptorPath, backup);
  assert.equal((await fs.stat(record.descriptorPath)).nlink, 2);
  assert.deepEqual(await f.restart().recover(), {
    recovered: true,
    action: "rolled-back",
  });
  assert.equal((await fs.stat(record.descriptorPath)).nlink, 1);
  await assert.rejects(fs.stat(backup), { code: "ENOENT" });
  assert.deepEqual(await f.restart().list(), [installed]);
});

test("modified managed descriptors are hidden from installed results and preserved on uninstall", async (t) => {
  const f = await fixture(t),
    old = await f.service.install(await f.archive());
  await fs.appendFile(old.descriptorPath, "# user changed this\n");
  assert.deepEqual(await f.service.list(), []);
  await assert.rejects(
    f.service.uninstall("123", { userDataPath: f.userData }),
    /改变/,
  );
  assert.match(await fs.readFile(old.descriptorPath, "utf8"), /user changed/);
});

test("missing installed content is not reported as installed and can be restored", async (t) => {
  const f = await fixture(t),
    input = await f.archive(),
    old = await f.service.install(input);
  await fs.rename(old.contentPath, old.contentPath + "-moved");
  assert.deepEqual(await f.service.list(), []);
  const repaired = await f.service.install(input);
  assert.notEqual(repaired.contentPath, old.contentPath);
  assert.deepEqual(await f.service.list(), [repaired]);
  assert.equal(
    (await f.service.uninstall("123", { userDataPath: f.userData })).removed,
    true,
  );
});

test("staging root replacement is rejected and cleanup never follows the foreign junction", async (t) => {
  const f = await fixture(t),
    outside = path.join(f.root, "outside");
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "keep.txt"), "foreign data");
  let replaced = false;
  await assert.rejects(
    f.service.install({
      ...(await f.archive()),
      onProgress: async (progress) => {
        if (progress.stage !== "verifying" || replaced) return;
        replaced = true;
        const tasks = await fs.readdir(path.join(f.storage, "tasks"));
        const task = path.join(f.storage, "tasks", tasks[0]);
        await fs.rename(task, path.join(f.root, "displaced-task"));
        await fs.symlink(outside, task, "junction");
      },
    }),
    /链接|联接|替换/,
  );
  assert.equal(replaced, true);
  assert.equal(
    await fs.readFile(path.join(outside, "keep.txt"), "utf8"),
    "foreign data",
  );
  assert.deepEqual(await f.service.list(), []);
});

test("foreign links inserted into extracted content are rejected and preserved during cleanup", async (t) => {
  const f = await fixture(t),
    outside = path.join(f.root, "outside");
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "keep.txt"), "foreign data");
  let link;
  await assert.rejects(
    f.service.install({
      ...(await f.archive()),
      onProgress: async (progress) => {
        if (progress.stage !== "committing") return;
        const tasks = await fs.readdir(path.join(f.storage, "tasks"));
        link = path.join(
          f.storage,
          "tasks",
          tasks[0],
          "content",
          "foreign-link",
        );
        await fs.symlink(outside, link, "junction");
      },
    }),
    /链接|身份/,
  );
  assert.equal((await fs.lstat(link)).isSymbolicLink(), true);
  assert.equal(
    await fs.readFile(path.join(outside, "keep.txt"), "utf8"),
    "foreign data",
  );
  assert.deepEqual(await f.service.list(), []);
});
