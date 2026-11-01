"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const data = require("../electron/managed-data.cjs");

async function fixture(t) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "ironclad-managed-data-"),
  );
  t.after(async () => {
    assert.equal(path.dirname(root), os.tmpdir());
    assert.ok(path.basename(root).startsWith("ironclad-managed-data-"));
    await fs.rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  });
  return {
    root,
    target: path.join(root, "record.json"),
    staged: path.join(root, "staged.bin"),
  };
}

async function retained(root, prefix) {
  const names = (await fs.readdir(root)).filter((name) =>
    name.startsWith(prefix),
  );
  return Promise.all(
    names.map(async (name) => ({
      name,
      bytes: await fs.readFile(path.join(root, name), "utf8"),
    })),
  );
}

test("exclusive installation leaves one normal target and removes its own staging name", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.staged, "verified staged bytes");
  await data.installExclusive(f.staged, f.target);
  assert.equal(await fs.readFile(f.target, "utf8"), "verified staged bytes");
  assert.equal((await data.file(f.target)).nlink, 1);
  await assert.rejects(fs.lstat(f.staged), { code: "ENOENT" });
});

test("exclusive installation preserves an occupied target and all staging bytes", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.staged, "requested");
  await fs.writeFile(f.target, "external");
  await assert.rejects(data.installExclusive(f.staged, f.target), {
    code: "EEXIST",
  });
  assert.equal(await fs.readFile(f.target, "utf8"), "external");
  assert.equal(await fs.readFile(f.staged, "utf8"), "requested");
  assert.equal((await data.file(f.target)).nlink, 1);
});

test("exclusive installation rejects hardlinks and directory junctions before publishing", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.staged, "original");
  await fs.link(f.staged, path.join(f.root, "hardlink"));
  await assert.rejects(data.installExclusive(f.staged, f.target), /链接/);
  await assert.rejects(fs.lstat(f.target), { code: "ENOENT" });
  const real = path.join(f.root, "real"),
    linked = path.join(f.root, "linked");
  await fs.mkdir(real);
  await fs.writeFile(path.join(real, "stage"), "safe bytes");
  await fs.symlink(
    real,
    linked,
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(
    data.installExclusive(path.join(linked, "stage"), f.target),
    /链接/,
  );
  await assert.rejects(
    data.installExclusive(
      path.join(real, "stage"),
      path.join(linked, "target"),
    ),
    /链接/,
  );
});

test("a target replaced after linking is retained and does not cause deletion of the stage", async (t) => {
  const f = await fixture(t),
    link = fs.link;
  await fs.writeFile(f.staged, "requested");
  t.mock.method(fs, "link", async (source, target) => {
    await link(source, target);
    if (target === f.target) {
      await fs.unlink(target);
      await fs.writeFile(target, "external replacement");
    }
  });
  await assert.rejects(data.installExclusive(f.staged, f.target), /发生变化/);
  assert.equal(await fs.readFile(f.target, "utf8"), "external replacement");
  assert.equal(await fs.readFile(f.staged, "utf8"), "requested");
});

test("a stage replaced after linking is retained instead of unlinking an external file", async (t) => {
  const f = await fixture(t),
    link = fs.link;
  await fs.writeFile(f.staged, "requested");
  t.mock.method(fs, "link", async (source, target) => {
    await link(source, target);
    if (target === f.target) {
      await fs.unlink(source);
      await fs.writeFile(source, "external staging replacement");
    }
  });
  await assert.rejects(data.installExclusive(f.staged, f.target), /发生变化/);
  assert.equal(await fs.readFile(f.target, "utf8"), "requested");
  assert.equal(
    await fs.readFile(f.staged, "utf8"),
    "external staging replacement",
  );
});

test("an unlink failure cannot report a successful exclusive installation", async (t) => {
  const f = await fixture(t),
    unlink = fs.unlink;
  await fs.writeFile(f.staged, "requested");
  t.mock.method(fs, "unlink", async (filename) => {
    if (filename === f.staged)
      throw Object.assign(new Error("isolated denied unlink"), {
        code: "EACCES",
      });
    return unlink(filename);
  });
  await assert.rejects(data.installExclusive(f.staged, f.target), {
    code: "EACCES",
  });
  assert.equal(await fs.readFile(f.staged, "utf8"), "requested");
  assert.equal(await fs.readFile(f.target, "utf8"), "requested");
});

test("new records publish exclusively and have no unnecessary previous backup", async (t) => {
  const f = await fixture(t);
  await data.atomic(f.target, Buffer.from("new record"), null);
  assert.equal(await fs.readFile(f.target, "utf8"), "new record");
  assert.equal((await data.file(f.target)).nlink, 1);
  assert.deepEqual(await retained(f.root, ".previous-"), []);
  assert.deepEqual(await retained(f.root, ".write-"), []);
});

