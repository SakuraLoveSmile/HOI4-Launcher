# CPatch 签名链与 HOI4 修复入口研究

2026-10-29，基于本机 Paradox Launcher v2.2026.12。本文保留 0.13 阶段的协议研究证据；0.15 已实现完整包 OpenPGP 信任链，0.16 增加可信 ZIP 派生索引的受管安装逐文件校验和同版事务修复。实际范围见 [签名验证](pdx-signatures.md) 与 [安装验证与修复](pdx-repair.md)。CPatch 增量、官方 files/内部缓存兼容仍未实现。完整 ZIP 授权见 [受保护仓库](pdx-protected-repository.md)。

该次研究只静态读取官方 `cpatch.exe`、`resources/app.asar`，并匿名读取小型公开元数据、签名、公钥和撤销端点。没有执行官方程序、打开界面、使用真实账号或下载 ZIP 包体；当时未向生产资源加入官方公钥。下面表格记录的包结构探测当时没有完成密码学验算；后续 0.15 已保存固定生产根与公开原始夹具，完成真实字节验签。

## 0.13 的实施建议（历史）

当时建议在现有整包安装事务前增加独立的签名验证层：固定生产根公钥及指纹，确认仓库公钥获得该根认证并检查撤销，再验证原始 `repository.json` 与 `manifest` 字节的分离签名。签名通过以后才解析清单，用现有 SHA-256 流程核对下载的 ZIP。0.15 已完成此路径；下文保留当时发现及建议，不作为当前实现缺口清单。

这里的 `manifest.asc` 签署的是 **manifest 文件**，不能称为直接签署 ZIP 的归档签名。ZIP 的信任关系来自已验证 manifest 中的 SHA-256。该步骤也不提供 CPatch 的差分补丁、分块缓存或内部断点格式兼容。

当时需要先解决的兼容问题是：读取的官方根与仓库公钥使用旧式 SHA-1 密钥认证签名，而真实内容签名使用 SHA-256。不能把“公钥能解析”或“签名数学上匹配任意下载公钥”当作已建立官方信任链；也不能为了接受旧认证而全局降低内容签名要求。0.15 只在固定根链的旧密钥认证中局部允许 SHA-1，内容仍限定 SHA-256/384/512。

## 静态信任链证据

以下均为当前 `cpatch.exe` 的十进制文件偏移，不是稳定源码行号。可用本地只读工具 `.work/cpatch-static-tools/inspect_binary.py` 按 Go 函数符号复核。

| 行为          | 定位与可确认结果                                                                                                                                                      |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 分离签名算法  | `common/integrity.(*PGPVerifier).Verify`：3301280；3301394 调用 `github.com/ProtonMail/go-crypto/openpgp.CheckArmoredDetachedSignature`，使用 OpenPGP ASCII armor     |
| 生产根选择    | `chooseRootKey`：3302944；编译时 `integrity.sandbox` Go 字符串为 `false`（字符串头 raw 8258672，内容 raw 5391436，长 5）                                              |
| 生产公钥      | armor 位于 raw 4890763，长 3151；`GetRootPublicKey`：3303584，调用 `ReadArmoredKeyRing` 并要求一个 entity                                                             |
| 仓库公钥认证  | `(*PGPVerifier).VerifyKey`：3301632；遍历用户身份认证，3302827 调用根公钥的 `VerifyUserIdSignature`；3302756 的失败文本为 `found no signature from the root key`      |
| 仓库元数据    | `(*RepositoryConnector).DownloadMetadata`：3641728；下载 `repository.json` 和 `repository.json.asc`，读取 `_keys/public.gpg`，3643286 调用 `VerifyPGPKeyAndSignature` |
| 旧公钥刷新    | 缓存公钥存在且验证失败时，3643566 重新取得公钥，3643691 再验证一次；不是无限重试或忽略失败                                                                            |
| 验证先于解析  | 3643828 的日志为 `repository.json signature verified, parsing`；3645066 调用 `ParseRepositoryInfo`                                                                    |
| manifest 签名 | `GetCompleteManifest`：3648992；`fetchManifest`：3655296，下载 `manifest` 与 `manifest.asc`，3656790 调用已配置 verifier 后再解析                                     |

