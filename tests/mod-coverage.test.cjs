"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createLauncherService } = require("../electron/launcher-service.cjs");
const { createModProjectService } = require("../electron/mod-projects.cjs");
const {
  createModCoverageService,
  COVERAGE_LIMITS,
} = require("../electron/mod-coverage.cjs");
const { inspectModScript } = require("../electron/mod-project-checks.cjs");
const { zipFixture } = require("../scripts/pdx-fixture.cjs");

const ALPHA = "local:alpha.mod",
  BETA = "local:beta.mod";
const alphaScript = [
  ...Array.from({ length: 8 }, (_, i) =>
    i === 3 ? '# <img src=x onerror="unsafe()">' : `# before ${i + 1}`,
  ),
  "country_event = {",
  " id = shared.1",
  ' desc = "country_event = { id = fake.2 }"',
  " option = { country_event = { id = call.2 days = 1 } }",
  "}",
  ...Array.from({ length: 10 }, (_, i) => `# after ${i + 1}`),
].join("\n");
const clone = (value) => structuredClone(value);
const samePath = (a, b) =>
  path.resolve(String(a)).toLowerCase() === path.resolve(b).toLowerCase();

async function fixture(t) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "ironclad-coverage-test-"),
  );
  t.after(async () => {
    assert.equal(path.dirname(root), os.tmpdir());
    assert.ok(path.basename(root).startsWith("ironclad-coverage-test-"));
    await fs.rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  });
  const game = path.join(root, "game"),
    user = path.join(root, "Paradox Interactive", "Hearts of Iron IV"),
    steam = path.join(root, "steam"),
    alpha = path.join(user, "mod", "alpha"),
    beta = path.join(user, "mod", "beta");
  const write = async (filename, bytes) => {
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, bytes);
    return filename;
  };
  const descriptors = {
    alpha: path.join(user, "mod", "alpha.mod"),
    beta: path.join(user, "mod", "beta.mod"),
  };
  await write(path.join(game, "hoi4.exe"), "never executable; fixture only");
  await write(
    path.join(game, "launcher-settings.json"),
    '{"rawVersion":"1.19.4.0"}',
  );
  await write(
    descriptors.alpha,
    'name="Alpha"\npath="mod/alpha"\nreplace_path="events"\ndependencies={"Other author Mod"}\n',
  );
  await write(descriptors.beta, 'name="Beta"\npath="mod/beta"\n');
  for (const directory of [alpha, beta]) {
    await write(
      path.join(directory, "descriptor.mod"),
      'name="Internal metadata"\nreplace_path="internal/wrong"\n',
    );
    await write(path.join(directory, "preview.png"), "metadata image");
  }
  await write(path.join(alpha, "events", "shared.txt"), alphaScript);
  await write(
    path.join(beta, "events", "shared.txt"),
    "country_event = {\n id = shared.1\n}\n",
  );
  await write(
    path.join(alpha, "common", "national_focus", "alpha.txt"),
    "focus_tree = {\n focus = { id = SHARED_FOCUS }\n}",
  );
  await write(
    path.join(beta, "common", "national_focus", "beta.txt"),
    "focus_tree = {\n focus = { id = SHARED_FOCUS }\n}",
  );
  let projects,
    launches = 0;
  const launcher = createLauncherService({
    settingsPath: path.join(root, "settings.json"),
    documentsPath: root,
    steamRoots: [steam],
    processProbe: async () => null,
    spawnProcess: () => {
      launches++;
      throw Error("must never launch game");
    },
    getModProjects: async () =>
      projects ? (await projects.list()).projects : [],
    resolveProjectVersion: (...args) => projects.resolveVersion(...args),
  });
  await launcher.saveSettings({
    gameDirectory: game,
    playsets: [
      {
        id: "default",
        name: "Evidence fixture",
        modIds: [ALPHA, BETA],
        modOrder: [ALPHA, BETA],
        modReferences: [],
        disabledDlcIds: [],
        unmappedDlcIds: [],
      },
    ],
    activePlaysetId: "default",
  });
  projects = createModProjectService({
    storageDirectory: path.join(root, "projects"),
    getUserDataPath: async () =>
      (await launcher.getSourceState()).paths.userData,
    isGameRunning: async () => false,
  });
  const select = async (ids, references = []) => {
    const settings = (await launcher.getState()).settings;
    return launcher.saveSettings({
      playsets: settings.playsets.map((p) =>
        p.id === "default"
          ? { ...p, modIds: ids, modOrder: ids, modReferences: references }
          : p,
      ),
    });
  };
  const make = (source = launcher) =>
    createModCoverageService({ launcher: source });
  return {
    root,
    game,
    user,
    steam,
    alpha,
    beta,
    descriptors,
    write,
    launcher,
    projects,
    select,
    make,
    service: make(),
    launches: () => launches,
  };
}
function evidence(report, kind = "event-id", modId = ALPHA) {
  const group = report.groups.find((g) => g.kind === kind);
  assert.ok(group, `missing group ${kind}`);
  const item = group.evidence.find((e) => e.modId === modId);
  assert.ok(item, `missing evidence ${modId}`);
  return item;
}
async function frozenSource(f) {
  const state = await f.launcher.getState();
  return { state, launcher: { getState: async () => clone(state) } };
}

