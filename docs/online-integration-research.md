# Roadmap 1：HOI4 在线集成核对

首次核对日期：2026-10-28。对齐对象为用户确认的 **Windows Steam 版 HOI4 / Paradox Launcher v2**。该次研究只读取已安装应用的静态实现、公开文档和匿名查询响应；未读取账号存储、登录令牌或 Steam 凭据，未登录、订阅、下载模组、上传、发布或启动任何前台程序。

本文保留首次调查、实施建议和注明日期的后续静态补核，文中的“尚未建立”与“后续工作”按对应研究时点理解，不是当前产品缺口表。0.19 已实现官方签名信任链、自有完整包/补丁暂停恢复和单 ZIP `n/p/k` 补丁链路；当前行为见 [增量下载与缓存](pdx-delta-core.md)、[内容地址及补丁选择](cpatch-download-paths.md) 和 [Roadmap](../ROADMAP.md)。真实账号、Electron、游戏及 Steam SDK 验收与协议实现分别记录，不从匿名探测推断。

2026-10-29 另完成真实公开安装补丁补核：重新验签后完整取得同一 HOI4 仓库 revision 3 的 559,180,000 字节 `-1_to_3`，生产容器实际执行 `n`，无旧源重建 561,485,374 字节目标 ZIP，与可信 complete 摘要一致，安全工作区 `finish/proofs` 通过。见 [重建报告](../test-results/official-install-patch.json) 和 [官方安装补丁验收](official-install-acceptance.md)。这条真实资源重建与下文首次静态/HEAD 探测分别记录；隔离安装结果另行核对，不能外推真实账号、完整下载协调器、Electron、游戏、Steam，或通用 `c/d/s`、多目标、真实 `k` 已通过。

## 结论与适用范围

后续隔离安装也已通过：生产安装器将上述真实 ZIP 安装到项目新目录，8,155 个文件及注册在提交后、服务重建后两次完整验证均 intact，原 ZIP 不变。见 [安装报告](../test-results/official-install.json)。正常服务重开与真实进程重启或中断事务恢复分别验收。

**HOI4 当前未启用云预设和公开预设分享。** 官方通用启动器包含的云同步、公开预设、云端版本和冲突处理界面，不能直接全部算作 HOI4 对齐要求。游戏的本地预设、成员启停、顺序、DLC 配置以及 JSON 交换仍然适用。

账号登录、Steam Workshop 与 Paradox Mods 订阅/下载/上传属于适用能力。首次研究已实测匿名新闻和 Paradox Mods 浏览；账号和写操作当时仅确认接口形状，不能据此声称端到端通过。后续项目已独立实现相关服务并使用隔离验证，当前覆盖与真实联调状态见 [Roadmap](../ROADMAP.md)，不要把当时的实现建议当成当前未实现结论。

| 能力                        | HOI4 当前依据                                                       | 对齐判定                                             |
| --------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------- |
| 本地预设、顺序、JSON 分享   | 本地数据库和官方导入导出实现                                        | 适用                                                 |
| 云预设同步                  | GraphQL `activationSets:false`                                      | 当前不适用                                           |
| 云端模组排序                | GraphQL `setActivationOrder:false`                                  | 当前不适用；不影响本地排序                           |
| 公开/订阅/版本化云预设      | `/mods/games` 中 `usePlaysetSharing:false`，同时云预设关闭          | 当前不适用                                           |
| Paradox Mods 启用/发布      | GraphQL `enable:true`、`publish:true`                               | 适用                                                 |
| Paradox Mods 安装/下载/上传 | `/mods/games` 中 `canInstall/canDownload/canPublish/canUpload:true` | 适用                                                 |
| Paradox Mods 任意版本选择   | `/mods/games` 中 `canSelectVersion:false`                           | 当前未开放用户版本选择；交换数据中的已有版本仍应保留 |
| 匿名新闻、Paradox 模组浏览  | HTTPS 请求实测 HTTP 200                                             | 可直接实现真实读取与缓存                             |
| Steam 订阅、更新、发布      | 官方使用 Steam SDK；Steamworks 有公开接口文档                       | 适用，需独立实现并满足 SDK/应用接入条件              |

服务端开关可能变化。生产实现应记录来源、获取时间和缓存状态，而非把本次值永久写死。网络失败也不能被解释成“所有云功能已开放”。

