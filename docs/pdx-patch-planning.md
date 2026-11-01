# CPatch 清单与操作规划底座 · 0.20.0

0.20 增加可独立验证的多条目 manifest 解析、共享 Windows 路径规则和六类操作计划器，并把它们接入现有单 ZIP 下载链。**通用结果目前是数据计划，不授予文件系统访问、签名信任或安装提交权限。** 产品下载仍只接受一个目标 ZIP；当前实际新增的容器行为是空 operations 的可信旧 ZIP 复制、同目标 `d+n/p/k` 和无旧源 `p`。通用 `c/s`、任意多目标文件系统执行及提交尚未接通。

## 清单解析接口

[pdx-manifest.cjs](../electron/pdx-manifest.cjs) 导出同步纯解析器：

```js
const manifest = parsePdxManifest(input, {
  expectedName,
  maxBytes: 16 * 1024 ** 2,
  maxEntries: 100000,
  maxFileBytes: 5 * 1024 ** 3,
  maxTotalBytes: 20 * 1024 ** 3,
});
// { name, hashAlgorithm: "sha256", entries: [...] }
```

`input` 仅接受 Buffer 或 string，Buffer 会复制后解码；字符串中的孤立 surrogate 直接拒绝。UTF-8 必须有效，不接受 BOM 或控制字符。返回对象、entries 数组和各条目冻结，条目顺序保持输入顺序。`Name` 与 `Hash` header 均必填、各出现一次，未知 header 拒绝；header 名及 `sha256` 大小写精确。header 后的空行分隔内容，内容空行忽略，支持 LF/CRLF 和最后一行无换行。

内容逐物理行解析 CSV，支持引号和引号内逗号，不支持跨行字段。没有 `c` 时精确4列 `Path,Size,Hash,Flags`；有 `c` 时精确6列，再加 `UncompressedSize,CompressionAlgorithm`。flags 仅允许 `drwxcs`，保留输入次序和重复字符。Size/Hash/Flags 及可选压缩字段去首尾空白，Path 不去空白。

| 类型      | 输出字段                                          | 约束                                               |
| --------- | ------------------------------------------------- | -------------------------------------------------- |
| file      | `{path,type:"file",bytes,sha256,flags}`           | bytes 可为0；sha256 是64字符小写hex                |
| directory | `{path,type:"directory",bytes:0,sha256:"",flags}` | flags 含d；拒绝d+s或d+c                            |
| symlink   | `{path,type:"symlink",bytes:0,sha256,flags}`      | flags 含s；sha256必须有效，不读取目标              |
| 含c的条目 | 额外 `{unpackedBytes,compression}`                | 展开量可为0；compression是字符串，不自动选择执行器 |

输入摘要接受规范、带 `=` 填充的标准 Base64 或 Base64URL SHA-256，拒绝混用字母表、无填充、错误长度或非零尾位，统一返回hex。官方生成的规范编码为 padded Base64URL；双字母表接受策略延续已有内容服务。`s+c` 可以表达名字以 `.zip` 结尾的链接，压缩字段可为空；这不表示链接会被当作ZIP执行。未知compression仅保留为数据，由消费者拒绝。

默认输入16 MiB、每行最多64 KiB、最多100,000个显式条目，单条压缩/展开量各最多5 GiB。压缩总量与展开总量分别受20 GiB预算约束；无c的条目在展开总量中按bytes计。数值必须为规范非负十进制和JavaScript安全整数。错误只返回固定中文消息与 `INVALID_MANIFEST` 或 `RESPONSE_TOO_LARGE`，不包含原始行或远端输入。

当前 [内容服务](../electron/pdx-content.cjs) 在既有验签之后调用此parser，再额外要求**恰好一个普通ZIP条目**，其名称、大小和摘要继续绑定canonical计划。网络清单仍最多64 KiB；此调用为原展开量兼容将parser单条/总量上限设为20 GiB，随后再按具体下载限制核对ZIP字节数，补丁展开总量最多 `maxArchiveBytes + 64 KiB`。默认 `maxArchiveBytes` 为5 GiB。通用parser的16 MiB和多条目能力没有扩大生产下载capability或CDN路由。

