/**
 * 源编码探测。
 *
 * 分四步，每一步都能被独立核查：
 *   1. BOM             —— 精确，不做猜测
 *   2. UTF-8 严格校验   —— 自写字节级校验（拒绝超长编码、代理区、>U+10FFFF），通过即认定 UTF-8
 *   3. UTF-16 无 BOM    —— 按零字节在奇/偶位的分布判断
 *   4. 遗留双字节       —— 字节语法错误数 + 期望文字占比 + 汉字字频，三项原始值全部输出
 *
 * 一条关键设计取舍（第一版踩到的坑）：
 *   单字节编码（windows-1252）**能解码任何字节串**，结构上永不出错，
 *   所以它在打分上天然占优，会把所有 GBK/Big5 样本都判成 cp1252。
 *   因此单字节候选的分值上限被压到 0.55，且当任一多字节候选"结构零错误 + 解码无替换符"时，
 *   单字节候选不参与胜出——它只在字节确实不构成任何合法多字节序列时才作为兜底出现。
 */
import iconv from "../lib/index.js"
import { CHARSETS } from "./charsets.mjs"
import { FREQUENCY } from "./frequency.mjs"

const CJK = [[0x3000, 0x303f], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xf900, 0xfaff], [0xff00, 0xffef]]
const KANA = [[0x3040, 0x309f], [0x30a0, 0x30ff], [0x31f0, 0x31ff], [0xff66, 0xff9f]]
const HANGUL = [[0x1100, 0x11ff], [0x3130, 0x318f], [0xa960, 0xa97f], [0xac00, 0xd7a3]]
const LATIN = [[0x00a0, 0x024f], [0x2010, 0x203a]]

/**
 * 期望文字：specific = 该语言的"身份标记"（假名 / 谚文），generic = 共用汉字。
 * 只用"是否落在汉字区"判分会让 GBK 把韩文/日文样本全判成中文——汉字区对三者都成立，
 * 没有区分力。加权后，韩文样本在 cp949 下拿到满分，在 GBK 下只能拿 generic 分。
 */
const SCRIPT_RANGES = {
  gbk: { specific: CJK, generic: [] },
  gb18030: { specific: CJK, generic: [] },
  big5: { specific: CJK, generic: [] },
  big5hkscs: { specific: CJK, generic: [] },
  shiftjis: { specific: KANA, generic: CJK },
  eucjp: { specific: KANA, generic: CJK },
  cp949: { specific: HANGUL, generic: CJK },
  "windows-1252": { specific: LATIN, generic: [] }
}
/** 汉字在日文里是正常文字（当用汉字），在韩文里已基本不用 hanja，故两者权重不同。 */
const GENERIC_WEIGHT = { shiftjis: 0.85, eucjp: 0.85, cp949: 0.5 }
const DEFAULT_GENERIC_WEIGHT = 1

/** 这些字符集的候选参与字频打分（字频表是汉字表，纯谚文样本上会自然退回 script 分）。 */
const FREQ_ENABLED = new Set(["gbk", "gb18030", "big5", "big5hkscs", "shiftjis", "eucjp"])

/** 同分时的优先顺序：超集优先（解码结果相同，用更宽的编码更安全）。 */
const PREFERENCE = ["gb18030", "gbk", "big5hkscs", "big5", "shiftjis", "eucjp", "cp949", "windows-1252"]
const SINGLE_BYTE_CAP = 0.55

const inRanges = (cp, ranges) => ranges.some(([lo, hi]) => cp >= lo && cp <= hi)

// ---------------------------------------------------------------- 字节语法校验

function walkDoubleByte (buf, { lead, trail, singles }) {
  let errors = 0
  let i = 0
  while (i < buf.length) {
    const b = buf[i]
    if (b < 0x80) { i++; continue }
    if (singles && singles(b)) { i++; continue }
    if (i + 1 >= buf.length) { errors++; i++; continue }
    if (lead(b) && trail(buf[i + 1])) { i += 2; continue }
    errors++
    i++
  }
  return errors
}

