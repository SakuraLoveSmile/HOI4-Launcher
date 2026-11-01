# OpenPGP.js 第三方材料与替换说明

IRONCLAD 的 CPatch 签名验证使用未修改的 **OpenPGP.js 6.3.2**（npm 包 `openpgp`）。上游为 [openpgpjs/openpgpjs](https://github.com/openpgpjs/openpgpjs)，许可声明是 **LGPL-3.0-or-later**，npm 元数据记作 `LGPL-3.0+`。本说明只记录该第三方库的交付材料；IRONCLAD 自有代码的 MIT 许可不因此改成 LGPL。

## 随包材料

`licenses/` 与可替换的库文件一同分发，包括：

- `LGPL-3.0.txt`：与所安装 npm 包 `LICENSE` 逐字节一致的完整 LGPL v3 文本。
- `GPL-3.0.txt`：LGPL v3 引用的完整 GPL v3 文本，取自 GNU 官方站点。
- `openpgp-6.3.2-source.tar.gz`：上游 `v6.3.2` 标签的源码归档，包含 `src/`、`package-lock.json`、Rollup 配置和构建命令。
- `openpgp-6.3.2-materials.json`、`SHA256SUMS.txt`：来源、版本、大小与材料 SHA-256。
- `README.md`：随二进制保留的库归属、源码、重建及替换说明。

源码包为 **1,196,260 字节**，SHA-256 为 `1e0b14b06e18a958960c36749c02b575c0bd16df2b6b8bf3ed5c11938e61ff05`。归档的 Git PAX 注释为 `5f33328a3b601fb9c9dce310d1ecc137db0dbc75`，与 npm 6.3.2 的 `gitHead` 相同；归档内 `package.json` 的包名、版本和许可也已核对。本次只读取归档成员，未提取或执行其中代码。

上游地址为：

- [源码标签](https://github.com/openpgpjs/openpgpjs/tree/v6.3.2)
- [已保存的源码归档来源](https://codeload.github.com/openpgpjs/openpgpjs/tar.gz/refs/tags/v6.3.2)
- [npm 精确版本](https://www.npmjs.com/package/openpgp/v/6.3.2)

`node_modules/openpgp/` 的运行时文件采用 npm 原始发布字节，保留其 `LICENSE`、运行入口/依赖等包元数据、JavaScript 构建文件和内嵌版权头。打包工具会省略上游 README 和开发用元数据；上游 README 保留在随包源码归档中。Node CJS 构建包括 OpenPGP.js 的 LGPL 声明及 noble-ciphers、noble-hashes、noble-curves 的原始 MIT 版权头；不得因压缩、复制或替换而去除这些声明。源码重建安装的依赖另遵循其各自许可，锁文件保留具体来源和版本。

## 独立模块与替换

Electron 制品把 OpenPGP 的独立运行模块放在 `resources/app.asar.unpacked/node_modules/openpgp/`，不把它合并到 IRONCLAD 业务代码或浏览器构建中。运行时的 CommonJS `require` 使用这份独立模块；静态制品核验检查它的入口、JavaScript 文件、许可内容和解析路径。实际打包状态以该版本的 `package-verification.json` 为准。

可对库进行修改和替换，也可为调试这些库修改而分析应用与该库的交互。IRONCLAD 不另加禁止这些操作的许可条款。替换时保留应用所调用的 CommonJS API；实际入口由库的 `package.json` 中 `exports.require` 指向 `dist/node/openpgp.min.cjs`。替换包还应提供它所需的其他库文件和依赖。

操作前关闭 IRONCLAD，备份原 `node_modules/openpgp/`，再把同接口的替代库放到上述独立目录。官方便携 EXE 会先解压再运行；直接修改某次启动的临时目录可能随退出丢失。需要长期使用修改版时，使用源码构建生成的 `release/win-unpacked/` 目录副本，或解出完整应用目录后替换其独立模块。保留原启动器代码和 `app.asar` 即可；不要求修改签名验证代码里的官方信任根。

原版制品核验记录的是原版库的哈希，替换后自然不再与该记录相同。库替换不表示模组签名一定会通过，也不保证任意不兼容 API 可以运行。实际签名验证和运行结果仍应单独测试。

## 从已附源码重建

在独立工作目录解开 `openpgp-6.3.2-source.tar.gz`，使用上游要求的 Node.js 22 或更新版本及兼容 npm，进入 `openpgpjs-6.3.2/`。以下命令使用归档内锁文件安装构建依赖，然后调用原构建脚本：

```powershell
npm ci --ignore-scripts
npm run build
npm run build-types
```

把生成的 `dist/`、上游 `package.json`、`LICENSE`、README 及所需文件作为完整库替换，保留所有原版权声明。构建依赖安装需要相应 npm 资源；归档中的 `package-lock.json` 固定了依赖来源和完整性摘要。上游编译产物可能带构建日期等信息，重新构建不承诺与 npm 发布的压缩文件逐字节相同。

本次材料核对没有运行这些构建命令。应用仓库中的替换解析测试与包静态检查用于证明独立模块交付方式，不能替代修改后库的功能测试或新 Electron 运行验收。
