"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const yazl = require("yazl");
const { createModProjectService } = require("../electron/mod-projects.cjs");
const { readLocalModMetadata } = require("../electron/mod-authoring.cjs");

const ref = {
  provider: "workshop",
  remoteId: "123",
  modId: "workshop:123",
  updatedAt: 1,
};
const descriptor =
  'name="Original"\nversion="1"\nsupported_version="1.19.*"\nremote_file_id="123"\npops_id="456"\npath="old"\narchive="old.zip"\ndependencies={"Other"}\nreplace_path="history/states"\nunknown={ keep=yes }\n';
async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ironclad-projects-"));
  t.after(() =>
    fs.rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    }),
  );
  const userData = path.join(root, "用户目录"),
    storageDirectory = path.join(root, "state"),
    source = path.join(root, "source");
  const write = async (filename, bytes) => {
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, bytes);
    return filename;
  };
  await write(path.join(source, "descriptor.mod"), descriptor);
  await write(path.join(source, "common", "a.txt"), "one\ntwo\nthree\n");
  const make = (extra = {}) =>
    createModProjectService({
      storageDirectory,
      getUserDataPath: async () => userData,
      ...options,
      ...extra,
    });
  const service = make();
  const create = (input = {}) =>
    service.create({
      name: "我的二改",
      sourcePath: source,
      upstreamRef: ref,
      baselineKnown: true,
      ...input,
    });
  const candidate = async (project, files = {}, extra = {}) => {
    const directory = path.join(
      root,
      "candidate-" + Math.random().toString(36).slice(2),
    );
    await fs.cp(source, directory, { recursive: true });
    for (const [name, value] of Object.entries(files)) {
      const filename = path.join(directory, name);
      if (value === null) await fs.rm(filename, { force: true });
      else await write(filename, value);
    }
    return service.captureCandidate(project.id, {
      sourcePath: directory,
      upstreamRef: ref,
      ...extra,
    });
  };
  const decisions = (plan, choices = {}) =>
    plan.entries
      .filter((e) => e.upstreamChanged)
      .map((e) => ({ path: e.path, choice: choices[e.path] || "upstream" }));
  return {
    root,
    userData,
    storageDirectory,
    source,
    write,
    make,
    service,
    create,
    candidate,
    decisions,
  };
}
async function zip(filename, entries) {
  const archive = new yazl.ZipFile();
  for (const [name, bytes, options] of entries)
    archive.addBuffer(Buffer.from(bytes), name, options);
  archive.end();
  const chunks = [];
  for await (const chunk of archive.outputStream) chunks.push(chunk);
  await fs.writeFile(filename, Buffer.concat(chunks));
}

test("creates independent, registered local projects and removes upstream publication identities", async (t) => {
  const f = await fixture(t),
    p = await f.create();
  assert.equal(p.modId, `local:ironclad_project_${p.id}.mod`);
  const inner = await fs.readFile(
    path.join(p.workPath, "descriptor.mod"),
    "utf8",
  );
  assert.match(inner, /name="我的二改"/);
  assert.doesNotMatch(inner, /^(remote_file_id|pops_id|archive|path)=/m);
  assert.match(inner, /dependencies=\{"Other"\}/);
  assert.match(inner, /replace_path=/);
  assert.match(inner, /unknown=/);
  const meta = await readLocalModMetadata({
    userData: f.userData,
    descriptorPath: p.descriptorPath,
  });
  assert.equal(meta.id, p.modId);
  assert.equal(meta.remoteFileId, null);
  assert.equal(meta.popsId, null);
  await f.write(path.join(p.workPath, "common", "a.txt"), "local edit");
  assert.equal(
    await fs.readFile(path.join(f.source, "common", "a.txt"), "utf8"),
    "one\ntwo\nthree\n",
  );
  await fs.rm(f.source, { recursive: true });
  assert.equal((await f.make().get(p.id)).id, p.id);
  assert.equal(
    (await f.service.inspect(p.id)).changes.find(
      (v) => v.path === "common/a.txt",
    ).status,
    "modified",
  );
});

test("list and get never ask for the current game directory", async (t) => {
  const f = await fixture(t),
    p = await f.create();
  const service = f.make({
    getUserDataPath: async () => {
      throw new Error("must not be called");
    },
  });
  assert.equal((await service.list()).projects[0].id, p.id);
  assert.equal((await service.get(p.id)).id, p.id);
});

test("ZIP import validates content and remains independent", async (t) => {
  const f = await fixture(t),
    archive = path.join(f.root, "mod.zip");
  await zip(archive, [
    ["descriptor.mod", descriptor],
    ["common/a.txt", "ZIP bytes"],
  ]);
  const p = await f.create({ sourcePath: archive });
  assert.equal(
    await fs.readFile(path.join(p.workPath, "common", "a.txt"), "utf8"),
    "ZIP bytes",
  );
  await fs.unlink(archive);
  assert.equal(
    (await f.service.resolveVersion(p.id, p.baseSnapshotId)).digest,
    p.snapshots[0].digest,
  );
});

