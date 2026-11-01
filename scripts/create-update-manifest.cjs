"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { createReadStream } = require("node:fs");
const { createHash } = require("node:crypto");

async function createUpdateManifest({
  version,
  directory = path.resolve(__dirname, "../release"),
}) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version))
    throw new Error("Update releases require a stable x.y.z version.");
  const asset = `IRONCLAD-${version}-portable.exe`;
  const file = path.join(directory, asset);
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || !stat.size)
    throw new Error("Portable release asset is missing or invalid.");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  const after = await fs.lstat(file);
  if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs)
    throw new Error("Portable asset changed while hashing.");
  const manifest = {
    schema: 1,
    version,
    asset,
    size: stat.size,
    sha256: hash.digest("hex"),
  };
  await fs.writeFile(
    path.join(directory, "updater.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  return manifest;
}
module.exports = { createUpdateManifest };
if (require.main === module) {
  createUpdateManifest({ version: require("../package.json").version })
    .then((manifest) =>
      console.log(`Created updater.json for ${manifest.asset}`),
    )
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
