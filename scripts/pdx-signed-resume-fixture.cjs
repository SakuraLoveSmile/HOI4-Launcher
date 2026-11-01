"use strict";
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { createAccountService } = require("../electron/account-service.cjs");
const { createPdxIntegrity } = require("../electron/pdx-integrity.cjs");
const { createPdxSignatureVerifier } = require("../electron/pdx-signature.cjs");
const { createPdxResumeFixture } = require("./pdx-resume-fixture.cjs");
const {
  createSignatureFixture,
} = require("../tests/fixtures/pdx-signatures/create-fixture.cjs");

// Real cryptography, account service, downloads and installation, with only
// generated test keys and isolated in-memory API/CDN responses.
async function createPdxSignedResumeFixture({
  sessionPath,
  filesAvailable = false,
}) {
  const data = createPdxResumeFixture(),
    signing = await createSignatureFixture();
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
  const resources = new Map([
    ["_keys/public.gpg", signed.repositoryKey],
    ["repository.json", signed.metadata],
    ["repository.json.asc", signed.metadataSignature],
    ["3/complete/manifest", signed.manifest],
    ["3/complete/manifest.asc", signed.manifestSignature],
  ]);
  const repositoryPath = `mods/hoi4/${data.name}/repo/Any__Any`,
    prefix = `/patch/repo/${repositoryPath}/`,
    fileResource = `files/${data.bytes.length}_${createHash("sha256").update(data.bytes).digest("base64url")}=`;
  const grants = [],
    accountCalls = [],
    failures = [];
  const token = "signed-ui-test-session",
    accountId = "signed-ui-test-account",
    cdn = "https://signed-content-ui.example.invalid";
  data.metadata.modDetail.acl = "private";
  data.metadata.modDetail.repositoryPath = repositoryPath;
  const guarded =
    (handler) =>
    async (...args) => {
      try {
        return await handler(...args);
      } catch (error) {
        failures.push(error.message);
        throw error;
      }
    };
  const account = createAccountService({
    sessionPath,
    fetchImpl: guarded(async (url, options) => {
      const address = new URL(url);
      assert.equal(address.origin, "https://api.paradox-interactive.com");
      assert.equal(options.redirect, "error");
      accountCalls.push(address.pathname);
      if (address.pathname === "/accounts/sessions/launcher-v2") {
        assert.equal(options.method, "PUT");
        return Response.json({ session: { token, userid: accountId } });
      }
      assert.equal(options.method, "GET");
      assert.equal(
        JSON.parse(options.headers.Authorization).session.token,
        token,
      );
      if (address.pathname === "/accountdetails")
        return Response.json({
          account: {
            email: "signed-ui@example.invalid",
            displayName: "Signed content UI fixture",
          },
        });
      if (address.pathname === "/mods") return data.fetchImpl(url, options);
      assert.equal(address.search, "");
      assert.ok(address.pathname.startsWith(prefix));
      const resource = address.pathname.slice(prefix.length);
      assert.ok(
        resources.has(resource) ||
          resource === `3/complete/${data.name}.zip` ||
          resource === fileResource,
      );
      const prepend = `${cdn}/grant/${grants.length}/${resource}`,
        append = `?signature=signed-ui-grant-${grants.length}`;
      grants.push({ resource, url: prepend + append });
      return Response.json({
        result: "OK",
        prepend,
        append,
        ttl: String(Math.floor(Date.now() / 1000) + 3600),
      });
    }),
  });
  return {
    ...data,
    account,
    grants,
    accountCalls,
    failures,
    signedResourceNames: [...resources.keys()],
    fileResource,
    integrity: () =>
      createPdxIntegrity({
        verifier: createPdxSignatureVerifier({
          rootKey: signing.rootKey,
          rootFingerprint: signing.rootFingerprint,
          now: () => signing.now,
        }),
      }),
    get heldCancelled() {
      return data.heldCancelled;
    },
    fetchImpl: guarded(async (url, options) => {
      const headers = new Headers(options.headers);
      assert.equal(headers.has("Authorization"), false);
      assert.equal(headers.has("Cookie"), false);
      assert.equal(options.credentials, "omit");
      assert.equal(options.redirect, "manual");
      if (
        new URL(url).origin ===
        "https://revocation-prod.paradox-interactive.com"
      ) {
        data.requests.push({ type: "revocation" });
        return new Response(null, { status: 204 });
      }
      const grant = grants.find((item) => item.url === url);
      assert.ok(
        grant,
        "every content resource needs an independent exact grant",
      );
      if (resources.has(grant.resource)) {
        data.requests.push({
          type: "signature-resource",
          resource: grant.resource,
        });
        return new Response(resources.get(grant.resource));
      }
      if (grant.resource === fileResource && !filesAvailable) {
        data.requests.push({ type: "files-missing", resource: fileResource });
        return new Response(null, { status: 404 });
      }
      return data.fetchImpl(
        data.prefix +
          (grant.resource === fileResource
            ? data.name + ".zip"
            : grant.resource.split("/").at(-1)),
        options,
      );
    }),
    assertNoSecrets(value) {
      const serialized = JSON.stringify(value);
      for (const secret of [
        token,
        accountId,
        cdn,
        "signed-ui-grant-",
        "signature=",
      ])
        assert.equal(
          serialized.includes(secret),
          false,
          "credentials and grants stay out of public state",
        );
    },
  };
}
module.exports = { createPdxSignedResumeFixture };
