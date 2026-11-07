#!/usr/bin/env node
/*
 * 免 Key 端点实测转正 · 契约测试
 *
 * 为什么存在：`probeAnonChat` 的返回值直接决定"哪家进 auto 池"（钱袋子路径）。
 * 它过去只存在于 patrolWhitelist 的内部流程里，没有任何测试 —— 一旦判据被改松
 * （例如把 429 也算成"可用"），会静默把被限流的端点当成免费通道放进来。
 *
 * 做法：**从 server.mjs 源码里提取被测函数**，只替换外部依赖（http/https/CFG/readBody），
 * 逻辑一行不改。刻意不复刻实现 —— 复刻出来的断言在源码改动后会继续假通过。
 * 离线可跑：本地起假端点，不碰网络、不碰生产。
 *
 * 用法：node test/anon-check.cjs
 */
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = (() => { const _fs = require('fs'), _p = require('path'); let d = _p.dirname(__dirname); for (let i = 0; i < 6; i++) { if (_fs.existsSync(_p.join(d, 'server.mjs'))) return d; d = _p.dirname(d) } return _p.join(__dirname, '..') })()
const SRC = fs.readFileSync(path.join(ROOT, 'server.mjs'), 'utf8')

let pass = 0
let fail = 0
const t = (name, ok, extra = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}${extra ? '  → ' + extra : ''}`) }
}

// ── 从真实源码提取函数体（按大括号配平扫描）────────────────────────────
function extractFn(src, name) {
  const re = new RegExp('^(?:async )?function ' + name + '\\s*\\(', 'm')
  const m = re.exec(src)
  if (!m) throw new Error(`源码里找不到函数 ${name} —— 它被改名或删除了，本测试已失效`)
  let i = src.indexOf('{', m.index)
  let depth = 0
  let j = i
  for (; j < src.length; j++) {
    const c = src[j]
    if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) break }
  }
  if (depth !== 0) throw new Error(`函数 ${name} 的大括号没有配平，提取失败`)
  return src.slice(m.index, j + 1)
}

const NAMES = ['httpPostText', 'postTextAuto', 'probeAnonChat', 'applyAnonPromotions']
let pieces
try { pieces = NAMES.map((n) => extractFn(SRC, n)).join('\n\n') }
catch (e) { console.error('提取失败:', e.message); process.exit(1) }

// 桩：只替掉外部依赖，被测逻辑保持源码原样
// ⚠ 2026-10-18: probeAnonChat 开始引用模块级常量 ANON_PROBE_TRIES，这里必须同步注入，
//   否则 new Function 执行时报 ReferenceError（"测试自身出错"，不是断言失败，容易被误读）。
//   值从源码里现抽，不写死 —— 源码改上限时测试跟着走。
const ANON_PROBE_TRIES = (() => {
  const m = SRC.match(/const ANON_PROBE_TRIES\s*=\s*(\d+)/)
  if (!m) throw new Error('源码里找不到 ANON_PROBE_TRIES，本测试已失效')
  return Number(m[1])
})()
const harness = `
const http = require('node:http')
const https = require('node:https')
const CFG = { proxy: '' }
const getTunnelAgent = () => undefined
const ANON_PROBE_TRIES = ${ANON_PROBE_TRIES}
const readBody = (res) => new Promise((resolve, reject) => {
  const chunks = []
  res.on('data', (c) => chunks.push(c))
  res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  res.on('error', reject)
})
${pieces}
module.exports = { probeAnonChat, applyAnonPromotions }
`
const mod = { exports: {} }
new Function('module', 'exports', 'require', harness)(mod, mod.exports, require)
const { probeAnonChat, applyAnonPromotions } = mod.exports

// ── 假端点 ──────────────────────────────────────────────────────────────
const listen = (handler) => new Promise((resolve) => {
  const s = http.createServer(handler)
  s.listen(0, '127.0.0.1', () => resolve({ s, base: `http://127.0.0.1:${s.address().port}/v1` }))
})
const okBody = JSON.stringify({ choices: [{ message: { content: 'hi' } }] })

