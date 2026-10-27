#!/usr/bin/env node
/**
 * 精确性证据：把"逐码点预言 == 真实转码"这件事在码点网格上跑一遍并留档。
 *
 * 用法：
 *   node gate/scripts/exactness.mjs            # 打印
 *   node gate/scripts/exactness.mjs --json     # 机器可读
 *   node gate/scripts/exactness.mjs --check    # 与 docs/EVIDENCE.json 比对，漂移则退出码 1
 *
 * --check 存在的理由：文档里的数字会过期。凡是写进 README 的量，都必须能被脚本重新算出来并比对，
 * 而不是靠 `includes('408')` 这种字符串包含来"验证"。
 */
import fs from "node:fs"
import path from "node:path"
import iconv from "../../lib/index.js"
import { probeTarget } from "../probe.mjs"
import { analyze } from "../analyze.mjs"

const args = process.argv.slice(2)
const asJson = args.includes("--json")
const check = args.includes("--check")
const OUT = path.resolve("docs/EVIDENCE.json")

const TARGETS = ["gbk", "gb18030", "big5", "big5hkscs", "shiftjis", "eucjp", "cp949", "windows-1252", "ascii", "utf-8", "utf-16le", "utf-16be", "utf-32le", "utf7"]

function grid () {
  const cps = new Set()
  for (let cp = 0x20; cp <= 0x7e; cp++) cps.add(cp)
  // 拉丁补充/标点区逐码点扫：静默改写（如 Shift_JIS 的 ¥→\、‾→~）都在这一区
  for (let cp = 0xa0; cp <= 0x2fff; cp += 1) cps.add(cp)
  for (let cp = 0x3000; cp <= 0x9fff; cp += 9) cps.add(cp)
  for (let cp = 0xac00; cp <= 0xd7a3; cp += 23) cps.add(cp)
  for (let cp = 0xe000; cp <= 0xf8ff; cp += 61) cps.add(cp)
  for (let cp = 0xf900; cp <= 0xffef; cp += 3) cps.add(cp)
  for (const cp of [0x1f389, 0x1f600, 0x1f1e6, 0x20000, 0x2a6d6, 0x10ffff, 0x10000, 0x1d11e, 0x1f9d1]) cps.add(cp)
  return [...cps].sort((a, b) => a - b)
}

const CPS = grid()
const rows = []
let checked = 0
let verdictMismatch = 0
let byteMismatch = 0

for (const target of TARGETS) {
  const probe = probeTarget(target)
  let lossy = 0
  let mism = 0
  const kinds = { ok: 0, replaced: 0, substituted: 0, dropped: 0, error: 0 }
  const substituted = []
  for (const cp of CPS) {
    const ch = String.fromCodePoint(cp)
    const v = probe.of(cp)
    const back = iconv.decode(iconv.encode(ch, probe.charset.iconv), probe.charset.iconv)
    checked++
    if ((v.kind === "ok") !== (back === ch)) { mism++; verdictMismatch++ }
    if (v.kind !== "ok") lossy++
    kinds[v.kind] = (kinds[v.kind] || 0) + 1
    if (v.kind === "substituted" && substituted.length < 5) {
      substituted.push("U+" + cp.toString(16).toUpperCase().padStart(4, "0") + "→" + JSON.stringify(v.becomes))
    }
  }
  // 整串复核 + 字节数核对（有状态编码跳过字节核对）
  const text = "价格：￥199 — 含税 🎉 “限时” abc 日本語 한국어 훈민정음 𠀋①㈱"
  const r = analyze(text, target, { maxGroups: 999 })
  if (probe.perCharBytesExact && r.bytes.predicted !== r.bytes.actual) byteMismatch++
  rows.push({
    target,
    codePoints: CPS.length,
    lossy,
    lossyRatio: Number((lossy / CPS.length).toFixed(4)),
    verdictMismatch: mism,
    kinds,
    substituted,
    stringVerified: r.verified,
    bytesPredicted: r.bytes.predicted,
    bytesActual: r.bytes.actual
  })
}

const summary = {
  generatedBy: "gate/scripts/exactness.mjs",
  upstream: "iconv-lite v0.7.3",
  node: process.version,
  icu: process.versions.icu,
  codePointsPerTarget: CPS.length,
  targets: TARGETS.length,
  assertions: checked,
  verdictMismatch,
  byteMismatch,
  rows
}

if (check) {
  if (!fs.existsSync(OUT)) {
    console.error(`缺少 ${OUT}，先运行 node gate/scripts/exactness.mjs --write`)
    process.exit(1)
  }
  const want = JSON.parse(fs.readFileSync(OUT, "utf8"))
  const diffs = []
  const keys = ["codePointsPerTarget", "targets", "assertions", "verdictMismatch", "byteMismatch"]
  for (const k of keys) if (want[k] !== summary[k]) diffs.push(`${k}: 文档 ${want[k]} ≠ 实测 ${summary[k]}`)
  // 逐行比，不整体字符串比：机器无关字段（node/icu）不参与
  for (const row of summary.rows) {
    const old = (want.rows || []).find((r) => r.target === row.target)
    if (!old) { diffs.push(`缺少 ${row.target} 行`); continue }
    for (const k of ["codePoints", "lossy", "verdictMismatch", "stringVerified", "bytesPredicted", "bytesActual", "kinds"]) {
      if (JSON.stringify(old[k]) !== JSON.stringify(row[k])) diffs.push(`${row.target}.${k}: 文档 ${JSON.stringify(old[k])} ≠ 实测 ${JSON.stringify(row[k])}`)
    }
  }
  if (diffs.length) {
    console.error("证据文件与实测不一致：")
    for (const d of diffs) console.error("  - " + d)
    console.error("确认改动后运行 node gate/scripts/exactness.mjs --write 重新生成")
    process.exit(1)
  }
  console.log(`证据一致：${summary.assertions} 条码点断言 / ${summary.targets} 个目标字符集 / 分歧 ${summary.verdictMismatch}`)
  process.exit(0)
}

if (args.includes("--write")) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, JSON.stringify(summary, null, 2) + "\n")
  console.log(`已写出 ${OUT}`)
}

if (asJson) {
  console.log(JSON.stringify(summary, null, 2))
} else {
  const pad = (s, n) => String(s).padEnd(n)
  console.log(pad("目标", 14) + pad("码点", 7) + pad("不可表示", 10) + pad("占比", 8) + pad("判定分歧", 10) + pad("字节预言", 10) + "整串复核")
  for (const r of rows) {
    const byteOk = r.bytesPredicted === r.bytesActual || r.target === "utf7"
    console.log(
      pad(r.target, 14) + pad(r.codePoints, 7) + pad(r.lossy, 10) + pad(`${(r.lossyRatio * 100).toFixed(1)}%`, 8) +
      pad(r.verdictMismatch, 10) + pad(byteOk ? "一致" : `${r.bytesPredicted}≠${r.bytesActual}`, 10) +
      (r.stringVerified ? "一致" : "不一致")
    )
  }
  console.log("---")
  console.log(`合计 ${checked} 条码点断言（${TARGETS.length} 个目标 × ${CPS.length} 码点），判定分歧 ${verdictMismatch}，字节数分歧 ${byteMismatch}`)
  const subs = rows.filter((r) => r.kinds.substituted > 0)
  if (subs.length) {
    console.log("静默改写（输出里没有 ?，但字被换掉了）：")
    for (const r of subs) console.log(`  ${r.target}: ${r.kinds.substituted} 个 —— ${r.substituted.join(" ")}`)
  } else {
    console.log("静默改写：无")
  }
}
