"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  canRemoveLocalMod,
  removeLocalMod,
} = require("../electron/mod-removal.cjs");

async function fixture(t, { archive = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ironclad-removal-"));
  t.after(async () => {
    assert.ok(path.isAbsolute(root));
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("ironclad-removal-"));
    await fs.rm(root, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 50,
    });
  });
  const userData = path.join(root, "中文 Documents", "HOI4");
  const modRoot = path.join(userData, "mod");
  const write = async (filename, bytes) => {
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, bytes);
    return filename;
  };
  const contentPath = path.join(modRoot, archive ? "模组包.zip" : "我的模组");
  const descriptorPath = path.join(modRoot, "我的模组.mod");
  const original = `name="我的模组"\n${archive ? "archive" : "path"}="mod/${path.basename(contentPath)}"\n`;
  await write(descriptorPath, original);
  if (archive) await write(contentPath, "inert archive fixture bytes");
  else {
    await write(path.join(contentPath, "descriptor.mod"), 'name="我的模组"\n');
    await write(
      path.join(contentPath, "common", "ideas", "中文.txt"),
      "idea = { value = 1 }\n",
    );
  }
  const mod = {
    id: "local:我的模组.mod",
    name: "我的模组",
    source: "local",
    descriptorPath,
    contentPath,
    available: true,
  };
  const input = { userData, mod };
  return { root, userData, modRoot, write, mod, input, original };
}

async function untouched(f) {
  assert.equal(await fs.readFile(f.mod.descriptorPath, "utf8"), f.original);
  assert.ok(await fs.lstat(f.mod.contentPath));
}

test("local directory removal preserves all content and a recovery manifest in its own recycle directory", async (t) => {
  const f = await fixture(t);
  assert.equal(await canRemoveLocalMod(f.input), true);
  assert.equal(
    await canRemoveLocalMod({ ...f.input, mods: [{ ...f.mod }] }),
    true,
  );
  const before = await fs.readFile(
    path.join(f.mod.contentPath, "common", "ideas", "中文.txt"),
  );
  const result = await removeLocalMod(f.input);
  assert.equal(
    path.dirname(result.backupDirectory),
    path.join(f.userData, "ironclad-mod-trash"),
  );
  assert.match(path.basename(result.backupDirectory), /^[0-9a-f-]{36}$/);
  assert.deepEqual(
    await fs.readFile(
      path.join(
        result.backupDirectory,
        "content",
        "common",
        "ideas",
        "中文.txt",
      ),
    ),
    before,
  );
  assert.equal(
    await fs.readFile(
      path.join(result.backupDirectory, "registration.mod"),
      "utf8",
    ),
    f.original,
  );
  const manifest = JSON.parse(
    await fs.readFile(
      path.join(result.backupDirectory, "manifest.json"),
      "utf8",
    ),
  );
  assert.equal(manifest.operation, "remove-local-mod");
  assert.equal(manifest.userData, f.userData);
  assert.deepEqual(manifest.entries, [
    { originalPath: f.mod.contentPath, backupName: "content" },
    { originalPath: f.mod.descriptorPath, backupName: "registration.mod" },
  ]);
  await assert.rejects(fs.lstat(f.mod.contentPath), { code: "ENOENT" });
  await assert.rejects(fs.lstat(f.mod.descriptorPath), { code: "ENOENT" });
  assert.equal(await canRemoveLocalMod(f.input), false);
});

test("archive removal keeps the exact archive and uses localDescriptor when supplied", async (t) => {
  const f = await fixture(t, { archive: true });
  const originalBytes = await fs.readFile(f.mod.contentPath);
  const mod = {
    ...f.mod,
    localDescriptor: f.mod.descriptorPath,
    descriptorPath: path.join(f.root, "irrelevant.mod"),
  };
  const result = await removeLocalMod({ ...f.input, mod });
  assert.deepEqual(
    await fs.readFile(path.join(result.backupDirectory, "archive.zip")),
    originalBytes,
  );
  assert.equal(
    await fs.readFile(
      path.join(result.backupDirectory, "registration.mod"),
      "utf8",
    ),
    f.original,
  );
});