## 可复核的服务端开关

### 模组目录能力

匿名 `GET https://api.paradox-interactive.com/mods/games` 返回 HTTP 200。`name:"hoi4"` 的关键字段为：

```json
{
  "actions": {
    "activationSets": false,
    "canInstall": true,
    "canEnable": true,
    "canPublish": true,
    "canDownload": true,
    "canSelectVersion": false,
    "canReorder": false,
    "looseModFilesSupport": false,
    "usePlaysetSharing": false,
    "useModCollaborators": true,
    "canUpload": true
  },
  "betaActions": {
    "usePlaysetSharing": false,
    "useModCollaborators": false
  },
  "extension": "zip",
  "osPublishList": ["Any"],
  "osCrossPlatformList": ["Linux", "OSX", "Windows"]
}
```

### 启动器实际采用的元数据开关

官方主进程 `Iat` / `getGamesAvailableActions` 还从 GraphQL 读取 `activationSets` 等字段；不能仅检查 `/mods/games`。本次向 `https://api.paradox-interactive.com/metadata/graphql` 发送了以下**匿名只读查询**，返回 HTTP 200：

```json
{
  "operationName": "GetMetadata",
  "query": "query GetMetadata($ids: [ID]) { games(ids: $ids) { id name actions { activationSets setActivationOrder publish enable } } }",
  "variables": { "ids": ["hoi4"] }
}
```

```json
{
  "data": {
    "games": [
      {
        "id": "hoi4",
        "name": "Hearts of Iron 4",
        "actions": {
          "activationSets": false,
          "setActivationOrder": false,
          "publish": true,
          "enable": true
        }
      }
    ]
  }
}
```

安装版主进程中，`wZe` 将这些开关应用到游戏设置，`BVe` 为同步服务提供开关 getter。`jVe` 在预设开关关闭时直接跳过本地到 API 的预设同步；`$Ve` 在此状态下仅同步 Paradox 模组，然后返回。因此这不是仅凭开关名称作出的推测。通用云预设还会检查 PDX 模组资格；Steam/本地模组集合不能直接等同于可云同步的 PDX 预设。

## 匿名读取：可直接开发的部分

### 新闻

`GET https://api.paradox-interactive.com/communication/braze/contentcards/hoi4?distributionPlatform=steam` 实测 HTTP 200，JSON 顶层有 `main`、`secondary-1` 等槽位，每个槽位包含 `contentGroups`、可见时间和 `contentItems`。

安装版静态常量使用 HTTP，但 HTTPS 已实测可用；本项目应使用 HTTPS，遵守可见时间并验证外链协议，处理空结果、超时和离线缓存。读取成功与用户主动打开新闻链接是两个独立动作。

### Paradox 模组浏览

`POST https://api.paradox-interactive.com/mods` 可用于匿名只读搜索。已验证请求：

```json
{
  "gameNames": ["hoi4"],
  "orderBy": "desc",
  "sortBy": "best",
  "pageSize": 1,
  "page": 0,
  "time": "quarter",
  "states": ["published"]
}
```

响应为 `{totalCount, mods, result}`；已观察到的条目字段包括 `modId`、`displayName`、`author`、`game`、`requiredVersion`、`shortDescription`、`tags`、`displayImagePath`、`modVersion`、`repositoryPath`、`state`。公开示例模组 `157712` 的 `game` 为 `hoi4`。搜索有内容不表示已订阅、已下载或可启动。

官方还定义 `GET /mods?modId=<id>`、`GET /mods/versions?modId=<id>` 与 `POST /mods/directDependencies`。本次未逐一在线验收这些接口，不能把它们与上面的实测请求混为一谈。

### Steam 公开详情

