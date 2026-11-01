"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const {
  captureEnvironment,
  compareEnvironments,
  fingerprintMods,
  validateEnvironment,
  FINGERPRINT_LIMITS,
} = require("../electron/launch-environment.cjs");

const A = "a".repeat(64),
  B = "b".repeat(64);
const clone = (value) => structuredClone(value);
const fingerprints = {
  "workshop:1": { status: "verified", digest: A },
  "local:two.mod": { status: "verified", digest: B },
};

function state() {
  return {
    settings: {
      gameDirectory: "C:\\game",
      activeGameInstanceId: "default",
      gameInstances: [{ id: "default", name: "默认版本" }],
      activePlaysetId: "one",
      launchMode: "normal",
      gameOptions: { language: "wrong-pending-value" },
      playsets: [
        {
          id: "one",
          name: "战役播放集",
          modIds: ["local:two.mod", "workshop:1"],
          modOrder: ["local:two.mod", "local:off.mod", "workshop:1"],
          modReferences: [
            {
              id: "workshop:1",
              name: "作者原名",
              source: "workshop",
              remoteId: "1",
            },
            {
              id: "local:two.mod",
              name: "本地二改",
              source: "local",
              remoteId: null,
              version: "checkpoint-1",
            },
          ],
          disabledDlcIds: ["dlc-off"],
          unmappedDlcIds: [],
          origin: "local",
        },
      ],
    },
    game: { directory: "C:\\game", version: "1.19.4.0" },
    paths: { userData: "C:\\user-data" },
    dlc: {
      items: [
        { id: "dlc-z", installed: true, enabled: true },
        { id: "dlc-a", installed: true, enabled: true },
        { id: "dlc-off", installed: true, enabled: false },
        { id: "not-installed", installed: false, enabled: true },
      ],
    },
    gameOptions: {
      values: { language: "l_simp_chinese", fullscreen: true, max_fps: 60 },
    },
    mods: [
      {
        id: "workshop:1",
        name: "显示别名",
        source: "workshop",
        remoteId: "1",
        version: "1.0",
        available: true,
        contentPath: "C:\\mods\\one",
      },
      {
        id: "local:two.mod",
        name: "二改",
        source: "local",
        remoteId: null,
        version: "2.0",
        projectId: "project-1",
        projectVersion: "checkpoint-1",
        available: true,
        contentPath: "C:\\mods\\two",
      },
      {
        id: "local:off.mod",
        name: "停用",
        source: "local",
        remoteId: null,
        version: "1",
        available: true,
      },
    ],
  };
}

const capture = (value = state(), hashes = fingerprints) =>
  captureEnvironment(value, { fingerprints: hashes });

function onlyMods(value, ids) {
  const selected = value.settings.playsets[0];
  selected.modIds = [...ids];
  selected.modOrder = [...ids];
  selected.modReferences = selected.modReferences.filter((mod) =>
    ids.includes(mod.id),
  );
  return value;
}

async function fixture(t) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "ironclad-environment-"),
  );
  t.after(async () => {
    assert.equal(path.dirname(root), os.tmpdir());
    assert.ok(path.basename(root).startsWith("ironclad-environment-"));
    await fs.rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  });
  const one = path.join(root, "one"),
    two = path.join(root, "two");
  await fs.mkdir(path.join(one, "events"), { recursive: true });
  await fs.mkdir(two);
  await fs.writeFile(
    path.join(one, "events", "sample.txt"),
    "namespace = sample\n",
  );
  await fs.writeFile(
    path.join(one, "descriptor.mod"),
    'name="One"\nversion="1.0"\n',
  );
  await fs.writeFile(path.join(two, "content.txt"), "original");
  const value = state();
  value.mods[0].contentPath = one;
  value.mods[1].contentPath = two;
  return { root, one, two, state: value };
}

test("environment captures the actual enabled order, DLC and effective options with detached playset data", () => {
  const input = state(),
    snapshot = capture(input);
  assert.equal(validateEnvironment(snapshot), snapshot);
  assert.deepEqual(
    snapshot.mods.map((mod) => mod.id),
    ["local:two.mod", "workshop:1"],
  );
  assert.deepEqual(snapshot.dlcIds, ["dlc-a", "dlc-z"]);
  assert.deepEqual(snapshot.gameOptions, input.gameOptions.values);
  assert.equal(snapshot.mods[0].projectVersion, "checkpoint-1");
  assert.equal(snapshot.mods[1].contentDigest, A);
  assert.deepEqual(snapshot.playset, input.settings.playsets[0]);
  input.settings.playsets[0].modReferences[0].name = "changed";
  input.gameOptions.values.max_fps = 90;
  assert.equal(snapshot.playset.modReferences[0].name, "作者原名");
  assert.equal(snapshot.gameOptions.max_fps, 60);
});