test("non-local, project, unavailable and missing mods are refused without writes", async (t) => {
  const f = await fixture(t);
  for (const mod of [
    { ...f.mod, source: "workshop" },
    { ...f.mod, source: "pdx" },
    { ...f.mod, projectId: "project-id" },
    { ...f.mod, available: false },
    { ...f.mod, contentPath: path.join(f.modRoot, "missing") },
    { ...f.mod, descriptorPath: path.join(f.modRoot, "missing.mod") },
  ]) {
    assert.equal(await canRemoveLocalMod({ ...f.input, mod }), false);
    await assert.rejects(removeLocalMod({ ...f.input, mod }));
  }
  await untouched(f);
  await assert.rejects(fs.lstat(path.join(f.userData, "ironclad-mod-trash")), {
    code: "ENOENT",
  });
});

test("external, root, same-file and non-direct registration paths cannot be removed", async (t) => {
  const f = await fixture(t);
  const outside = await f.write(
    path.join(f.root, "external.zip"),
    "outside sentinel",
  );
  const nested = await f.write(
    path.join(f.mod.contentPath, "nested.mod"),
    f.original,
  );
  for (const mod of [
    { ...f.mod, contentPath: outside },
    { ...f.mod, contentPath: f.userData },
    { ...f.mod, contentPath: f.modRoot },
    { ...f.mod, contentPath: f.mod.descriptorPath },
    { ...f.mod, descriptorPath: nested },
    { ...f.mod, descriptorPath: outside },
    { ...f.mod, contentPath: "relative/path" },
  ]) {
    assert.equal(await canRemoveLocalMod({ ...f.input, mod }), false);
    await assert.rejects(removeLocalMod({ ...f.input, mod }));
  }
  assert.equal(await fs.readFile(outside, "utf8"), "outside sentinel");
  await untouched(f);
});

test("the registration must still point to the scanned content at removal time", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.mod.descriptorPath, 'path="mod/other"\n');
  assert.equal(await canRemoveLocalMod(f.input), false);
  await assert.rejects(removeLocalMod(f.input), /发生变化/);
  assert.ok(await fs.lstat(f.mod.contentPath));
});

test("ordinary files must be registered as archives rather than directory mods", async (t) => {
  const f = await fixture(t, { archive: true });
  await fs.writeFile(
    f.mod.descriptorPath,
    `path="mod/${path.basename(f.mod.contentPath)}"\n`,
  );
  assert.equal(await canRemoveLocalMod(f.input), false);
  await assert.rejects(removeLocalMod(f.input), /独立安装的本地模组/);
  assert.equal(
    await fs.readFile(f.mod.contentPath, "utf8"),
    "inert archive fixture bytes",
  );
});

test("shared content is refused for identical, ancestor and descendant registrations", async (t) => {
  const f = await fixture(t);
  for (const contentPath of [
    f.mod.contentPath,
    f.modRoot,
    path.join(f.mod.contentPath, "common"),
  ]) {
    const other = {
      ...f.mod,
      id: "local:another.mod",
      descriptorPath: path.join(f.modRoot, "another.mod"),
      contentPath,
    };
    const input = { ...f.input, mods: [f.mod, other] };
    assert.equal(await canRemoveLocalMod(input), false);
    await assert.rejects(removeLocalMod(input), /共用内容目录/);
  }
  await untouched(f);
});

test("without a supplied catalog, other on-disk registrations still protect shared archives", async (t) => {
  const f = await fixture(t, { archive: true });
  const other = await f.write(
    path.join(f.modRoot, "another.mod"),
    `archive="mod/${path.basename(f.mod.contentPath)}"\n`,
  );
  assert.equal(await canRemoveLocalMod(f.input), false);
  await assert.rejects(removeLocalMod(f.input), /共用内容目录/);
  assert.ok(await fs.lstat(other));
  await untouched(f);
});