[ISteamRemoteStorage Web API 文档](https://partner.steamgames.com/doc/webapi/ISteamRemoteStorage) 列出 `POST https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/`，参数为 `itemcount` 和 `publishedfileids[0]` 等；此公开详情接口文档未要求 API key。它提供元数据，不提供对当前用户执行订阅的授权。

## Paradox 账号：已查明机制与未知条件

安装版渲染器的账号客户端使用 `PUT https://api.paradox-interactive.com/accounts/sessions/launcher-v2`。静态实现显示：

1. 手工登录发送 `Authorization` JSON，其中 `hawk` 包含 `email` 与 `sha256(password+salt)` 字段。salt 为安装程序中公开的常量；此文档不复制其具体值。
2. Steam 自动登录发送 `{steam:{appId,ticket}}`，ticket 来自本机 Steam SDK 身份流程。
3. 会话返回后，请求头采用 `{session:{token}}`；刷新采用 `{renewal:{token}}`。会话字段是敏感信息，不能写入普通日志、导出诊断或发送到渲染器的无关状态中。
4. 账号详情为 `GET /accountdetails`；关联平台查询为 `GET /accounts/connections/u`。存在 `PUT /accounts/steam/connect` 和 `/disconnect` 等显式关联动作，它们不属于普通浏览操作。

这表明官方实现有直接会话认证，**未查明它提供给第三方的 OAuth Authorization Code / PKCE 流程**。没有发现 `client_id/client_secret` 并不能证明无需注册；公开的 `launcher-v2` 会话名称和 salt 也不能被当作私密凭据，或当作第三方已获准使用该身份的证据。

本次查阅的公开支持文档没有明确给出第三方启动器的客户端登记、授权范围或可复用会话身份政策。**这项未知不是已证实的技术阻塞，也不能推导出必须先取得 OAuth client secret。** 手工邮箱/密码流程的静态协议只含用户凭据、公开常量与固定会话路径，没有出现客户端秘密、签名私钥或独立登记令牌。可实现用户主动输入自己账号凭据的流程，并将服务器是否有额外约束留给真实账号验收；目前没有调用登录接口，也没有复用已安装官方启动器的用户会话。Steam 自动登录/账号关联才确定需要新的 Steam ticket 与 native SDK。

会话字段已核实为 `token`、`userid`、`refresh_token`。刷新向同一会话路径 PUT `{renewal:{token:<refresh_token>}}` 认证头，并读取响应 `session`；没有查明可依赖的过期时间字段，故不能编造固定会话寿命。账号详情响应嵌套 `account.email`；社交用户名来自 `GET /profiles?namespace=social`。官方退出仅清内存、持久化会话和补丁服务 token，没有发现单独服务器 revoke 调用。

账号实现需要覆盖用户主动登录、退出、401 后刷新、取消登录和账号切换；密码不落盘，长期 refresh token 仅在系统凭据保护可用时加密存储，网络与诊断日志统一脱敏。通过 SDK 获取新 Steam ticket 也应由用户主动发起账号流程。技术实现可通过注入网络与加密器的隔离测试验证，实际认证成功仍需用户主动提供凭据后验收。

## Paradox 模组订阅、下载与发布接口

以下由官方安装版静态实现确认，**均未调用写接口**。基础地址为 `https://api.paradox-interactive.com`。游戏请求会带 `x-pdx-game-name: hoi4` 及可选 `x-pdx-game-version`。本项目若接入，应使用自身产品身份，不伪装成 `ParadoxLauncher` User-Agent。

| 操作        | 官方请求形状                                                                            | 注意                                                                        |
| ----------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 批量订阅    | `POST /mods/installed`，`X-Accept-Version:2`，`{activationSetId?,mods:[{id,version?}]}` | 此项有账号副作用；HOI4 可能仍使用服务端默认集合承载订阅，不等于已启用云预设 |
| 取消订阅    | `DELETE /mods/installed?modId=<id>&activationSetId=<optional>`                          | 需处理本地成员、下载中任务和其他预设引用                                    |
| 已发布模组  | `POST /mods`，`{gameNames:["hoi4"],onlyModsByMe:true}`                                  | 必须有当前账号，不能用匿名结果推断所有权                                    |
| 内容上传 V1 | `PUT /mods/content/<game>/<modName>/<fileType>/<fileName>`                              | 二进制流，`Content-Type:application/octet-stream` 和长度；有进度            |
| 发布 V1     | `POST /mods/publish`                                                                    | 发出后需要处理服务端发布中状态                                              |
| 更新 V1     | `POST /mods/publishUpdate`                                                              | 增加 `modId`，先验证当前账号所有权和模组未忙碌                              |

发布元数据包括 `modName`、`gameName`、`contentFileName`、`thumbnail`、`os:"Any"`、`arch:"Any"`、`longDescription`、`shortDescription`、`displayName`、`tags`、`recommendedGameVersion`、`changelogEntry`。官方会检查大小、所有权、重复本地远程 ID，以及正在进行的上传。

**HOI4 当前采用 LFV0，官方选择 V1 发布策略。** 通用实现还存在 V2 的 `/mods/presigned-urls`、`POST /mods` 和 `PUT /mods/<id>/versions`，但只在 LFV1.1 与 loose-files 配置符合时选择。不能因 V2 代码存在就用它替代 HOI4 的真实流程。

下载不是把 `displayImagePath` 或 `repositoryPath` 当作一个 ZIP 链接。官方 Paradox 模组同步委托下载/补丁服务，使用仓库路径和版本。首次研究时尚未建立独立内容交付契约，当时的实施要求是补齐临时下载、完整性、路径安全、事务安装、取消和恢复；后续已经独立实现完整包、官方签名链、自有断点及 0.19 单 ZIP 补丁流程，当前条件见 [增量下载与缓存](pdx-delta-core.md) 和 [内容地址及补丁选择](cpatch-download-paths.md)。这些实现不等于通用 CPatch 或官方内部缓存/断点兼容，也不替代真实账号/SDK/游戏验收；不复制分发官方专有补丁二进制。

## Steam Workshop：客户端 SDK 与服务器 Web API 的区别

[Steamworks API 初始化文档](https://partner.steamgames.com/doc/sdk/api) 说明，接口调用前必须 `SteamAPI_Init` 成功。Steam 客户端需运行，调用进程和 Steam 处于同一操作系统用户/权限上下文，存在正确的 App ID，用户有相应许可。开发用 `steam_appid.txt` 不应随正式产品分发。

### 桌面客户端可用的接口方向

[ISteamUGC 文档](https://partner.steamgames.com/doc/api/ISteamUGC) 定义：

- `SubscribeItem(id)`：为当前 Steam 用户订阅，Steam 尽快安排下载/安装；等待对应回调确认结果。
- `UnsubscribeItem(id)`：取消订阅，文档说明内容在游戏退出后移除；不能立即假定磁盘已清理。
- `DownloadItem(id, highPriority)`：下载或更新，等待 `DownloadItemResult_t` 后才使用文件。
- `GetItemState`、`GetItemInstallInfo`、`GetItemDownloadInfo`：区分订阅、待下载、下载中、需更新和已安装。
- `CreateItem` → `StartItemUpdate` → 内容/描述/标签/预览等 setter → `SubmitItemUpdate` → 回调：创建或更新模组；用 `GetItemUpdateProgress` 展示进度。

`DownloadItem` 的 `highPriority:true` 会暂停其他 Steam 下载。为尊重用户“不打扰前台工作”的要求，不应将其设为默认，也不应在测试时自动触发真实下载。

[Workshop 实施指南](https://partner.steamgames.com/doc/features/workshop/implementation) 说明应用需配置 UGC 支持以及预览上传等相应配额；创建/更新时检查用户是否接受 Workshop 法律协议。`SubmitItemUpdate` 后没有取消接口，因此发布操作应有明确的最终提交动作，不能用“取消”按钮虚假保证可以撤回。`SetItemContent` 使用内容目录，文档推荐散文件以改善后续差量传输。

桌面 SDK 路线不等于所有操作都必须有 publisher Web API key。不过，第三方启动器能否合法分发相应 SDK/native binding、以何种应用身份调用 HOI4 Workshop、是否需要额外工具/App 登记，仍须从项目实际接入条件确认。仅把 App ID 设成 `394360` 不能证明已取得这些条件。应选择许可明确的绑定并验证当前 Electron ABI 和 Windows x64，而非复制官方启动器附带的私有模块。

### Web API 不是无密钥订阅捷径

[ISteamRemoteStorage 文档](https://partner.steamgames.com/doc/webapi/ISteamRemoteStorage) 中 `SubscribePublishedFile` / `UnsubscribePublishedFile` 使用 `https://partner.steam-api.com/ISteamRemoteStorage/.../v1/`，要求 publisher API key、`steamid`、`appid`、`publishedfileid`。

文档明确要求这类 key 仅用于安全服务器，不能放在桌面客户端。普通用户 Web API key 不等价于 publisher key。匿名获取详情成功也不能推导出可以匿名订阅、下载受限内容或代表其他用户发布。

## 首次研究提出的后续工作与验收（历史计划）

以下保留 2026-10-28 的实施顺序，便于追溯当时证据，不表示每项至今仍未实现。当前服务、用户入口、隔离核验及剩余真实验收，以 [Roadmap](../ROADMAP.md) 为准；自更新仍按用户选择暂缓。

1. **匿名在线层**：新闻、PDX 模组浏览和 Steam 公开详情；验收真实结果、离线缓存、超时/限流、协议白名单和空结果。此部分不依赖登录。
2. **Steam provider**：先明确 SDK 分发和应用身份条件，选择绑定；在 fixture/mock 中验证回调、状态和失败恢复。用户主动授权真实联调后，再验收订阅、更新和上传；后台自检不得发起真实动作。
3. **Paradox provider**：实现已查明的用户主动会话协议，完成会话隔离及订阅状态；继续明确内容交付协议，再接入可取消下载和版本校验。发布前准备可审阅的标题、描述、标签、目标模组和内容大小，等待用户实际提交。没有公开第三方政策不是自动停止实现的理由，实际服务端约束仍需真实账户验收。
4. **能力检测**：将当前 HOI4 开关纳入能力模型；用“服务未开放”“未登录”“接入尚未完成”和“请求失败”分别表达状态。不能把占位页或外部网页入口标为完整在线管理。
5. **真实发布源（用户已暂缓）**：IRONCLAD 自更新仍需自己的下载源、版本清单和完整性验证；官方启动器稳定/测试通道不能复用为本产品更新。本阶段不继续实施自更新。

## 对先前研究的两点补充

- `official-launcher-research.md` 最初“HOI4 云预设开关待确认”的结论已由本文件的匿名查询和同步代码条件补足，当前对齐依据已标为不适用；服务端开关将来变化时须重新核查。
- 官方运行时预设名称校验常量为 `lv=1`、`uv=128`，上限 **128**。SQLite 列类型写作 255 并不代表 UI/业务层允许 255；新建/重命名应对齐运行时限制。已有迁移数据是否保留更长名称需明确策略，不能无提示截断。

## 已安装 Paradox 模组：扫描实施依据

HOI4 使用 LFV0。官方外部描述文件位于玩家资料目录 `mod/`，普通订阅为 `pdx_<id>.mod`，固定版本的目录克隆流程会写出 `pdx_<id>_<version>.mod`。扫描可兼容 `^pdx_(\d+)(?:_(\d+))?\.mod$`，并保留版本；ID 来自文件名前缀，`remote_file_id` 表示 Steam Workshop ID，不能当作 PDX ID。

描述格式为 Paradox 文本。`name` 必填；`path`、`archive`、`supported_version`、`tags`、`version` 可选，允许其他字段。相对 `path/archive` 以**玩家资料根目录**解析，不能相对 `mod/` 再拼接一次。例：

```text
name="Example Paradox mod"
path="mod/pdx_12345"
supported_version="1.19.*"
tags={ "Gameplay" }
```

官方 `_je` 默认跟随最新版的安装目录为 `mod/pdx_<id>/`，固定版本为 `mod/pdx_<id>_<version>/`。自定义位置会保存为 `<用户选择目录>/hoi4`，之后在该目录下使用同样的模组目录名，并可能保留默认位置的链接。扫描应优先信任经过路径/存在性验证的外部描述和已导入数据库 `dirPath/archivePath`，不能只枚举默认目录。

`WGe.cloneFromDir` 先找安装目录内的 `.mod`，找不到时寻找 `.zip` 并提取其中描述，生成外部描述时设置正确的 `path` 或 `archive`。不能假定每个已安装 PDX 模组都是已解压散文件，也不能因目录存在就断言完整安装。

首次研究时，本机已观察的真实数据库来源仅为 Steam/local，该次没有用于实机验收的 PDX 已安装样本；当时建议以 fixture 覆盖路径、ZIP、缺失描述、固定版本和自定义位置。后续真实公开补丁重建及独立隔离安装的证据范围见 [官方安装补丁验收](official-install-acceptance.md)，不将它们混写成玩家当前安装或游戏加载验收。官方旧的文件来源判断正则只识别无版本后缀，但其实际写出流程包含后缀，独立扫描应兼容写出格式。

## 官方启动器语言、设置与启动后行为

语言菜单支持 12 种：`en`、`de`、`es`、`fr`、`ja`、`ko`、`pl`、`pt`、`ru`、`tr`、`zh-hans`、`zh-hant`；默认英语。语言菜单和游戏语言是不同状态，不能只改游戏语言就声称完成界面国际化。

渲染器 `zTt` 的实际启动器设置组件包括：

| 设置                | 实际行为 / 适用性                                                         |
| ------------------- | ------------------------------------------------------------------------- |
| 接收 Beta 版本      | 稳定/测试通道切换，有确认提示；更新服务禁用时隐藏                         |
| 个性化营销设置      | 打开 Paradox 账号设置页，本身是外部入口                                   |
| 导出启动器日志      | 保存 ZIP；本项目需脱敏自身日志                                            |
| 可选启动器遥测      | 控制 optional telemetry；不要求本项目为对齐而新增遥测采集                 |
| 下载限速            | 开关与 Mib/s 数值，最低 0.25；转换为 bytes/s 时 `ceil(value*1024*1024/8)` |
| 显示全部 Steam 游戏 | 仅多游戏/standalone 模式显示，单游戏 HOI4 目标不要求实现多游戏库          |
| 更新状态            | 更新中、失败、可重启完成更新、操作系统不受支持等状态                      |

没有找到官方“启动后保持/最小化/退出”三选一用户配置。实际启动成功分支是 standalone 保留进程，单游戏模式退出启动器。因此本项目可以提供额外行为选项，但不能把未实证的三选一标成官方必需功能。默认单游戏 Steam 行为可对齐启动成功后退出，启动失败应保留界面。

### 下载限速的实际范围（2026-10-29 补核）

限速菜单只控制官方 CPatch 分发。Renderer 的 `Rj` / `trt` 将 Mib/s 转成 bytes/s，发送 `SET_DOWNLOAD_SPEED_THROTTLE`；main 的 `jrt` 只取得 `patchService` 并调用 `setDownloadSpeedThrottle`，后续经 CPatch socket 发送 `download-speed-throttle`。它没有向 Steam 设置带宽。

当前 2026.12 静态文件定位：renderer 字符偏移约 1228135 / 1227171；main 的路由约 2470966，patch service 约 3239210，CPatch socket 约 3056968 / 3061904。Steam 下载在 main 约 1829851 / 3302701，使用 `downloadItem(id,false)` → `ugcDownloadItem(id,false)`，只有普通优先级参数。以上仅内存只读提取，未执行官方代码。

本项目 `steamworks.js` 0.4.0 的 `client.d.ts` 同样仅暴露 `download(id,highPriority)`、订阅及状态/字节进度，没有单项限速、暂停或撤销已接受下载的接口。因此“Steam 下载限速”不是当前官方对齐缺口。产品应说明带宽和暂停由 Steam 客户端管理；0.19 自有 Paradox 完整包与已选补丁传输均提供独立限速及暂停，补丁应用和安装阶段不可暂停，见 [暂停与恢复](pdx-resume.md)。

自定义 PDX 模组位置属于游戏级选项，会迁移现有内容并维护默认位置链接。单纯改扫描路径不等于完成官方迁移行为；涉及真实数据迁移时需要先预览目标与文件数量，并保留恢复路径。

## 证据定位与研究边界

静态核对路径：`<用户目录>/AppData/Local/Programs/Paradox Interactive/launcher/launcher-v2.2026.12/resources/app.asar`；归档成员 `dist/main/index.mjs` 与 `dist/renderer/assets/primary-BdsA_WUs.js`。使用内存只读提取，未执行官方应用代码，未将官方实现、凭据或素材用于产品；公开网页研究缓存仅位于 test-results，不打包分发。符号为该版本压缩后的定位标识，未来版本可能变化。

本机游戏元数据：`D:/Steam/steamapps/common/Hearts of Iron IV/launcher-settings.json`，`rawVersion:1.19.4.0`。本次在线研究没有修改真实玩家资料。上述已实测匿名请求与仅静态发现的接口已分别标明；接口存在不等于第三方使用政策或端到端验收已经完成。