async function main() {
  console.log('\n免 Key 端点实测 · 判定契约\n')

  // ① 匿名真调通 -> 必须判可用
  {
    const { s, base } = await listen((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(okBody)
    })
    const r = await probeAnonChat(base, ['fake-chat-1'])
    t('200 + 非空 content → ok=true（免 Key 真调通）', r.ok === true, JSON.stringify(r))
    t('  且回传试通的模型名', r.model === 'fake-chat-1', JSON.stringify(r))
    s.close()
  }
  // ② 401 -> 不可用（这正是"能匿名列模型但调用要 Key"的那批候选）
  {
    const { s, base } = await listen((req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":"unauthorized"}')
    })
    const r = await probeAnonChat(base, ['fake-chat-1'])
    t('401 → ok=false（能列模型 ≠ 能免 Key 调用）', r.ok === false, JSON.stringify(r))
    s.close()
  }
  // ③ 429 -> 不可用。⚠ 这条最容易被改松：被限流不等于被允许
  {
    const { s, base } = await listen((req, res) => {
      res.writeHead(429, { 'content-type': 'application/json' }); res.end('{"error":"rate limited"}')
    })
    const r = await probeAnonChat(base, ['fake-chat-1'])
    t('429 → ok=false（限流不是"可用"，不能当免费通道放行）', r.ok === false, JSON.stringify(r))
    s.close()
  }
  // ④ 200 但 content 为空 -> 不可用（端点收下了请求却没真跑模型）
  {
    const { s, base } = await listen((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: '' } }] }))
    })
    const r = await probeAnonChat(base, ['fake-chat-1'])
    t('200 但 content 为空 → ok=false', r.ok === false, JSON.stringify(r))
    s.close()
  }
  // ⑤ 200 但不是 JSON（打到官网页面）-> 不可用
  {
    const { s, base } = await listen((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>not an api</html>')
    })
    const r = await probeAnonChat(base, ['fake-chat-1'])
    t('200 但返回 HTML → ok=false（不是 API 端点）', r.ok === false, JSON.stringify(r))
    s.close()
  }
  // ⑥ 逐个试：第一家 401、第二家通 -> 应成功（有些端点只对部分模型开放匿名）
  {
    let n = 0
    const { s, base } = await listen((req, res) => {
      n++
      if (n === 1) { res.writeHead(401); res.end('{}') }
      else { res.writeHead(200, { 'content-type': 'application/json' }); res.end(okBody) }
    })
    const r = await probeAnonChat(base, ['m1', 'm2'])
    t('逐个试到成功为止（m1 失败 → m2 通过）', r.ok === true && r.model === 'm2', JSON.stringify(r))
    s.close()
  }

  console.log('\n免 Key 转正 · 合并规则\n')

  // ⑦ 新转正：进 hosts、出 candidates、计数 +1
  {
    const hosts = {}
    const candidates = { 'a.example': { source: 'A', models: ['x'], provisional: true } }
    const promoted = applyAnonPromotions(hosts, candidates, { 'a.example': { source: 'A', models: ['x', 'y'], anonModel: 'x' } }, '2026-09-30T00:00:00Z')
    t('新转正 → 进正式名单', !!hosts['a.example'] && hosts['a.example'].anon === true, JSON.stringify(hosts))
    t('新转正 → 记下试通模型（供"为什么免费"解释）', hosts['a.example'].anonModel === 'x')
    t('新转正 → 模型取端点真实列出的聊天模型', JSON.stringify(hosts['a.example'].models) === '["x","y"]')
    t('新转正 → 从候选区移除（避免两处重复显示）', candidates['a.example'] === undefined)
    t('新转正 → 计数 +1', promoted === 1, String(promoted))
    t('新转正 → 保持封闭名单语义（openFree 仍为 false）', hosts['a.example'].openFree === false)
  }
  // ⑧ 已在名单里（OVH 这类）：只补标记，**不覆盖模型表**
  {
    const hosts = { 'ovh.example': { source: 'OVH', models: ['keep-me'], openFree: false } }
    const candidates = { 'ovh.example': { source: 'OVH', models: ['dup'] } }
    const promoted = applyAnonPromotions(hosts, candidates, { 'ovh.example': { source: 'OVH', models: ['should-not-overwrite'], anonModel: 'gpt-oss-20b' } }, 'at')
    t('已在名单 → 补 anon 标记', hosts['ovh.example'].anon === true)
    t('已在名单 → 不覆盖上游源维护的模型表', JSON.stringify(hosts['ovh.example'].models) === '["keep-me"]', JSON.stringify(hosts['ovh.example'].models))
    t('已在名单 → 计数不 +1（不是新转正）', promoted === 0, String(promoted))
    t('已在名单 → 同样从候选区移除', candidates['ovh.example'] === undefined)
  }
  // ⑨ 没试通的不该出现在 anonPromote 里（由调用方保证）—— 空表必须零副作用
  {
    const hosts = {}
    const candidates = { 'b.example': {} }
    const promoted = applyAnonPromotions(hosts, candidates, {}, 'at')
    t('空转正表 → 零副作用', Object.keys(hosts).length === 0 && promoted === 0 && !!candidates['b.example'])
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error('测试自身出错:', e); process.exit(1) })
