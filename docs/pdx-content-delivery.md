# Paradox Mods：HOI4 内容分发与发布契约

首次核对日期：2026-10-28。对齐对象为 Windows Steam 版 HOI4 与 Paradox Launcher v2.2026.12；本机游戏为 `1.19.4.0`、Launcher Format V0（LFV0）。**本文是最初接口研究、当时证据和实现建议的历史记录，不是当前功能缺口表。** 文中的“本次”“未下载”“尚未验证”和样本版本均指对应探测时点，不代表后续版本没有实现或没有新增证据。

当前 0.19 已实现官方签名信任链、自有完整包/补丁暂停与手动续传，以及可信旧源/原 ZIP 缓存支持的单 ZIP `n/p/k` 差分和有声明的安装补丁。最新行为见 [增量下载与缓存](pdx-delta-core.md)、[files 与补丁选择](cpatch-download-paths.md) 和 [暂停与恢复](pdx-resume.md)；受保护资源授权见 [受保护仓库](pdx-protected-repository.md)。最终核验与真实环境证据统一以 [Roadmap](../ROADMAP.md) 为准；隔离通过不等于真实账号、Electron 或游戏加载验收。

## 真实公开安装补丁补核（2026-10-29）

后续匿名取得同一公开 HOI4 仓库 revision 3 的完整 `-1_to_3.zip`，共 559,180,000 字节。使用生产验签器重新核对目标 complete 与安装补丁的官方信任链、原始签名和撤销状态后，生产容器实际执行 `n`，无旧源生成 561,485,374 字节目标 ZIP；SHA-256 为 `25594cbf8ebbe81b1beff1a8ca276258ebe23cb2457c68e2e92c3057c57d5b2c`，与已验签 complete 一致。安全工作区 `finish()` 和 `proofs()` 通过，提取/重建阶段用时 310,087 ms；没有另行下载目标 complete 包体。原始报告见 [official-install-patch.json](../test-results/official-install-patch.json)，完整范围见 [官方安装补丁验收](official-install-acceptance.md)。

该报告证明真实官方 `n` 容器与安全工作区的重建结果，不等于完整下载协调器或真实账号流程通过。随后生产安装器在项目新隔离目录安装，8,155 个文件及注册在提交后、服务重建后两次完整检查均通过，原 ZIP 不变，见 [隔离安装报告](../test-results/official-install.json)。这只是正常服务重开，不是进程重启或崩溃恢复；通用 `c/d/s`、多目标、真实 `k`、官方内部缓存/断点、账号、协调器、Electron、游戏和 Steam 验收仍须按各自证据判断。

## 首次研究的可实施结论

**2026-10-28 探测的 HOI4 公开版本可以使用匿名元数据、公开 CDN manifest 和完整 ZIP 实现独立下载器。** 此路径是 Paradox Mods 网站自身使用的下载流程，不依赖运行或分发官方 CPatch 二进制。一个真实公开模组的详情、版本列表、manifest 返回 HTTP 200；对应 ZIP 的匿名 HEAD 返回 HTTP 200，且长度与 manifest 一致。该次研究没有下载 ZIP 内容，不能将 HEAD 当作包体校验。

账号订阅、安装状态上报和本地下载是不同操作。下载成功不等于账号已订阅；本地安装成功也不等于服务端已经记录安装。应分别记录结果和重试状态。

历史版本不能据此概括为匿名可用。同一模组的指定历史版本详情返回 HTTP 401；未继续猜测该版本的 CDN 地址。需先由当前账号获得所请求版本的合法元数据，再决定内容请求；不得把版本列表可见当成内容授权。

## 首次研究的证据与复核范围

| 证据            | 来源及结果                                                                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 当前详情        | [pdx-detail-157712.json](../test-results/pdx-detail-157712.json)：匿名 `GET /mods?modId=157712`，200                                             |
| 版本列表        | [pdx-versions-157712.json](../test-results/pdx-versions-157712.json)：匿名 `GET /mods/versions?modId=157712`，200                                |
| 当前 manifest   | [pdx-manifest-157712.json](../test-results/pdx-manifest-157712.json)：匿名 GET，200，143 字节                                                    |
| 当前 ZIP 元数据 | [pdx-archive-head-157712.json](../test-results/pdx-archive-head-157712.json)：匿名 HEAD，200，未读取包体                                         |
| 历史详情权限    | [pdx-versioned-detail-157712.json](../test-results/pdx-versioned-detail-157712.json)：匿名请求 revision 11，401                                  |
| 网站下载流程    | 公开 `ModsWeb/2.6.1` bundle，研究缓存 `test-results/paradoxmods-public-bundle.js`；下载 action `ct`、模块 `23158` 的 CDN fetch / anchor download |
| 官方客户端流程  | 本机 `launcher-v2.2026.12/resources/app.asar` 的 `dist\main\index.mjs` 静态读取；未执行其代码或 CPatch                                           |

