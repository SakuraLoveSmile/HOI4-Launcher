# Paradox 受保护仓库：完整 ZIP 下载

2026-10-29，IRONCLAD 0.17.0。支持当前账号获准访问的私有完整包，强制验证官方根信任链和原始元数据分离签名，再复用 SHA-256 校验、安装事务、暂停和断点恢复。0.16 增加受管安装逐文件验证和固定版本修复；0.17 接入修复的 files 内容地址，实际内容 404 后回退同版 complete ZIP，两者仍传输完整模组包。开发验证使用隔离账号、网络、运行时生成的独立测试密钥和小型 ZIP；尚未使用真实私有账号验收。不运行或分发官方 CPatch。

## 协议依据

对本机官方 CPatch Go 二进制只读静态核对，`GetPatchRepoUrlReply` 使用固定账号 API 的 `GET /patch/repo/<signingBasePath>`。官方可按完整 manifest 或文件夹作为 signingBasePath；IRONCLAD 为独立完整包选择以下逐资源请求：

```text
/patch/repo/mods/hoi4/<name>/repo/<platform>/_keys/public.gpg
/patch/repo/mods/hoi4/<name>/repo/<platform>/repository.json
/patch/repo/mods/hoi4/<name>/repo/<platform>/repository.json.asc
/patch/repo/mods/hoi4/<name>/repo/<platform>/<revision>/complete/manifest
/patch/repo/mods/hoi4/<name>/repo/<platform>/<revision>/complete/manifest.asc
/patch/repo/mods/hoi4/<name>/repo/<platform>/<revision>/complete/<filename.zip>
/patch/repo/mods/hoi4/<name>/repo/<platform>/files/<size>_<padded-base64url-sha256>
Authorization: {"session":{"token":"…"}}
```

200 返回字符串字段 `prepend`、`append`、`ttl`，以及 `result:"OK"`。`ttl` 是绝对 Unix 秒数。完整资源授权后的内容地址为 `prepend + append`。普通安装的六项分别请求资源授权；修复下载另外独立授权 files，对象 404 后再独立授权 complete ZIP，不能复用 manifest、签名或 files 的授权。资源授权中的 URL 签名和 OpenPGP 内容分离签名是两个不同层次。官方通用 RoundTrip 还会拼接相对 signingBasePath 的剩余路径，本实现限定到完整资源，不需要这一步。

静态定位为二进制文件偏移：GetPatchRepoUrlReply 3466240，`patch` 4753351，`repo` 4752581，Authorization 模板 4804946，`GET` 4751662，UrlDetails 类型 4503680，NewRepository 的 60 秒刷新余量 3631645，GetCompleteManifest 3656018，DownloadFolder 3650628–3650681。这些是当前已安装版本的定位证据，不是稳定源码行号。

已留存匿名只读探测 [cpatch-public-repo-probe.json](../test-results/cpatch-public-repo-probe.json)：已知公开仓库的授权端点返回 200，具有上述四个字符串字段，公开资源的 append 为空。没有账号、Cookie 或包体请求，也不保存签名值。该探测证明端点与返回形状，不证明真实私有账号访问成功。网站主 bundle 证明 CDN/API 认证分流及 ACL 枚举；尚未证明懒加载私有下载按钮的完整调用链，不能据此宣称网站私有下载路径已实测。

## 本项目实现

