# PDX 历史内容：账号授权下载与会话绑定

2026-10-29。0.6.0 实现账号授权元数据与公开整包下载；0.13.0 增加 [受保护仓库完整 ZIP 授权](pdx-protected-repository.md)。使用隔离账号/HTTP/ZIP 验证，没有真实登录或历史包实网下载。已核实的匿名协议见 [内容分发契约](pdx-content-delivery.md)。

## 已确认的契约

API 固定主机为 `https://api.paradox-interactive.com`。官方 Web bundle 的详情请求为 `GET /mods?modId=<id>&modVersion=<revision>`，返回 `modDetail`；版本列表为 `GET /mods/versions?modId=<id>`，返回 `modVersions`。revision 是服务器编号，不是作者填写的 `userVersion`。现有 `account-service.cjs` 已允许这些只读请求，支持 `expectedAccountId`、取消及 401 刷新。

官方 Web bundle 对 API 使用账号 session 认证，对 `type:"cdn"` 请求返回空认证 headers。公开 HOI4 完整包使用 `https://modscontent.paradox-interactive.com/hoi4/<name>/repo/<os>__<arch>/<revision>/complete/manifest`，随后读取清单指定 ZIP。此公开路径使用固定 CDN；0.13 受保护路径使用账号 API 授予且经过校验的 HTTPS 域名。两种内容请求均保持 `credentials:"omit"` 和禁止重定向；遇到 401/403 停止，不能补发账号令牌。

本地静态证据：`test-results/paradoxmods-public-bundle.js` 字符偏移约 87080 为详情、87672 为版本列表、46357 为整包下载、70660 为 CDN/API 认证分流。官方 app.asar 的 `dist/main/index.mjs` 偏移约 1997597 为版本 API、2466325 为向 CPatch 发送 session、3061621 为 `set-auth-token` 命令。压缩文件偏移仅用于当前缓存定位，不是稳定接口。

现有匿名证据确认当前详情、版本列表、manifest 和 ZIP HEAD；历史 revision 11 的详情返回 401，见 `test-results/pdx-versioned-detail-157712.json`。尚无真实账号授权成功或历史 ZIP 下载证据。0.13 另经静态核对确认 CPatch 的完整资源授权 HTTP 契约，详见 [受保护仓库](pdx-protected-repository.md)；这不等于真实私有账号验收，V2 上传 presigned URL 也不能当作历史下载接口。

## 实现范围

支持需要账号读取详情的已有固定 revision：用户在“发现模组→本地下载→下载身份”选择当前账号，由当前账号取得并核对 ID、HOI4、revision、发布状态、ACL 和区域限制，再沿用完整包校验及安装。公开完整包沿用普通 CDN；非公开完整包使用匹配 repositoryPath 的独立 manifest/ZIP 授权。默认仍匿名，失败不会自动切账号，不宣称 CPatch 增量或内部缓存兼容。

`createPdxContentService({account,...})` 的 `resolve({modId,revision,expectedAccountId?,signal})` 缺省匿名。下载协调器接受 `authorization:"account"` 后，在主进程调用 `account.bindSession({signal})`，取得本次登录的账号 ID、取消信号和同步检查方法；再把该 ID 传给元数据请求。渲染器不能指定账号 ID，计划和下载日志不含会话信息。

绑定从异步初始化前捕获登录代次，覆盖元数据、CDN、安装前检查和安装取消信号。账号切换、退出及同账号重新登录使旧绑定立即失效；正常 token 刷新保持有效，服务判定过期则取消。中断错误显示账号变化或过期，任务结束释放绑定。安装在最后校验和日志落盘后检查取消；一旦开始提交，依据事务实际完成或回滚结果报告，不把已提交安装误报为取消。

HOI4 当前 `canSelectVersion:false`，先处理订阅/导入数据中的固定 revision，不增加任意版本选择器。重新启动后的重试重新授权，不自动重放先前账号请求。

## 验证

- 匿名模式不访问账号；账号模式传递准确路径、revision 和账号绑定。
- 元数据授权失败或 ID/游戏/revision/状态/区域不符时，不请求 CDN。
- CDN 无账号令牌和 Cookie；401/403 不猜地址、不切换认证方式。
- 账号切换、退出、同账号重新登录以及安装前取消均停止旧任务；正常续期保留绑定。
- 原有完整包长度、摘要、取消、安装回滚与恢复检查继续通过。
- 隔离测试与真实账号验收分别记录，不能用静态协议证据代替实际授权结果。

`tests/pdx-authorized-download.test.cjs` 组合真实账号服务、内容服务、协调器和安装器：ZIP 流只收到 16 字节后挂起，退出/同账号重新登录/真实 401 过期流程均无需等待服务器或超时便终止任务，未进入安装。0.7.0 保留可信断点，只有显式继续才重新授权并请求 Range 后安装小型夹具包；重新登录不会自动恢复任务。CDN 断言无账号认证或 Cookie，下载日志断言无账号标识和凭据。

0.6.0 隐藏 Electron 验证固定 revision 匿名失败→切换下载身份→重试→完整 ZIP 安装并保留预设，归档证据在 `test-results/0.6.0/pdx-authorized-download.json`。0.7.0 的 Electron 执行被自动审批拒绝，尚未复验。账号、网络和内容均为隔离夹具，无真实登录、订阅、下载或前台窗口。静态证据来自已留存的公开 bundle、本机官方代码和此前匿名探测；没有新增实网授权结论。
