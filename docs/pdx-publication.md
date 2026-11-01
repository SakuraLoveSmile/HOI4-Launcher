# HOI4 Paradox Mods 发布 provider

核对与实施日期：2026-10-28。实现为 `electron/pdx-publisher.cjs`，对齐 Windows Steam 版 HOI4 的 Paradox Launcher v2.2026.12。该模块在用户确认后打包已审核的文件快照、上传内容并新建或更新 Paradox Mods 项目；构造服务不登录、不访问网络、不上传。UI 与公共发布服务负责用户确认、预览图要求、审核快照和持久化记录。

## 静态依据与验证边界

协议来自本机官方 `resources/app.asar` 中的 `dist\main\index.mjs`、`dist\preload\index.mjs`、`dist\renderer\assets\mods-upload-BOZZ8zFN.js`，以及公开 ModsWeb/2.6.1 bundle。只读取静态实现，没有执行官方打包代码，也没有复用官方凭据。

本次 provider 验证使用临时文件、假账号适配器和假发布响应，覆盖成功、错误、账号切换、快照变化、持久化失败及恢复。未使用真实账号登录、上传或发布，因此没有宣称真实服务器端到端发布已经验证。公开元数据与 CDN 研究见 [pdx-content-delivery.md](pdx-content-delivery.md)。

## 接口与职责

```js
createPdxPublisher({
  account, // getAccount、request、uploadFile
  createArchive, // 对审核快照生成 ZIP
  onPublishStatus, // async：必须完成持久化后才 resolve
  pollIntervalMs: 2500,
  maxPolls: 48,
});
```

返回 `getState()`、`validatePublishTarget(id)`、`startPublish(input)`、`getPublishStatus()`、`refreshPublish(persistedJob)` 与 `dispose()`。`startPublish` 和 `getPublishStatus` 同步返回快照；耗时任务在后台串行执行。同一实例一次只接受一个发布或恢复任务。

发布输入包含 `id`、`actorId`、`existingItemId`、绝对路径 `contentPath`、`files`、标题、长描述、简介、标签、更新说明、推荐游戏版本，以及可选 `previewPath`。每个审核文件包含 `relative`、`size`、`hash`、`targetIno`、`targetDev`，其中 `hash` 是 SHA-256，文件集合须包含根级 `descriptor.mod`。普通 Node Windows stats 的 inode 数字可能超过安全整数范围；接口保留其原始数值表示用于一致性比较，内容完整性同时依赖长度和 SHA-256，不仅依赖 inode。

`createArchive` 接收 `{contentPath, files, signal, onProgress}`，返回 `{path, bytes, sha256, cleanup}`。ZIP 文件通过账号适配器流式 PUT；provider 不把整个归档读进内存。归档最终长度须严格小于 5 GiB；源文件总长度采用本应用的 200 GiB 上限，避免误拒绝压缩后符合要求的内容。无论上传、提交或查询是否成功，都调用归档清理函数。

每次账号 API 和上传均携带 `expectedAccountId`；账号适配器必须把请求绑定到该账号，不能在令牌刷新或账号切换后以其他账号继续请求。provider 还在打包前、上传前、提交前和确认成功前复查身份。

## 更新所有权检查

官方已发布列表是带身份的搜索请求：

```text
POST /mods
{"gameNames":["hoi4"],"onlyModsByMe":true,"page":0,"pageSize":100}
```

`page` 从 0 开始，响应包含 `mods`，可包含 `totalCount`。实现读取到空页或完整且一致的 `totalCount`，最多接收 10000 条；重复 ID、变化或异常的总数、异常页大小会使检查失败。此 POST 仅查询，不发布。

目标必须存在于当前账号的列表，然后通过 `GET /mods?modId=<id>` 核实 `modDetail.modId`、`game:"hoi4"` 和真实发布名称 `name`。不使用作者显示名判断所有权。更新前要求 `updating === false`，记录 `modVersion`（缺失时用 `latestVersion`）作为 `baseRevision`，并在上传前和提交前复查目标名称及 revision 没有变化。

## V1 上传与提交

```text
PUT /mods/content/hoi4/<publicationName>/content/<filename>
PUT /mods/content/hoi4/<publicationName>/thumbnail/<filename>
POST /mods/publish
POST /mods/publishUpdate
```

新建发布生成 UUID 作为 `publicationName`，更新采用服务器返回的真实 `name`。内容文件名为 `content_<jobId>.zip`，缩略图使用固定的 `thumbnail.png`、`thumbnail.jpg` 或 `thumbnail.jpeg`。路径字段都经过限制，不接受任意 API 路由或远端上传地址。

提交 body：

```js
{
  modName: publicationName,
  gameName: "hoi4",
  contentFileName,
  thumbnail,                 // 本次有上传缩略图时才传入
  os: "Any",
  arch: "Any",
  longDescription,
  shortDescription,
  displayName,
  tags,
  recommendedGameVersion,
  modId,                     // 仅更新
  changelogEntry,             // 仅更新；空内容使用官方空格占位
}
```

