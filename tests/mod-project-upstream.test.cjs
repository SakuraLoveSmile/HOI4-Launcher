"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createModProjectService } = require("../electron/mod-projects.cjs");
const {
  createModProjectUpstream,
} = require("../electron/mod-project-upstream.cjs");
const { createPdxContentService } = require("../electron/pdx-content.cjs");
const { createPdxIntegrity } = require("../electron/pdx-integrity.cjs");
const { createPdxSignatureVerifier } = require("../electron/pdx-signature.cjs");
const { createPdxResumeFixture } = require("../scripts/pdx-resume-fixture.cjs");
const {
  createSignatureFixture,
} = require("./fixtures/pdx-signatures/create-fixture.cjs");
let signingPromise;

async function fixture(
  t,
  { badSignature = false, badArchive = false, holdArchive = false } = {},
) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "ironclad-project-upstream-"),
  );
  t.after(() =>
    fs.rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    }),
  );
  const userData = path.join(root, "user"),
    original = path.join(root, "original");
  await fs.mkdir(original);
  await fs.mkdir(userData);
  await fs.writeFile(
    path.join(original, "descriptor.mod"),
    'name="Original"\nversion="1"\n',
  );
  await fs.writeFile(path.join(original, "personal.txt"), "keep me");
  const projects = createModProjectService({
    storageDirectory: path.join(root, "projects"),
    getUserDataPath: async () => userData,
  });
  const project = await projects.create({
    name: "My private version",
    sourcePath: original,
    upstreamRef: {
      provider: "pdx",
      modId: "pdx:123",
      remoteId: "123",
      revision: "1",
    },
    baselineKnown: true,
  });
  const data = createPdxResumeFixture();
  const signing = await (signingPromise ??= createSignatureFixture());
  const signed = await signing.sign({
    metadata: Buffer.from(
      JSON.stringify({
        version: "0.3",
        content: {
          versions: { 3: { completeSize: String(data.bytes.length) } },
        },
      }),
    ),
    manifest: Buffer.from(data.manifest),
  });
  const repo = data.prefix.slice(0, -"3/complete/".length);
  const resources = new Map([
    ["_keys/public.gpg", signed.repositoryKey],
    ["repository.json", signed.metadata],
    ["repository.json.asc", signed.metadataSignature],
    ["3/complete/manifest", signed.manifest],
    [
      "3/complete/manifest.asc",
      badSignature ? Buffer.from("bad") : signed.manifestSignature,
    ],
    [
      `3/complete/${data.name}.zip`,
      badArchive ? Buffer.alloc(data.bytes.length) : data.bytes,
    ],
  ]);
  const calls = [];
  const content = createPdxContentService({
    integrity: createPdxIntegrity({
      verifier: createPdxSignatureVerifier({
        rootKey: signing.rootKey,
        rootFingerprint: signing.rootFingerprint,
        now: () => signing.now,
      }),
    }),
    fetchImpl: async (url, options) => {
      calls.push(url);
      assert.equal(new Headers(options.headers).has("Authorization"), false);
      if (url.startsWith("https://api.paradox-interactive.com/mods?"))
        return Response.json(data.metadata);
      if (url.startsWith("https://revocation-prod.paradox-interactive.com/"))
        return new Response(null, { status: 204 });
      assert.ok(
        url.startsWith(repo),
        `Unexpected external destination: ${url}`,
      );
      const bytes = resources.get(url.slice(repo.length));
      assert.ok(bytes, `Unexpected resource ${url}`);
      if (holdArchive && url.endsWith(".zip"))
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(bytes.subarray(0, 64 * 1024));
            },
          }),
          { headers: { "Content-Length": String(bytes.length) } },
        );
      return new Response(bytes, {
        headers: { "Content-Length": String(bytes.length) },
      });
    },
  });
  const service = createModProjectUpstream({
    projects,
    content,
    getLauncherState: async () => ({ paths: { userData }, mods: [] }),
    storageDirectory: path.join(root, "downloads"),
  });
  return {
    root,
    userData,
    original,
    projects,
    project,
    service,
    content,
    calls,
    data,
    downloads: path.join(root, "downloads"),
  };
}

