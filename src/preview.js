const mods = [
  {
    id: "demo-road",
    name: "The Road to 56",
    tags: ["扩展内容", "架空历史"],
    supportedVersion: "1.17.*",
    source: "workshop",
  },
  {
    id: "demo-kaiser",
    name: "Kaiserreich",
    tags: ["架空历史", "全面转化"],
    supportedVersion: "1.17.*",
    source: "workshop",
  },
  {
    id: "demo-state",
    name: "State Transfer Tool",
    tags: ["实用工具"],
    supportedVersion: "1.17.*",
    source: "workshop",
  },
  {
    id: "demo-color",
    name: "Coloured Buttons",
    tags: ["界面"],
    supportedVersion: "1.16.*",
    source: "workshop",
  },
  {
    id: "demo-music",
    name: "My Radio Collection",
    tags: ["音乐"],
    supportedVersion: "",
    source: "local",
  },
].map((mod, index) => ({
  ...mod,
  available: true,
  canEdit: mod.source === "local",
  descriptorPath: "",
  contentPath: "",
  remoteId: mod.source === "workshop" ? String(10000 + index) : null,
  dependencies: [],
  missingDependencies: [],
  compatibility: mod.supportedVersion === "1.16.*" ? "different" : "compatible",
}));

const defaults = {
  schemaVersion: 3,
  activeGameInstanceId: "default",
  gameDirectory: "D:\\SteamLibrary\\steamapps\\common\\Hearts of Iron IV",
  launchMode: "normal",
  activePlaysetId: "default",
  gameOptions: {},
  modDisplayNames: {},
  disabledDlcIds: null,
  launcherPreferences: { closeOnLaunch: false, language: "zh-hans" },
  playsets: [
    {
      id: "default",
      name: "我的 1936",
      modIds: ["demo-road", "demo-state", "demo-color"],
    },
    { id: "vanilla", name: "原版战役", modIds: [] },
  ],
};

const dlcItems = [
  {
    id: "dlc/no_step_back.dlc",
    name: "No Step Back",
    category: "expansion",
    installed: true,
    enabled: true,
  },
  {
    id: "dlc/by_blood_alone.dlc",
    name: "By Blood Alone",
    category: "expansion",
    installed: true,
    enabled: true,
  },
  {
    id: "dlc/sabaton.dlc",
    name: "Sabaton Soundtrack",
    category: "music",
    installed: true,
    enabled: true,
  },
];
const optionLayout = [
  {
    category: "Graphics",
    settings: [
      {
        name: "display_mode",
        type: "radio",
        label: "显示模式",
        options: [
          { value: "fullscreen", label: "全屏" },
          { value: "borderless_fullscreen", label: "无边框全屏" },
          { value: "windowed", label: "窗口" },
        ],
      },
      { name: "display_index", type: "select", label: "显示器" },
      { name: "vsync", type: "toggle", label: "垂直同步" },
      { name: "fullscreen_resolution", type: "select", label: "全屏分辨率" },
      { name: "windowed_resolution", type: "select", label: "窗口分辨率" },
      { name: "refreshRate", type: "select", label: "刷新率" },
      {
        name: "renderer",
        type: "radio",
        label: "渲染器",
        options: [
          { value: "dx11", label: "DirectX 11" },
          { value: "dx9_compat", label: "DirectX 9" },
          { value: "opengl", label: "OpenGL" },
        ],
      },
    ],
  },
  {
    category: "System",
    settings: [
      {
        name: "language",
        type: "select",
        label: "游戏语言",
        options: [
          { value: "l_english", label: "English" },
          { value: "l_simp_chinese", label: "中文" },
        ],
      },
    ],
  },
];
const optionValues = {
  display_mode: "borderless_fullscreen",
  display_index: "0",
  vsync: true,
  fullscreen_resolution: "1920x1080",
  windowed_resolution: "1920x1080",
  refreshRate: "60",
  renderer: "dx11",
  language: "l_simp_chinese",
};

const instanceKeys = [
  "gameDirectory",
  "launchMode",
  "playsets",
  "activePlaysetId",
  "disabledDlcIds",
  "gameOptions",
  "modDisplayNames",
];
const instanceValues = (settings) =>
  Object.fromEntries(
    instanceKeys.map((key) => [key, structuredClone(settings[key])]),
  );

