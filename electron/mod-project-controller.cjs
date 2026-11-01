"use strict";

// Small desktop boundary: renderer supplies known IDs and choices; only native
// dialogs or the source resolver can introduce filesystem paths.
function createModProjectController({
  projects,
  upstream,
  launcher,
  chooseOpen,
  chooseSave,
  openPath,
  runMutation = (fn) => fn(),
  verifyOriginal = async () => {},
}) {
  const object = (v) =>
    v !== null && typeof v === "object" && !Array.isArray(v);
  const fields = (v, keys) => {
    if (!object(v) || Object.keys(v).some((key) => !keys.includes(key)))
      throw new Error("项目操作参数无效。");
  };
  return {
    getModProjects: () => projects.list(),
    inspectModProject: (id) => projects.inspect(id),
    createModProject: (input) =>
      runMutation(async () => {
        fields(input, ["modId", "name", "baselineKnown"]);
        if (typeof input.baselineKnown !== "boolean")
          throw new Error("请明确原版基线状态。");
        const source = await upstream.sourceForMod(input.modId, {
          requireStable: input.baselineKnown,
        });
        if (input.baselineKnown) {
          const checkSource = source.checkSource;
          source.checkSource = async () => {
            await checkSource?.();
            await verifyOriginal(input.modId, source);
          };
        }
        return projects.create({
          ...source,
          name: input.name,
          baselineKnown: input.baselineKnown,
        });
      }),
    importModProject: (input) =>
      runMutation(async () => {
        fields(input, ["kind", "name", "baselineKnown"]);
        if (!["folder", "zip", "backup"].includes(input.kind))
          throw new Error("项目导入类型无效。");
        const sourcePath = await chooseOpen(input.kind);
        if (!sourcePath) return null;
        if (input.kind === "backup") return projects.importProject(sourcePath);
        if (typeof input.baselineKnown !== "boolean")
          throw new Error("请明确原版基线状态。");
        return projects.create({
          name: input.name,
          sourcePath,
          upstreamRef: null,
          baselineKnown: input.baselineKnown,
        });
      }),
    linkModProject: (id, modId) =>
      runMutation(async () => {
        if (modId === null) return projects.setUpstream(id, null);
        const source = await upstream.sourceForMod(modId);
        if (!source.upstreamRef)
          throw new Error("请选择 Steam 或 Paradox 来源模组。");
        return projects.setUpstream(id, source.upstreamRef);
      }),
    importModProjectCandidate: (id) =>
      runMutation(async () => {
        const project = await projects.get(id);
        const sourcePath = await chooseOpen("candidate");
        if (!sourcePath) return null;
        return projects.captureCandidate(id, {
          sourcePath,
          upstreamRef: project.upstreamRef,
        });
      }),
    checkpointModProject: (id, name) =>
      runMutation(() => projects.checkpoint(id, name)),
    restoreModProject: (id, snapshotId) =>
      runMutation(() => projects.restore(id, snapshotId)),
    prepareModProjectMerge: (id) =>
      runMutation(() => projects.prepareMerge(id)),
    previewModProjectMerge: (id, planId, decisions) =>
      runMutation(() => projects.previewMerge(id, planId, decisions)),
    readModProjectMergeFile: (id, planId, file) =>
      projects.readMergeFile(id, planId, file),
    applyModProjectMerge: (id, planId, decisions) =>
      runMutation(() => projects.applyMerge(id, planId, decisions)),
    exportModProject: (id) =>
      runMutation(async () => {
        await projects.get(id);
        const destination = await chooseSave();
        return destination ? projects.exportProject(id, destination) : null;
      }),
    openModProject: async (id) => {
      const project = await projects.get(id);
      const error = await openPath(project.workPath);
      if (error) throw new Error(error);
      return true;
    },
    pinModProject: (id, snapshotId) =>
      runMutation(async () => {
        const project = await projects.get(id);
        if (snapshotId !== null) await projects.resolveVersion(id, snapshotId);
        const state = await launcher.getState();
        if (
          require("node:path").resolve(project.userData).toLowerCase() !==
          require("node:path").resolve(state.paths.userData).toLowerCase()
        )
          throw new Error("项目属于其他游戏用户目录，请切回原目录后操作。");
        const active = state.settings.playsets.find(
          (item) => item.id === state.settings.activePlaysetId,
        );
        const modOrder = [
          ...new Set([...(active.modOrder || active.modIds), project.modId]),
        ];
        const modIds = modOrder.filter(
          (key) =>
            key === project.modId ||
            (active.modIds.includes(key) &&
              key !== project.upstreamRef?.modId &&
              key !== project.originRef?.modId &&
              key !== project.originModId),
        );
        const modReferences = (active.modReferences || []).filter(
          (ref) => ref.id !== project.modId,
        );
        modReferences.push({
          id: project.modId,
          name: project.name,
          source: "local",
          remoteId: null,
          ...(snapshotId === null ? {} : { version: snapshotId }),
        });
        await launcher.saveSettings({
          playsets: state.settings.playsets.map((item) =>
            item.id === active.id
              ? { ...item, modOrder, modIds, modReferences }
              : item,
          ),
        });
        return launcher.getState();
      }),
    checkModProjectUpstream: (id, authorization) =>
      upstream.check(id, authorization),
    fetchModProjectUpstream: (id, options) => {
      if (options !== undefined) fields(options, ["authorization"]);
      return upstream.start(id, options);
    },
    getModProjectUpstream: () => upstream.getState(),
    cancelModProjectUpstream: () => upstream.cancel(),
  };
}
module.exports = { createModProjectController };
