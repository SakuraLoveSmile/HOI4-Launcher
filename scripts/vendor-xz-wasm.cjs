"use strict";

// Offline, deterministic extraction and memory-only transformation. No upstream
// JavaScript or WASM is evaluated by this script.
const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");
const {
  PAGE_BYTES,
  MAX_MEMORY_BYTES,
  UPSTREAM_BYTES,
  UPSTREAM_SHA256,
  limitMemory,
} = require("../electron/vendor/xz/memory-limit.cjs");

const root = path.resolve(__dirname, "..");
const source = path.join(root, "licenses", "xz-decompress");
const destination = path.join(root, "electron", "vendor", "xz");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function main() {
  if (process.argv.slice(2).some((value) => value !== "--check"))
    throw new Error("Usage: node scripts/vendor-xz-wasm.cjs [--check]");
  const check = process.argv.includes("--check");
  const archive = await fs.readFile(
    path.join(source, "xz-decompress-0.2.3.tgz"),
  );
  const bundle = await fs.readFile(path.join(source, "xz-decompress.js"));
  if (
    archive.length !== 14444 ||
    sha256(archive) !==
      "b590b7ea774bd82e812d74c572d6c9fcd4abef4da752c974e8d335439f63e69c" ||
    bundle.length !== 26506 ||
    sha256(bundle) !==
      "3e1c069c559e5c08e2c6a237ecb93687151725e517d36847c3d10b2b8975a93c"
  )
    throw new Error("Pinned xz-decompress source materials do not match.");
  const matches = [
    ...bundle
      .toString("utf8")
      .matchAll(/data:application\/wasm;base64,([A-Za-z0-9+/=]+)/g),
  ];
  if (matches.length !== 1)
    throw new Error("Expected one embedded WASM module.");
  const upstream = Buffer.from(matches[0][1], "base64");
  const bounded = limitMemory(upstream, MAX_MEMORY_BYTES);
  const metadata = {
    formatVersion: 1,
    package: "xz-decompress",
    version: "0.2.3",
    packageUrl:
      "https://registry.npmjs.org/xz-decompress/-/xz-decompress-0.2.3.tgz",
    packageSha256: sha256(archive),
    packageIntegrity:
      "sha512-O8v6HG8T0PrKBcpyWA13GkSYWFvncwzuzcLx5A7++l3HsE3atmoetXjIxrZ/JV/nbvSZ7WS4+3XvREZuVn+rEA==",
    gitHead: "02e7ec3ee164de24cd3d1baf76911dd0be68a7c0",
    upstream: {
      file: "xz-decompress.upstream.wasm",
      bytes: UPSTREAM_BYTES,
      sha256: UPSTREAM_SHA256,
      memoryMinimumBytes: 2 * PAGE_BYTES,
      memoryMaximumBytes: null,
    },
    bounded: {
      file: "xz-decompress.memory64m.wasm",
      bytes: bounded.length,
      sha256: sha256(bounded),
      memoryMinimumBytes: 2 * PAGE_BYTES,
      memoryMaximumBytes: MAX_MEMORY_BYTES,
    },
    transformation:
      "Only WASM section 5: one memory, flags 0 to 1, minimum 2 pages unchanged, maximum 1024 pages. All other section bytes unchanged.",
    reproduction: "node scripts/vendor-xz-wasm.cjs --check",
    runtime:
      "pdx-xz.cjs verifies the original hash and applies the same transformation before instantiation, allowing a lower page-aligned maximum.",
  };
  const files = new Map([
    [metadata.upstream.file, upstream],
    [metadata.bounded.file, bounded],
    ["metadata.json", Buffer.from(JSON.stringify(metadata, null, 2) + "\n")],
  ]);
  if (!check) await fs.mkdir(destination, { recursive: true });
  for (const [name, data] of files) {
    const target = path.join(destination, name);
    if (check) {
      if (!(await fs.readFile(target)).equals(data))
        throw new Error(`Vendored asset does not match: ${name}`);
    } else await fs.writeFile(target, data);
  }
  console.log(
    JSON.stringify({
      checked: check,
      assets: [...files.keys()],
      ...metadata.bounded,
    }),
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
