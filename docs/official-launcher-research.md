# Roadmap 1：官方启动器对齐依据

首次核对日期：2026-10-28。目标由用户确认为 Windows Steam 版 HOI4 的 Paradox Launcher v2。以下材料来自当时的只读文件检查和官方公开支持站点；该次研究没有打开官方启动器、Steam 或游戏，没有读取登录令牌，没有修改实际玩家资料。

本文记录官方行为依据及各次补核的证据边界，不是当前实现状态表。0.19 已具备独立官方签名验证、自有完整包/补丁暂停恢复和单 ZIP `n/p/k` 重建；当前规则见 [增量下载与缓存](pdx-delta-core.md)、[内容地址及补丁选择](cpatch-download-paths.md)，交付结果和真实环境验收统一见 [Roadmap](../ROADMAP.md)。旧版“未实现”结论须按其版本阅读，不能据此否认后续能力。

## 基线与证据

- 本机安装的官方启动器版本目录：`<用户目录>/AppData/Local/Programs/Paradox Interactive/launcher/launcher-v2.2026.12/`。
- 官方应用只读归档：该目录 `resources/app.asar`。检查了游戏元数据、渲染层功能文案和主进程的文件格式/调用参数；不复制官方程序、素材或实现代码到项目。
- 本机游戏：`D:/Steam/steamapps/common/Hearts of Iron IV/launcher-settings.json`，`rawVersion` 为 `1.19.4.0`。
- 游戏设置声明：同目录 `settings-layout.json`。
- 官方预设数据库：`Documents/Paradox Interactive/Hearts of Iron IV/launcher-v2.sqlite`。研究仅以只读方式检查表结构和 DLC 标识格式；迁移实现须使用隔离快照，不向官方数据库写入。

公开参考资料：

