#!/usr/bin/env node
/**
 * encgate CLI。
 *
 * 退出码是契约（CI 里靠它拦下会丢字的转码）：
 *   0  无损 / 结论确定
 *   1  预测到损失（未加 --force 时不产出文件）
 *   2  用法错误、文件读写失败、字符集不支持
 *   3  结论不可信（短样本、无法确定源编码、复核不一致）
 */
import fs from "node:fs"
import path from "node:path"
import { analyze } from "../gate/analyze.mjs"
import { detect } from "../gate/detect.mjs"
import { listCharsets, resolveCharset } from "../gate/charsets.mjs"
import { EXIT, transcodeFile, VERSION } from "../gate/transcode.mjs"
import iconv from "../lib/index.js"

const VALUE_OPTS = new Set(["--to", "--from", "--out", "--max-groups", "--max-positions", "--min-bytes"])
const FLAG_OPTS = new Set(["--json", "--force", "--suggest", "--quiet", "--help", "-h", "--version", "-v"])

function parseArgs (argv) {
  const opts = {}
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith("--") && a.includes("=")) {
      const eq = a.indexOf("=")
      opts[a.slice(0, eq)] = a.slice(eq + 1)
      continue
    }
    if (VALUE_OPTS.has(a)) {
      // 值可能以 -- 开头（例如 --from --weird），因此不按前缀判空，只按"有没有下一个 token"判
      if (i + 1 >= argv.length) throw usageError(`${a} 需要一个值`)
      opts[a] = argv[++i]
      continue
    }
    if (FLAG_OPTS.has(a)) { opts[a] = true; continue }
    if (a.startsWith("-") && a !== "-") throw usageError(`未知选项：${a}`)
    rest.push(a)
  }
  return { opts, rest }
}

function usageError (msg) {
  const err = new Error(msg)
  err.code = "USAGE"
  return err
}

const HELP = `encgate ${VERSION} — 转码闸门：先证明不会丢字，再产出字节

用法
  encgate analyze   <文件|-> --to <编码> [--json] [--max-groups 50]
  encgate detect    <文件|-> [--json] [--min-bytes 32]
  encgate transcode <文件>   --to <编码> [--from 编码] [--out 路径] [--force] [--suggest]
  encgate charsets  [--json]

选项
  --to <编码>        目标字符集（gbk / gb18030 / big5 / big5hkscs / shiftjis / eucjp / cp949 /
                     windows-1252 / ascii / utf-8 / utf-16le / utf-16be / utf-32le / utf7）
  --from <编码>      强制指定源编码，跳过探测
  --out <路径>       输出路径（默认在同目录加 <编码> 后缀）
  --force            有损时仍然写出（占位符会写进产物，并记录在 manifest 里）
  --suggest          有损时按建议表替换后再写出（只应用已验证可表示的替代）
  --json             机器可读输出
  --quiet            只输出结论行

退出码
  0 无损/确定   1 预测到损失   2 用法或 IO 错误   3 结论不可信

示例
  encgate analyze 导出.csv --to gbk            # 会丢哪些字、在哪一行
  encgate transcode 导出.csv --to gbk          # 有损则拒绝产出，退出码 1
  encgate transcode 导出.csv --to gbk --suggest --out 导出.gbk.csv
`

function readInput (file) {
  if (file === "-") return fs.readFileSync(0)
  return fs.readFileSync(file)
}

function num (v, dflt) {
  if (v === undefined) return dflt
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0) throw usageError(`数值参数非法：${v}`)
  return Math.floor(n)
}

function fmtPct (x) {
  return `${(x * 100).toFixed(x < 0.01 ? 2 : 1)}%`
}

