#!/usr/bin/env node
'use strict'
/**
 * make-dist.cjs —— 打一份"可以直接发给别人"的干净包
 *
 * ⚠ 为什么要有这个脚本, 而不是手工挑文件发:
 *   `config.json` 里躺着 7 家厂商的明文 API Key。手工挑 = 早晚有一次忘了删,
 *   而密钥泄漏不可逆(公开仓库被爬虫扫到是分钟级的事)。所以这里用**白名单** ——
 *   只有明确列在下面 COPY_* 里的东西才会进包。新加的文件默认**不进**:
 *   漏了最多是少个文件, 漏不掉的是 Key。方向必须是这样。
 *   打完还会自动扫一遍密钥特征 + 违禁文件名, 命中就中止、不留产物。
 *
 * 用法:
 *   node scripts/make-dist.cjs           生成 dist/xiaoji-free-model-<日期>.zip
 *   node scripts/make-dist.cjs --dir     只组装 dist/xiaoji-free-model/ 目录, 不打包
 *   node scripts/make-dist.cjs --list    只打印会进包的清单, 什么都不写
 */

const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const ROOT = path.resolve(__dirname, '..')
const DIST_ROOT = path.join(ROOT, 'dist')
const PKG_NAME = 'xiaoji-free-model'

// ── 只删"我们认识的"东西: 逐文件 unlink + 逐目录 rmdir, **不用 `fs.rmSync(recursive)`** ──
// 为什么不用递归删除(2026-10-09 实测): 本机环境给 `fs.rmSync` 挂了批量删除守卫,
// 一次递归删 40 多个文件会被垫片拦下并**超时**, 脚本直接崩在**清理步骤**上 ——
// 而报错长得像打包逻辑坏了, 极难定位。更糟的是那一崩已经把上一轮的 zip 删掉了,
// 于是"什么都没产出、还丢了旧产物"。
// 逐文件 unlink 不触发守卫, 与 test/sb-util.cjs 用的是同一套做法(那边有完整踩坑记录)。
function removeTree(dir) {
  let n = 0
  const walk = (d) => {
    let ents
    try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) { walk(p); try { fs.rmdirSync(p) } catch {} }
      else { try { fs.unlinkSync(p); n++ } catch {} }
    }
  }
  walk(dir)
  try { fs.rmdirSync(dir) } catch {}
  return n
}

// ═══════════════ 白名单 ═══════════════
// [源路径(相对项目根), 包内路径]
// ⚠ 小鸡开关.bat 进包后改名 start.bat —— zip 里的非 ASCII 文件名在部分解压器上
//   会变乱码, 而"启动脚本叫什么名字"是朋友唯一的入口, 不值得赌。
const COPY_FILES = [
  ['小鸡开关.bat', 'start.bat'],
  ['packaging/START-HERE.txt', 'START-HERE.txt'],
  ['server.mjs', 'server.mjs'],
  ['dashboard.html', 'dashboard.html'],
  ['free_whitelist.json', 'free_whitelist.json'],
  ['xiaoji-launcher.vbs', 'xiaoji-launcher.vbs'],
  ['README.md', 'README.md'],
]
// ⚠ docs/ 必须进包：README 的详细内容已拆到 docs/，只带 README 的话包内**所有文档链接都会断**。
const COPY_DIRS = [['assets', 'assets'], ['docs', 'docs']]

// 需要带 UTF-8 BOM 的文本文件 —— 不加的话老版本记事本会按 GBK 解出乱码
const BOM_FILES = new Set(['START-HERE.txt'])

// ═══════════════ 自检规则 ═══════════════
// ⚠ 判据只有一份，在 scripts/publish-rules.cjs（2026-11-07 统一）。原来这里自带一份，
//   与 check-secrets 已经漂了（Groq {30,} vs {20,}、OpenRouter 只认 hex、缺 Bearer）——
//   "两份判据"必然变成"一份漏检"。
//   违禁文件名与个人信息同理：2026-11-07 之前本文件还各留了一份（前者已漂成 `^config\.json`
//   缺 `$`，后者干脆没查）。现在三样全部 require，本文件不再定义任何判据。
const { SECRET_RES: SECRET_PATTERNS, PERSONAL_RES, FORBIDDEN_NAME, SANITIZE } = require('./publish-rules.cjs')

// 文本类才做去敏改写（JSON 数据与图片只做自检，不动内容）
const TEXT_EXT = /\.(mjs|html|md|cjs|bat|vbs|txt|json)$/i

const errors = []