test("an external creation immediately before new-record commit is never overwritten", async (t) => {
  const f = await fixture(t),
    link = fs.link;
  t.mock.method(fs, "link", async (source, target) => {
    if (target === f.target) await fs.writeFile(target, "external new record");
    return link(source, target);
  });
  await assert.rejects(data.atomic(f.target, Buffer.from("requested"), null), {
    code: "EEXIST",
  });
  assert.equal(await fs.readFile(f.target, "utf8"), "external new record");
  assert.equal((await retained(f.root, ".write-"))[0].bytes, "requested");
});

test("a normal existing-record update permanently retains the actual old file", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.target, "old record");
  await data.atomic(
    f.target,
    Buffer.from("new record"),
    Buffer.from("old record"),
  );
  assert.equal(await fs.readFile(f.target, "utf8"), "new record");
  assert.equal((await data.file(f.target)).nlink, 1);
  const previous = await retained(f.root, ".previous-");
  assert.equal(previous.length, 1);
  assert.equal(previous[0].bytes, "old record");
  assert.equal((await data.file(path.join(f.root, previous[0].name))).nlink, 1);
});

test("external modification immediately before moving an existing record is recovered and retained", async (t) => {
  const f = await fixture(t),
    rename = fs.rename;
  await fs.writeFile(f.target, "old record");
  t.mock.method(fs, "rename", async (source, target) => {
    if (source === f.target && path.basename(target).startsWith(".previous-"))
      await fs.writeFile(source, "external modification before move");
    return rename(source, target);
  });
  await assert.rejects(
    data.atomic(f.target, Buffer.from("requested"), Buffer.from("old record")),
    /外部修改/,
  );
  assert.equal(
    await fs.readFile(f.target, "utf8"),
    "external modification before move",
  );
  assert.equal(
    (await retained(f.root, ".previous-"))[0].bytes,
    "external modification before move",
  );
  assert.equal((await retained(f.root, ".write-"))[0].bytes, "requested");
  assert.equal((await data.file(f.target)).nlink, 1);
});

test("an external record created after moving the old target is preserved alongside the old file", async (t) => {
  const f = await fixture(t),
    rename = fs.rename;
  await fs.writeFile(f.target, "old record");
  t.mock.method(fs, "rename", async (source, target) => {
    await rename(source, target);
    if (source === f.target && path.basename(target).startsWith(".previous-"))
      await fs.writeFile(source, "external record after move");
  });
  await assert.rejects(
    data.atomic(f.target, Buffer.from("requested"), Buffer.from("old record")),
    { code: "EEXIST" },
  );
  assert.equal(
    await fs.readFile(f.target, "utf8"),
    "external record after move",
  );
  assert.equal((await retained(f.root, ".previous-"))[0].bytes, "old record");
  assert.equal((await retained(f.root, ".write-"))[0].bytes, "requested");
});

test("failed installation restores the old target exclusively while retaining the previous backup", async (t) => {
  const f = await fixture(t),
    link = fs.link;
  await fs.writeFile(f.target, "old record");
  t.mock.method(fs, "link", async (source, target) => {
    if (path.basename(source).startsWith(".write-") && target === f.target)
      throw Object.assign(new Error("isolated install failure"), {
        code: "EIO",
      });
    return link(source, target);
  });
  await assert.rejects(
    data.atomic(f.target, Buffer.from("requested"), Buffer.from("old record")),
    { code: "EIO" },
  );
  assert.equal(await fs.readFile(f.target, "utf8"), "old record");
  assert.equal((await retained(f.root, ".previous-"))[0].bytes, "old record");
  assert.deepEqual(await retained(f.root, ".recover-"), []);
  assert.equal((await data.file(f.target)).nlink, 1);
});

test("an external creation during recovery cannot be overwritten by the rollback", async (t) => {
  const f = await fixture(t),
    link = fs.link;
  await fs.writeFile(f.target, "old record");
  t.mock.method(fs, "link", async (source, target) => {
    if (target === f.target && path.basename(source).startsWith(".write-"))
      throw Object.assign(new Error("isolated install failure"), {
        code: "EIO",
      });
    if (target === f.target && path.basename(source).startsWith(".recover-"))
      await fs.writeFile(target, "external creation during recovery");
    return link(source, target);
  });
  await assert.rejects(
    data.atomic(f.target, Buffer.from("requested"), Buffer.from("old record")),
    { code: "EIO" },
  );
  assert.equal(
    await fs.readFile(f.target, "utf8"),
    "external creation during recovery",
  );
  assert.equal((await retained(f.root, ".previous-"))[0].bytes, "old record");
  assert.equal((await retained(f.root, ".recover-"))[0].bytes, "old record");
});

