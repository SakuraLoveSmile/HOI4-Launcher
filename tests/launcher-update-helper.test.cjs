"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execute = promisify(execFile);
const windowsTest = process.platform === "win32" ? test : test.skip;
const original = "Inert original fixture. Never execute.";
const replacement = "Inert replacement fixture. Never execute.";
const hash = (value) => createHash("sha256").update(value).digest("hex");

// A separate PowerShell scope shadows every process lookup and launch while
// dot-sourcing the production helper. Its real file moves and hashing operate
// only on the per-test temporary directory. No fixture EXE is ever executed.
const harness = String.raw`
param([string]$HelperPath, [string]$UpdateConfigPath, [string]$Mode, [string]$CallsPath)
$ErrorActionPreference = 'Stop'
$harnessMode = $Mode
$harnessCallsPath = $CallsPath
$script:harnessStarts = 0
function Get-Process {
  param([int]$Id, [string]$ErrorAction)
  if ($harnessMode -eq 'still-running') {
    $stub = [PSCustomObject]@{}
    $stub | Add-Member -MemberType ScriptMethod -Name WaitForExit -Value { param($timeout) return $false }
    return $stub
  }
  return $null
}
function Start-Process {
  param([string]$FilePath, [string]$WorkingDirectory, [string]$WindowStyle)
  $script:harnessStarts++
  $call = @{file=$FilePath;sha256=(Get-UpdateHash $FilePath);windowStyle=$WindowStyle}
  [IO.File]::AppendAllText($harnessCallsPath, ($call | ConvertTo-Json -Compress) + [Environment]::NewLine)
  if ($harnessMode -eq 'start-fail' -and $script:harnessStarts -eq 1) {
    throw 'Mock replacement start failed.'
  }
}
function Set-Content {
  [CmdletBinding()]
  param([Parameter(ValueFromPipeline=$true)][object]$Value, [string]$LiteralPath, [string]$Encoding)
  process {
    if ($harnessMode -eq 'log-fail') { throw 'Mock log write failed.' }
    [IO.File]::WriteAllText($LiteralPath, [string]$Value)
  }
}
. $HelperPath -ConfigPath $UpdateConfigPath
if ($LASTEXITCODE) { exit $LASTEXITCODE }
`;

async function runHelper(t, mode, patch = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ironclad-helper-"));
  t.after(() =>
    fs.rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    }),
  );
  const source = path.join(root, "new [launcher].exe");
  const target = path.join(root, "launcher's [original].exe");
  const backup = path.join(root, "original backup.exe");
  const log = path.join(root, "helper.log");
  const callsPath = path.join(root, "process-calls.jsonl");
  const configPath = path.join(root, "update config.json");
  const harnessPath = path.join(root, "isolated harness.ps1");
  await fs.writeFile(source, replacement);
  await fs.writeFile(target, original);
  await fs.writeFile(harnessPath, harness);
  await fs.writeFile(
    configPath,
    JSON.stringify({
      processId: 2147483647,
      source,
      target,
      backup,
      log,
      sha256: hash(replacement),
      originalSha256: hash(original),
      ...patch,
    }),
  );
  const powershell = path.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  let code = 0;
  try {
    await execute(
      powershell,
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        harnessPath,
        "-HelperPath",
        path.resolve(__dirname, "../electron/launcher-update-helper.ps1"),
        "-UpdateConfigPath",
        configPath,
        "-Mode",
        mode,
        "-CallsPath",
        callsPath,
      ],
      { windowsHide: true, timeout: 10000, maxBuffer: 128 * 1024 },
    );
  } catch (error) {
    if (typeof error.code !== "number") throw error;
    code = error.code;
  }
  const calls = (await fs.readFile(callsPath, "utf8").catch(() => ""))
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const read = (file) =>
    fs.readFile(file, "utf8").catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
  return { root, source, target, backup, log, code, calls, read };
}

windowsTest(
  "actual helper replaces the isolated target and keeps the original backup",
  async (t) => {
    const f = await runHelper(t, "success");
    assert.equal(f.code, 0, await f.read(f.log));
    assert.equal(await f.read(f.target), replacement, await f.read(f.log));
    assert.equal(await f.read(f.backup), original);
    assert.equal(await f.read(f.source), null);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].sha256.toLowerCase(), hash(replacement));
    assert.equal(f.calls[0].windowStyle, "Hidden");
  },
);
windowsTest(
  "actual helper restores the original and retains new bytes when replacement start fails",
  async (t) => {
    const f = await runHelper(t, "start-fail");
    assert.equal(f.code, 1);
    assert.equal(await f.read(f.target), original);
    assert.equal(await f.read(f.source), replacement);
    assert.equal(await f.read(f.backup), null);
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls[0].sha256.toLowerCase(), hash(replacement));
    assert.equal(f.calls[1].sha256.toLowerCase(), hash(original));
    assert.match(await f.read(f.log), /Mock replacement start failed/);
  },
);
windowsTest(
  "actual helper rejects changed update bytes and reopens the preserved original",
  async (t) => {
    const f = await runHelper(t, "success", { sha256: "a".repeat(64) });
    assert.equal(f.code, 1);
    assert.equal(await f.read(f.target), original);
    assert.equal(await f.read(f.source), replacement);
    assert.equal(await f.read(f.backup), null);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].sha256.toLowerCase(), hash(original));
    assert.match(await f.read(f.log), /Downloaded update changed/);
  },
);
windowsTest(
  "actual helper preserves an unrecognized original without launching it",
  async (t) => {
    const f = await runHelper(t, "success", { originalSha256: "a".repeat(64) });
    assert.equal(f.code, 1);
    assert.equal(await f.read(f.target), original);
    assert.equal(await f.read(f.source), replacement);
    assert.equal(await f.read(f.backup), null);
    assert.equal(f.calls.length, 0);
    assert.match(await f.read(f.log), /Original launcher changed/);
  },
);
windowsTest(
  "actual helper treats a successful update log failure as best effort",
  async (t) => {
    const f = await runHelper(t, "log-fail");
    assert.equal(f.code, 0);
    assert.equal(await f.read(f.target), replacement);
    assert.equal(await f.read(f.backup), original);
    assert.equal(await f.read(f.source), null);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].sha256.toLowerCase(), hash(replacement));
  },
);
windowsTest(
  "actual helper never replaces or restarts a launcher that has not exited",
  async (t) => {
    const f = await runHelper(t, "still-running");
    assert.equal(f.code, 1);
    assert.equal(await f.read(f.target), original);
    assert.equal(await f.read(f.source), replacement);
    assert.equal(await f.read(f.backup), null);
    assert.equal(f.calls.length, 0);
    assert.match(await f.read(f.log), /did not exit/);
  },
);