async function downloadEntries(directory) {
  try {
    return await fs.readdir(directory);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

test("signed PDX update becomes an independent candidate without switching the fork registration", async (t) => {
  const f = await fixture(t);
  const registration = await fs.readFile(f.project.descriptorPath);
  const current = await f.service.check(f.project.id);
  assert.equal(current.revision, "3");
  assert.equal(current.changed, true);
  await f.service.start(f.project.id);
  const { job } = await f.service.settled();
  assert.equal(job.status, "succeeded", job.error);
  const project = await f.projects.get(f.project.id);
  assert.ok(project.candidateSnapshotId);
  assert.equal(
    await fs.readFile(path.join(project.workPath, "personal.txt"), "utf8"),
    "keep me",
  );
  assert.deepEqual(await fs.readFile(project.descriptorPath), registration);
  await assert.rejects(
    fs.stat(path.join(project.workPath, "events", "fixture.txt")),
    { code: "ENOENT" },
  );
  assert.ok(f.calls.some((url) => url.endsWith("manifest.asc")));
  assert.ok(f.calls.some((url) => url.endsWith(".zip")));
  assert.deepEqual(
    await downloadEntries(f.downloads),
    [],
    "verified archive is removed after candidate capture",
  );
  assert.equal(job.retainedDownloadDirectory, undefined);
});

for (const corrupt of ["badSignature", "badArchive"])
  test(`PDX ${corrupt} cannot replace the candidate or change the workspace`, async (t) => {
    const f = await fixture(t, { [corrupt]: true });
    await f.service.start(f.project.id);
    const { job } = await f.service.settled();
    assert.equal(job.status, "failed");
    assert.equal(
      (await f.projects.get(f.project.id)).candidateSnapshotId,
      null,
    );
    assert.equal(
      await fs.readFile(path.join(f.project.workPath, "personal.txt"), "utf8"),
      "keep me",
    );
    if (corrupt === "badSignature")
      assert.equal(
        f.calls.some((url) => url.endsWith(".zip")),
        false,
      );
    assert.deepEqual(
      await downloadEntries(f.downloads),
      [],
      "failed transfer leaves no owned partial or download directory",
    );
  });

test("candidate capture failure cleans the completed owned archive", async (t) => {
  const f = await fixture(t);
  f.projects.captureCandidate = async () => {
    throw new Error("isolated capture failure");
  };
  await f.service.start(f.project.id);
  assert.equal((await f.service.settled()).job.status, "failed");
  assert.deepEqual(await downloadEntries(f.downloads), []);
  assert.equal((await f.projects.get(f.project.id)).candidateSnapshotId, null);
});

test(
  "cancelling a real partial transfer removes its owned bytes and directory",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t, { holdArchive: true });
    const download = f.content.download;
    let received = 0;
    f.content.download = (plan, options) =>
      download(plan, {
        ...options,
        onProgress: (value) => {
          options.onProgress(value);
          if (value.receivedBytes > 0) {
            received = value.receivedBytes;
            f.service.cancel();
          }
        },
      });
    await f.service.start(f.project.id);
    assert.equal((await f.service.settled()).job.status, "cancelled");
    assert.ok(received > 0 && received < f.data.bytes.length);
    assert.deepEqual(await downloadEntries(f.downloads), []);
    assert.equal(
      (await f.projects.get(f.project.id)).candidateSnapshotId,
      null,
    );
  },
);

for (const mutation of [
  "extra-file",
  "modified-archive",
  "replaced-identical-archive",
  "replaced-directory",
]) {
  test(`download cleanup retains external ${mutation} changes`, async (t) => {
    const f = await fixture(t);
    const capture = f.projects.captureCandidate;
    let directory;
    f.projects.captureCandidate = async (id, input) => {
      const result = await capture(id, input);
      directory = path.dirname(input.sourcePath);
      if (mutation === "extra-file")
        await fs.writeFile(path.join(directory, "personal.txt"), "preserve me");
      if (mutation === "modified-archive")
        await fs.writeFile(
          input.sourcePath,
          Buffer.alloc(f.data.bytes.length, 42),
        );
      if (mutation === "replaced-identical-archive") {
        await fs.rename(
          input.sourcePath,
          path.join(f.root, "saved-original.zip"),
        );
        await fs.writeFile(input.sourcePath, f.data.bytes);
      }
      if (mutation === "replaced-directory") {
        await fs.rename(directory, path.join(f.root, "saved-download"));
        await fs.mkdir(directory);
        await fs.writeFile(input.sourcePath, "external file");
      }
      return result;
    };
    await f.service.start(f.project.id);
    const { job } = await f.service.settled();
    assert.equal(job.status, "succeeded", job.error);
    assert.equal(job.retainedDownloadDirectory, directory);
    assert.ok((await fs.stat(path.join(directory, "content.zip"))).isFile());
    if (mutation === "extra-file")
      assert.equal(
        await fs.readFile(path.join(directory, "personal.txt"), "utf8"),
        "preserve me",
      );
    if (mutation === "replaced-identical-archive")
      assert.deepEqual(
        await fs.readFile(path.join(directory, "content.zip")),
        f.data.bytes,
      );
    if (mutation === "replaced-directory")
      assert.equal(
        await fs.readFile(path.join(directory, "content.zip"), "utf8"),
        "external file",
      );
  });
}

test("cleanup reports a directory retained when its archive disappears after enumeration", async (t) => {
  const f = await fixture(t);
  const capture = f.projects.captureCandidate,
    readdir = fs.readdir;
  let directory,
    armed = false;
  f.projects.captureCandidate = async (id, input) => {
    const result = await capture(id, input);
    directory = path.dirname(input.sourcePath);
    armed = true;
    return result;
  };
  fs.readdir = async (...args) => {
    const entries = await readdir(...args);
    if (armed && args[0] === directory) {
      armed = false;
      await fs.unlink(path.join(directory, "content.zip"));
      await fs.writeFile(path.join(directory, "external.txt"), "preserve me");
    }
    return entries;
  };
  try {
    await f.service.start(f.project.id);
    const { job } = await f.service.settled();
    assert.equal(job.status, "succeeded", job.error);
    assert.equal(job.retainedDownloadDirectory, directory);
    assert.equal(
      await fs.readFile(path.join(directory, "external.txt"), "utf8"),
      "preserve me",
    );
  } finally {
    fs.readdir = readdir;
  }
});

test("cancellation stops an in-flight content operation and never captures a candidate", async () => {
  let entered,
    captured = false;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const project = {
    id: "test",
    userData: path.resolve("isolated"),
    upstreamRef: { provider: "pdx", remoteId: "123", modId: "pdx:123" },
  };
  const service = createModProjectUpstream({
    projects: {
      get: async () => project,
      captureCandidate: async () => {
        captured = true;
      },
    },
    getLauncherState: async () => ({ paths: { userData: project.userData } }),
    storageDirectory: path.resolve("unused"),
    content: {
      resolve: ({ signal }) => {
        entered();
        return new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      },
    },
  });
  await service.start(project.id);
  await started;
  await assert.rejects(service.start(project.id), /已有上游获取/);
  service.cancel();
  assert.equal((await service.settled()).job.status, "cancelled");
  assert.equal(captured, false);
});