test("four evidence kinds use actual definitions, trusted descriptors and stable one-based enabled order", async (t) => {
  const f = await fixture(t);
  await f.select([BETA, ALPHA]);
  const before = (await f.launcher.getState()).settings,
    report = await f.service.scan();
  assert.equal(report.partial, false);
  assert.equal(report.configurationId.length, 64);
  assert.deepEqual(
    report.mods.map((m) => [m.id, m.order, m.status, m.fileCount]),
    [
      [BETA, 1, "complete", 2],
      [ALPHA, 2, "complete", 2],
    ],
  );
  assert.deepEqual(report.counts, { files: 4, mods: 2, groups: 4 });
  assert.deepEqual(report.groups.map((g) => g.kind).sort(), [
    "event-id",
    "focus-id",
    "replace-path",
    "same-path",
  ]);
  for (const group of report.groups)
    assert.deepEqual(
      group.evidence.map((e) => e.order),
      [1, 2],
    );
  const replacement = report.groups.find((g) => g.kind === "replace-path");
  assert.equal(replacement.value, "events");
  assert.deepEqual(
    replacement.evidence.map((e) => [e.modId, e.role, e.line]),
    [
      [BETA, "affected", 1],
      [ALPHA, "declaration", 3],
    ],
  );
  assert.equal(evidence(report).line, 10);
  assert.equal(evidence(report, "focus-id").line, 2);
  assert.deepEqual(report.notices, []);
  assert.ok(!JSON.stringify(report).includes(f.root));
  assert.ok(
    !report.groups.some((g) =>
      /fake\.2|call\.2|Other author|internal\/wrong|descriptor\.mod|preview\.png/.test(
        g.value,
      ),
    ),
  );
  assert.deepEqual((await f.launcher.getState()).settings, before);
  assert.equal(
    await fs.readFile(path.join(f.alpha, "events", "shared.txt"), "utf8"),
    alphaScript,
  );
  assert.equal(f.launches(), 0);
});

test("pure script inspection ignores comments, strings and nested calls and retains ID assignment lines", () => {
  const events = inspectModScript(
    "events/story.txt",
    '# country_event = { id = fake.1 }\ncountry_event = {\n id = story.1\n desc = "news_event = { id = fake.2 }"\n immediate = { country_event = { id = call.2 } }\n}\nnews_event = { id = story.2 }\n',
  );
  assert.deepEqual(events.events, [
    { id: "story.1", line: 3 },
    { id: "story.2", line: 7 },
  ]);
  assert.deepEqual(events.focuses, []);
  const focuses = inspectModScript(
    "common/national_focus/tree.txt",
    "focus_tree = {\n focus = {\n  id = REAL_FOCUS\n  completion_reward = { focus = { id = FAKE_FOCUS } }\n }\n}\nfocus = { id = ROOT_FOCUS }\n",
  );
  assert.deepEqual(focuses.focuses, [
    { id: "REAL_FOCUS", line: 3 },
    { id: "ROOT_FOCUS", line: 7 },
  ]);
  assert.deepEqual(
    inspectModScript("common/ideas/story.txt", "country_event={id=story.1}")
      .events,
    [],
  );
  assert.deepEqual(
    inspectModScript(
      "descriptor.mod",
      '# replace_path="fake"\nname="replace_path=wrong"\nreplace_path="events"\nnested={replace_path="fake"}',
    ).replacePaths,
    [{ value: "events", line: 3 }],
  );
  assert.ok(inspectModScript("events/broken.txt", "country_event = {").error);
});

