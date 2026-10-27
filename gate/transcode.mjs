/**
 * 转码执行层：**先预言、再转码、后复核**。
 *
 * 三步都不省略：
 *   1. preflight —— 逐码点判定 + 整串复核（analyze）
 *   2. encode    —— 真有损时，未加 --force 一律拒绝产出文件
 *   3. verify    —— 把产出的字节解回来，与"预言的结果"逐字符比对
 *
 * manifest 里不含时间戳：同一输入 + 同一参数必须得到逐字节相同的清单，
 * 否则归档校验、ZIP 比对、CI 复现全部失效。
 */
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import iconv from "../lib/index.js"
import { analyze } from "./analyze.mjs"
import { detect } from "./detect.mjs"
import { resolveCharset } from "./charsets.mjs"

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex")

/** 判定退出码：0 无损 / 1 有损被拦 / 2 用法或 IO 错误 / 3 结论不可信 */
export const EXIT = { OK: 0, LOSSY: 1, ERROR: 2, INCONCLUSIVE: 3 }

/**
 * 只做预测，不产出任何字节。
 * @param {Buffer} input
 * @param {{from?: string, to: string}} opts
 */
export function preflight (input, opts) {
  const target = resolveCharset(opts.to)
  if (!target) {
    const err = new Error(`未知目标字符集：${opts.to}`)
    err.code = "UNKNOWN_CHARSET"
    throw err
  }
  const src = opts.from
    ? { encoding: resolveCharset(opts.from)?.key ?? opts.from, verdict: "forced", confidence: 1, notes: ["调用方指定了源编码"] }
    : detect(input)
  if (!src.encoding || src.verdict === "inconclusive") {
    return {
      ok: false,
      status: "inconclusive",
      source: src,
      report: null,
      reason: src.encoding
        ? `源编码只能给到 ${src.encoding}（${src.verdict}），证据不足，拒绝转码（用 --from 指定源编码）`
        : "无法确定源编码，拒绝转码（用 --from 指定源编码）"
    }
  }
  let text
  try {
    text = iconv.decode(input, resolveCharset(src.encoding)?.iconv ?? src.encoding)
  } catch (err) {
    return { ok: false, status: "error", source: src, report: null, reason: `源编码解码失败：${err && err.message}` }
  }
  const report = analyze(text, target.key)
  const status = report.lossless ? (report.verified ? "ok" : "inconclusive") : "lossy"
  return { ok: report.lossless && report.verified, status, source: src, report, text }
}

/**
 * 执行转码。有损且未 force 时不写任何文件。
 * @param {Buffer} input
 * @param {{from?: string, to: string, force?: boolean, applySuggestions?: boolean}} opts
 */
