/**
 * 转码闸门：拒绝产出、强行产出、建议替换、清单确定性。
 */
import test from "node:test"
import assert from "node:assert/strict"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import iconv from "../../lib/index.js"
import { preflight, transcode, transcodeFile, EXIT } from "../transcode.mjs"

function tmpdir () {
  return fs.mkdtempSync(path.join(os.tmpdir(), "encgate-"))
}

const LOSSY_TEXT = "导出说明：含税价 199 元 🎉 限时\n第二行也有 emoji 😀\n"
const CLEAN_TEXT = "导出说明：含税价 199 元，限时。\n第二行没有 emoji。\n"

test("无损输入：产出字节且解回来完全一致", () => {
  const input = iconv.encode(CLEAN_TEXT, "utf-8")
  const r = transcode(input, { to: "gbk", from: "utf-8" })
  assert.equal(r.status, "ok")
  assert.equal(r.manifest.lossyCodePoints, 0)
  assert.equal(r.manifest.verified, true)
  assert.equal(iconv.decode(r.buffer, "gbk"), CLEAN_TEXT)
  assert.equal(r.manifest.outputSha256, crypto.createHash("sha256").update(r.buffer).digest("hex"))
})

test("有损且未 force：不产出任何字节，并说明会丢多少", () => {
  const input = iconv.encode(LOSSY_TEXT, "utf-8")
  const r = transcode(input, { to: "gbk", from: "utf-8" })
  assert.equal(r.status, "blocked")
  assert.equal(r.buffer, null)
  assert.equal(r.manifest.lossyCodePoints, 2)
  assert.equal(r.manifest.distinctLossy, 2)
  assert.ok(r.manifest.reason.includes("未产出文件"))
})

test("有损 + force：产出字节，占位符留痕，清单标记 forced-lossy", () => {
  const input = iconv.encode(LOSSY_TEXT, "utf-8")
  const r = transcode(input, { to: "gbk", from: "utf-8", force: true })
  assert.equal(r.status, "forced-lossy")
  assert.equal(r.manifest.verified, true)
  const back = iconv.decode(r.buffer, "gbk")
  assert.equal(back, LOSSY_TEXT.replace("🎉", "?").replace("😀", "?"))
  assert.deepEqual(r.manifest.lossy.map((l) => l.codePoint), ["U+1F389", "U+1F600"])
})

test("--suggest：按已验证建议替换后产出无损文件（不再需要 --force）", () => {
  const text = "A—B…C🎉D"
  const input = iconv.encode(text, "utf-8")
  const r = transcode(input, { to: "ascii", from: "utf-8", applySuggestions: true })
  assert.equal(r.status, "ok")
  assert.equal(iconv.decode(r.buffer, "ascii"), "A-B...CD")
  assert.equal(r.manifest.suggestionsApplied, 3)
  assert.equal(r.manifest.lossyCodePoints, 0)
  assert.equal(r.manifest.verified, true)
})

test("--suggest 换来不了无损时仍然拦下（不接受悄悄降级）", () => {
  const text = "汉字🎉"
  const input = iconv.encode(text, "utf-8")
  const r = transcode(input, { to: "ascii", from: "utf-8", applySuggestions: true })
  assert.equal(r.status, "blocked")
  assert.equal(r.buffer, null)
  assert.ok(r.manifest.reason.includes("仍有"))
})

test("文件级：写出产物与清单，输出路径不与输入同名", () => {
  const dir = tmpdir()
  const inPath = path.join(dir, "导出.csv")
  fs.writeFileSync(inPath, iconv.encode(CLEAN_TEXT, "utf-8"))
  const r = transcodeFile(inPath, { to: "gbk", from: "utf-8" })
  assert.ok(fs.existsSync(r.outPath))
  assert.ok(fs.existsSync(r.manifestPath))
  const manifest = JSON.parse(fs.readFileSync(r.manifestPath, "utf8"))
  assert.equal(manifest.tool, "encgate")
  assert.equal(manifest.input, "导出.csv")
  assert.equal(fs.statSync(r.outPath).size, manifest.outputBytes)
})

test("文件级：被拦下时不留下产物文件", () => {
  const dir = tmpdir()
  const inPath = path.join(dir, "lossy.csv")
  fs.writeFileSync(inPath, iconv.encode(LOSSY_TEXT, "utf-8"))
  const r = transcodeFile(inPath, { to: "gbk", from: "utf-8" })
  assert.equal(r.outPath, null)
  assert.equal(fs.existsSync(path.join(dir, "lossy.gbk.csv")), false)
  assert.equal(fs.readdirSync(dir).length, 1, "被拦下时目录里不应新增文件")
})

test("清单可复现：同一输入两次运行得到逐字节相同的清单", () => {
  const dir = tmpdir()
  const inPath = path.join(dir, "same.csv")
  fs.writeFileSync(inPath, iconv.encode(CLEAN_TEXT, "utf-8"))
  const a = transcodeFile(inPath, { to: "gbk", from: "utf-8" })
  const first = fs.readFileSync(a.manifestPath)
  const b = transcodeFile(inPath, { to: "gbk", from: "utf-8" })
  const second = fs.readFileSync(b.manifestPath)
  assert.equal(first.equals(second), true, "清单里出现了随时间变化的字段")
})

test("源编码无法确定时拒绝转码（不猜）", () => {
  const input = iconv.encode("中文", "gbk") // 6 字节，短样本
  const plan = preflight(input, { to: "gbk" })
  assert.equal(plan.status, "inconclusive")
  assert.ok(plan.reason.includes("--from"))
})

test("强制指定错误源编码时，结论仍以复核为准（不会假称成功）", () => {
  const input = iconv.encode(CLEAN_TEXT, "gbk")
  const r = transcode(input, { to: "utf-8", from: "big5" })
  // 用错源编码解出来的是乱码，但转成 UTF-8 本身是"无损"的——闸门只对目标字符集负责
  assert.equal(r.status, "ok")
  assert.equal(r.manifest.verified, true)
})

test("退出码常量与文档一致", () => {
  assert.deepEqual(EXIT, { OK: 0, LOSSY: 1, ERROR: 2, INCONCLUSIVE: 3 })
})
