# 单 ZIP 增量下载、原始缓存与解码内核 · 0.20.0

0.20 新增 [通用清单与操作规划底座](pdx-patch-planning.md)，并扩展既有单 ZIP 链：空 operations 可复制可信不变旧ZIP，同目标可有一个 `d` 加一个 `n/p/k`，`p` 可使用空旧源。**下载能力仍仅限生成一个目标ZIP，通用多条目计划不授予文件系统权限。** `c/s`、任意多目标执行及官方内部缓存/断点兼容仍待完成。

0.19 已接通可信目标 complete、独立验签补丁、原始 ZIP 缓存、VCDIFF/XZ、安全暂存与原安装事务，交付后补验两组真实官方大型 `p` 差分及实际 `n` 安装补丁，见 [实际 ZIP 重建](official-patch-acceptance.md) 与 [安装补丁验收](official-install-acceptance.md)。这些是0.19历史真实资源证据；0.18缓存/独立内核及各版验证结果保留在 [Roadmap](../ROADMAP.md)。

## 可信计划与补丁选择

[内容服务](../electron/pdx-content.cjs) 先 `resolve()` 目标 complete：验证固定官方根、仓库公钥认证、原始 repository/manifest 分离签名及新鲜撤销状态，再为该 canonical 计划建立不可序列化的主进程能力。`getPatchSize(plan,{resolvedPlan,fromRevision})` 和 `resolvePatch(plan,{resolvedPlan,fromRevision,signal})` 必须绑定这个能力，不能用序列化计划或渲染层输入制造补丁权限。

`resolvePatch()` 独立取得补丁 manifest、签名和所需仓库材料并重新验签；补丁压缩/展开大小须与可信仓库声明一致，目标 completeSize 须与目标计划一致。补丁 ZIP 以独立的大小和 SHA-256 传输，完整重建结果仍须匹配目标 complete 的大小和 SHA-256。账号模式对公钥、原始元数据、签名、清单及 ZIP 各自授权，不把账号凭据或授权 URL 发到 IPC、日志或断点。

普通更新只在已安装旧 revision 对应的声明补丁**小于目标 complete**时尝试优化：重新解析并验签旧版，核对其归档摘要与受管安装记录一致，再打开经过完整摘要核对的原始 ZIP 缓存 lease。缓存缺失、损坏、预算/存储错误或旧源优化不可用时，初选使用目标 complete；不会把已安装目录重新压缩充当旧源。取消、会话变化、目标/签名错误等仍停止。

选定补丁后不再静默降级：补丁授权、签名、下载、容器、源字节、解码或目标校验失败均停止。恢复既有补丁片段时必须重新取得同一补丁和旧源计划、核对缓存；旧源不可用则保留片段并要求取消后另开完整下载。`files` 实际 404 且可信仓库声明 `-1` 才使用无旧源的安装补丁；未声明 `-1` 保留 files→同版 complete 兼容，详细条件见 [内容地址及补丁路径](cpatch-download-paths.md)。

协调器的持久状态分别保存：

| 字段           | 身份                                                                                                |
| -------------- | --------------------------------------------------------------------------------------------------- |
| `plan`         | 目标 complete 的固定 revision、文件名、大小及摘要，供重建结果和安装使用                             |
| `transferPlan` | 已选补丁的 `kind:"patch"`、`fromRevision`、实际压缩/展开大小、摘要和路径；完整传输时省略            |
| `sourcePlan`   | 版本差分旧 complete 的重新验签身份；`-1` 安装补丁不携带旧源                                         |
| `checkpoint`   | 实际传输计划（补丁为 `transferPlan`，否则为 `plan`）的 planKey、前缀大小/摘要、ETag 与文件/祖先身份 |

这些快照不保存可信能力、缓存 handle 或授权 URL。补丁片段位于 `patch.zip`；恢复只针对同一实际传输计划发送精确 Range/If-Range，200 响应表示从头下载同一传输包，不能把补丁断点接到目标 complete。空operations归档的已签名 `unpackedBytes` 可以为0，必须在repository、补丁manifest、transferPlan及checkpoint key中一致保留；ZIP包体与目标ZIP仍须有正字节数。重开不自动联网。

## 当前下载中的缓存

[主进程](../electron/main.cjs) 将 [原始归档缓存](../electron/pdx-archive-cache.cjs) 注入 [下载协调器](../electron/pdx-downloads.cjs)，位置为应用数据目录下 `pdx/archives/`。完整 ZIP 下载或补丁重建并通过目标大小及摘要校验后，安装前可选保存；旧源选择时打开缓存：