test("read-only source files become independently editable copies", async (t) => {
  const f = await fixture(t),
    source = path.join(f.source, "common", "a.txt");
  await fs.chmod(source, 0o444);
  const p = await f.create();
  await fs.writeFile(
    path.join(p.workPath, "common", "a.txt"),
    "my writable copy",
  );
  assert.equal(await fs.readFile(source, "utf8"), "one\ntwo\nthree\n");
  await fs.chmod(source, 0o600);
});

test("missing inner descriptor gives an actionable error and leaves source untouched", async (t) => {
  const f = await fixture(t);
  await fs.unlink(path.join(f.source, "descriptor.mod"));
  await assert.rejects(
    f.create(),
    /请选择包含 descriptor\.mod 的模组内容目录，或将该文件放在 ZIP 根目录/,
  );
  assert.equal(
    await fs.readFile(path.join(f.source, "common", "a.txt"), "utf8"),
    "one\ntwo\nthree\n",
  );
  await assert.rejects(fs.stat(path.join(f.source, "descriptor.mod")), {
    code: "ENOENT",
  });
  assert.equal((await f.service.list()).projects.length, 0);
});

test("registered local mods without an inner descriptor accept a sanitized main-process fallback", async (t) => {
  const f = await fixture(t);
  await fs.unlink(path.join(f.source, "descriptor.mod"));
  const p = await f.create({
    descriptorText: descriptor,
    upstreamRef: null,
    baselineKnown: false,
  });
  const inner = await fs.readFile(
    path.join(p.workPath, "descriptor.mod"),
    "utf8",
  );
  assert.match(inner, /dependencies=\{"Other"\}/);
  assert.doesNotMatch(inner, /^(remote_file_id|pops_id|path|archive)=/m);
  await assert.rejects(fs.stat(path.join(f.source, "descriptor.mod")), {
    code: "ENOENT",
  });
  const archive = path.join(f.root, "old-format.zip");
  await zip(archive, [["common/a.txt", "new"]]);
  await f.service.captureCandidate(p.id, {
    sourcePath: archive,
    upstreamRef: null,
    descriptorText: descriptor,
  });
  assert.equal((await f.service.prepareMerge(p.id)).counts.upstreamChanged, 1);
});

test("an actual inner descriptor takes precedence over fallback registration text", async (t) => {
  const f = await fixture(t),
    p = await f.create({
      descriptorText: 'name="Fallback"\nsupported_version="0.0.*"\n',
    });
  const inner = await fs.readFile(
    path.join(p.workPath, "descriptor.mod"),
    "utf8",
  );
  assert.match(inner, /supported_version="1.19.\*"/);
  assert.doesNotMatch(inner, /0\.0\.\*/);
});

test("ZIP imports reject CRC corruption, case collisions and symlinks", async (t) => {
  const f = await fixture(t),
    archive = path.join(f.root, "bad.zip");
  await zip(archive, [
    ["descriptor.mod", descriptor],
    ["A.txt", "x"],
    ["a.txt", "y"],
  ]);
  await assert.rejects(f.create({ sourcePath: archive }), /大小写冲突/);
  await zip(archive, [
    ["descriptor.mod", descriptor],
    ["link", "elsewhere", { mode: 0o120777 }],
  ]);
  await assert.rejects(f.create({ sourcePath: archive }), /链接/);
  await zip(archive, [["descriptor.mod", descriptor, { compress: false }]]);
  const bytes = await fs.readFile(archive),
    index = bytes.indexOf(Buffer.from('name="Original"'));
  assert.ok(index > 0);
  bytes[index] ^= 1;
  await fs.writeFile(archive, bytes);
  await assert.rejects(f.create({ sourcePath: archive }), /CRC/);
  assert.equal((await f.service.list()).projects.length, 0);
});

test("directory imports reject file hardlinks and directory junctions", async (t) => {
  const f = await fixture(t),
    shared = path.join(f.root, "shared.txt");
  await f.write(shared, "shared");
  await fs.link(shared, path.join(f.source, "shared.txt"));
  await assert.rejects(f.create(), /硬链接/);
  await fs.unlink(path.join(f.source, "shared.txt"));
  await fs.symlink(
    path.dirname(shared),
    path.join(f.source, "junction"),
    "junction",
  );
  await assert.rejects(f.create(), /链接/);
});

test("source guards run around capture and failed candidates preserve the selected version", async (t) => {
  const f = await fixture(t);
  let checks = 0;
  const p = await f.create({
    checkSource: async () => {
      checks++;
    },
  });
  assert.equal(checks, 3);
  const first = await f.candidate(p, { "common/a.txt": "first" });
  let calls = 0;
  await assert.rejects(
    f.candidate(
      p,
      { "common/a.txt": "second" },
      {
        checkSource: async () => {
          if (++calls === 2) throw new Error("Steam is updating");
        },
      },
    ),
    /Steam is updating/,
  );
  assert.equal(
    (await f.service.get(p.id)).candidateSnapshotId,
    first.candidateSnapshotId,
  );
  assert.equal(
    await fs.readFile(path.join(p.workPath, "common", "a.txt"), "utf8"),
    "one\ntwo\nthree\n",
  );
});

