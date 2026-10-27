#!/usr/bin/env node
/**
 * 生成汉字频次表（gate/frequency.mjs）。
 *
 * 语料来源必须可复现：脚本接受若干目录/文件路径，只统计 CJK 统一汉字，
 * 输出 top-N 与 log 归一化权重。换一份语料重新跑即可得到本地的频次表，
 * 因此这里不把它当成"权威字频"，只当成"当前语料上的常见字集合"。
 *
 * 用法：
 *   node gate/scripts/build-freq.mjs --out gate/frequency.mjs ../docs ../README.md
 */
import fs from "node:fs"
import path from "node:path"

const args = process.argv.slice(2)
const outIdx = args.indexOf("--out")
const outFile = outIdx >= 0 ? args[outIdx + 1] : "gate/frequency.mjs"
const inputs = args.filter((a, i) => i !== outIdx && i !== outIdx + 1)
const TOP_N = 3500
const EXT = new Set([".md", ".markdown", ".txt", ".mjs", ".js", ".json"])

if (inputs.length === 0) {
  console.error("用法: node gate/scripts/build-freq.mjs --out <file> <paths...>")
  process.exit(2)
}

const counts = new Map()
let scannedFiles = 0
let totalCjk = 0

function eatFile (file) {
  let text
  try { text = fs.readFileSync(file, "utf8") } catch { return }
  // 统计规模上限，避免把巨大的生成物算进来
  if (text.length > 2_000_000) return
  scannedFiles++
  for (const ch of text) {
    const cp = ch.codePointAt(0)
    if (cp < 0x4e00 || cp > 0x9fff) continue
    totalCjk++
    counts.set(ch, (counts.get(ch) || 0) + 1)
  }
}

function walk (p, depth = 0) {
  if (depth > 6) return
  let st
  try { st = fs.statSync(p) } catch { return }
  if (st.isFile()) { eatFile(p); return }
  if (!st.isDirectory()) return
  let ents = []
  try { ents = fs.readdirSync(p, { withFileTypes: true }) } catch { return }
  for (const e of ents) {
    if (e.name === "node_modules" || e.name === ".git" || e.name === ".venv") continue
    const full = path.join(p, e.name)
    if (e.isDirectory()) walk(full, depth + 1)
    else if (EXT.has(path.extname(e.name).toLowerCase())) eatFile(full)
  }
}

for (const p of inputs) walk(path.resolve(p))

if (counts.size === 0) {
  console.error("语料里没有汉字，检查输入路径")
  process.exit(1)
}

const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].codePointAt(0) - b[0].codePointAt(0))
const top = sorted.slice(0, TOP_N)
const max = top[0][1]
const denom = Math.log(max + 1)

const lines = top.map(([ch, n]) => `  ['${ch}', ${(Math.log(n + 1) / denom).toFixed(3)}]`)
const header = `// 自动生成，请勿手改。生成命令见文件末尾注释。
// 语料：${scannedFiles} 个文件，${totalCjk} 个汉字，去重 ${counts.size} 个，取前 ${top.length} 个。
// 权重为 log 归一化（最高频 = 1.000），只用于"这段解码结果像不像正常中文"的相对比较。
export const FREQUENCY = new Map([
${lines.join(",\n")},
])
export const FREQUENCY_META = ${JSON.stringify({ files: scannedFiles, totalCjk, distinct: counts.size, kept: top.length })}
// 生成命令：node gate/scripts/build-freq.mjs --out gate/frequency.mjs <corpus paths>
`

fs.mkdirSync(path.dirname(outFile), { recursive: true })
fs.writeFileSync(outFile, header, "utf8")
console.log(`写出 ${outFile}：${top.length} 字 / 语料 ${scannedFiles} 文件 ${totalCjk} 汉字`)
console.log("top10:", top.slice(0, 10).map(([c]) => c).join(""))