```js
const cache = createPdxArchiveCache({
  storageDirectory,
  maxBytes: 10 * 1024 ** 3,
  maxEntries: 32,
});
await cache.put(plan, { sourcePath, signal });
const lease = await cache.open(plan, { signal }); // 未命中返回 null
// lease: { bytes, sha256, read(offset, length), close() }
```

`plan` 至少含十进制字符串 `modId/revision`、正整数字节数 `bytes` 和小写 hex `sha256`。缓存以原始 ZIP 的完整 SHA-256 命名，核对字节数与摘要，不重新压缩已安装目录。调用方必须先重新验签并核对当前账号权限；缓存命中本身不授权内容，也不证明某份补丁的来源或目标。

`put` 先完整校验源文件，再从稳定 handle 复制到独占暂存，核对暂存摘要并同步后无覆盖提交。`open` 在返回固定 handle 的 lease 前重新校验整个缓存文件；每次精确读取前后检查文件与祖先身份、文件时间、大小、链接数及真实路径。单次 `read` 最多 8 MiB，内部按 64 KiB 分块；调用方须在 `finally` 中 `close()`。源、缓存或暂存被替换、篡改，或涉及符号链接、目录联接及外部硬链接时停止，未知内容保留。

默认容量为 **10 GiB / 32 项**。同内容经验证后复用；进程内队列与独占磁盘锁保护并发，无覆盖提交避免相互覆盖。满额返回 `CACHE_FULL`，不自动淘汰旧项；未知片段保留并计入预算。未知或崩溃遗留锁不自动删除，等待最多5秒后返回 `CACHE_BUSY`。本缓存独立于官方内部缓存，尚无 GC。

保存缓存的容量、损坏或存储错误不会使已验证目标 ZIP 的安装失败；安装仍经过原有验证与事务。初选时缓存不能提供可信旧源则用目标 complete；已选补丁恢复期间的旧源缓存失败则停止。用户暂停、取消或账号会话失效的信号传播到缓存操作，并阻止继续安装；恢复重新取得计划和授权。缓存存在不会跳过在线权限或签名核对。

## 单 ZIP 容器与安全工作区

[pdx-patch-archive.cjs](../electron/pdx-patch-archive.cjs) 通过有界随机 reader 打开已验证补丁 ZIP，核对目录、条目大小、CRC、压缩比和解压总量。`operations` 必须是有界UTF-8，所有操作只能命名调用方可信complete指定的同一简单ZIP文件名。复用 [通用计划器](pdx-patch-planning.md) 后，当前执行子集如下：

| 操作              | 容器内容与行为                                                                                 |
| ----------------- | ---------------------------------------------------------------------------------------------- |
| `n`               | `operations` 和同名目标 ZIP，提取后核对目标完整摘要                                            |
| `p`               | `operations` 和 `<目标文件名>.vcdiff`，先写入并重读scratch，再以可信旧源或0字节空源执行VCDIFF  |
| `k`               | 仅 `operations`，完整核对旧源后复制，并按目标 complete 摘要验证                                |
| 空operations或仅d | 仅 `operations`，必须有与目标大小及摘要一致的可信旧ZIP，规划为 `implicit:true` 的k并重读源摘要 |
| d加n/p/k          | 最多一个同目标d与一个producer，文本先后次序均可；对新的空target执行逻辑删除后重建，旧源不变    |

`c/s`、多个producer、重复d、其他目标、额外payload、链接/危险路径和不支持的容器均拒绝；不是任意两行操作都可执行。已选补丁不会因此自动改取complete。operations上限64 KiB，单行还必须小于64 KiB；ZIP初步条目预算8，最终仅接受上述1或2个条目。patch/payload/目标各最多5 GiB，展开总量最多5 GiB + 64 KiB，压缩比最多1000。空operations不允许跳过源/目标摘要检查，无源p也不能解码引用不存在旧源的COPY。

[安全工作区](../electron/pdx-patch-workspace.cjs) 只操作协调器已建立的独占staging子目录，不创建目录或删除文件；新增d阶段没有扩展其物理删除权限，也不会修改旧安装或缓存lease：

