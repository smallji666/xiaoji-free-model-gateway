#!/usr/bin/env node
'use strict'
/*
 * 一键把本机已安装的 Agent 接到小鸡网关（零依赖）。
 *
 *   node scripts/setup-client.cjs              扫描 + 预演（默认，一个字节都不写）
 *   node scripts/setup-client.cjs --apply      真正写入（写前自动备份）
 *   node scripts/setup-client.cjs --remove     只撤掉我们写过的键，其它配置原样保留
 *   node scripts/setup-client.cjs --list       只报告本机检测到哪些客户端
 *
 * 设计边界（对着 FreeLLMAPI / Magpie 的同类能力逐条想过）：
 *   ① **只碰本机真的装了的客户端**。凭空造一份 ~/.claude/settings.json 会把一个没装的
 *      工具"造"出来，还可能挡住它日后的首次初始化 —— Magpie 也是只显示装了的那些。
 *   ② **默认预演**。写别人的配置文件是不可逆动作，先给完整 diff 让人看一眼再 --apply。
 *   ③ **只做加法与覆盖我们自己的键**，绝不删用户原有字段；写前整文件备份成 .bak.<时间戳>。
 *   ④ **凭据尽量不落盘**：Codex 用 env_key 指向环境变量名（由 shell 提供），
 *      只有另外两家客户端的配置格式本身要求字面值才写入。输出一律掩码。
 *   ⑤ **零依赖、单文件、不碰 server.mjs**。加客户端只改下面的 CLIENTS 表。
 *
 * ⚠ 路径一律用 path.dirname(__dirname) 起找项目根（测试沙箱会把脚本复制进别处）。
 */
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const ROOT = path.dirname(__dirname)
const args = process.argv.slice(2)
const has = (f) => args.includes(f)
const val = (f, dflt) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : dflt }
const HOME = val('--home', process.env.XIAOJI_HOME || os.homedir())
const APPLY = has('--apply')
const REMOVE = has('--remove')
const LIST = has('--list')
const SHOW_KEY = has('--show-key')

function gatewayInfo() {
  let cfg = {}
  try { cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')) } catch {}
  const port = Number(cfg.port) || 8787
  return {
    port,
    base: val('--url', `http://127.0.0.1:${port}`),
    key: val('--key', cfg.gatewayKey || ''),
  }
}
const mask = (s) => !s ? '(未配置)' : s.length <= 8 ? '****' : s.slice(0, 6) + '…' + s.slice(-4)

// ── 客户端表 ────────────────────────────────────────────────────────────
// 每个客户端: exists() 判"装没装", read()/write() 管配置, plan() 返回要写的键值。
// 只收录能确定配置格式的；拿不准的一律不写文件，只在末尾给通用 base_url 提示。
const CLIENTS = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    dir: () => path.join(HOME, '.claude'),
    file: () => path.join(HOME, '.claude', 'settings.json'),
    kind: 'json',
    keys: (g) => ({ ANTHROPIC_BASE_URL: g.base, ANTHROPIC_AUTH_TOKEN: g.key }),
    note: 'Anthropic 协议走网关 /v1/messages；BASE_URL 填根地址，客户端自己拼 /v1/messages',
  },
  {
    id: 'gemini-cli',
    name: 'Gemini CLI',
    dir: () => path.join(HOME, '.gemini'),
    file: () => path.join(HOME, '.gemini', 'settings.json'),
    kind: 'json',
    keys: (g) => ({ GOOGLE_GEMINI_BASE_URL: g.base, GEMINI_API_KEY: g.key }),
    note: 'Gemini 协议走网关 /v1beta；若你的版本用 GOOGLE_API_KEY，按输出的键名自行改名',
  },
  {
    id: 'codex',
    name: 'Codex CLI',
    dir: () => path.join(HOME, '.codex'),
    file: () => path.join(HOME, '.codex', 'config.toml'),
    kind: 'toml',
    keys: (g) => ({ base_url: `${g.base}/v1`, env_key: 'XIAOJI_GATEWAY_KEY' }),
    note: '走网关 /v1/responses；Key 不写进文件，请先设环境变量 XIAOJI_GATEWAY_KEY',
  },
]

const OWN_PREFIX = '# >>> xiaoji-gateway'
const OWN_SUFFIX = '# <<< xiaoji-gateway'

