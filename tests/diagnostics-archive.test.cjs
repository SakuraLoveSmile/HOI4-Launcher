"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const yauzl = require("yauzl");
const {
  createDiagnosticsArchive,
} = require("../electron/diagnostics-archive.cjs");

async function readArchive(bytes) {
  const archive = await yauzl.fromBufferPromise(bytes, { lazyEntries: true });
  const files = Object.create(null);
  for await (const entry of archive.eachEntry()) {
    const chunks = [];
    for await (const chunk of await archive.openReadStreamPromise(entry))
      chunks.push(chunk);
    files[entry.fileName] = Buffer.concat(chunks).toString("utf8");
  }
  return files;
}

test("diagnostic ZIP contains the exact report and UTF-8 session events without collecting paths", async () => {
  const report = {
    generatedAt: "2026-10-29T00:00:00.000Z",
    paths: { userData: "Z:\\does-not-exist\\设置 {0} <img>.json" },
    counts: { mods: 2, playsets: 1, dlc: 0 },
    warnings: ["设置\n甲，但乙"],
    events: [
      {
        at: "2026-10-29T00:00:00.000Z",
        action: "launcher:save",
        result: "error",
        detail: "拒绝访问\n设置",
      },
    ],
  };
  const files = await readArchive(await createDiagnosticsArchive(report));
  assert.deepEqual(Object.keys(files).sort(), [
    "diagnostics.json",
    "events.jsonl",
  ]);
  assert.deepEqual(JSON.parse(files["diagnostics.json"]), report);
  assert.deepEqual(
    files["events.jsonl"].trim().split("\n").map(JSON.parse),
    report.events,
  );
  assert.equal(report.events[0].detail, "拒绝访问\n设置");
});

test("diagnostic ZIP preserves a valid empty session log", async () => {
  const report = { launcherVersion: "fixture", events: [] };
  const files = await readArchive(await createDiagnosticsArchive(report));
  assert.deepEqual(JSON.parse(files["diagnostics.json"]), report);
  assert.equal(files["events.jsonl"], "");
});

test("diagnostic serialization failures reject before producing an archive", async () => {
  const report = { events: [] };
  report.cycle = report;
  await assert.rejects(createDiagnosticsArchive(report), /circular/i);
});

test("diagnostic ZIP generates safe history names from the same explicit snapshot", async () => {
  const file = {
    name: "../../credential.session",
    sessionId: "fixture-session",
    part: 2,
    createdAt: "2026-10-29T00:00:00.000Z",
    truncated: true,
    events: [
      {
        at: "2026-10-29T00:00:01.000Z",
        action: "app:start",
        result: "ok",
        detail: "",
      },
    ],
  };
  const report = {
    events: [],
    logHistory: { directory: "Z:\\does-not-exist", files: [file] },
  };
  const files = await readArchive(await createDiagnosticsArchive(report));
  assert.deepEqual(Object.keys(files).sort(), [
    "diagnostics.json",
    "events.jsonl",
    "logs/history-001.jsonl",
  ]);
  assert.deepEqual(JSON.parse(files["diagnostics.json"]), report);
  const lines = files["logs/history-001.jsonl"]
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.deepEqual(lines.slice(1), file.events);
  assert.deepEqual(lines[0], {
    format: "IRONCLAD-DIAGNOSTIC-EVENTS",
    schemaVersion: 1,
    sessionId: file.sessionId,
    part: 2,
    createdAt: file.createdAt,
  });
  assert.equal(
    files["logs/history-001.jsonl"].includes("credential.session"),
    false,
  );
});
