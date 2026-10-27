/**
 * 探测层：BOM / UTF-8 / 遗留双字节 / 短样本 / 非文本。
 * 语料是真实人工翻译文案（见 fixtures/corpus/PROVENANCE.md），不是自造句子。
 */
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import iconv from "../../lib/index.js"
import { detect, utf8Validity } from "../detect.mjs"

const here = path.dirname(fileURLToPath(import.meta.url))
const corpus = (name) => fs.readFileSync(path.join(here, "..", "test", "fixtures", "corpus", name), "utf8")

const WESTERN = "Grüße aus München — die Straße ist schön, aber teuer. Ça va? Évidemment, oui. " +
  "Le cœur a ses raisons que la raison ne connaît point; c'est pourquoi l'on aime. " +
  "Der Frühling kommt, die Vögel singen, und die Sonne scheint über den Dächern der Stadt."

test("BOM 精确判定，且跳过 BOM 字节", () => {
  const cases = [
    { enc: "utf-8", bom: [0xef, 0xbb, 0xbf] },
    { enc: "utf-16le", bom: [0xff, 0xfe] },
    { enc: "utf-16be", bom: [0xfe, 0xff] }
  ]
  for (const c of cases) {
    const body = iconv.encode("中文 abc", c.enc)
    const buf = Buffer.concat([Buffer.from(c.bom), body])
    const r = detect(buf)
    assert.equal(r.encoding, c.enc)
    assert.equal(r.verdict, "certain")
    assert.equal(r.confidence, 1)
    assert.equal(r.bom, c.enc)
    assert.equal(r.text, "中文 abc")
  }
})

test("合法多字节 UTF-8 判为确定", () => {
  const r = detect(iconv.encode("这是一段 utf-8 文本，含 emoji 🎉", "utf-8"))
  assert.equal(r.encoding, "utf-8")
  assert.equal(r.verdict, "certain")
})

test("纯 ASCII 给出 likely + 歧义说明，而不是假装确定", () => {
  const r = detect(Buffer.from("plain ascii text, nothing special here at all", "ascii"))
  assert.equal(r.encoding, "utf-8")
  assert.equal(r.verdict, "likely")
  assert.ok(r.notes.some((n) => n.includes("纯 ASCII")))
})

test("UTF-8 结构校验拒绝超长编码与代理区", () => {
  assert.equal(utf8Validity(Buffer.from([0xc0, 0xaf])).valid, false) // overlong '/'
  assert.equal(utf8Validity(Buffer.from([0xed, 0xa0, 0x80])).valid, false) // surrogate
  assert.equal(utf8Validity(Buffer.from([0xf5, 0x80, 0x80, 0x80])).valid, false) // > U+10FFFF
  assert.equal(utf8Validity(Buffer.from("中文", "utf8")).valid, true)
})

test("真实语料：简体中文 GBK（≥256 字节）", () => {
  const sample = corpus("zh-hans.txt").slice(0, 200)
  const buf = iconv.encode(sample, "gbk")
  const r = detect(buf)
  assert.ok(["gbk", "gb18030"].includes(r.encoding), `实际给出 ${r.encoding}`)
  assert.ok(["likely", "weak"].includes(r.verdict), `verdict=${r.verdict}`)
})

test("真实语料：繁体中文 Big5（≥256 字节）", () => {
  const sample = corpus("zh-hant.txt").slice(0, 200)
  const buf = iconv.encode(sample, "big5")
  const r = detect(buf)
  assert.ok(["big5", "big5hkscs"].includes(r.encoding), `实际给出 ${r.encoding}`)
})

test("真实语料：日文 Shift_JIS 与 EUC-JP", () => {
  const sample = corpus("ja.txt").slice(0, 300)
  for (const enc of ["shiftjis", "eucjp"]) {
    const r = detect(iconv.encode(sample, enc))
    assert.equal(r.encoding, enc, `${enc} 被判成 ${r.encoding}`)
  }
})

test("真实语料：韩文 CP949", () => {
  const sample = corpus("ko.txt").slice(0, 300)
  const r = detect(iconv.encode(sample, "cp949"))
  assert.equal(r.encoding, "cp949", `实际给出 ${r.encoding}`)
})

test("短样本一律 inconclusive（不猜）", () => {
  const buf = iconv.encode("中文", "gbk")
  const r = detect(buf, { minBytes: 32 })
  assert.equal(r.verdict, "inconclusive")
  assert.ok(r.notes.some((n) => n.includes("短样本")))
})

test("空输入返回 inconclusive 且不抛异常", () => {
  const r = detect(Buffer.alloc(0))
  assert.equal(r.encoding, null)
  assert.equal(r.verdict, "inconclusive")
})

test("随机高字节不抛异常，且不给出高置信度结论", () => {
  const buf = Buffer.from(Array.from({ length: 200 }, (_, i) => 0x80 + ((i * 37) % 0x78)))
  const r = detect(buf)
  assert.ok(r.confidence <= 0.95)
  if (r.encoding === "windows-1252") assert.ok(r.confidence <= 0.55)
})

test("候选里始终带原始评分分量，便于人工复核", () => {
  const buf = iconv.encode(corpus("zh-hans.txt").slice(0, 200), "gbk")
  const r = detect(buf)
  const c = r.candidates.find((x) => x.key === r.encoding)
  assert.ok(c, "首选候选必须在候选表里")
  assert.equal(typeof c.structuralErrors, "number")
  assert.ok("scriptRatio" in c)
  assert.ok("freqScore" in c)
})

test("西欧单字节文本：windows-1252 不被双字节候选抢走", () => {
  const buf = iconv.encode(WESTERN, "windows-1252")
  const r = detect(buf)
  assert.equal(r.encoding, "windows-1252", `实际给出 ${r.encoding}`)
  assert.ok(r.confidence >= 0.5)
  // 双字节候选在这里必然失败：字节流里有落单的高位字节
  const gbk = r.candidates.find((c) => c.key === "gbk")
  assert.ok(gbk.structuralErrors > 0 || gbk.replacementCount > 0)
})
