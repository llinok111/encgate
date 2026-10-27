# encgate

**转码闸门：在产出字节之前，先精确说出会丢哪些字、丢在第几行第几列；产出之后再复核一遍。**

`encgate` 建立在 [iconv-lite](https://github.com/pillarjs/iconv-lite) v0.7.3 之上（MIT，npm 周下载量级 2.5 亿）。
codec 层逐字节未改——它在"编解码"这件事上是可靠的；缺口在**它从不告诉你这次转码会损失什么**：

```js
const iconv = require('iconv-lite')
iconv.decode(iconv.encode('价格：￥199 — 含税 🎉 “限时”', 'gbk'), 'gbk')
// → '价格：￥199 — 含税 ? “限时”'      ← 一个字符消失了，没有任何警告，也没有任何 API 能问"会不会丢"
```

这不是理论问题。把 CSV / Markdown / 字幕导出成 GBK 给遗留系统时，emoji、增补平面汉字、`⇒`、`✓`、`²`
都会静默变成 `?`；有些字符更糟——**不产生 `?`，而是直接换成了另一个字符**（Shift_JIS 的 `¥`→`\`、`‾`→`~`）。

```
$ encgate analyze 导出.csv --to gbk
导出.csv → GBK
结论：会丢 3 个字符（1.2%），涉及 2 个不同字符
字节：248（预测） / 248（实测）

字符  码点      次数  结果      位置                  建议
🎉    U+1F389  2     "?"      3:14 3:41             → (删除) drop
⇒     U+21D2   1     "?"      7:2                   → "->" lossless
注：如需保留这些字符，可改用 gb18030
```

## 30 秒上手

```bash
npm install          # 本仓库自带 codec 与全部依赖，无需发布到 registry
node bin/encgate.mjs analyze  文件.txt --to gbk       # 只预测，不产出
node bin/encgate.mjs detect   文件.txt                # 源编码是什么
node bin/encgate.mjs transcode 文件.txt --to gbk      # 有损则拒绝产出（退出码 1）
node bin/encgate.mjs transcode 文件.txt --to gbk --suggest   # 按建议替换后再转
node bin/encgate.mjs charsets                         # 支持的目标编码
```

要求 Node **>= 18**（`engines` 声明的下限，CI 在 18/20/22 上实跑）。

## 退出码是契约

| 码 | 含义 | 何时出现 |
|---|---|---|
| 0 | 无损 / 结论确定 | 目标字符集能表示全部字符 |
| 1 | 预测到损失 | 未加 `--force` 时**不产出任何文件** |
| 2 | 用法或 IO 错误 | 未知选项、字符集不支持、输出路径与输入相同 |
| 3 | 结论不可信 | 短样本、源编码无法确定、复核不一致 |

CI 里最常用的写法就是 `encgate transcode x.csv --to gbk`：退出码非 0 即拦下发布。

## 库 API

```js
import { analyze, detect, transcode, preflight, probeTarget } from 'encgate/gate/index.mjs'

const report = analyze('中文 🎉', 'gbk')
// {
//   lossless: false, verified: true,
//   counts: { codePoints: 4, lossyCodePoints: 1, distinctLossy: 1, lossyRatio: 0.25 },
//   bytes: { predicted: 6, actual: 6 },
//   groups: [{ codePoint: 'U+1F389', char: '🎉', verdict: 'replaced', becomes: '?',
//              count: 1, bytes: 1, positions: [{ line: 1, column: 4, index: 3 }],
//              suggestion: { text: '', why: 'emoji/象形符号…', risk: 'drop', verified: true } }],
// }

const plan = preflight(buffer, { to: 'gbk' })            // 只预测
const out  = transcode(buffer, { to: 'gbk', force: false })  // 拒绝产出时 buffer === null
// out.manifest 记录 sourceSha256 / outputSha256 / 损失清单 / 复核方式，且不含时间戳（可复现）
```

`verdict` 分四类，语义不同不能混为一谈：

| verdict | 含义 | 输出里能否看出来 |
|---|---|---|
| `ok` | 可表示，回环不变 | — |
| `replaced` | 不可表示，被替换成占位符 | 能（出现 `?`） |
| `substituted` | 可表示，但**换成了另一个字符** | **不能**（没有 `?`，字却变了） |
| `dropped` | 编码后长度 0 | 能（字符消失） |

## 实测证据（全部可复现，非宣称）

**1. 预言与真实转码的一致性**（`npm run exactness` → `docs/EVIDENCE.json`）

| 项 | 数值 |
|---|---|
| 码点断言 | **232,414** 条（14 个目标字符集 × 16,601 个码点） |
| 逐码点判定与真实转码分歧 | **0** |
| 整串复核不一致 | **0** |
| 字节数预言与实测不一致 | **0** |
| 静默改写（无 `?` 但字变了） | Shift_JIS / EUC-JP 各 **2** 个码点：`U+00A5`→`\`、`U+203E`→`~` |

**2. 源编码探测**（`npm run bench:detect`，真实人工翻译语料 4 种语言 × 5 种样本长度 × 每格 20 样本 = 700 件）

| 实现 | 首选正确 | 误判（给出确定答案但错） | 明确说"不确定" |
|---|---|---|---|
| encgate | **88.4%** | **0.1%** | 11.4% |
| chardet@2.2.0 | 51.7% | 48.3% | 0%（永远给答案） |

差别不在"更准"，而在**把"不知道"当成合法输出**：16 字节以下一律 `inconclusive`，让调用方转人工，
而不是赌一个 48% 会错的答案。

**3. 真实文档的下游影响**（`npm run evidence -- --dirs ..`）

| 项 | 数值 |
|---|---|
| 语料 | 本机 **80** 个真实中文文档 / **575,601** 个码点 |
| 直接转 GBK 会丢字的文件 | **29** 个，合计 **183** 个码点 |
| 按建议表可自动替换 | **120** 处（其余需人工决定） |
| 高频丢失字符 | `🔴`(33) `⇒`(26) `−`(16) `►`(16) `✅`(12) `❌`(9) `²`(8) `©`(8) |

## 与相邻工具的区别

| | encgate（本项目） | iconv-lite（上游） | 编码取证类工具 |
|---|---|---|---|
| 回答的问题 | 转成目标编码**会不会丢字** | 编解码本身 | 这个文件**是什么编码**、已经乱码了怎么修 |
| 时机 | 转码**之前** | 转码当下 | 事故**之后** |
| 输出 | 逐字符 verdict + 行列 + 建议 + 复核清单 | 字节 | 编码判定 + 证据 |
| 静默改写 | 单列一类，不与"替换"混淆 | 不可见 | 不涉及 |

本仓库**不提供** mojibake 还原（`repair`）。已乱码文件的取证与还原属于另一条工具链，
两件事混在一个 CLI 里会让"推断"和"确认"边界变糊。

## 设计取舍（每条都有实测依据）

1. **不靠替换字符的字面值判断损失**。`iconv.defaultCharSingleByte` 是模块级可变全局，用户可以改成 `□`；
   判定一律用 `decode(encode(ch))` 回环比对，并有专门测试把替换字符改掉后复测。
2. **单字节候选在探测中封顶 0.55，且多字节候选"零结构错误"时不参与胜出**。
   windows-1252 能解码**任何**字节串，结构上永不出错，不加这条规则它会把所有 GBK/Big5 样本都判成 cp1252
   （第一版就是这样，实测 GBK 中文被判成 windows-1252）。
3. **字频分用 `mean × coverage²`，不用均值**。实测真实解码的汉字覆盖率 0.998–1.0、错误解码 0.28–0.75，
   区分力来自覆盖率而不是均值。
4. **汉字区对中日韩没有区分力**。GBK 解韩文字节得到的**还是汉字**，所以日文把汉字算 0.85 权重、
   韩文算 0.5，靠假名/谚文这两种"身份标记"拉开差距。
5. **增补平面字符在单字节编码里会产出两个占位符**（按 UTF-16 码元拆），所以"输出里 `?` 的个数 = 丢字数"
   这个常见假设在 emoji 上就是错的。
6. **`--suggest` 之后要重新判定**，替换后仍有无损结论才产出；不接受"悄悄降级"。
7. **清单不带时间戳**：同一输入 + 同一参数必须产出逐字节相同的清单，否则归档校验与 CI 复现全部失效。

## 已知限制

1. **探测在短样本上不猜**：< 32 字节一律 `inconclusive`；16 字节的 Shift_JIS 样本首选正确率只有 0%（全部转人工）。
2. **GBK 与 GB18030 在字节层面不可区分**（后者是前者超集），统一按 `gb18030` 给出。
3. **Big5 与 Big5-HKSCS、GBK 与 Big5 在部分样本上仍会混淆**：同为双字节区，只有字频与假名密度可依。
4. **纯 CJK 的无 BOM UTF-16 与本项目无关但容易混淆**：本项目的 UTF-16 判定依赖零字节分布，纯 CJK 无 BOM 时不判。
5. **`utf7` 的字节偏移不可按字符推算**（有状态编码），因此不提供逐字符字节数核对。
6. **建议表只做有语义依据的映射**（印刷体标点→ASCII、全角→半角、数学符号→ASCII 记法），
   不做形近字替换；表里没有的字符只能人工决定。
7. **不做自动编码嗅探的"修好给你"**：本项目只报结论，不静默改写调用方的数据。
8. 上游 codec 的已知缺陷（如某些字体/宽度相关的边缘行为）本项目不修，只在必要时绕过并记录。

## 目录结构

```
gate/                 本层源码（零改动上游）
  analyze.mjs         损失预测 + 整串复核 + 建议挂载
  probe.mjs           逐码点探针（回环判定，带缓存）
  detect.mjs          源编码探测（BOM/UTF-8 严格校验/UTF-16/双字节评分）
  suggest.mjs         替代建议表（每条都用探针复验）
  transcode.mjs       预检 → 执行 → 复核 → 清单
  charsets.mjs        目标字符集元数据
  frequency.mjs       汉字频次表（由真实语料生成，含生成命令）
  scripts/            证据与工具脚本（exactness / bench-detect / downstream-demo / build-freq / make-fixtures）
  test/               57 条测试（node:test），含精确性、探测、CLI 契约、上游守卫
bin/encgate.mjs       CLI（退出码契约）
lib/ encodings/       ← 上游 codec，逐字节未改（有 sha256 守卫测试）
docs/EVIDENCE.json    精确性证据（由脚本生成，`--check` 可验漂移）
docs/upstream-readme.md  上游原始文档
```

## 开发与测试

```bash
npm install
npm run test            # 上游 154 条 + 本层 57 条
npm run test:upstream   # 只跑上游（基线：154 passing）
npm run test:gate       # 只跑本层
npm run exactness       # 精确性网格（打印）
npm run exactness:write # 重新生成 docs/EVIDENCE.json
npm run exactness:check # 证据漂移检查（CI 用）
npm run bench:detect    # 探测基准（含 chardet 对照）
npm run evidence -- --dirs <目录>   # 真实文档下游影响
```

## 来源与许可

- 上游：[pillarjs/iconv-lite](https://github.com/pillarjs/iconv-lite) v0.7.3（commit `43694e2`，2026-07-03），**MIT**。
  本仓库保留其完整提交历史，`LICENSE` 逐字未改。
- 本层新增代码：`gate/`、`bin/`、`docs/`、`.gitattributes`，同样以 **MIT** 发布，版权与来源声明见 [NOTICE.md](NOTICE.md)。
- 测试语料：`gate/test/fixtures/corpus/*.txt` 取自 [microsoft/vscode-loc](https://github.com/microsoft/vscode-loc)（MIT），
  逐文件来源与再生成命令见 `gate/test/fixtures/corpus/PROVENANCE.md`。