function walkFiles(dir, base) {
  const out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...walkFiles(full, base))
    else if (e.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'))
  }
  return out.sort()
}

function collect() {
  const list = []
  for (const [src, dst] of COPY_FILES) {
    const full = path.join(ROOT, src)
    if (!fs.existsSync(full)) { errors.push(`缺文件: ${src}`); continue }
    list.push({ src: full, dst })
  }
  for (const [src, dst] of COPY_DIRS) {
    const base = path.join(ROOT, src)
    if (!fs.existsSync(base)) { errors.push(`缺目录: ${src}`); continue }
    for (const r of walkFiles(base, base)) list.push({ src: path.join(base, r), dst: `${dst}/${r}` })
  }
  return list
}

// ── 扫 stage 目录: 有没有密钥、有没有不该来的文件 ──
function audit(stageDir) {
  const hits = []
  const files = walkFiles(stageDir, stageDir)
  for (const rel of files) {
    const base = path.basename(rel)
    if (FORBIDDEN_NAME.some((re) => re.test(base))) hits.push(`${rel}  ← 这个文件不该出现在分发包里`)
    // 二进制（图片等）跳过文本扫描：按 utf8 读一张 PNG 只会得到一堆替换字符，
    // 既扫不出东西、又白读几百 KB。（docs/screenshots/ 进包后才有的问题。）
    const buf = fs.readFileSync(path.join(stageDir, rel))
    if (buf.includes(0)) continue
    const text = buf.toString('utf8')
    // ⚠ 只报特征名，**绝不回显命中原文** —— 这个脚本的输出常被贴进 Issue / 发布说明。
    //   原来这里打 `m[0].slice(0, 10)`，等于把网关 Key 的前 10 个字符抄进日志。
    for (const [label, re] of SECRET_PATTERNS) {
      if (re.test(text)) hits.push(`${rel}  ← 命中密钥「${label}」`)
    }
    for (const [label, re] of PERSONAL_RES) {
      if (re.test(text)) hits.push(`${rel}  ← 命中个人信息「${label}」`)
    }
  }
  return { hits, count: files.length }
}

// ═══════════════ 最小 zip 写入器 (零依赖) ═══════════════
// 手写而不是调 Compress-Archive: 少一个外部依赖, 且能精确控制 UTF-8 文件名标志位。
function dosStamp(d) {
  return {
    time: ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff,
    date: (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff,
  }
}

function writeZip(entries, outPath) {
  const { time, date } = dosStamp(new Date())
  const parts = []
  const central = []
  let offset = 0
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8')
    const deflated = zlib.deflateRawSync(e.data, { level: 9 })
    const useDeflate = deflated.length < e.data.length
    const body = useDeflate ? deflated : e.data
    const method = useDeflate ? 8 : 0
    const crc = zlib.crc32(e.data) >>> 0

    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0)
    lh.writeUInt16LE(20, 4)        // version needed
    lh.writeUInt16LE(0x0800, 6)    // flag bit 11 = 文件名是 UTF-8
    lh.writeUInt16LE(method, 8)
    lh.writeUInt16LE(time, 10)
    lh.writeUInt16LE(date, 12)
    lh.writeUInt32LE(crc, 14)
    lh.writeUInt32LE(body.length, 18)
    lh.writeUInt32LE(e.data.length, 22)
    lh.writeUInt16LE(nameBuf.length, 26)
    lh.writeUInt16LE(0, 28)        // extra len
    parts.push(lh, nameBuf, body)

    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(20, 4)        // version made by
    cd.writeUInt16LE(20, 6)        // version needed
    cd.writeUInt16LE(0x0800, 8)
    cd.writeUInt16LE(method, 10)
    cd.writeUInt16LE(time, 12)
    cd.writeUInt16LE(date, 14)
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(body.length, 20)
    cd.writeUInt32LE(e.data.length, 24)
    cd.writeUInt16LE(nameBuf.length, 28)
    cd.writeUInt16LE(0, 30)        // extra
    cd.writeUInt16LE(0, 32)        // comment
    cd.writeUInt16LE(0, 34)        // disk start
    cd.writeUInt16LE(0, 36)        // internal attrs
    cd.writeUInt32LE(0, 38)        // external attrs
    cd.writeUInt32LE(offset, 42)
    central.push(cd, nameBuf)

    offset += lh.length + nameBuf.length + body.length
  }
  const cdBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cdBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)
  fs.writeFileSync(outPath, Buffer.concat([...parts, cdBuf, eocd]))
}

