# 官方安装补丁与隔离安装验收 · 2026-10-29

0.19.0 交付后，对固定公开 HOI4 仓库的真实 `-1_to_3` 安装补丁补核。生产模块与原便携版保持一致；这是追加验收证据，不是新版本或重新打包。先前两组真实 `p` 差分及其独立归档见 [大 ZIP 差分验收](official-patch-acceptance.md)。

## 实际安装补丁

仓库为 `hoi4/6cca83a0-a6ec-11f1-92e5-affbeaa2abe2/repo/Any__Any/`，目标 revision `3`。使用生产 `createPdxIntegrity`，分别重新获取目标 complete 和 `-1` 补丁的原始清单、分离签名、仓库认证及当次撤销状态；验证通过后，匿名下载实际补丁正文，限制为 8 MiB/s。没有下载 complete 正文，也没有提供旧源 ZIP。

| 对象          |      字节数 | SHA-256                                                            |
| ------------- | ----------: | ------------------------------------------------------------------ |
| `-1_to_3.zip` | 559,180,000 | `14aaa1aa9c03faf8aa0306a5b80021c81cf72a5d5acaba389dd34273e8a0f0a8` |
| 重建目标 ZIP  | 561,485,374 | `25594cbf8ebbe81b1beff1a8ca276258ebe23cb2457c68e2e92c3057c57d5b2c` |

实际容器是单条 `n` 操作。生产容器校验外 ZIP 摘要、目录与 local header、条目名、展开大小及 CRC，再将内含完整 ZIP 提取到生产安全工作区。签名声明的展开总量为 561,485,418 字节，含 44 字节 operations；输出的字节数、累计摘要及落盘重读摘要均匹配独立验签的目标 complete。工作区 `finish()` 和 `proofs()` 通过，重建至生成证明共 310,087 ms，不含前置下载与复制。

执行脚本为 [.work/verify-official-install-patch.cjs](../.work/verify-official-install-patch.cjs)，原始报告为 [official-install-patch.json](../test-results/official-install-patch.json)，日志为 [official-install-patch.txt](../test-results/official-install-patch.txt)。大型原始补丁、工作区补丁副本和重建 ZIP 保留在报告列出的 `.work/official-install-patch-<random>/`。

## 隔离安装路径

[安装验收脚本](../.work/verify-official-install.cjs) 只接受上述固定目标及近期成功报告，核对报告摘要、官方根/仓库 fingerprint、生产证明的文件身份、完整目录链及目标 ZIP 摘要。安装前只读预检中央目录：8,522 条，含 8,155 个文件及 367 个目录，声明展开 917,031,187 字节，最大文件 34,603,062 字节，根 `descriptor.mod` 为 1,724 字节。

本次预算比产品限制更小：最多 20,000 条、5 GiB 展开；创建目录前检查可用空间至少为展开量加 512 MiB 及每条目 64 KiB 余量。生产安装器仍执行自己的 100,000 条、20 GiB 展开、5 GiB 归档及路径、CRC、链接、描述文件检查。

所有安装写入均位于新建的 `.work/official-install-<random>/`：`storage/` 保存受管内容、数据库和可信逐文件索引，`game-user/` 仅保存本次隔离注册。调用生产 `install` 后执行 `verify/list`，重建服务对象并调用 `recover`，再次 `verify/list`，最后重新核对原 ZIP、输入报告及运行源码摘要。安装器不独立验签，上游报告提供已验证的 complete 计划；本地 `modId:"1"` 仅为验收绑定，不是从仓库 UUID 推断真实目录 ID。

实际安装通过：8,155 个普通文件在提交后与服务重建后的两次检查中均为 `intact`，全部文件已检查，缺失、改动、多余和不安全项均为 0，注册描述文件完整，两次 `list` 与安装返回记录一致。正常重开 `recover()` 返回 `{recovered:false,action:null}`，没有遗留事务或锁。原 ZIP 的大小、SHA-256 和文件身份不变，安装、两次检查及最终核对共 250,060 ms。内部 descriptor 按生产规则净化；可信索引基于净化后字节，因此不把它与 ZIP 内原 descriptor 摘要混为一谈。

实际安装结果见 [official-install.json](../test-results/official-install.json)，执行日志见 [official-install.txt](../test-results/official-install.txt)。API 与检查边界的独立审查见 [.work/official-install-review.md](../.work/official-install-review.md)。控制证据包含安装数据库、完整性索引和生成的外部 `.mod`；大量展开文件保留在项目隔离目录。

## 证据与边界

本轮汇总归档为 [official-install-acceptance-2026-10-29/verification-summary.json](../test-results/official-install-acceptance-2026-10-29/verification-summary.json)，包含原始小型签名材料、日志、控制证据、脚本及相关生产模块/文档快照。大型文件另行完整重算摘要，不在归档重复保存。原始 0.19 交付及两组 `p` 差分归档保留；本轮重核其 271 与 76 份输入摘要，并核对便携包未变，见 [原证据检查](../test-results/official-install-prior-evidence-check.json)。原交付的 1,138 项系统 Node 和 54 项常规无界面 UI 结果不计为本轮重跑。

真实 `n` 安装补丁与两组 `p` 差分提供具体字节兼容证据，不能推断所有仓库、编码器参数或真实 `k` 样本已通过。通用 `c/d/s`、多操作/多目标以及官方内部缓存/断点格式仍未实现。隔离安装验收直接组合生产模块，没有经过真实下载协调器、账号授权或 Electron IPC；重建服务对象的正常重开也不等于进程重启或中断事务恢复。

全程仅使用系统 Node 和匿名公开数据；未运行 Electron、便携程序、官方 CPatch/xdelta3、游戏或 Steam SDK，未登录账号、写入真实玩家目录或操作前台窗口。先前自动审批拒绝 Electron 启动（`blocked by policy`），没有更换方式重试；新版桌面运行和真实账号/游戏/Steam/发布仍待验收。完整官方对齐目标保持进行中，本地便携分发和不配置自更新的决定保持不变。
