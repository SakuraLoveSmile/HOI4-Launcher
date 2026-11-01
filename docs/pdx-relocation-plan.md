# PDX 内容目录迁移与恢复

2026-10-29，已实现于 0.5.0。官方依据见 [在线调查](online-integration-research.md)。本实现使用“所选父目录/hoi4/ironclad”存放受管内容，通过外部 .mod 的绝对路径注册。

## 用户操作与范围

设置页提供选择位置和恢复默认。先预览当前位置、目标、版本、文件数、展开大小及冲突，确认后才迁移。复制及校验可取消；注册切换与收尾阶段等待完成。关闭窗口会说明中断及下次恢复行为。

迁移当前游戏用户目录下有完整记录的当前安装及可验证保留版本。描述文件名、模组 ID、revision 和预设引用保持不变，其他游戏用户目录的位置独立保存。官方安装、官方 SQLite/junction 和用户本地模组不在迁移范围内。

v1 未索引的旧目录、被修改的保留版本和无法确认身份的内容原地保留并显示位置。当前安装的注册或内容无效会阻止提交，不能只迁移 list() 返回的完整项后误报全部完成。

## 数据与接口

控制文件固定在 %APPDATA%/IRONCLAD/pdx/installations/。默认内容根也在这里；自定义只改变版本内容所在根。数据库 v2 包含 generation、roots、按 userDataPath 关联的 locations、records 和 retainedVersions；版本记录关联 contentRootId。读取兼容 v1，后续写入保存 v2，新更新/卸载的保留版本也记录身份和注册备份。旧版启动器不能管理 v2 数据库。

- planRelocation({userDataPath,targetParent}) 返回 planId/from/to/installations/files/bytes/retainedLegacyPaths/conflicts/isDefault；targetParent 为 null 时恢复默认。
- relocate({planId,signal,onProgress}) 返回 moved/retainedPaths/warnings/location。
- getStorageState({userDataPath}) 返回 location/defaultLocation/isDefault/retainedLegacyPaths/recoveryRequired。
- cancelRelocationPlan(planId) 仅丢弃未提交计划。

installations 按版本列出 modId/revision/title/transactionId/retained。计划保存在后端，只接受对应 planId 提交，不能由渲染器改文件清单。提交前重新检查数据库、源文件指纹、注册、当前游戏用户目录和目标身份。进度包含阶段、字节、文件数量及 cancellable。

pdx-relocation.cjs 协调预览、确认、取消、状态和重试恢复，进度读取不等待复制结束。命名 IPC 为 pdx-storage:state/prepare/commit/discard/cancel/recover；目标由主进程原生对话框选择，渲染器不能传任意路径。

## 事务与恢复

迁移与安装共用队列及跨进程锁，先恢复旧事务。迁移、下载、发布、游戏目录切换及缓存维护相互检查；启动前等待恢复，并在异步检查后重新核对是否出现新操作。

先复制至目标卷专属暂存目录，校验展开文件清单、摘要及身份。目标根先登记以便发现中断遗留，当前位置只随最终数据库提交改变。独立迁移 ID 与数据库快照确定提交边界：准备注册备份，在目标卷内重命名副本，切换自有外部描述，最后提交位置与版本记录。

数据库提交前失败恢复原注册，提交后恢复验证新注册并收尾。目标完整验证后才清理原内容；删除前复核从卷根到内容根的完整身份链、内容内父目录身份及文件摘要/身份/时间戳，避免同一文件经新插入的junction被误删。外来修改保留并报告，禁止递归删除整个旧根。

恢复记录与磁盘状态不一致时保留 RECOVERY_REQUIRED，阻止启动及其他目录写操作。设置页“重试恢复目录”成功后解除保护。不会自动重放新迁移请求；事务日志决定完成或回滚方向。启动恢复和失败清理保留的路径会交给界面显示。

## 验证边界

后端覆盖空库、自定义目录互迁、恢复默认、多版本、不同游戏用户目录、官方同 ID 注册共存、v1 升级、空间不足/卷离线、路径替换/链接/硬链接、复制取消、各注册提交边界故障及重启，以及后续安装/更新/卸载。

协调器验证快速进度、单次提交、取消与恢复保护；实际 main.cjs 的 VM 测试验证命名 IPC、发送方、启动竞态、双向互斥和退出提示，外部操作均为受控替身。

隐藏 Electron 验证 UI 预览→自定义→默认位置，检查预设及固定 revision 不变、原副本释放。scripts/check-relocation-volumes.cjs 使用临时夹具实际完成 C 盘→D 盘→C 盘，证据在 test-results/relocation-volumes.json。没有迁移真实游戏或用户模组，没有打开可见窗口。