function normalize(settings) {
  const normalized = {
    ...defaults,
    ...settings,
    modDisplayNames: settings.modDisplayNames || {},
    playsets: settings.playsets.map((item) => {
      const modOrder = [
        ...new Set([...(item.modOrder || item.modIds), ...item.modIds]),
      ];
      return {
        ...item,
        modOrder,
        modIds: modOrder.filter((id) => item.modIds.includes(id)),
        disabledDlcIds: item.disabledDlcIds ?? null,
        modReferences: item.modReferences || [],
        unmappedDlcIds: item.unmappedDlcIds || [],
      };
    }),
  };
  const instances = settings.gameInstances?.length
    ? settings.gameInstances
    : [{ id: "default", name: "默认版本", isolated: false }];
  normalized.schemaVersion = 3;
  normalized.activeGameInstanceId = settings.activeGameInstanceId || "default";
  normalized.gameInstances = instances.map((instance) =>
    instance.id === normalized.activeGameInstanceId
      ? { ...instance, ...instanceValues(normalized) }
      : structuredClone(instance),
  );
  return normalized;
}

export function createPreviewApi() {
  let settings = normalize(structuredClone(defaults));
  let performanceEnabled = true;
  try {
    performanceEnabled =
      localStorage.getItem("ironclad-preview-performance") !== "disabled";
  } catch {}
  const performanceSamples = Array.from({ length: 241 }, (_, index) => ({
    elapsedMs: index * 30000,
    cpuPercent:
      index === 0 ? null : 9 + index / 60 + 4 * Math.sin(index / 12) ** 2,
    memoryBytes: Math.round(
      (2.6 + index / 160 + 0.15 * Math.sin(index / 15)) * 1024 ** 3,
    ),
    privateMemoryBytes: Math.round(
      (3.5 + index / 130 + 0.2 * Math.sin(index / 16)) * 1024 ** 3,
    ),
  }));
  const performanceSession = {
    id: "preview-session",
    status: "completed",
    startedAt: "2026-10-29T10:20:00.000Z",
    endedAt: "2026-10-29T12:20:00.000Z",
    lastSampleAt: "2026-10-29T12:20:00.000Z",
    durationMs: 7200000,
    sampleCount: 1441,
    cpuAveragePercent: 13.2,
    cpuPeakPercent: 16.9,
    memoryAverageBytes: 3.35 * 1024 ** 3,
    memoryPeakBytes: Math.max(
      ...performanceSamples.map((point) => point.memoryBytes),
    ),
    privateMemoryAverageBytes: 4.4 * 1024 ** 3,
    privateMemoryPeakBytes: Math.max(
      ...performanceSamples.map((point) => point.privateMemoryBytes),
    ),
    gameVersion: "1.19.4.0",
    instanceId: "default",
    instanceName: "默认版本",
    playsetId: "default",
    playsetName: "示例战役 · 1939",
    modCount: 12,
    logicalCpuCount: 16,
    trendDownsampled: true,
    samplingGapCount: 0,
    samples: performanceSamples,
  };
  const performanceState = () => ({
    enabled: performanceEnabled,
    supported: true,
    intervalMs: 5000,
    notice: null,
    sessions: [{ ...performanceSession, samples: undefined }],
  });
  let removedMods = [];
  try {
    const saved = JSON.parse(localStorage.getItem("ironclad-preview"));
    if (
      saved?.playsets?.length &&
      saved.playsets.some((p) => p.id === saved.activePlaysetId)
    )
      settings = normalize(saved);
  } catch {
    /* The browser preview can always fall back to its sample data. */
  }
  try {
    const saved = JSON.parse(
      localStorage.getItem("ironclad-preview-mod-library"),
    );
    if (saved && typeof saved === "object") {
      if (Array.isArray(saved.removedMods)) removedMods = saved.removedMods;
    }
  } catch {
    /* These are browser-only sample aliases and simulated deletions. */
  }
  const saveLibrary = () => {
    try {
      localStorage.setItem(
        "ironclad-preview-mod-library",
        JSON.stringify({ removedMods }),
      );
    } catch {}
  };
  const previewMod = (id) => {
    const mod = mods.find((item) => item.id === id);
    if (!mod) throw new Error("未找到此模组，请刷新后重试。");
    return mod;
  };
  const getState = async () => ({
    settings: structuredClone(settings),
    mods: mods
      .filter(
        (mod) =>
          settings.activeGameInstanceId === "default" ||
          mod.source === "workshop",
      )
      .filter(
        (mod) =>
          !removedMods.includes(mod.id) ||
          settings.playsets.some((playset) =>
            (playset.modOrder || playset.modIds).includes(mod.id),
          ),
      )
      .map((mod) => ({
        ...mod,
        originalName: mod.name,
        name: settings.modDisplayNames[mod.id]?.name || mod.name,
        displayNameKind: settings.modDisplayNames[mod.id]?.kind || null,
        available: !removedMods.includes(mod.id),
        canDeleteLocal: mod.source === "local" && !removedMods.includes(mod.id),
        canDelete: mod.source !== "local" || !removedMods.includes(mod.id),
      })),
    game: {
      found: true,
      directory: settings.gameDirectory,
      executable: "",
      version: "1.17.1",
    },
    paths: {
      userData:
        settings.activeGameInstanceId === "default"
          ? "示例文档目录 / Hearts of Iron IV"
          : "示例独立目录 / " + settings.activeGameInstanceId + "/user-data",
      settings: "浏览器预览本地存储",
    },
    warnings: [],
    launchStatus: { running: false, pid: null, lastExitCode: null },
    launchBlockedReason: "",
    continueGame: {
      available: settings.activeGameInstanceId === "default",
      title: "示例战役 · 1939",
      filename: "demo.hoi4",
      remote: false,
      reason:
        settings.activeGameInstanceId === "default" ? "" : "没有可继续的存档。",
    },
    dlc: { items: dlcItems, disabledIds: [], warnings: [] },
    gameOptions: {
      layout: optionLayout,
      values: { ...optionValues, ...settings.gameOptions },
      persistedValues: optionValues,
      pending: settings.gameOptions,
      warnings: [],
    },
  });
  const saveSettings = async (patch) => {
    settings = normalize({ ...settings, ...patch });
    try {
      localStorage.setItem("ironclad-preview", JSON.stringify(settings));
    } catch {}
    return structuredClone(settings);
  };
  return {
    getState,
    scanModCoverage: async () => {
      throw new Error("请在桌面启动器中检查实际 Mod 文件。");
    },
    getModCoverageProgress: async () => ({
      busy: false,
      canCancel: false,
      index: 0,
      total: 0,
    }),
    cancelModCoverage: async () => false,
    getPlaysetSnapshots: async () => ({
      snapshots: [],
      notices: [],
      retainedDirectories: [],
    }),
    getPlaysetSnapshotProgress: async () => ({
      busy: false,
      canCancel: false,
      progress: null,
    }),
    createPlaysetSnapshot: async () => {
      throw new Error("请在桌面启动器中保存实际 Mod 文件。");
    },
    getCampaigns: async () => ({ campaigns: [], notices: [] }),
    reviewContinueCampaign: async () => null,
    bindCampaign: async () => {
      throw new Error("请在桌面启动器中选择和绑定本地存档。");
    },
    getCampaignProgress: async () => ({ busy: false, progress: null }),
    cancelCampaignCheck: async () => true,
    getGamePerformance: async () => structuredClone(performanceState()),
    getGamePerformanceSession: async (id) =>
      id === performanceSession.id ? structuredClone(performanceSession) : null,
    setGamePerformanceNotes: async (id, notes) => {
      if (id !== performanceSession.id)
        throw new Error("统计记录不存在或无法读取。");
      performanceSession.notes = String(notes).slice(0, 4000);
      return structuredClone(performanceSession);
    },
    compareGamePerformance: async (beforeId, afterId) => ({
      beforeId,
      afterId,
      available: false,
      changes: [],
      notice: "此统计记录未保存完整启动配置，无法比较配置。",
    }),
    setGamePerformanceEnabled: async (enabled) => {
      performanceEnabled = enabled === true;
      try {
        localStorage.setItem(
          "ironclad-preview-performance",
          enabled ? "enabled" : "disabled",
        );
      } catch {}
      return structuredClone(performanceState());
    },
    setModDisplayName: async ({ modId, name, kind }) => {
      previewMod(modId);
      if (
        typeof name !== "string" ||
        !name.trim() ||
        name.trim().length > 128 ||
        /[\0-\x1f]/.test(name) ||
        !["custom", "translated"].includes(kind)
      )
        throw new Error("模组显示名称须为 1 至 128 个字符。");
      await saveSettings({
        modDisplayNames: {
          ...settings.modDisplayNames,
          [modId]: { name: name.trim(), kind },
        },
      });
      return getState();
    },
    resetModDisplayName: async (modId) => {
      previewMod(modId);
      const names = { ...settings.modDisplayNames };
      delete names[modId];
      await saveSettings({ modDisplayNames: names });
      return getState();
    },
    getLocalizedModName: async (modId) => {
      previewMod(modId);
      return { name: null };
    },
    updateMod: async (modId) => {
      const mod = previewMod(modId);
      if (mod.source === "local")
        throw new Error("本地模组没有可请求的在线更新。");
      removedMods = removedMods.filter((id) => id !== modId);
      saveLibrary();
      return { state: await getState() };
    },
    deleteMod: async (modId) => {
      previewMod(modId);
      removedMods = [...new Set([...removedMods, modId])];
      await saveSettings({
        playsets: settings.playsets.map((playset) => ({
          ...playset,
          modIds: playset.modIds.filter((id) => id !== modId),
          modOrder: playset.modOrder.filter((id) => id !== modId),
          modReferences: playset.modReferences.filter(
            (reference) => reference.id !== modId,
          ),
        })),
      });
      saveLibrary();
      return { state: await getState() };
    },
    copyText: async (text) => {
      if (globalThis.navigator?.clipboard?.writeText)
        await navigator.clipboard.writeText(text);
      return true;
    },
    openModFolder: async (modId) => {
      previewMod(modId);
      return true;
    },
    openModPage: async (modId) => {
      previewMod(modId);
      return true;
    },
    createGameInstance: async ({ name }) => {
      if (typeof name !== "string" || !name.trim() || name.trim().length > 128)
        throw new Error("版本实例名称须为 1 至 128 个字符。");
      if (settings.gameInstances.length >= 50)
        throw new Error("请保留 1 至 50 个版本实例。");
      const id = crypto.randomUUID();
      const next = {
        id,
        name: name.trim(),
        isolated: true,
        gameDirectory: "示例安装目录 / " + id,
        launchMode: "normal",
        playsets: [{ id: "default", name: "默认预设", modIds: [] }],
        activePlaysetId: "default",
        disabledDlcIds: null,
        gameOptions: {},
        modDisplayNames: {},
      };
      await saveSettings({
        ...instanceValues(next),
        activeGameInstanceId: id,
        gameInstances: [...settings.gameInstances, next],
      });
      return getState();
    },
    switchGameInstance: async (id) => {
      const next = settings.gameInstances.find(
        (instance) => instance.id === id,
      );
      if (!next) throw new Error("当前版本实例不存在。");
      await saveSettings({ ...instanceValues(next), activeGameInstanceId: id });
      return getState();
    },
    renameGameInstance: async ({ id, name }) => {
      if (typeof name !== "string" || !name.trim() || name.trim().length > 128)
        throw new Error("版本实例名称须为 1 至 128 个字符。");
      if (!settings.gameInstances.some((instance) => instance.id === id))
        throw new Error("当前版本实例不存在。");
      await saveSettings({
        gameInstances: settings.gameInstances.map((instance) =>
          instance.id === id ? { ...instance, name: name.trim() } : instance,
        ),
      });
      return getState();
    },
    removeGameInstance: async (id) => {
      if (id === "default") throw new Error("默认版本实例不能移除。");
      if (!settings.gameInstances.some((instance) => instance.id === id))
        throw new Error("当前版本实例不存在。");
      const next = settings.gameInstances.find(
        (instance) => instance.id === "default",
      );
      await saveSettings({
        ...(settings.activeGameInstanceId === id
          ? { ...instanceValues(next), activeGameInstanceId: "default" }
          : {}),
        gameInstances: settings.gameInstances.filter(
          (instance) => instance.id !== id,
        ),
      });
      return getState();
    },
    getNews: async () => ({
      items: [],
      source: "unavailable",
      error: "界面预览不请求在线新闻；桌面版会读取真实 HOI4 官方公告。",
      fetchedAt: null,
    }),
    openLink: async () => {
      throw new Error("请在桌面版中打开外部链接。");
    },
    exportDiagnostics: async () => {
      throw new Error("请在桌面版中导出诊断文件。");
    },
    getCachePlan: async () => ({
      targets: [
        {
          id: "shadercache",
          label: "着色器缓存",
          path: "示例路径",
          exists: true,
          containsUserContent: false,
          selectedByDefault: true,
        },
        {
          id: "mod",
          label: "模组描述文件",
          path: "示例路径",
          exists: true,
          containsUserContent: true,
          selectedByDefault: false,
        },
      ],
      warnings: ["这是界面预览，不会修改任何游戏文件。"],
    }),
    listCacheBackups: async () => [],
    clearCache: async () => {
      throw new Error("请在桌面版中管理游戏缓存。");
    },
    restoreCacheBackup: async () => {
      throw new Error("请在桌面版中恢复游戏缓存。");
    },
    detectGame: getState,
    getPdxDownloads: async () => ({
      job: null,
      installations: [],
      bytesPerSecond: 0,
    }),
    getPdxStorageState: async () => ({
      storage: {
        location: "界面预览 · 默认模组目录",
        isDefault: true,
        retainedLegacyPaths: [],
      },
      job: null,
      busy: false,
      recoveryRequired: false,
      error: null,
    }),
    preparePdxRelocation: async () => {
      throw new Error("请在桌面版中选择和迁移模组目录。");
    },
    commitPdxRelocation: async () => {
      throw new Error("界面预览不能迁移模组目录。");
    },
    discardPdxRelocation: async () => true,
    cancelPdxRelocation: async () => null,
    recoverPdxStorage: async () => {
      throw new Error("请在桌面版中恢复模组目录。");
    },
    downloadPdxMod: async () => {
      throw new Error("界面预览不能下载模组，请使用桌面版。");
    },
    repairPdxMod: async () => {
      throw new Error("界面预览不能修复模组，请使用桌面版。");
    },
    cancelPdxDownload: async () => null,
    pausePdxDownload: async () => {
      throw new Error("请在桌面版中暂停下载。");
    },
    resumePdxDownload: async () => {
      throw new Error("请在桌面版中继续下载。");
    },
    setPdxDownloadLimit: async () => {
      throw new Error("请在桌面版中设置下载限速。");
    },
    uninstallPdxMod: async () => {
      throw new Error("界面预览不能卸载模组。");
    },
    getPdxSubscriptions: async () => ({ accountId: null, items: [] }),
    getModThumbnail: async () => null,
    getSteamMissingMods: async () => ({ job: null, plan: null }),
    prepareSteamMissingMods: async () => {
      throw new Error("请在桌面版中连接 Steam 后处理缺失模组。");
    },
    commitSteamMissingMods: async () => {
      throw new Error("界面预览不能修改 Steam 订阅或请求下载。");
    },
    cancelSteamMissingMods: async () => null,
    subscribePdxMod: async () => {
      throw new Error("界面预览不能修改账号订阅。");
    },
    unsubscribePdxMod: async () => {
      throw new Error("界面预览不能修改账号订阅。");
    },
    getPublishDraft: async (id) => {
      const mod = mods.find((item) => item.id === id);
      return {
        metadata: { ...mod, description: "这是界面预览，不会发布任何内容。" },
        existingItemId: null,
        lastJob: null,
      };
    },
    cancelPublishPreparation: async () => true,
    preparePublish: async () => {
      throw new Error("请在桌面版中准备发布内容。");
    },
    commitPublish: async () => {
      throw new Error("界面预览不能发布模组。");
    },
    getPublishStatus: async () => null,
    getPdxPublishDraft: async (id) => ({
      metadata: {
        ...mods.find((item) => item.id === id),
        description: "这是界面预览，不会发布任何内容。",
      },
      existingItemId: null,
      lastJob: null,
    }),
    preparePdxPublish: async () => {
      throw new Error("请在桌面版中准备 Paradox 发布。");
    },
    commitPdxPublish: async () => {
      throw new Error("界面预览不能发布模组。");
    },
    cancelPdxPublishPreparation: async () => true,
    getPdxPublishStatus: async () => null,
    refreshPdxPublish: async () => null,
    getSteamState: async () => ({ connected: false, account: null, items: [] }),
    connectSteam: async () => {
      throw new Error("当前为界面预览，请在桌面版中连接 Steam。");
    },
    disconnectSteam: async () => ({
      connected: false,
      account: null,
      items: [],
    }),
    getAccount: async () => ({
      status: "signed-out",
      account: null,
      remembered: false,
      canRemember: false,
      notice: "界面预览不连接账户服务。",
    }),
    login: async () => {
      throw new Error("请在桌面版中登录 Paradox 账户。");
    },
    logout: async () => ({
      status: "signed-out",
      account: null,
      remembered: false,
      canRemember: false,
      notice: null,
    }),
    cancelLogin: async () => true,
    searchModCatalog: async () => ({
      items: [],
      page: 0,
      pageSize: 12,
      totalCount: 0,
      totalPages: 0,
      source: "unavailable",
      fetchedAt: null,
      error: "当前为界面预览；桌面版可浏览真实 Paradox 模组。",
    }),
    createLocalMod: async () => {
      throw new Error("当前为界面预览，请在桌面版中创建本地模组。");
    },
    getLocalModMetadata: async () => {
      throw new Error("请在桌面版中读取本地模组资料。");
    },
    updateLocalModMetadata: async () => {
      throw new Error("请在桌面版中编辑本地模组资料。");
    },
    saveSettings,
    getLaunchStatus: async () => ({ running: false, pid: null }),
    getDisplays: async () => [
      {
        index: 0,
        name: "示例显示器",
        primary: true,
        currentResolution: "1920x1080",
        currentRefreshRate: 60,
        resolutions: ["1280x720", "1920x1080", "2560x1440"],
        refreshRatesByResolution: {
          "1920x1080": [60, 144],
          "1280x720": [60],
          "2560x1440": [60],
        },
      },
    ],
    getOfficialPlaysets: async () => ({
      playsets: [
        {
          sourceId: "official-demo",
          name: "官方预设（示例）",
          isActive: true,
          modOrder: ["demo-road", "demo-state"],
          modIds: ["demo-road"],
          disabledDlcIds: ["dlc/sabaton.dlc"],
          modReferences: [],
        },
      ],
      warnings: ["当前为界面预览，下面显示的是示例预设。"],
    }),
    importOfficialPlaysets: async (ids) => {
      if (!ids.includes("official-demo")) throw new Error("请选择示例预设。");
      const playset = {
        id: crypto.randomUUID(),
        name: "官方预设（示例）",
        modOrder: ["demo-road", "demo-state"],
        modIds: ["demo-road"],
        disabledDlcIds: ["dlc/sabaton.dlc"],
      };
      await saveSettings({
        playsets: [...settings.playsets, playset],
        activePlaysetId: playset.id,
      });
      return { state: await getState(), importedCount: 1, warnings: [] };
    },
    importPlayset: async (text) => {
      const parsed = JSON.parse(text);
      if (
        parsed.game !== "hoi4" ||
        !parsed.name?.trim() ||
        !Array.isArray(parsed.mods)
      )
        throw new Error("请选择 HOI4 官方格式预设 JSON。");
      const refs = parsed.mods
        .sort((a, b) => a.position - b.position)
        .map((item) => {
          const remoteId = item.steamId || item.pdxId;
          if (!remoteId || typeof item.enabled !== "boolean")
            throw new Error("模组数据无效。");
          const source = item.steamId ? "workshop" : "pdx";
          return {
            id:
              mods.find(
                (mod) => mod.remoteId === remoteId && mod.source === source,
              )?.id || `${source}:${remoteId}`,
            name: item.displayName,
            source,
            remoteId,
            enabled: item.enabled,
          };
        });
      const playset = {
        id: crypto.randomUUID(),
        name: parsed.name,
        modOrder: refs.map((ref) => ref.id),
        modIds: refs.filter((ref) => ref.enabled).map((ref) => ref.id),
        modReferences: refs,
      };
      await saveSettings({
        playsets: [...settings.playsets, playset],
        activePlaysetId: playset.id,
      });
      return getState();
    },
    exportPlayset: async (id) => {
      const playset = settings.playsets.find((item) => item.id === id);
      const omittedLocalMods = [];
      const entries = playset.modOrder
        .map((key, position) => {
          const mod =
            mods.find((item) => item.id === key) ||
            playset.modReferences.find((item) => item.id === key);
          if (mod.source === "local") {
            omittedLocalMods.push({ id: key, name: mod.name });
            return null;
          }
          return {
            displayName: mod.name,
            [mod.source === "workshop" ? "steamId" : "pdxId"]: mod.remoteId,
            position,
            enabled: playset.modIds.includes(key),
          };
        })
        .filter(Boolean);
      return {
        document: { game: "hoi4", name: playset.name, mods: entries },
        omittedLocalMods,
      };
    },
    importPlaysetFile: async () => {
      throw new Error("请在桌面版中选择预设文件。");
    },
    exportPlaysetFile: async () => {
      throw new Error("请在桌面版中保存预设文件，或复制 JSON。");
    },
    selectGameDirectory: async () => {
      throw new Error("当前为界面预览，请在桌面版中选择游戏目录。");
    },
    launchGame: async () => {
      throw new Error("当前为界面预览，请打开桌面版启动游戏。");
    },
  };
}
