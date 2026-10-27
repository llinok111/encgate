#!/usr/bin/env node
/**
 * 编码探测准确率基准。
 *
 * 语料：gate/test/fixtures/corpus/*.txt（真实人工翻译文案，见 PROVENANCE.md）
 * 做法：按随机但确定的偏移切出定长片段 → 用目标字符集编码成字节 → 交给探测器 → 比对
 * 判定口径：
 *   top1          —— 首选答案与真实编码一致（含超集等价，如 gbk→gb18030）
 *   wrong         —— 给出确定答案但错（最危险）
 *   inconclusive  —— 明确说"不确定"（可接受，调用方会转人工）
 *
 * 用法：node gate/scripts/bench-detect.mjs [--json] [--compare-chardet]
 */
import fs from "node:fs"
import path from "node:path"
import { detect } from "../detect.mjs"

const args = process.argv.slice(2)
const asJson = args.includes("--json")
const compareChardet = args.includes("--compare-chardet")

const CORPUS = path.resolve("gate/test/fixtures/corpus")
const LANGS = [
  { file: "zh-hans.txt", charset: "gbk", accept: ["gbk", "gb18030"] },
  { file: "zh-hans.txt", charset: "gb18030", accept: ["gbk", "gb18030"] },
  { file: "zh-hant.txt", charset: "big5", accept: ["big5", "big5hkscs"] },
  { file: "zh-hant.txt", charset: "big5hkscs", accept: ["big5", "big5hkscs"] },
  { file: "ja.txt", charset: "shiftjis", accept: ["shiftjis"] },
  { file: "ja.txt", charset: "eucjp", accept: ["eucjp"] },
  { file: "ko.txt", charset: "cp949", accept: ["cp949"] }
]
const LENGTHS = [16, 32, 64, 256, 1024]
const PER_CELL = 20

// 确定性伪随机：同一台机器/任何机器都得到同一批样本
function lcg (seed) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

const iconv = (await import("../../lib/index.js")).default

function samples (text, lenBytes, n, seed) {
  const rnd = lcg(seed)
  const out = []
  const chars = [...text]
  let guard = 0
  while (out.length < n && guard++ < n * 40) {
    const start = Math.floor(rnd() * (chars.length - 1))
    let s = ""
    for (let i = start; i < chars.length && Buffer.byteLength(s, "utf8") < lenBytes * 1.2; i++) s += chars[i]
    // 截断到目标字节长度（按字符边界）
    let acc = 0
    let cut = s
    while (Buffer.byteLength(cut, "utf8") > lenBytes && cut.length > 1) cut = [...cut].slice(0, -1).join("")
    acc = Buffer.byteLength(cut, "utf8")
    if (acc >= Math.floor(lenBytes * 0.6)) out.push(cut)
  }
  return out
}

let chardet = null
if (compareChardet) {
  try {
    const mod = await import("chardet")
    chardet = mod.default || mod
  } catch {
    console.error("未安装 chardet，跳过对照")
  }
}

const CHARDET_ALIAS = {
  GB18030: ["gbk", "gb18030"],
  GB2312: ["gbk", "gb18030"],
  Big5: ["big5", "big5hkscs"],
  SHIFT_JIS: ["shiftjis"],
  "EUC-JP": ["eucjp"],
  "EUC-KR": ["cp949"],
  "UTF-8": ["utf-8"],
  "windows-1252": ["windows-1252"],
  "ISO-8859-1": ["windows-1252"]
}

const rows = []
let seed = 1
for (const lang of LANGS) {
  const text = fs.readFileSync(path.join(CORPUS, lang.file), "utf8")
  for (const len of LENGTHS) {
    const cells = { charset: lang.charset, bytes: len, total: 0, top1: 0, wrong: 0, inconclusive: 0, chardetTop1: 0, chardetWrong: 0, chardetTotal: 0, examples: [] }
    for (const sample of samples(text, len, PER_CELL, seed++)) {
      const buf = iconv.encode(sample, lang.charset)
      const r = detect(buf)
      cells.total++
      if (lang.accept.includes(r.encoding)) cells.top1++
      else if (r.verdict === "inconclusive") cells.inconclusive++
      else {
        cells.wrong++
        if (cells.examples.length < 3) cells.examples.push({ got: r.encoding, verdict: r.verdict, bytes: buf.length })
      }
      if (chardet) {
        const c = chardet.detect(buf)
        // chardet@2 的 detect() 直接返回编码名字符串；chardet@1 返回 { encoding, confidence }
        const name = typeof c === "string" ? c : (c && c.encoding ? String(c.encoding) : null)
        const accepted = name ? (CHARDET_ALIAS[name] || [name.toLowerCase()]) : []
        cells.chardetTotal++
        if (accepted.some((a) => lang.accept.includes(a))) cells.chardetTop1++
        else if (name) cells.chardetWrong++
      }
    }
    rows.push(cells)
  }
}

if (asJson) {
  console.log(JSON.stringify(rows, null, 2))
} else {
  const pad = (s, n) => String(s).padEnd(n)
  console.log(pad("charset", 12) + pad("bytes", 7) + pad("n", 5) + pad("top1", 7) + pad("wrong", 7) + pad("inconcl", 9) + (chardet ? pad("chardet", 9) : ""))
  for (const r of rows) {
    const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : "-")
    console.log(
      pad(r.charset, 12) + pad(r.bytes, 7) + pad(r.total, 5) +
      pad(pct(r.top1, r.total), 7) + pad(pct(r.wrong, r.total), 7) + pad(pct(r.inconclusive, r.total), 9) +
      (chardet ? pad(pct(r.chardetTop1, r.chardetTotal), 9) : "")
    )
  }
  const sum = (k) => rows.reduce((a, r) => a + r[k], 0)
  const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : "-")
  console.log("---")
  console.log(`合计 top1 ${pct(sum("top1"), sum("total"))} / wrong ${pct(sum("wrong"), sum("total"))} / inconclusive ${pct(sum("inconclusive"), sum("total"))}`)
  if (chardet) console.log(`chardet 对照 top1 ${pct(sum("chardetTop1"), sum("chardetTotal"))} / wrong ${pct(sum("chardetWrong"), sum("chardetTotal"))}`)
}
