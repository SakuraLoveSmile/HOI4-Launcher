"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const {
  createLocalMod,
  readLocalModMetadata,
  updateLocalModMetadata,
} = require("../electron/mod-authoring.cjs");

const input = (patch = {}) => ({
  name: "我的中文模组",
  folder: "my_local_mod",
  version: "0.1.0",
  supportedVersion: "1.19.*",
  tags: ["Alternative History", "Balance"],
  description: "我的第一场战役。",
  ...patch,
});

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ironclad-authoring-"));
  t.after(() =>
    fs.rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    }),
  );
  const userData = path.join(root, "中文 Documents", "Hearts of Iron IV");
  const write = async (filename, content) => {
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, content);
    return filename;
  };
  const create = (patch = {}, fsImpl) =>
    createLocalMod({
      userData,
      input: input(patch),
      ...(fsImpl ? { fsImpl } : {}),
    });
  return { root, userData, modRoot: path.join(userData, "mod"), write, create };
}

test("creates a discoverable local mod with inner and registered descriptors", async (t) => {
  const f = await fixture(t);
  const created = await f.create({ folder: "我的模组" });
  assert.equal(created.id, "local:我的模组.mod");
  assert.equal(created.contentPath, path.join(f.modRoot, "我的模组"));
  const outer = await fs.readFile(created.descriptorPath, "utf8");
  const inner = await fs.readFile(
    path.join(created.contentPath, "descriptor.mod"),
    "utf8",
  );
  assert.match(outer, /path="mod\/我的模组"/);
  assert.doesNotMatch(inner, /^path=/m);
  const metadata = await readLocalModMetadata({
    userData: f.userData,
    descriptorPath: created.descriptorPath,
  });
  assert.equal(metadata.name, "我的中文模组");
  assert.equal(metadata.version, "0.1.0");
  assert.equal(metadata.supportedVersion, "1.19.*");
  assert.deepEqual(metadata.tags, ["Alternative History", "Balance"]);
  assert.equal(metadata.editable, true);
});

test("quotes and backslashes cannot break metadata fields", async (t) => {
  const f = await fixture(t);
  const name = 'A "quoted" \\ name';
  const description = 'First line\nSecond "quoted" line \\ end';
  const created = await f.create({
    name,
    description,
    tags: ['A "tag"', "路径\\tag", 'A "tag"'],
  });
  const metadata = await readLocalModMetadata({
    userData: f.userData,
    descriptorPath: created.descriptorPath,
  });
  assert.equal(metadata.name, name);
  assert.equal(metadata.description, description);
  assert.deepEqual(metadata.tags, ['A "tag"', "路径\\tag"]);
  const outer = await fs.readFile(created.descriptorPath, "utf8");
  assert.equal((outer.match(/^path=/gm) || []).length, 1);
});

test("rejects unsafe Windows folder names before creating any directory", async (t) => {
  const f = await fixture(t);
  for (const folder of [
    "",
    ".",
    "..",
    "../escape",
    "a/b",
    "a\\b",
    "C:\\escape",
    "a:",
    "CON",
    "nul.txt",
    "LPT1.mod",
    "com9",
    "COM¹",
    "CONIN$",
    "name.",
    "name ",
    " leading",
    "a\0b",
    'a"b',
    "a*b",
    "a?b",
    "a|b",
  ])
    await assert.rejects(f.create({ folder }), /文件夹名称无效/);
  await assert.rejects(fs.stat(f.userData), { code: "ENOENT" });
});

test("validates names, versions, tags and unknown input fields", async (t) => {
  const f = await fixture(t);
  for (const patch of [
    { name: "\n" },
    { version: "" },
    { supportedVersion: "1.*.4" },
    { supportedVersion: '1.19.*"\npath="bad' },
    { tags: ["bad\ntag"] },
    { tags: Array(33).fill("tag") },
    { description: "bad\0text" },
    { remote_file_id: "123" },
  ])
    await assert.rejects(f.create(patch));
  await assert.rejects(fs.stat(f.userData), { code: "ENOENT" });
});

test("existing folder and descriptor collisions are never overwritten", async (t) => {
  const f = await fixture(t);
  const content = path.join(f.modRoot, "my_local_mod");
  await f.write(path.join(content, "foreign.txt"), "keep folder");
  await assert.rejects(f.create(), /已经存在/);
  assert.equal(
    await fs.readFile(path.join(content, "foreign.txt"), "utf8"),
    "keep folder",
  );
  await f.write(path.join(f.modRoot, "another.mod"), "keep descriptor");
  await assert.rejects(f.create({ folder: "another" }), /已经存在/);
  assert.equal(
    await fs.readFile(path.join(f.modRoot, "another.mod"), "utf8"),
    "keep descriptor",
  );
  await assert.rejects(fs.stat(path.join(f.modRoot, "another")), {
    code: "ENOENT",
  });
});

