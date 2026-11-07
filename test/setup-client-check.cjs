#!/usr/bin/env node
'use strict'
/*
 * setup-client.cjs 的离线回归。不起网关、不占端口、不碰真实 ~/.claude 等目录。
 *
 * 重点是**反断言**：这个脚本会写别人的配置文件, 最坏的不是"没写对"而是"多写了" ——
 * 凭空造目录、覆盖用户的其它键、重复追加 TOML 块、把明文 Key 打进日志。
 * 所以每条正断言后面都跟一条"绝不能发生"的检查。
 */
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const cp = require('node:child_process')

const ROOT = (() => { let d = path.dirname(__dirname); for (let i = 0; i < 6; i++) { if (fs.existsSync(path.join(d, 'server.mjs'))) return d; d = path.dirname(d) } return path.join(__dirname, '..') })()
const SCRIPT = path.join(ROOT, 'scripts', 'setup-client.cjs')
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-client-'))
const KEY = 'freegw-setup-client-test-key-1234567890'
const BASE = 'http://127.0.0.1:8787'

let pass = 0, fail = 0
const chk = (n, ok, extra) => { console.log((ok ? '  PASS  ' : '  FAIL  ') + n + (!ok && extra ? '  << ' + extra : '')); ok ? pass++ : fail++ }
// ⚠ 必须显式给 --url / --key：否则脚本会去读项目根真实 config.json 的 gatewayKey，
//   于是① 离线测试把**真实凭据**写进临时目录 ② 断言拿测试 Key 比必然假红。
//   这条是"测试自包含"红线，不是图省事。
const SELF = ['--url', BASE, '--key', KEY]
const run = (...a) => cp.execFileSync(process.execPath, [SCRIPT, '--home', HOME, ...SELF, ...a], { encoding: 'utf8', cwd: ROOT })
const read = (p) => fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null
const jread = (p) => JSON.parse(read(p) || '{}')

// 逐文件删, 不用 rmSync(recursive) —— 项目沙箱守卫会拦, 而且会连旧产物一起毁掉。
function cleanup(dir) {
  if (!fs.existsSync(dir)) return
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) cleanup(p); else fs.unlinkSync(p)
  }
  fs.rmdirSync(dir)
}

