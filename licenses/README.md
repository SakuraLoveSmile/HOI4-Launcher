# OpenPGP.js 6.3.2

IRONCLAD 使用未修改的 npm 包 `openpgp` **6.3.2**，上游 [OpenPGP.js](https://github.com/openpgpjs/openpgpjs)，许可为 LGPL-3.0-or-later（npm 声明 `LGPL-3.0+`）。IRONCLAD 自有代码继续采用 MIT 许可；此处材料用于该独立第三方库。

本目录包含完整 `LGPL-3.0.txt`、其引用的 `GPL-3.0.txt`、上游 `v6.3.2` 对应源码 `openpgp-6.3.2-source.tar.gz`，以及来源/哈希记录 `openpgp-6.3.2-materials.json` 和 `SHA256SUMS.txt`。独立运行模块保留库原始 JavaScript、`LICENSE`、运行入口/依赖等包元数据和内嵌版权头，包括 noble-ciphers、noble-hashes、noble-curves 的 MIT 版权头。打包工具省略上游 README 和开发用元数据；上游 README 保留在本目录的源码归档中。

源码归档 SHA-256：`1e0b14b06e18a958960c36749c02b575c0bd16df2b6b8bf3ed5c11938e61ff05`；大小 **1,196,260 字节**。归档内 Git 注释和 npm `gitHead` 都是 `5f33328a3b601fb9c9dce310d1ecc137db0dbc75`，内部 `package.json` 版本为 6.3.2。

上游源码与版本：

- https://github.com/openpgpjs/openpgpjs/tree/v6.3.2
- https://codeload.github.com/openpgpjs/openpgpjs/tar.gz/refs/tags/v6.3.2
- https://www.npmjs.com/package/openpgp/v/6.3.2

## 修改与替换独立库

库以独立 Node CommonJS 模块交付在 `resources/app.asar.unpacked/node_modules/openpgp/`，运行时通过 `require` 使用该模块。没有把库源码并入应用的浏览器包或业务代码。具体入口由该目录 `package.json` 的 `exports.require` 指向 `dist/node/openpgp.min.cjs`。

你可以修改、重建或使用接口兼容的替代库，也可以为调试库修改而分析应用与库的交互。IRONCLAD 不另加禁止这些操作的许可条款。替换前关闭应用并备份原库目录，再替换上述整个目录及替代库所需文件。保留版权及许可声明。

便携 EXE 会解压应用后运行；修改一次运行的临时目录可能在退出后丢失。持久使用修改库时，可使用源码构建生成的 `release/win-unpacked/` 目录副本，或解出完整应用目录，再替换其独立库。替换不要求重新编译应用 `app.asar` 或修改官方签名信任根。原版制品哈希用于辨识原版文件，替换库后的哈希自然会变化。

## 从所附源码重建

在独立目录解开所附源码归档，进入 `openpgpjs-6.3.2/`，使用上游要求的 Node.js 22 或更新版本和兼容 npm：

```powershell
npm ci --ignore-scripts
npm run build
npm run build-types
```

锁文件提供构建依赖的精确来源与完整性摘要，安装依赖需访问相应 npm 资源。替换时使用生成的 `dist/`，同时保留上游 `package.json`、`LICENSE`、README 和其他必要文件；构建工具及各依赖仍各自遵循原许可。重新构建可能使用不同构建日期，不承诺与 npm 压缩产物逐字节一致。此次材料收集没有执行上游源码或这些构建命令。

应用的原版包核验和替换解析检查说明独立库的分发结构。修改或替换后的库需另行进行接口、密码学功能及运行验证。

## Koffi 3.3.6

Steam 创意工坊的扩展排序使用未修改的 [Koffi 3.3.6](https://github.com/Koromix/koffi) 和同版本 `@koromix/koffi-win32-x64`，许可为 MIT。完整版权和许可声明随库保留在 `resources/app.asar.unpacked/node_modules/koffi/LICENSE.txt`；原生模块独立保留在相邻 `@koromix/koffi-win32-x64/win32_x64/koffi.node`。包核验检查版本、许可文件、入口和原生模块与已安装依赖一致。
