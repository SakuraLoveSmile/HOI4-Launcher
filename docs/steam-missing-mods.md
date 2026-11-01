# Steam 预设缺失模组补齐

0.8.0新增当前预设的Steam缺失引用审阅与批量提交。导入官方SQLite/JSON或打开预设不会自动订阅、下载或初始化Steam SDK；只有用户连接Steam、审阅名单并确认后才提交。最终0.8.0验证结果以 [ROADMAP.md](../ROADMAP.md) 的本轮核验段为准。

## 用户流程

1. 在Steam面板主动连接，在“补齐预设模组”选择“审阅补齐计划”。名单来自当前预设中磁盘文件不可用的 `workshop:` 成员，按原顺序去重，包含未启用成员。Paradox与本地引用不进入Steam名单。
2. 确认Steam账号、预设、模组名称/ID及启用状态。审阅和结果每页40项，完整支持现有设置合并后最多20000个成员，不静默截去超过一页的内容。
3. 点击“确认订阅并请求下载”后逐项处理。未订阅则订阅；已下载/排队的项目不重复请求，已安装且无需更新的项目跳过下载；其余使用普通优先级请求。原预设的顺序、关闭成员、启用状态和DLC选择保持不变。
4. “停止后续请求”只阻止还没提交的项，不能撤回正在进行的订阅请求、取消已经订阅的项目或停止Steam已接受的下载。当前请求的最终结果仍会记录；下载带宽和暂停请在Steam客户端管理。
5. 查看逐项结果，待文件到位后“刷新本地模组”。`已提交至 Steam`、`已确认订阅`、`已接受下载请求`以及SDK的installed状态均不直接清除本地缺失引用；必须由启动器磁盘扫描确认模组内容可用。已启用的缺失成员继续阻止启动，关闭成员不会被补齐流程自动启用。

## 审阅与执行边界

主进程 `createSteamMissingService` 提供 `prepare({playsetId})`、`commit(planId)`、`getState()`、`cancel()`、`isBusy()`、`dispose()`。渲染器的命名接口为 `prepareSteamMissingMods`、`commitSteamMissingMods`、`getSteamMissingMods`、`cancelSteamMissingMods`，对应 `steam-missing:prepare/commit/state/cancel`。渲染器不能直接传待处理ID列表、文件路径或目标账号。

`prepare`读取真实启动器状态，生成只保存在内存中的一次性审阅，绑定账号、预设成员/顺序/启用状态、游戏目录与游戏用户目录。`commit`再次核对上下文与磁盘可用性，成员或路径变更要求重新审阅；审阅后已出现在磁盘上的项可以跳过，不扩大已确认的名单。提交先保存queued任务，再立即返回可轮询的快照，随后按顺序执行。

每项提交前持久保存checking边界，再调用worker专用的 `repairItem({id,expectedSteamId})`。worker不重扫整个订阅库，而是读取未缓存的条目详情；先核对ID、HOI4 App ID 394360、非封禁状态，并在异步查询、订阅及下载边界重新核验当前Steam账号和游戏身份。订阅与下载分别记回执，下载调用为 `download(id,false)`，不使用会暂停其他Steam下载的高优先级。

执行前和每项之间核对游戏运行、发布、其他下载/安装及目录迁移等互斥条件。账号变化、无法核验账号、游戏身份变化或操作门禁关闭时停止后续请求。只读任务状态保持可响应，进度条表示名单请求处理数量，不是下载字节或安装进度。

## 回执、持久化与恢复

任务记录保存在 `%APPDATA%/IRONCLAD/steam-missing/missing-mods.json`。持久化内容包括最近任务的预设、审阅时的Steam账号标识/名称、时间、请求前意图、逐项结果及终结汇总，不保存账号凭据。审阅计划本身不跨重启保留。