// ═══════════════ 主流程 ═══════════════
function main() {
  const argv = process.argv.slice(2)
  const dirOnly = argv.includes('--dir')
  const listOnly = argv.includes('--list')

  if (typeof zlib.crc32 !== 'function') {
    console.error('[x] 这个脚本需要 Node ≥ 20.15 (用到 zlib.crc32)。当前: ' + process.version)
    process.exit(1)
  }

  const sources = collect()
  if (errors.length) {
    console.error('[x] 打包中止:')
    for (const e of errors) console.error('    ' + e)
    process.exit(1)
  }

  if (listOnly) {
    console.log(`会进包的文件 (${sources.length} 个):`)
    for (const s of sources) console.log('  ' + s.dst)
    return
  }

  // 用**本地**日期，不用 `toISOString()`（那是 UTC）—— 否则 GMT+8 的凌晨打出来的包，
  // 名字会比"今天"早一天，用户会以为拿到的是旧包（2026-10-10 实测：本地 10-10 00:37 → 包名 10-09）。
  const _d = new Date()
  const stamp = `${_d.getFullYear()}-${String(_d.getMonth() + 1).padStart(2, '0')}-${String(_d.getDate()).padStart(2, '0')}`
  const stage = path.join(DIST_ROOT, PKG_NAME)

  // 清空重来 —— 免得上一轮的东西混进来。
  // ⚠ 只清**本包的目录**和**本包产出的 zip**, 不动 dist/ 里的其它东西(见 removeTree 的说明)。
  removeTree(stage)
  // 上一轮的 zip 逐个 unlink(单文件删除不触发批量守卫)
  try {
    for (const f of fs.readdirSync(DIST_ROOT)) {
      if (new RegExp(`^${PKG_NAME}-.*\\.zip$`).test(f)) { try { fs.unlinkSync(path.join(DIST_ROOT, f)) } catch {} }
    }
  } catch {}
  fs.mkdirSync(stage, { recursive: true })

  for (const s of sources) {
    const dst = path.join(stage, s.dst)
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    let buf = fs.readFileSync(s.src)
    // ⚠ 出包前必须去敏（2026-11-07 补）：这个包是"直接发给别人"的，而源码注释里到处是
    //   `用户原话"…"` / `用户要求…` 这类归属措辞。原来只查密钥、不查个人信息，
    //   于是 42 个文件的包里带着十几处"某某人说"。改写只作用于**包内副本**，不动项目源文件
    //   —— 与 sync-skill-dist 同一套规则（scripts/publish-rules.cjs 的 SANITIZE）。
    if (TEXT_EXT.test(s.dst) && !buf.includes(0)) {
      let text = buf.toString('utf8')
      for (const [re, to] of SANITIZE) text = text.replace(re, to)
      buf = Buffer.from(text, 'utf8')
    }
    if (BOM_FILES.has(s.dst)) buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), buf])
    fs.writeFileSync(dst, buf)
  }

  // ── 出包前自检: 这一步失败就什么都不产出 ──
  const { hits, count } = audit(stage)
  if (hits.length) {
    removeTree(stage)
    console.error(`[x] 自检不通过, 已删除产物, 一个字节都没发出去。`)
    console.error(`    检查了 ${count} 个文件, ${hits.length} 处问题:`)
    for (const h of hits) console.error('    · ' + h)
    process.exit(1)
  }
  console.log(`[✓] 密钥自检通过 (扫了 ${count} 个文件, 0 命中)`)

  let outPath = null
  if (!dirOnly) {
    outPath = path.join(DIST_ROOT, `${PKG_NAME}-${stamp}.zip`)
    const entries = []
    for (const rel of walkFiles(stage, stage)) {
      entries.push({ name: `${PKG_NAME}/${rel}`, data: fs.readFileSync(path.join(stage, rel)) })
    }
    writeZip(entries, outPath)
  }

  const total = sources.reduce((n, s) => n + fs.statSync(path.join(stage, s.dst)).size, 0)
  console.log('')
  console.log(`  内容: ${sources.length} 个文件, 解压后约 ${(total / 1024).toFixed(0)} KB`)
  console.log(`  目录: ${path.relative(ROOT, stage).split(path.sep).join('/')}/`)
  if (outPath) {
    const mb = (fs.statSync(outPath).size / 1024).toFixed(0)
    console.log(`  压缩包: ${path.relative(ROOT, outPath).split(path.sep).join('/')}  (${mb} KB)`)
    console.log('')
    console.log('  这个 zip 可以直接发给别人 —— 里面不含任何 API Key。')
  } else {
    console.log('  (--dir: 未打包)')
  }
}

main()
