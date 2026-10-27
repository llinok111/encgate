#!/usr/bin/env node
/**
 * 生成多语言测试语料（gate/test/fixtures/corpus/*.txt）。
 *
 * 语料来源：microsoft/vscode-loc（MIT）里 VS Code 语言包的 UI 文案。
 * 选它是因为：真实人工翻译文本、许可干净（MIT）、四种语言同源同体裁，
 * 便于做"同一段语义在不同编码下"的对照，而不是拿自造句子自证。
 *
 * 用法：node gate/scripts/make-fixtures.mjs
 * 产物已随仓库提交，测试与基准不依赖网络；只有想换语料时才需要重跑本脚本。
 */
import fs from "node:fs"
import path from "node:path"

const PACKS = {
  "zh-hans": "zh-hans",
  "zh-hant": "zh-hant",
  ja: "ja",
  ko: "ko"
}
const RAW = (pack) => `https://api.github.com/repos/microsoft/vscode-loc/contents/i18n/vscode-language-pack-${pack}/translations/main.i18n.json`
const OUT_DIR = path.resolve("gate/test/fixtures/corpus")
const TARGET_BYTES = 64 * 1024

const FILTERS = {
  "zh-hans": (ch) => (ch >= 0x4e00 && ch <= 0x9fff) || ch === 0x3002 || ch === 0xff0c,
  "zh-hant": (ch) => (ch >= 0x4e00 && ch <= 0x9fff) || ch === 0x3002 || ch === 0xff0c,
  ja: (ch) => (ch >= 0x3040 && ch <= 0x30ff) || (ch >= 0x4e00 && ch <= 0x9fff),
  ko: (ch) => ch >= 0xac00 && ch <= 0xd7a3
}

async function fetchJson (url) {
  const res = await fetch(url, { headers: { Accept: "application/vnd.github.raw", "User-Agent": "encgate-corpus" } })
  if (!res.ok) throw new Error(`${res.status} ${url}`)
  return res.text()
}

// 语言包结构：{ version, contents: { <module>: { <English 原文>: <译文> } } }
function collect (json, keep) {
  let data
  try { data = JSON.parse(json) } catch { return [] }
  const out = []
  for (const mod of Object.values(data.contents || {})) {
    if (!mod || typeof mod !== "object") continue
    for (const s of Object.values(mod)) {
      if (typeof s !== "string" || s.length < 8) continue
      let good = 0
      for (const ch of s) if (keep(ch.codePointAt(0))) good++
      if (good / s.length >= 0.5) out.push(s.replace(/\s+/g, " ").trim())
    }
  }
  return out
}

fs.mkdirSync(OUT_DIR, { recursive: true })
const meta = []
for (const [name, pack] of Object.entries(PACKS)) {
  const raw = await fetchJson(RAW(pack))
  const lines = collect(raw, FILTERS[name])
  let text = ""
  for (const line of lines) {
    if (Buffer.byteLength(text, "utf8") >= TARGET_BYTES) break
    text += line + "\n"
  }
  const file = path.join(OUT_DIR, `${name}.txt`)
  fs.writeFileSync(file, text, "utf8")
  meta.push({ name, source: `microsoft/vscode-loc (MIT) · vscode-language-pack-${pack}`, bytes: Buffer.byteLength(text, "utf8"), lines: text.split("\n").length - 1, chars: [...text].length })
  console.log(`${name}: ${meta[meta.length - 1].bytes} bytes, ${meta[meta.length - 1].chars} chars`)
}

fs.writeFileSync(path.join(OUT_DIR, "PROVENANCE.md"), `# 测试语料来源与许可

全部语料取自 **microsoft/vscode-loc**（MIT License），为 VS Code 语言包的人工翻译文案，
仅做"同一体裁、不同语言"的编码探测对照用，不是本项目原创内容。

| 文件 | 来源 | 字节 | 行数 |
|---|---|---|---|
${meta.map((m) => `| ${m.name}.txt | ${m.source} | ${m.bytes} | ${m.lines} |`).join("\n")}

重新生成：\`node gate/scripts/make-fixtures.mjs\`（需要访问 api.github.com）。
原文许可：https://github.com/microsoft/vscode-loc/blob/main/LICENSE
`, "utf8")
console.log("写出 PROVENANCE.md")