研究仅使用匿名请求和静态实现。未登录、读取或复用用户凭据，未订阅、上传、发布、下载模组包或打开前台程序。证据文件不保存响应 Cookie。网站和本机压缩代码中的符号仅为本次定位线索，不是稳定 API。

## 元数据与版本

API 固定基址：`https://api.paradox-interactive.com`。

```text
GET /mods?modId=<modId>
GET /mods/versions?modId=<modId>
GET /mods?modId=<modId>&modVersion=<revision>
```

第三个 URL 来自网站 `fetchModDetails` 的查询参数构造；2026-10-28 的匿名历史版本探测实际返回 401。不要将 `modVersion` 换成作者的展示版本字符串。

2026-10-28 样本 `157712`（Aftermath: The Cold War）当时返回的关键详情：

```json
{
  "result": "OK",
  "modDetail": {
    "modId": "157712",
    "game": "hoi4",
    "name": "6cca83a0-a6ec-11f1-92e5-affbeaa2abe2",
    "os": "Any",
    "arch": "Any",
    "modVersion": "12",
    "latestVersion": 12,
    "preferredVersion": "12",
    "repositoryPath": "mods/hoi4/6cca83a0-a6ec-11f1-92e5-affbeaa2abe2/repo/Any__Any",
    "state": "published",
    "updating": false,
    "acl": "public",
    "isRegionBlocked": false,
    "actions": {
      "canEdit": false,
      "canPublish": false,
      "canManageCollaborators": false,
      "canManageAccess": false,
      "canDelete": false
    },
    "requirements": [],
    "installedActivationSets": []
  }
}
```

版本列表结构为 `{result:"OK",modVersions:[{id,created,size,userVersion},...]}`。`id` / `modVersion` 表示服务端 revision；`userVersion` 为可空的作者展示标签，例如 `"0.1.1"`。数据可能混用数字和数字字符串，应严格校验后统一表示，不用浮点比较或字符串字典序判断更新。

`repositoryPath` 是 CPatch 的逻辑仓库路径，含开头的 `mods/`。网站完整包 CDN URL 从 `game/name/os/arch/modVersion` 另行构造，不能直接把 `repositoryPath` 拼到 CDN 根路径。

当前 HOI4 的 `looseModFilesSupport:false`、扩展名 `zip`、`canSelectVersion:false`。默认安装当前可用版本；无需因为通用 API 存在就暴露官方 HOI4 没有开放的任意版本切换。导入数据已有的版本固定信息应保留；能否取得该版本仍以实际授权元数据为准。其余开关见 [online-integration-research.md](online-integration-research.md)。

## 完整包分发

固定 CDN 基址：`https://modscontent.paradox-interactive.com`。网站对 CDN 类型请求不添加账号 Authorization。

HOI4 使用的普通仓库路径：

```text
/<game>/<name>/repo/<os>__<arch>/<modVersion>/complete/manifest
/<game>/<name>/repo/<os>__<arch>/<modVersion>/complete/<manifestFilename>
```

网站读取 manifest 的第 4 行，以逗号分割取第一项作为文件名，然后触发浏览器下载。本项目可以独立实现更严格的格式解析，不应复制这种固定行号假设。

样本 manifest URL：

```text
https://modscontent.paradox-interactive.com/hoi4/6cca83a0-a6ec-11f1-92e5-affbeaa2abe2/repo/Any__Any/12/complete/manifest
```

实际 manifest 全文：

```text
Name: Any__Any
Hash: sha256

6cca83a0-a6ec-11f1-92e5-affbeaa2abe2.zip,606268882,Ogfp1QsraESzXj8m8BfCflxS7EGffBNTdwBRN7ada5k=,crw,998488439,zip
```

