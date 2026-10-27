#!/usr/bin/env node
/**
 * 测试入口：显式列出 gate/test 下的用例文件再交给 `node --test`。
 *
 * 不用 `node --test "gate/test/*.test.mjs"` 的原因：引号内 glob 展开是 Node 21+ 的行为，
 * 而本包声明 engines >=18（声明的最低版本必须真的能跑）。
 */
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const testDir = path.resolve(here, "..", "test")
const files = fs.readdirSync(testDir)
  .filter((f) => f.endsWith(".test.mjs"))
  .sort()
  .map((f) => path.join(testDir, f))

if (files.length === 0) {
  console.error("没有找到任何测试文件（gate/test/*.test.mjs）")
  process.exit(1)
}

const res = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" })
process.exit(res.status === null ? 1 : res.status)
