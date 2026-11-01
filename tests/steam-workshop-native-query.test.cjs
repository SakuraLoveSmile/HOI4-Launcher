"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createExtendedWorkshopQuery,
} = require("../electron/steam-workshop-native-query.cjs");

function fixture(overrides = {}, options = {}) {
  const calls = [];
  let clock = 0;
  const api = {
    createQuery: (...args) => {
      calls.push(["create", ...args]);
      return 9007199254740993n;
    },
    ...Object.fromEntries(
      [
        "setCachedAge",
        "setMatchAnyTag",
        "addRequiredTag",
        "addExcludedTag",
        "setSearchText",
        "setTrendDays",
      ].map((name) => [
        name,
        (...args) => {
          calls.push([name, ...args]);
          return true;
        },
      ]),
    ),
    sendQuery: (query) => {
      calls.push(["send", query]);
      return 9007199254740995n;
    },
    runFrame: () => calls.push(["frame"]),
    isCallCompleted: () => true,
    getCallResult: (call, buffer, bytes, expected, failed) => {
      assert.equal(call, 9007199254740995n);
      assert.equal(bytes, 280);
      assert.equal(buffer.length, 280);
      assert.equal(expected, 3401);
      assert.equal(failed.length, 1);
      buffer.writeBigUInt64LE(9007199254740993n, 0);
      buffer.writeInt32LE(1, 8);
      buffer.writeUInt32LE(1, 12);
      buffer.writeUInt32LE(1234, 16);
      buffer[20] = 1;
      return true;
    },
    getItem: (query, index, buffer) => {
      assert.equal(query, 9007199254740993n);
      assert.equal(index, 0);
      assert.equal(buffer.length, 9784);
      buffer.writeBigUInt64LE(9007199254740997n, 0);
      buffer.writeInt32LE(1, 8);
      buffer.writeUInt32LE(394360, 20);
      buffer.write("测试前置模组", 24, 129, "utf8");
      buffer.write("Author description: 中文与 English", 153, 8000, "utf8");
      buffer.writeUInt32LE(1234567890, 8168);
      buffer.writeUInt32LE(1793424000, 8172);
      buffer.write("Gameplay,Utilities", 8187, 1025, "utf8");
      buffer.writeUInt32LE(123, 9756);
      buffer.writeUInt32LE(4, 9760);
      buffer.writeUInt32LE(2, 9768);
      // The SDK writes this trailing field even though the JS adapter omits it.
      buffer.writeBigUInt64LE(123456789012n, 9776);
      return true;
    },
    getPreview: (_query, _index, buffer, bytes) => {
      assert.equal(bytes, 2048);
      buffer.write("https://images.steamusercontent.com/ugc/fixture/preview");
      return true;
    },
    getStatistic: (_query, _index, statistic, buffer) => {
      assert.equal(statistic, 0);
      assert.equal(buffer.length, 8);
      buffer.writeBigUInt64LE(9007199254740999n);
      return true;
    },
    releaseQuery: (query) => {
      calls.push(["release", query]);
      return true;
    },
    ...overrides,
  };
  const query = createExtendedWorkshopQuery(
    () => {
      throw new Error("The legacy SDK cannot handle this query");
    },
    {
      nativeApi: api,
      timeoutMs: 20,
      pollMs: 5,
      now: () => clock,
      wait: (ms) => {
        clock += ms;
      },
      ...options,
    },
  );
  return {
    api,
    calls,
    query: (config = {}, type = 20) => query(1, type, 0, 0, 394360, config),
    get releases() {
      return calls.filter(([name]) => name === "release").length;
    },
  };
}

test("ordinary SDK queries preserve all arguments and never load the native bridge", async () => {
  const calls = [];
  const query = createExtendedWorkshopQuery((...args) => {
    calls.push(args);
    return "original result";
  });
  for (const type of [0, 1, 3, 12, 19]) {
    const config = { language: "schinese", includeLongDescription: true };
    assert.equal(await query(7, type, 0, 0, 394360, config), "original result");
    assert.deepEqual(calls.at(-1), [7, type, 0, 0, 394360, config]);
  }
});

for (const type of [20, 21])
  test(`query ${type} uses its actual native enum and decodes the Windows x64 SDK layout`, async () => {
    const f = fixture();
    const result = await f.query({}, type);
    assert.deepEqual(f.calls[0], ["create", type, 0, 0, 394360, 1]);
    assert.equal(result.totalResults, 1234);
    assert.equal(result.returnedResults, 1);
    assert.equal(result.wasCached, true);
    const item = result.items[0];
    assert.equal(item.publishedFileId, 9007199254740997n);
    assert.equal(item.consumerAppId, 394360);
    assert.equal(item.title, "测试前置模组");
    assert.equal(item.description, "Author description: 中文与 English");
    assert.equal(item.banned, false);
    assert.equal(item.timeUpdated, 1793424000);
    assert.deepEqual(item.tags, ["Gameplay", "Utilities"]);
    assert.equal(item.numUpvotes, 123);
    assert.equal(item.numDownvotes, 4);
    assert.equal(item.numChildren, 2);
    assert.equal(item.statistics.numSubscriptions, 9007199254740999n);
    assert.equal(
      item.previewUrl,
      "https://images.steamusercontent.com/ugc/fixture/preview",
    );
    assert.equal(f.releases, 1);
  });

