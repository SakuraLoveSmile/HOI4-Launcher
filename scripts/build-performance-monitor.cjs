"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execute = promisify(execFile);
const root = path.resolve(__dirname, "..");

async function buildPerformanceMonitor({
  outputPath = path.join(root, "assets", "game-performance-monitor.exe"),
  compilerPath,
  additionalSources = [],
  mainType,
  target = "winexe",
} = {}) {
  if (process.platform !== "win32")
    throw new Error("The performance monitor can only be built on Windows.");
  if (!["winexe", "exe"].includes(target)) throw new Error("Invalid target.");
  const compiler =
    compilerPath ||
    path.join(
      process.env.SystemRoot || "C:\\Windows",
      "Microsoft.NET",
      "Framework64",
      "v4.0.30319",
      "csc.exe",
    );
  await fs.access(compiler);
  const output = path.resolve(outputPath);
  await fs.mkdir(path.dirname(output), { recursive: true });
  const args = [
    "/nologo",
    "/optimize+",
    "/platform:x64",
    `/target:${target}`,
    "/reference:System.Web.Extensions.dll",
    `/out:${output}`,
    ...(mainType ? [`/main:${mainType}`] : []),
    path.join(root, "scripts", "native", "game-performance-monitor.cs"),
    ...additionalSources.map((source) => path.resolve(source)),
  ];
  await execute(compiler, args, {
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 512 * 1024,
  });
  return output;
}

module.exports = { buildPerformanceMonitor };

if (require.main === module) {
  buildPerformanceMonitor()
    .then((output) => console.log(`Built ${output}`))
    .catch((error) => {
      console.error(error.stdout || error.message);
      process.exitCode = 1;
    });
}
