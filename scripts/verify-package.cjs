"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const asar = require("@electron/asar");
const root = path.resolve(__dirname, "..");
const releaseDir = path.resolve(root, process.argv[2] || "release");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function files(directory) {
  if ((await fs.stat(directory)).isFile()) return [directory];
  const result = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await files(target)));
    else if (entry.isFile()) result.push(target);
  }
  return result;
}
async function verify() {
  const manifest = JSON.parse(
    await fs.readFile(path.join(root, "package.json"), "utf8"),
  );
  const archive = path.join(
    releaseDir,
    "win-unpacked",
    "resources",
    "app.asar",
  );
  const packaged = JSON.parse(asar.extractFile(archive, "package.json"));
  assert.equal(packaged.version, manifest.version);
  let compared = 0;
  for (const directory of [
    "electron",
    "dist",
    "src/locales",
    "src/language-info.json",
    "src/workshop-filters.json",
  ]) {
    for (const file of await files(path.join(root, directory))) {
      const relative = path.relative(root, file);
      assert.equal(
        hash(asar.extractFile(archive, relative)),
        hash(await fs.readFile(file)),
        `Packaged file differs: ${relative}`,
      );
      compared++;
    }
  }
  for (const name of ["steamworksjs.win32-x64-msvc.node", "steam_api64.dll"]) {
    const relative = `node_modules/steamworks.js/dist/win64/${name}`;
    assert.equal(
      asar.statFile(archive, path.normalize(relative)).unpacked,
      true,
    );
    const payload = await fs.readFile(
      path.join(archive + ".unpacked", relative),
    );
    assert.equal(
      hash(payload),
      hash(await fs.readFile(path.join(root, relative))),
    );
    assert.equal(payload.toString("ascii", 0, 2), "MZ");
  }
  const koffiVersion = manifest.dependencies.koffi;
  for (const relative of [
    "node_modules/koffi/index.cjs",
    "node_modules/koffi/src/koffi/index.cjs",
    "node_modules/koffi/LICENSE.txt",
    "node_modules/@koromix/koffi-win32-x64/index.js",
    "node_modules/@koromix/koffi-win32-x64/win32_x64/koffi.node",
  ]) {
    assert.equal(
      asar.statFile(archive, path.normalize(relative)).unpacked,
      true,
    );
    assert.equal(
      hash(await fs.readFile(path.join(archive + ".unpacked", relative))),
      hash(await fs.readFile(path.join(root, relative))),
      `Packaged Steam query dependency differs: ${relative}`,
    );
  }
  const koffiDirectory = path.join(
    archive + ".unpacked",
    "node_modules",
    "koffi",
  );
  const packagedKoffi = require(koffiDirectory);
  assert.equal(packagedKoffi.version, koffiVersion);
  assert.equal(packagedKoffi.sizeof("uint64_t"), 8);
  for (const name of ["index.js", "crc32.js", "fd-slicer.js"]) {
    const relative = path.join("node_modules", "yauzl", name);
    assert.equal(
      hash(asar.extractFile(archive, relative)),
      hash(await fs.readFile(path.join(root, relative))),
      `Packaged ZIP reader differs: ${name}`,
    );
  }
  for (const dependency of ["yazl", "sanitize-html"]) {
    const dependencyRoot = path.join(root, "node_modules", dependency);
    for (const file of await files(dependencyRoot)) {
      if (!/\.(?:c?js|mjs|json)$/.test(file)) continue;
      const relative = path.relative(root, file);
      if (path.basename(file) === "package.json") {
        // electron-builder removes development-only package metadata.
        const packedDependency = JSON.parse(
          asar.extractFile(archive, relative),
        );
        const installedDependency = JSON.parse(await fs.readFile(file, "utf8"));
        for (const field of [
          "name",
          "version",
          "main",
          "type",
          "exports",
          "dependencies",
        ])
          assert.deepEqual(
            packedDependency[field],
            installedDependency[field],
            `${relative}: ${field}`,
          );
        continue;
      }
      assert.equal(
        hash(asar.extractFile(archive, relative)),
        hash(await fs.readFile(file)),
        `Packaged publication dependency differs: ${relative}`,
      );
    }
  }
  const libraryRelative = path.join("node_modules", "openpgp");
  const libraryRoot = path.join(root, libraryRelative);
  const unpackedLibrary = path.join(archive + ".unpacked", libraryRelative);
  let libraryFiles = 0;
  for (const file of await files(libraryRoot)) {
    if (!/\.(?:c?js|mjs)$/.test(file) && path.basename(file) !== "LICENSE")
      continue;
    const relative = path.relative(root, file);
    assert.equal(
      asar.statFile(archive, relative).unpacked,
      true,
      `OpenPGP runtime file must remain replaceable: ${relative}`,
    );
    assert.equal(
      hash(await fs.readFile(path.join(archive + ".unpacked", relative))),
      hash(await fs.readFile(file)),
      `Packaged OpenPGP differs: ${relative}`,
    );
    libraryFiles++;
  }
  const libraryManifest = JSON.parse(
    await fs.readFile(path.join(unpackedLibrary, "package.json"), "utf8"),
  );
  const installedLibrary = JSON.parse(
    await fs.readFile(path.join(libraryRoot, "package.json"), "utf8"),
  );
  assert.equal(libraryManifest.version, "6.3.2");
  for (const field of [
    "name",
    "version",
    "main",
    "type",
    "exports",
    "dependencies",
  ])
    assert.deepEqual(
      libraryManifest[field],
      installedLibrary[field],
      `OpenPGP runtime metadata: ${field}`,
    );
  const libraryEntry = require.resolve(unpackedLibrary);
  assert.equal(
    path.relative(unpackedLibrary, libraryEntry),
    path.join("dist", "node", "openpgp.min.cjs"),
  );
  // This loads only the separately unpacked JS library in system Node. It
  // never executes Electron, the portable EXE or any Steam native module.
  const packagedOpenPgp = require(libraryEntry);
  assert.equal(typeof packagedOpenPgp.readKeys, "function");
  const rootKey = await packagedOpenPgp.readKey({
    armoredKey: (
      await fs.readFile(
        path.join(root, "electron/keys/pdx-production-root.asc"),
      )
    ).toString("ascii"),
  });
  assert.equal(
    rootKey.getFingerprint().toUpperCase(),
    "AF28077C9C565B53F3CD5A65788AA56D99D64E1C",
  );
  const resourcesDirectory = path.dirname(archive);
  const performanceMonitor = await fs.readFile(
    path.join(resourcesDirectory, "performance-monitor.exe"),
  );
  assert.equal(
    hash(performanceMonitor),
    hash(
      await fs.readFile(path.join(root, "assets/game-performance-monitor.exe")),
    ),
  );
  assert.equal(performanceMonitor.toString("ascii", 0, 2), "MZ");
  const performancePe = performanceMonitor.readUInt32LE(0x3c);
  assert.equal(
    performanceMonitor.toString("ascii", performancePe, performancePe + 4),
    "PE\0\0",
  );
  assert.equal(
    performanceMonitor.readUInt16LE(performancePe + 4),
    0x8664,
    "Performance monitor must be x64",
  );
  assert.equal(
    hash(
      await fs.readFile(
        path.join(resourcesDirectory, "performance-monitor-source.cs"),
      ),
    ),
    hash(
      await fs.readFile(
        path.join(root, "scripts/native/game-performance-monitor.cs"),
      ),
    ),
  );
  const xzMetadata = JSON.parse(
    asar.extractFile(
      archive,
      path.normalize("electron/vendor/xz/metadata.json"),
    ),
  );
  const { limitMemory } = require("../electron/vendor/xz/memory-limit.cjs");
  const xzUpstream = asar.extractFile(
    archive,
    path.normalize(`electron/vendor/xz/${xzMetadata.upstream.file}`),
  );
  const xzBounded = asar.extractFile(
    archive,
    path.normalize(`electron/vendor/xz/${xzMetadata.bounded.file}`),
  );
  for (const [bytes, expected] of [
    [xzUpstream, xzMetadata.upstream],
    [xzBounded, xzMetadata.bounded],
  ]) {
    assert.equal(bytes.length, expected.bytes);
    assert.equal(hash(bytes), expected.sha256);
  }
  assert.deepEqual(limitMemory(xzUpstream), xzBounded);
  assert.deepEqual(
    WebAssembly.Module.imports(await WebAssembly.compile(xzBounded)),
    [],
  );
  assert.equal(xzMetadata.bounded.memoryMaximumBytes, 64 * 1024 ** 2);
  for (const file of await files(path.join(root, "licenses"))) {
    const relative = path.relative(path.join(root, "licenses"), file);
    assert.equal(
      hash(
        await fs.readFile(path.join(resourcesDirectory, "licenses", relative)),
      ),
      hash(await fs.readFile(file)),
      `Packaged third-party material differs: ${relative}`,
    );
  }
  assert.ok(
    !asar
      .listPackage(archive)
      .some((file) => /^[/\\](?:test-results|tests|scripts)[/\\]/.test(file)),
    "Test fixtures must not ship",
  );
  const artifact =
    process.argv[3] || `IRONCLAD-${manifest.version}-portable.exe`;
  const payload = await fs.readFile(path.join(releaseDir, artifact));
  assert.equal(payload.toString("ascii", 0, 2), "MZ");
  const pe = payload.readUInt32LE(0x3c);
  assert.equal(payload.toString("ascii", pe, pe + 4), "PE\0\0");
  const sums = [];
  for (const file of (await fs.readdir(releaseDir))
    .filter((file) => /^IRONCLAD-.+-portable\.exe$/.test(file))
    .sort())
    sums.push(
      `${hash(await fs.readFile(path.join(releaseDir, file)))}  ${file}`,
    );
  await fs.writeFile(
    path.join(releaseDir, "SHA256SUMS.txt"),
    sums.join("\n") + "\n",
  );
  const report = {
    version: manifest.version,
    checkedAt: new Date().toISOString(),
    artifact,
    bytes: payload.length,
    sha256: hash(payload),
    comparedSourceFiles: compared,
    gamePerformanceMonitor: {
      bytes: performanceMonitor.length,
      sha256: hash(performanceMonitor),
      architecture: "x64",
      sourceMatches: true,
      separatelyPackaged: true,
    },
    nativeSteamBinaries: "present, unpacked, match dependency; not initialized",
    workshopQueryBridge: {
      koffiVersion,
      runtimeAndNativeAddonMatch: true,
      separatelyUnpacked: true,
      systemNodeLoad: true,
      steamInitialized: false,
    },
    publicationDependencies:
      "yazl and sanitize-html match installed dependencies",
    openpgp: {
      version: libraryManifest.version,
      comparedRuntimeFiles: libraryFiles,
      entry: path.relative(resourcesDirectory, libraryEntry),
      separatelyUnpacked: true,
      systemNodeLoadAndPinnedRootParse: true,
      licenseAndSourceMaterialsMatch: true,
    },
    xz: {
      version: xzMetadata.version,
      upstreamSha256: hash(xzUpstream),
      boundedSha256: hash(xzBounded),
      memoryMaximumBytes: xzMetadata.bounded.memoryMaximumBytes,
      offlineTransformationMatches: true,
      packagedModuleCompilesWithoutImports: true,
      licenseAndSourceMaterialsMatch: true,
    },
    portableExecuted: false,
  };
  await fs.writeFile(
    path.resolve(
      root,
      process.argv[4] || "test-results/package-verification.json",
    ),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
}
verify().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