```js
const workspace = await createPdxPatchWorkspace({ directory, signal });
const patch = await workspace.openPatch({ bytes, sha256 }); // patch.zip
const scratch = await workspace.createScratch(); // patch-data.bin
const target = await workspace.createTarget({ bytes, sha256 }); // content.zip
await target.finish();
const proofs = await workspace.proofs();
await workspace.close();
```

文件只打开/创建一次；writer 使用 `wx+`、顺序追加和调用前输入副本。固定 handle、路径、大小、纳秒级 mtime/ctime、单硬链接、realpath、目录及全祖先身份在分块 I/O 前后复核，拒绝符号链接、目录联接、硬链接、替换和篡改。`read` 精确返回最多 8 MiB，write 支持最多 64 MiB 窗口，内部按 64 KiB 分块；失败 writer 永久不可复用。追加后的首次读取完整核对当前前缀与累计 intended hash，防止自己的 stat 刷新意外认可外部修改。

`finish()` 要求目标长度、累计摘要与可信 complete 一致，fsync 后完整重读落盘 SHA-256，返回普通数字 `{ino,dev,birthtimeMs,size,mtimeMs,ctimeMs}`。`proofs()` 等待已排队操作、阻挡后续 I/O/创建，完整验证当前每个文件的前缀摘要并重检全部身份，返回冻结的 `[{name,bytes,sha256,identity}]`；只允许三个固定 name，空 scratch 或部分 target 也可证明。取消或任何证明错误均停止，不忽略 signal 强行生成清理许可。`close()` 幂等释放全部 handle，即使取消也执行，关闭失败可重试。

协调器保存 scratch/target 的证明，补丁自身沿用传输摘要与身份记录；清理器独立再次核对身份和字节摘要，只删除有证明且仍匹配的普通文件。未知条目、未知尾部、取消/崩溃未取得证明的中间产物及外部变化保留并报告。重建成功后仅把目标 `content.zip` 和目标 `plan` 交给原安装事务；补丁应用可取消不可暂停，提交仍由原事务决定，旧内容、注册备份和预设保留。

## VCDIFF 接口与验证

[pdx-vcdiff.cjs](../electron/pdx-vcdiff.cjs) 导出：

```js
await applyVcdiff({
  source: { bytes, read },
  patch: { bytes, read },
  target: { read, write },
  expectedSourceSha256,
  expectedTargetSha256,
  expectedTargetBytes,
  signal,
  limits,
  onProgress,
});
```

`read(offset,length)` 必须返回精确长度的 Buffer；`target.write(buffer)` 顺序追加完整窗口，`target.read` 支持读取已写内容。返回值为 `{bytes,sha256,windows}`。内核不自行打开文件、请求网络或决定账号权限；调用方负责稳定文件访问、目标暂存和失败回滚，以及在解码前验证补丁清单签名与补丁包体摘要。该接口没有代替上述验证的 `expectedPatchSha256` 参数。

已实现 RFC 3284 默认码表的 ADD、RUN、COPY 及双指令编码；支持 SELF/HERE、四项 NEAR 与三组 SAME 地址缓存、重叠 COPY、源片段偏移和 `VCD_TARGET` 已完成窗口引用。每窗口重置地址缓存，严格检查整数、标志、窗口边界、指令与数据/地址段耗尽，拒绝未来地址。自定义码表及非 ID2 的二次压缩器返回不支持。

先完整核对 source SHA-256，再写 target；有窗口 Adler-32 字段时先校验窗口再写入。完成后核对总字节数、生成过程中的完整 SHA-256，并通过 `target.read` 重读目标核对同一可信摘要。任何失败都不表示部分目标可安装。进度观察器不能控制校验结果；长循环让出事件循环并检查取消。

默认硬上限如下，`limits` 只能降低已知项：

| 资源               | 上限与范围                                                      |
| ------------------ | --------------------------------------------------------------- |
| source / target    | 各 5 GiB；source可为0字节，按回调分块读写，不将完整归档装入内存 |
| patch              | 5 GiB                                                           |
| 单个目标窗口       | 64 MiB                                                          |
| 编码段             | 每窗口 data/instructions/addresses 三段合计 64 MiB              |
| 解码段             | 每窗口三段解码后合计 64 MiB，解压前核对声明长度                 |
| 窗口 / 指令        | 100,000 个窗口、10,000,000 条指令                               |
| application header | 64 KiB，仅有界读取，不作为可信路径                              |
| WASM 线性内存      | 三个 XZ context 共享最多 64 MiB                                 |

## XZ ID2 与内存边界