test("configuration identity ignores display labels, instance IDs, paths and dictionary insertion order", () => {
  const before = capture(),
    input = state();
  input.game.directory = "D:\\moved-game";
  input.paths.userData = "D:\\moved-user";
  input.settings.activeGameInstanceId = "renamed-instance";
  input.settings.gameInstances = [{ id: "renamed-instance", name: "新名字" }];
  input.settings.activePlaysetId = "renamed-playset";
  input.settings.playsets[0].id = "renamed-playset";
  input.settings.playsets[0].name = "播放集新名字";
  input.settings.playsets[0].modReferences[0].name = "引用新名字";
  input.mods[0].name = "另一个显示名";
  input.mods[1].name = "另一个二改名";
  input.gameOptions.values = {
    max_fps: 60,
    fullscreen: true,
    language: "l_simp_chinese",
  };
  const after = capture(input);
  assert.equal(before.configurationId, after.configurationId);
  assert.deepEqual(compareEnvironments(before, after), []);
});

test("configuration identity changes for enabled order, enabled members, DLC, options, version and mode", () => {
  const before = capture();
  const mutations = [
    (v) => {
      v.settings.playsets[0].modOrder.reverse();
    },
    (v) => {
      v.settings.playsets[0].modIds = ["workshop:1"];
    },
    (v) => {
      v.dlc.items[0].enabled = false;
    },
    (v) => {
      v.gameOptions.values.max_fps = 120;
    },
    (v) => {
      v.game.version = "1.20";
    },
    (v) => {
      v.settings.launchMode = "debug";
    },
    (v) => {
      v.mods[0].installedRevision = "123";
    },
  ];
  for (const mutate of mutations) {
    const input = state();
    mutate(input);
    assert.notEqual(capture(input).configurationId, before.configurationId);
  }
});

test("disabled library members do not change the runtime configuration identity", () => {
  const input = state(),
    before = capture(input);
  input.settings.playsets[0].modOrder.push("local:another-disabled.mod");
  assert.equal(capture(input).configurationId, before.configurationId);
});

test("an unmodified vanilla environment is comparable without any mod fingerprints", async () => {
  const input = onlyMods(state(), []);
  const result = captureEnvironment(input);
  assert.deepEqual(result.mods, []);
  assert.deepEqual(await fingerprintMods(input), {});
  assert.deepEqual(compareEnvironments(result, result), []);
});

test("comparison detects content changes even when every author version remains the same", () => {
  const before = capture();
  const after = capture(state(), {
    ...fingerprints,
    "workshop:1": { status: "verified", digest: B },
  });
  assert.notEqual(before.configurationId, after.configurationId);
  assert.deepEqual(compareEnvironments(before, after), [
    {
      kind: "mod-content",
      id: "workshop:1",
      name: "显示别名",
      before: A,
      after: B,
    },
  ]);
});

test("comparison reports membership, shared-member order, version, DLC, settings, game and launch mode", () => {
  const input = state();
  input.settings.playsets[0].modOrder.reverse();
  input.mods[0].version = "2.0";
  input.game.version = "1.20";
  input.settings.launchMode = "debug";
  input.dlc.items[0].enabled = false;
  input.gameOptions.values.max_fps = 30;
  const kinds = compareEnvironments(capture(), capture(input)).map(
    (entry) => entry.kind,
  );
  assert.deepEqual(kinds, [
    "game",
    "mod-version",
    "order",
    "dlc",
    "settings",
    "mode",
  ]);
  const smaller = capture(onlyMods(state(), ["workshop:1"]));
  assert.deepEqual(
    compareEnvironments(capture(), smaller).map((entry) => entry.kind),
    ["mods-removed"],
  );
  assert.deepEqual(
    compareEnvironments(smaller, capture()).map((entry) => entry.kind),
    ["mods-added"],
  );
});

test("missing selected mods stay in the record and unverified content never implies compatibility", () => {
  const input = state();
  input.mods = input.mods.filter((mod) => mod.id !== "workshop:1");
  const after = capture(input, {});
  assert.equal(after.mods[1].id, "workshop:1");
  assert.equal(after.mods[1].available, false);
  assert.equal(after.mods[1].contentDigest, null);
  assert.equal(after.mods[1].contentStatus, "not-recorded");
  const changes = compareEnvironments(capture(), after);
  assert.ok(
    changes.some(
      (entry) => entry.kind === "unverified" && entry.id === "workshop:1",
    ),
  );
  assert.ok(!changes.some((entry) => entry.kind === "mods-removed"));
  assert.equal(
    compareEnvironments(after, after).filter(
      (entry) => entry.kind === "unverified",
    ).length,
    2,
  );
});

