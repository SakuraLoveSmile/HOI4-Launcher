# HOI4 Paradox 账号订阅 provider

核对与实施日期：2026-10-28。实现位于 `electron/pdx-subscriptions.cjs`，只处理当前账号的 HOI4 订阅关系，不下载内容、不改本地安装、不创建或同步云预设。构造服务不会调用账号服务；只有调用方主动调用读取或变更方法后才执行请求。真实写入应仅由产品中用户点击触发。

## 已核实的协议

来源是本机 Paradox Launcher v2.2026.12 的 `resources/app.asar` / `dist\main\index.mjs` 静态实现，以及公开 ModsWeb/2.6.1 bundle。下面列出的形状是官方实际消费的协议字段；本次没有使用真实账号取得订阅响应，也没有发送订阅或取消订阅请求。

### 默认集合

官方 `nVe` 的 default-playset getter 首先检查游戏 `activationSets`。启用云预设时它不提供默认集合；HOI4 当前开关为 false，因此执行：

```text
GET /mods/sets/list/hoi4?includeShared=true
```

客户端读取的响应形状：

```json
{
  "sets": [
    {
      "id": 77,
      "owned": true,
      "state": "private",
      "preferredVersion": null
    }
  ]
}
```

这里的值仅为形状示例，不是真实账号数据。官方只有在 `sets.length === 1` 时把该集合视为默认集合，**没有通过 `isDefault`、集合名称或作者显示名识别**。本实现沿用唯一集合规则，并拒绝明确标记 `owned:false`、已移除、已禁用或声明为其他游戏的集合。返回零个集合时读取结果为空，不发起初始化写操作；多个集合时返回明确错误，不猜选某个云预设。

### 分页成员列表

官方 `Nze.getMods`、分页包装 `Ufe` / `xze` 和常量 `VCe=100` 确认：

```text
GET /mods/sets/<actualSetId>/mods?limit=100&page=1
GET /mods/sets/<actualSetId>/mods?limit=100&page=2
...
```

如果集合本身实际返回了 `preferredVersion`，客户端会传 `version=<setRevision>`；这是集合成员读取参数，不是给所有订阅模组设置同一版本。本实现只转发实际返回的数字集合版本。

响应由官方代码消费为：

```json
{
  "mods": [
    {
      "modId": "123",
      "displayName": "Example mod",
      "preferredVersion": null,
      "latestVersion": 12,
      "userModVersion": "1.0",
      "enabled": true,
      "loadOrder": 0
    }
  ],
  "count": 1
}
```

官方启动器读取 `mods` 数组，从第 1 页开始，直到空页停止；网站另外使用 `count`。本实现不因为最后一页不足 100 项而自行停止，也不依赖可变化的 `count` 判定完成；设置 10000 条、101 页上限，并拒绝重复 ID、异常页大小和不合法计数，防止截断列表被误报为完整列表。

官方 `St.mapPdxModToRegistryItem` 明确使用：

- `preferredVersion:null` 表示跟随最新版本；`latestVersion` 是当前最新服务端 revision。
- 非空 `preferredVersion` 表示固定版本；`userModVersion` 只是作者展示标签。
- 因此 provider 的 `items[].revision` **只在固定版本时存在**，不可把 `latestVersion` 填入并改变用户订阅语义。

列表项带 `game` 时必须为 `hoi4`。旧响应缺少 `game` 时，会通过当前账号的 `GET /mods?modId=<id>` 核验；核验失败则列表未知，不展示未经确认的其他游戏数据。列表接口返回 `result` 时必须为 `OK`；错误响应不会被转换为空订阅列表。

公开网站还使用 `GET /mods/installed?game=<game>&os=<os>&arch=<arch>&includeDependants=<...>&includeShared=<...>` 并读取 `mods`。本 provider 采用已核对的官方启动器默认集合分页契约，没有用这个额外接口猜测默认集合或分页行为。

### 订阅与取消订阅

官方 `subscribeMods` 形状：

```text
POST /mods/installed
X-Accept-Version: 2

{"activationSetId":77,"mods":[{"id":123,"version":5}]}
```

`activationSetId` 仅在前述唯一默认集合存在时传入实际 ID；没有集合时省略此字段，由订阅操作自身使用服务端默认行为。没有版本固定需求时也省略 `version`。**不创建集合、不把本地预设 ID 当作 activationSetId，也不启用 HOI4 当前关闭的云预设。**

官方调用方使用订阅响应中的 `mods[].id` 确认订阅结果：

```json
{ "mods": [{ "id": 123 }] }
```

本实现要求响应明确包含所请求 ID；缺少确认或格式异常时，报告结果未知，不自动重放写入。