test("actual removal checks registrations omitted by a deduplicated supplied catalog", async (t) => {
  const f = await fixture(t);
  const otherContent = path.join(f.modRoot, "other-content");
  await fs.mkdir(otherContent);
  const selected = await f.write(
    path.join(f.modRoot, "pdx_123_1.mod"),
    'name="Selected revision"\npath="mod/other-content"\n',
  );
  const hidden = await f.write(
    path.join(f.modRoot, "pdx_123_2.mod"),
    `name="Hidden shared revision"\npath="mod/${path.basename(f.mod.contentPath)}"\n`,
  );
  const input = {
    ...f.input,
    mods: [
      f.mod,
      { id: "pdx:123", descriptorPath: selected, contentPath: otherContent },
    ],
  };
  await assert.rejects(removeLocalMod(input), /共用内容目录/);
  await untouched(f);
  assert.ok(await fs.lstat(hidden));
  await assert.rejects(fs.lstat(path.join(f.userData, "ironclad-mod-trash")), {
    code: "ENOENT",
  });
});

test("an unscannable registration cannot bypass actual removal sharing checks", async (t) => {
  const f = await fixture(t);
  // A directory with a descriptor filename must fail closed as well as links;
  // neither is part of the ordinary-file catalog used for capability previews.
  await fs.mkdir(path.join(f.modRoot, "unscannable.mod"));
  await assert.rejects(
    removeLocalMod({ ...f.input, mods: [f.mod] }),
    /独立安装的本地模组/,
  );
  await untouched(f);
});