test("shared focuses are focus ID definitions while scalar imports and nested references are ignored", () => {
  const parsed = inspectModScript(
    "common/national_focus/shared.txt",
    "shared_focus = {\n id = SHARED_DEFINITION\n completion_reward = { shared_focus = { id = NESTED_CALL } }\n}\nfocus_tree = {\n shared_focus = SHARED_DEFINITION\n shared_focus = { id = INLINE_SHARED }\n}\n",
  );
  assert.deepEqual(parsed.focuses, [
    { id: "SHARED_DEFINITION", line: 2 },
    { id: "INLINE_SHARED", line: 7 },
  ]);
  assert.equal(parsed.limited, false);
});

test("CRLF, CR and LF line endings terminate comments and count quoted newlines once", () => {
  for (const newline of ["\r\n", "\r", "\n"]) {
    const parsed = inspectModScript(
      "events/lines.txt",
      [
        "# country_event={id=fake.1}",
        'desc="first',
        "second\\",
        'third"',
        "country_event={",
        " id=real.1",
        "}",
      ].join(newline),
    );
    assert.deepEqual(parsed.events, [{ id: "real.1", line: 6 }]);
    const descriptor = inspectModScript(
      "descriptor.mod",
      [
        '# replace_path="ignored"',
        'name="first',
        'second"',
        'replace_path="events"',
      ].join(newline),
    );
    assert.deepEqual(descriptor.replacePaths, [{ value: "events", line: 4 }]);
  }
});

test("duplicate shared focus definitions appear across enabled Mods", async (t) => {
  const f = await fixture(t);
  for (const root of [f.alpha, f.beta])
    await f.write(
      path.join(root, "common", "national_focus", "shared.txt"),
      "# header\rshared_focus={\r id=TEST_SHARED\r}\rfocus_tree={shared_focus=TEST_SHARED}\r",
    );
  const report = await f.service.scan(),
    group = report.groups.find(
      (g) => g.kind === "focus-id" && g.value === "TEST_SHARED",
    );
  assert.equal(report.partial, false);
  assert.deepEqual(
    group.evidence.map((e) => e.line),
    [3, 3],
  );
});

test("source excerpts show six surrounding lines and preserve literal HTML as source text", async (t) => {
  const f = await fixture(t),
    report = await f.service.scan(),
    item = evidence(report),
    result = await f.service.readEvidence(report.id, item.id);
  assert.deepEqual(
    {
      path: result.path,
      line: result.line,
      firstLine: result.firstLine,
      modName: result.modName,
    },
    { path: "events/shared.txt", line: 10, firstLine: 4, modName: "Alpha" },
  );
  assert.equal(result.text, alphaScript.split("\n").slice(3, 16).join("\n"));
  assert.match(result.text, /<img src=x onerror=/);
  assert.equal(result.unavailable, undefined);
});

test("long excerpts report truncation at the public snippet limit", async (t) => {
  const f = await fixture(t);
  await f.write(path.join(f.alpha, "events", "shared.txt"), alphaScript + "\n");
  const text = alphaScript.replace("# after 1", "# " + "x".repeat(15000));
  await f.write(path.join(f.alpha, "events", "shared.txt"), text);
  const report = await f.service.scan();
  const result = await f.service.readEvidence(report.id, evidence(report).id);
  assert.equal(result.truncated, true);
  assert.equal(result.text.length, 12000);
});

test("replace_path matches a directory prefix and reports declarations without inventing dependencies", async (t) => {
  const f = await fixture(t);
  await f.write(
    path.join(f.beta, "events_extra", "unrelated.txt"),
    "# unrelated",
  );
  let report = await f.service.scan();
  let replacement = report.groups.find((g) => g.kind === "replace-path");
  assert.deepEqual(
    replacement.evidence
      .filter((e) => e.role === "affected")
      .map((e) => e.path),
    ["events/shared.txt"],
  );
  await f.select([ALPHA]);
  report = await f.service.scan();
  assert.equal(report.partial, false);
  assert.deepEqual(
    report.groups.map((g) => g.kind),
    ["replace-path"],
  );
  replacement = report.groups[0];
  assert.deepEqual(
    replacement.evidence.map((e) => e.role),
    ["declaration"],
  );
});

test("duplicates within one enabled Mod do not become cross-Mod ID evidence", async (t) => {
  const f = await fixture(t);
  await f.write(
    path.join(f.alpha, "events", "duplicate.txt"),
    "country_event={id=shared.1}",
  );
  await f.write(
    path.join(f.alpha, "common", "national_focus", "duplicate.txt"),
    "focus_tree={focus={id=SHARED_FOCUS}}",
  );
  await f.select([ALPHA]);
  const report = await f.service.scan();
  assert.ok(
    !report.groups.some((g) =>
      ["event-id", "focus-id", "same-path"].includes(g.kind),
    ),
  );
});