test("candidate retrieval changes no working bytes or registration", async (t) => {
  const f = await fixture(t),
    p = await f.create(),
    registration = await fs.readFile(p.descriptorPath);
  await f.candidate(p, { "common/a.txt": "upstream" });
  assert.deepEqual(await fs.readFile(p.descriptorPath), registration);
  assert.equal(
    await fs.readFile(path.join(p.workPath, "common", "a.txt"), "utf8"),
    "one\ntwo\nthree\n",
  );
  const plan = await f.service.prepareMerge(p.id);
  assert.equal(
    plan.entries.find((e) => e.path === "common/a.txt").status,
    "upstream-only",
  );
  const text = await f.service.readMergeFile(p.id, plan.id, "common/a.txt");
  assert.equal(text.upstreamText, "upstream");
  await assert.rejects(
    f.service.readMergeFile(p.id, plan.id, "../outside"),
    /不安全/,
  );
});

test("text auto merge keeps non-overlapping edits and advances the per-file base", async (t) => {
  const f = await fixture(t),
    p = await f.create();
  await f.write(
    path.join(p.workPath, "common", "a.txt"),
    "local\ntwo\nthree\n",
  );
  await f.candidate(p, { "common/a.txt": "one\ntwo\nupstream\n" });
  const plan = await f.service.prepareMerge(p.id);
  assert.equal(
    plan.entries.find((e) => e.path === "common/a.txt").status,
    "merged",
  );
  assert.equal(plan.counts.merged, 1);
  assert.equal(plan.counts.conflicts, 0);
  await f.service.applyMerge(
    p.id,
    plan.id,
    f.decisions(plan, { "common/a.txt": "auto" }),
  );
  assert.equal(
    await fs.readFile(path.join(p.workPath, "common", "a.txt"), "utf8"),
    "local\ntwo\nupstream\n",
  );
  const next = await f.service.prepareMerge(p.id);
  assert.equal(next.counts.upstreamChanged, 0);
  assert.equal(
    next.entries.find((e) => e.path === "common/a.txt").status,
    "local-only",
  );
});

test("deferred entries remain pending across another candidate while kept-local choices consume the incoming base", async (t) => {
  const f = await fixture(t);
  await f.write(path.join(f.source, "b.txt"), "b0");
  await f.write(path.join(f.source, "c.txt"), "c0");
  const p = await f.create();
  await f.write(path.join(p.workPath, "b.txt"), "my b");
  await f.candidate(p, { "common/a.txt": "a1", "b.txt": "b1", "c.txt": "c1" });
  let plan = await f.service.prepareMerge(p.id);
  await f.service.applyMerge(
    p.id,
    plan.id,
    f.decisions(plan, { "common/a.txt": "defer", "b.txt": "local" }),
  );
  plan = await f.service.prepareMerge(p.id);
  assert.deepEqual(
    plan.entries.filter((e) => e.upstreamChanged).map((e) => e.path),
    ["common/a.txt"],
  );
  assert.equal(
    await fs.readFile(path.join(p.workPath, "b.txt"), "utf8"),
    "my b",
  );
  await f.candidate(p, { "common/a.txt": "a2", "b.txt": "b2", "c.txt": "c1" });
  plan = await f.service.prepareMerge(p.id);
  const a = await f.service.readMergeFile(p.id, plan.id, "common/a.txt"),
    b = await f.service.readMergeFile(p.id, plan.id, "b.txt");
  assert.equal(a.baseText, "one\ntwo\nthree\n");
  assert.equal(b.baseText, "b1");
  assert.equal(b.localText, "my b");
  assert.equal(
    plan.entries.find((e) => e.path === "c.txt").upstreamChanged,
    false,
  );
  assert.equal(
    (await f.service.get(p.id)).history
      .find((h) => h.type === "merged")
      .decisions.find((d) => d.path === "common/a.txt").choice,
    "defer",
  );
});

test("file fragments compose independent conflict choices and preserve unchanged UTF-16 content", async (t) => {
  const f = await fixture(t);
  const encoded = (text) =>
    Buffer.concat([Buffer.from([255, 254]), Buffer.from(text, "utf16le")]);
  await f.write(
    path.join(f.source, "common/a.txt"),
    encoded("first\r\nkeep\r\nlast\r\n"),
  );
  const p = await f.create();
  await f.write(
    path.join(p.workPath, "common/a.txt"),
    encoded("local first\r\nkeep\r\nlocal last\r\n"),
  );
  await f.candidate(p, {
    "common/a.txt": encoded("upstream first\r\nkeep\r\nupstream last\r\n"),
  });
  const plan = await f.service.prepareMerge(p.id);
  const file = await f.service.readMergeFile(p.id, plan.id, "common/a.txt");
  assert.equal(file.chunks.filter((c) => c.conflict).length, 2);
  let conflict = 0;
  const text = file.chunks
    .map((c) =>
      c.conflict
        ? ++conflict === 1
          ? c.localText
          : c.upstreamText
        : c.mergedText,
    )
    .join("");
  await f.service.applyMerge(p.id, plan.id, [
    { path: "common/a.txt", choice: "manual", text },
  ]);
  assert.deepEqual(
    await fs.readFile(path.join(p.workPath, "common/a.txt")),
    encoded("local first\r\nkeep\r\nupstream last\r\n"),
  );
  assert.deepEqual(
    await fs.readFile(path.join(f.source, "common/a.txt")),
    encoded("first\r\nkeep\r\nlast\r\n"),
  );
});