| 项目        | 本次可确认含义                                                             |
| ----------- | -------------------------------------------------------------------------- |
| `Name`      | 平台组合，样本为 `Any__Any`                                                |
| `Hash`      | 摘要算法 `sha256`                                                          |
| CSV 第 1 项 | ZIP 文件名；网站以此构造下载 URL                                           |
| CSV 第 2 项 | `606268882`，与 ZIP HEAD 的 Content-Length 及版本列表 size 一致            |
| CSV 第 3 项 | Base64 摘要，解码后 32 字节，与 SHA-256 格式一致；没有包体，未核验内容摘要 |
| CSV 第 4 项 | `crw`，语义尚未确认                                                        |
| CSV 第 5 项 | `998488439`，语义尚未确认；不能当成已确认的解压大小或磁盘预算              |
| CSV 第 6 项 | `zip`，归档类型                                                            |

对应 ZIP HEAD 返回 `Content-Length: 606268882`、`Content-Type: application/octet-stream`、`Accept-Ranges: bytes`。ETag 为 `"4f965b1a9e956b200a5970b5de165a4d"`，不是 manifest 的 SHA-256，不可用它代替内容摘要。

`Accept-Ranges` 仅证明服务器声明支持范围请求。该次探测没有下载包体，也没有验证 206、If-Range 或中断恢复。当时建议首版采用重新下载，并在实现恢复前验证 Content-Range、版本/ETag 绑定、200 回退、416、部分文件长度及最终整包 SHA-256。自有断点后来已实现；当前规则与验证边界见 [暂停与恢复](pdx-resume.md)，不能据本次 HEAD 推断真实 CDN 的 Range 验收已通过。

仅供边界辨识：启用 `looseModFilesSupport` 的其他游戏使用 `/<game>/<name>/content/sources/<name>_<modVersion>.<extension>`。此路径不是本次 HOI4 的下载契约，不要混用。

## 首次研究提出的安装器建议契约

以下保留 2026-10-28 的实施建议，不是该次已验证的 CPatch 内部行为，也不取代当前 [后端契约](../CONTRACT.md)。例如当前实现拒绝内容重定向，完整包和补丁分别验签，更新可在可信旧源与缓存可用时选择较小差分；不能据下列早期整包建议认定这些能力仍未实现。

1. **解析并固定任务输入。** 通过固定 API 主机获取详情，校验 game 为 `hoi4`，拒绝区域限制、非可下载状态、缺失字段和授权失败。将 modId、name、平台、revision 和预期摘要绑定至单个任务；下载过程中不悄悄切换到新 revision。仅选择经过实际授权详情返回的 revision。
2. **限制 URL 和清单。** 严格校验各路径段；不要接受渲染层提供的任意 URL。只允许 HTTPS 固定 CDN 主机；每次重定向都重新检查目标和协议，且不向内容主机转发 API 账号凭据。限制 manifest 大小、行数和字段长度，兼容 CRLF；遇到不支持的算法、多个不明确的内容记录或格式应明确失败。文件名必须为普通 basename，禁止绝对路径、斜杠、反斜杠、`..` 路径段、URL、查询片段及 Windows 特殊名称。校验摘要为规范 Base64 且解码 32 字节；字节数为安全范围内的非负整数。
3. **下载与完整性。** 流式写入应用独占的 staging 目录，计算 SHA-256，持续限制实际接收长度，核对 manifest 长度与摘要。HEAD 的长度只能辅助预检，最终以收到的文件和清单校验为准。未知 manifest 项不提供可信解压预算；应设独立的文件数、单文件和总解压体积上限。
4. **受限解压。** 目标限定在任务 staging 内；拒绝路径穿越、绝对路径、驱动器/UNC 路径、符号链接、Windows 重解析点、大小写冲突和非法路径。校验根部 `descriptor.mod` 及其引用，避免由归档中的外部 path 指向任务外文件。不要直接覆盖已有安装，也不要信任包内的远程 ID 来替换其他模组。
5. **提交与回滚。** 在同一卷上完成 staging 和备份目录切换；为文件替换、描述文件注册、应用数据库更新设置可恢复日志。Windows 的多步重命名不是整个安装事务的原子操作，应确保失败和重启后都能恢复原版本或完成新版本。安装成功状态只在校验、目录切换和本地注册全部完成后写入。
6. **取消。** 下载/解压前后的取消应终止网络和文件流、停止后续提交，且不影响旧版。提交阶段需要明确的不可中断小段或事务回滚；不要在收到取消后仍返回“已安装”。清理范围限于任务自己创建的临时路径，清理失败保留可识别记录。
7. **更新。** 使用服务端 revision 与本地已安装 revision 比较，在新 staging 内下载完整包；失败保留旧版。重新获取元数据发现上游新版本时，可以提示下一次更新，不能把当前任务的包和旧摘要混合。固定版本、缺失版本、无权限、发布处理中需分别呈现。
8. **卸载与账号。** 本地卸载仅移除应用管理的该模组安装和相应注册。账号取消订阅是另一个有独立错误结果的动作；避免下载/安装失败时误报订阅成功，也避免取消订阅后无条件删除用户自建源目录。