1. [My Mods or Playsets are not showing up in the Launcher](https://support.paradoxplaza.com/hc/en-us/articles/360020841079-My-Mods-or-Playsets-are-not-showing-up-in-the-Launcher)：确认模组/预设及其本地 SQLite 数据。
2. [Mods won't load / Mod load order failed](https://support.paradoxplaza.com/hc/en-us/articles/360019724999-Mods-won-t-load-Mod-load-order-failed)：HOI4 官方支持确认模组加载顺序、描述文件和数据库相关路径。
3. [The Paradox Launcher v2 doesn't work](https://support.paradoxplaza.com/hc/en-us/articles/360010684620-The-Paradox-Launcher-v2-doesn-t-work)：确认启动器设置里的 Export Launcher Logs、缓存和游戏配置文件。文章中的删除步骤仅作为背景资料，研究没有执行。
4. [Open Beta information](https://support.paradoxplaza.com/hc/en-us/articles/360013202439-Open-Beta-information)：确认官方启动器有稳定/公开测试通道，切换后更新启动器；官方也提示设置未必可向后兼容。

## 功能清单及证据强度

“已证实”表示本机游戏元数据或官方实现存在明确对应行为；“游戏/服务开关控制”表示官方通用启动器包含此功能，但还需核对 HOI4 当前线上开关，不能只凭通用文案声称本游戏已启用。

| 范围                    | 对齐要求                                                                                                                    | 依据 / 限制                                                                                                   |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 启动                    | 普通启动、游戏版本、调试替代启动、继续上次存档、启动失败提示                                                                | 已证实，读取游戏元数据与 `continue_game.json`                                                                 |
| 游戏设置                | 按游戏布局显示语言、显示器、窗口模式、全屏/窗口分辨率、垂直同步、渲染器等实际字段                                           | 已证实；动态显示器/分辨率选项由官方 SDL 提供，不应编造硬件可用选项                                            |
| DLC                     | 列表、启用/停用、安装/校验状态、商店入口、分类、预设内 DLC 选择                                                             | 已证实；文件存在不能证明 Steam 购买权益，权益由平台确认                                                       |
| 模组库                  | 安装模组扫描、Steam/Paradox/本地来源、筛选排序、详情、缩略图、版本兼容提示、失效/缺依赖/下载错误状态、打开所在文件夹/来源页 | 官方通用实现及本机 HOI4 模组数据                                                                              |
| 预设                    | 新建、激活、重命名/信息编辑、复制、删除、添加/移除成员、成员启用开关、排序/加载顺序、预设 DLC 配置                          | 已证实；成员关系和启用状态是两个不同维度                                                                      |
| 预设迁移/交换           | 从官方数据库导入；官方 JSON 文件/剪贴板格式导入导出；保持位置、关闭成员和缺失远程 ID                                        | 已证实；官方导出明确排除本地模组并提示                                                                        |
| 创意工坊与 Paradox Mods | 浏览、订阅/取消订阅、下载/更新及状态、缺失订阅处理                                                                          | 官方实现包含 Steam SDK 与 Paradox 服务调用；只打开网页不等价于应用内订阅/下载管理全部完成                     |
| 模组创作                | 创建本地模组、编辑发布资料、向 Steam/Paradox 上传或更新、版本/标签/描述/封面等校验                                          | 官方存在独立 `mods-upload` 窗口和对应服务；发布必须由用户主动操作，不应测试性发布                             |
| 新闻                    | 游戏新闻/公告、真实网络加载、离线缓存和失败状态                                                                             | 官方匿名新闻流可不登录；不得用静态假新闻声称完成                                                              |
| 账号                    | 登录/退出、账号相关状态、服务会话和适用的账号管理入口                                                                       | 官方账号服务；不能复用玩家现有令牌、冒充官方客户端或把链接当作已完成认证                                      |
| 云预设                  | 云同步、冲突解决、公开/订阅预设、描述/封面/版本、离线/仅云端存储                                                            | 官方通用实现存在；已由[在线补核](online-integration-research.md)确认 HOI4 当时关闭云预设/分享，当前基准不适用 |
| 维护                    | 备份并清理游戏缓存、导出启动器日志、错误诊断                                                                                | 已证实；官方清缓存会先备份/移动且排除关键数据库与配置，不能直接递归删除 `mod/`                                |
| 启动器设置              | 界面语言、适用的启动行为、检查更新、稳定/测试更新通道                                                                       | 已证实通用功能；IRONCLAD 自身更新需要真实发布源和校验，不能安装官方二进制冒充自身更新                         |

## 关键互操作格式

### 启动参数

本机 HOI4 的普通参数为 `['-gdpr-compliant']`。官方声明的调试替代项为 `['-gdpr-compliant', '-debug_mode']`。不能继续用未核对的 `-debug` 取代当前元数据。

官方继续游戏路径在普通/替代参数之外追加 `--continuelastsave`，不直接拼接存档文件名。`continue_game.json` 包含 `title`、`desc`、`date`、`filename`、`is_remote`。存档存在性验证由元数据开关控制；本机 HOI4 未声明附加开关。对远程存档不能用本地 `save games/` 是否存在作为唯一判断。

### 游戏设置：LFV0 与 LFV1

官方 `formatVersion` 默认是 `0`，本机 HOI4 元数据没有该字段，故属于 LFV0。即使元数据写了 `ingameSettingsPath: "pdx_settings.json"`，LFV0 仍固定使用 `pdx_settings.txt` 的 Paradox 文本格式。

LFV0 形状为类别 → 设置名 → 属性。例如布尔量 `{ enabled=yes version=0 }`，其他量 `{ value="dx11" version=0 }`。保存时合并已有设置，保留已有 `version`，新字段默认 `0`。该路径不额外重写老的 `settings.txt`。

LFV1/1.1 按 `ingameSettingsPath` 使用 JSON。类别内是直接标量，例如 `{"Graphics":{"display_mode":"windowed","vsync":true}}`；不是 LFV0 的 `value/version` 包装。保存为深合并，保留其他字段。

### 官方预设交换 JSON

```json
{
  "game": "hoi4",
  "name": "Example playset",
  "mods": [
    {
      "displayName": "Example Workshop mod",
      "steamId": "1234567890",
      "position": 0,
      "enabled": true
    },
    {
      "displayName": "Example Paradox mod",
      "pdxId": "12345",
      "position": 1,
      "enabled": false,
      "version": "1.0"
    }
  ]
}
```

根字段 `game/name/mods` 必需。每个模组的 `displayName/position/enabled` 必需，至少有 `steamId` 或 `pdxId`。`version` 是可选的 Paradox 模组版本固定信息。官方允许额外字段。顺序来自 `position`，关闭的成员仍然必须保留。官方从导出中排除本地模组，并在分享界面给出提示。文件和剪贴板都使用 JSON。

官方导入还会核对游戏、平台、重复模组，并为缺失远程项执行订阅；仅完成本地解析/保存时应明确说明订阅部分是否实现。

### SQLite 预设关系

只需读取以下字段；不需要任何账号表或会话字段：

- `playsets(id, name, isActive, loadOrder, isRemoved)`。
- `playsets_mods(playsetId, modId, enabled, position)`。
- `mods(id, pdxId, steamId, gameRegistryId, name, displayName, dirPath, archivePath, status, source)`。
- `playsets_dlcs(playsetId, dlcId, enabled)`。

`playsets_mods.modId` 是数据库内部 ID，不能当作 Workshop ID。应优先根据 `mods.steamId/pdxId` 映射稳定远程 ID；本地项按 `gameRegistryId` 或描述文件路径匹配。本机数据库实际来源值为 `steam`、`local`；兼容性配置的另一组来源枚举是 `steam_workshop`、`pdx_mods`、`local`，不能混为一谈。导入可兼容这些别名。本机加载顺序模式是 `custom`。

**DLC 标识必须转换：** 实际 `playsets_dlcs.dlcId` 是 Pops ID，例如 `hoi4_dlc001_german_historical_portraits`；同库 `dlc` 表可能完全为空。需要通过已安装 `.dlc` 中的 `pops_id` 映射成 `dlc_load.json.disabled_dlcs` 使用的相对描述文件路径。无法映射时要保留诊断，不能把未知状态静默变成“全部启用”。

## 日志持久化与轮换（2026-10-29 补核）

对本机 Paradox Launcher v2.2026.12 的 `resources/app.asar` 只读静态核对，未执行程序、读取真实日志或账户数据。以下位置为打包文件内零基字符偏移，用于复核压缩代码，非源码行号。

- `dist/main/index.mjs` 约 259000：`pdxlDebug` 默认开启，关闭时禁用文件日志；约 264094/264836/266296：Windows 日志位于 `%LOCALAPPDATA%/Paradox Interactive/launcher-v2[-suffix]/logs`。
- `dist/main/chunks/_baseClamp-C5MIA6rb.mjs` 约 10374、233831、229500：main/worker 使用日期日志，追加模式并识别已存在文件，记录可跨会话保存。
- 同 chunk 约 314815：`YYYY-MM-DD`、`maxSize:"2m"`、`maxFiles:"3"`；约 226159/227123 确认该配置表示 2 MiB 与 3 个文件，并非三天。此限额只适用于对应 logger 的轮换集，不能推断官方整个日志目录最多 6 MiB。
- index 约 268156 为有条件的性能日志，约 572160/1673300 的导出会打包日志目录，也可能包含 audit JSON 与 CPatch 日志。约 3330327 可见 CPatch 路径，但未建立 CPatch 自身轮换规则。

IRONCLAD 0.12 使用自身目录、独立 UUID 会话和 3×2 MiB 受管日志上限，提供跨重启及 ZIP/JSON 导出；这属于本项目实现，不宣称复刻官方日期命名、audit 或 CPatch 的完整日志结构。见 [诊断导出](diagnostics.md)。

## 受保护完整包下载（2026-10-29 补核）

该次补核通过 CPatch 二进制只读静态检查确认完整资源 `/patch/repo/.../complete/<resource>`、session Authorization、`prepend/append/ttl` 及 60 秒刷新余量；0.13 独立实现获准访问的完整 ZIP 下载。manifest 与 ZIP 分别授权，授权 URL 只保留在内存中；隔离安装/续传和账号变化测试通过。定位、匿名探测与当时限制见 [受保护仓库](pdx-protected-repository.md)。该次没有运行、复制或分发 CPatch，也没有用真实私有账号下载。

“签名和增量未完成”是 0.13 时的历史边界：0.15 后已验证官方根与仓库认证、原始元数据/manifest 分离签名及撤销状态，0.19 已接通独立签名补丁、可信原 ZIP 旧源、files 实际 404 后有声明的安装补丁和原事务。范围限单 ZIP `n/p/k`；通用操作、多目标以及官方内部缓存/断点仍未完成。详见 [签名验证](pdx-signatures.md)、[补丁下载](cpatch-download-paths.md) 与 [增量核心](pdx-delta-core.md)。

## 真实公开安装补丁补核（2026-10-29）

已匿名完整取得公开 HOI4 仓库 revision 3 的 559,180,000 字节 `-1_to_3` 安装补丁，重新通过生产官方签名与撤销验证。生产容器实际执行 `n`，无旧源重建 561,485,374 字节目标 ZIP，与已验签 complete 的 SHA-256 一致，安全工作区 `finish/proofs` 通过；没有另下目标 complete 包体。证据见 [重建报告](../test-results/official-install-patch.json) 与 [官方安装补丁验收](official-install-acceptance.md)。这是该真实容器的有限验收，不是完整下载协调器、真实账号或游戏加载通过证明；隔离安装结果单独记录。

上述重建 ZIP 另经生产安装器写入项目新隔离目录：8,155 个文件及注册在提交后和服务重建后两次完整检查均通过，原 ZIP 不变，正常 `recover` 没有遗留事务。见 [隔离安装报告](../test-results/official-install.json)；这不代表进程重启、崩溃恢复或真实玩家目录验收。

## 当前仍需分别验收的事项

- HOI4 当前云预设/公开分享已核实关闭，详细证据见 [在线核对](online-integration-research.md)；未来服务端开关变化需再核查。
- 本项目已有账号、Steam/Paradox 订阅下载及发布的独立实现与隔离测试；真实账号及受限内容授权、SDK、订阅、发布、Electron 和完整下载协调器须分别联调，不能把公开补丁重建或隔离通过当作这些场景已验收。通用 `c/d/s`、多目标、真实 `k` 与官方内部缓存/断点仍未完成；当前范围见 [Roadmap](../ROADMAP.md)。
- 使用真实游戏验证普通/调试/继续启动。为不打扰前台工作，本轮没有启动游戏。
- 用户于 2026-10-28 明确选择先交付本地便携版，暂不配置自更新。

上述真实环境验收与尚未支持的协议范围属于完整 roadmap 的待完成项；历史研究、隔离功能和本地便携制品不会自动关闭目标。官方公开资源后续核验如有新增证据，以 [Roadmap](../ROADMAP.md) 的具体范围为准，也不自动证明账号、SDK 或游戏加载通过。