test("unknown bases require explicit adoption and changing upstream does not invent ancestry", async (t) => {
  const f = await fixture(t),
    p = await f.create({ baselineKnown: false });
  await f.candidate(p, { "common/a.txt": "new" });
  let plan = await f.service.prepareMerge(p.id);
  assert.deepEqual(
    (await f.service.readMergeFile(p.id, plan.id, "common/a.txt")).chunks,
    [],
  );
  await assert.rejects(
    f.service.applyMerge(
      p.id,
      plan.id,
      f.decisions(plan, { "common/a.txt": "auto" }),
    ),
    /基准未知/,
  );
  await f.service.applyMerge(p.id, plan.id, f.decisions(plan));
  assert.equal((await f.service.get(p.id)).baselineKnown, true);
  assert.equal(
    (await f.service.get(p.id)).history.find(
      (h) => h.type === "baseline-established",
    ).initialAncestryVerified,
    false,
  );
  const changed = await f.service.setUpstream(p.id, {
    provider: "pdx",
    remoteId: "456",
    modId: "pdx:456",
  });
  assert.equal(changed.baselineKnown, false);
  assert.equal(changed.candidateSnapshotId, null);
  assert.deepEqual(changed.originRef, ref);
  await assert.rejects(f.candidate(p, { "a.txt": "wrong" }), /不一致/);
});

test("unknown baselines remember an explicit keep-local choice without claiming global ancestry", async (t) => {
  const f = await fixture(t);
  await f.write(path.join(f.source, "b.txt"), "base");
  const p = await f.create({ baselineKnown: false });
  await f.candidate(p, { "common/a.txt": "u1", "b.txt": "b1" });
  let plan = await f.service.prepareMerge(p.id);
  const kept = await f.service.applyMerge(
    p.id,
    plan.id,
    f.decisions(plan, { "common/a.txt": "local", "b.txt": "defer" }),
  );
  assert.equal(kept.baselineKnown, false);
  assert.deepEqual(kept.knownBasePaths, ["common/a.txt"]);
  assert.equal((await f.service.prepareMerge(p.id)).counts.upstreamChanged, 1);
  const saved = await f.service.checkpoint(p.id, "unknown-base checkpoint");
  await f.candidate(p, { "common/a.txt": "u2", "b.txt": "b1" });
  plan = await f.service.prepareMerge(p.id);
  assert.equal(plan.counts.upstreamChanged, 2);
  assert.ok(
    (await f.service.readMergeFile(p.id, plan.id, "common/a.txt")).chunks
      .length,
  );
  assert.deepEqual(
    (await f.service.readMergeFile(p.id, plan.id, "b.txt")).chunks,
    [],
  );
  await f.service.restore(
    p.id,
    saved.snapshots.find((s) => s.name === "unknown-base checkpoint").id,
  );
  assert.equal((await f.service.prepareMerge(p.id)).counts.upstreamChanged, 1);
  assert.equal((await f.service.get(p.id)).baselineKnown, false);
});

test("complete review establishes a future base and permits reliable subsequent three-way comparison", async (t) => {
  const f = await fixture(t),
    p = await f.create({ baselineKnown: false });
  await f.candidate(p, { "common/a.txt": "one\ntwo\nu1\n" });
  let plan = await f.service.prepareMerge(p.id);
  const reviewed = await f.service.applyMerge(p.id, plan.id, [
    { path: "common/a.txt", choice: "manual", text: "local\ntwo\nu1\n" },
  ]);
  assert.equal(reviewed.baseSnapshotId, reviewed.candidateSnapshotId);
  assert.equal(reviewed.baselineKnown, true);
  await f.candidate(p, { "common/a.txt": "one\ntwo\nu2\n" });
  plan = await f.service.prepareMerge(p.id);
  assert.equal(
    plan.entries.find((e) => e.path === "common/a.txt").status,
    "merged",
  );
  await f.service.applyMerge(p.id, plan.id, [
    { path: "common/a.txt", choice: "auto" },
  ]);
  assert.equal(
    await fs.readFile(path.join(p.workPath, "common", "a.txt"), "utf8"),
    "local\ntwo\nu2\n",
  );
});