function printAnalyze (report, file, opts) {
  const lines = []
  const label = report.targetLabel
  const c = report.counts
  lines.push(`${file} → ${label}`)
  if (report.lossless) {
    lines.push(`结论：无损。${c.codePoints} 个码点全部可表示，${report.bytes.predicted} 字节`)
  } else {
    lines.push(`结论：会丢 ${c.lossyCodePoints} 个字符（${fmtPct(c.lossyRatio)}），涉及 ${c.distinctLossy} 个不同字符`)
    lines.push(`字节：${report.bytes.predicted}（预测） / ${report.bytes.actual}（实测）`)
    const pad = (s, n) => String(s).padEnd(n)
    lines.push("")
    lines.push(pad("字符", 4) + pad("码点", 9) + pad("次数", 5) + pad("结果", 8) + pad("位置", 22) + "建议")
    for (const g of report.groups) {
      const pos = g.positions.slice(0, 3).map((p) => `${p.line}:${p.column}`).join(" ")
      const sug = g.suggestion
        ? (g.suggestion.verified ? `→ ${JSON.stringify(g.suggestion.risk === "drop" ? "(删除)" : g.suggestion.text)} ${g.suggestion.risk}` : `建议不可用（${g.suggestion.why}）`)
        : "—"
      const becomes = g.verdict === "dropped" ? "(删除)" : JSON.stringify(g.becomes)
      lines.push(pad(g.char, 4) + pad(g.codePoint, 9) + pad(g.count, 5) + pad(becomes, 8) + pad(pos || "—", 22) + sug)
    }
    if (report.truncatedGroups) lines.push(`… 另有 ${report.truncatedGroups} 个不同字符未列出（--max-groups 调整）`)
    if (report.worstLines.length) {
      lines.push("")
      lines.push("集中行：" + report.worstLines.map((w) => `第 ${w.line} 行 ${w.count} 个`).join("；"))
    }
  }
  if (!report.verified) {
    lines.push("")
    lines.push("⚠ 逐码点预测与整串真实转码不一致，本次结论不可信：" + JSON.stringify(report.verification.note))
  }
  for (const n of report.notes) lines.push(`注：${n}`)
  if (opts["--quiet"]) return lines.slice(0, 2).join("\n")
  return lines.join("\n")
}

function printDetect (r, file) {
  const lines = []
  lines.push(`${file}：${r.encoding ?? "(未知)"} · ${r.verdict} · 置信度 ${r.confidence}`)
  if (r.candidates && r.candidates.length > 1) {
    lines.push("候选：" + r.candidates.slice(0, 4).map((c) => `${c.key}=${c.score}`).join("  "))
  }
  for (const n of r.notes) lines.push(`注：${n}`)
  return lines.join("\n")
}

