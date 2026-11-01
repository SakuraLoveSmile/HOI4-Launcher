# Roadmap 2 implementation contract

Status: implemented in 0.23; final acceptance is recorded in roadmap-2.md. Scope is the agreed local Mod workspace,
upstream tracking, selective merge, history/backup and HOI4 assistance roadmap.
This does not mark Roadmap 1 complete.

## Project service (main-process only)

`createModProjectService({storageDirectory,getUserDataPath,isGameRunning?})`.
All methods async; writes serialize and refuse when the game is running.
Native-selected paths and source objects below never cross IPC unchecked.

- list() -> {projects: Project[], busy:boolean}; get(projectId) -> Project.
- create({name,sourcePath,upstreamRef:null|UpstreamRef,baselineKnown:boolean,
  descriptorText?,sourceModId?,checkSource?}) -> Project.
  Accept a directory or safe ZIP; copy into an independent local workspace.
- captureCandidate(projectId,{sourcePath,upstreamRef,descriptorText?,checkSource?}) -> Project.
- setUpstream(projectId,upstreamRef|null) -> Project; preserve existing baselines;
  replacing a different upstream must not imply shared ancestry.
- inspect(projectId) -> {project,changes:[{path,status}],digest,checks}.
- checkpoint(projectId,name) -> Project.
- restore(projectId,snapshotId) -> Project; retain a pre-restore checkpoint.
- prepareMerge(projectId) -> {id,projectId,entries,counts}; token binds the exact
  working tree, baseline and candidate. Entries use the merge module's structure.
- readMergeFile(projectId,planId,path) -> {path,status,baseText,localText,
  upstreamText,mergedText,binary,encoding,bom,chunks,baselineKnown}; bounded text only,
  never arbitrary paths. Chunks require known ancestry for that file; the displayed
  initial copy is explicitly labelled when ancestry is unknown.
- previewMerge(projectId,planId,decisions) -> {counts,checks,decisions}; analyze the
  actual selected result, including manual text, without changing the workspace.
- applyMerge(projectId,planId,decisions) -> Project. decisions is an array of
  {path,choice:'auto'|'upstream'|'local'|'defer'|'manual',text?}. Every changed
  upstream entry must have a decision. Manual content is bounded text.
- exportProject(projectId,destinationPath) -> {path}; importProject(sourcePath)
  -> Project. Backups include provenance, bases and named snapshots; import gives
  independent identity and registration, never overwrites an existing project.
- isBusy() -> boolean (sync).
- resolveVersion(projectId,snapshotId|null) -> launch source and descriptor; null
  resolves the editable workspace. Only playable base/checkpoint/before-operation
  snapshots can be pinned or restored; candidates and synthetic merge bases cannot.

Project: {id,name,modId,workPath,descriptorPath,userData,upstreamRef,originRef,originModId,
baselineKnown,baseSnapshotId,candidateSnapshotId,history,snapshots,createdAt,
updatedAt}. Snapshot entries: {id,name,kind,createdAt}; history records choices.
UpstreamRef: {provider:'workshop'|'pdx',remoteId,modId,revision?,updatedAt?}.
Untrusted display version/timestamps are not content identities.

Working copies use unique `ironclad_project_<uuid>.mod` registrations and
`local:ironclad_project_<uuid>.mod` identities. Strip remote_file_id, pops_id,
path/archive bindings from the copied inner descriptor, keep game semantics
(dependencies, replace_path, unknown fields), and use the project's own name.
Keep origin reference separately; do not inherit publishing history or targets.
Existing user-created mods retain their existing identities and behavior.

Snapshots are independent ordinary files, immutable after capture, validated by
bounded per-file SHA-256 manifests. No symlink/hardlink alias to upstream or work.
Detect source changes while copying. Reject unsafe paths, case collisions and
links. ZIP extraction is bounded and validates CRC/size. Preserve unrecognized
or externally changed recovery artifacts instead of deleting them.

Merge base advances per file: accepted and explicitly kept-local changes consume
that upstream file as a new comparison base; deferred entries retain their old
base. The resulting synthetic base is never advertised as a pristine upstream
revision. Restoring a checkpoint restores its matching base/decision context.
Unknown baselines allow import/edit/checkpoints and explicit choices. Reviewed
files retain knownBasePaths; all resolved files establish a future comparison
base without claiming that the initial import was a pristine original. Unreviewed
files never receive automatic three-way merging or selectable three-way chunks.

