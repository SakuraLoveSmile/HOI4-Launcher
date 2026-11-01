import electron from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
const root = await fs.mkdtemp(
  path.join(os.tmpdir(), "ironclad-workflows-desktop-"),
);
try {
  const child = spawn(electron, ["scripts/test-workflows-desktop.cjs", root], {
    cwd: path.resolve("."),
    windowsHide: true,
    stdio: "inherit",
  });
  const [code] = await once(child, "exit");
  process.exitCode = code || 0;
} finally {
  if (
    path.dirname(root) !== os.tmpdir() ||
    !path.basename(root).startsWith("ironclad-workflows-desktop-")
  )
    throw new Error("Unexpected fixture root");
  await fs.rm(root, {
    recursive: true,
    force: true,
    maxRetries: 8,
    retryDelay: 75,
  });
}