test("an identical candidate can establish a future base through an explicit empty review", async (t) => {
  const f = await fixture(t),
    p = await f.create({ baselineKnown: false });
  await f.candidate(p);
  const plan = await f.service.prepareMerge(p.id);
  assert.equal(plan.counts.upstreamChanged, 0);
  const updated = await f.service.applyMerge(p.id, plan.id, []);
  assert.equal(updated.baselineKnown, true);
  assert.equal(updated.baseSnapshotId, updated.candidateSnapshotId);
  assert.equal(updated.history.at(-1).type, "baseline-established");
});

test("unlinked local projects can compare a manually imported ZIP candidate", async (t) => {
  const f = await fixture(t),
    p = await f.create({ upstreamRef: null, baselineKnown: false });
  const archive = path.join(f.root, "manual.zip");
  await zip(archive, [
    ["descriptor.mod", descriptor],
    ["common/a.txt", "manual upstream"],
  ]);
  const captured = await f.service.captureCandidate(p.id, {
    sourcePath: archive,
    upstreamRef: null,
  });
  assert.equal(captured.upstreamRef, null);
  assert.ok(captured.candidateSnapshotId);
  const plan = await f.service.prepareMerge(p.id);
  assert.equal(plan.counts.upstreamChanged, 1);
});

test("source mutation while copying fails without creating a registered project", async (t) => {
  const f = await fixture(t),
    originalCopy = fs.copyFile;
  let changed = false;
  fs.copyFile = async (...args) => {
    await originalCopy(...args);
    if (!changed && args[0] === path.join(f.source, "common", "a.txt")) {
      changed = true;
      await fs.writeFile(args[0], "modified during capture");
    }
  };
  try {
    await assert.rejects(f.create(), /变化/);
  } finally {
    fs.copyFile = originalCopy;
  }
  assert.equal(changed, true);
  assert.equal((await f.service.list()).projects.length, 0);
});

test("external work edits invalidate a reviewed plan", async (t) => {
  const f = await fixture(t),
    p = await f.create();
  await f.candidate(p, { "common/a.txt": "new" });
  const plan = await f.service.prepareMerge(p.id);
  await f.write(
    path.join(p.workPath, "common", "a.txt"),
    "changed after review",
  );
  await assert.rejects(
    f.service.applyMerge(p.id, plan.id, f.decisions(plan)),
    /变化/,
  );
  assert.equal(
    await fs.readFile(path.join(p.workPath, "common", "a.txt"), "utf8"),
    "changed after review",
  );
});

test("decisions are exhaustive and binary files cannot accept manual text", async (t) => {
  const f = await fixture(t);
  await f.write(path.join(f.source, "image.dds"), Buffer.from([0, 1, 2]));
  const p = await f.create();
  await f.write(path.join(p.workPath, "image.dds"), Buffer.from([0, 2, 3]));
  await f.candidate(p, { "image.dds": Buffer.from([0, 3, 4]) });
  const plan = await f.service.prepareMerge(p.id);
  await assert.rejects(f.service.applyMerge(p.id, plan.id, []), /每个上游/);
  assert.equal(
    (await f.service.readMergeFile(p.id, plan.id, "image.dds")).binary,
    true,
  );
  await assert.rejects(
    f.service.applyMerge(p.id, plan.id, [
      { path: "image.dds", choice: "manual", text: "text" },
    ]),
    /二进制/,
  );
  await f.service.applyMerge(p.id, plan.id, [
    { path: "image.dds", choice: "upstream" },
  ]);
  assert.deepEqual(
    await fs.readFile(path.join(p.workPath, "image.dds")),
    Buffer.from([0, 3, 4]),
  );
});

test("manual edits preserve UTF-8 BOM and CRLF without writing conflict markers", async (t) => {
  const f = await fixture(t),
    bom = Buffer.from([0xef, 0xbb, 0xbf]);
  await f.write(
    path.join(f.source, "common", "a.txt"),
    Buffer.concat([bom, Buffer.from("base\r\n")]),
  );
  const p = await f.create();
  await f.write(
    path.join(p.workPath, "common", "a.txt"),
    Buffer.concat([bom, Buffer.from("local\r\n")]),
  );
  await f.candidate(p, {
    "common/a.txt": Buffer.concat([bom, Buffer.from("upstream\r\n")]),
  });
  const plan = await f.service.prepareMerge(p.id);
  await f.service.applyMerge(p.id, plan.id, [
    { path: "common/a.txt", choice: "manual", text: "resolved\r\n" },
  ]);
  assert.deepEqual(
    await fs.readFile(path.join(p.workPath, "common", "a.txt")),
    Buffer.concat([bom, Buffer.from("resolved\r\n")]),
  );
});