当时的验证建议是先用本地 HTTP fixture 和生成的小 ZIP 覆盖正确包、截断、长度溢出、摘要不符、重定向、路径穿越、取消、更新失败回滚及重启恢复。后续完成程度与新增真实资源证据见 [Roadmap](../ROADMAP.md)；真实公开包、账号授权与游戏加载须分别验证，不能由本次 HEAD 推断成功。

## 官方 CPatch：可见契约与未知部分

官方 launcher 通过子进程运行 CPatch daemon。静态参数包括 Windows 的 `--disableHardLink`、可选 `-q`、`-l <log>`、`daemon -p <port>`。本研究没有运行、复制或分发该程序。

socket 命令外层形状：

```json
{
  "type": "command",
  "opId": "<operation UUID>",
  "data": {
    "type": "<command>",
    "data": {}
  }
}
```

`patch` 的字段为 `repository`、`appName`、`repositoryType`、`sourceDirectory`、`targetDirectory`、`targetVersion`、`newestVersion`、`backendUrl`、`xDeltaPath`；`repositoryType` 为 `cdn` / `url` / `local`。

PDX 模组安装服务把 `repositoryPath`、`name`、安装目录和指定版本传给此接口，并在可用时提供旧目录作为 source。其他可见命令包括 `patch-size`、`versions`、`installed-version`、`repair-installation`、`uninstall`、`cancel`、`pause`、`download-speed-throttle`、`set-auth-token`。

| 操作           | 静态可见内容                                                                  |
| -------------- | ----------------------------------------------------------------------------- |
| 查询已安装版本 | 结果包含 `version`、`pausedPatch`；`version:"-1"` 表示未安装                  |
| 暂停恢复       | 暂停记录的 `toVersion` 与目标一致时保留目标目录；具体持久化格式未确认         |
| 取消           | payload 为 `{opIdToCancel}`                                                   |
| 暂停           | payload 为 `{opIdToPause}`                                                    |
| 登录令牌       | `set-auth-token` payload 为 `{authToken}`，注销置空；没有验证具体网络使用方式 |
| 本地记录       | 常量包含 `.cpatch` 目录和 `version` 文件名；不能据此臆造完整格式              |
| 进度           | 初始化、元数据、依赖、下载 patch、应用 patch、完成等阶段                      |

在首次研究时，独立完整包方案尚未实现签名、增量或暂停恢复，不能用下载/校验结果代替这些能力。后续自有暂停与手动恢复在 0.7 实现，0.13 接入 [完整资源 HTTP 授权](pdx-protected-repository.md)，0.15 建立 [官方签名信任链](pdx-signatures.md)，0.19 接通 [单 ZIP 补丁下载与重建](pdx-delta-core.md)。这些是本项目实现；官方内部缓存/断点格式兼容、通用操作及多目标仍未完成，不能伪造 `.cpatch` 文件让官方客户端误判安装状态。

## HOI4 V1 发布流程

这是官方静态实现确认的接口形状，**未执行真实上传或发布**。HOI4 LFV0 使用 V1 ZIP publisher；它与其他游戏可能采用的 V2 presigned upload / loose-file 流程不同。

### 所有权与更新前置检查

```text
POST /mods
Content-Type: application/json

{"gameNames":["hoi4"],"onlyModsByMe":true}
```

官方通过当前账号返回的 `mods[].modId` 匹配 remoteId 来检查已发布模组归属。更新前获取 `GET /mods?modId=<id>`，用 `modDetail.name` 作为 publication name；`modDetail.updating:true` 时拒绝重复发布。新模组生成 UUID publication name。