Apply/restore stage complete trees, recheck working bytes and game guard, keep
the prior tree, and journal workspace/metadata/registration transitions. Recovery
must produce a coherent previous or new version; ambiguous external edits block
destructive recovery. Snapshot/backup reads revalidate contents.

## Pure merge and checks

`createMergePlan({base,local,upstream,baselineKnown=true})` accepts plain objects
mapping relative paths to {sha256,bytes}. Returns {entries,counts}. Entries:
{path,status,localChanged,upstreamChanged,suggested}; statuses include unchanged,
local-only,upstream-only,same,conflict. suggested is auto/local/defer as appropriate.

`mergeTextBuffers({base,local,upstream,maxBytes?})` accepts Buffer|null (null means
absent). Returns {status:'merged'|'conflict'|'binary',buffer?,baseText?,localText?,
upstreamText?,mergedText?,encoding?}. Merge only compatible supported encodings;
retain BOM/newlines; handle additions/deletions; no conflict-marker writes.
Bound CPU/memory and treat unsupported/large binary contents as whole-file choice.

`createTextMergeChunks({base,local,upstream,maxBytes?})` returns
{status:'text'|'binary'|'unavailable',chunks,encoding,bom}. Ordered chunks contain
{id,changed,baseText,localText,upstreamText,mergedText?,conflict}; unchanged regions
remain present. UI chooses local/upstream per conflict, or auto for nonconflicts,
then explicitly composes an editable manual result. Missing files use whole-file
choices. `encodeMergeText(text,{encoding,bom})` preserves the local text format.

`analyzeProjectFiles(files)` accepts [{path,text}] (bounded UTF text supplied by
caller) and returns {issues:[{severity,code,path,message,relatedPaths?}],groups}.
Provide honest bounded HOI4 hints for event references/localisation, duplicate
IDs, descriptor dependencies/replace_path; never claim game validation.

## Upstream and desktop integration

`createModProjectUpstream` provides sourceForMod/check/start/getState/cancel/settled
and isBusy. The renderer supplies project IDs and an anonymous/account choice,
never filesystem or download URLs. Native dialogs resolve import/export paths.
The Steam SDK getItem read includes installation folder/timestamp in the main
process only. Candidate acquisition uses that actual App 394360 workshop folder,
even when a local descriptor with the same remote ID shadows it in library scans.
It checks completed download state and actor/source stability around capture.
Steam is connected only by the user's existing connection action.

Paradox candidates use the existing signed complete resolve/download pipeline;
they do not install or switch the original Mod. Account leases bind the transfer
and capture. An asserted pristine managed PDX source must match installationId,
revision, content path and current user directory and pass installer verification.
Successful unchanged temporary archives are removed using recorded identity and
hash evidence; uncertain or externally modified files are retained and displayed.
Candidate jobs are session-only; restart does not automatically resume a transfer.

`launcher.getSourceState()` is an internal unqueued scan that skips project overlay
and thumbnail refresh. Source guards and installer user-directory validation use
it to avoid re-entering the project queue. Normal launcher scans attach project
identity and pinned version metadata. The current workspace's descriptor is read
again for launch. Generated launch registrations are distinguished from persistent
project registrations; the legacy metadata editor cannot rewrite a project.

Pinning stores snapshotId in the existing local modReferences[].version. Original
and full fork cannot launch together; assigning a project to the current playset
disables its origin while retaining membership. Original provenance remains after
changing the tracked upstream. Native project backups include content/history;
official playset JSON is not a transport for local project files.

## Acceptance

Independent originals/forks; directory/ZIP import; source changes during capture;
upstream candidates without switching active versions; original deletion/offline
survival; unknown baseline; publish ID separation; text and binary merges;
delete/edit, same-path additions and Windows casing; partial/deferred merge
followed by another upstream version; external edit invalidates plan; interrupted
apply/restore recovery; history and native backup roundtrip; frozen playset
versions; original+full-fork duplicate load protection; safe IPC; meaningful
isolated backend/UI regression and build/package verification.
