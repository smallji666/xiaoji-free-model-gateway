#!/usr/bin/env node
/*
 * pack-skill.cjs —— 把技能包打成一个可以直接「上传技能」的 .zip。
 *
 * 背景：WorkBuddy 的技能导入（技能面板 → 添加技能 → 上传技能）接受
 *   **一个文件夹或一个 .zip**，二者都必须包含 `SKILL.md`（可以在根，也可以在子目录里）。
 *   所以这里产出的 zip 根目录是一个 `xiaoji-free-model-gateway/` 文件夹。
 *
 * 出包前做两道自检（**任一命中就中止、不留产物**）：
 *   ① 密钥特征  ② 个人信息特征（本机用户名 / 内部目录名 / 个人化措辞）
 *   再加一条"违禁文件名"白名单外兜底 —— 漏了最多少个文件，漏不掉的是 Key。
 *
 * 用法：
 *   node scripts/pack-skill.cjs          生成 dist/xiaoji-free-model-gateway-skill.zip
 *   node scripts/pack-skill.cjs --list   只打印会进包的清单，什么都不写
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const zlib = require('node:zlib')

const ROOT = path.resolve(__dirname, '..')
const SKILL = path.join(os.homedir(), '.workbuddy-ai', 'skills', 'xiaoji-free-model-gateway')
const PKG = 'xiaoji-free-model-gateway'
const DIST = path.join(ROOT, 'dist')

const LIST_ONLY = process.argv.includes('--list')

// ── 不进包的东西 ──
// ⚠ `*.prev` 是项目约定的备份（loadConfig 损坏时的恢复源），留在本机、不进包。
const SKIP_FILE = /\.(prev|log|pid|tmp)$|^\.DS_Store$/i
const SKIP_DIR = new Set(['shots', 'logs', 'node_modules', '__pycache__'])

// ── 自检规则（与 scripts/sync-skill-dist.cjs 保持同一口径）──
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
const PERSONAL_RES = [
  // 动态取当前机器的用户名：写死某个名字只对一台机器有效，换人/换机就形同虚设
  ['本机用户名', new RegExp(os.userInfo().username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')],
  ['个人化归属措辞', /用户原话|用户明确要求|用户说|用户反馈|用户要求|用户问|起因\(用户\)|按你的要求/],
  ['旧测试目录名', /\.workbuddy-ai[\\/]testinst/],
]
// 兜底：这些文件名出现在包里就是出事了
const FORBIDDEN_NAME = [
  /^config\.json/i, /\.prev$/i, /\.corrupt\./i, /\.import-bak\./i,
  /^gateway\.pid$/i, /^logs?$/i, /^metrics\.json/i, /^usage_log\.json/i,
  /^promo_state\.json/i, /^free_catalog\.json/i, /^server\.log/i,
]

function walk(dir, base, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.isDirectory()) {
      if (SKIP_DIR.has(e.name)) continue
      walk(path.join(dir, e.name), base, out)
    } else if (e.isFile()) {
      if (SKIP_FILE.test(e.name)) continue
      out.push(path.relative(base, path.join(dir, e.name)).split(path.sep).join('/'))
    }
  }
  return out
}

// ═══════════════ 最小 zip 写入器（零依赖，UTF-8 文件名）═══════════════
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
    lh.writeUInt16LE(20, 4)
    lh.writeUInt16LE(0x0800, 6) // flag bit 11 = 文件名是 UTF-8
    lh.writeUInt16LE(method, 8)
    lh.writeUInt16LE(time, 10)
    lh.writeUInt16LE(date, 12)
    lh.writeUInt32LE(crc, 14)
    lh.writeUInt32LE(body.length, 18)
    lh.writeUInt32LE(e.data.length, 22)
    lh.writeUInt16LE(nameBuf.length, 26)
    lh.writeUInt16LE(0, 28)
    parts.push(lh, nameBuf, body)

    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(20, 4)
    cd.writeUInt16LE(20, 6)
    cd.writeUInt16LE(0x0800, 8)
    cd.writeUInt16LE(method, 10)
    cd.writeUInt16LE(time, 12)
    cd.writeUInt16LE(date, 14)
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(body.length, 20)
    cd.writeUInt32LE(e.data.length, 24)
    cd.writeUInt16LE(nameBuf.length, 28)
    cd.writeUInt16LE(0, 30)
    cd.writeUInt16LE(0, 32)
    cd.writeUInt16LE(0, 34)
    cd.writeUInt16LE(0, 36)
    cd.writeUInt32LE(0, 38)
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
  if (typeof zlib.crc32 !== 'function') {
    console.error('[x] 需要 Node ≥ 20.15（用到 zlib.crc32）。当前: ' + process.version)
    process.exit(1)
  }
  if (!fs.existsSync(path.join(SKILL, 'SKILL.md'))) {
    console.error('[x] 技能包不存在或缺 SKILL.md：' + SKILL)
    process.exit(1)
  }

  const files = walk(SKILL, SKILL)
  const problems = []

  // ── 自检 ──
  for (const rel of files) {
    const base = path.basename(rel)
    if (FORBIDDEN_NAME.some((re) => re.test(base))) problems.push(`${rel}  ← 这个文件不该出现在分发包里`)
    const buf = fs.readFileSync(path.join(SKILL, rel))
    // 二进制（图片等）跳过文本扫描
    if (buf.includes(0)) continue
    const text = buf.toString('utf8')
    for (const [name, re] of SECRET_RES) {
      const m = text.match(re)
      if (m) problems.push(`${rel}  ← 命中密钥「${name}」: ${m[0].slice(0, 10)}…`)
    }
    for (const [name, re] of PERSONAL_RES) {
      if (re.test(text)) problems.push(`${rel}  ← 命中个人信息「${name}」`)
    }
  }

  if (!files.includes('SKILL.md')) problems.push('SKILL.md 不在包根 —— WorkBuddy 导入会失败')

  if (problems.length) {
    console.error(`[x] 自检不通过，未产出任何文件。检查了 ${files.length} 个文件：`)
    for (const p of problems) console.error('    · ' + p)
    process.exit(1)
  }
  console.log(`[✓] 自检通过（${files.length} 个文件，密钥与个人信息 0 命中）`)

  if (LIST_ONLY) {
    for (const rel of files) console.log('  ' + rel)
    return
  }

  // ── 打包 ──
  const entries = files.map((rel) => ({
    name: `${PKG}/${rel}`,
    data: fs.readFileSync(path.join(SKILL, rel)),
  }))
  const outPath = path.join(DIST, `${PKG}-skill.zip`)
  fs.rmSync(outPath, { force: true })
  fs.mkdirSync(DIST, { recursive: true })
  writeZip(entries, outPath)

  const total = entries.reduce((n, e) => n + e.data.length, 0)
  console.log('')
  console.log(`  文件: ${entries.length} 个，解压后约 ${(total / 1024).toFixed(0)} KB`)
  console.log(`  技能包: ${path.relative(ROOT, outPath).split(path.sep).join('/')}  (${(fs.statSync(outPath).size / 1024).toFixed(0)} KB)`)
  console.log('')
  console.log('  这个 zip 可以直接在 WorkBuddy「技能 → 添加技能 → 上传技能」里拖入安装，里面不含任何 API Key。')
}

main()