v2 使用逐行 JSON：首行为 `{version:2,type:"snapshot",job}`；每项意图与回执追加 `{version:2,type:"item",jobId,sequence,index,state}`，只存动态状态，不重复名称和启用值。每条记录最多 8 KiB，文件最多 256 MiB。任务开始和结束各保存一次完整快照，结束时原子替换同一文件，避免不同文件代次不一致；兼容读取 v1，重开不会改写旧记录。20,000 成员、160 个中文名称字符和 500 个中文错误字符的计量预算约 127.3 MiB 总写入，随成员数量线性增长；测试只实际执行两项后取消，并核对最坏完整快照可重开。

| 字段              | 含义                                                                                                                                           |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 任务 `status`     | queued/running/cancelling为进行中；completed表示请求处理结束；partial表示含明确失败；cancelled为停止后续请求；interrupted或blocked需要核对提示 |
| 条目 `status`     | pending/checking/submitted/skipped/failed/unknown/cancelled；skipped对应无需重复请求，cancelled为此项未提交                                    |
| `subscription`    | unchanged、confirmed或unknown；订阅确认与下载是否接受分别记录                                                                                  |
| `downloadRequest` | not-requested、already-active、accepted、rejected或unknown；accepted不表示文件已安装                                                           |
| `observed`        | 当次SDK观察到的订阅/安装/更新/下载/排队状态与可用字节计数，不代替本地磁盘扫描                                                                  |

明确的单项失败保留原因，后续项可继续。结果未知、无效回执、worker退出或RPC超时则停止后续提交，不自动重试。RPC超时不代表原生操作已结束：客户端保留该请求的占用，直到worker明确报告完成、迟到的最终回执到达或进程退出；期间不允许重叠写操作或断开连接。worker可用缓存状态回复只读查询，避免排在挂起写操作后面。

持久化顺序为请求前先同步意图、收到回执后保存逐项结果、结束时保存终结汇总。追加前后核对普通文件身份、长度及修改时间；短写或同步失败时不更新可信长度，阻止后续汇总覆盖不确定尾部。重开保留未完成的末尾行，完整损坏记录则保留原文件并报错。终结替换失败仍可从原日志恢复已确认结果。保存失败停止后续项；磁盘记录可能仍停留在先前的不确定边界，必须核对Steam实际状态。重启恢复只还原已经持久保存的状态，不补发请求。

重开仅加载本地记录，不连接Steam，也不重放任何订阅或下载。遗留活动任务改为interrupted，checking项改为unknown，pending项改为cancelled。需要用户重新连接、刷新状态与磁盘，再审阅仍缺失的引用；不能把重新打开应用视为继续授权。

## Steam 下载选项的适用范围

官方2026.12的限速菜单只向CPatch发送带宽限制，不向Steam设置速度。本项目采用的steamworks.js接口只有普通/高优先级下载请求及订阅/状态，没有单项限速、暂停或撤销已接受下载的接口。Steam限速与暂停由Steam客户端控制，不属于待补的官方对齐缺口；IRONCLAD自有Paradox完整ZIP下载的限速、暂停与续传是另一套流程。证据见 [在线集成调查](online-integration-research.md#下载限速的实际范围2026-10-29-补核)。

## 验证范围

`tests/steam-missing.test.cjs` 覆盖审阅名单、关闭成员、大预设、一次性提交、目录/成员变化、取消、未知结果、持久化失败和重启不重放。`tests/steam-workshop.test.cjs` 覆盖逐项详情/账号核对、普通下载优先级、已有状态及回执区别；`tests/steam-worker-client.test.cjs` 覆盖超时后占用、迟到结果与真实worker消息协议的模拟连接。main/preload边界由 `tests/main-migration.test.cjs` 验证。

本轮系统Node全套638/638通过，常规无界面UI 54项通过；`scripts/test-steam-missing-ui.mjs`另外使用真实启动器/协调器及模拟原生Steam，验证43项计划与结果分页、关闭成员/顺序、下载优先级、取消、换号、回执丢失、磁盘刷新及重开不重放。证据在 `test-results/0.8.0/`，制品校验见 [ROADMAP](../ROADMAP.md)。开发验证使用隔离目录、模拟Steam/进程及无界面浏览器，不启动真实游戏、Steam SDK或前台应用；新版Electron运行时和真实订阅/下载仍待验收。
