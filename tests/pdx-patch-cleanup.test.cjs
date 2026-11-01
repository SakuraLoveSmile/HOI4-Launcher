"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");
const {
  createPdxPatchWorkspace,
} = require("../electron/pdx-patch-workspace.cjs");
const {
  identity,
  planKey,
  cleanStaging,
} = require("../electron/pdx-download-checkpoint.cjs");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function fixture(t) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "ironclad-patch-cleanup-"),
  );
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("ironclad-patch-cleanup-"));
    await fs.rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  });
  const directory = await fs.mkdtemp(path.join(root, "download-"));
  const patch = Buffer.from("trusted patch bytes"),
    target = Buffer.from("trusted reconstructed zip");
  await fs.writeFile(path.join(directory, "patch.zip"), patch, { flag: "wx" });
  const workspace = await createPdxPatchWorkspace({ directory });
  let proofs;
  try {
    await workspace.openPatch({ bytes: patch.length, sha256: digest(patch) });
    const scratch = await workspace.createScratch();
    await scratch.write(Buffer.from("trusted payload"));
    const output = await workspace.createTarget({
      bytes: target.length,
      sha256: digest(target),
    });
    await output.write(target);
    await output.finish();
    proofs = await workspace.proofs();
  } finally {
    await workspace.close();
  }
  const transferPlan = {
    modId: "123",
    revision: "2",
    name: "Fixture",
    platform: "Any__Any",
    filename: "1_to_2.zip",
    archiveUrl:
      "https://modscontent.paradox-interactive.com/hoi4/Fixture/repo/Any__Any/2/1_to_2/1_to_2.zip",
    bytes: patch.length,
    sha256: digest(patch),
    kind: "patch",
    fromRevision: "1",
    unpackedBytes: 100,
  };
  const bigIdentity = (stat) =>
    Object.fromEntries(
      ["dev", "ino", "birthtimeNs"].map((key) => [key, String(stat[key])]),
    );
  const ancestors = [];
  let current = directory;
  for (;;) {
    ancestors.unshift({
      path: current,
      ...bigIdentity(await fs.lstat(current, { bigint: true })),
    });
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const staging = {
    directory: path.basename(directory),
    identity: identity(await fs.lstat(directory)),
    archiveIdentity: proofs.find((item) => item.name === "patch.zip").identity,
    artifacts: proofs.filter((item) => item.name !== "patch.zip"),
  };
  const partial = {
    transferPlan,
    checkpoint: {
      version: 1,
      planKey: planKey(transferPlan),
      receivedBytes: patch.length,
      prefixSha256: digest(patch),
      etag: null,
      identity: {
        file: bigIdentity(
          await fs.lstat(path.join(directory, "patch.zip"), { bigint: true }),
        ),
        ancestors,
      },
    },
  };
  const clean = () =>
    cleanStaging(root, root, staging, partial, async () => {});
  return { root, directory, staging, partial, patch, target, clean };
}

test("patch cleanup removes only the fully proven patch and derived files", async (t) => {
  const f = await fixture(t);
  assert.equal(await f.clean(), true);
  assert.deepEqual(await fs.readdir(f.root), []);
  assert.equal(await f.clean(), true, "already absent directory is clean");
});

for (const cause of [
  "unknown entry",
  "missing artifact",
  "replaced target",
  "wrong proof hash",
  "unknown patch tail",
]) {
  test(`patch cleanup retains the workspace for ${cause}`, async (t) => {
    const f = await fixture(t),
      targetPath = path.join(f.directory, "content.zip");
    if (cause === "unknown entry")
      await fs.writeFile(
        path.join(f.directory, "my-local-file.txt"),
        "preserve me",
      );
    if (cause === "missing artifact") await fs.unlink(targetPath);
    if (cause === "replaced target") {
      await fs.rename(targetPath, path.join(f.root, "old-target.zip"));
      await fs.writeFile(targetPath, f.target);
    }
    if (cause === "wrong proof hash")
      f.staging.artifacts = f.staging.artifacts.map((item) => ({
        ...item,
        sha256: "0".repeat(64),
      }));
    if (cause === "unknown patch tail")
      await fs.appendFile(path.join(f.directory, "patch.zip"), "unproven tail");
    const before = await fs.readdir(f.directory);
    assert.equal(await f.clean(), false);
    assert.deepEqual(await fs.readdir(f.directory), before);
    assert.deepEqual(
      (await fs.readFile(path.join(f.directory, "patch.zip"))).subarray(
        0,
        f.patch.length,
      ),
      f.patch,
    );
    if (cause !== "missing artifact")
      assert.deepEqual(await fs.readFile(targetPath), f.target);
  });
}