生产根主钥指纹为 `AF28077C9C565B53F3CD5A65788AA56D99D64E1C`，用户身份为 `Paradox Interactive Distribution (Root Key) <devops@paradoxplaza.com>`。这是 OpenPGP v4 RSA 4096 位主钥；其 RSA 4096 位子钥指纹为 `7A7DE63B61C4F783384B93EC270266FBE0EBA8EB`。

另一个 sandbox armor 位于 raw 4889011，长 1752，主钥指纹为 `456613BA2FCAE6AE1E5EB6EB5C13641FB569A44C`，RSA 2048 位，身份包含 `Root Key - Sandbox`。它不是当前生产信任根。运行时根公钥覆盖与撤销地址覆盖是未初始化全局，不能把 BSS 虚拟地址映射后的任意文件字节误认为实际配置。

`PGPVerifier.Verify` 在 3301423–3301458 对错误文本 `openpgp: key expired` 有特殊容错。当时据此提出先评估官方链的有效期和兼容行为，不能仅凭错误文本忽略到期。0.15 后续确认真实官方根和仓库钥已到期，限定兼容主/子钥到期并保留其他时间、认证、权限、绑定和撤销检查。OpenPGP v4 的指纹本身按格式使用 SHA-1，这和内容签名使用何种摘要是两个问题。

## 真实 HOI4 公开路径

本次复用了已知公开模组 157712 的 API 详情中提供的仓库名，未枚举私有或历史内容。公开 CDN 仓库基址为：

```text
https://modscontent.paradox-interactive.com/hoi4/6cca83a0-a6ec-11f1-92e5-affbeaa2abe2/repo/Any__Any/
```

匿名 GET 带 `User-Agent: IRONCLAD-static-research/0.13`，每项最多读取 65,537 字节。以下全部返回 HTTP 200，均未超过大小上限。

| 基址下的相对资源           | 字节数 | SHA-256                                                            |
| -------------------------- | -----: | ------------------------------------------------------------------ |
| `repository.json`          |   4677 | `08599cb49aa8ec14046066ca7ec0cd3a546dd2cb8a17ff7eb29633f8b9de6096` |
| `repository.json.asc`      |    454 | `809dd342d836b9660e5cee05b7822f446eb87f5992060c6cb403126a90b7b1f6` |
| `_keys/public.gpg`         |   2447 | `47ede5d8c6d05f5806e98227b67ed2517797f3cb911d838b6a4297d97226038b` |
| `12/complete/manifest.asc` |    454 | `e0e9a3ba2c5b1a58a147656fd6c2e2de8647ddde2c54ea14d781a106fb9e5162` |

因此 `_keys/public.gpg` 位于平台仓库根下，不是全 CDN 根或版本 `complete` 目录下。`CDNHttpFetcher.FetchFiles` 在 3588286–3588378 拼接 `/`、逻辑仓库名和相对资源；`DownloadMetadata` 在 3642741–3642803 构造 `_keys/public.gpg` 并交给该 fetcher。账号服务使用带 `mods/` 的逻辑仓库路径，CDN 实际 URL 没有这段前缀；不得绕过当前仓库授权能力自行猜测私有 CDN 地址。

返回公钥的主钥指纹为 `E7120B18C9267050FA73CB6479A54411046A8535`，身份为 `Mods Distribution <devops@paradoxplaza.com>`，RSA 2048 位；子钥为 `FA7BA2EB4EDF044BE86231ABDAE4D0866045E4EB`，RSA 2048 位。结构解析结果如下：

| OpenPGP 对象                     | 结构解析                                                                                               |
| -------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 官方根自认证、子钥绑定           | v4 RSA，hash algorithm 2（SHA-1），签名类型分别为 0x13、0x18                                           |
| 仓库自认证、第三方认证、子钥绑定 | v4 RSA，hash algorithm 2（SHA-1），签名类型分别为 0x13、0x10、0x18；认证签名存在不等于密码学认证已验证 |
| `repository.json.asc`            | v4 RSA，binary document signature 0x00，hash algorithm 8（SHA-256）                                    |
| `manifest.asc`                   | v4 RSA，binary document signature 0x00，hash algorithm 8（SHA-256）                                    |