export function transcode (input, opts) {
  const plan = preflight(input, opts)
  const target = resolveCharset(opts.to)
  const base = {
    tool: "encgate",
    toolVersion: VERSION,
    target: target ? target.key : opts.to,
    sourceEncoding: plan.source.encoding,
    sourceVerdict: plan.source.verdict,
    sourceBytes: input.length,
    sourceSha256: sha256(input)
  }

  if (plan.status === "error" || plan.status === "inconclusive") {
    return { status: plan.status, buffer: null, manifest: { ...base, status: plan.status, reason: plan.reason }, plan }
  }

  let text = plan.text
  let report = plan.report
  let suggestionsApplied = 0

  // --suggest：只应用"已验证可表示"的替代，然后把结果重新送进同一套判定。
  // 替代后仍有无损结论才允许直接产出；否则该拦还是拦（不接受"悄悄降级"）。
  if (opts.applySuggestions && !report.lossless) {
    const replaced = replaceWithSuggestions(text, report)
    const after = analyze(replaced.text, target.key)
    suggestionsApplied = replaced.applied
    if (after.lossless && after.verified) {
      text = replaced.text
      report = after
    } else if (opts.force) {
      text = replaced.text
      report = after
    } else {
      return {
        status: "blocked",
        buffer: null,
        manifest: {
          ...base,
          status: "blocked",
          lossyCodePoints: after.counts.lossyCodePoints,
          distinctLossy: after.counts.distinctLossy,
          reason: `按建议替换后仍有 ${after.counts.lossyCodePoints} 个字符无法表示，未产出文件（加 --force 强制写出）`
        },
        plan: { ...plan, report: after, suggestions: replaced }
      }
    }
  }

  if (!report.lossless && !opts.force) {
    return {
      status: "blocked",
      buffer: null,
      manifest: {
        ...base,
        status: "blocked",
        lossyCodePoints: report.counts.lossyCodePoints,
        distinctLossy: report.counts.distinctLossy,
        reason: "目标字符集无法表示部分字符，未产出文件（加 --suggest 按建议替换，或加 --force 强制写出）"
      },
      plan: { ...plan, report }
    }
  }

  const output = iconv.encode(text, target.iconv)
  const back = iconv.decode(output, target.iconv)
  const expected = expectedText(text, report)
  const verified = back === expected

  const manifest = {
    ...base,
    status: verified ? (report.lossless ? "ok" : "forced-lossy") : "unverified",
    outputEncoding: target.key,
    outputBytes: output.length,
    outputSha256: sha256(output),
    lossyCodePoints: report.counts.lossyCodePoints,
    distinctLossy: report.counts.distinctLossy,
    lossy: report.groups.map((g) => ({ codePoint: g.codePoint, verdict: g.verdict, becomes: g.becomes, count: g.count })),
    suggestionsApplied,
    verified,
    verification: verified
      ? "decode(output) 与逐码点预言逐字符一致"
      : "decode(output) 与逐码点预言不一致：本次产物不可信"
  }
  return { status: verified ? (report.lossless ? "ok" : "forced-lossy") : "unverified", buffer: output, manifest, plan: { ...plan, report } }
}

function replaceWithSuggestions (text, report) {
  const byChar = new Map(report.groups.map((g) => [g.char, g]))
  let out = ""
  let applied = 0
  let unresolved = 0
  const changes = []
  for (const ch of text) {
    const g = byChar.get(ch)
    if (!g) { out += ch; continue }
    if (g.suggestion && g.suggestion.verified) {
      out += g.suggestion.text
      applied++
      changes.push({ codePoint: g.codePoint, from: ch, to: g.suggestion.text, why: g.suggestion.why })
    } else {
      out += ch
      unresolved++
    }
  }
  return { text: out, applied, unresolved, changes }
}

function expectedText (text, report) {
  const byChar = new Map(report.groups.map((g) => [g.char, g]))
  let out = ""
  for (const ch of text) {
    const g = byChar.get(ch)
    if (!g) { out += ch; continue }
    out += g.verdict === "dropped" ? "" : (g.becomes ?? "")
  }
  return out
}

/**
 * 文件级入口：读 -> 预测 -> （必要时）写出 -> 复核。
 * @param {string} inPath
 * @param {{to: string, from?: string, out?: string, force?: boolean, applySuggestions?: boolean}} opts
 */
export function transcodeFile (inPath, opts) {
  const input = fs.readFileSync(inPath)
  const result = transcode(input, opts)
  if (!result.buffer) return { ...result, outPath: null }
  const outPath = opts.out || defaultOutPath(inPath, opts.to)
  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true })
  fs.writeFileSync(outPath, result.buffer)
  const wavPath = `${outPath}.manifest.json`
  const manifest = { ...result.manifest, input: path.basename(inPath), output: path.basename(outPath) }
  fs.writeFileSync(wavPath, JSON.stringify(manifest, null, 2) + "\n", "utf8")
  return { ...result, outPath, manifestPath: wavPath }
}

function defaultOutPath (inPath, to) {
  const ext = path.extname(inPath)
  const base = inPath.slice(0, inPath.length - ext.length)
  const tag = String(to).replace(/[^\w.-]/g, "")
  return `${base}.${tag}${ext}`
}

export const VERSION = "1.0.1"