test("query configuration sets every requested condition before sending", async () => {
  const f = fixture();
  await f.query(
    {
      cachedResponseMaxAge: 0,
      matchAnyTag: false,
      requiredTags: ["Gameplay"],
      excludedTags: ["Graphics"],
      searchText: "中国",
      rankedByTrendDays: 7,
    },
    20,
  );
  assert.deepEqual(
    f.calls.slice(0, 8).map(([name, _query, value]) => [name, value]),
    [
      ["create", 0],
      ["setCachedAge", 0],
      ["setMatchAnyTag", false],
      ["addRequiredTag", "Gameplay"],
      ["addExcludedTag", "Graphics"],
      ["setSearchText", "中国"],
      ["setTrendDays", 7],
      ["send", undefined],
    ],
  );
  assert.equal(f.releases, 1);
});

test("invalid config is rejected before creating a native handle", async () => {
  for (const config of [
    { arbitrary: true },
    { requiredTags: ["bad\0tag"] },
    { excludedTags: ["comma,tag"] },
    { searchText: "unsafe\ntext" },
    { matchAnyTag: "true" },
    { rankedByTrendDays: 0 },
    { rankedByTrendDays: 366 },
    { cachedResponseMaxAge: -1 },
  ]) {
    const f = fixture();
    await assert.rejects(f.query(config), /参数无效/);
    assert.deepEqual(f.calls, []);
  }
});

for (const name of [
  "setCachedAge",
  "setMatchAnyTag",
  "addRequiredTag",
  "addExcludedTag",
  "setSearchText",
  "setTrendDays",
])
  test(`failed ${name} releases its handle without sending`, async () => {
    const f = fixture({ [name]: () => false });
    await assert.rejects(
      f.query({
        cachedResponseMaxAge: 0,
        matchAnyTag: false,
        requiredTags: ["Gameplay"],
        excludedTags: ["Graphics"],
        searchText: "safe",
        rankedByTrendDays: 7,
      }),
      /筛选设置失败/,
    );
    assert.equal(f.releases, 1);
    assert.ok(!f.calls.some(([name]) => name === "send"));
  });

test("invalid handles are rejected and no nonexistent query is released", async () => {
  for (const value of [0n, -1n, 0xffffffffffffffffn, NaN]) {
    const f = fixture({ createQuery: () => value });
    await assert.rejects(f.query(), /查询创建失败/);
    assert.equal(f.releases, 0);
  }
  const f = fixture({ sendQuery: () => 0n });
  await assert.rejects(f.query(), /查询提交失败/);
  assert.equal(f.releases, 1);
});

test("bounded polling does not yield to the SDK callback timer before consuming only its own result", async () => {
  let anotherPumpRan = false;
  queueMicrotask(() => {
    anotherPumpRan = true;
  });
  const f = fixture({
    isCallCompleted: () => {
      assert.equal(anotherPumpRan, false);
      return f.calls.filter(([name]) => name === "frame").length === 3;
    },
  });
  await f.query();
  assert.equal(anotherPumpRan, true);
  assert.equal(f.calls.filter(([name]) => name === "frame").length, 3);
  assert.equal(f.releases, 1);
});

test("a stalled call times out and releases its query instead of wedging the serial queue", async () => {
  const f = fixture({ isCallCompleted: () => false });
  await assert.rejects(f.query(), /查询超时/);
  assert.equal(f.calls.filter(([name]) => name === "frame").length, 5);
  assert.equal(f.releases, 1);
});

test("failed calls, unreadable callbacks and mismatched query identities are rejected and released", async () => {
  const variants = [
    {
      isCallCompleted: (_call, failed) => {
        failed[0] = 1;
        return true;
      },
    },
    { getCallResult: () => false },
    {
      getCallResult: (_call, buffer, _bytes, _id, failed) => {
        failed[0] = 1;
        return true;
      },
    },
    {
      getCallResult: (_call, buffer) => {
        buffer.writeBigUInt64LE(42n);
        return true;
      },
    },
    {
      getCallResult: (_call, buffer) => {
        buffer.writeBigUInt64LE(9007199254740993n);
        buffer.writeInt32LE(2, 8);
        return true;
      },
    },
    { getItem: () => false },
  ];
  for (const overrides of variants) {
    const f = fixture(overrides);
    await assert.rejects(f.query(), {
      code: "STEAM_WORKSHOP_NATIVE_QUERY_FAILED",
    });
    assert.equal(f.releases, 1);
  }
});

test("invalid page sizes are rejected before reading item buffers", async () => {
  for (const [returned, total] of [
    [51, 100],
    [2, 1],
  ]) {
    const f = fixture();
    const original = f.api.getCallResult;
    f.api.getCallResult = (...args) => {
      original(...args);
      args[1].writeUInt32LE(returned, 12);
      args[1].writeUInt32LE(total, 16);
      return true;
    };
    await assert.rejects(f.query(), /结果无效/);
    assert.equal(f.releases, 1);
  }
});

test("missing optional preview/statistics are preserved as absent, unavailable items as null", async () => {
  const f = fixture({ getPreview: () => false, getStatistic: () => false });
  const result = await f.query();
  assert.equal(result.items[0].previewUrl, undefined);
  assert.deepEqual(result.items[0].statistics, {});
  const unavailable = fixture({
    getItem: (_query, _index, buffer) => {
      buffer.writeInt32LE(9, 8);
      return true;
    },
  });
  assert.deepEqual((await unavailable.query()).items, [null]);
});

test("release failure is reported without overwriting an earlier query error", async () => {
  const f = fixture({ releaseQuery: () => false });
  await assert.rejects(f.query(), /资源释放失败/);
  const failed = fixture({
    sendQuery: () => 0n,
    releaseQuery: () => {
      throw new Error("release");
    },
  });
  await assert.rejects(failed.query(), /查询提交失败/);
});
