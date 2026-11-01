"use strict";

const { ZipFile } = require("yazl");

async function createDiagnosticsArchive(report) {
  // Build only from the application's explicit report. Paths inside it are
  // diagnostic values, never files to collect from the player's machine.
  const diagnostics = Buffer.from(JSON.stringify(report, null, 2) + "\n");
  const events = Buffer.from(
    (report.events || []).map((event) => JSON.stringify(event) + "\n").join(""),
  );
  return new Promise((resolve, reject) => {
    const archive = new ZipFile();
    const chunks = [];
    archive.once("error", reject);
    archive.outputStream.once("error", reject);
    archive.outputStream.on("data", (chunk) => chunks.push(chunk));
    archive.outputStream.once("end", () => resolve(Buffer.concat(chunks)));
    archive.addBuffer(diagnostics, "diagnostics.json");
    archive.addBuffer(events, "events.jsonl");
    for (const [index, file] of (report.logHistory?.files || []).entries()) {
      // Archive names are generated here, never taken from diagnostic paths.
      const header = {
        format: "IRONCLAD-DIAGNOSTIC-EVENTS",
        schemaVersion: 1,
        sessionId: file.sessionId,
        part: file.part,
        createdAt: file.createdAt,
      };
      const lines = [header, ...file.events]
        .map((value) => JSON.stringify(value) + "\n")
        .join("");
      archive.addBuffer(
        Buffer.from(lines),
        `logs/history-${String(index + 1).padStart(3, "0")}.jsonl`,
      );
    }
    archive.end();
  });
}

module.exports = { createDiagnosticsArchive };
