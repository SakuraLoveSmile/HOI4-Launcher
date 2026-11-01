# Roadmap 1 shared implementation contract

Baseline: Windows Steam HOI4, installed Paradox Launcher v2 (confirmed by user).
This is a feature-parity goal; phase completion does not mean the whole roadmap is done.

This document records the initial implementation split. All assigned modules have now been handed back to the main agent. The current API and ownership boundary are documented in [CONTRACT.md](../CONTRACT.md); the current feature/verification status is in [ROADMAP.md](../ROADMAP.md).

## Ownership and integration

- Main: `electron/launcher-service.cjs`, `electron/main.cjs`, `electron/preload.cjs`,
  UI, build files, roadmap, integration tests. Owns settings migrations and launch transaction.
- Research agent: `docs/official-launcher-research.md` only. Reads official/local sources;
  does not mutate actual game, Steam, launcher, account, or saves.
- Game support agent: `electron/game-support.cjs`, `tests/game-support.test.cjs` only.
  Provides pure/file-read helpers and write plans; never performs a game-file write itself.

## game-support.cjs API

CommonJS exports, async unless specified:

- `readGameMetadata(gameDirectory)` -> `{ version, displayVersion, normalArgs: string[], debugArgs: string[] }`.
  Read launcher-settings.json; defaults must work for older fixtures without metadata.
  Restrict executable to hoi4.exe, keep args as arrays; no shell command execution.
- `resolveUserDirectory(gameDirectory, documentsPath)` -> absolute directory.
  Honor nonempty userdir.txt (relative paths against game directory); default Documents/Paradox Interactive/Hearts of Iron IV.
  Return actionable errors for invalid/control-character paths, never create directories during reads.
- `readGameOptions(gameDirectory, userData)` -> `{ layout: category[], values: object, sourcePaths: string[], warnings: string[] }`.
  Categories retain official `category`, `label`, `labelId`, `settings`.
  Each setting includes name, type, options/default/provider if available.
  Values are flat by setting name. Read installed layout, pdx_settings.txt and/or JSON,
  and relevant legacy settings.txt. Preserve source uncertainty as warnings.
- `planGameOptions(gameDirectory, userData, patch)` -> `{ writes: [{ path: absolute, content: string }], values: object }`.
  Validate patch against actual official layout and recognized dynamic SDL option types.
  Preserve unknown data/comments where practical; never rewrite unrelated gameplay preferences.
  The main service backs up, commits and rolls back these writes as part of launch.
- `readDlc(gameDirectory, userData)` -> `{ items: [{ id: string, name: string, path: string, installed: boolean, enabled: boolean, steamId: string|null, category: string }], disabledIds: string[], warnings: string[] }`.
  IDs are game-relative forward slash descriptor paths, matching disabled_dlcs entries.
  Installed files do not by themselves prove Steam ownership; do not claim entitlement.
- `readContinueGame(userData)` -> `{ available: boolean, title: string, description: string, date: string, filename: string, remote: boolean, reason: string }`.
  Validate local save existence; use actual continue_game.json schema. Never read the save body.
  Confirm the official launch argument mechanism from launcher evidence before asserting behavior.

## Service extensions (main)

Settings remain backward compatible with v0.1.0. Add `disabledDlcIds: null|string[]`
(null preserves current game state), `gameOptions: {}` (staged overrides), and
`launcherPreferences: { closeOnLaunch:false }` initially. Continue using ordered modIds.

State adds `dlc`, `gameOptions`, `continueGame`, `launchStatus` as implementation lands.
Game settings and DLC changes persist to this launcher's settings immediately, but apply
to game config only on explicit launch with exact backups and rollback on spawn failure.

All tests use isolated fixtures and injected processes. Actual player data remains read-only.