test("unavailable fingerprint status is explicit and cannot retain a claimed digest", () => {
  const result = capture(state(), {
    "workshop:1": { status: "unavailable", digest: A },
  });
  assert.equal(result.mods[1].contentStatus, "unavailable");
  assert.equal(result.mods[1].contentDigest, null);
});

test("persistent environment validation rejects tampering, unsupported data and structural inconsistencies", () => {
  const mutations = [
    (v) => {
      v.schemaVersion = 2;
    },
    (v) => {
      v.configurationId = B;
    },
    (v) => {
      v.mods[0].contentDigest = "wrong";
    },
    (v) => {
      v.mods[0].available = false;
    },
    (v) => {
      v.mods[0].contentStatus = "compatible";
    },
    (v) => {
      v.mods[0].extra = true;
    },
    (v) => {
      v.gameOptions.max_fps = NaN;
    },
    (v) => {
      v.gameOptions.nested = { hidden: true };
    },
    (v) => {
      v.playset.modIds.push(v.playset.modIds[0]);
    },
    (v) => {
      v.playset.modOrder = ["workshop:1"];
    },
    (v) => {
      v.playset.modReferences[0].id = "not-a-member";
    },
    (v) => {
      v.mods.reverse();
    },
    (v) => {
      v.dlcIds.reverse();
    },
    (v) => {
      v.mods[0].name = "x".repeat(1025);
    },
    (v) => {
      v.playset.modOrder = Array.from({ length: 10001 }, (_, i) => `mod:${i}`);
    },
    (v) => {
      Object.defineProperty(v.game, "version", { get: () => "1.19.4.0" });
    },
  ];
  for (const mutate of mutations) {
    const value = clone(capture());
    mutate(value);
    assert.throws(() => validateEnvironment(value), /记录无效/);
  }
});

test("directory content fingerprints are deterministic across paths and discovery order", async (t) => {
  const f = await fixture(t),
    other = path.join(f.root, "copy");
  await fs.mkdir(path.join(other, "events"), { recursive: true });
  await fs.writeFile(
    path.join(other, "descriptor.mod"),
    'name="One"\nversion="1.0"\n',
  );
  await fs.writeFile(
    path.join(other, "events", "sample.txt"),
    "namespace = sample\n",
  );
  f.state.mods[1].contentPath = other;
  const progress = [],
    hashes = await fingerprintMods(f.state, {
      onProgress: (entry) => progress.push(entry),
    });
  assert.equal(hashes["workshop:1"].status, "verified");
  assert.equal(hashes["workshop:1"].digest, hashes["local:two.mod"].digest);
  assert.deepEqual(progress, [
    { modId: "local:two.mod", index: 1, total: 2 },
    { modId: "workshop:1", index: 2, total: 2 },
  ]);
  assert.equal(Object.hasOwn(hashes, "local:off.mod"), false);
});

test("same-size content modifications with a restored mtime produce a different digest", async (t) => {
  const f = await fixture(t),
    filename = path.join(f.two, "content.txt");
  const before = await fingerprintMods(f.state),
    prior = await fs.stat(filename);
  await fs.writeFile(filename, "modified");
  await fs.utimes(filename, prior.atime, prior.mtime);
  const after = await fingerprintMods(f.state);
  assert.equal(after["local:two.mod"].status, "verified");
  assert.notEqual(
    after["local:two.mod"].digest,
    before["local:two.mod"].digest,
  );
  assert.equal(after["workshop:1"].digest, before["workshop:1"].digest);
});

test("archives are hashed as their exact bytes without requiring an extension or unpacking", async (t) => {
  const f = await fixture(t),
    archive = path.join(f.root, "archive.data"),
    bytes = Buffer.from("exact archive bytes\0");
  await fs.writeFile(archive, bytes);
  f.state.mods[1].contentPath = archive;
  const hashes = await fingerprintMods(f.state);
  assert.equal(
    hashes["local:two.mod"].digest,
    createHash("sha256").update(bytes).digest("hex"),
  );
});

test("a missing item does not prevent other enabled mods from being fingerprinted", async (t) => {
  const f = await fixture(t);
  f.state.mods[1].contentPath = path.join(f.root, "missing");
  const hashes = await fingerprintMods(f.state);
  assert.equal(hashes["local:two.mod"].status, "unavailable");
  assert.equal(hashes["local:two.mod"].digest, null);
  assert.ok(hashes["local:two.mod"].reason);
  assert.equal(hashes["workshop:1"].status, "verified");
});