官方 V1 提交没有 `acl` 或 `visibility` 字段。本实现不猜测或承诺服务器默认可见性；提交前的界面应显示“服务器默认”，不可承诺私有或隐藏。确认详情实际返回 `acl` 后，任务才可记录 `visibility`。公开网站关于新上传默认隐藏的文案，不能证明此 V1 协议有同样默认行为。

## 官方字段约束与本应用限制

| 字段         | 静态官方校验                              | 当前实现                                          |
| ------------ | ----------------------------------------- | ------------------------------------------------- |
| 标题         | trim 后 3–60 个 JavaScript 字符           | 同长度规则，不用 Steam UTF-8 字节限制             |
| PDX 长描述   | 清理标记后的长度至少 10，未发现配置最大值 | 相同计数；本应用额外限制原始输入 1000000 字符     |
| PDX 简介     | 清理标记后的长度 10–200                   | 相同计数；原始输入最多 10000 字符是本应用资源限制 |
| 更新说明     | 最多 5000 字符                            | 最多 5000                                         |
| 推荐游戏版本 | 最多 12 字符                              | 最多 12，限制为版本字符；空值用 `*`               |
| 标签         | 最多 10 个                                | 最多 10，每个最多 256 字符是本应用附加限制        |
| 缩略图       | JPEG/JPG/PNG，`maxSize = 1e6`             | 扩展名相同，最大 1000000 字节，包含边界值         |

官方 preload 使用 `sanitize-html(value, {allowedTags:[]})` 后取 `.length`。provider 使用相同依赖与选项计数，清理标签和 script/style 内容，并按 sanitizer 实际返回的字符串处理实体转义；不是简单去标签或按可见字符数猜测。原始描述仍作为数据提交，预览应以文本显示，不能直接作为 HTML 执行。

缩略图的官方 MIME 白名单为 `image/jpeg`、`image/jpg`、`image/png`、`image/x-png`，没有 MIME 时允许按扩展名校验。Dropzone 在 `size > 1000000` 时拒绝，所以恰好 1000000 字节允许，1000001 字节拒绝。这不是 1 MiB。provider 校验审核快照中的图片路径、常规文件、单链接、realpath、inode/device、长度和哈希；账号上传层还检查实际上传长度与哈希。provider 不解码或重编码图片，不把扩展名检查声称为图像内容检测。公共准备流程负责要求新建时提供缩略图；更新可省略以沿用现有图片。

## 持久记录、轮询和恢复

任务状态为 `queued`、`packing`、`uploading`、`publishing`、`succeeded`、`pending`、`failed`、`interrupted`。记录必须保留以下字段：

```js
{
  id, status, accountId,
  publicationName, itemId,
  existingItemId, baseRevision, commitSent,
  progress, error,
  visibility, // 只在实际观察到服务端值时记录
}
```

新建 UUID 在任何 PUT 之前通过 `onPublishStatus` 持久化；失败则停止上传。提交 POST 前先持久化 `commitSent:true`；持久化失败则停止提交。这个字段表示已进入可能提交的阶段，崩溃恢复时不能据此认定成功或安全重放。进度块更新内存状态，关键阶段和标识变更等待持久化完成。

提交响应中的 `modId` 立即保存。响应 `state` 为 `publishing` 或 `published` 都继续查真实详情，不用固定延时推定成功。新建要求 ID、游戏和 UUID 一致，且 `state:"published"`、`updating:false`；更新额外要求服务端 revision 高于 `baseRevision`，避免把旧版本成功状态当成本次上传完成。

达到轮询上限、提交响应丢失或提交后详情暂时不可读，均保留为 `pending`，不自动重发 POST。只有明确发布终态 `failed`、`rejected`、`removedByUser`、`disabledByManager` 等才记为远端失败。账号错误、超时与其他错误只显示预设文案，不输出令牌或原始异常。

`refreshPublish` 绑定原账号，读取该账号的已发布列表和详情。缺少 `itemId` 时按已保存 UUID 查找；找不到时继续待确认，不新建。不打包、不 PUT、不调用 publish/publishUpdate；查询到明确失败终态会返回 `failed`。已进入提交阶段的同一 job ID 在本实例中不能再次发布。公共发布服务必须保存并恢复记录，避免重启后绕过此保护。

`dispose` 取消后台工作；已经到达服务器的提交无法撤回，保留标识供后续查询。临时归档清理失败会附加提示，但不会把已经确认的远端成功改写为失败。

## 后台验证

```text
node --test tests/pdx-publisher.test.cjs
```

同一套测试还通过 Electron 45.1.0 的 `ELECTRON_RUN_AS_NODE=1` 模式执行，由隐藏子进程启动。覆盖 V1 body、分页所有权、新旧 revision、1 MB 图片边界、快照变化、持久化失败、账号切换、取消、无响应提交、暂时详情错误、明确拒绝状态和只读恢复；不打开前台窗口、不启动游戏、不进行真实远端写入。