test("per-group evidence bounds produce an explicit partial report", async (t) => {
  const f = await fixture(t);
  await f.write(
    path.join(f.alpha, "events", "many.txt"),
    "country_event={id=cap.1}\n".repeat(COVERAGE_LIMITS.groupEvidence + 1),
  );
  await f.write(
    path.join(f.beta, "events", "many.txt"),
    "country_event={id=cap.1}\n",
  );
  const report = await f.service.scan();
  const group = report.groups.find(
    (g) => g.kind === "event-id" && g.value === "cap.1",
  );
  assert.equal(group.evidence.length, COVERAGE_LIMITS.groupEvidence);
  assert.equal(report.partial, true);
  assert.ok(report.notices.includes("覆盖证据条目超过显示上限。"));
});

test("group bounds limit a real ZIP scan and retain a partial-report notice", async (t) => {
  const f = await fixture(t);
  const files = Object.fromEntries(
    Array.from({ length: COVERAGE_LIMITS.groups + 1 }, (_, i) => [
      `common/limits/${i}.txt`,
      "# content",
    ]),
  );
  for (const id of [777, 888]) {
    const archive = await f.write(
      path.join(f.root, `groups-${id}.zip`),
      zipFixture(files),
    );
    await f.write(
      path.join(f.user, "mod", `pdx_${id}_9.mod`),
      `name="Archive ${id}"\npops_id="${id}"\narchive=${JSON.stringify(archive.replaceAll("\\", "/"))}\n`,
    );
  }
  await f.select(
    ["pdx:777", "pdx:888"],
    [777, 888].map((id) => ({
      id: `pdx:${id}`,
      name: `Archive ${id}`,
      source: "pdx",
      remoteId: String(id),
      version: "9",
    })),
  );
  const report = await f.service.scan();
  assert.equal(report.groups.length, COVERAGE_LIMITS.groups);
  assert.equal(report.counts.files, (COVERAGE_LIMITS.groups + 1) * 2);
  assert.equal(report.partial, true);
  assert.ok(report.notices.includes("覆盖证据分组超过显示上限。"));
});

test("unknown or path-shaped IDs are rejected and a rescan invalidates old reports", async (t) => {
  const f = await fixture(t),
    old = await f.service.scan(),
    item = evidence(old);
  await assert.rejects(
    f.service.readEvidence(old.id, path.join(f.alpha, "events", "shared.txt")),
    /已失效/,
  );
  await assert.rejects(
    f.service.readEvidence("..\\settings.json", item.id),
    /已失效/,
  );
  await assert.rejects(
    f.service.readEvidence(old.id, "../../secret"),
    /已失效/,
  );
  const fresh = await f.service.scan();
  assert.notEqual(fresh.id, old.id);
  assert.notEqual(evidence(fresh).id, item.id);
  await assert.rejects(f.service.readEvidence(old.id, item.id), /已失效/);
  assert.match(
    (await f.service.readEvidence(fresh.id, evidence(fresh).id)).text,
    /shared\.1/,
  );
});

test("caller mutations of a report cannot redirect its saved evidence", async (t) => {
  const f = await fixture(t),
    report = await f.service.scan(),
    item = evidence(report),
    id = item.id;
  item.path = "../../settings.json";
  item.modName = "tampered";
  report.groups.length = 0;
  const result = await f.service.readEvidence(report.id, id);
  assert.equal(result.path, "events/shared.txt");
  assert.equal(result.modName, "Alpha");
});

test("configuration identity rejects order, selected playset, instance, user directory and pinned reference changes", async (t) => {
  const f = await fixture(t),
    source = await frozenSource(f),
    service = f.make(source.launcher),
    original = clone(source.state);
  const mutations = [
    (s) => s.settings.playsets[0].modOrder.reverse(),
    (s) => {
      s.settings.activePlaysetId = "other";
      s.settings.playsets.push({
        ...clone(s.settings.playsets[0]),
        id: "other",
      });
    },
    (s) => (s.settings.activeGameInstanceId = "another"),
    (s) => (s.paths.userData = path.join(f.root, "another-user")),
    (s) =>
      s.settings.playsets[0].modReferences.push({
        id: ALPHA,
        name: "Alpha",
        source: "local",
        remoteId: null,
        version: "pinned-checkpoint",
      }),
  ];
  for (const mutate of mutations) {
    Object.assign(source.state, clone(original));
    const report = await service.scan();
    mutate(source.state);
    await assert.rejects(
      service.readEvidence(report.id, evidence(report).id),
      /配置已变化/,
    );
  }
});