不要用作者显示名相等推断所有权，也不要将匿名详情中的 `actions.canPublish:false` 理解为该模组永远不能被所有者更新。实际授权需要当前账号；协作者权限、私有模组与过期会话需依实际响应处理。本次未调用账号的 owned-mods 查询。

### 内容上传与提交

```text
PUT /mods/content/hoi4/<modName>/<fileType>/<filename>
Content-Type: application/octet-stream
Content-Length: <bytes>

<stream>
```

`fileType` 包括 `content`、`thumbnail`、`screenshot`、`descriptionImage`。官方将文件 basename 的非 word 字符去除后保留扩展名，再作为上传文件名；项目应另外检查清理后为空、冲突和路径注入。不要把输入文件完整路径发送给服务端。

```text
POST /mods/publish        # 新建
POST /mods/publishUpdate  # 更新，body 额外包含 modId
```

提交 body 的公共字段：

```json
{
  "modName": "<publication UUID>",
  "gameName": "hoi4",
  "contentFileName": "<uploaded ZIP filename>",
  "thumbnail": "<uploaded thumbnail filename, if supplied>",
  "os": "Any",
  "arch": "Any",
  "longDescription": "<description>",
  "shortDescription": "<summary>",
  "displayName": "<title>",
  "tags": [],
  "recommendedGameVersion": "*"
}
```

更新还包含 `modId` 与 `changelogEntry`；新建会省略 `changelogEntry`。官方将缺失的推荐游戏版本回退为 `"*"`，空更新说明回退为单个空格，并将标签截取到最多 10 个。

静态代码消费的返回值是 `{modId,state}`，状态含 `publishing` / `published`。官方在 `publishing` 时等待 2500 毫秒，然后登记返回的 modId；这不构成服务端处理已经完成的证明。本项目应保留已创建 ID，将任务显示为“处理中”，用详情的 state/updating 确认后续状态。超时应保留 ID 与可恢复状态，防止重试误建重复模组。上传成功和发布成功也需分别记录。

### ZIP 打包契约

官方 LFV0 从 `dirPath || archivePath` 取源。输入为 `.zip` 时复用归档；输入为目录时打包目录内容。静态 packager 调用语义是 **内容置于 ZIP 根部，不加源目录外层**；默认压缩配置为 zlib level 1。LFV0 发布前会更新 descriptor 的 supported version，再上传内容和可选缩略图，完成后清理临时 ZIP。

本项目建议对源目录建立受控快照，在快照中更新 descriptor，避免打包前修改用户工作文件。归档使用任务独占临时位置，避免官方相邻 `<name>.zip` 路径可能覆盖既有文件的问题。对 symlink/reparse point 的处理需显式制定，不能把源目录链接到的任意外部文件带入上传。

官方大小验证阈值为 `5 * 1024 * 1024 * 1024`，`size >= threshold` 拒绝；这证明客户端的检查规则，不保证远端一定接受所有小于此值的文件。服务端配额、缩略图约束及其他校验仍需按照实际响应处理。账号请求使用项目已有的主进程账号服务，令牌不进入渲染进程、错误日志或研究记录。

## 首次研究结束时尚未验证的事项（历史快照）

以下清单描述 2026-10-28 当时的边界，保留以说明原始证据强度。签名、补丁、自有恢复等后续进展以及新增真实资源核验见 [内容地址及补丁路径](cpatch-download-paths.md)、[增量下载与缓存](pdx-delta-core.md) 和 [Roadmap](../ROADMAP.md)；不能将此历史清单直接当作当前未实现列表。

- 当时未验证真实 ZIP 下载的摘要一致性、内部目录结构和在 HOI4 中的实际加载；该次只有 manifest 与 HEAD。
- 私有/历史/区域受限内容的完整授权路径；样本历史详情为 401，未绕过此拒绝。
- HTTP 206 恢复、强校验器稳定性、边缘缓存与上游改版时的行为。
- manifest 第 4/5 项的语义、多个记录的完整语法、CPatch 签名与 delta 细节。
- 使用本项目账号的 owned-mods 查询、上传、发布、状态轮询、协作者更新与取消上传后的服务端清理。
- 第三方账号接入的实际服务端兼容性；已定位接口并不等于账号端到端通过，但缺少额外公开政策材料本身也不是拒绝实施已授权功能的依据。

这些限制应进入验收记录，不应把已实测可用的匿名当前版本下载路径一并标为不可实施。