const gbkLead = (b) => b >= 0x81 && b <= 0xfe
const gbkTrail = (t) => t >= 0x40 && t <= 0xfe && t !== 0x7f
const big5Lead = (b) => b >= 0xa1 && b <= 0xf9
const hkscsLead = (b) => b >= 0x81 && b <= 0xfe
const big5Trail = (t) => (t >= 0x40 && t <= 0x7e) || (t >= 0xa1 && t <= 0xfe)
const sjisLead = (b) => (b >= 0x81 && b <= 0x9f) || (b >= 0xe0 && b <= 0xfc)
const sjisTrail = (t) => (t >= 0x40 && t <= 0x7e) || (t >= 0x80 && t <= 0xfc)
const sjisSingle = (b) => b >= 0xa1 && b <= 0xdf
const eucLead = (b) => b >= 0xa1 && b <= 0xfe
const eucTrail = (t) => t >= 0xa1 && t <= 0xfe
const cp949Lead = (b) => b >= 0x81 && b <= 0xfe
const cp949Trail = (t) => (t >= 0x41 && t <= 0x5a) || (t >= 0x61 && t <= 0x7a) || (t >= 0x81 && t <= 0xfe)

const STRUCTURE = {
  gbk: (buf) => walkDoubleByte(buf, { lead: gbkLead, trail: gbkTrail }),
  gb18030: (buf) => {
    let errors = 0
    let i = 0
    while (i < buf.length) {
      const b = buf[i]
      if (b < 0x80) { i++; continue }
      if (gbkLead(b) && i + 3 < buf.length && buf[i + 1] >= 0x30 && buf[i + 1] <= 0x39) {
        if (gbkLead(buf[i + 2]) && buf[i + 3] >= 0x30 && buf[i + 3] <= 0x39) { i += 4; continue }
        errors++; i++; continue
      }
      if (gbkLead(b) && i + 1 < buf.length && gbkTrail(buf[i + 1])) { i += 2; continue }
      errors++; i++
    }
    return errors
  },
  big5: (buf) => walkDoubleByte(buf, { lead: big5Lead, trail: big5Trail }),
  big5hkscs: (buf) => walkDoubleByte(buf, { lead: hkscsLead, trail: big5Trail }),
  shiftjis: (buf) => walkDoubleByte(buf, { lead: sjisLead, trail: sjisTrail, singles: sjisSingle }),
  eucjp: (buf) => {
    let errors = 0
    let i = 0
    while (i < buf.length) {
      const b = buf[i]
      if (b < 0x80) { i++; continue }
      if (b === 0x8e) {
        if (i + 1 < buf.length && buf[i + 1] >= 0xa1 && buf[i + 1] <= 0xdf) { i += 2; continue }
        errors++; i++; continue
      }
      if (b === 0x8f) {
        if (i + 2 < buf.length && eucTrail(buf[i + 1]) && eucTrail(buf[i + 2])) { i += 3; continue }
        errors++; i++; continue
      }
      if (eucLead(b) && i + 1 < buf.length && eucTrail(buf[i + 1])) { i += 2; continue }
      errors++; i++
    }
    return errors
  },
  cp949: (buf) => walkDoubleByte(buf, { lead: cp949Lead, trail: cp949Trail }),
  "windows-1252": () => 0 // 单字节：任何字节都合法，语法检查没有区分力，见文件头说明
}

// ---------------------------------------------------------------- UTF-8 / UTF-16

export function utf8Validity (buf) {
  let i = 0
  let multibyte = 0
  while (i < buf.length) {
    const b = buf[i]
    if (b < 0x80) { i++; continue }
    let need
    let min
    if (b >= 0xc2 && b <= 0xdf) { need = 1; min = 0x80 } else if (b >= 0xe0 && b <= 0xef) { need = 2; min = 0x800 } else if (b >= 0xf0 && b <= 0xf4) { need = 3; min = 0x10000 } else return { valid: false, multibyte, at: i }
    if (i + need >= buf.length) return { valid: false, multibyte, at: i }
    let cp = b & (0x3f >> need)
    for (let k = 1; k <= need; k++) {
      const c = buf[i + k]
      if ((c & 0xc0) !== 0x80) return { valid: false, multibyte, at: i }
      cp = (cp << 6) | (c & 0x3f)
    }
    if (cp < min) return { valid: false, multibyte, at: i }
    if (cp >= 0xd800 && cp <= 0xdfff) return { valid: false, multibyte, at: i }
    if (cp > 0x10ffff) return { valid: false, multibyte, at: i }
    multibyte++
    i += need + 1
  }
  return { valid: true, multibyte, at: -1 }
}

