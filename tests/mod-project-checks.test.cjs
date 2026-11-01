"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  analyzeProjectFiles,
  CHECK_LIMITS,
} = require("../electron/mod-project-checks.cjs");

test("event definitions satisfy project references and available localisation", () => {
  const result = analyzeProjectFiles([
    {
      path: "events/story.txt",
      text: "namespace = story\ncountry_event = { id = story.1 title = story.title desc = story.desc option = { name = story.option country_event = { id = story.2 days = 1 } } }\ncountry_event = { id = story.2 }",
    },
    {
      path: "localisation/english/story_l_english.yml",
      text: '\uFEFFl_english:\n story.title:0 "Title"\n story.desc:0 "Description"\n story.option:0 "Continue"',
    },
  ]);
  assert.deepEqual(result.issues, []);
  assert.equal(result.scope, "project-static-only");
  assert.deepEqual(
    result.groups.map((group) => group.id),
    ["events", "localisation"],
  );
});

test("unknown references are informational because game and dependency content is external", () => {
  const result = analyzeProjectFiles([
    {
      path: "events/story.txt",
      text: "country_event = { id = story.1 title = vanilla_title option = { country_event = { id = other.1 } country_event = other.1 } }",
    },
  ]);
  assert.equal(result.issues.length, 2);
  assert.ok(result.issues.every((issue) => issue.severity === "info"));
  assert.deepEqual(result.issues.map((issue) => issue.code).sort(), [
    "external-event-reference",
    "external-localisation-reference",
  ]);
  assert.ok(
    result.issues.every((issue) =>
      issue.message.includes("可能来自原版或依赖模组"),
    ),
  );
});

test("comments and quoted text cannot create fake events or structural errors", () => {
  const result = analyzeProjectFiles([
    {
      path: "events/story.txt",
      text: '# country_event = { id = fake.1\ncountry_event = { id = story.1 desc = "A sentence with } # and country_event = { id = ghost.1 }" option = { log = "escaped \\" quote and {" } }',
    },
  ]);
  assert.deepEqual(result.issues, []);
});

test("duplicate event and focus IDs identify relevant source files", () => {
  const result = analyzeProjectFiles([
    { path: "events/a.txt", text: "country_event = { id = duplicate.1 }" },
    { path: "events/b.txt", text: "news_event = { id = duplicate.1 }" },
    {
      path: "common/national_focus/tree.txt",
      text: "focus_tree = { id = tree focus = { id = SAME_FOCUS } focus = { id = SAME_FOCUS } }",
    },
    {
      path: "localisation/english/tree.yml",
      text: 'l_english:\n SAME_FOCUS:0 "Name"',
    },
  ]);
  assert.deepEqual(result.issues.map((issue) => issue.code).sort(), [
    "duplicate-event-id",
    "duplicate-focus-id",
  ]);
  assert.deepEqual(
    result.issues.find((issue) => issue.code === "duplicate-event-id")
      .relatedPaths,
    ["events/b.txt"],
  );
});

test("translations across languages are valid but repeated keys within a language are flagged", () => {
  const result = analyzeProjectFiles([
    {
      path: "localisation/english/a.yml",
      text: 'l_english:\n key:0 "English # text"\n # commented:0 "ignored"',
    },
    {
      path: "localisation/simp_chinese/a.yml",
      text: 'l_simp_chinese:\n key:0 "中文"',
    },
    {
      path: "localisation/english/b.yml",
      text: 'l_english:\n key:0 "Replacement"',
    },
  ]);
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].code, "duplicate-localisation");
  assert.equal(result.issues[0].path, "localisation/english/b.yml");
  assert.deepEqual(result.issues[0].relatedPaths, [
    "localisation/english/a.yml",
  ]);
});

test("descriptor dependencies and replace_path retain game semantics as actionable hints", () => {
  const result = analyzeProjectFiles([
    {
      path: "descriptor.mod",
      text: 'name="Mine"\ndependencies={"Original dependency" "Shared Library"}\nreplace_path="common/national_focus"\n',
    },
    {
      path: "common/national_focus/tree.txt",
      text: "focus_tree = { id = tree }",
    },
  ]);
  assert.equal(
    result.issues.filter((issue) => issue.code === "descriptor-dependency")
      .length,
    2,
  );
  const replace = result.issues.find(
    (issue) => issue.code === "descriptor-replace-path",
  );
  assert.equal(replace.severity, "warning");
  assert.deepEqual(replace.relatedPaths, ["common/national_focus/tree.txt"]);
});

test("unclosed structures report source positions without claiming full grammar validation", () => {
  for (const text of [
    "country_event = {\n id = story.1",
    'country_event = { id = "story.1 }',
    "name =",
    "}",
  ]) {
    const result = analyzeProjectFiles([{ path: "events/broken.txt", text }]);
    assert.equal(result.issues[0].code, "script-structure");
    assert.ok(result.issues[0].line >= 1);
    assert.equal(result.scope, "project-static-only");
  }
});

test("dynamic values and generic condition operators do not invent missing definitions", () => {
  const result = analyzeProjectFiles([
    {
      path: "events/test.txt",
      text: 'country_event = { id = test.1 title = "[ROOT.GetName]" trigger = { num_of_factories > 20 date < 1940.1.1 } option = { name = "A literal sentence." } }',
    },
  ]);
  assert.deepEqual(result.issues, []);
});

test("checks group binary paths while respecting text, depth and issue budgets", () => {
  const result = analyzeProjectFiles([
    { path: "gfx/test.dds", text: null },
    {
      path: "events/large.txt",
      text: "a".repeat(CHECK_LIMITS.fileCharacters + 1),
    },
    {
      path: "common/deep.txt",
      text:
        "a = {".repeat(CHECK_LIMITS.depth + 2) +
        "}".repeat(CHECK_LIMITS.depth + 2),
    },
    {
      path: "events/refs.txt",
      text: Array.from(
        { length: 600 },
        (_, i) =>
          `country_event = { id = test.${i} immediate = { country_event = missing.${i} } }`,
      ).join("\n"),
    },
  ]);
  assert.equal(result.limited, true);
  assert.equal(result.issues.length, CHECK_LIMITS.issues);
  assert.equal(result.groups.find((group) => group.id === "graphics").count, 1);
  assert.ok(result.issues.some((issue) => issue.code === "script-check-limit"));
});
