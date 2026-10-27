/**
 * 上游守卫：
 *   1. codec 层（lib/ encodings/）的每个文件字节未改，只允许在仓库里新增 gate/ 与 bin/
 *   2. 上游公开行为保持不变（抽样）
 *   3. gate/ 与 bin/ 不使用 Node 20+ 才有的 API —— 包声明 engines >=18，
 *      声明的最低版本必须真的跑得起来（此前吃过"本地 Node 22 全绿、CI 的 18 全红"的亏）
 */
import test from "node:test"
import assert from "node:assert/strict"
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import iconv from "../../lib/index.js"

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, "..", "..")
const pinned = JSON.parse(fs.readFileSync(path.join(here, "..", "test", "fixtures", "upstream-0.7.3.sha256.json"), "utf8"))

test("codec 层逐文件字节未改（基线 iconv-lite v0.7.3）", () => {
  const changed = []
  for (const [rel, want] of Object.entries(pinned.files)) {
    const p = path.join(root, rel)
    if (!fs.existsSync(p)) { changed.push({ rel, reason: "missing" }); continue }
    const got = crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex")
    if (got !== want) changed.push({ rel, reason: "modified" })
  }
  assert.deepEqual(changed, [], `codec 层被改动：${JSON.stringify(changed)}`)
  assert.ok(Object.keys(pinned.files).length >= 14, "哈希基线不完整")
})

test("上游公开行为抽样保持不变", () => {
  assert.equal(iconv.decode(iconv.encode("中文", "gbk"), "gbk"), "中文")
  assert.equal(iconv.encode("🎉", "gbk").toString("hex"), "3f") // 不可表示 → 单个 '?'
  assert.equal(iconv.decode(Buffer.from([0x81, 0x20]), "gbk"), "\ufffd ")
  assert.equal(iconv.encodingExists("gb18030"), true)
  assert.equal(iconv.encodingExists("no-such-encoding"), false)
  assert.equal(iconv.defaultCharSingleByte, "?")
})

test("包元数据：名称、engines、bin 与对外无关的字段", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))
  assert.equal(pkg.name, "encgate")
  assert.equal(pkg.engines.node, ">=18")
  assert.equal(pkg.bin.encgate, "./bin/encgate.mjs")
  assert.equal(pkg.license, "MIT")
  assert.ok(pkg.files.includes("gate/"))
  assert.ok(pkg.files.includes("lib/"), "上游 codec 必须继续随包分发")
})

test("gate/ 与 bin/ 不依赖 Node 20+ 专属 API（engines 下限 18）", () => {
  const banned = [
    { pattern: /\.toSorted\s*\(/, why: "Array#toSorted 需要 Node 20" },
    { pattern: /\.toReversed\s*\(/, why: "Array#toReversed 需要 Node 20" },
    { pattern: /\.findLast(Index)?\s*\(/, why: "Array#findLast 需要 Node 18.0+（可用，但需 18.0 以下不支持）" },
    { pattern: /Object\.groupBy\s*\(/, why: "Object.groupBy 需要 Node 21" },
    { pattern: /Array\.fromAsync\s*\(/, why: "Array.fromAsync 需要 Node 22" },
    { pattern: /fs\.promises\.glob\s*\(/, why: "fs.promises.glob 需要 Node 22" },
    { pattern: /\bimport\.meta\.dirname\b/, why: "import.meta.dirname 需要 Node 20.11" }
  ]
  const files = []
  for (const dir of ["gate", "bin"]) {
    const walk = (p) => {
      for (const e of fs.readdirSync(p, { withFileTypes: true })) {
        if (e.name === "test" || e.name === "fixtures") continue
        const full = path.join(p, e.name)
        if (e.isDirectory()) walk(full)
        else if (/\.(mjs|js)$/.test(e.name)) files.push(full)
      }
    }
    walk(path.join(root, dir))
  }
  assert.ok(files.length >= 6, `扫描到的源文件太少：${files.length}`)
  const hits = []
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8")
    for (const b of banned) {
      // findLast 在 Node 18.0 已存在，这里只在注释里标注，不当作违规
      if (b.why.includes("18.0+")) continue
      if (b.pattern.test(src)) hits.push({ file: path.relative(root, f), why: b.why })
    }
  }
  assert.deepEqual(hits, [])
})
