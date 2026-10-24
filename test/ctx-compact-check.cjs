#!/usr/bin/env node
// ctx-compact-check.cjs —— 上下文降级(compact)的端到端回归
//
// 被测行为: 请求比池里**所有**模型都大时, 网关按实测撞墙规模裁一段历史重发, 而不是报
// "模型不在可用池里"。这条路径最贵的不是"能不能裁", 而是**它会不会裁错** —— 所以本套件的
// 重点在反断言:
//   ① system 消息**绝不能**被删掉(删了模型就不再守指令, 比报错更糟)
//   ② 保留的第一条**绝不能**是 role:"tool"(孤立的 tool 消息在 OpenAI 协议里非法 -> 上游 400)
//   ③ 小请求**一个字节都不该变**(降级只在"全链嫌大"时触发, 不能变成常态路径)
//
// 端口 8819/8820 是专属区间(见 run-all.cjs 的端口分配表)。
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')

const NODE = process.execPath
const HERE = __dirname
const SB = path.join(HERE, 'sb-ctx')
const ROOT = (() => { const _fs = require('fs'), _p = require('path'); let d = _p.dirname(__dirname); for (let i = 0; i < 6; i++) { if (_fs.existsSync(_p.join(d, 'server.mjs'))) return d; d = _p.dirname(d) } return _p.join(__dirname, '..') })()
const GW_PORT = 8819
const UP_PORT = 8820
const GW_KEY = 'freegw-ctx-test-0000000000000000'
const CFG = path.join(SB, 'config.json')
// 与 server.mjs 里的 COMPACT_RATIO 保持一致(0.7)。不写死断言"必须等于", 只用来算期望区间。
const CTX_LIMIT_CHARS = 12000

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
let lastResp = ''
const ok = (c, m, extra) => {
  if (c) { pass++; console.log('  PASS  ' + m) }
  else { fail++; console.log('  FAIL  ' + m + (extra ? '  → ' + extra : '')); if (lastResp) console.log('    ↳ 最近响应: ' + lastResp.replace(/\s+/g, ' ').slice(0, 300)) }
}

// ── 假上游 ──
// 记录**最后一次**收到的 chat body: 断言要看的不是"网关说了什么", 而是"上游到底收到了什么"。
let lastUpBody = null
const up = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    if (req.url.includes('/models')) {
      // 必须回**非空**列表: 空列表会被判成"账号看不到任何模型"(accountIssue), 整家退出候选链
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ object: 'list', data: [{ id: 'tiny-8k', object: 'model' }] }))
    }
    try { lastUpBody = JSON.parse(body) } catch { lastUpBody = null }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      id: 'x', object: 'chat.completion', model: 'tiny-8k',
      choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }))
  })
})