## 共享路径与冲突规则

[pdx-patch-path.cjs](../electron/pdx-patch-path.cjs) 导出：

```js
normalizePdxPatchPath(value, { directory: false });
pdxPatchPathKey(value);
```

路径必须是Windows安全相对路径。反斜杠转 `/`，目录可移除单个尾 `/`；其他空段、`.`、`..`、绝对/UNC/盘符、控制字符、`<>:"|?*`、U+FFFD、孤立surrogate、片段尾点/空格及设备名均拒绝。设备名检查包含COM/LPT的¹²³及设备stem与扩展名之间的空格。UTF-8路径最多1024字节、每段255字节、深度64。

冲突key为 **NFC → Unicode uppercase → NFC**，保留原路径用于一致性检查；该保守规则也捕获final sigma、long s等仅lowercase会遗漏的别名。清单/计划拒绝同key重复、父目录拼写别名，以及普通文件或链接成为其他条目祖先。明确目录可与其子项同时存在，目录先后次序均可。该key用于冲突检测，不把磁盘路径改写为大写。目录单尾斜杠处理和严格路径约束属于本项目策略，不能当作官方normalizePath已证行为。

## 操作解析与计划接口

[pdx-patch-plan.cjs](../electron/pdx-patch-plan.cjs) 导出：

```js
const operations = parsePdxPatchOperations(bufferOrString);
const plan = createPdxPatchPlan({
  operations: rawOperations,
  targets: targetManifest.entries,
  sources: oldManifest.entries, // 可省略，默认 []
  payloads: [{ path: "target.zip.vcdiff", bytes: 123 }],
});
// { deletes, directories, actions, operationCount }
```

`createPdxPatchPlan` 接收原始operations文本/Buffer，内部解析，不能将上面的已解析数组直接传入。清单参数是typed entries，必须含安全path、file/directory/symlink类型、bytes和hex sha256；目录必须0/空摘要，链接必须0/有效摘要。计划只保留这四个身份字段，不把flags、codec或任意对象当作权限。

operations 每行精确按 `: ` 分隔，类型首尾Unicode空白允许去除，路径按共享规则处理。支持LF/CRLF、无尾换行及完全空文件；一个普通尾换行不产生空操作，真实空行、注释、未知类型或额外分隔符会失败。操作数组、计划及嵌套身份对象冻结。

| 操作 | 计划规则                                                                                                                 |
| ---- | ------------------------------------------------------------------------------------------------------------------------ |
| d    | 必须存在于可信source或target命名空间；独立放入deletes，带 `directoryPolicy:"empty-only"`，同路径重复删除拒绝             |
| c    | 目标必须为明确或隐式目录；重复创建合并，directories按父目录深度优先排列                                                  |
| n    | 目标必须为file；同名payload长度须等于目标bytes                                                                           |
| p    | 目标必须为file；payload为 `<path>.vcdiff` 且非空；有同路径普通旧源则绑定它，无旧文件则绑定0字节空源，旧源为symlink时拒绝 |
| k    | 同路径旧source必须与目标type/bytes/sha256全部一致，无payload                                                             |
| s    | 目标必须为symlink；同名payload长1–4096字节；仅记录payload身份，不解码或创建链接                                          |

同路径只能有一个 `n/p/k/s` producer；`d` 与producer可同时出现，删除组从原行序列分离。计划的显式actions保留其相对顺序，之后遍历目标清单，为没有producer的每个非目录目标补 `implicit:true` 的k，仍须验证旧清单type/bytes/sha256一致。旧source中目标未列出的额外路径不会进入计划。所有必需的明确/隐式目标目录单独列出；未消费的payload拒绝。

操作文本最多8 MiB，单物理行必须小于64 KiB，最多100,000行；targets、sources、payloads数组各最多100,000项。source和target命名空间各最多100,000节点，**含隐式父目录**。单文件/单payload最多5 GiB，source、target、payload分别累计最多20 GiB。该预算独立于下游单ZIP容器更小的预算。

