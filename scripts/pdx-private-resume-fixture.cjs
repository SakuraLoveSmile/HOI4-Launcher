"use strict";
const assert = require("node:assert/strict");
const { createAccountService } = require("../electron/account-service.cjs");
const { createPdxResumeFixture } = require("./pdx-resume-fixture.cjs");

// All requests are in-memory fixtures. No real account, CDN or game is used.
function createPdxPrivateResumeFixture({ sessionPath }) {
  const data = createPdxResumeFixture(),
    repositoryPath = `mods/hoi4/${data.name}/repo/Any__Any`,
    prefix = `/patch/repo/${repositoryPath}/3/complete/`,
    grants = [],
    accountCalls = [],
    failures = [],
    token = "private-ui-isolated-session",
    accountId = "private-ui-isolated-account",
    cdn = "https://signed-ui.example.invalid";
  data.metadata.modDetail.acl = "private";
  data.metadata.modDetail.repositoryPath = repositoryPath;
  const guarded = (handler) => async (url, options) => {
    try {
      return await handler(url, options);
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
            email: "private-ui@example.invalid",
            displayName: "Private UI fixture",
          },
        });
      if (address.pathname === "/mods") {
        assert.equal(address.searchParams.get("modVersion"), "3");
        return data.fetchImpl(url, options);
      }
      assert.equal(address.search, "");
      assert.ok(address.pathname.startsWith(prefix));
      const resource = address.pathname.slice(prefix.length);
      assert.ok(["manifest", `${data.name}.zip`].includes(resource));
      const prepend = `${cdn}/grant/${grants.length + 1}/${resource}`,
        append = `?signature=private-ui-grant-${grants.length + 1}`;
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
    get heldCancelled() {
      return data.heldCancelled;
    },
    fetchImpl: guarded(async (url, options) => {
      const grant = grants.find((item) => item.url === url);
      assert.ok(grant, "every CDN request must use an exact resource grant");
      return data.fetchImpl(data.prefix + grant.resource, options);
    }),
    assertNoSecrets(value) {
      const serialized = JSON.stringify(value);
      for (const secret of [
        token,
        accountId,
        cdn,
        "private-ui-grant-",
        "signature=",
      ])
        assert.equal(
          serialized.includes(secret),
          false,
          "download state must not contain account credentials or grant URLs",
        );
    },
  };
}
module.exports = { createPdxPrivateResumeFixture };