function utf16Guess (buf) {
  const n = Math.min(buf.length, 4096)
  let evenZero = 0
  let oddZero = 0
  for (let i = 0; i + 1 < n; i += 2) {
    if (buf[i] === 0) evenZero++
    if (buf[i + 1] === 0) oddZero++
  }
  const pairs = Math.floor(n / 2) || 1
  const evenRatio = evenZero / pairs
  const oddRatio = oddZero / pairs
  if (oddRatio > 0.3 && oddRatio > evenRatio * 3) return { encoding: "utf-16le", strength: oddRatio }
  if (evenRatio > 0.3 && evenRatio > oddRatio * 3) return { encoding: "utf-16be", strength: evenRatio }
  return null
}

// ---------------------------------------------------------------- 评分

const BOMS = [
  { bytes: [0xff, 0xfe, 0x00, 0x00], encoding: "utf-32le", iconv: "utf-32le", skip: 4 },
  { bytes: [0x00, 0x00, 0xfe, 0xff], encoding: "utf-32be", iconv: "utf-32be", skip: 4 },
  { bytes: [0xef, 0xbb, 0xbf], encoding: "utf-8", iconv: "utf-8", skip: 3 },
  { bytes: [0xff, 0xfe], encoding: "utf-16le", iconv: "utf-16le", skip: 2 },
  { bytes: [0xfe, 0xff], encoding: "utf-16be", iconv: "utf-16be", skip: 2 }
]

function matchBom (buf) {
  for (const bom of BOMS) {
    if (buf.length >= bom.bytes.length && bom.bytes.every((b, i) => buf[i] === b)) return bom
  }
  return null
}

function scriptRatio (text, ranges, genericWeight) {
  let nonAscii = 0
  let score = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0)
    if (cp < 0x80) continue
    nonAscii++
    if (inRanges(cp, ranges.specific)) score += 1
    else if (ranges.generic.length && inRanges(cp, ranges.generic)) score += genericWeight
  }
  if (nonAscii === 0) return { ratio: null, nonAscii }
  return { ratio: Math.min(1, score / nonAscii), nonAscii }
}

/**
 * 字频分。实测（见 gate/scripts/bench-detect.mjs）真实解码与错误解码的差别
 * **主要不在均值而在覆盖率**：正确解码的汉字覆盖率 0.998–1.0，错误解码 0.28–0.75。
 * 所以这里用 mean × coverage² ——覆盖率低时哪怕均值尚可也会被压下去。
 */
function freqScore (text) {
  let sum = 0
  let n = 0
  let present = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0)
    if (cp < 0x4e00 || cp > 0x9fff) continue
    n++
    const f = FREQUENCY.get(ch)
    if (f !== undefined) { present++; sum += f }
  }
  if (n < 8) return { score: null, coverage: null, mean: null, covered: n }
  const coverage = present / n
  const mean = sum / n
  return {
    score: Math.min(1, mean / 0.7) * coverage * coverage,
    coverage,
    mean,
    covered: n
  }
}

/** 单字节候选的"像不像西文"评分：可见 ASCII 占比。GBK 字节被当成 cp1252 解出来时该值约 0.5–0.6。 */
function asciiPrintability (text) {
  let printable = 0
  let total = 0
  for (const ch of text) {
    if (ch === "\n" || ch === "\r" || ch === "\t") { total++; printable++; continue }
    const cp = ch.codePointAt(0)
    total++
    if (cp >= 0x20 && cp <= 0x7e) printable++
  }
  return total ? printable / total : 0
}