test("delete versus edit remains a conflict until explicitly selected", async (t) => {
  const f = await fixture(t),
    p = await f.create();
  await f.write(path.join(p.workPath, "common", "a.txt"), "my edit");
  await f.candidate(p, { "common/a.txt": null });
  const plan = await f.service.prepareMerge(p.id);
  await assert.rejects(
    f.service.applyMerge(
      p.id,
      plan.id,
      f.decisions(plan, { "common/a.txt": "auto" }),
    ),
    /冲突/,
  );
  await f.service.applyMerge(
    p.id,
    plan.id,
    f.decisions(plan, { "common/a.txt": "local" }),
  );
  assert.equal(
    await fs.readFile(path.join(p.workPath, "common", "a.txt"), "utf8"),
    "my edit",
  );
  assert.equal((await f.service.prepareMerge(p.id)).counts.upstreamChanged, 0);
});

test("restoring a checkpoint restores its base, candidate and decision context", async (t) => {
  const f = await fixture(t),
    p = await f.create();
  await f.candidate(p, { "common/a.txt": "u1" });
  const checkpoint = await f.service.checkpoint(p.id, "合入前"),
    selected = checkpoint.snapshots.find((s) => s.name === "合入前");
  const plan = await f.service.prepareMerge(p.id);
  await f.service.applyMerge(p.id, plan.id, f.decisions(plan));
  const changedBase = (await f.service.get(p.id)).baseSnapshotId;
  assert.notEqual(changedBase, p.baseSnapshotId);
  await f.candidate(p, { "common/a.txt": "u2" });
  const restored = await f.service.restore(p.id, selected.id);
  assert.equal(restored.baseSnapshotId, p.baseSnapshotId);
  assert.equal(restored.candidateSnapshotId, checkpoint.candidateSnapshotId);
  assert.equal(
    restored.snapshots.filter((s) => s.kind === "before-restore").length,
    1,
  );
  assert.equal(
    await fs.readFile(path.join(p.workPath, "common", "a.txt"), "utf8"),
    "one\ntwo\nthree\n",
  );
  assert.equal((await f.service.prepareMerge(p.id)).counts.upstreamChanged, 1);
});

test("local descriptor semantic edits are registered by the next transactional merge", async (t) => {
  const f = await fixture(t),
    p = await f.create();
  const filename = path.join(p.workPath, "descriptor.mod");
  await fs.appendFile(filename, "extra_semantics={ yes=yes }\n");
  await f.candidate(p, { "common/a.txt": "upstream" });
  const plan = await f.service.prepareMerge(p.id);
  await f.service.applyMerge(p.id, plan.id, f.decisions(plan));
  assert.match(
    await fs.readFile(p.descriptorPath, "utf8"),
    /extra_semantics=\{ yes=yes \}/,
  );
});

test("an externally changed registration is preserved and blocks a merge", async (t) => {
  const f = await fixture(t),
    p = await f.create();
  await f.candidate(p, { "common/a.txt": "upstream" });
  const plan = await f.service.prepareMerge(p.id);
  await fs.appendFile(p.descriptorPath, "# external edit\n");
  await assert.rejects(
    f.service.applyMerge(p.id, plan.id, f.decisions(plan)),
    /注册已被其他程序修改/,
  );
  assert.match(await fs.readFile(p.descriptorPath, "utf8"), /external edit/);
  assert.equal(
    await fs.readFile(path.join(p.workPath, "common", "a.txt"), "utf8"),
    "one\ntwo\nthree\n",
  );
});

test("snapshot reads and frozen-version resolution reject external changes", async (t) => {
  const f = await fixture(t),
    p = await f.create(),
    frozen = await f.service.resolveVersion(p.id, p.baseSnapshotId);
  await f.write(path.join(frozen.contentPath, "common", "a.txt"), "tampered");
  await assert.rejects(
    f.service.resolveVersion(p.id, p.baseSnapshotId),
    /变化/,
  );
  await assert.rejects(f.service.inspect(p.id), /变化/);
});

test("current-version resolution uses edited descriptor semantics without rewriting the stored registration", async (t) => {
  const f = await fixture(t),
    p = await f.create(),
    outer = await fs.readFile(p.descriptorPath);
  await fs.appendFile(
    path.join(p.workPath, "descriptor.mod"),
    'dependencies={"New dependency"}\nreplace_path="events"\nremote_file_id="999"\npath="C:/foreign"\n',
  );
  const current = await f.service.resolveVersion(p.id, null);
  assert.equal(current.contentPath, p.workPath);
  assert.equal(current.snapshotId, null);
  assert.match(current.descriptorText, /dependencies=\{"New dependency"\}/);
  assert.match(current.descriptorText, /replace_path="events"/);
  assert.doesNotMatch(
    current.descriptorText,
    /^(?:path|archive|remote_file_id|pops_id)=/m,
  );
  assert.deepEqual(await fs.readFile(p.descriptorPath), outer);
  const moved = p.workPath + "-original";
  await fs.rename(p.workPath, moved);
  await fs.symlink(moved, p.workPath, "junction");
  await assert.rejects(f.service.resolveVersion(p.id, null), /链接/);
});