test("a mismatching expected record is rejected before creating a replacement", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.target, "external record");
  await assert.rejects(
    data.atomic(f.target, Buffer.from("requested"), Buffer.from("old record")),
    /外部修改/,
  );
  assert.equal(await fs.readFile(f.target, "utf8"), "external record");
  assert.deepEqual(await fs.readdir(f.root), ["record.json"]);
});

test("staging write failure retains the partial staging file and leaves the original record untouched", async (t) => {
  const f = await fixture(t),
    open = fs.open;
  await fs.writeFile(f.target, "old record");
  let openedStage;
  t.mock.method(fs, "open", async (...args) => {
    const handle = await open(...args);
    if (path.basename(args[0]).startsWith(".write-")) {
      openedStage = handle;
      const writeFile = handle.writeFile.bind(handle);
      handle.writeFile = async () => {
        await writeFile(Buffer.from("partial"));
        throw Object.assign(new Error("isolated disk write failure"), {
          code: "EIO",
        });
      };
    }
    return handle;
  });
  await assert.rejects(
    data.atomic(f.target, Buffer.from("requested"), Buffer.from("old record")),
    { code: "EIO" },
  );
  assert.equal(openedStage.fd, -1);
  assert.equal(await fs.readFile(f.target, "utf8"), "old record");
  assert.equal((await retained(f.root, ".write-"))[0].bytes, "partial");
  assert.deepEqual(await retained(f.root, ".previous-"), []);
});

test("copyFile closes the already-open source when exclusive destination creation fails", async (t) => {
  const f = await fixture(t),
    open = fs.open;
  await fs.writeFile(f.staged, "source bytes");
  await fs.writeFile(f.target, "occupied destination");
  let openedSource;
  t.mock.method(fs, "open", async (...args) => {
    const handle = await open(...args);
    if (args[0] === f.staged) openedSource = handle;
    return handle;
  });
  await assert.rejects(data.copyFile(f.staged, f.target), { code: "EEXIST" });
  assert.equal(openedSource.fd, -1);
  assert.equal(await fs.readFile(f.staged, "utf8"), "source bytes");
  assert.equal(await fs.readFile(f.target, "utf8"), "occupied destination");
});

test("cancelled copies and hashes stop before opening files", async (t) => {
  const f = await fixture(t),
    controller = new AbortController();
  controller.abort();
  await assert.rejects(
    data.copyFile(f.staged, f.target, undefined, { signal: controller.signal }),
    { name: "AbortError", code: "ABORT_ERR" },
  );
  await assert.rejects(
    data.digestFile(f.staged, undefined, { signal: controller.signal }),
    { name: "AbortError", code: "ABORT_ERR" },
  );
  assert.deepEqual(await fs.readdir(f.root), []);
});

for (const operation of ["copyFile", "digestFile"]) {
  test(`${operation} checks cancellation between chunks and closes file handles`, async (t) => {
    const f = await fixture(t),
      controller = new AbortController(),
      open = fs.open,
      handles = [];
    const original = Buffer.alloc(3 * 1024 * 1024, 0x46);
    await fs.writeFile(f.staged, original);
    let reads = 0;
    t.mock.method(fs, "open", async (...args) => {
      const handle = await open(...args);
      handles.push(handle);
      if (args[0] === f.staged) {
        const read = handle.read.bind(handle);
        handle.read = async (...readArgs) => {
          const result = await read(...readArgs);
          reads++;
          controller.abort();
          return result;
        };
      }
      return handle;
    });
    const options = { signal: controller.signal };
    await assert.rejects(
      operation === "copyFile"
        ? data.copyFile(f.staged, f.target, undefined, options)
        : data.digestFile(f.staged, undefined, options),
      { name: "AbortError", code: "ABORT_ERR" },
    );
    assert.equal(reads, 1);
    assert.ok(handles.every((handle) => handle.fd === -1));
    assert.ok((await fs.readFile(f.staged)).equals(original));
    if (operation === "copyFile") {
      const retainedBytes = await fs.readFile(f.target);
      assert.equal(retainedBytes.length, 1024 * 1024);
      assert.ok(
        retainedBytes.equals(original.subarray(0, retainedBytes.length)),
      );
    } else await assert.rejects(fs.lstat(f.target), { code: "ENOENT" });
  });
}

test("digestFile honors cancellation during its final chunk", async (t) => {
  const f = await fixture(t),
    controller = new AbortController(),
    open = fs.open;
  await fs.writeFile(f.staged, "small file");
  t.mock.method(fs, "open", async (...args) => {
    const handle = await open(...args);
    if (args[0] === f.staged) {
      const read = handle.read.bind(handle);
      handle.read = async (...readArgs) => {
        const result = await read(...readArgs);
        controller.abort();
        return result;
      };
    }
    return handle;
  });
  await assert.rejects(
    data.digestFile(f.staged, undefined, { signal: controller.signal }),
    { name: "AbortError", code: "ABORT_ERR" },
  );
});
