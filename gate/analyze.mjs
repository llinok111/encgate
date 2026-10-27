/**
 * 损失预测：把"转码会丢哪些字"变成可核对的事实。
 *
 * 做法是逐码点探针 + **整串复核**两段：
 *   1. 逐码点得出 verdict（ok / replaced / substituted / dropped / error）与"会变成什么"
 *   2. 用这些 verdict 拼出**预期解码结果**，再与真实 `decode(encode(整串))` 比对
 *      → 一致则 prediction 被验证（verified: true），不一致则显式标为 inconclusive 并给出差异位置
 *
 * 之所以要第 2 段：iconv-lite 的替换字符是模块级可变量，任何人都能在运行时改掉它；
 * 单靠"回环是否等于 '?'"这种字面判断会在被改过之后静默给出错误结论。
 */
import { probeTarget } from "./probe.mjs"
import { suggestFor } from "./suggest.mjs"

const DEFAULT_MAX_GROUPS = 50
const DEFAULT_MAX_POSITIONS = 5

function describeCp (cp) {
  const hex = cp.toString(16).toUpperCase().padStart(4, "0")
  return cp > 0xffff ? `U+${hex}` : `U+${hex}`
}

/**
 * @param {string} text 源文本
 * @param {string} target 目标字符集
 * @param {{maxGroups?: number, maxPositions?: number, withSuggestions?: boolean}} [opts]
 */
export function analyze (text, target, opts = {}) {
  const source = typeof text === "string" ? text : String(text ?? "")
  const maxGroups = opts.maxGroups ?? DEFAULT_MAX_GROUPS
  const maxPositions = opts.maxPositions ?? DEFAULT_MAX_POSITIONS
  const withSuggestions = opts.withSuggestions !== false
  const probe = probeTarget(target)

  const groups = new Map()
  let line = 1
  let column = 1
  let index = 0
  let lossyCount = 0
  let predictedBytes = 0
  const expectedParts = []
  const lossyPerLine = new Map()

  for (const ch of source) {
    const cp = ch.codePointAt(0)
    const verdict = probe.of(cp)
    predictedBytes += verdict.bytes
    if (verdict.kind === "ok") {
      expectedParts.push(ch)
    } else {
      lossyCount++
      expectedParts.push(verdict.kind === "dropped" ? "" : (verdict.becomes ?? ""))
      lossyPerLine.set(line, (lossyPerLine.get(line) || 0) + 1)
      let g = groups.get(cp)
      if (!g) {
        g = {
          cp,
          codePoint: describeCp(cp),
          char: ch,
          verdict: verdict.kind,
          becomes: verdict.becomes,
          count: 0,
          bytes: verdict.bytes,
          positions: [],
          suggestion: null
        }
        groups.set(cp, g)
      }
      g.count++
      if (g.positions.length < maxPositions) g.positions.push({ line, column, index })
    }
    // 行列推进：按码点计列，换行重置
    if (ch === "\n") { line++; column = 1 } else { column++ }
    index += ch.length
  }

  const distinctCp = groups.size
  const groupList = [...groups.values()].sort((a, b) => b.count - a.count || a.cp - b.cp)

  if (withSuggestions) {
    for (const g of groupList) {
      g.suggestion = suggestFor(g.cp, probe)
    }
  }

  // ---- 第二段：整串复核
  const expectedText = expectedParts.join("")
  let whole
  try {
    whole = probe.roundTrip(source)
  } catch (err) {
    whole = { bytes: -1, text: null, lossless: false, error: err && err.message }
  }
  const predictionConsistent = whole.text === expectedText
  const bytesConsistent = !probe.perCharBytesExact || whole.bytes === predictedBytes
  let verifyNote = null
  if (!predictionConsistent) {
    verifyNote = firstDifference(expectedText, whole.text)
  }

  const worstLines = [...lossyPerLine.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([lineNo, count]) => ({ line: lineNo, count }))

  const report = {
    target: probe.charset.key,
    targetLabel: probe.charset.label,
    targetKind: probe.charset.kind,
    lossless: lossyCount === 0 && predictionConsistent,
    verified: predictionConsistent && bytesConsistent,
    verification: {
      predictionConsistent,
      bytesConsistent,
      perCharBytesExact: probe.perCharBytesExact,
      note: verifyNote
    },
    counts: {
      codePoints: [...source].length,
      utf16Units: source.length,
      lossyCodePoints: lossyCount,
      distinctLossy: distinctCp,
      lossyRatio: [...source].length ? lossyCount / [...source].length : 0
    },
    bytes: {
      predicted: predictedBytes,
      actual: whole.bytes
    },
    groups: groupList.slice(0, maxGroups).map((g) => ({
      codePoint: g.codePoint,
      char: g.char,
      verdict: g.verdict,
      becomes: g.becomes,
      count: g.count,
      bytes: g.bytes,
      positions: g.positions,
      suggestion: g.suggestion
    })),
    truncatedGroups: Math.max(0, distinctCp - maxGroups),
    worstLines,
    notes: []
  }

  if (probe.charset.lossless) report.notes.push(`${probe.charset.label} 覆盖全部 Unicode 码点，逐字符判定不会丢字`)
  if (probe.charset.kind === "stateful") report.notes.push("UTF-7 为有状态编码：字节数不可按字符加总，已跳过字节核对")
  if (!report.verified) report.notes.push("逐码点预测与整串真实转码不一致，本次结论标为不可信（inconclusive）")
  if (distinctCp > maxGroups) report.notes.push(`仅展示前 ${maxGroups} 个高频字符，其余 ${distinctCp - maxGroups} 个已统计但未列出`)
  if (probe.charset.upgradeTo) report.notes.push(`如需保留这些字符，可改用 ${probe.charset.upgradeTo}`)

  return report
}

function firstDifference (expected, actual) {
  if (actual === null) return { reason: "round-trip failed" }
  const a = [...expected]
  const b = [...actual]
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) {
      return {
        reason: "decoded text differs from per-char prediction",
        index: i,
        expected: a.slice(Math.max(0, i - 8), i + 8).join(""),
        actual: b.slice(Math.max(0, i - 8), i + 8).join("")
      }
    }
  }
  return { reason: "length differs", expectedLength: a.length, actualLength: b.length }
}

/** 便捷封装：把整段文本里的不可表示字符替换成建议值，并报告替换前后的可表示性。 */
export function applySuggestions (text, target, report) {
  const probe = probeTarget(target)
  let out = ""
  let applied = 0
  let unresolved = 0
  const byCp = new Map(report.groups.map((g) => [g.char, g]))
  for (const ch of text) {
    const v = probe.of(ch.codePointAt(0))
    if (v.kind === "ok") { out += ch; continue }
    const g = byCp.get(ch)
    const s = g && g.suggestion
    if (s && s.verified) { out += s.text; applied++ } else { out += (v.kind === "dropped" ? "" : (v.becomes ?? "")); unresolved++ }
  }
  const after = analyze(out, target, { maxGroups: 0, withSuggestions: false })
  return { text: out, applied, unresolved, after }
}