function main () {
  let parsed
  try {
    parsed = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error(`错误：${err.message}\n\n${HELP}`)
    return EXIT.ERROR
  }
  const { opts, rest } = parsed
  if (opts["--version"] || opts["-v"]) { console.log(VERSION); return EXIT.OK }
  if (opts["--help"] || opts["-h"] || rest.length === 0) { console.log(HELP); return EXIT.OK }

  const [cmd, file] = rest
  try {
    if (cmd === "charsets") {
      const list = listCharsets()
      if (opts["--json"]) { console.log(JSON.stringify(list, null, 2)); return EXIT.OK }
      const pad = (s, n) => String(s).padEnd(n)
      console.log(pad("编码", 14) + pad("族别", 10) + pad("无损", 6) + "说明")
      for (const cs of list) console.log(pad(cs.key, 14) + pad(cs.kind, 10) + pad(cs.lossless ? "是" : "否", 6) + cs.note)
      return EXIT.OK
    }

    if (cmd === "analyze") {
      if (!file) throw usageError("缺少输入文件")
      const target = opts["--to"] || "gbk"
      if (!resolveCharset(target) || !iconv.encodingExists(resolveCharset(target).iconv)) {
        throw usageError(`不支持的目标字符集：${target}`)
      }
      const buf = readInput(file)
      const src = opts["--from"] || detect(buf).encoding
      if (!src) {
        console.error("错误：无法确定源编码，请用 --from 指定")
        return EXIT.INCONCLUSIVE
      }
      const text = iconv.decode(buf, resolveCharset(src)?.iconv ?? src)
      const report = analyze(text, target, {
        maxGroups: num(opts["--max-groups"], 50),
        maxPositions: num(opts["--max-positions"], 5)
      })
      if (opts["--json"]) console.log(JSON.stringify(report, null, 2))
      else console.log(printAnalyze(report, file === "-" ? "(stdin)" : file, opts))
      if (!report.verified) return EXIT.INCONCLUSIVE
      return report.lossless ? EXIT.OK : EXIT.LOSSY
    }

    if (cmd === "detect") {
      if (!file) throw usageError("缺少输入文件")
      const r = detect(readInput(file), { minBytes: num(opts["--min-bytes"], 32) })
      if (opts["--json"]) console.log(JSON.stringify(r, null, 2))
      else console.log(printDetect(r, file === "-" ? "(stdin)" : file))
      if (!r.encoding) return EXIT.INCONCLUSIVE
      return r.verdict === "inconclusive" ? EXIT.INCONCLUSIVE : EXIT.OK
    }

    if (cmd === "transcode") {
      if (!file || file === "-") throw usageError("transcode 需要真实文件路径（预览请用 analyze）")
      const target = opts["--to"]
      if (!target) throw usageError("缺少 --to")
      if (!resolveCharset(target) || !iconv.encodingExists(resolveCharset(target).iconv)) {
        throw usageError(`不支持的目标字符集：${target}`)
      }
      const out = opts["--out"]
      if (out && path.resolve(out) === path.resolve(file)) throw usageError("输出路径与输入相同，已拒绝覆盖")
      const r = transcodeFile(file, {
        to: target,
        from: opts["--from"],
        out,
        force: Boolean(opts["--force"]),
        applySuggestions: Boolean(opts["--suggest"])
      })
      if (r.status === "inconclusive" || r.status === "error") {
        console.error(`未转码：${r.manifest.reason}`)
        return r.status === "error" ? EXIT.ERROR : EXIT.INCONCLUSIVE
      }
      if (r.status === "blocked") {
        const rep = r.plan.report
        console.error(`${r.manifest.reason}`)
        console.error(`会丢 ${rep.counts.lossyCodePoints} 个字符 / ${rep.counts.distinctLossy} 种：`)
        for (const g of rep.groups.slice(0, 10)) {
          const where = g.positions[0] ? `第 ${g.positions[0].line} 行` : ""
          console.error(`  ${g.char} ${g.codePoint} ×${g.count} ${where} → ${JSON.stringify(g.becomes)}`)
        }
        console.error("加 --force 强制写出，或加 --suggest 按建议替换后再写出。")
        return EXIT.LOSSY
      }
      if (opts["--json"]) console.log(JSON.stringify(r.manifest, null, 2))
      else {
        console.log(`已写出 ${r.outPath}`)
        console.log(`  ${r.manifest.sourceBytes} → ${r.manifest.outputBytes} 字节，源 ${r.manifest.sourceEncoding} → 目标 ${r.manifest.outputEncoding}`)
        if (r.manifest.lossyCodePoints) console.log(`  有损：${r.manifest.lossyCodePoints} 个字符（${r.manifest.status}）`)
        console.log(`  复核：${r.manifest.verification}`)
        console.log(`  清单：${r.manifestPath}`)
      }
      return r.status === "unverified" ? EXIT.INCONCLUSIVE : EXIT.OK
    }

    throw usageError(`未知子命令：${cmd}`)
  } catch (err) {
    if (err && err.code === "USAGE") { console.error(`错误：${err.message}\n\n${HELP}`); return EXIT.ERROR }
    console.error(`错误：${err && err.message}`)
    return EXIT.ERROR
  }
}

process.exitCode = main()
