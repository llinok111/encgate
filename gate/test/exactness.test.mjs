/**
 * 精确性套件：这是本项目的核心主张，必须逐条比对"预言"与"真实转码"。
 *
 * 三个层次的断言：
 *   1. 逐码点 verdict 与整串真实结果一致（不存在"单字符判定对、拼起来就错"的编码）
 *   2. 用 verdict 拼出的预期解码结果与真实 decode(encode(text)) 逐字符相同
 *   3. 非有状态编码下，逐码点字节数之和等于整串字节长度
 */
import test from "node:test"
import assert from "node:assert/strict"
import iconv from "../../lib/index.js"
import { probeTarget } from "../probe.mjs"
import { analyze } from "../analyze.mjs"

const TARGETS = [
  "gbk", "gb18030", "big5", "big5hkscs", "shiftjis", "eucjp", "cp949",
  "windows-1252", "ascii", "utf-8", "utf-16le", "utf-16be", "utf-32le", "utf7"
]

/** 覆盖：ASCII / 拉丁补充 / 标点 / 希腊 / 西里尔 / 假名 / 谚文 / 汉字 / 兼容区 / 增补平面 */
function sampleCodePoints () {
  const cps = new Set()
  for (let cp = 0x20; cp <= 0x7e; cp++) cps.add(cp)
  for (let cp = 0xa0; cp <= 0x2fff; cp += 13) cps.add(cp)
  for (let cp = 0x3000; cp <= 0x9fff; cp += 17) cps.add(cp)
  for (let cp = 0xac00; cp <= 0xd7a3; cp += 41) cps.add(cp)
  for (let cp = 0xf900; cp <= 0xffef; cp += 5) cps.add(cp)
  for (const cp of [0x1f389, 0x1f600, 0x20000, 0x2a6d6, 0x10ffff, 0x10000, 0x1d11e]) cps.add(cp)
  return [...cps].sort((a, b) => a - b)
}

const CPS = sampleCodePoints()

test("逐码点 verdict 与真实转码一致（所有目标字符集）", () => {
  let checked = 0
  const mismatches = []
  for (const target of TARGETS) {
    const probe = probeTarget(target)
    for (const cp of CPS) {
      const ch = String.fromCodePoint(cp)
      const v = probe.of(cp)
      const back = iconv.decode(iconv.encode(ch, probe.charset.iconv), probe.charset.iconv)
      checked++
      const realOk = back === ch
      if ((v.kind === "ok") !== realOk) {
        mismatches.push({ target, cp, verdict: v.kind, real: back })
      }
    }
  }
  assert.deepEqual(mismatches, [], `逐码点判定与真实转码分歧：${JSON.stringify(mismatches.slice(0, 5))}`)
  assert.ok(checked > 40000, `断言数量异常：${checked}`)
})

test("预期解码结果与真实 decode(encode(text)) 逐字符一致", () => {
  const samples = [
    "价格：￥199 — 含税 🎉 “限时”",
    "中文abc日本語한국어éüß—…“”",
    "ASCII only text 12345",
    "㈱①ⅧⅢ㊤～－",
    "훈민정음 한글 테스트",
    "カタカナとひらがな、漢字。",
    "𝕳𝖊𝖑𝖑𝖔 𝔘𝔫𝔦𝔠𝔬𝔡𝔢 🎊"
  ]
  const failures = []
  for (const target of TARGETS) {
    for (const text of samples) {
      const r = analyze(text, target, { maxGroups: 999 })
      if (!r.verified) failures.push({ target, text, note: r.verification.note })
    }
  }
  assert.deepEqual(failures, [])
})

test("字节预言：非有状态编码下逐码点字节数之和 === 整串字节数", () => {
  const text = "价格：￥199 — 含税 🎉 “限时” abc 日本語 한국어"
  const bad = []
  for (const target of TARGETS) {
    const probe = probeTarget(target)
    const r = analyze(text, target)
    if (!probe.perCharBytesExact) continue
    if (r.bytes.predicted !== r.bytes.actual) bad.push({ target, predicted: r.bytes.predicted, actual: r.bytes.actual })
  }
  assert.deepEqual(bad, [])
})

test("有状态编码（UTF-7）不宣称字节可加总", () => {
  const text = "中文a中文a中文"
  const r = analyze(text, "utf7")
  assert.equal(r.verification.perCharBytesExact, false)
  assert.equal(r.lossless, true)
  // 逐字符拼接确实不等于整串，这正是不能按字符算偏移的原因
  const whole = iconv.encode(text, "utf7")
  const concat = Buffer.concat([...text].map((c) => iconv.encode(c, "utf7")))
  assert.equal(whole.equals(concat), false)
})

test("替换字符被运行时改掉时，判定仍然正确", () => {
  const original = iconv.defaultCharSingleByte
  try {
    iconv.defaultCharSingleByte = "\u25a1" // □
    const r = analyze("中文 🎉", "gbk")
    assert.equal(r.lossless, false)
    assert.equal(r.verified, true)
    assert.equal(r.counts.lossyCodePoints, 1)
  } finally {
    iconv.defaultCharSingleByte = original
  }
})

test("随机混合文本 200 轮：损失计数与真实回环一致", () => {
  let seed = 20261027
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff
  }
  const pool = ["a", "Z", "0", "中", "文", "あ", "ア", "한", "🎉", "—", "“", "①", "é", "ß", "𠀋", "\n", " "]
  const targets = ["gbk", "big5", "shiftjis", "cp949", "windows-1252", "ascii"]
  for (let round = 0; round < 200; round++) {
    let text = ""
    const n = 1 + Math.floor(rnd() * 40)
    for (let i = 0; i < n; i++) text += pool[Math.floor(rnd() * pool.length)]
    for (const target of targets) {
      const probe = probeTarget(target)
      const r = analyze(text, target)
      const back = probe.roundTrip(text)
      assert.equal(r.verified, true, `round ${round} ${target} 复核失败`)
      assert.equal(r.lossless, back.lossless, `round ${round} ${target} 无损判定与真实回环不一致`)
      if (back.lossless) assert.equal(back.text, text)
    }
  }
})

test("增补平面字符：单字节编码会产出两个占位符，双字节只产出一个", () => {
  // 这是 iconv-lite 的实现细节（SBCS 编码器按 UTF-16 码元处理），
  // 直接导致"输出里 ? 的个数 = 丢失字符数"这个常见假设在增补平面上是错的。
  const astral = "𠀋"
  const expected = { ascii: "??", "windows-1252": "??", gbk: "?", big5: "?", shiftjis: "?", cp949: "?" }
  for (const [target, becomes] of Object.entries(expected)) {
    const r = analyze(astral, target, { maxGroups: 5 })
    assert.equal(r.counts.lossyCodePoints, 1, `${target}: 应只记 1 个丢失码点`)
    assert.equal(r.groups[0].becomes, becomes, `${target}: 占位符个数应为 ${becomes.length}`)
    assert.equal(r.groups[0].bytes, becomes.length, `${target}: 字节数应与占位符数一致`)
    assert.equal(r.verified, true, `${target}: 预测必须与真实转码一致`)
  }
})