test("same-size source edits with restored mtime invalidate evidence", async (t) => {
  const f = await fixture(t),
    report = await f.service.scan(),
    filename = path.join(f.alpha, "events", "shared.txt"),
    before = await fs.stat(filename);
  await fs.writeFile(filename, alphaScript.replace("shared.1", "shared.9"));
  await fs.utimes(filename, before.atime, before.mtime);
  assert.equal((await fs.stat(filename)).size, before.size);
  await assert.rejects(
    f.service.readEvidence(report.id, evidence(report).id),
    /已变化/,
  );
});

test("any trusted descriptor edit invalidates evidence even when path and version stay unchanged", async (t) => {
  const f = await fixture(t),
    source = await frozenSource(f),
    service = f.make(source.launcher),
    report = await service.scan();
  await fs.appendFile(f.descriptors.beta, 'replace_path="common/ideas"\n');
  await assert.rejects(
    service.readEvidence(report.id, evidence(report).id),
    /已变化/,
  );
});

test("descriptor edits during excerpt reading are rejected by the final proof recheck", async (t) => {
  const f = await fixture(t),
    source = await frozenSource(f),
    service = f.make(source.launcher),
    report = await service.scan(),
    nativeOpen = fs.open;
  let changed = false;
  t.mock.method(fs, "open", async function (filename, ...args) {
    if (
      !changed &&
      samePath(filename, path.join(f.alpha, "events", "shared.txt"))
    ) {
      changed = true;
      await fs.appendFile(f.descriptors.beta, 'replace_path="changed"\n');
    }
    return nativeOpen.call(this, filename, ...args);
  });
  await assert.rejects(
    service.readEvidence(report.id, evidence(report).id),
    /已变化/,
  );
  assert.equal(changed, true);
});

test("the scan tail rejects an earlier Mod changing while a later Mod is inspected", async (t) => {
  const f = await fixture(t),
    source = await frozenSource(f),
    service = f.make(source.launcher),
    nativeOpendir = fs.opendir;
  let changed = false;
  t.mock.method(fs, "opendir", async function (filename, ...args) {
    if (!changed && samePath(filename, f.beta)) {
      changed = true;
      await fs.appendFile(
        path.join(f.alpha, "events", "shared.txt"),
        "\n# concurrent edit",
      );
    }
    return nativeOpendir.call(this, filename, ...args);
  });
  await assert.rejects(service.scan(), /已变化/);
  assert.equal(changed, true);
  assert.equal(service.isBusy(), false);
});

test("a configuration change at scan completion cannot publish a stale report", async (t) => {
  const f = await fixture(t),
    source = await frozenSource(f);
  let calls = 0;
  const service = f.make({
    getState: async () => {
      if (++calls === 2) source.state.settings.playsets[0].modOrder.reverse();
      return clone(source.state);
    },
  });
  await assert.rejects(service.scan(), /配置已变化/);
  assert.equal(service.isBusy(), false);
});

test("cancelling during the final configuration read cannot publish a report", async (t) => {
  const f = await fixture(t),
    source = await frozenSource(f);
  let calls = 0,
    release,
    entered;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  const service = f.make({
    getState: async () => {
      if (++calls === 2) {
        entered();
        await gate;
      }
      return clone(source.state);
    },
  });
  const scan = service.scan();
  await ready;
  assert.equal(service.cancel(), true);
  release();
  await assert.rejects(scan, (error) => error.code === "ABORT_ERR");
  assert.equal(service.isBusy(), false);
});

test("binary directory files are inventoried without opening their contents", async (t) => {
  const f = await fixture(t);
  for (const root of [f.alpha, f.beta])
    await f.write(path.join(root, "gfx", "shared.dds"), Buffer.alloc(32, 0xff));
  const source = await frozenSource(f),
    service = f.make(source.launcher),
    nativeOpen = fs.open;
  t.mock.method(fs, "open", async function (filename, ...args) {
    assert.ok(
      !String(filename).endsWith(".dds"),
      "directory binary must not be opened",
    );
    return nativeOpen.call(this, filename, ...args);
  });
  const report = await service.scan(),
    item = report.groups.find(
      (g) => g.kind === "same-path" && g.value === "gfx/shared.dds",
    ).evidence[0];
  assert.equal(report.partial, false);
  const result = await service.readEvidence(report.id, item.id);
  assert.equal(result.unavailable, true);
  assert.equal(result.text, "");
});