这些响应会随仓库更新变化。请求未携带 Authorization、Cookie 或账号数据。0.13 此次探测未保存响应 Cookie、公钥文件或完整签名文件；上表是当时响应结构和摘要的记录，不是可重复执行的端到端密码学验收夹具。0.15 后续另行取得并保留五份公开原始资源，使用固定根完成密码学验算，来源见 `tests/fixtures/pdx-signatures/README.md`。一次未带指定 User-Agent 的重复请求返回 404，后续带该 User-Agent 的读取成功；原因未确认，不应推断为稳定的 User-Agent 授权规则。

## 撤销查询

`GetRevocationCertLocation`：3290336。模板字符串位于 raw 8258656 指向的 Go 字符串，内容为 `https://revocation-%s.paradox-interactive.com`；生产选择 `prod`。`integrity.fetchFromURL`：3298496，3298625–3298656 格式化 `<fingerprint>.asc`，3298876–3298904 拼接地址。

```text
https://revocation-prod.paradox-interactive.com/<fingerprint>.asc
```

0.13 此次匿名 GET 生产根指纹对应地址返回 **204，0 字节**。这只证明该次根撤销查询没有返回证书；当时未查询真实仓库钥的撤销状态，不能据此宣称整条链未撤销。0.15 后续公开资源探测分别查询真实根和仓库钥，均返回 204；生产实现仍在每次 resolve 时重新查询，不持久缓存该结果。

官方可确认的响应处理：

- 3298985 检查 HTTP 404，将其兼容为无证书，并记录 `Got 404 for revocation key for %v. Should be a 204.`。
- 3299372 检查 HTTP 204，返回无证书。
- 其他抓取错误返回失败，3299309 的包装文本为 `fetching revocation certificate for %v: %w`。
- 成功下载证书后仍须解析并验签，不能把任意 200 响应直接当作可信撤销。相关函数为 `ReadRevocationCertificate` 3294784、`ValidateRootKeyRevocationSignature` 3294304、`ValidateKeyRevocationSignature` 3294592。

当时待明确的是离线缓存期限、失联时是否允许旧状态、根撤销检查时序及是否保留官方旧 404 容错。0.15 选择每次 resolve 新取钥并查询两项撤销，无离线撤销缓存，保留旧 404，网络失败停止。后续静态核对及夹具验证确认：200 必须为 `PUBLIC KEY BLOCK` armor 内恰好一个目标主钥自签的 key-revocation 包；有效撤销、伪造、错钥、畸形或未来证书均停止下载。

## HOI4 用户功能：验证并修复模组

官方 `dist\\renderer\\assets\\primary-BdsA_WUs.js` 中 `c2e` 的模组菜单确实渲染 `mod-card-dropdown-validate-and-repair`，并调用 `KU` → `@IPC_PRIMARY/REPAIR_INSTALLATION`。条件是 `mod.source === PDX` 且没有隐藏磁盘相关选项；正在修复或排队时禁用按钮。请求字段为 `appName: mod.name`、`installationPath: mod.dirPath`、`repositoryPath`、`type: MOD`，主进程 `_Ze` 在修复完成后同步模组存储并刷新列表。这是实际用户入口，不只是通用 CPatch 中未使用的命令。

该菜单没有要求 `looseModFilesSupport` 或指定游戏开关，因此同一流程适用于本项目对齐的 HOI4 PDX 模组。Steam/本地来源没有这个 CPatch 菜单。`f2e` 把 `hideOnDiskSpecificOptions` 设为 `shouldBeOffDisk || [UNSUBSCRIBED, TO_UNSUBSCRIBE].includes(mod.status)`；新实现应限定到已安装且由应用管理的模组，而不是对任意本地目录承诺修复。

游戏本体的安装/验证区则由 `Rr && !isSelectedGameSteam` 控制，验证组件还要求账号已登录。**Windows Steam 版 HOI4 的本体修复应交给 Steam，不应为了对齐官方而增加 CPatch 本体修复。**