[pdx-xz.cjs](../electron/pdx-xz.cjs) 的 `createXzSections({signal,maxMemoryBytes,maxDecodedBytes})` 返回 `{decode,dispose}`。`decode(kind,encodedBuffer,expectedBytes)` 的 kind 为 `data/instructions/addresses`；三个独立 context 在同一补丁的多个窗口间持续保留状态，共享一个隔离 WASM 实例。调用必须顺序等待；并行调用、错误、取消或 dispose 均使整个实例不可复用。

ID2 的 XZ/LZMA2 段可能在同步刷新边界结束而没有独立 XZ EOF。段成功要求消费全部输入并精确产出声明长度；这不等于证明一个完整独立 XZ 文件结束。换补丁须创建新实例，不能共享旧状态。

[内存限制模块](../electron/vendor/xz/memory-limit.cjs) 校验固定上游 WASM 的长度和 SHA-256，仅改写 memory section，增加最多 1,024 页的硬 maximum；每页 64 KiB，初始最少两页。运行时只实例化加限后的字节，无外部 imports；可进一步降低为至少 128 KiB 的页对齐上限，原始无上限模块不被实例化。字典超额、OOM 或 trap 返回固定资源错误并丢弃实例。

**64 MiB 仅限制 WASM 线性内存，不是整个 Node 进程的内存上限。** XZ bridge 在让出执行前复制输入，单次输入副本和输出 Buffer 各有 64 MiB 上限；`maxDecodedBytes` 可进一步限制输出。VCDIFF 另有窗口、编码段合计和解码段合计预算，回调读取按 64 KiB 分块。Node Buffer、尚未回收的旧对象、V8 与编译器内存均不包含在 WASM maximum 内，不能把这些限制表述为进程 RSS 保证。

WASM 来源为 [xz-decompress 0.2.3](https://github.com/httptoolkit/xz-decompress)，保存的包、桥接源码、许可及来源摘要见 [随包材料](../licenses/xz-decompress/README.md)、[NOTICE](../licenses/xz-decompress/NOTICE.txt)、[MIT](../licenses/xz-decompress/LICENSE-MIT.txt)、[walloc MIT](../licenses/xz-decompress/LICENSE-WALLOC.txt) 与 [xz-embedded 公有领域声明](../licenses/xz-decompress/COPYING-XZ-EMBEDDED.txt)。[离线脚本](../scripts/vendor-xz-wasm.cjs) 的 `--check` 可从已保存材料重现并核对字节变换，不联网、不执行上游 JS，也不声称重新编译上游 C 工具链可复现。

## 验证与剩余边界

隔离检查见 [manifest测试](../tests/pdx-manifest.test.cjs)、[通用计划测试](../tests/pdx-patch-plan.test.cjs)、[补丁整合测试](../tests/pdx-patch-integration.test.cjs)、[暂存清理测试](../tests/pdx-patch-cleanup.test.cjs)、[缓存测试](../tests/pdx-archive-cache.test.cjs)、[协调器测试](../tests/pdx-downloads.test.cjs)、[安全工作区测试](../tests/pdx-patch-workspace.test.cjs)、[容器测试](../tests/pdx-patch-archive.test.cjs)、[VCDIFF测试](../tests/pdx-vcdiff.test.cjs) 与 [XZ测试](../tests/pdx-xz.test.cjs)。新增覆盖六操作规划、目标缺项补齐、Unicode/设备名别名、空operations的签名暂停恢复、d+n保留旧安装及files404后的无源p修复；既有签名/权限绑定、拒绝降级、稳定文件访问、完整重读、跨窗口XZ及取消检查继续适用。0.20最终全套、UI和制品结果统一见 [Roadmap](../ROADMAP.md)。0.19系统Node1138/1138、常规54项及补丁流程为历史归档，不计作本版重跑。

0.19后续补核已将小型压缩段证据扩展为实际官方大source ZIP到目标ZIP的完整重建，目标摘要匹配独立验签complete；具体样本及未覆盖项见 [官方验收记录](official-patch-acceptance.md)。0.20的通用清单/计划和有限单ZIP执行仍不覆盖任意多目标文件系统、实际k样本或官方内部缓存/checkpoint。新版Electron、便携程序、真实游戏、账号、Steam SDK、发布与实机验收仍未完成；Roadmap目标保持active，有限实际样本、隔离夹具与制品静态核对不代表官方差分完整兼容。