test("unavailable binary excerpts still reject changes during their final configuration check", async (t) => {
  const f = await fixture(t);
  for (const root of [f.alpha, f.beta])
    await f.write(path.join(root, "gfx", "shared.dds"), "binary");
  const state = (await frozenSource(f)).state;
  let armed = false,
    calls = 0;
  const service = f.make({
      getState: async () => {
        if (armed && ++calls === 2) state.settings.launchMode = "debug";
        return clone(state);
      },
    }),
    report = await service.scan(),
    item = report.groups.find(
      (g) => g.kind === "same-path" && g.value === "gfx/shared.dds",
    ).evidence[0];
  armed = true;
  await assert.rejects(service.readEvidence(report.id, item.id), /配置已变化/);
});

test("oversized and invalid UTF-8 text stay path-only and make the report partial", async (t) => {
  const f = await fixture(t);
  for (const root of [f.alpha, f.beta]) {
    await f.write(
      path.join(root, "events", "large.txt"),
      Buffer.alloc(COVERAGE_LIMITS.textFileBytes + 1, 32),
    );
    await f.write(
      path.join(root, "events", "invalid.txt"),
      Buffer.from([0xc3, 0x28]),
    );
  }
  const report = await f.service.scan();
  assert.equal(report.partial, true);
  assert.ok(report.mods.every((m) => m.status === "partial"));
  assert.ok(report.notices.some((n) => n.includes("超过检查预算")));
  assert.ok(report.notices.some((n) => n.includes("UTF-8")));
  for (const value of ["events/large.txt", "events/invalid.txt"]) {
    const item = report.groups.find(
      (g) => g.kind === "same-path" && g.value === value,
    ).evidence[0];
    assert.equal(
      (await f.service.readEvidence(report.id, item.id)).unavailable,
      true,
    );
  }
});

test("missing enabled Mods make a partial report while valid Mod evidence remains available", async (t) => {
  const f = await fixture(t);
  await f.select(
    [ALPHA, "workshop:999", BETA],
    [
      {
        id: "workshop:999",
        name: "Missing",
        source: "workshop",
        remoteId: "999",
      },
    ],
  );
  const report = await f.service.scan();
  assert.equal(report.partial, true);
  assert.equal(
    report.mods.find((m) => m.id === "workshop:999").status,
    "unavailable",
  );
  assert.match(report.notices.join("\n"), /模组「Missing」：/);
  assert.ok(report.groups.some((g) => g.kind === "event-id"));
});

test("unreadable entries discard that Mod without presenting a complete scan", async (t) => {
  const f = await fixture(t),
    source = await frozenSource(f),
    service = f.make(source.launcher),
    nativeOpen = fs.open;
  t.mock.method(fs, "open", async function (filename, ...args) {
    if (samePath(filename, path.join(f.alpha, "events", "shared.txt")))
      throw Object.assign(Error("fixture denied"), { code: "EACCES" });
    return nativeOpen.call(this, filename, ...args);
  });
  const report = await service.scan();
  assert.equal(report.partial, true);
  assert.equal(report.mods[0].status, "unavailable");
  assert.ok(!report.groups.some((g) => g.kind === "event-id"));
});

test("file size budgets reject oversized metadata before opening directory binaries", async (t) => {
  const f = await fixture(t),
    target = await f.write(
      path.join(f.alpha, "gfx", "huge.dds"),
      "small fixture",
    ),
    source = await frozenSource(f),
    service = f.make(source.launcher),
    nativeLstat = fs.lstat,
    nativeOpen = fs.open;
  t.mock.method(fs, "lstat", async function (filename, ...args) {
    const stat = await nativeLstat.call(this, filename, ...args);
    if (samePath(filename, target) && args[0]?.bigint)
      Object.defineProperty(stat, "size", {
        value: BigInt(COVERAGE_LIMITS.modBytes + 1),
      });
    return stat;
  });
  t.mock.method(fs, "open", async function (filename, ...args) {
    assert.ok(!samePath(filename, target));
    return nativeOpen.call(this, filename, ...args);
  });
  const report = await service.scan();
  assert.equal(report.partial, true);
  assert.equal(report.mods[0].status, "partial");
  assert.ok(
    report.notices.some(
      (n) => n === "模组「Alpha」：文件检查未完成（超过检查预算）。",
    ),
  );
});