function scoreCandidate (buf, key) {
  const cs = CHARSETS[key]
  const structErrors = STRUCTURE[key](buf)
  const totalUnits = Math.max(1, buf.length)
  let text
  let replacementCount
  try {
    text = iconv.decode(buf, cs.iconv)
    replacementCount = (text.match(/\uFFFD/g) || []).length
  } catch (err) {
    return { key, label: cs.label, error: String(err && err.message), score: -1, clean: false }
  }
  const structRate = structErrors / totalUnits
  const ranges = SCRIPT_RANGES[key] || { specific: CJK, generic: [] }
  const sr = scriptRatio(text, ranges, GENERIC_WEIGHT[key] ?? DEFAULT_GENERIC_WEIGHT)
  const fr = FREQ_ENABLED.has(key) ? freqScore(text) : { score: null, coverage: null, mean: null, covered: 0 }
  const clean = structErrors === 0 && replacementCount === 0

  let score = 0
  const parts = {}
  if (structRate <= 0.05 && replacementCount === 0) {
    if (cs.kind === "sbcs") {
      // 单字节：只能靠"像不像西文"判断，且封顶，避免它靠"什么都能解"赢下所有样本
      const ap = asciiPrintability(text)
      parts.asciiPrintability = Number(ap.toFixed(4))
      score = Math.min(SINGLE_BYTE_CAP, SINGLE_BYTE_CAP * ap)
    } else {
      const s1 = 1 - structRate * 4
      const s2 = sr.ratio === null ? 0.5 : sr.ratio
      // 字频项不可用（例如纯谚文）时退回文字项，不额外加分也不扣分
      const s3 = fr.score === null ? s2 : fr.score
      parts.structTerm = Number(s1.toFixed(4))
      parts.scriptTerm = Number(s2.toFixed(4))
      parts.freqTerm = Number(s3.toFixed(4))
      score = 0.35 * s1 + 0.4 * s2 + 0.25 * s3
    }
  }

  return {
    key,
    label: cs.label,
    kind: cs.kind,
    score: Number(score.toFixed(4)),
    parts,
    clean,
    structuralErrors: structErrors,
    structuralRate: Number(structRate.toFixed(4)),
    replacementCount,
    scriptRatio: sr.ratio === null ? null : Number(sr.ratio.toFixed(4)),
    nonAsciiChars: sr.nonAscii,
    freqScore: fr.score === null ? null : Number(fr.score.toFixed(4)),
    freqCovered: fr.covered,
    preview: text.slice(0, 48)
  }
}

/**
 * @param {Buffer|Uint8Array|string} input
 * @param {{minBytes?: number}} [opts]
 */
