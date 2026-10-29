#!/usr/bin/env node
'use strict'
/*
 * sync-skill-dist.cjs —— 把项目**当前**源码同步进技能包。
 *
 * 为什么要有这个脚本：
 *   技能包的 `assets/gateway/` 是"给别人部署用"的完整源码，原来靠**手工拷贝**维护 ——
 *   实测已经落后两个版本，而 SKILL.md 里却写着新功能，**描述与产物不一致**，比不同步更糟。
 *   这和"要人工补录才会动的列表 = 死列表"是同一个病。
 *
 * 同步什么：
 *   ① 网关运行所需的最小集（server.mjs / dashboard.html / 白名单 / 启动脚本 / logo）
 *   ② package.json（**只取白名单字段**，版本号跟着项目走，不手抄）
 *   ③ 开发侧测试台（`--with-tests` 才带，默认不带：18MB，且部署者用不上）
 *
 * 出包前自检：密钥 + 个人信息，命中即整体拒绝，不写任何一个文件。
 * 去敏改写只作用于技能包副本，不动项目源文件。
 *
 * 用法：
 *   node scripts/sync-skill-dist.cjs            同步（默认不带测试台）
 *   node scripts/sync-skill-dist.cjs --check    只自检与列清单，不写盘
 *   node scripts/sync-skill-dist.cjs --with-tests  连测试台一起同步
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { SECRET_RES, PERSONAL_RES, SANITIZE } = require('./publish-rules.cjs')

const ROOT = path.join(__dirname, '..')
const SKILL = path.join(os.homedir(), '.workbuddy-ai', 'skills', 'xiaoji-free-model-gateway')
const GATEWAY_DST = path.join(SKILL, 'assets', 'gateway')

const CHECK_ONLY = process.argv.includes('--check')
const WITH_TESTS = process.argv.includes('--with-tests')

// 要同步的 [源, 技能包内相对路径]；源以 `/` 结尾表示整目录递归
const TARGETS = [
  ['server.mjs', 'assets/gateway/server.mjs'],
  ['dashboard.html', 'assets/gateway/dashboard.html'],
  ['xiaoji-launcher.vbs', 'assets/gateway/xiaoji-launcher.vbs'],
  ['小鸡开关.bat', 'assets/gateway/小鸡开关.bat'],
  ['free_whitelist.json', 'assets/gateway/free_whitelist.json'],
  ['config.example.json', 'assets/gateway/config.example.json'],
  // 自启脚本必须跟着走：它是**部署侧**的功能，缺了它技能包里就会写"支持开机自启"却没有那个文件。
  // 落点是 assets/gateway/scripts/，而脚本用 `path.dirname(__dirname)` 找根 —— 正好指回 assets/gateway。
  ['scripts/autostart.cjs', 'assets/gateway/scripts/autostart.cjs'],
  ['assets/logos/', 'assets/gateway/assets/logos/'],
]

// 文本类才做改写（JSON 数据与图片只做自检，不动内容）
const TEXT_EXT = /\.(mjs|html|md|cjs|bat|vbs|txt|json)$/i

// package.json 只带这些键 —— 上游那份含 private/test 脚本，对部署者没意义
const PKG_KEYS = ['name', 'version', 'description', 'type', 'license', 'engines', 'main']

// ═══════════════ 路径自适应（只对测试脚本）═══════════════
// 测试脚本用**自适应**方式定位项目根：从父目录逐级上找含 server.mjs 的目录。
// ⚠ 必须从 `path.dirname(__dirname)` 起步，不能从 __dirname 起步 ——
//    protocol-test 会把 server.mjs 拷进自己目录，从 __dirname 起步会在第二次运行时认错根目录。
const ROOT_AUTO =
  "(() => { const _fs = require('fs'), _p = require('path'); " +
  "let d = _p.dirname(__dirname); for (let i = 0; i < 6; i++) { " +
  "if (_fs.existsSync(_p.join(d, 'server.mjs'))) return d; d = _p.dirname(d) } " +
  "return _p.join(__dirname, '..') })()"

const PATH_FIX = [
  [/const ROOT = path\.join\(__dirname, '\.\.', '\.\.'\)/g, `const ROOT = ${ROOT_AUTO}`],
  [/const ROOT = path\.resolve\(__dirname, '\.\.\/\.\.'\)/g, `const ROOT = ${ROOT_AUTO}`],
  [/const SRC = path\.join\(DIR, '\.\.', '\.\.'\)[^\n]*/g, `const SRC = ${ROOT_AUTO}`],
  [/path\.join\(__dirname, '\.\.', '\.\.', 'config\.json'\)/g, `path.join(${ROOT_AUTO}, 'config.json')`],
  [/path\.join\(__dirname, '\.\.', '\.\.', 'free_catalog\.json'\)[^\n]*/g, `path.join(__dirname, '..', 'free_catalog.json')`],
  [/path\.join\(ROOT, '\.workbuddy-ai\/testinst\/layout-check\.cjs'\)/g, `path.join(__dirname, 'layout-check.cjs')`],
  [/path\.join\(HERE, '\.\.', '\.\.', '\.\.', 'server\.mjs'\)/g, `path.join(${ROOT_AUTO}, 'server.mjs')`],
  [/path\.join\(HERE, '\.\.', '\.\.', '\.\.', 'dashboard\.html'\)/g, `path.join(${ROOT_AUTO}, 'dashboard.html')`],
]

const problems = []
const blobs = [] // [相对路径, 内容字符串]

