"use strict";
// In-memory content only. Shared by hidden UI and local HTTP integration tests.
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { zipFixture } = require("./pdx-fixture.cjs");

function createPdxResumeFixture({ revision = "3" } = {}) {
  const name = "11111111-2222-3333-4444-555555555555";
  const title = "Resumable PDX fixture";
  const bytes = zipFixture({
    "descriptor.mod": `name="${title}"\nversion="${revision}"\nsupported_version="1.19.*"\n`,
    "events/fixture.txt": "# isolated resumable content\n".repeat(20000),
  });
  const digest = createHash("sha256").update(bytes).digest("base64");
  const prefix = `https://modscontent.paradox-interactive.com/hoi4/${name}/repo/Any__Any/${revision}/complete/`;
  const manifest = `Name: Any__Any\nHash: sha256\n\n${name}.zip,${bytes.length},${digest},crw,${bytes.length},zip\n`;
  const metadata = {
    result: "OK",
    modDetail: {
      modId: "123",
      name,
      game: "hoi4",
      os: "Any",
      arch: "Any",
      modVersion: revision,
      state: "published",
      acl: "public",
      updating: false,
      isRegionBlocked: false,
      displayName: title,
    },
  };
  const requests = [];
  let held = false,
    cancelled = false;
  const fetchImpl = async (url, options) => {
    const headers = new Headers(options?.headers);
    const address = new URL(url);
    if (address.origin === "https://api.paradox-interactive.com") {
      assert.equal(address.pathname, "/mods");
      assert.equal(address.searchParams.get("modId"), "123");
      if (address.searchParams.has("modVersion"))
        assert.equal(address.searchParams.get("modVersion"), revision);
      requests.push({ type: "metadata" });
      return Response.json(metadata);
    }
    assert.equal(address.origin, "https://modscontent.paradox-interactive.com");
    assert.equal(headers.has("Authorization"), false);
    assert.equal(headers.has("Cookie"), false);
    assert.equal(options.credentials, "omit");
    if (url === prefix + "manifest") {
      requests.push({ type: "manifest" });
      return new Response(manifest);
    }
    assert.equal(url, prefix + name + ".zip");
    const range = headers.get("Range"),
      match = range?.match(/^bytes=(\d+)-$/);
    assert.ok(range === null || match);
    const offset = match ? Number(match[1]) : 0;
    requests.push({ type: "archive", range, ifRange: headers.get("If-Range") });
    const responseHeaders = {
      "Content-Length": String(bytes.length - offset),
      ETag: '"resume-fixture-v1"',
      "Accept-Ranges": "bytes",
      ...(offset
        ? {
            "Content-Range": `bytes ${offset}-${bytes.length - 1}/${bytes.length}`,
          }
        : {}),
    };
    const body = new ReadableStream({
      start(controller) {
        if (!held && !offset) {
          held = true;
          controller.enqueue(bytes.subarray(0, 64 * 1024));
        } else {
          controller.enqueue(bytes.subarray(offset));
          controller.close();
        }
      },
      cancel() {
        cancelled = true;
      },
    });
    return new Response(body, {
      status: offset ? 206 : 200,
      headers: responseHeaders,
    });
  };
  return {
    bytes,
    manifest,
    metadata,
    revision,
    name,
    prefix,
    requests,
    fetchImpl,
    get heldCancelled() {
      return cancelled;
    },
  };
}

module.exports = { createPdxResumeFixture };
