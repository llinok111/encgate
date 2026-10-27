/**
 * CLI 契约：退出码是 CI 依赖的接口，必须逐条锁死。
 */
import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import iconv from "../../lib/index.js"

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, "..", "..")
const bin = path.join(root, "bin", "encgate.mjs")

function run (args, { input } = {}) {
  const res = spawnSync(process.execPath, [bin, ...args], {
    cwd: root,
    encoding: "utf8",
    input
  })
  return { code: res.status, out: res.stdout || "", err: res.stderr || "" }
}

function tmpdir () {
  return fs.mkdtempSync(path.join(os.tmpdir(), "encgate-cli-"))
}

test("--version 与 --help 返回 0", () => {
  const v = run(["--version"])
  assert.equal(v.code, 0)
  assert.match(v.out.trim(), /^\d+\.\d+\.\d+$/)
  const h = run(["--help"])
  assert.equal(h.code, 0)
  assert.match(h.out, /转码闸门/)
  assert.match(h.out, /退出码/)
})

test("charsets 列出全部目标编码", () => {
  const r = run(["charsets"])
  assert.equal(r.code, 0)
  for (const k of ["gbk", "gb18030", "big5", "shiftjis", "utf-8"]) assert.ok(r.out.includes(k), `缺少 ${k}`)
})

test("analyze：无损 → 退出码 0；有损 → 退出码 1", () => {
  const dir = tmpdir()
  const clean = path.join(dir, "clean.txt")
  const lossy = path.join(dir, "lossy.txt")
  fs.writeFileSync(clean, iconv.encode("价格 199 元，限时。", "utf-8"))
  fs.writeFileSync(lossy, iconv.encode("价格 199 元 🎉 限时。", "utf-8"))

  const a = run(["analyze", clean, "--to", "gbk"])
  assert.equal(a.code, 0, a.err)
  assert.match(a.out, /无损/)

  const b = run(["analyze", lossy, "--to", "gbk"])
  assert.equal(b.code, 1)
  assert.match(b.out, /会丢 1 个字符/)
  assert.match(b.out, /U\+1F389/)
})

test("analyze --json 输出可解析且字段完整", () => {
  const dir = tmpdir()
  const f = path.join(dir, "x.txt")
  fs.writeFileSync(f, iconv.encode("A🎉B", "utf-8"))
  const r = run(["analyze", f, "--to", "gbk", "--json"])
  assert.equal(r.code, 1)
  const j = JSON.parse(r.out)
  assert.equal(j.lossless, false)
  assert.equal(j.verified, true)
  assert.equal(j.target, "gbk")
  assert.equal(j.counts.lossyCodePoints, 1)
  assert.equal(j.groups[0].codePoint, "U+1F389")
  assert.equal(j.groups[0].positions[0].column, 2)
})

test("analyze 支持 stdin（-）", () => {
  const r = run(["analyze", "-", "--to", "utf-8", "--from", "utf-8"], { input: "纯文本" })
  assert.equal(r.code, 0, r.err)
})

test("detect：短样本 → 退出码 3", () => {
  const dir = tmpdir()
  const f = path.join(dir, "short.txt")
  fs.writeFileSync(f, iconv.encode("中文", "gbk"))
  const r = run(["detect", f])
  assert.equal(r.code, 3)
  assert.match(r.out, /inconclusive/)
})

test("transcode：被拦下时退出码 1 且不产生文件", () => {
  const dir = tmpdir()
  const f = path.join(dir, "data.txt")
  fs.writeFileSync(f, iconv.encode("导出 🎉 完成", "utf-8"))
  const r = run(["transcode", f, "--to", "gbk", "--from", "utf-8"])
  assert.equal(r.code, 1)
  assert.match(r.err, /未产出文件|未转码/)
  assert.deepEqual(fs.readdirSync(dir), ["data.txt"])
})

test("transcode --force 写出产物与清单，退出码 0", () => {
  const dir = tmpdir()
  const f = path.join(dir, "data.txt")
  fs.writeFileSync(f, iconv.encode("导出 🎉 完成", "utf-8"))
  const r = run(["transcode", f, "--to", "gbk", "--from", "utf-8", "--force"])
  assert.equal(r.code, 0, r.err)
  const files = fs.readdirSync(dir).sort()
  assert.deepEqual(files, ["data.gbk.txt", "data.gbk.txt.manifest.json", "data.txt"])
  const m = JSON.parse(fs.readFileSync(path.join(dir, "data.gbk.txt.manifest.json"), "utf8"))
  assert.equal(m.status, "forced-lossy")
  assert.equal(m.verified, true)
})

test("transcode 拒绝把输出写回输入文件（退出码 2）", () => {
  const dir = tmpdir()
  const f = path.join(dir, "same.txt")
  fs.writeFileSync(f, "hello")
  const r = run(["transcode", f, "--to", "gbk", "--from", "utf-8", "--out", f])
  assert.equal(r.code, 2)
  assert.equal(fs.readFileSync(f, "utf8"), "hello")
})

test("未知选项与未知子命令 → 退出码 2", () => {
  assert.equal(run(["analyze", "x.txt", "--nope"]).code, 2)
  assert.equal(run(["nonsense"]).code, 2)
  assert.equal(run(["analyze", "x.txt", "--to", "no-such"]).code, 2)
})

test("不支持的目标字符集 → 退出码 2，不误报成功", () => {
  const dir = tmpdir()
  const f = path.join(dir, "a.txt")
  fs.writeFileSync(f, "abc")
  const r = run(["analyze", f, "--to", "klingon"])
  assert.equal(r.code, 2)
  assert.match(r.err, /不支持/)
})