test("directory junctions are rejected at the content root, within the tree and in an ancestor", async (t) => {
  const f = await fixture(t),
    linked = path.join(f.root, "linked");
  await fs.symlink(
    f.one,
    linked,
    process.platform === "win32" ? "junction" : "dir",
  );
  f.state.mods[1].contentPath = linked;
  assert.equal(
    (await fingerprintMods(f.state))["local:two.mod"].status,
    "unavailable",
  );
  f.state.mods[1].contentPath = path.join(linked, "events");
  assert.equal(
    (await fingerprintMods(f.state))["local:two.mod"].status,
    "unavailable",
  );
  f.state.mods[1].contentPath = f.two;
  await fs.symlink(
    f.one,
    path.join(f.two, "nested"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const result = await fingerprintMods(f.state);
  assert.equal(result["local:two.mod"].status, "unavailable");
  assert.equal(result["workshop:1"].status, "verified");
});

test("hardlinked archive and tree files are rejected", async (t) => {
  const f = await fixture(t),
    hardlink = path.join(f.root, "hardlink.bin");
  await fs.link(path.join(f.two, "content.txt"), hardlink);
  const treeHashes = await fingerprintMods(f.state);
  assert.equal(treeHashes["local:two.mod"].status, "unavailable");
  f.state.mods[1].contentPath = hardlink;
  assert.equal(
    (await fingerprintMods(f.state))["local:two.mod"].status,
    "unavailable",
  );
});

test("file changes during hashing remain unavailable even if size and mtime are restored", async (t) => {
  const f = await fixture(t),
    filename = path.join(f.two, "content.txt"),
    prior = await fs.stat(filename);
  const original = fs.open;
  let changed = false;
  t.mock.method(fs, "open", async (...args) => {
    const handle = await original(...args);
    if (args[0] === filename) {
      const read = handle.read.bind(handle);
      handle.read = async (...readArgs) => {
        const result = await read(...readArgs);
        if (!changed && result.bytesRead) {
          changed = true;
          await fs.writeFile(filename, "modified");
          await fs.utimes(filename, prior.atime, prior.mtime);
        }
        return result;
      };
    }
    return handle;
  });
  const result = await fingerprintMods(f.state);
  assert.equal(changed, true);
  assert.equal(result["local:two.mod"].status, "unavailable");
  assert.equal(result["workshop:1"].status, "verified");
});

test("a new file appearing after the initial tree scan invalidates the fingerprint", async (t) => {
  const f = await fixture(t),
    filename = path.join(f.two, "content.txt");
  const original = fs.open;
  let changed = false;
  t.mock.method(fs, "open", async (...args) => {
    const handle = await original(...args);
    if (args[0] === filename) {
      const read = handle.read.bind(handle);
      handle.read = async (...readArgs) => {
        const result = await read(...readArgs);
        if (!changed && !result.bytesRead) {
          changed = true;
          await fs.writeFile(path.join(f.two, "new.txt"), "new content");
        }
        return result;
      };
    }
    return handle;
  });
  const result = await fingerprintMods(f.state);
  assert.equal(changed, true);
  assert.equal(result["local:two.mod"].status, "unavailable");
});

test("oversize files fail before any content is read", async (t) => {
  const f = await fixture(t),
    filename = path.join(f.root, "large.zip");
  await fs.writeFile(filename, "small isolated fixture");
  f.state.mods[1].contentPath = filename;
  const originalStat = fs.lstat,
    originalOpen = fs.open;
  t.mock.method(fs, "lstat", async (...args) => {
    const stat = await originalStat(...args);
    if (args[0] === filename)
      stat.size = BigInt(FINGERPRINT_LIMITS.modBytes + 1);
    return stat;
  });
  t.mock.method(fs, "open", async (...args) => {
    assert.notEqual(args[0], filename, "oversize content must not be opened");
    return originalOpen(...args);
  });
  const result = await fingerprintMods(f.state);
  assert.equal(result["local:two.mod"].status, "unavailable");
  assert.match(result["local:two.mod"].reason, /上限/);
});

test("cancellation propagates before scanning and during content reads", async (t) => {
  const f = await fixture(t),
    cancelled = new AbortController();
  cancelled.abort("cancelled by fixture");
  await assert.rejects(fingerprintMods(f.state, { signal: cancelled.signal }), {
    name: "AbortError",
  });
  const controller = new AbortController(),
    original = fs.open;
  let readCalled = false;
  t.mock.method(fs, "open", async (...args) => {
    const handle = await original(...args),
      read = handle.read.bind(handle);
    handle.read = async (...readArgs) => {
      const result = await read(...readArgs);
      readCalled = true;
      controller.abort();
      return result;
    };
    return handle;
  });
  await assert.rejects(
    fingerprintMods(f.state, { signal: controller.signal }),
    { name: "AbortError" },
  );
  assert.equal(readCalled, true);
});