function readJson(file) {
  if (!fs.existsSync(file)) return {}
  try { const v = JSON.parse(fs.readFileSync(file, 'utf8')); return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {} }
  catch (e) { throw new Error(`配置文件不是合法 JSON，拒绝改动: ${file} (${e.message})`) }
}
function writeJson(file, obj) { fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf8') }

function planJson(c, g) {
  const file = c.file()
  const before = readJson(file)
  const after = JSON.parse(JSON.stringify(before))
  const env = (after.env && typeof after.env === 'object' && !Array.isArray(after.env)) ? after.env : {}
  after.env = env
  const changes = []
  for (const [k, v] of Object.entries(c.keys(g))) {
    if (REMOVE) {
      if (k in env) { changes.push([k, env[k], '(删除)']); delete env[k] }
    } else if (!v) {
      changes.push([k, env[k] || '(空)', '(跳过：网关 Key 未配置)'])
    } else if (env[k] !== v) {
      changes.push([k, env[k] === undefined ? '(空)' : mask(String(env[k])), mask(String(v))]); env[k] = v
    }
  }
  if (REMOVE && Object.keys(env).length === 0 && !(before.env && Object.keys(before.env).length)) delete after.env
  return { file, before, after, changes }
}

// TOML 不做完整解析（零依赖），只维护一个由标记包起来的**我们自己的块**。
// 这样用户原有的任何 TOML 结构都一个字节不动，重复 --apply 也只是替换同一块。
function planToml(c, g) {
  const file = c.file()
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  const kv = c.keys(g)
  const block = [
    OWN_PREFIX,
    'model_provider = "xiaoji"',
    'model = "auto"',
    '',
    '[model_providers.xiaoji]',
    'name = "XiaoJi Free Model"',
    `base_url = "${kv.base_url}"`,
    `env_key = "${kv.env_key}"`,
    'wire_api = "responses"',
    OWN_SUFFIX,
  ].join('\n')
  const re = new RegExp(OWN_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\s\\S]*?' + OWN_SUFFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const had = re.test(before)
  let after
  if (REMOVE) after = before.replace(re, '').replace(/\n{3,}/g, '\n\n').trimEnd() + (before.trim() ? '\n' : '')
  else if (had) after = before.replace(re, block)
  else after = (before.trimEnd() + (before.trim() ? '\n\n' : '') + block + '\n')
  const changes = REMOVE
    ? (had ? [['[model_providers.xiaoji]', '(存在)', '(删除整块)']] : [])
    : had ? [['[model_providers.xiaoji]', '(已存在)', '(原样替换，不重复追加)']]
      : [['[model_providers.xiaoji]', '(空)', `${kv.base_url} · env_key=${kv.env_key}`]]
  return { file, before, after, changes }
}

function backup(file, stamp) {
  const dst = `${file}.bak.${stamp}`
  fs.writeFileSync(dst, fs.readFileSync(file))
  return dst
}

function main() {
  const g = gatewayInfo()
  if (!g.key && !REMOVE) {
    console.log('⚠ 没读到 config.json 里的 gatewayKey —— 涉及 Key 的条目会被跳过。')
    console.log('  可先启动一次网关生成配置，或用 --key <值> 显式指定。\n')
  }
  const detected = CLIENTS.filter((c) => fs.existsSync(c.dir()))
  console.log(`网关: ${g.base}   Key: ${SHOW_KEY ? (g.key || '(未配置)') : mask(g.key)}`)
  console.log(`模式: ${LIST ? '仅列出' : REMOVE ? '移除' : APPLY ? '写入(自动备份)' : '预演(不写盘)'}`)
  console.log(`本机检测到 ${detected.length} 个客户端: ${detected.length ? detected.map((c) => c.name).join(' / ') : '(无)'}\n`)
  if (!detected.length) {
    console.log('没有检测到 ~/.claude / ~/.gemini / ~/.codex，未创建任何目录或文件。')
    console.log('通用接法（任何支持 base_url 的客户端）:')
    console.log(`  Base URL : ${g.base}/v1      Model: auto      Key: ${mask(g.key)}`)
    return
  }
  if (LIST) { for (const c of detected) console.log(`  ${c.name.padEnd(12)} ${c.file()} ${fs.existsSync(c.file()) ? '' : '(配置文件尚不存在，将新建)'}`); return }

  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  let touched = 0
  for (const c of detected) {
    let p
    try { p = c.kind === 'json' ? planJson(c, g) : planToml(c, g) }
    catch (e) { console.log(`✗ ${c.name}: ${e.message}`); continue }
    console.log(`── ${c.name}  ${p.file}`)
    if (!p.changes.length) { console.log('   已是目标状态，无需改动\n'); continue }
    for (const [k, from, to] of p.changes) console.log(`   ${k}: ${from}  →  ${to}`)
    if (p.before === p.after || (typeof p.before === 'object' && JSON.stringify(p.before) === JSON.stringify(p.after))) {
      console.log('   (内容无变化)\n'); continue
    }
    if (APPLY || REMOVE) {
      const existed = fs.existsSync(p.file)
      const bak = existed ? backup(p.file, stamp) : null
      if (c.kind === 'json') writeJson(p.file, p.after)
      else fs.writeFileSync(p.file, p.after, 'utf8')
      console.log(`   ✓ 已写入${bak ? `（备份 ${path.basename(bak)}）` : '（新建）'}`)
      touched++
    } else {
      console.log('   (预演，未写盘)')
    }
    console.log(`   说明: ${c.note}\n`)
  }
  if (!APPLY && !REMOVE) console.log('确认无误后加 --apply 写入；写前会为每个文件生成 .bak.<时间戳> 备份。')
  else console.log(`完成，改动 ${touched} 个文件。撤销: node scripts/setup-client.cjs --remove`)
  console.log('\n通用接法（其余任何支持 base_url 的客户端）:')
  console.log(`  Base URL : ${g.base}/v1      Model: auto      Key: ${mask(g.key)}`)
}

try { main() } catch (e) { console.error('失败: ' + (e && e.stack ? e.stack : e)); process.exit(1) }

module.exports = { CLIENTS, planJson, planToml, gatewayInfo, mask, OWN_PREFIX, OWN_SUFFIX }
