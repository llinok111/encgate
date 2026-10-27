#!/usr/bin/env node
/**
 * 下游影响：用本机真实中文文档（含 emoji / 印刷体标点）模拟"直接转 GBK"的后果。
 *
 * 只输出聚合数字与字符样本，不记录任何文件路径 —— 这些语料是本地文档，不是可发布内容。
 *
 * 用法：node gate/scripts/downstream-demo.mjs [--dirs a,b] [--json] [--write]
 */
import fs from "node:fs"
import path from "node:path"
import iconv from "../../lib/index.js"
import { analyze, applySuggestions } from "../analyze.mjs"
import { utf8Validity } from "../detect.mjs"

const args = process.argv.slice(2)
const asJson = args.includes("--json")
const write = args.includes("--write")
const dirIdx = args.indexOf("--dirs")
const dirs = dirIdx >= 0
  ? args[dirIdx + 1].split(",").map((d) => path.resolve(d))
  : [path.resolve(".")]
const OUT = path.resolve("docs/DOWNSTREAM.json")
const MAX_FILES = 80
const MAX_BYTES = 256 * 1024

function collect (roots) {
  const out = []
  const walk = (dir, depth) => {
    if (depth > 4 || out.length >= MAX_FILES) return
    let ents = []
    try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      if (out.length >= MAX_FILES) return
      if (["node_modules", ".git", ".venv", "fixtures", "corpus"].includes(e.name)) continue
      const full = path.join(dir, e.name)
      if (e.isDirectory()) { walk(full, depth + 1); continue }
      if (!/\.(md|txt)$/i.test(e.name)) continue
      let st
      try { st = fs.statSync(full) } catch { continue }
      if (st.size === 0 || st.size > MAX_BYTES) continue
      out.push(full)
    }
  }
  for (const r of roots) walk(r, 0)
  return out.sort()
}

const files = collect(dirs)
const perChar = new Map()
let filesWithLoss = 0
let totalLost = 0
let totalChars = 0
let naiveWouldWarn = 0
let recoverable = 0
const samples = []

for (const f of files) {
  let buf
  try { buf = fs.readFileSync(f) } catch { continue }
  // 语料卫生：只统计**字节层面合法 UTF-8** 且不含替换符的文档。
  // 否则本机那些 GBK 编码的旧文档会被当成 UTF-8 读进来，凭空产出 U+FFFD 污染统计。
  if (!utf8Validity(buf).valid) continue
  const text = buf.toString("utf8")
  if (!text.trim() || text.includes("�")) continue
  const report = analyze(text, "gbk", { maxGroups: 200 })
  totalChars += report.counts.codePoints
  if (!report.lossless) {
    filesWithLoss++
    totalLost += report.counts.lossyCodePoints
    for (const g of report.groups) perChar.set(g.char, (perChar.get(g.char) || 0) + g.count)
    // 朴素管线的判据：输出里出现了源文本没有的 '?' —— 只能发现一部分，且会把原文的 '?' 也算进去
    const before = (text.match(/\?/g) || []).length
    const after = (iconv.decode(iconv.encode(text, "gbk"), "gbk").match(/\?/g) || []).length
    if (after > before) naiveWouldWarn++
    const fixed = applySuggestions(text, "gbk", report)
    recoverable += fixed.applied
    if (samples.length < 6) samples.push({ chars: report.counts.lossyCodePoints, distinct: report.counts.distinctLossy, applied: fixed.applied, afterLossless: fixed.after.lossless })
  }
}

const top = [...perChar.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
  .map(([ch, n]) => ({ char: ch, codePoint: "U+" + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, "0"), count: n }))

const summary = {
  generatedBy: "gate/scripts/downstream-demo.mjs",
  target: "gbk",
  files: files.length,
  totalCodePoints: totalChars,
  filesWithLoss,
  totalLostCodePoints: totalLost,
  lostRatio: totalChars ? Number((totalLost / totalChars).toFixed(5)) : 0,
  naivePipelineDetectable: naiveWouldWarn,
  naivePipelineMissed: filesWithLoss - naiveWouldWarn,
  suggestionsApplied: recoverable,
  topLostChars: top
}

if (write) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, JSON.stringify(summary, null, 2) + "\n")
  console.log(`已写出 ${OUT}`)
}

if (asJson) {
  console.log(JSON.stringify(summary, null, 2))
} else {
  console.log(`真实文档 ${summary.files} 个，共 ${summary.totalCodePoints} 个码点`)
  console.log(`直接转 GBK：${summary.filesWithLoss} 个文件会静默丢字，合计 ${summary.totalLostCodePoints} 个码点（${(summary.lostRatio * 100).toFixed(2)}%）`)
  console.log(`朴素判据（输出里多出 ?）只能发现其中 ${summary.naivePipelineDetectable} 个文件，漏掉 ${summary.naivePipelineMissed} 个`)
  console.log(`按建议表可替换 ${summary.suggestionsApplied} 处`)
  if (top.length) {
    console.log("高频丢失字符：" + top.map((t) => `${t.char}(${t.count})`).join(" "))
  }
  if (samples.length) {
    console.log("样本文件：" + samples.map((s) => `${s.chars} 个字/${s.distinct} 种，可替换 ${s.applied}${s.afterLossless ? "（替换后无损）" : ""}`).join("；"))
  }
}
