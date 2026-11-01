param([Parameter(Mandatory = $true)][string]$ConfigPath)
$ErrorActionPreference = 'Stop'
$updateConfig = $null
$backupCreated = $false
$replacementCreated = $false
$launcherExited = $false
function Write-UpdateLog([string]$Message) {
  try {
    if ($updateConfig -and $updateConfig.log) {
      $Message | Set-Content -LiteralPath $updateConfig.log -Encoding UTF8
    }
  } catch { }
}
function Assert-OrdinaryFile([string]$FilePath) {
  $entry = Get-Item -LiteralPath $FilePath -Force
  if ($entry.PSIsContainer -or ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'Update paths must be ordinary files.'
  }
}
function Get-UpdateHash([string]$FilePath) {
  # Use .NET directly: a helper launched from PowerShell 7 can inherit a
  # PSModulePath that omits Windows PowerShell's Get-FileHash module.
  $hashStream = $null
  $hashAlgorithm = $null
  try {
    $hashStream = [IO.File]::Open($FilePath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    $hashAlgorithm = [Security.Cryptography.SHA256]::Create()
    return [BitConverter]::ToString($hashAlgorithm.ComputeHash($hashStream)).Replace('-', '').ToLowerInvariant()
  } finally {
    if ($hashAlgorithm) { $hashAlgorithm.Dispose() }
    if ($hashStream) { $hashStream.Dispose() }
  }
}
try {
  $updateConfig = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $launcherProcess = Get-Process -Id $updateConfig.processId -ErrorAction SilentlyContinue
  if ($launcherProcess -and -not $launcherProcess.WaitForExit(120000)) {
    throw 'Launcher did not exit within two minutes. Restart it and retry the update.'
  }
  $launcherExited = $true
  Assert-OrdinaryFile $updateConfig.source
  Assert-OrdinaryFile $updateConfig.target
  if ((Get-UpdateHash $updateConfig.source) -ne $updateConfig.sha256) {
    throw 'Downloaded update changed. The original executable was preserved.'
  }
  if ((Get-UpdateHash $updateConfig.target) -ne $updateConfig.originalSha256) {
    throw 'Original launcher changed. Replacement was cancelled.'
  }
  if (Test-Path -LiteralPath $updateConfig.backup) { throw 'Update backup already exists.' }
  # The outer portable wrapper may release its executable shortly after the
  # Electron process exits. Retry only the move, before any replacement occurs.
  for ($moveAttempt = 0; $moveAttempt -lt 40; $moveAttempt++) {
    try { [IO.File]::Move($updateConfig.target, $updateConfig.backup); break }
    catch {
      if ($moveAttempt -eq 39) { throw }
      Start-Sleep -Milliseconds 250
    }
  }
  $backupCreated = $true
  [IO.File]::Move($updateConfig.source, $updateConfig.target)
  $replacementCreated = $true
  Start-Process -FilePath $updateConfig.target -WorkingDirectory ([IO.Path]::GetDirectoryName($updateConfig.target)) -WindowStyle Hidden
  # Logging cannot roll back an already-started replacement.
  Write-UpdateLog ('Update installed. The previous executable remains at: ' + $updateConfig.backup)
} catch {
  $failureMessage = $_.Exception.Message
  try {
    if ($backupCreated) {
      if ($replacementCreated -and (Test-Path -LiteralPath $updateConfig.target)) {
        # Retain failed replacement for diagnosis; never delete unknown files.
        [IO.File]::Move($updateConfig.target, $updateConfig.source)
      }
      if (-not (Test-Path -LiteralPath $updateConfig.target)) {
        [IO.File]::Move($updateConfig.backup, $updateConfig.target)
        Start-Process -FilePath $updateConfig.target -WorkingDirectory ([IO.Path]::GetDirectoryName($updateConfig.target)) -WindowStyle Hidden
      }
    } elseif ($launcherExited -and (Test-Path -LiteralPath $updateConfig.target)) {
      # A wrapper/file lock may prevent the first move. Reopen the preserved
      # original only after its owning launcher exited, avoiding duplicates.
      Assert-OrdinaryFile $updateConfig.target
      if ((Get-UpdateHash $updateConfig.target) -eq $updateConfig.originalSha256) {
        Start-Process -FilePath $updateConfig.target -WorkingDirectory ([IO.Path]::GetDirectoryName($updateConfig.target)) -WindowStyle Hidden
      }
    }
  } catch { $failureMessage += ' Rollback failed: ' + $_.Exception.Message }
  Write-UpdateLog $failureMessage
  exit 1
}