test("content junctions are rejected without touching their destination", async (t) => {
  const f = await fixture(t);
  const realContent = path.join(f.root, "external-content");
  await fs.rename(f.mod.contentPath, realContent);
  await fs.symlink(
    realContent,
    f.mod.contentPath,
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.equal(await canRemoveLocalMod(f.input), false);
  await assert.rejects(removeLocalMod(f.input), /链接|联接/);
  assert.equal(
    await fs.readFile(
      path.join(realContent, "common", "ideas", "中文.txt"),
      "utf8",
    ),
    "idea = { value = 1 }\n",
  );
});

test("ancestor junctions at the mod root and user directory are rejected", async (t) => {
  for (const target of ["mod", "userData"]) {
    await t.test(target, async (t) => {
      const f = await fixture(t),
        originalPath = target === "mod" ? f.modRoot : f.userData;
      const relocated = path.join(f.root, "relocated");
      await fs.rename(originalPath, relocated);
      await fs.symlink(
        relocated,
        originalPath,
        process.platform === "win32" ? "junction" : "dir",
      );
      assert.equal(await canRemoveLocalMod(f.input), false);
      await assert.rejects(removeLocalMod(f.input), /链接|联接/);
      assert.ok(
        await fs.lstat(
          path.join(
            relocated,
            target === "mod" ? "我的模组.mod" : "mod/我的模组.mod",
          ),
        ),
      );
    });
  }
});

test("a recycle-root junction or file is refused without modifying source files", async (t) => {
  for (const type of ["junction", "file"]) {
    await t.test(type, async (t) => {
      const f = await fixture(t),
        trash = path.join(f.userData, "ironclad-mod-trash");
      if (type === "file") await f.write(trash, "never overwrite");
      else {
        const outside = path.join(f.root, "recycle-outside");
        await fs.mkdir(outside);
        await fs.symlink(
          outside,
          trash,
          process.platform === "win32" ? "junction" : "dir",
        );
      }
      assert.equal(await canRemoveLocalMod(f.input), false);
      await assert.rejects(removeLocalMod(f.input));
      await untouched(f);
    });
  }
});

test("second rename failure rolls back the moved content and retains its diagnostic manifest", async (t) => {
  const f = await fixture(t);
  let backupDirectory;
  const fileOps = {
    rename: async (source, target) => {
      if (source === f.mod.descriptorPath)
        throw Object.assign(new Error("injected descriptor move failure"), {
          code: "EACCES",
        });
      if (source === f.mod.contentPath) backupDirectory = path.dirname(target);
      return fs.rename(source, target);
    },
  };
  await assert.rejects(removeLocalMod({ ...f.input, fileOps }), /已恢复原文件/);
  await untouched(f);
  assert.ok(await fs.lstat(path.join(backupDirectory, "manifest.json")));
  await assert.rejects(fs.lstat(path.join(backupDirectory, "content")), {
    code: "ENOENT",
  });
});

test("a rename that completes before reporting failure is still rolled back", async (t) => {
  const f = await fixture(t);
  let injected = false;
  const fileOps = {
    rename: async (source, target) => {
      await fs.rename(source, target);
      if (source === f.mod.descriptorPath && !injected) {
        injected = true;
        throw new Error("late rename failure");
      }
    },
  };
  await assert.rejects(removeLocalMod({ ...f.input, fileOps }), /已恢复原文件/);
  await untouched(f);
});

test("commit runs after the manifest and both moves; rejecting it restores both original files", async (t) => {
  const f = await fixture(t);
  let backupDirectory,
    committed = false;
  await assert.rejects(
    removeLocalMod({
      ...f.input,
      commit: async (input) => {
        backupDirectory = input.backupDirectory;
        assert.ok(await fs.lstat(path.join(backupDirectory, "manifest.json")));
        assert.ok(await fs.lstat(path.join(backupDirectory, "content")));
        assert.ok(
          await fs.lstat(path.join(backupDirectory, "registration.mod")),
        );
        await assert.rejects(fs.lstat(f.mod.descriptorPath), {
          code: "ENOENT",
        });
        committed = true;
        throw new Error("settings persistence rejected");
      },
    }),
    /已恢复原文件/,
  );
  assert.equal(committed, true);
  await untouched(f);
  assert.ok(await fs.lstat(path.join(backupDirectory, "manifest.json")));
});

test("a successful settings commit is followed by no further filesystem operations", async (t) => {
  const f = await fixture(t);
  let committed = false;
  const fileOps = Object.fromEntries(
    ["lstat", "realpath", "open", "mkdir", "rename", "readdir"].map(
      (method) => [
        method,
        (...args) => {
          assert.equal(
            committed,
            false,
            `unexpected ${method} after settings commit`,
          );
          return fs[method](...args);
        },
      ],
    ),
  );
  const result = await removeLocalMod({
    ...f.input,
    fileOps,
    commit: async () => {
      committed = true;
    },
  });
  assert.equal(committed, true);
  assert.ok(
    await fs.lstat(path.join(result.backupDirectory, "registration.mod")),
  );
});

test("rollback preserves a concurrent replacement and retains the moved original for recovery", async (t) => {
  const f = await fixture(t);
  let backupDirectory;
  await assert.rejects(
    removeLocalMod({
      ...f.input,
      commit: async (input) => {
        backupDirectory = input.backupDirectory;
        await fs.writeFile(f.mod.descriptorPath, "new unrelated registration");
        throw new Error("commit rejected");
      },
    }),
    /部分文件保留/,
  );
  assert.equal(
    await fs.readFile(f.mod.descriptorPath, "utf8"),
    "new unrelated registration",
  );
  assert.equal(
    await fs.readFile(path.join(backupDirectory, "registration.mod"), "utf8"),
    f.original,
  );
  assert.ok(await fs.lstat(f.mod.contentPath));
});

test("an unexpected pre-existing recovery directory is never overwritten or deleted", async (t) => {
  const f = await fixture(t);
  let unknown;
  const fileOps = {
    mkdir: async (directory) => {
      if (path.basename(path.dirname(directory)) === "ironclad-mod-trash") {
        await fs.mkdir(directory);
        unknown = path.join(directory, "unknown.txt");
        await fs.writeFile(unknown, "preserve unrelated recovery data");
        throw Object.assign(new Error("unexpected existing UUID directory"), {
          code: "EEXIST",
        });
      }
      return fs.mkdir(directory);
    },
  };
  await assert.rejects(removeLocalMod({ ...f.input, fileOps }), /已恢复原文件/);
  await untouched(f);
  assert.equal(
    await fs.readFile(unknown, "utf8"),
    "preserve unrelated recovery data",
  );
});