const procs = []
let gwLog = ''
function launch(args, cwd) {
  const p = spawn(NODE, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
  p.stdout.on('data', (d) => { gwLog += d })
  p.stderr.on('data', (d) => { gwLog += d })
  procs.push(p)
  return p
}
function cleanup() { for (const p of procs) { try { p.kill() } catch {} } }
process.on('exit', cleanup)

function writeCfg(c) { fs.writeFileSync(CFG, JSON.stringify(c, null, 2)) }
async function waitFor(fn, ms = 8000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    try { if (await fn()) return true } catch {}
    await sleep(150)
  }
  return false
}
async function chat(payload) {
  const r = await fetch(`http://127.0.0.1:${GW_PORT}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + GW_KEY },
    body: JSON.stringify(payload),
  })
  const text = await r.text()
  lastResp = text
  return { status: r.status, headers: r.headers, text }
}

// ── 构造请求 ──
// chars() 与 server.mjs 的 payloadChars 同口径: 只数 messages 的 content 字符串。
const chars = (p) => p.messages.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : 0), 0)

function bigPayload(turns = 8, per = 1500, model = 'tiny-8k') {
  const messages = [{ role: 'system', content: '你是助手，必须只回 OK。' + 'S'.repeat(500) }]
  for (let i = 0; i < turns; i++) {
    messages.push({ role: 'user', content: `第${i}轮问题：` + 'U'.repeat(per) })
    messages.push({ role: 'assistant', content: `第${i}轮回答：` + 'A'.repeat(per) })
  }
  messages.push({ role: 'user', content: '最后一个问题：请只回 OK' })
  return { model, messages, max_tokens: 32 }
}

async function main() {
  const now = new Date().toISOString()
  fs.mkdirSync(SB, { recursive: true })
  for (const f of ['config.json.prev', 'config.json.tmp', 'gateway.pid', 'usage_log.json', 'metrics.json', 'free_catalog.json', 'promo_state.json']) {
    try { fs.unlinkSync(path.join(SB, f)) } catch {}
  }
  writeCfg({
    port: GW_PORT, proxy: '', gatewayKey: GW_KEY, maxConcurrent: 0,
    providers: [{
      id: 'cx1', name: 'ctxco', label: 'CtxCo', base_url: `http://127.0.0.1:${UP_PORT}/v1`,
      api_key: 'sk-x', keys: ['sk-x'], model: 'tiny-8k', models: ['tiny-8k'],
      needs_proxy: false, enabled: true, ok: 0, err: 0, cooldownUntil: 0, lastError: '', lastSweepAt: now,
      // 实测学到的容量: 这个模型吃过 12000 字符的请求被拒。降级的目标规模 = 12000 * 0.7 = 8400。
      ctxLimit: { 'tiny-8k': { at: now, chars: CTX_LIMIT_CHARS, reason: 'Request too large for model' } },
    }],
  })
  fs.writeFileSync(path.join(SB, '.sandbox'), '')
  fs.writeFileSync(path.join(SB, 'free_whitelist.json'), JSON.stringify({ list_date: now.slice(0, 10), fetched_at: now, sources: { local: now.slice(0, 10) }, hosts: {} }, null, 2))
  fs.copyFileSync(path.join(ROOT, 'server.mjs'), path.join(SB, 'server.mjs'))
  fs.copyFileSync(path.join(ROOT, 'dashboard.html'), path.join(SB, 'dashboard.html'))

  await new Promise((r) => up.listen(UP_PORT, '127.0.0.1', r))
  launch([path.join(SB, 'server.mjs')], SB)
  const ready = await waitFor(async () => (await fetch(`http://127.0.0.1:${GW_PORT}/api/state`)).ok, 30000)
  if (!ready) { console.log('  FAIL  网关未在 30s 内就绪'); console.log(gwLog.slice(-800)); process.exit(1) }
  await sleep(1200)

  // ══ 一、小请求: 降级路径**不能被触发** ══
  // 这是最重要的一条: 改了"全链嫌大"的分支, 最容易顺手把常态路径也改掉。
  console.log('\n【一】小请求不受影响')
  const small = { model: 'tiny-8k', messages: [{ role: 'system', content: '你是助手' }, { role: 'user', content: '你好' }], max_tokens: 16 }
  lastUpBody = null
  const r1 = await chat(small)
  ok(r1.status === 200, `小请求正常返回（HTTP ${r1.status}）`)
  ok(!r1.headers.get('x-xiaoji-compacted'), '小请求**没有** x-xiaoji-compacted 响应头（降级没被误触发）')
  ok(lastUpBody && lastUpBody.messages.length === 2, `上游收到的消息条数不变（${lastUpBody ? lastUpBody.messages.length : '?'} 条）`)
  ok(lastUpBody && lastUpBody.messages[1].content === '你好', '上游收到的是**原封不动**的消息内容')

  // ══ 二、auto + 大请求: 这正是旧版报 404 的那条路径 ══
  // 旧版把"全链嫌大"的候选硬跳过 -> 链空 -> 报"模型 auto 当前不在任何已启用供应商的可用池里"。
  // 实测确认过(2026-10-23, 用 HEAD 那版 server.mjs 跑同一请求): 状态 404、错误码 model_not_found。
  console.log('\n【二】auto + 大请求不再报"模型不在可用池里"')
  const bigAuto = bigPayload(8, 1500, 'auto')
  lastUpBody = null
  const r2a = await chat(bigAuto)
  ok(r2a.status === 200, `auto + 大请求成功（HTTP ${r2a.status}）`)
  ok(!!r2a.headers.get('x-xiaoji-compacted'), 'auto 路径也标出了"裁过历史"')
  ok(!!lastUpBody, 'auto 路径确实把请求发到了上游（不是网关编了个回答）')

  // ══ 三、显式指定模型 + 大请求 ══
  // 旧版**只有 auto 分支**查 modelCtxTooBig, 显式/路由组分支完全不查 —— 学到的 ctxLimit 白学,
  // 每次照样发过去撞 413。这里连同"标记后降档"一起回归。
  console.log('\n【三】显式指定模型 + 大请求')
  const big = bigPayload()
  const bigChars = chars(big)
  ok(bigChars > CTX_LIMIT_CHARS, `构造的请求确实超过实测容量（${bigChars} > ${CTX_LIMIT_CHARS} 字符）`)
  lastUpBody = null
  const r2 = await chat(big)
  ok(r2.status === 200, `大请求降级后成功（HTTP ${r2.status}，而不是 404 "模型不在可用池里"）`)
  const h = r2.headers.get('x-xiaoji-compacted')
  ok(!!h, `响应头标出了"裁过历史"（x-xiaoji-compacted: ${h}）`)
  const got = lastUpBody
  ok(!!got, '上游确实收到了请求（不是网关自己编了个回答）')
  if (got) {
    const gotChars = chars(got)
    // 目标规模 = 撞墙规模 * 0.7 = 8400; 留一点余量, 只要"明显变小且不超过撞墙规模"就算对
    ok(gotChars < bigChars, `实际发出的规模变小了（${bigChars} → ${gotChars} 字符）`)
    ok(gotChars <= CTX_LIMIT_CHARS, `裁到了实测撞墙规模以内（${gotChars} <= ${CTX_LIMIT_CHARS}）`)
    // 反断言①: system 绝不能被删
    const sys = got.messages.filter((m) => m.role === 'system')
    ok(sys.length === 1 && sys[0].content.includes('必须只回 OK'),
      'system 消息**被完整保留**（删掉它 = 模型不再守指令，比报错更糟）')
    // 最后一条用户提问必须还在 —— 不然等于答了个别的问题
    const last = got.messages[got.messages.length - 1]
    ok(last.role === 'user' && last.content.includes('最后一个问题'),
      '最后一条用户提问被保留（裁的是中段历史，不是当前问题）')
    // 反断言②: 保留的第一条不能是 tool（协议非法）
    ok(got.messages[0].role !== 'tool', '保留的第一条不是 role:"tool"（孤立的 tool 消息会让上游回 400）')
    ok(got.messages.length < big.messages.length, `历史条数减少了（${big.messages.length} → ${got.messages.length} 条）`)
  }

  // ══ 四、tool 消息必须成对保留 ══
  // 构造"最后一条就是 tool"的极端请求: 裁剪起点会正好落在 tool 上, 必须往前吞到它的
  // assistant.tool_calls, 否则发出的是一条非法消息序列。
  console.log("\n【四】tool 消息成对保留")
  const toolPayload = {
    model: 'tiny-8k',
    messages: [
      { role: 'system', content: '你是助手。' + 'S'.repeat(200) },
      { role: 'user', content: '读一下这个文件' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'R'.repeat(20000) },
    ],
    max_tokens: 32,
  }
  lastUpBody = null
  const r3 = await chat(toolPayload)
  ok(r3.status === 200, `以 tool 结尾的大请求也能处理（HTTP ${r3.status}）`)
  if (lastUpBody) {
    const ms = lastUpBody.messages
    const firstTool = ms.findIndex((m) => m.role === 'tool')
    ok(firstTool !== 0, `保留的第一条不是 tool（实际第一条: ${ms[0] && ms[0].role}）`)
    if (firstTool > 0) {
      const before = ms[firstTool - 1]
      ok(before.role === 'assistant' && Array.isArray(before.tool_calls) && before.tool_calls.length > 0,
        'tool 消息前面紧跟着它的 assistant.tool_calls（成对保留，协议合法）')
    } else if (firstTool < 0) {
      ok(true, 'tool 消息整组被裁掉（也是合法的：没有孤立的 tool）')
    }
  }

  // ══ 五、裁不动时不乱改 ══
  // tools 定义本身就超过预算时, 裁剪救不回来 —— 这时必须**原样发出去**, 让上游回它自己的错误,
  // 而不是发一个"工具被删掉一半"的请求(那会让客户端以为能调、上游看不到)。
  console.log("\n【五】裁不动时不硬裁")
  const heavyTools = Array.from({ length: 40 }, (_, i) => ({
    type: 'function',
    function: { name: 'tool_' + i, description: 'D'.repeat(400), parameters: { type: 'object', properties: {} } },
  }))
  const toolDefChars = JSON.stringify(heavyTools).length
  const toolHeavy = {
    model: 'tiny-8k',
    tools: heavyTools,
    messages: [
      { role: 'system', content: '你是助手' },
      { role: 'user', content: 'U'.repeat(9000) },
      { role: 'user', content: '最后一个问题' },
    ],
    max_tokens: 32,
  }
  lastUpBody = null
  const r4 = await chat(toolHeavy)
  if (lastUpBody) {
    // tools 定义占满了预算 -> 不该裁消息(裁了也放不下), 应该原样发出
    const same = JSON.stringify(lastUpBody.tools || []) === JSON.stringify(heavyTools)
    ok(same, `tools 定义占满预算时不被裁剪（${toolDefChars} 字符，原样发出）`)
  } else {
    ok(true, '上游未收到请求（网关已提前拒绝），也属于可接受行为')
  }

  console.log(`\n${fail ? '✗' : '✓'} ctx-compact-check: ${pass} 通过 / ${fail} 失败`)
  cleanup()
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error(e); cleanup(); process.exit(1) })