function audit(label, text) {
  for (const [name, re] of SECRET_RES) if (re.test(text)) problems.push(`${label} 命中密钥特征「${name}」`)
  for (const [name, re] of PERSONAL_RES) if (re.test(text)) problems.push(`${label} 命中个人信息特征「${name}」`)
}

function transform(text, isTest) {
  let s = text
  if (isTest) for (const [re, to] of PATH_FIX) s = s.replace(re, to)
  for (const [re, to] of SANITIZE) s = s.replace(re, to)
  return s
}

// ── 收集：文件 ──
function collectFile(src, rel) {
  const from = path.join(ROOT, src)
  if (!fs.existsSync(from)) { problems.push(`缺源文件：${src}`); return }
  const raw = fs.readFileSync(from, 'utf8')
  const s = TEXT_EXT.test(src) ? transform(raw, false) : raw
  audit(src, s)
  blobs.push([rel, s])
}

// ── 收集：目录（递归，跳过日志/截图/备份）──
const DIR_SKIP = /\.(log|pid|tmp|prev)$|^\.DS_Store$/i
function collectDir(src, rel) {
  const base = path.join(ROOT, src)
  if (!fs.existsSync(base)) { problems.push(`缺源目录：${src}`); return }
  for (const e of fs.readdirSync(base, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (DIR_SKIP.test(e.name)) continue
    const child = path.join(base, e.name)
    if (e.isDirectory()) collectDir(`${src}${e.name}/`, `${rel}${e.name}/`)
    else if (e.isFile()) {
      const buf = fs.readFileSync(child)
      if (buf.includes(0)) { blobs.push([`${rel}${e.name}`, buf]); continue } // 二进制原样带
      const s = transform(buf.toString('utf8'), false)
      audit(`${src}${e.name}`, s)
      blobs.push([`${rel}${e.name}`, s])
    }
  }
}

for (const [src, rel] of TARGETS) {
  if (src.endsWith('/')) collectDir(src, rel)
  else collectFile(src, rel)
}

// ── 收集：package.json（只取白名单字段）──
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  const slim = {}
  for (const k of PKG_KEYS) if (pkg[k] !== undefined) slim[k] = pkg[k]
  const text = JSON.stringify(slim, null, 2) + '\n'
  audit('package.json', text)
  blobs.push(['assets/gateway/package.json', text])
} catch (e) {
  problems.push('读不到 package.json：' + e.message)
}

// ── 收集：测试台（可选）──
if (WITH_TESTS) {
  const TEST_SKIP = /\.(json|pid|log|png|prev)$/i
  for (const sub of ['', 'hedge']) {
    const dir = path.join(ROOT, 'test', sub)
    if (!fs.existsSync(dir)) continue
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!e.isFile() || !e.name.endsWith('.cjs') || TEST_SKIP.test(e.name)) continue
      const rel = sub ? `${sub}/${e.name}` : e.name
      const s = transform(fs.readFileSync(path.join(dir, e.name), 'utf8'), true)
      audit(`test/${rel}`, s)
      blobs.push([`assets/gateway/test/${rel}`, s])
    }
  }
}

// ── 收集：技能包内文档（源即产物，只自检不改写）──
for (const rel of ['SKILL.md', 'README.md']) {
  const p = path.join(SKILL, rel)
  if (fs.existsSync(p)) audit(rel, fs.readFileSync(p, 'utf8'))
}
const refDir = path.join(SKILL, 'references')
if (fs.existsSync(refDir)) {
  for (const f of fs.readdirSync(refDir).sort()) {
    if (!f.endsWith('.md') || f.endsWith('.prev')) continue
    audit(`references/${f}`, fs.readFileSync(path.join(refDir, f), 'utf8'))
  }
}
const ownScripts = path.join(SKILL, 'scripts')
if (fs.existsSync(ownScripts)) {
  for (const f of fs.readdirSync(ownScripts).sort()) {
    if (!/\.(cjs|mjs|js)$/.test(f)) continue
    audit(`scripts/${f}`, fs.readFileSync(path.join(ownScripts, f), 'utf8'))
  }
}

if (problems.length) {
  console.error('[x] 自检不通过，未写入任何文件：')
  for (const p of problems) console.error('    · ' + p)
  process.exit(1)
}
console.log(`[✓] 自检通过（待写入 ${blobs.length} 个文件，密钥与个人信息 0 命中）`)

if (CHECK_ONLY) {
  for (const [rel] of blobs) console.log('  ' + rel)
  process.exit(0)
}

// ── 写入 ──
if (!fs.existsSync(GATEWAY_DST)) {
  console.error('✗ 目标目录不存在：' + GATEWAY_DST)
  console.error('  先建好技能包骨架（SKILL.md + assets/gateway/），再跑本脚本。')
  process.exit(1)
}
let bytes = 0
for (const [rel, s] of blobs) {
  const to = path.join(SKILL, rel)
  fs.mkdirSync(path.dirname(to), { recursive: true })
  if (Buffer.isBuffer(s)) { fs.writeFileSync(to, s); bytes += s.length }
  else { fs.writeFileSync(to, s, 'utf8'); bytes += Buffer.byteLength(s) }
  console.log(`✓ ${rel}  ${Buffer.isBuffer(s) ? s.length + ' bytes' : s.length + ' chars'}`)
}
console.log(`同步完成 → ${SKILL}（${blobs.length} 文件，${(bytes / 1024).toFixed(0)} KB）`)