取消订阅：

```text
DELETE /mods/installed?modId=123&activationSetId=77
```

集合参数同样可省略。官方取消调用不消费特定 body；本实现接受账号服务返回的 HTTP 204 对应 `null` 或无明确错误的对象，同时拒绝 `result:Failure` 等错误结果。该方法不会删除已下载的模组，也不会更改本地预设。

写入前总是通过授权的 `GET /mods?modId=<id>` 核验 game；请求固定历史版本时必须使用 `GET /mods?modId=<id>&modVersion=<revision>` 并要求返回相同 revision。不会因当前版本可见就推断历史版本可访问。订阅还拒绝未发布、区域限制或明确不允许安装的详情；取消订阅仅核验游戏归属，不要求模组仍处于可安装状态。

## 主进程接口

```js
const service = createPdxSubscriptions({
  account, // createAccountService 的 request / getAccount
  isGameRunning: async () => false,
});

await service.getState({ refresh: true });
await service.subscribe({ modId: "123", revision: "5" });
await service.unsubscribe("123");
```

通常返回：

```json
{
  "accountId": "<current account ID>",
  "items": [
    { "modId": "123", "title": "Example mod", "revision": "5" },
    { "modId": "456", "title": "Following latest" }
  ]
}
```

没有登录时读取返回 `{accountId:null,items:[]}`，写操作拒绝并提示主动登录。参数校验和写入前置失败通过带安全 `code` 的 Error 返回。`getState()` 可复用同账号的完整内存列表；`refresh:true` 强制重新读取。所有返回对象都是副本，调用方不能修改内部缓存。

列表未知时返回空 `items` 和结构化 `error`，空数组此时**不是“没有订阅”**：

```json
{
  "accountId": "<account ID, or null if no longer verified>",
  "items": [],
  "error": {
    "code": "REFRESH_FAILED_AFTER_WRITE",
    "message": "订阅变更已成功，但当前列表暂不可用。请刷新列表，勿重复提交。",
    "writeSucceeded": true,
    "operation": "subscribe",
    "modId": "123"
  }
}
```

必须区分以下结果：

| 结果                                       | 处理                                                           |
| ------------------------------------------ | -------------------------------------------------------------- |
| 正常返回、无 error                         | 列表已确认                                                     |
| `REFRESH_FAILED_AFTER_WRITE`               | 写入已确认成功，列表未知；只刷新列表，不重新发送写入           |
| `ACCOUNT_CHANGED_AFTER_WRITE`              | 原账号写入已确认，但随后切号/退出；不展示原账号列表            |
| `WRITE_NOT_YET_VISIBLE`                    | 写入已确认，但刷新列表尚未反映变更；保留提示并稍后只读刷新     |
| `MUTATION_UNKNOWN` / `outcomeUnknown:true` | 请求可能已到达服务端，回执缺失或无法识别；只读核对，不自动重放 |
| 明确错误结果或权限拒绝                     | 拒绝操作，保留明确错误；不声称成功                             |

## 账号绑定与并发

构造没有网络副作用。调用时通过 `getAccount` 捕获 ID，进入同一串行队列后再次核验；排队操作不能跟随用户切换到另一账号。每次 `account.request` 都提供 `expectedAccountId`，由账号服务在取当前会话和发送请求前原子检查，并由已有 epoch 阻止在途切号请求继续。不能用显示名判定同一账号。

读取完成时再次核验账号，切换或无法确认身份就丢弃旧缓存。变更前检查游戏运行状态；元数据和列表核验后、写入前再次检查。一次写入期间排队的相同操作共享该次结果，包含“已成功但刷新失败”和“结果未知”，不会由重复点击重放该次请求。相反动作仍依调用顺序执行。

账号服务可能在 `getAccount` 中恢复用户此前主动保存的会话或刷新已存在会话；provider 不调用登录、不索取凭据、不进行集合初始化，令牌不进入返回状态或日志。所有远端错误仅映射为固定提示，不转发任意响应文本。

## 验证与限制

使用 fake account 和隔离数据测试分页、缺少默认集合、多集合拒绝、固定版本、取消订阅 204、错误结果、重复点击、断网、回执未知、写后刷新失败、账号切换及游戏运行阻止写入。没有真实登录或订阅验收。

本实现有意只支持当前 HOI4 唯一默认集合布局。将来服务端若启用云预设或改变响应，应单独扩展协议，不能静默选择集合。旧列表项缺少 game 且其详情已不可访问时，归属核验会失败并保留“列表未知”；不会以未验证详情代表用户执行取消订阅。
