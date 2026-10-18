#!/usr/bin/env node
'use strict'
/*
 * check-secrets.cjs —— 提交前的密钥闸门。
 *
 * 为什么必须有：`config.json` 里躺着各家厂商的明文 API Key，而公开仓库被爬虫扫到是**分钟级**的事，
 * 泄漏不可逆。人肉 `git status` 逐行看是挡不住的 —— 迟早有一次会顺手 `git add -A`。
 * 所以把判据变成可执行的检查：命中任何一条密钥特征就退出码非 0，CI 与 pre-commit 都能用它。
 *
 * 用法：
 *   node scripts/check-secrets.cjs              扫描工作区（跳过 node_modules/.git/dist 与 gitignore 的隐私文件）
 *   node scripts/check-secrets.cjs <文件...>     只扫指定文件（给 pre-commit / git diff --name-only 用）
 *   node scripts/check-secrets.cjs --staged      只扫 git 暂存区里的文件
 *
 * 退出码：0 = 干净；1 = 命中密钥特征（会打印文件:行号:命中的特征名）。
 *
 * ⚠ 只报"特征名"、绝不回显命中的原文 —— 这个脚本的输出常常被贴进 Issue 或 CI 日志。
 */
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')

// 特征表与 scripts/sync-skill-dist.cjs 的自检规则保持一致 —— 两处判据不能各写各的。
const SECRET_RES = [
  ['网关统一 Key', /freegw-[0-9a-f]{32}/],
  ['Groq Key', /gsk_[A-Za-z0-9]{20,}/],
  ['OpenRouter Key', /sk-or-v1-[A-Za-z0-9]{20,}/],
  ['Anthropic Key', /sk-ant-[A-Za-z0-9_-]{20,}/],
  ['Google Key', /AIza[A-Za-z0-9_-]{30,}/],
  ['OpenAI Key', /sk-(?:proj-)?[A-Za-z0-9_-]{40,}/],
  ['HuggingFace Key', /hf_[A-Za-z0-9]{30,}/],
  ['NVIDIA Key', /nvapi-[A-Za-z0-9_-]{30,}/],
  ['Cerebras Key', /csk-[A-Za-z0-9]{30,}/],
]

// 目录：一律跳过。这些要么是依赖、要么是 git 自己的库、要么是本项目明确 gitignore 的隐私区。
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', '.workbuddy-ai'])
// 后缀：二进制/体积大，不做文本扫描。
const SKIP_EXT = /\.(png|jpg|jpeg|gif|ico|svgz|zip|gz|pdf|woff2?|ttf|mp4)$/i
const MAX_BYTES = 2 * 1024 * 1024 // 单文件超过 2MB 不扫（状态日志可能很大）

// ── 从 .gitignore 读"隐私文件"规则并跳过 ──
// ⚠ 为什么必须这么做：`config.json` 里就是**真 Key**。本机跑这个闸门时，若不跳过它，
//   每次都会红 —— 而"每次都红的闸门"最后一定会被人忽略（这正是本项目反复强调的"假 FAIL"）。
//   所以工作区扫描要跳过 `.gitignore` 已覆盖的文件，只对"**没被覆盖、可能被提交**的"报红。
// ⚠ 单一事实来源：这里**不另写一份文件名清单**，直接读 `.gitignore`
//   （本项目的铁律：同一份源数据不能有两套过滤条件 —— 两处判据必然漂）。
//   只支持 `.gitignore` 里实际出现的写法：`#` 注释、`!` 取反（本文件没用到，遇到即忽略该行）、
//   目录结尾 `/`、`*` 与 `**` 通配。不支持 `[]` 字符组（本文件也没用到）。
function globToRe(pat) {
  let s = ''
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i]
    if (c === '*') {
      if (pat[i + 1] === '*') { // `**` 跨目录；吞掉紧随的 `/`，让 `a/**/b` 也能匹配 `a/b`
        i++
        if (pat[i + 1] === '/') i++
        s += '(?:.*/)?'
      } else s += '[^/]*'
    } else if (c === '?') s += '[^/]'
    else if ('.+^${}()|[]\\'.includes(c)) s += '\\' + c
    else s += c
  }
  return s
}
function loadIgnoreMatchers() {
  const out = []
  let raw
  try { raw = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8') } catch { return out }
  for (let line of raw.split('\n')) {
    line = line.trim()
    if (!line || line.startsWith('#') || line.startsWith('!')) continue
    const pat = line.replace(/\/+$/, '')
    // 无斜杠的规则匹配任意层级（gitignore 语义）；有斜杠的锚定在仓库根。
    const anchored = pat.includes('/')
    out.push(new RegExp((anchored ? '^' : '(?:^|/)') + globToRe(pat) + '(?:/|$)'))
  }
  return out
}
const IGNORE = loadIgnoreMatchers()
const isIgnored = (rel) => IGNORE.some((re) => re.test(rel))

function walk(dir, out) {
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    const rel = path.relative(ROOT, p).split(path.sep).join('/')
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !isIgnored(rel)) walk(p, out) }
    else if (e.isFile() && !SKIP_EXT.test(e.name) && !isIgnored(rel)) out.push(p)
  }
  return out
}

function scanFile(file) {
  let text
  try {
    const st = fs.statSync(file)
    if (st.size > MAX_BYTES) return []
    text = fs.readFileSync(file, 'utf8')
  } catch { return [] }
  const hits = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    for (const [name, re] of SECRET_RES) {
      if (re.test(lines[i])) hits.push({ file, line: i + 1, name })
    }
  }
  return hits
}

function stagedFiles() {
  try {
    const out = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACM'], { cwd: ROOT, encoding: 'utf8' })
    return out.split('\n').map((s) => s.trim()).filter(Boolean).map((f) => path.join(ROOT, f))
  } catch {
    console.error('[!] 不是 git 仓库或 git 不可用，--staged 无意义')
    process.exit(0)
  }
}

let files
const args = process.argv.slice(2)
if (args.includes('--staged')) files = stagedFiles()
else if (args.length) files = args.map((f) => path.resolve(f))
else files = walk(ROOT, [])

let hits = []
for (const f of files) hits = hits.concat(scanFile(f))

if (!hits.length) {
  console.log(`[✓] 密钥扫描通过（${files.length} 个文件，0 命中）`)
  process.exit(0)
}
console.error(`[✗] 发现 ${hits.length} 处密钥特征 —— 请立刻处理，不要提交：\n`)
for (const h of hits) console.error(`    ${path.relative(ROOT, h.file)}:${h.line}  命中「${h.name}」`)
console.error('\n提示：config.json 及各类 *.prev / logs/ 都应在 .gitignore 里。若确为测试夹具，')
console.error('      请改用明显假值（如 gsk_TEST_ONLY_0000），让特征表不命中。')
process.exit(1)
