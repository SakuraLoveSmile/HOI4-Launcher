"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const { once } = require("node:events");
const { createPdxResumeFixture } = require("../scripts/pdx-resume-fixture.cjs");
const { createPdxContentService } = require("../electron/pdx-content.cjs");
const { createPdxDownloads } = require("../electron/pdx-downloads.cjs");
const { createPdxInstallService } = require("../electron/pdx-install.cjs");

async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!(await predicate())) {
    if (Date.now() > deadline)
      throw new Error("Local resume integration did not settle");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function fixture(t, { ignoreRange = false } = {}) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "ironclad-resume-http-"),
  );
  const data = createPdxResumeFixture(),
    requests = [],
    failures = [];
  const userDataPath = path.join(root, "user"),
    storageDirectory = path.join(root, "downloads");
  await fs.mkdir(userDataPath);
  let hungOnce = false,
    hungClosed = false;
  const server = http.createServer((req, res) => {
    try {
      assert.equal(req.headers.authorization, undefined);
      assert.equal(req.headers.cookie, undefined);
      const address = new URL(req.url, "http://fixture.invalid");
      requests.push({
        path: address.pathname,
        range: req.headers.range,
        ifRange: req.headers["if-range"],
      });
      if (address.pathname === "/mods") {
        assert.equal(address.searchParams.get("modVersion"), "3");
        res.end(JSON.stringify(data.metadata));
      } else if (address.pathname.endsWith("/manifest")) res.end(data.manifest);
      else {
        assert.ok(address.pathname.endsWith(".zip"));
        const range = req.headers.range?.match(/^bytes=(\d+)-$/);
        const offset = range && !ignoreRange ? Number(range[1]) : 0;
        res.statusCode = offset ? 206 : 200;
        res.setHeader("Content-Length", data.bytes.length - offset);
        res.setHeader("ETag", '"resume-fixture-v1"');
        res.setHeader("Accept-Ranges", "bytes");
        if (offset)
          res.setHeader(
            "Content-Range",
            `bytes ${offset}-${data.bytes.length - 1}/${data.bytes.length}`,
          );
        if (!hungOnce) {
          hungOnce = true;
          res.on("close", () => {
            hungClosed = true;
          });
          res.write(data.bytes.subarray(0, 64 * 1024));
        } else res.end(data.bytes.subarray(offset));
      }
    } catch (error) {
      failures.push(error.message);
      res.destroy(error);
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  const content = createPdxContentService({
    integrity: require("../scripts/pdx-fixture-integrity.cjs").fixtureIntegrity,
    fetchImpl: async (url, options) => {
      const address = new URL(url);
      assert.ok(
        [
          "https://api.paradox-interactive.com",
          "https://modscontent.paradox-interactive.com",
        ].includes(address.origin),
      );
      const reply = await fetch(
        base + address.pathname + address.search,
        options,
      );
      // Preserve actual HTTP body/status/headers; production never sees the local URL.
      return new Response(reply.body, {
        status: reply.status,
        headers: reply.headers,
      });
    },
  });
  const installer = createPdxInstallService({
    storageDirectory: path.join(root, "installed"),
  });
  const options = {
    content,
    installer,
    storageDirectory,
    getUserDataPath: async () => userDataPath,
  };
  const services = [];
  const open = () => {
    const service = createPdxDownloads(options);
    services.push(service);
    return service;
  };
  t.after(async () => {
    for (const service of services) service.dispose();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await until(() => services.every((service) => !service.isBusy()));
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("ironclad-resume-http-"));
    await fs.rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  });
  return {
    root,
    data,
    requests,
    failures,
    installer,
    storageDirectory,
    open,
    async pause(service) {
      await service.start({ modId: "123", revision: "3" });
      await until(
        async () => (await service.getState()).job?.progress?.receivedBytes > 0,
      );
      await service.pause();
      await until(() => !service.isBusy());
      await until(() => hungClosed);
      const state = await service.getState();
      assert.equal(state.job.status, "paused");
      assert.equal(state.job.canResume, true);
      assert.deepEqual(await installer.list(), []);
      return state;
    },
  };
}

for (const scenario of ["range", "ignored-range", "unrecorded-tail"]) {
  test(`real HTTP ${scenario}: pause, reopen and resume a verified prefix without changing an unknown source`, async (t) => {
    const f = await fixture(t, { ignoreRange: scenario === "ignored-range" });
    const first = f.open(),
      paused = await f.pause(first);
    const directory = (await fs.readdir(f.storageDirectory)).find((name) =>
      /^download-/.test(name),
    );
    assert.ok(directory);
    const source = path.join(f.storageDirectory, directory, "content.zip");
    const prefix = await fs.readFile(source);
    assert.equal(prefix.length, paused.job.progress.receivedBytes);
    assert.ok(prefix.length > 0 && prefix.length < f.data.bytes.length);
    let retained;
    if (scenario === "unrecorded-tail") {
      await fs.appendFile(source, "unknown tail after saved checkpoint");
      retained = await fs.readFile(source);
    }
    first.dispose();
    const before = f.requests.length,
      second = f.open();
    assert.equal((await second.getState()).job.canResume, true);
    assert.equal(
      f.requests.length,
      before,
      "startup must not contact provider or replay the task",
    );
    await second.resume();
    await until(() => !second.isBusy());
    const result = await second.getState();
    assert.equal(result.job.status, "succeeded", result.job.error);
    if (scenario === "ignored-range")
      assert.equal(result.job.progress.restarted, true);
    assert.equal((await f.installer.list())[0].revision, "3");
    const archives = f.requests.filter((request) =>
      request.path.endsWith(".zip"),
    );
    assert.equal(archives.length, 2);
    assert.equal(archives[1].range, `bytes=${prefix.length}-`);
    assert.equal(archives[1].ifRange, '"resume-fixture-v1"');
    if (retained) {
      assert.deepEqual(await fs.readFile(source), retained);
      const paths = [
        result.job.retainedDownloadDirectory,
        ...(result.job.retainedDownloadDirectories || []),
      ];
      assert.ok(
        paths.some(
          (value) => value === path.dirname(source) || value === source,
        ),
      );
    } else await assert.rejects(fs.lstat(source), { code: "ENOENT" });
    assert.deepEqual(f.failures, []);
  });
}