test("technical comparison snapshots cannot be restored or fixed as playable versions", async (t) => {
  const f = await fixture(t),
    p = await f.create(),
    candidate = await f.candidate(p, { "common/a.txt": "new" });
  await assert.rejects(
    f.service.resolveVersion(p.id, candidate.candidateSnapshotId),
    /不能固定/,
  );
  await assert.rejects(
    f.service.restore(p.id, candidate.candidateSnapshotId),
    /不能作为可玩版本恢复/,
  );
  const plan = await f.service.prepareMerge(p.id),
    applied = await f.service.applyMerge(p.id, plan.id, f.decisions(plan));
  assert.equal(
    applied.snapshots.find((s) => s.id === applied.baseSnapshotId).kind,
    "merge-base",
  );
  await assert.rejects(
    f.service.resolveVersion(p.id, applied.baseSnapshotId),
    /不能固定/,
  );
  await assert.rejects(
    f.service.restore(p.id, applied.baseSnapshotId),
    /不能作为可玩版本恢复/,
  );
});

test("merge preview checks the selected content without modifying work, baselines or history", async (t) => {
  const f = await fixture(t),
    p = await f.create();
  await f.candidate(p, {
    "common/national_focus/tree.txt":
      "focus_tree = { id = tree focus = { id = NEW_FOCUS completion_reward = { country_event = { id = new.1 } } } }",
    "events/new.txt": "country_event = { id = new.1 }",
  });
  const plan = await f.service.prepareMerge(p.id),
    before = await f.service.get(p.id),
    original = await fs.readFile(
      path.join(f.storageDirectory, "projects", p.id, "project.json"),
    );
  const preview = await f.service.previewMerge(
    p.id,
    plan.id,
    f.decisions(plan, { "events/new.txt": "defer" }),
  );
  assert.equal(preview.counts.added, 1);
  assert.equal(preview.counts.deferred, 1);
  assert.ok(
    preview.checks.issues.some((i) => i.code === "external-event-reference"),
  );
  assert.deepEqual(
    await fs.readFile(
      path.join(f.storageDirectory, "projects", p.id, "project.json"),
    ),
    original,
  );
  await assert.rejects(
    fs.stat(path.join(p.workPath, "common", "national_focus", "tree.txt")),
    { code: "ENOENT" },
  );
  assert.equal(
    (await f.service.get(p.id)).baseSnapshotId,
    before.baseSnapshotId,
  );
  const full = await f.service.previewMerge(p.id, plan.id, f.decisions(plan));
  assert.equal(full.counts.added, 2);
  assert.ok(
    !full.checks.issues.some((i) => i.code === "external-event-reference"),
  );
});

for (const phase of [
  "prepared",
  "old-moved",
  "work-installed",
  "registration-installed",
  "metadata-installed",
]) {
  test(`interrupted merge at ${phase} recovers a coherent new tree and metadata`, async (t) => {
    let armed = false;
    const f = await fixture(t, {
      transactionObserver: async (at) => {
        if (armed && at === phase) throw new Error("simulated interruption");
      },
    });
    const p = await f.create();
    await f.candidate(p, { "common/a.txt": "new version" });
    const plan = await f.service.prepareMerge(p.id);
    armed = true;
    await assert.rejects(
      f.service.applyMerge(p.id, plan.id, f.decisions(plan)),
      /simulated interruption/,
    );
    const reopened = f.make({ transactionObserver: undefined }),
      recovered = await reopened.get(p.id);
    assert.equal(
      await fs.readFile(path.join(p.workPath, "common", "a.txt"), "utf8"),
      "new version",
    );
    assert.notEqual(recovered.baseSnapshotId, p.baseSnapshotId);
    assert.equal((await reopened.prepareMerge(p.id)).counts.upstreamChanged, 0);
    assert.equal(recovered.history.at(-1).type, "merged");
    assert.ok(recovered.retainedTrees.length);
    await assert.rejects(
      fs.stat(
        path.join(f.storageDirectory, "projects", p.id, "transaction.json"),
      ),
      { code: "ENOENT" },
    );
  });
}

test("recovery preserves and blocks an externally edited new work tree", async (t) => {
  let armed = false;
  const f = await fixture(t, {
    transactionObserver: async (at) => {
      if (armed && at === "work-installed") throw new Error("interruption");
    },
  });
  const p = await f.create();
  await f.candidate(p, { "common/a.txt": "upstream" });
  const plan = await f.service.prepareMerge(p.id);
  armed = true;
  await assert.rejects(
    f.service.applyMerge(p.id, plan.id, f.decisions(plan)),
    /interruption/,
  );
  await f.write(
    path.join(p.workPath, "common", "a.txt"),
    "external write after crash",
  );
  await assert.rejects(
    f.make({ transactionObserver: undefined }).list(),
    /变化/,
  );
  assert.equal(
    await fs.readFile(path.join(p.workPath, "common", "a.txt"), "utf8"),
    "external write after crash",
  );
  assert.ok(
    await fs.stat(
      path.join(f.storageDirectory, "projects", p.id, "transaction.json"),
    ),
  );
});

