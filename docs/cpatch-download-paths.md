# CPatch 内容地址与补丁路径 · 0.20.0

当前受管PDX修复先尝试 `files` 内容地址，再按可信仓库声明选择 `-1_to_` 安装补丁或同版complete；普通更新可选择较小差分和可信旧ZIP。0.20接入 [通用manifest/操作计划器](pdx-patch-planning.md)，实际下载仍限制一个目标ZIP，增加空operations隐式复制、同目标d加n/p/k、无旧源p，不提供任意多目标或单个解压文件的网络修复。

0.18当时仅保存原始ZIP并提供独立VCDIFF/XZ内核，0.19接通补丁选择、网络、容器和事务。0.19交付后的真实官方大型p差分及n安装补丁证据继续保留，见 [大ZIP补核](official-patch-acceptance.md) 和 [安装补丁验收](official-install-acceptance.md)，不计为0.20重跑。官方内部缓存/断点格式及通用文件系统执行仍待完成。接口、预算及边界见 [增量下载与缓存](pdx-delta-core.md)。

## 当前下载流程

健康安装沿用本地验证；账号模式仍先核对会话。需要取得可信 ZIP 时，主进程调用 `content.resolve({modId,revision,repair:true,...})`，重新验证官方根、仓库认证、原始 metadata/complete manifest 的分离签名及两项撤销状态，再从可信清单派生：

```text
<平台仓库根>/files/<十进制ZIP字节数>_<带填充Base64URL的SHA-256>
```

SHA-256 必须是规范的 44 字符编码，末尾保留 `=`。生产计划内部保存小写 hex 摘要，构造资源名时才编码；拒绝非规范尾位、URL 编码、路径别名、混合参数和任意 URL。修复策略和可信 complete 能力只存放在本次 resolve 的内存中，不写入计划、checkpoint 或 IPC，也不允许渲染层选择下载路径。

账号模式为 `files` 单独请求：

```text
GET /patch/repo/mods/hoi4/<name>/repo/<platform>/files/<size>_<hash>
```

该授权不能替代 complete ZIP 的授权。签名地址只存在内存，CDN 请求不携带账号令牌或 Cookie；不跟随重定向。

修复的选择规则如下：

| 可信仓库声明与 files 结果                | 下一步                                                           |
| ---------------------------------------- | ---------------------------------------------------------------- |
| 声明 `-1`，files 返回 200                | 仅从 files 取得目标完整 ZIP；实际传输再返回错误时停止            |
| 声明 `-1`，files 内容实际返回 404        | 回收响应，独立验签并下载固定目标 `-1_to_<target>` 安装补丁       |
| 未声明 `-1`                              | 保留原兼容流程：files 内容实际 404 后，独立授权同版 complete ZIP |
| 权限、会话、限流、网络、重定向或校验失败 | 停止；不猜测补丁路径、不降级匿名、不按错误回退                   |

只有实际内容 404 才触发相应分支，授权服务报错不能代替它；回收响应时取消也阻止后续请求。已选安装补丁的任何后续失败都停止，不再静默换 complete。

files/complete 直接传输和补丁重建都必须得到同一可信目标 ZIP 大小和 SHA-256，并经过落盘重读校验。补丁本身另有已验签 manifest 指定的压缩大小、展开大小和 SHA-256；完整目标校验不能替代补丁校验。

## 补丁信任、版本差分与恢复

补丁路径固定为：

```text
<平台仓库根>/<target>/<from>_to_<target>/manifest
<平台仓库根>/<target>/<from>_to_<target>/manifest.asc
<平台仓库根>/<target>/<from>_to_<target>/<from>_to_<target>.zip
```

`from` 仅为可信仓库声明的旧revision或安装补丁的 `-1`。`resolvePatch` 必须持有可信目标complete的主进程能力，独立取得仓库认证、原始metadata/补丁manifest、分离签名和新鲜撤销状态，核对completeSize及声明的补丁压缩/展开大小。空operations的已签名展开量可为0，仍须与manifest及checkpoint一致，补丁ZIP大小必须为正。账号模式通过固定HOI4补丁资源路由逐项授权；files、complete和补丁授权不互换，不把账号凭据发到CDN。序列化或篡改计划不能恢复该能力。

普通更新在已安装旧版存在、声明差分小于目标 complete、旧 complete 重新验签且匹配安装归档摘要、原始 ZIP 缓存完整可用时选择差分。初选前缓存或旧源优化不可用则取目标 complete；选定补丁后签名、权限、传输、容器、旧源或目标错误停止。不会对当前已安装目录重新压缩生成近似旧 ZIP。