test("concurrent creation has one winner and a complete descriptor pair", async (t) => {
  const f = await fixture(t);
  const attempts = await Promise.allSettled([f.create(), f.create()]);
  assert.equal(
    attempts.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(
    attempts.filter((result) => result.status === "rejected").length,
    1,
  );
  const result = attempts.find(
    (attempt) => attempt.status === "fulfilled",
  ).value;
  assert.equal(
    (
      await readLocalModMetadata({
        userData: f.userData,
        descriptorPath: result.descriptorPath,
      })
    ).name,
    input().name,
  );
  assert.ok(await fs.stat(path.join(result.contentPath, "descriptor.mod")));
});

test("partial creation failure removes only its own files and empty directories", async (t) => {
  const f = await fixture(t);
  const failingFs = {
    ...fs,
    open: async (filename, flags) => {
      if (
        filename === path.join(f.modRoot, "my_local_mod.mod") &&
        flags === "wx"
      )
        throw Object.assign(new Error("injected failure"), { code: "EACCES" });
      return fs.open(filename, flags);
    },
  };
  await assert.rejects(f.create({}, failingFs), /访问权限/);
  await assert.rejects(fs.stat(f.userData), { code: "ENOENT" });
  assert.deepEqual(await fs.readdir(f.root), []);
});

test("rollback preserves content written concurrently into a newly created folder", async (t) => {
  const f = await fixture(t);
  const content = path.join(f.modRoot, "my_local_mod");
  const failingFs = {
    ...fs,
    open: async (filename, flags) => {
      if (
        filename === path.join(f.modRoot, "my_local_mod.mod") &&
        flags === "wx"
      ) {
        await fs.writeFile(
          path.join(content, "other-writer.txt"),
          "preserve this",
        );
        throw Object.assign(new Error("injected failure"), { code: "EACCES" });
      }
      return fs.open(filename, flags);
    },
  };
  const { original } = require("../electron/diagnostic-message.cjs");
  const { formatDiagnostic } = await import("../src/i18n-core.mjs");
  await assert.rejects(f.create({}, failingFs), (error) => {
    assert.match(error.message, /其他写入/);
    assert.equal(original(error.diagnostic), error.message);
    const rendered = formatDiagnostic("en", error.diagnostic, error.message);
    assert.match(rendered, /Some newly created content has been kept/);
    assert.ok(rendered.includes(content));
    assert.equal(
      rendered,
      "Create mod failed. Check access permissions for the mod directory. Some newly created content has been kept because of other writes or changed permissions. Check: " +
        error.diagnostic.values[1],
    );
    return true;
  });
  assert.equal(
    await fs.readFile(path.join(content, "other-writer.txt"), "utf8"),
    "preserve this",
  );
  await assert.rejects(fs.stat(path.join(content, "descriptor.mod")), {
    code: "ENOENT",
  });
});

test("an interrupted descriptor write cleans only its own written prefix", async (t) => {
  const f = await fixture(t);
  const failingFs = {
    ...fs,
    open: async (filename, flags) => {
      const handle = await fs.open(filename, flags);
      if (filename.endsWith(path.sep + "descriptor.mod") && flags === "wx")
        return {
          stat: () => handle.stat(),
          close: () => handle.close(),
          writeFile: async (bytes) => {
            await handle.writeFile(bytes.subarray(0, 16));
            throw Object.assign(new Error("partial write"), { code: "EACCES" });
          },
        };
      return handle;
    },
  };
  await assert.rejects(f.create({}, failingFs), /访问权限/);
  assert.deepEqual(await fs.readdir(f.root), []);
});

test("creation rejects a junction at the mod root without writing outside", async (t) => {
  const f = await fixture(t);
  const outside = path.join(f.root, "outside");
  await fs.mkdir(f.userData, { recursive: true });
  await fs.mkdir(outside);
  await fs.symlink(outside, f.modRoot, "junction");
  await assert.rejects(f.create(), /符号链接|目录联接/);
  assert.deepEqual(await fs.readdir(outside), []);
});

test("metadata edits preserve exact paths, unknown keys, published ids and backups", async (t) => {
  const f = await fixture(t);
  const created = await f.create();
  const innerPath = path.join(created.contentPath, "descriptor.mod");
  const outerOriginal = Buffer.from(
    '\uFEFF# user comment\r\nname="Old"\r\nversion="1"\r\nsupported_version="1.19.*"\r\ntags={"Balance"}\r\npath="mod/my_local_mod" # exact path comment\r\nremote_file_id="123456"\r\npops_id="my-published-mod"\r\nreplace_path="history/states"\r\nreplace_path="common/ideas"\r\ncustom={ nested="preserve" }\r\n',
  );
  const innerOriginal = Buffer.from(
    'name="Old"\nversion="1"\nsupported_version="1.19.*"\ntags={"Balance"}\nremote_file_id="123456"\ncustom_inner="keep"\n',
  );
  await fs.writeFile(created.descriptorPath, outerOriginal);
  await fs.writeFile(innerPath, innerOriginal);
  const before = await readLocalModMetadata({
    userData: f.userData,
    descriptorPath: created.descriptorPath,
  });
  assert.equal(before.remoteFileId, "123456");
  assert.equal(before.editable, true);
  const result = await updateLocalModMetadata({
    userData: f.userData,
    descriptorPath: created.descriptorPath,
    input: {
      name: 'Changed "name"',
      version: "2",
      tags: ["Balance", "Alternative History"],
    },
  });
  assert.equal(result.name, 'Changed "name"');
  assert.equal(result.remoteFileId, "123456");
  assert.equal(result.backups.length, 2);
  assert.deepEqual(
    await fs.readFile(
      result.backups.find((file) => file.startsWith(created.descriptorPath)),
    ),
    outerOriginal,
  );
  assert.deepEqual(
    await fs.readFile(
      result.backups.find((file) => file.startsWith(innerPath)),
    ),
    innerOriginal,
  );
  const outer = await fs.readFile(created.descriptorPath, "utf8");
  assert.ok(outer.startsWith("\uFEFF# user comment\r\n"));
  assert.ok(outer.includes('path="mod/my_local_mod" # exact path comment'));
  assert.ok(outer.includes('remote_file_id="123456"'));
  assert.ok(outer.includes('pops_id="my-published-mod"'));
  assert.equal((outer.match(/replace_path=/g) || []).length, 2);
  assert.ok(outer.includes('custom={ nested="preserve" }'));
  assert.ok(
    (await fs.readFile(innerPath, "utf8")).includes('custom_inner="keep"'),
  );
  assert.equal(
    (
      await readLocalModMetadata({
        userData: f.userData,
        descriptorPath: created.descriptorPath,
      })
    ).name,
    'Changed "name"',
  );
  assert.ok(
    !(await fs.readdir(f.modRoot)).some((name) =>
      /edit\.lock|ironclad-tmp/.test(name),
    ),
  );
});

test("updates restore both originals after a mid-transaction rename failure", async (t) => {
  const f = await fixture(t);
  const created = await f.create();
  const innerPath = path.join(created.contentPath, "descriptor.mod");
  const originalOuter = await fs.readFile(created.descriptorPath),
    originalInner = await fs.readFile(innerPath);
  let failed = false;
  const failingFs = {
    ...fs,
    rename: async (from, to) => {
      if (to === innerPath && from.includes(".ironclad-tmp-") && !failed) {
        failed = true;
        throw Object.assign(new Error("injected failure"), { code: "EACCES" });
      }
      return fs.rename(from, to);
    },
  };
  await assert.rejects(
    updateLocalModMetadata({
      userData: f.userData,
      descriptorPath: created.descriptorPath,
      input: { name: "New" },
      fsImpl: failingFs,
    }),
    /已恢复/,
  );
  assert.deepEqual(await fs.readFile(created.descriptorPath), originalOuter);
  assert.deepEqual(await fs.readFile(innerPath), originalInner);
  assert.ok(
    !(await fs.readdir(f.modRoot)).some((name) =>
      /edit\.lock|ironclad-tmp|ironclad-restore/.test(name),
    ),
  );
  assert.ok(
    (await fs.readdir(f.modRoot)).some((name) =>
      name.includes(".ironclad-backup-"),
    ),
  );
});

test("edit rollback and retained temporary path produce one fully translatable diagnostic", async (t) => {
  const f = await fixture(t),
    created = await f.create(),
    innerPath = path.join(created.contentPath, "descriptor.mod"),
    originalOuter = await fs.readFile(created.descriptorPath),
    originalInner = await fs.readFile(innerPath),
    lock = created.descriptorPath + ".ironclad-edit.lock";
  let failed = false;
  const failingFs = {
    ...fs,
    rename: async (from, to) => {
      if (to === innerPath && from.includes(".ironclad-tmp-") && !failed) {
        failed = true;
        throw Object.assign(new Error("injected raw failure"), {
          code: "EACCES",
        });
      }
      return fs.rename(from, to);
    },
    unlink: async (filename) => {
      if (filename === lock)
        throw Object.assign(new Error("held lock"), { code: "EPERM" });
      return fs.unlink(filename);
    },
  };
  let failure;
  try {
    await updateLocalModMetadata({
      userData: f.userData,
      descriptorPath: created.descriptorPath,
      input: { name: "New" },
      fsImpl: failingFs,
    });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure);
  const { original } = require("../electron/diagnostic-message.cjs"),
    { formatDiagnostic } = await import("../src/i18n-core.mjs"),
    translated = formatDiagnostic("en", failure.diagnostic, failure.message);
  assert.equal(original(failure.diagnostic), failure.message);
  assert.match(translated, /Update mod failed/);
  assert.match(translated, /original descriptor files have been restored/);
  assert.match(translated, /Temporary files have been kept/);
  assert.ok(translated.includes(lock));
  assert.doesNotMatch(
    translated.replace(lock, ""),
    /[\u3400-\u9fff]|injected raw failure/,
  );
  assert.deepEqual(await fs.readFile(created.descriptorPath), originalOuter);
  assert.deepEqual(await fs.readFile(innerPath), originalInner);
});

test("updates detect concurrent edits instead of overwriting them", async (t) => {
  const f = await fixture(t);
  const created = await f.create();
  const innerPath = path.join(created.contentPath, "descriptor.mod");
  let modified = false;
  const concurrentFs = {
    ...fs,
    open: async (filename, flags) => {
      if (filename.startsWith(innerPath + ".ironclad-tmp-") && !modified) {
        modified = true;
        await fs.appendFile(created.descriptorPath, "\n# another editor\n");
      }
      return fs.open(filename, flags);
    },
  };
  await assert.rejects(
    updateLocalModMetadata({
      userData: f.userData,
      descriptorPath: created.descriptorPath,
      input: { name: "New" },
      fsImpl: concurrentFs,
    }),
    /其他程序修改/,
  );
  const outer = await fs.readFile(created.descriptorPath, "utf8");
  assert.match(outer, /another editor/);
  assert.doesNotMatch(outer, /name="New"/);
  assert.ok(
    !(await fs.readdir(f.modRoot)).some((name) =>
      /edit\.lock|ironclad-tmp/.test(name),
    ),
  );
});

test("rollback leaves subsequent foreign edits intact and retains recovery backups", async (t) => {
  const f = await fixture(t);
  const created = await f.create();
  const innerPath = path.join(created.contentPath, "descriptor.mod");
  const failingFs = {
    ...fs,
    rename: async (from, to) => {
      if (to === innerPath && from.includes(".ironclad-tmp-")) {
        await fs.appendFile(
          created.descriptorPath,
          "\n# concurrent after commit\n",
        );
        throw Object.assign(new Error("injected failure"), { code: "EACCES" });
      }
      return fs.rename(from, to);
    },
  };
  await assert.rejects(
    updateLocalModMetadata({
      userData: f.userData,
      descriptorPath: created.descriptorPath,
      input: { name: "New" },
      fsImpl: failingFs,
    }),
    /部分文件未回滚/,
  );
  assert.match(
    await fs.readFile(created.descriptorPath, "utf8"),
    /concurrent after commit/,
  );
  assert.ok(
    (await fs.readdir(f.modRoot)).some((name) =>
      name.includes(".ironclad-backup-"),
    ),
  );
});

test("external Workshop content, traversal and archived mods are read-only", async (t) => {
  const f = await fixture(t);
  const created = await f.create();
  const outside = path.join(f.root, "workshop");
  await fs.mkdir(outside);
  await fs.writeFile(
    created.descriptorPath,
    'name="Remote"\npath=' +
      JSON.stringify(outside.replace(/\\/g, "/")) +
      '\nremote_file_id="123"\n',
  );
  await assert.rejects(
    readLocalModMetadata({
      userData: f.userData,
      descriptorPath: created.descriptorPath,
    }),
    /创意工坊|只读/,
  );
  await assert.rejects(
    updateLocalModMetadata({
      userData: f.userData,
      descriptorPath: path.join(f.root, "outside.mod"),
      input: { name: "New" },
    }),
    /只能编辑/,
  );
  await fs.writeFile(
    created.descriptorPath,
    'name="Archive"\narchive="mod/mod.zip"\n',
  );
  await assert.rejects(
    readLocalModMetadata({
      userData: f.userData,
      descriptorPath: created.descriptorPath,
    }),
    /压缩包/,
  );
});

test("junctions inside the authoring tree are refused without external mutations", async (t) => {
  const f = await fixture(t);
  const outside = path.join(f.root, "outside");
  await fs.mkdir(outside);
  await f.write(
    path.join(f.modRoot, "linked.mod"),
    'name="Linked"\npath="mod/linked"\n',
  );
  await fs.symlink(outside, path.join(f.modRoot, "linked"), "junction");
  await assert.rejects(
    updateLocalModMetadata({
      userData: f.userData,
      descriptorPath: path.join(f.modRoot, "linked.mod"),
      input: { name: "New" },
    }),
    /符号链接|目录联接/,
  );
  assert.deepEqual(await fs.readdir(outside), []);
});

test("existing nested local author folders retain their path during metadata edits", async (t) => {
  const f = await fixture(t);
  const created = await f.create();
  const group = path.join(f.modRoot, "author-group");
  await fs.mkdir(group);
  const nested = path.join(group, "my_local_mod");
  await fs.rename(created.contentPath, nested);
  const original = (await fs.readFile(created.descriptorPath, "utf8")).replace(
    'path="mod/my_local_mod"',
    'path="mod/author-group/my_local_mod"',
  );
  await fs.writeFile(created.descriptorPath, original);
  const result = await updateLocalModMetadata({
    userData: f.userData,
    descriptorPath: created.descriptorPath,
    input: { name: "Nested local mod", folder: "my_local_mod" },
  });
  assert.equal(result.contentPath, nested);
  assert.match(
    await fs.readFile(created.descriptorPath, "utf8"),
    /path="mod\/author-group\/my_local_mod"/,
  );
  assert.match(
    await fs.readFile(path.join(nested, "descriptor.mod"), "utf8"),
    /name="Nested local mod"/,
  );
});

test("missing inner descriptor is recreated from outer metadata without losing remote ids", async (t) => {
  const f = await fixture(t);
  const created = await f.create();
  const inner = path.join(created.contentPath, "descriptor.mod");
  await fs.unlink(inner);
  await fs.appendFile(
    created.descriptorPath,
    'remote_file_id="123"\ncustom="keep"\n',
  );
  const result = await updateLocalModMetadata({
    userData: f.userData,
    descriptorPath: created.descriptorPath,
    input: { name: "Published author mod" },
  });
  assert.equal(result.backups.length, 1);
  const text = await fs.readFile(inner, "utf8");
  assert.match(text, /remote_file_id="123"/);
  assert.match(text, /custom="keep"/);
  assert.doesNotMatch(text, /^path=/m);
});

test("existing edit lock and folder rename attempts do not change descriptors", async (t) => {
  const f = await fixture(t);
  const created = await f.create();
  const original = await fs.readFile(created.descriptorPath);
  await fs.writeFile(
    created.descriptorPath + ".ironclad-edit.lock",
    "another editor owns this",
  );
  await assert.rejects(
    updateLocalModMetadata({
      userData: f.userData,
      descriptorPath: created.descriptorPath,
      input: { name: "New" },
    }),
    /编辑锁/,
  );
  assert.equal(
    await fs.readFile(created.descriptorPath + ".ironclad-edit.lock", "utf8"),
    "another editor owns this",
  );
  await assert.rejects(
    updateLocalModMetadata({
      userData: f.userData,
      descriptorPath: created.descriptorPath,
      input: { folder: "different" },
    }),
    /不能重命名/,
  );
  assert.deepEqual(await fs.readFile(created.descriptorPath), original);
});

test("invalid UTF-8 or malformed descriptor syntax is never overwritten", async (t) => {
  const f = await fixture(t);
  const created = await f.create();
  for (const bytes of [
    Buffer.from([0xff, 0xfe, 0x00]),
    Buffer.from('name="broken'),
  ]) {
    await fs.writeFile(created.descriptorPath, bytes);
    await assert.rejects(
      updateLocalModMetadata({
        userData: f.userData,
        descriptorPath: created.descriptorPath,
        input: { name: "New" },
      }),
    );
    assert.deepEqual(await fs.readFile(created.descriptorPath), bytes);
  }
});