test("interrupted restore recovers matching checkpoint bytes and comparison context", async (t) => {
  let armed = false;
  const f = await fixture(t, {
    transactionObserver: async (at) => {
      if (armed && at === "old-moved") throw new Error("interrupted restore");
    },
  });
  const p = await f.create(),
    checkpoint = await f.service.checkpoint(p.id, "before");
  await f.candidate(p, { "common/a.txt": "u1" });
  const plan = await f.service.prepareMerge(p.id);
  await f.service.applyMerge(p.id, plan.id, f.decisions(plan));
  armed = true;
  await assert.rejects(
    f.service.restore(
      p.id,
      checkpoint.snapshots.find((s) => s.name === "before").id,
    ),
    /interrupted restore/,
  );
  const reopened = f.make({ transactionObserver: undefined }),
    restored = await reopened.get(p.id);
  assert.equal(restored.baseSnapshotId, p.baseSnapshotId);
  assert.equal(restored.candidateSnapshotId, null);
  assert.equal(
    await fs.readFile(path.join(p.workPath, "common", "a.txt"), "utf8"),
    "one\ntwo\nthree\n",
  );
});

test("interrupted initial creation can recover without any prior project record", async (t) => {
  const f = await fixture(t, {
    transactionObserver: async (at) => {
      if (at === "work-installed") throw new Error("interrupted create");
    },
  });
  await assert.rejects(f.create(), /interrupted create/);
  const reopened = f.make({ transactionObserver: undefined }),
    state = await reopened.list();
  assert.equal(state.projects.length, 1);
  assert.equal(
    (
      await readLocalModMetadata({
        userData: f.userData,
        descriptorPath: state.projects[0].descriptorPath,
      })
    ).remoteFileId,
    null,
  );
});

test("game guard blocks mutations and interrupted transaction recovery", async (t) => {
  let running = false;
  const f = await fixture(t, { isGameRunning: async () => running }),
    p = await f.create();
  running = true;
  await assert.rejects(f.service.checkpoint(p.id, "blocked"), /关闭游戏/);
  await assert.rejects(f.create(), /关闭游戏/);
  assert.equal((await f.service.list()).projects.length, 1);
});

test("native project backup roundtrip preserves provenance and contexts under a new identity", async (t) => {
  const f = await fixture(t),
    p = await f.create();
  await f.candidate(p, { "common/a.txt": "new" });
  await f.service.checkpoint(p.id, "named milestone");
  const plan = await f.service.prepareMerge(p.id);
  await f.service.applyMerge(
    p.id,
    plan.id,
    f.decisions(plan, { "common/a.txt": "local" }),
  );
  const archive = path.join(f.root, "backup.zip");
  assert.equal((await f.service.exportProject(p.id, archive)).path, archive);
  const imported = await f.service.importProject(archive);
  assert.notEqual(imported.id, p.id);
  assert.notEqual(imported.workPath, p.workPath);
  assert.notEqual(imported.modId, p.modId);
  assert.deepEqual(imported.upstreamRef, ref);
  assert.deepEqual(imported.originRef, ref);
  assert.equal(imported.history.at(-1).type, "imported");
  assert.ok(imported.snapshots.some((s) => s.name === "named milestone"));
  assert.equal(
    (await f.service.prepareMerge(imported.id)).counts.upstreamChanged,
    0,
  );
  assert.equal(
    (
      await readLocalModMetadata({
        userData: f.userData,
        descriptorPath: imported.descriptorPath,
      })
    ).remoteFileId,
    null,
  );
  await f.write(path.join(imported.workPath, "common", "a.txt"), "independent");
  assert.equal(
    await fs.readFile(path.join(p.workPath, "common", "a.txt"), "utf8"),
    "one\ntwo\nthree\n",
  );
  await assert.rejects(f.service.exportProject(p.id, archive), /已经存在/);
});

test("unsafe project identifiers and foreign backup manifests cannot select arbitrary paths", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.service.get("../elsewhere"), /编号无效/);
  const archive = path.join(f.root, "foreign.zip");
  await zip(archive, [
    ["backup.json", JSON.stringify({ format: "other", version: 1 })],
  ]);
  await assert.rejects(f.service.importProject(archive), /不是有效/);
});

test("legacy origins are preserved when the tracked upstream is changed or detached", async (t) => {
  const f = await fixture(t),
    p = await f.create();
  const filename = path.join(
    f.storageDirectory,
    "projects",
    p.id,
    "project.json",
  );
  const legacy = JSON.parse(await fs.readFile(filename, "utf8"));
  delete legacy.originRef;
  await fs.writeFile(filename, JSON.stringify(legacy));
  assert.deepEqual((await f.service.get(p.id)).originRef, ref);
  const detached = await f.service.setUpstream(p.id, null);
  assert.equal(detached.upstreamRef, null);
  assert.deepEqual(detached.originRef, ref);
  assert.deepEqual(
    JSON.parse(await fs.readFile(filename, "utf8")).originRef,
    ref,
  );
});