持久化的 `plan` 始终表示目标 complete；实际补丁另存 `transferPlan`，版本差分旧源另存 `sourcePlan`，checkpoint 绑定 `transferPlan || plan`。补丁片段是 `patch.zip`，重建目标是 `content.zip`。暂停重开重新验签、检查权限、原安装身份、旧源缓存和前缀摘要；已选补丁计划或源变化时保留片段并停止。206 的 ETag 与断点不一致时停止；200 时从头下载同一实际传输包，不把补丁 Range 接到完整目标。

补丁应用只允许同一ZIP目标最多一个d和一个n/p/k；空operations或仅d须以大小/摘要一致的可信旧ZIP隐式复制，p可使用0字节空源。d只作用于新空目标的逻辑阶段，不触碰旧安装或缓存。c/s、其他目标、多个producer或额外payload拒绝。核对容器、实际源和完整目标后，再由安全工作区fsync、落盘重读并产生固定文件身份/摘要证明；协调器持久化后由清理器独立重核，未知或改动内容保留。原安装器重新核对目标ZIP并按原事务提交，修复保持固定revision，保留旧内容、注册备份和预设。补丁应用和安装不可暂停；重开不自动联网。

通用manifest虽然能解析多个file/directory/symlink，内容服务仍在验签后强制恰好一个普通ZIP条目；未知codec或多目标清单不会生成可下载capability。解析或计划结果不授予新CDN路径、文件系统权限或任意链接执行能力。

## 真实协议证据

对本机 Paradox Launcher 2026.12 的 CPatch 只读反汇编确认：`GenerateHash` raw 3290218 读取的 Go 全局为 `encoding/base64.URLEncoding`，raw 3290240 调用 `EncodeToString`；文件映射直接拼接 Size 和 Hash。URL path 保留 `=`、`-`、`_`。完整偏移和复核脚本见 [静态发现](../.work/cpatch-patch-discovery.md)。没有运行官方程序。

2026-10-29 匿名读取公开仓库的三份补丁 manifest 及签名，并以生产签名验证器、固定官方根和当次撤销状态验算通过：

| 路径          | 补丁 ZIP 字节数 |  展开字节数 |
| ------------- | --------------: | ----------: |
| `12/-1_to_12` |     603,645,354 | 606,268,926 |
| `12/11_to_12` |      35,920,778 |  35,921,832 |
| `3/1_to_3`    |           1,081 |       2,097 |

仅下载其中 1,081 字节的小补丁，SHA-256 `563e6135e2f137b220f1a66aff6137a67d2c2acd5b97188fe76449a2e9cf1dcf` 与已验签清单一致。只在内存读取 ZIP，得到 `operations` 的 `p: <mod-name>.zip` 与对应 `.zip.vcdiff`，未提取为安装、未执行差分、未下载源 ZIP 或构造真实目标。记录位于 [清单探测](../.work/cpatch-patch-fixtures/probe.json) 与 [小包检查](../.work/cpatch-patch-fixtures/small-patch-inspection.json)。

同仓库 revision 12 的 files 地址匿名 HEAD 返回 404，complete ZIP HEAD 返回 200、长度 606,268,882；未读取该 ZIP 包体。它证明本次回退的必要性，不证明 files 对象在其他仓库可用，亦不替代真实私有账号验收。

## 验证与未完成部分

0.17 历史系统 Node 全套 894/894 通过，失败/取消/跳过为零。检查覆盖规范摘要路径、受限账号路由、绑定计划、404 响应回收、取消与拒绝回退、损坏内容停止，以及真实签名流程中 files 直接修复和两种来源的精确 Range 重开恢复。0.19 全套 1138/1138、24 项签名补丁整合、常规 54 项及补丁更新/续传/修复无界面流程通过；最终核验、制品和0.18历史结果统一见 [Roadmap](../ROADMAP.md)。

0.20隔离整合新增空operations/0展开量的暂停重开与精确Range安装、d+n替换保留旧安装，以及files实际404后的无源p修复；网络及账号为隔离夹具，最终全套/UI/制品归档见 [Roadmap](../ROADMAP.md)。通用计划器可识别六操作并补齐目标缺项，但c/s或任意多目标执行、官方内部缓存/checkpoint仍待完成。

历史真实补丁使用带二次LZMA压缩的VCDIFF并保留跨窗口状态，0.19后续 [官方大ZIP重建](official-patch-acceptance.md) 已验证实际源到可信目标的完整摘要。实际 `-1_to_3` 容器确认单条n，无旧源重建目标并通过完整摘要和工作区证明，见 [安装补丁验收](official-install-acceptance.md)。范围仍限所列样本；实际k、其他仓库/编码参数以及Electron、便携程序、游戏、账号、Steam SDK和发布验收仍待完成，目标保持active。