test("hardlinked files and junction ancestors are rejected", async (t) => {
  const f = await fixture(t),
    outside = await f.write(path.join(f.root, "outside.txt"), "unsafe");
  await fs.link(outside, path.join(f.alpha, "linked.txt"));
  let report = await f.service.scan();
  assert.equal(report.mods[0].status, "unavailable");
  await fs.unlink(path.join(f.alpha, "linked.txt"));
  const target = path.join(f.root, "redirect-target"),
    link = path.join(f.alpha, "redirect");
  await fs.mkdir(target);
  await fs.symlink(target, link, "junction");
  report = await f.service.scan();
  assert.equal(report.partial, true);
  assert.equal(report.mods[0].status, "unavailable");
});

test("Workshop directories and PDX ZIP content produce the same evidence without reading archive descriptor semantics", async (t) => {
  const f = await fixture(t),
    workshop = path.join(
      f.steam,
      "steamapps",
      "workshop",
      "content",
      "394360",
      "246",
    ),
    archive = path.join(f.root, "content.zip");
  await f.write(
    path.join(workshop, "descriptor.mod"),
    'name="Workshop"\nremote_file_id="246"\n',
  );
  await f.write(
    path.join(workshop, "events", "shared.txt"),
    "country_event={id=shared.1}",
  );
  await f.write(
    archive,
    zipFixture({
      "descriptor.mod": 'replace_path="internal/wrong"',
      "events/shared.txt": "country_event={\n id=shared.1\n}",
    }),
  );
  await f.write(
    path.join(f.user, "mod", "pdx_777_9.mod"),
    `name="Archive"\npops_id="777"\nreplace_path="events"\narchive=${JSON.stringify(archive.replaceAll("\\", "/"))}\n`,
  );
  await f.select(
    ["workshop:246", "pdx:777"],
    [
      {
        id: "pdx:777",
        name: "Archive",
        source: "pdx",
        remoteId: "777",
        version: "9",
      },
    ],
  );
  const report = await f.service.scan();
  assert.equal(report.partial, false);
  assert.equal(report.counts.files, 2);
  assert.deepEqual(
    report.mods.map((m) => m.id),
    ["workshop:246", "pdx:777"],
  );
  assert.ok(!report.groups.some((g) => g.value === "internal/wrong"));
  const item = evidence(report, "event-id", "pdx:777");
  assert.equal(item.line, 2);
  assert.match(
    (await f.service.readEvidence(report.id, item.id)).text,
    /shared\.1/,
  );
  await f.write(
    archive,
    zipFixture({ "events/shared.txt": "country_event={id=shared.9}" }),
  );
  await assert.rejects(f.service.readEvidence(report.id, item.id), /已变化/);
});

test("pinned projects use the immutable selected version and its descriptor", async (t) => {
  const f = await fixture(t);
  await f.write(
    path.join(f.alpha, "descriptor.mod"),
    'name="Pinned Alpha"\nreplace_path="events"\n',
  );
  const project = await f.projects.create({
    name: "Pinned Alpha",
    sourcePath: f.alpha,
    upstreamRef: null,
    baselineKnown: true,
  });
  await f.write(
    path.join(project.workPath, "events", "shared.txt"),
    "country_event={id=working.9}",
  );
  await f.write(
    path.join(project.workPath, "descriptor.mod"),
    'name="Pinned Alpha"\nreplace_path="working/wrong"\n',
  );
  await f.select(
    [project.modId, BETA],
    [
      {
        id: project.modId,
        name: project.name,
        source: "local",
        remoteId: null,
        version: project.baseSnapshotId,
      },
    ],
  );
  const report = await f.service.scan();
  assert.equal(report.partial, false);
  assert.ok(
    report.groups.some((g) => g.kind === "event-id" && g.value === "shared.1"),
  );
  assert.ok(
    report.groups.some(
      (g) => g.kind === "replace-path" && g.value === "events",
    ),
  );
  assert.ok(!report.groups.some((g) => g.value === "working/wrong"));
  const result = await f.service.readEvidence(
    report.id,
    evidence(report, "event-id", project.modId).id,
  );
  assert.match(result.text, /shared\.1/);
  assert.doesNotMatch(result.text, /working\.9/);
});