0.13/0.15 的历史判断是：下载时验签和 ZIP SHA-256 不等于“检查已有安装文件并修复”，需要另行建立可信的解压文件基准。0.16 已实现该检查和逐文件损坏计数，修复固定已有 revision，并复用原事务保留旧内容和预设；需要下载时仍取完整 ZIP，不宣称只下载差异文件。

## 0.16 修复单位的静态核对

本轮只读核对现有二进制及已保存的小型公开 metadata，不执行 CPatch/xdelta3，不新增联网探测、不下载真实 ZIP。DWARF 的 `FileEntry` 恰有 Path、Size、Hash、Flags、UncompressedSize、CompressionAlgorithm；manifest 无块序号或分块摘要字段。已保存的 HOI4 revision 12 complete manifest 只有一个 ZIP 条目，大小 606268882，SHA-256 为 Base64。该条目不能直接验证本项目解压目录中的各个脚本。

`common/integrity.GenerateHash` raw 3289760 只接受 sha256，以 1,024 字节缓冲累计整文件摘要并编码 Base64；该缓冲不是网络块大小。`Manifest.makeFileEntry` raw 3448352 对 ZIP 的特殊处理只累加展开总字节数，不生成内部逐文件摘要。`VerifyInstallation` raw 3457088 遍历 manifest，`VerifyFile` raw 3458400 比较条目的类型、大小、摘要和 flags；因此本次 manifest 的修复单位就是 ZIP 本体。

官方 `RepositoryConnector.RepairInstallation` raw 3661152 读取当前版本、complete manifest，收集错误条目，再下载并修复。`DownloadFilesForRepair` raw 3624064 先尝试平台仓库根 `files/<Size>_<Hash>`，遇到 404 才回退 `<target>/-1_to_<target>` 安装补丁并从其归档取得需要的条目。`PrepareFileMapFilesFolder` raw 3652992 构造 Size_Hash 名称，`GetPatchURLPath` raw 3443872 构造版本补丁路径；ZIP archive 的 operations 和 xdelta 另有独立分支。本轮未取得 files 资源或补丁归档，不能从静态分支推断真实 CDN 可用性、精确缓存协议或授权行为。

IRONCLAD 因此只为自己提取的受管内容建立本地索引：可信 ZIP 提取并清理 descriptor 后，绑定 modId/revision/archiveSha256 和逐文件大小/SHA-256；索引位于固定控制根，按独立摘要引用。它支持本地缺失、改写、额外和不安全文件检查，同版完整包事务修复，以及旧安装重新取得可信包后补建基准。它不实现上述官方 files/补丁/缓存分支，也不把索引称为官方逐文件签名 manifest。存储、取消与回滚边界详见 [修复文档](pdx-repair.md)。

## 0.17 内容地址与真实补丁补核

0.17 已静态确认 files 名称使用带 padding 的 Base64URL SHA-256，精确路由接入受管模组修复；只有实际内容 404 才回退同版 complete ZIP，授权、会话、签名、大小和摘要错误均停止。安装补丁回退、差分和内部缓存仍未实现，实际能力见 [内容下载路径](cpatch-download-paths.md)。

本轮另匿名取得三个官方补丁 manifest 并用生产验证器核对固定根、分离签名和当次撤销状态，读取其中 1,081 字节的小型差分 ZIP，确认大小/SHA-256 与可信清单一致。它包含 operations 和 VCDIFF payload；未执行官方程序，未取得大型源 ZIP 或应用真实差分。静态与小型纯 WASM 研究确认二次 LZMA 状态跨窗口保留，但尚缺生产内存硬上限与完整窗口解码器，不能用此证据宣称已支持 delta。

## 库选择和历史验收建议