- 默认匿名下载公开或凭链接可访问的 `unlisted` 完整包。`private/hidden` 必须显式选择当前账号。元数据仍须通过 HOI4、ID、revision、发布状态、地区、Windows/Any 平台和 canDownload 校验。
- 账号模式下的非公开元数据必须提供精确匹配的 `repositoryPath`。仅主进程账号服务能请求受限 HOI4 路由：三个固定仓库根资源、合法版本下的 complete manifest/manifest.asc/ZIP，以及规范 Size/SHA-256 的 files 对象。根资源、版本/文件名和 files 三种输入不能混用；不增加任意网络 IPC。
- 每次 resolve 重新取得仓库钥、原始 `repository.json` / `manifest` 及各自签名。固定生产根认证仓库钥，独立核对根和仓库钥的当前撤销状态，两份文档验签后才解析，签名 metadata 的 `completeSize` 必须与 manifest ZIP 大小相同。旧密钥到期兼容、强内容摘要及撤销错误边界见 [签名验证](pdx-signatures.md)。
- 每个仓库实例最多缓存两项独立资源授权。剩余有效期小于 60 秒时重新请求，新授权仍不足 60 秒则停止。权限与账号变化由覆盖整个任务的会话绑定取消；正常 token 刷新保持绑定有效。
- 内容 URL 只接受账号 API 返回且通过语法校验的 HTTPS 域名，端口仅默认 443，拒绝账号信息、IP、localhost、local/internal 域名和不安全字符；不解析 DNS 或宣称验证解析后的公网地址。内容请求不带账号令牌或 Cookie，不跟随重定向。
- 签名 URL、grant 和账号信息只保存在主进程内存中。可序列化计划仅增加非敏感 `access:"repository"`，checkpoint 哈希同时绑定该标记。脱离本次 resolve 能力的受保护计划不能下载；不会静默改成 unsigned URL。
- 下载协调器只通过临时 `resolvedPlan` 传递能力，持久化仍为规范计划。暂停/重启后必须手动继续，重新取得全部签名资源、重新验签/查询撤销并取得 ZIP 授权，继续原固定版本与可信片段。旧公开计划的哈希保持兼容。
- `repair({modId,authorization})` 只接受当前游戏用户目录内的受管安装，服务固定已有 revision 与 installationId。公开身份的健康本地检查不联网；账号身份先核对登录会话，文件完整时不请求内容元数据、签名资源或 ZIP。缺少可信索引或需要修复时，同版完整包继续使用本节的独立授权与验签边界。暂停/重开/恢复保留 repair 身份与版本，恢复前重新检查原安装，不能凭旧片段跳过账号、权限、签名或撤销检查。
- 授权拒绝、过期、账号变化、不安全响应或重定向均停止，不猜地址、不切账号、不转发凭据。错误只保留可操作的错误码和固定文案。

## 验证与范围

`pdx-repository.test.cjs` 验证路由、账号绑定、两项 LRU、有效期边界、URL/大小限制、取消和错误脱敏。`pdx-content.test.cjs` 验证独立资源授权、能力绑定及无降级。0.15 的 `pdx-private-integration.test.cjs` 使用独立生成的签名链，组合真实账号服务、内容服务、下载协调器和安装器，八项覆盖安装、暂停/重开/Range 续传、退出/同账号重登/会话失效、授权拒绝，以及状态、下载日志和安装记录不含签名或凭据；暂停后签名被篡改时不再请求 ZIP 或安装。该版本另有 27 项独立密码学测试及默认生产根的公开原始字节测试，完整 Node 821/821、常规无界面 UI 54 项通过，作为历史结果保留。当前完整结果见 [Roadmap](../ROADMAP.md)。

0.15 无界面整合检查：`node scripts/test-pdx-resume-ui.mjs --signed`。该选项包含账号模式，使用真实业务模块、真实签名验证器、独立测试根和内存账号/网络夹具，检查 UI 显式选择当前账号、暂停 65,536 字节、重开不联网、继续后累计十二次独立资源授权及四次撤销查询、精确 `Range: bytes=65536-`、安装 revision 3 和预设保留。记录与截图使用 `pdx-signed-ui` 前缀，应用外部请求为 0。

0.16 的 `--repair` 无界面流程使用同一真实验签边界，验证健康时不请求内容资源、同版内容损坏修复、旧用户文件和预设保留，累计十八次资源授权及六次撤销查询。账号会话检查与内容资源请求分别统计，不能据内容请求为零宣称账号模式完全离线。修复索引、事务与本轮检查范围见 [安装验证与修复](pdx-repair.md)，最终结果以 Roadmap 为准。

0.13 的 `--private` / 无选项公开路径结果保留为历史传输证据，对应 `pdx-private-ui` / `pdx-resume-ui` 前缀；这些旧传输夹具显式替换密码学边界，不能作为新增签名验证证据。

0.17 全套 Node 894/894 通过。新增真实签名整合覆盖 files 直接修复，以及 files/complete 两条路径的暂停重开、独立授权和精确 Range；UI 修复流程为 files 404 回退 complete，累计 19 次资源授权和 6 次撤销查询。权限、会话、哈希或协议错误都不能触发该回退，完整机制见 [内容下载路径](cpatch-download-paths.md)。

这里实现的是使用仓库授权服务及官方 OpenPGP 信任链的独立完整 ZIP 下载，以及基于可信 ZIP 派生索引的受管安装校验/同版事务修复。CPatch delta、`_to_` 安装补丁回退、单个解压文件的网络修复、分块缓存和内部断点格式仍未实现。真实 Electron、账号、Steam SDK、CDN 有效期/Range 行为、私有内容和游戏实际加载仍需在用户主动操作的环境验收。