async function archiveFixture(t, bytes) {
  const f = await fixture(t),
    archive = await f.write(path.join(f.root, "test.zip"), bytes);
  await f.write(
    path.join(f.user, "mod", "pdx_777_9.mod"),
    `name="Archive"\npops_id="777"\narchive=${JSON.stringify(archive.replaceAll("\\", "/"))}\n`,
  );
  await f.select(
    ["pdx:777", BETA],
    [
      {
        id: "pdx:777",
        name: "Archive",
        source: "pdx",
        remoteId: "777",
        version: "9",
      },
    ],
  );
  return { ...f, archive };
}

test("unsafe ZIP paths, case collisions, symlinks and damaged CRC never become completed evidence", async (t) => {
  const valid = { "events/shared.txt": "country_event={id=shared.1}" },
    traversal = zipFixture({ "../escape.txt": "bad" }),
    collision = zipFixture({ ...valid, "EVENTS/shared.txt": "second" }),
    symlink = zipFixture(valid),
    corrupt = zipFixture(valid);
  symlink.writeUInt32LE(
    (0xa1ff << 16) >>> 0,
    symlink.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 38,
  );
  const payloadOffset = 30 + Buffer.byteLength("events/shared.txt");
  corrupt[payloadOffset] ^= 1;
  for (const [name, bytes] of [
    ["traversal", traversal],
    ["collision", collision],
    ["symlink", symlink],
    ["CRC", corrupt],
  ])
    await t.test(name, async (t) => {
      const f = await archiveFixture(t, bytes),
        report = await f.service.scan();
      assert.equal(report.partial, true);
      assert.equal(report.mods[0].status, "unavailable");
      assert.ok(
        !report.groups.some(
          (g) => g.kind === "same-path" || g.kind === "event-id",
        ),
      );
    });
});

test("ZIP decoded content exceeding the read budget stays partial and path-only", async (t) => {
  const bytes = zipFixture({ "gfx/shared.dds": "fixture bytes" }),
    central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])),
    claimed = COVERAGE_LIMITS.archiveReadBytes + 1;
  // The decompressor is never opened for an entry beyond the global read budget.
  bytes.writeUInt32LE(claimed, 18);
  bytes.writeUInt32LE(claimed, 22);
  bytes.writeUInt32LE(claimed, central + 20);
  bytes.writeUInt32LE(claimed, central + 24);
  const f = await archiveFixture(t, bytes);
  await f.write(path.join(f.beta, "gfx", "shared.dds"), "directory fixture");
  const report = await f.service.scan();
  assert.equal(report.partial, true);
  assert.equal(report.mods[0].status, "partial");
  assert.ok(report.notices.some((n) => n.includes("ZIP 内容超过读取预算")));
  const item = report.groups
    .find((g) => g.value === "gfx/shared.dds")
    .evidence.find((e) => e.modId === "pdx:777");
  assert.equal(
    (await f.service.readEvidence(report.id, item.id)).unavailable,
    true,
  );
});

test("cancel is effective, concurrent scans are rejected and cancelled rescans invalidate the old report", async (t) => {
  const f = await fixture(t),
    old = await f.service.scan(),
    nativeOpendir = fs.opendir;
  let release, entered;
  const gate = new Promise((r) => (release = r)),
    ready = new Promise((r) => (entered = r));
  let blocked = false;
  t.mock.method(fs, "opendir", async function (filename, ...args) {
    if (!blocked && samePath(filename, f.alpha)) {
      blocked = true;
      entered();
      await gate;
    }
    return nativeOpendir.call(this, filename, ...args);
  });
  const scan = f.service.scan();
  await ready;
  assert.equal(f.service.isBusy(), true);
  assert.deepEqual(f.service.getProgress(), {
    busy: true,
    index: 1,
    total: 2,
    name: "Alpha",
    canCancel: true,
  });
  await assert.rejects(f.service.scan(), /正在检查/);
  await assert.rejects(
    f.service.readEvidence(old.id, evidence(old).id),
    /已失效/,
  );
  assert.equal(f.service.cancel(), true);
  assert.equal(f.service.cancel(), false);
  assert.equal(f.service.getProgress().canCancel, false);
  release();
  await assert.rejects(
    scan,
    (error) => error.code === "ABORT_ERR" && error.name === "AbortError",
  );
  assert.deepEqual(f.service.getProgress(), {
    busy: false,
    index: 0,
    total: 0,
    canCancel: false,
  });
  assert.equal(f.service.cancel(), false);
  await assert.rejects(
    f.service.readEvidence(old.id, evidence(old).id),
    /已失效/,
  );
  const next = await f.service.scan();
  assert.equal(next.partial, false);
});
