"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { createPdxContentService } = require("../electron/pdx-content.cjs");

const repo =
  "https://modscontent.paradox-interactive.com/hoi4/6cca83a0-a6ec-11f1-92e5-affbeaa2abe2/repo/Any__Any/";
const relativeRepo =
  "mods/hoi4/6cca83a0-a6ec-11f1-92e5-affbeaa2abe2/repo/Any__Any";
const detail = {
  modId: "157712",
  game: "hoi4",
  name: "6cca83a0-a6ec-11f1-92e5-affbeaa2abe2",
  displayName: "Official signed metadata fixture",
  os: "Any",
  arch: "Any",
  modVersion: "12",
  state: "published",
  updating: false,
  acl: "public",
  isRegionBlocked: false,
};
async function fixture({ privateContent = false, change, options = {} } = {}) {
  const resources = new Map();
  for (const [resource, file] of [
    ["_keys/public.gpg", "repository-key.asc"],
    ["repository.json", "repository.json"],
    ["repository.json.asc", "repository.json.asc"],
    ["12/complete/manifest", "manifest"],
    ["12/complete/manifest.asc", "manifest.asc"],
  ]) {
    resources.set(
      resource,
      await fs.readFile(path.join(__dirname, "fixtures/pdx-signatures", file)),
    );
  }
  const calls = [],
    grants = [],
    accountCalls = [];
  const metadata = {
    result: "OK",
    modDetail: {
      ...detail,
      ...(privateContent
        ? { acl: "private", repositoryPath: relativeRepo }
        : {}),
    },
  };
  const account = {
    async request(input) {
      accountCalls.push(input);
      assert.equal(input.expectedAccountId, "fixture-account");
      if (input.path === "/mods") return metadata;
      assert.ok(input.path.startsWith(`/patch/repo/${relativeRepo}/`));
      const resource = input.path.slice(`/patch/repo/${relativeRepo}/`.length);
      assert.ok(resources.has(resource));
      const url = `https://private-cdn.example.invalid/resource/${grants.length}?grant=secret-${grants.length}`;
      grants.push({ resource, url });
      return {
        result: "OK",
        prepend: url.split("?")[0],
        append: "?" + url.split("?")[1],
        ttl: String(Math.floor(Date.now() / 1000) + 3600),
      };
    },
  };
  const fetchImpl = async (url, options) => {
    const headers = new Headers(options.headers);
    calls.push(url);
    assert.equal(headers.has("Authorization"), false);
    assert.equal(headers.has("Cookie"), false);
    assert.equal(options.credentials, "omit");
    assert.equal(options.redirect, "manual");
    if (change) {
      const result = await change(url, { resources, calls, grants });
      if (result) return result;
    }
    if (url.startsWith("https://api.paradox-interactive.com/mods?"))
      return Response.json(metadata);
    if (url.startsWith("https://revocation-prod.paradox-interactive.com/"))
      return new Response(null, { status: 204 });
    const resource = privateContent
      ? grants.find((x) => x.url === url)?.resource
      : url.slice(repo.length);
    assert.ok(resources.has(resource), `Unexpected resource ${url}`);
    return new Response(resources.get(resource));
  };
  return {
    resources,
    calls,
    grants,
    accountCalls,
    service: createPdxContentService({
      fetchImpl,
      ...(privateContent ? { account } : {}),
      ...options,
    }),
  };
}
test("default content resolver verifies the official expired-key chain using raw detached signatures", async () => {
  const f = await fixture(),
    plan = await f.service.resolve({ modId: "157712", revision: "12" });
  assert.equal(plan.revision, "12");
  assert.equal(plan.bytes, 606268882);
  assert.equal(
    plan.sha256,
    "3a07e9d50b2b6844b35e3f26f017c27e5c52ec419f7c135377005137b69d6b99",
  );
  assert.equal(f.calls.length, 8);
  assert.equal(
    f.calls.filter((url) => url.includes("revocation-prod")).length,
    2,
  );
  assert.ok(
    !f.calls.some((url) => url.endsWith(".zip")),
    "resolution fetches no mod archive",
  );
});
test("protected signature resources receive separate grants and never receive account credentials on CDN", async () => {
  const f = await fixture({ privateContent: true }),
    plan = await f.service.resolve({
      modId: "157712",
      revision: "12",
      expectedAccountId: "fixture-account",
    });
  assert.equal(plan.access, "repository");
  assert.equal(f.grants.length, 5);
  assert.equal(new Set(f.grants.map((x) => x.url)).size, 5);
  assert.deepEqual(
    f.grants.map((x) => x.resource),
    [
      "_keys/public.gpg",
      "repository.json",
      "repository.json.asc",
      "12/complete/manifest",
      "12/complete/manifest.asc",
    ],
  );
  assert.doesNotMatch(
    JSON.stringify(plan),
    /secret-|private-cdn|fixture-account/,
  );
});
for (const resource of [
  "repository.json",
  "repository.json.asc",
  "12/complete/manifest",
  "12/complete/manifest.asc",
]) {
  test(`tampered ${resource} fails closed before any archive request`, async () => {
    const f = await fixture();
    f.resources.set(
      resource,
      Buffer.concat([f.resources.get(resource), Buffer.from("tampered")]),
    );
    await assert.rejects(f.service.resolve({ modId: "157712" }), {
      code: "SIGNATURE_INVALID",
    });
    assert.ok(!f.calls.some((url) => url.endsWith(".zip")));
  });
}
test("a missing detached signature does not fall back to an unsigned manifest", async () => {
  const f = await fixture({
    change: (url) =>
      url === repo + "12/complete/manifest.asc"
        ? new Response(null, { status: 404 })
        : undefined,
  });
  await assert.rejects(f.service.resolve({ modId: "157712" }), {
    code: "NOT_FOUND",
  });
  assert.ok(!f.calls.some((url) => url.endsWith(".zip")));
});
test("revocation service failures cannot become an unrevoked result", async () => {
  const f = await fixture({
    change: (url) =>
      url.includes("revocation-prod")
        ? new Response("unavailable", { status: 503 })
        : undefined,
  });
  await assert.rejects(f.service.resolve({ modId: "157712" }), {
    code: "SIGNATURE_UNAVAILABLE",
  });
});
test("invalid HTTP 200 revocation material rejects the signed repository", async () => {
  const f = await fixture({
    change: (url) =>
      url.includes("revocation-prod")
        ? new Response("not a revocation certificate")
        : undefined,
  });
  await assert.rejects(f.service.resolve({ modId: "157712" }), {
    code: "SIGNATURE_INVALID",
  });
});
test("legacy HTTP 404 revocation replies remain compatible without following their body", async () => {
  const f = await fixture({
    change: (url) =>
      url.includes("revocation-prod")
        ? new Response("legacy 404", { status: 404 })
        : undefined,
  });
  assert.equal((await f.service.resolve({ modId: "157712" })).revision, "12");
});
test("reopened resolution obtains current signatures, keys and both revocation states again", async () => {
  const f = await fixture();
  await f.service.resolve({ modId: "157712" });
  await f.service.resolve({ modId: "157712" });
  assert.equal(f.calls.length, 16);
  assert.equal(
    f.calls.filter((url) => url === repo + "_keys/public.gpg").length,
    2,
  );
});
test("cancellation interrupts a hanging revocation lookup without requesting an archive", async () => {
  let entered;
  const reached = new Promise((resolve) => {
    entered = resolve;
  });
  const controller = new AbortController();
  const f = await fixture({
    change: (url) => {
      if (url.includes("revocation-prod")) {
        entered();
        return new Promise(() => {});
      }
    },
  });
  const pending = f.service.resolve({
    modId: "157712",
    signal: controller.signal,
  });
  await reached;
  controller.abort();
  await assert.rejects(pending, { code: "CANCELLED" });
  assert.ok(!f.calls.some((url) => url.endsWith(".zip")));
});
test("a revocation lookup deadline remains a timeout instead of a generic signature failure", async () => {
  const f = await fixture({
    options: { timeoutMs: 1000 },
    change: (url) =>
      url.includes("revocation-prod") ? new Promise(() => {}) : undefined,
  });
  await assert.rejects(f.service.resolve({ modId: "157712" }), {
    code: "TIMEOUT",
  });
  assert.ok(f.calls.some((url) => url.includes("revocation-prod")));
  assert.ok(!f.calls.some((url) => url.endsWith(".zip")));
});
