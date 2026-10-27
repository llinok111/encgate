/**
 * analyze 的报告语义：行列定位、聚合、建议可用性、边界输入。
 */
import test from "node:test"
import assert from "node:assert/strict"

import { analyze, applySuggestions } from "../analyze.mjs"

test("行列定位按码点计列，换行重置", () => {
  const text = "ab中🎉\ncd🎉"
  const r = analyze(text, "gbk", { maxGroups: 5 })
  assert.equal(r.counts.lossyCodePoints, 2)
  const emoji = r.groups.find((g) => g.char === "🎉")
  assert.deepEqual(emoji.positions, [
    { line: 1, column: 4, index: 3 },
    { line: 2, column: 3, index: 8 }
  ])
})

test("同一字符多次出现聚合为一条，并保留前 N 个位置", () => {
  const text = "🎉".repeat(9)
  const r = analyze(text, "gbk", { maxGroups: 5, maxPositions: 3 })
  assert.equal(r.counts.lossyCodePoints, 9)
  assert.equal(r.counts.distinctLossy, 1)
  assert.equal(r.groups[0].count, 9)
  assert.equal(r.groups[0].positions.length, 3)
})

test("超出 maxGroups 的字符被统计但标为截断", () => {
  const text = "🎉😀😁😂🤣"
  const r = analyze(text, "gbk", { maxGroups: 2 })
  assert.equal(r.counts.distinctLossy, 5)
  assert.equal(r.groups.length, 2)
  assert.equal(r.truncatedGroups, 3)
})

test("替代建议必须自身在目标字符集里可表示", () => {
  const r = analyze("“引号”—破折号…省略号🎉", "gbk", { maxGroups: 20 })
  for (const g of r.groups) {
    if (!g.suggestion) continue
    if (g.suggestion.risk === "drop") continue
    assert.equal(g.suggestion.verified, true, `${g.codePoint} 的建议未经验证`)
  }
  // 弯引号在 GBK 里本来就能表示，所以它不应出现在丢失列表里
  assert.equal(r.groups.some((g) => g.char === "“"), false)
})

test("emoji 的建议是删除，且标记为 drop 风险", () => {
  const r = analyze("🎉", "gbk")
  assert.equal(r.groups[0].suggestion.risk, "drop")
  assert.equal(r.groups[0].suggestion.text, "")
})

test("applySuggestions：替换后必须真的无损", () => {
  const text = "A—B…C🎉D"
  const before = analyze(text, "ascii", { maxGroups: 20 })
  assert.equal(before.lossless, false)
  const applied = applySuggestions(text, "ascii", before)
  assert.equal(applied.after.lossless, true, `替换后仍有损失：${JSON.stringify(applied.after.groups)}`)
  assert.ok(applied.applied > 0)
  assert.equal(applied.text, "A-B...CD")
  assert.equal(applied.after.verified, true)
})

test("无损目标返回 lossless 且 groups 为空", () => {
  const r = analyze("任意中文 🎉 均可", "utf-8")
  assert.equal(r.lossless, true)
  assert.equal(r.verified, true)
  assert.deepEqual(r.groups, [])
  assert.equal(r.counts.lossyCodePoints, 0)
})

test("空字符串不炸，统计为 0", () => {
  const r = analyze("", "gbk")
  assert.equal(r.lossless, true)
  assert.equal(r.counts.codePoints, 0)
  assert.equal(r.bytes.actual, 0)
})

test("孤立代理项不导致异常，且结论标为已验证或不一致（不静默）", () => {
  const lone = "\ud800"
  const r = analyze(lone, "gbk")
  assert.equal(typeof r.verified, "boolean")
  if (!r.verified) assert.ok(r.verification.note)
})

test("未知字符集抛出明确错误码", () => {
  assert.throws(() => analyze("x", "no-such-charset"), /未知字符集/)
})

test("gbk 与 gb18030 的差异被如实反映（gb18030 能表示更多）", () => {
  const text = "𠀋"
  const gbk = analyze(text, "gbk")
  const gb18030 = analyze(text, "gb18030")
  assert.equal(gbk.lossless, false)
  assert.equal(gb18030.lossless, true, "GB18030 有四字节区，应能表示增补平面")
})

test("worstLines 按行统计损失，取最多的前 5 行", () => {
  const text = "🎉\n🎉🎉\n🎉\n🎉🎉🎉\n🎉\n🎉\n🎉"
  const r = analyze(text, "gbk")
  assert.equal(r.worstLines[0].count, 3)
  assert.ok(r.worstLines.length <= 5)
})