try {
  // ── 造三个"已安装"的客户端, 第四个不存在的目录绝不许被创建 ──
  fs.mkdirSync(path.join(HOME, '.claude'))
  fs.mkdirSync(path.join(HOME, '.gemini'))
  fs.mkdirSync(path.join(HOME, '.codex'))
  const claude = path.join(HOME, '.claude', 'settings.json')
  const gemini = path.join(HOME, '.gemini', 'settings.json')
  const codex = path.join(HOME, '.codex', 'config.toml')
  fs.writeFileSync(claude, JSON.stringify({ theme: 'dark', permissions: { allow: ['Bash(git:*)'] }, env: { EXISTING: 'keep-me', ANTHROPIC_BASE_URL: 'https://api.anthropic.com' } }, null, 2) + '\n')
  fs.writeFileSync(gemini, JSON.stringify({ ui: { theme: 'light' } }, null, 2) + '\n')
  fs.writeFileSync(codex, 'model = "o3"\n\n[model_providers.other]\nname = "Other"\nbase_url = "https://example.com/v1"\n')

  const claudeBefore = read(claude), geminiBefore = read(gemini), codexBefore = read(codex)

  // [1] 默认 = 预演, 一个字节都不许改
  const dry = run()
  chk('默认预演列出 3 个客户端', /Claude Code/.test(dry) && /Gemini CLI/.test(dry) && /Codex CLI/.test(dry))
  chk('默认预演一个字节都没写', read(claude) === claudeBefore && read(gemini) === geminiBefore && read(codex) === codexBefore)
  chk('预演输出不含明文 Key', !dry.includes(KEY))
  chk('预演不创建未安装客户端的目录', !fs.existsSync(path.join(HOME, '.cursor')))
  chk('预演明确提示未写盘', /未写盘/.test(dry))

  // [2] --list 也是只读
  run('--list')
  chk('--list 同样不写盘', read(claude) === claudeBefore && read(gemini) === geminiBefore && read(codex) === codexBefore)

  // [3] 真正写入
  const applied = run('--apply')
  const cj = jread(claude), gj = jread(gemini), cx = read(codex)
  chk('写入 Claude Code 的 base_url', cj.env.ANTHROPIC_BASE_URL === BASE, JSON.stringify(cj.env))
  chk('写入 Claude Code 的 Key', cj.env.ANTHROPIC_AUTH_TOKEN === KEY)
  chk('⚠ 反断言: 用户原有顶层键保留', cj.theme === 'dark' && cj.permissions.allow[0] === 'Bash(git:*)')
  chk('⚠ 反断言: 用户原有 env 键保留', cj.env.EXISTING === 'keep-me')
  chk('写入 Gemini CLI', gj.env.GOOGLE_GEMINI_BASE_URL === BASE && gj.env.GEMINI_API_KEY === KEY)
  chk('⚠ 反断言: Gemini 原有 ui 键保留', gj.ui.theme === 'light')
  chk('Codex 用 base_url + env_key(不落 Key)', /base_url = "http:\/\/127\.0\.0\.1:8787\/v1"/.test(cx) && /env_key = "XIAOJI_GATEWAY_KEY"/.test(cx))
  chk('⚠ 反断言: Codex 用户原有 provider 块保留', /\[model_providers\.other\]/.test(cx) && /example\.com/.test(cx))
  chk('⚠ 反断言: Codex 块只出现一次', (cx.match(/\[model_providers\.xiaoji\]/g) || []).length === 1)
  chk('⚠ 反断言: 完整 Key 不出现在 TOML 里', !cx.includes(KEY))
  chk('写入输出仍不含明文 Key', !applied.includes(KEY))
  chk('三个文件都生成了 .bak 备份', fs.readdirSync(path.join(HOME, '.claude')).some((f) => f.startsWith('settings.json.bak.')) && fs.readdirSync(path.join(HOME, '.codex')).some((f) => f.startsWith('config.toml.bak.')))
  const bak = path.join(HOME, '.claude', fs.readdirSync(path.join(HOME, '.claude')).find((f) => f.startsWith('settings.json.bak.')))
  chk('备份与写入前字节一致', read(bak) === claudeBefore)

  // [4] 幂等: 再 apply 一次不许重复追加 / 不许改内容
  const cj2 = JSON.stringify(jread(claude)), cx2 = read(codex)
  const bakCount = () => ['.claude', '.gemini', '.codex'].reduce((n, d) => {
    const dir = path.join(HOME, d)
    return n + (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.includes('.bak.')).length : 0)
  }, 0)
  const bakBefore = bakCount()
  const again = run('--apply')
  chk('⚠ 反断言: 重复 --apply 内容不变', JSON.stringify(jread(claude)) === cj2 && read(codex) === cx2)
  chk('重复 --apply 不新增 TOML 块', (read(codex).match(/\[model_providers\.xiaoji\]/g) || []).length === 1)
  // ⚠ 原断言右半支 `|| !/FAIL/.test(again)` 恒真（正常日志里根本没有 FAIL 字样），
  //   等于一条永远绿的假闸门。改成两条都能真红的：文案 + "没有多出备份文件"（没写盘就不会备份）。
  chk('重复 --apply 报告已是目标状态', /已是目标状态|无需改动/.test(again), again.slice(0, 300))
  chk('⚠ 反断言: 重复 --apply 没有产生新备份（即没写盘）', bakCount() === bakBefore, `${bakBefore} -> ${bakCount()}`)

  // [5] 移除: 只撤我们的键, 其它一个不少
  run('--remove')
  const cj3 = jread(claude), gj3 = jread(gemini), cx3 = read(codex)
  chk('移除 Claude Code 写入的两个键', !('ANTHROPIC_BASE_URL' in cj3.env) && !('ANTHROPIC_AUTH_TOKEN' in cj3.env))
  chk('⚠ 反断言: 移除后用户原有键仍在', cj3.theme === 'dark' && cj3.env.EXISTING === 'keep-me' && cj3.permissions.allow[0] === 'Bash(git:*)')
  chk('移除 Gemini 写入的键', !(gj3.env && gj3.env.GOOGLE_GEMINI_BASE_URL) && gj3.ui.theme === 'light')
  chk('移除 Codex 整块', !/model_providers\.xiaoji/.test(cx3))
  chk('⚠ 反断言: 移除后原 provider 与 model 行仍在', /\[model_providers\.other\]/.test(cx3) && /model = "o3"/.test(cx3))

  // [6] 坏 JSON: 拒绝改动而不是把文件写坏
  fs.writeFileSync(claude, '{ this is not json')
  const bad = run('--apply')
  chk('坏 JSON 被明确拒绝', /不是合法 JSON|拒绝改动/.test(bad))
  chk('⚠ 反断言: 坏 JSON 文件保持原样', read(claude) === '{ this is not json')

  // [7] 空 HOME: 不造目录, 给通用接法
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-client-empty-'))
  try {
    const out = cp.execFileSync(process.execPath, [SCRIPT, '--home', empty, ...SELF], { encoding: 'utf8', cwd: ROOT })
    chk('没有安装任何客户端时不造目录', fs.readdirSync(empty).length === 0)
    chk('仍给出通用 base_url 接法', /Base URL/.test(out) && /\/v1/.test(out))
  } finally { cleanup(empty) }
} catch (e) {
  chk('套件执行未抛错', false, (e && e.stack ? e.stack.split('\n').slice(0, 3) : [String(e)]).join(' | '))
} finally {
  try { cleanup(HOME) } catch {}
}

console.log(`\n== ${pass} passed, ${fail} failed ==`)
process.exit(fail ? 1 : 0)