| 错误code             | 典型原因                                                             |
| -------------------- | -------------------------------------------------------------------- |
| INVALID_INPUT        | 参数类型、typed entry或数值身份无效                                  |
| PATCH_INVALID        | 操作语法、路径/命名空间冲突、重复producer、缺少payload或错误目标类型 |
| PATCH_UNSUPPORTED    | 未支持的操作、未消费payload、p要求读取旧symlink                      |
| PATCH_RESOURCE_LIMIT | 文本、数量、命名空间节点、总字节或s payload预算超限                  |
| SOURCE_CHANGED       | k/隐式补齐缺少旧源，或旧源type/bytes/sha256不匹配                    |
| HASH_MISMATCH        | n payload声明长度与目标不符                                          |

上述错误不证明磁盘实际字节已经验证。计划器不打开文件、计算payload内容摘要、校验签名、联网、创建目录/链接、递归删除或提交事务；它也不提供任意多目标执行的依赖调度保证。真正执行者还必须绑定稳定读写能力、验证实际内容与权限、限制链接目标，并完整校验最终目标。

## 当前实际接入的单 ZIP 子集

[pdx-patch-archive.cjs](../electron/pdx-patch-archive.cjs) 继续只接受可信complete指定的一个简单ZIP文件名，所有operations必须命名同一目标。允许最多一个d和一个n/p/k，两个操作的文本先后次序均可；c/s、第二个producer、任意其他目标或额外payload拒绝。

空operations或仅d时，从可信旧ZIP隐式复制，要求源与目标bytes/sha256完全一致，并重读实际源摘要；没有可信旧源则失败。`n`从同名payload生成目标，`p`从 `.vcdiff` 重建，显式k复制旧源。无source的p使用可信空源身份及0字节reader，只能成功解码不引用旧源的合法补丁，最后仍须匹配complete摘要。

目标和scratch均为新的稳定工作区handle。这里的d只表示对新空目标的逻辑删除阶段，不删除、截断或修改旧缓存、旧安装或玩家目录。它没有扩展工作区的物理删除权限。容器仍先验证补丁包体，再校验entry/local header、CRC、展开预算及操作计划，最终重读目标后交给原安装事务。预算、工作区证明及缓存边界见 [增量内核](pdx-delta-core.md)。

空operations的归档仍有非空ZIP包体，但其所有entry展开总量可以是0。该0值在已签名repository/补丁manifest、canonical transferPlan和checkpoint计划key中保持一致；不能省略该字段或把它混同于0字节目标ZIP。暂停只发生在传输阶段，重开不联网，显式继续仍需重新验签/授权和核对同一旧源缓存。

## 证据与剩余工作

静态依据见 [manifest布局](../.work/cpatch-manifest-layout.md) 和 [官方通用操作](../.work/cpatch-general-operations.md)：官方单独目标目录补齐遍历目标complete，operations不必列齐不变文件；d先分类，s payload是原始目标文本。静态观察不等于任意真实CDN补丁已运行通过。

隔离测试见 [manifest](../tests/pdx-manifest.test.cjs)、[plan](../tests/pdx-patch-plan.test.cjs)、[archive](../tests/pdx-patch-archive.test.cjs) 和 [签名整合](../tests/pdx-patch-integration.test.cjs)。覆盖路径大小写/NFC与祖先冲突、预算、六操作规划、隐式补齐和冲突producer；生产签名验证器结合隔离夹具覆盖空operations补丁暂停于64字节→服务重开不联网→精确Range继续→安装、d+n保留旧安装，以及files实际404后的无源p修复。这里的签名与安装器为生产模块，网络、账号和内容是隔离夹具，不代表真实CDN或账号验收。

当前0.20全套、无界面UI和制品核验以 [Roadmap](../ROADMAP.md) 最终归档为准。0.19真实大型p及实际n安装补丁的既有证据继续保留在 [差分验收](official-patch-acceptance.md) 与 [安装验收](official-install-acceptance.md)，不计作0.20重跑。通用文件系统执行与多目标事务、实际k/CDN/账号、其他codec/仓库变体、官方内部缓存/checkpoint格式、Electron/便携程序/游戏/Steam SDK/发布验收仍待完成。
