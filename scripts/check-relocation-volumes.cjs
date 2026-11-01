"use strict";
// Real filesystem integration, using only newly created disposable fixtures.
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { createPdxFixture } = require("./pdx-fixture.cjs");
const { createPdxInstallService } = require("../electron/pdx-install.cjs");

async function check() {
  const output = path.resolve(__dirname, "../test-results");
  await fs.mkdir(output, { recursive: true });
  const source = await fs.mkdtemp(path.join(os.tmpdir(), "ironclad-volume-"));
  const destination = await fs.mkdtemp(path.join(output, "cross-volume-"));
  try {
    const sourceDevice = (await fs.stat(source)).dev;
    const targetDevice = (await fs.stat(destination)).dev;
    const userDataPath = path.join(source, "user");
    await fs.mkdir(userDataPath);
    const storageDirectory = path.join(source, "control");
    const service = createPdxInstallService({ storageDirectory });
    const { bytes } = createPdxFixture();
    const archivePath = path.join(source, "mod.zip");
    await fs.writeFile(archivePath, bytes, { flag: "wx" });
    const original = await service.install({
      archivePath,
      userDataPath,
      plan: {
        modId: "123",
        revision: "1",
        title: "Cross-volume fixture",
        platform: "Any__Any",
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    });
    const descriptor = await fs.readFile(
      path.join(original.contentPath, "descriptor.mod"),
    );
    const plan = await service.planRelocation({
      userDataPath,
      targetParent: destination,
    });
    assert.deepEqual(plan.conflicts, []);
    const moved = await service.relocate({ planId: plan.planId });
    assert.deepEqual(moved.retainedPaths, []);
    const restarted = createPdxInstallService({ storageDirectory });
    const current = (await restarted.list())[0];
    assert.equal((await fs.stat(current.contentPath)).dev, targetDevice);
    assert.deepEqual(
      await fs.readFile(path.join(current.contentPath, "descriptor.mod")),
      descriptor,
    );
    assert.equal(current.descriptorPath, original.descriptorPath);
    await assert.rejects(fs.stat(original.contentPath), { code: "ENOENT" });
    const restore = await restarted.planRelocation({
      userDataPath,
      targetParent: null,
    });
    await restarted.relocate({ planId: restore.planId });
    const restored = (await restarted.list())[0];
    assert.equal((await fs.stat(restored.contentPath)).dev, sourceDevice);
    assert.deepEqual(
      await fs.readFile(path.join(restored.contentPath, "descriptor.mod")),
      descriptor,
    );
    await assert.rejects(fs.stat(current.contentPath), { code: "ENOENT" });
    const report = {
      checkedAt: new Date().toISOString(),
      sourceVolume: path.parse(source).root,
      targetVolume: path.parse(destination).root,
      sourceDevice,
      targetDevice,
      crossVolumeVerified: sourceDevice !== targetDevice,
      copiedAndRestored: true,
      originalFilesReleased: true,
      registeredDescriptorPreserved: true,
      realGameDataUsed: false,
    };
    await fs.writeFile(
      path.join(output, "relocation-volumes.json"),
      JSON.stringify(report, null, 2) + "\n",
    );
    console.log(JSON.stringify(report, null, 2));
  } finally {
    for (const [directory, parent, prefix] of [
      [source, os.tmpdir(), "ironclad-volume-"],
      [destination, output, "cross-volume-"],
    ]) {
      assert.equal(path.dirname(directory), parent);
      assert.ok(path.basename(directory).startsWith(prefix));
      await fs.rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      });
    }
  }
}
check().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
