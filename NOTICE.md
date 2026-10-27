# NOTICE

## 上游来源

本仓库是 [pillarjs/iconv-lite](https://github.com/pillarjs/iconv-lite) 的衍生项目。

| 项 | 值 |
|---|---|
| 上游仓库 | https://github.com/pillarjs/iconv-lite |
| 基线版本 | v0.7.3（tag `v0.7.3`，commit `43694e28291d3b0cb3a452c77be40c4fd3a4bd85`，2026-07-03） |
| 上游许可 | MIT（`LICENSE` 文件本仓库**逐字未改**，版权归 Alexander Shtuchkin） |
| 上游文档 | `docs/upstream-readme.md`（从仓库根 `README.md` 移入，内容未改） |

本仓库保留了上游全部提交历史（`git log` 可追溯到 2013 年），本层的改动以追加提交形式存在。

## 本仓库改动了什么

**codec 层零改动**：`lib/`、`encodings/` 下 14 个文件逐字节与上游 v0.7.3 相同，
由 `gate/test/upstream-guard.test.mjs` 用 sha256 基线（`gate/test/fixtures/upstream-0.7.3.sha256.json`）锁定。

改动集中在项目元数据与新增目录：

| 路径 | 性质 |
|---|---|
| `package.json` | 改名 `encgate`、新增 `bin`、`scripts.test:gate`、`engines >=18`、`files` 追加 `gate/` `bin/` |
| `README.md` → `docs/upstream-readme.md` | 移动（保留上游文档），根 `README.md` 改写为本项目说明 |
| `test/webpack/index.js`、`test/webpack/package.json` | 包名自引用同步（`iconv-lite` → `encgate`），否则 webpack 冒烟测试取不到包 |
| `.gitattributes` | 新增：统一 LF，`test/gbkFile.txt` 声明为二进制以免破坏上游夹具 |
| `gate/`、`bin/`、`docs/EVIDENCE.json` | 新增：转码闸门实现、CLI、证据 |

## 新增代码的版权与许可

`gate/`、`bin/`、`docs/` 等新增文件由 encgate contributors 编写，以 **MIT** 许可发布，
与上游同一许可，条款见根目录 `LICENSE`（该文件为上游原文，未追加任何段落）。

MIT 允许再发布与修改，条件是保留版权声明与许可声明——本文件与未改动的 `LICENSE` 共同满足该条件。

## 测试语料

`gate/test/fixtures/corpus/*.txt` 取自 [microsoft/vscode-loc](https://github.com/microsoft/vscode-loc)（MIT）中
VS Code 语言包的人工翻译文案，仅用于"同一体裁、不同语言"的编码探测对照。
不随包分发（`files` 字段未包含 `gate/test/`），逐文件来源与再生成命令见
`gate/test/fixtures/corpus/PROVENANCE.md`。

汉字频次表 `gate/frequency.mjs` 由 `gate/scripts/build-freq.mjs` 从本机真实中文文档统计生成，
不含任何原文片段，生成命令写在文件末尾注释里。