当时的候选为维护中的 [OpenPGP.js](https://github.com/openpgpjs/openpgpjs)，npm 包 `openpgp`。只读 registry 元数据返回 **6.3.2**、Node `>=18.0.0`、CJS 与 ESM 双入口、`LGPL-3.0+`。0.15 后续已精确安装该版本，并准备 [完整许可、对应源码与替换材料](third-party-openpgp.md)；不会把官方 Go 依赖或系统 GnuPG 当作运行依赖。

6.3.2 的 [src/key/user.js](https://github.com/openpgpjs/openpgpjs/blob/v6.3.2/src/key/user.js) 提供 `verifyCertificate` / `verifyAllCertifications`，可用于认证链核验；[src/packet/signature.js](https://github.com/openpgpjs/openpgpjs/blob/v6.3.2/src/packet/signature.js) 的 807–814 行分别检查 `rejectHashAlgorithms` 与仅作用于 binary/text 内容签名的 `rejectMessageHashAlgorithms`。这说明证书与内容摘要策略可以区分。后续真实验算发现官方钥已过期，高层 API 仍按签署时间检查钥有效期；0.15 使用局部包验签与独立日期/绑定检查保留官方旧密钥兼容，详见实现文档。

0.13 当时建议首个实现先用独立夹具和真实小元数据验证可行性，再接入生产下载器。历史验收建议如下；0.15 当前选择及证据见本节之后：

1. 使用固定生产根的精确字节和指纹建立信任，拒绝 sandbox、被替换根、多实体异常钥包和没有有效根认证的仓库公钥；收到一个自签钥不能自动授信。
2. 明确旧 SHA-1 认证的兼容边界及风险；如需局部接受，仅限固定官方信任链的密钥认证。内容分离签名仍限定 SHA-256 或另行确认的强算法；进程全局配置不降级。测试恶意内容 SHA-1 签名不会借该设置通过。
3. 对原始字节验签，禁止解析/重排 JSON、改换行或字符编码之后再验；包括合法签名、内容或签名篡改、错误签署钥、缺失/超大/畸形 armor、过期或撤销钥、撤销证书签署者错误。
4. 根和仓库撤销分别校验，明确 204、旧 404、网络错误、伪造 200 的行为。测试钥轮换只重新取钥并重试一次，不能失败后使用 unsigned manifest。
5. 在下载 ZIP 之前验证 manifest；受保护仓库为 metadata、key、signature、manifest 各自申请适当能力。0.13 授权服务当时只开放 complete manifest/ZIP 路由，扩展应继续限定资源和当前账号，不能新增任意 URL IPC。
6. 暂停/重开须重新验证元数据、签名和当前账号权限，并保留既有固定 revision、可信片段及安装事务边界；状态、错误、日志不含授权 URL 或令牌。
7. 用隔离小 ZIP 完成签名链 → SHA-256 → 安装/失败回滚集成验收，再分别核对真实公开元数据和用户主动操作时的真实私有授权。仅 HTTP 200、包结构解析或摘要长度不算密码学验收。

## 0.15 实现结果

固定官方根及认证、原始 metadata/manifest 验签、强内容摘要、旧密钥局部兼容和新鲜撤销检查已实现。每次 resolve 都重新取钥和签名资源，没有旧钥缓存，因此不需要历史建议中的缓存验签失败后刷新重试。受保护路由已扩展为三个固定根资源、complete manifest/manifest.asc 和 ZIP；六项独立授权，暂停重开后重新验签再续传，不提供任意 URL IPC。

该版独立签名测试 27/27、私有实签整合 8/8、全套 Node 821/821 及常规无界面 UI 54 项通过。签名 UI 使用独立测试根和真实验证器，暂停 65,536 字节、重开不联网、手动继续后共十二次资源授权及四次撤销检查，安装固定 revision 3 并保留预设。真实公开小资源也已使用固定生产根验算；没有下载其 ZIP 包体。详细边界见 [签名验证](pdx-signatures.md)，完整结果和制品证据见 [Roadmap](../ROADMAP.md)。

以上 0.15 数字与签名流程作为历史证据保留。0.16 已增加受管安装验证/同版修复，并通过使用真实验证器的 `--repair` 无界面流程，累计十八次资源授权和六次撤销查询；当前完整结果见 Roadmap。单文件网络修复、CPatch delta、官方 files 和内部缓存兼容继续待实现。真实 Electron、游戏、账号、Steam SDK 或发布验收仍未完成。