export function detect (input, opts = {}) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input ?? "")
  const minBytes = opts.minBytes ?? 32
  const notes = []
  if (buf.length === 0) {
    return { encoding: null, confidence: 0, verdict: "inconclusive", bom: null, candidates: [], text: "", replacementCount: 0, notes: ["输入为空"] }
  }

  const bom = matchBom(buf)
  if (bom) {
    const text = iconv.decode(buf.subarray(bom.skip), bom.iconv)
    return {
      encoding: bom.encoding,
      confidence: 1,
      verdict: "certain",
      bom: bom.encoding,
      candidates: [{ key: bom.encoding, label: bom.encoding.toUpperCase(), score: 1, reason: "BOM" }],
      text,
      replacementCount: (text.match(/\uFFFD/g) || []).length,
      notes: [`BOM 命中 ${bom.encoding}，跳过前 ${bom.skip} 字节`]
    }
  }

  const u8 = utf8Validity(buf)
  if (u8.valid) {
    const text = buf.toString("utf8")
    const onlyAscii = u8.multibyte === 0
    if (onlyAscii) notes.push("纯 ASCII：UTF-8 / GBK / Latin-1 解码结果完全相同，按 UTF-8 处理")
    return {
      encoding: "utf-8",
      confidence: onlyAscii ? 0.6 : 0.99,
      verdict: onlyAscii ? "likely" : "certain",
      bom: null,
      candidates: [{ key: "utf-8", label: "UTF-8", score: onlyAscii ? 0.6 : 1, reason: onlyAscii ? "ASCII 子集" : "UTF-8 结构校验通过" }],
      text,
      replacementCount: 0,
      notes
    }
  }
  notes.push(`UTF-8 结构校验在第 ${u8.at} 字节失败`)

  const u16 = utf16Guess(buf)
  if (u16 && u16.strength > 0.45) {
    const text = iconv.decode(buf, u16.encoding)
    return {
      encoding: u16.encoding,
      confidence: Number(Math.min(0.95, 0.6 + u16.strength * 0.35).toFixed(2)),
      verdict: "likely",
      bom: null,
      candidates: [{ key: u16.encoding, label: u16.encoding.toUpperCase(), score: Number(u16.strength.toFixed(4)), reason: "零字节分布" }],
      text,
      replacementCount: (text.match(/\uFFFD/g) || []).length,
      notes: [...notes, "无 BOM 的 UTF-16 判定依赖零字节分布，属启发式"]
    }
  }

  const candidates = Object.keys(STRUCTURE).map((k) => scoreCandidate(buf, k)).filter((c) => !c.error)
  const multiByteClean = candidates.filter((c) => c.clean && c.kind !== "sbcs")
  let pool = candidates
  if (multiByteClean.length > 0) {
    pool = candidates.filter((c) => c.kind !== "sbcs")
    notes.push("存在多字节候选可零错误解码，单字节候选（windows-1252）不参与胜出")
  }
  pool.sort((a, b) => b.score - a.score || PREFERENCE.indexOf(a.key) - PREFERENCE.indexOf(b.key))
  const top = pool[0]
  if (!top || top.score <= 0) {
    const bestSingle = candidates.find((c) => c.kind === "sbcs")
    return {
      encoding: bestSingle && bestSingle.score > 0 ? bestSingle.key : null,
      confidence: bestSingle ? 0.3 : 0,
      verdict: "inconclusive",
      bom: null,
      candidates,
      text: "",
      replacementCount: 0,
      notes: [...notes, "所有候选都被结构性否决：该输入可能不是文本，或已损坏"]
    }
  }

  // 满分并列 → 归并为同一结论。只有真正的超集关系才说"字节层面无法区分"，
  // 否则（例如 eucjp 与 cp949 同分）必须说明这是判定能力不足，而不是等价。
  const equivalent = pool.filter((c) => top.score - c.score < 0.005)
  if (equivalent.length > 1) {
    const names = equivalent.map((c) => c.key).join(" / ")
    const supersetPair = equivalent.some((c) => (CHARSETS[top.key].supersetOf || []).includes(c.key) || (CHARSETS[c.key].supersetOf || []).includes(top.key))
    notes.push(supersetPair
      ? `候选在字节层面等价（${names}），按超集优先给出 ${top.key}`
      : `有 ${equivalent.length} 个候选同分（${names}），按固定优先顺序给出 ${top.key}，建议人工确认`)
  }
  const margin = top.score - (pool.find((c) => top.score - c.score >= 0.005)?.score ?? 0)
  const short = buf.length < minBytes
  if (short) notes.push(`样本仅 ${buf.length} 字节（< ${minBytes}），短样本下双字节编码互相误判概率高`)

  let verdict
  if (short) verdict = "inconclusive"
  else if (margin >= 0.15 && top.structuralErrors === 0) verdict = "likely"
  else if (margin >= 0.06) verdict = "weak"
  else if (equivalent.length > 1 && top.structuralErrors === 0) verdict = "likely"
  else verdict = "inconclusive"

  return {
    encoding: top.key,
    confidence: Number(Math.min(0.95, Math.max(0.3, 0.5 + margin * 1.5)).toFixed(2)),
    verdict,
    bom: null,
    margin: Number(margin.toFixed(4)),
    equivalent: equivalent.length > 1 ? equivalent.map((c) => c.key) : undefined,
    candidates,
    text: iconv.decode(buf, CHARSETS[top.key].iconv),
    replacementCount: top.replacementCount,
    notes
  }
}
