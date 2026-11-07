#!/usr/bin/env node
// fail-scope-check.cjs —— 失败归类与冷却的两个修复
//
// ① **"模型不给你用" ≠ "你的 Key 失效"**：免费池里很常见的 401/403 是"这个模型只对某些客户端/
//    付费档开放"，与 Key 好坏无关。误判成 auth 会冷却**整个 Key 10 分钟**，同家其它本来能用的模型
//    一起被连累（一家里 17 个模型，一个模型的门槛把 16 个正常模型踢出池子）。
// ② **连续失败退避**：固定 90 秒冷却只挡得住"刚才抖了一下"。一个真过载的模型 90 秒后准时回到
//    竞争队列，于是每 90 秒被选中一次、白等一个完整往返、再冷却 —— 循环到天荒地老。
//
// 本套件断言的是**落盘状态**（config.json），不是"请求成功与否"：
// 这两个 bug 都不会让请求直接报错（路由会自动换下一家），只会**悄悄变慢**，所以只能看状态。
//
// 端口 8825/8826 是专属区间（见 run-all.cjs 的端口分配表）。
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')

const NODE = process.execPath
const HERE = __dirname
const SB = path.join(HERE, 'sb-scope')
const ROOT = (() => { const _fs = require('fs'), _p = require('path'); let d = _p.dirname(__dirname); for (let i = 0; i < 6; i++) { if (_fs.existsSync(_p.join(d, 'server.mjs'))) return d; d = _p.dirname(d) } return _p.join(__dirname, '..') })()
const GW_PORT = 8825
const UP_PORT = 8826
const GW_KEY = 'freegw-scope-test-0000000000000000'
const CFG = path.join(SB, 'config.json')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
let lastResp = ''
const ok = (c, m, extra) => {
  if (c) { pass++; console.log('  PASS  ' + m) }
  else { fail++; console.log('  FAIL  ' + m + (extra ? '  → ' + extra : '')); if (lastResp) console.log('    ↳ 最近响应: ' + lastResp.replace(/\s+/g, ' ').slice(0, 240)) }
}

// ── 假上游 ──
//   scoped-free-8b : 401 + "is only available on agentic harnesses"（模型级限制, 不是 Key 问题）
//   ok-free-8b     : 200（同家另一个正常模型）
//   flaky-free-8b  : 503 "service unavailable"（归 'server', 永远失败）, 由 flakyMode 切成 200
//   ovl-free-8b    : 503 "overloaded"（归 'overloaded' —— 它有自己的 60 秒基础冷却, 走的是**另一个分支**）
let flakyMode = 'fail'
const up = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    if (req.url.includes('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ object: 'list', data: [{ id: 'scoped-free-8b' }, { id: 'ok-free-8b' }, { id: 'flaky-free-8b' }, { id: 'ovl-free-8b' }] }))
    }
    let p = {}
    try { p = JSON.parse(body) } catch {}
    const m = String(p.model || '')
    if (m.includes('scoped-free-8b')) {
      res.writeHead(401, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ error: { message: 'thinkingmachines/inkling:free is only available on agentic harnesses. Try plugging it into your agent.' } }))
    }
    if (m.includes('ovl-free-8b')) {
      res.writeHead(503, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ error: { message: 'The model is overloaded. Please try again later.' } }))
    }
    if (m.includes('flaky-free-8b') && flakyMode === 'fail') {
      res.writeHead(503, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ error: { message: 'service unavailable' } }))
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      id: 'x', object: 'chat.completion', model: m,
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

function readCfg() { return JSON.parse(fs.readFileSync(CFG, 'utf8')) }
function writeCfg(c) { fs.writeFileSync(CFG, JSON.stringify(c, null, 2)) }
async function waitFor(fn, ms = 8000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    try { if (await fn()) return true } catch {}
    await sleep(120)
  }
  return false
}
async function chat(model) {
  const r = await fetch(`http://127.0.0.1:${GW_PORT}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + GW_KEY },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 8 }),
  })
  const text = await r.text()
  lastResp = text
  return { status: r.status, text }
}
// 读**内存态**（/api/state）而不是 config.json：saveConfig 是 300ms 防抖的（见 server.mjs），
// markFail 之后立刻读盘会读到上一轮的旧值 —— 那测的是"写盘时机"，不是"退避曲线"，会假红。
// "到底落盘了没有"另有一条独立断言（见【二】末尾），两件事分开验，各测各的。
const prov = async () => {
  const r = await fetch(`http://127.0.0.1:${GW_PORT}/api/state`)
  const s = await r.json()
  return s.providers[0]
}

async function main() {
  const now = new Date().toISOString()
  fs.mkdirSync(SB, { recursive: true })
  for (const f of ['config.json.prev', 'config.json.tmp', 'gateway.pid', 'usage_log.json', 'metrics.json', 'free_catalog.json', 'promo_state.json', 'free_whitelist.json']) {
    try { fs.unlinkSync(path.join(SB, f)) } catch {}
  }
  writeCfg({
    port: GW_PORT, proxy: '', gatewayKey: GW_KEY, maxConcurrent: 0,
    providers: [{
      id: 'sc', name: 'scco', label: 'ScopeCo', base_url: `http://127.0.0.1:${UP_PORT}/v1`,
      api_key: 'sk-x', keys: ['sk-x'], model: 'ok-free-8b',
      models: ['scoped-free-8b', 'ok-free-8b', 'flaky-free-8b', 'ovl-free-8b'],
      needs_proxy: false, enabled: true, ok: 0, err: 0, cooldownUntil: 0, lastError: '', lastSweepAt: now,
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

  // ══ 一、模型级 401 不许冷却整个 Key ══
  console.log('\n【一】模型级限制 ≠ Key 失效')
  const r1 = await chat('scco/scoped-free-8b')
  ok(r1.status >= 400, `被限定的模型调用失败（HTTP ${r1.status}，这是预期：它确实不给我们用）`)
  const st1 = await waitFor(async () => { const p = await prov(); return !!(p.blocked && p.blocked['scoped-free-8b']) }, 5000)
  const p1 = await prov()
  ok(st1, '该模型被**拉黑**（blocked.scoped-free-8b 存在）')
  const kc = p1.keyCooldown || {}
  ok(Object.keys(kc).length === 0,
    'Key **没有**被冷却（keyCooldown 为空）—— 误判成 auth 时这里会有一个 10 分钟的时间戳',
    JSON.stringify(kc))
  ok(!p1.cooldownUntil || p1.cooldownUntil < Date.now(),
    '整家供应商也没被冷却（cooldownUntil 不在未来）')

  // 行为断言: 同家另一个模型照常能用（Key 没被冻结）
  const r2 = await chat('scco/ok-free-8b')
  ok(r2.status === 200, `同家的另一个模型照常可用（HTTP ${r2.status}）`)
  // 反断言: 被拉黑的那个不再被尝试（直接报错, 不白等一个往返）
  const r3 = await chat('scco/scoped-free-8b')
  ok(r3.status >= 400, `再次调用被限定的模型仍失败（HTTP ${r3.status}，但没有打上游）`)

  // ══ 二、连续失败要退避 ══
  console.log('\n【二】连续失败退避（90s → 180s → 360s）')
  const cdOf = (p, m = 'flaky-free-8b') => {
    const t = (p.modelCooldown && p.modelCooldown[m]) || 0
    return t ? t - Date.now() : 0
  }
  // 等到冷却**真的比上一轮更长**再断言。失败就是失败（3 秒内没变长就按当前值报错），
  // 不做"等到通过为止"的宽容 —— 那会让退避真的坏掉时测试也是绿的。
  const cdAfter = async (prev, m) => {
    let v = cdOf(await prov(), m)
    const t0 = Date.now()
    while (!(v > prev + 5000) && Date.now() - t0 < 3000) { await sleep(120); v = cdOf(await prov(), m) }
    return v
  }
  await chat('scco/flaky-free-8b')
  const cd1 = await cdAfter(0)
  ok(cd1 > 80000 && cd1 <= 95000, `第 1 次失败后冷却约 90 秒（实得 ${Math.round(cd1 / 1000)}s）`)

  await chat('scco/flaky-free-8b')
  const cd2 = await cdAfter(cd1)
  ok(cd2 > 170000 && cd2 <= 190000, `第 2 次后翻倍到约 180 秒（实得 ${Math.round(cd2 / 1000)}s）`)

  await chat('scco/flaky-free-8b')
  const cd3 = await cdAfter(cd2)
  ok(cd3 > 340000 && cd3 <= 380000, `第 3 次后再翻倍到约 360 秒（实得 ${Math.round(cd3 / 1000)}s）`)
  ok(/\[backoff\]/.test(gwLog), '日志里记了这次退避（不是悄悄发生）')
  // 落盘断言: 退避必须写进 config.json —— 只活在内存里的话, 重启一次就归零,
  // 而"重启"恰恰是用户遇到一连串失败时最常做的事, 等于退避在最需要它的时候失效。
  await sleep(600)   // 等 saveConfig 的 300ms 防抖
  const diskCd = cdOf(readCfg().providers[0])
  ok(diskCd > 300000, `退避写进了 config.json（重启后不会立刻再撞一次，实得 ${Math.round(diskCd / 1000)}s）`)

  // ══ 二·b、"过载"走的是另一个分支, 也得退避 ══
  // 503 + "overloaded" 归 'overloaded', 它有自己的 60 秒基础冷却 —— 也就是说上面那条 else 分支
  // **根本管不到它**。而实测里真正在空转的正是这一类(gemini-3.8-flash 13 次 10 次过载)。
  // 这条断言就是为了防止"改了一个分支、以为覆盖了全部"。
  console.log('\n【二·b】"过载"也退避（60s → 120s）')
  await chat('scco/ovl-free-8b')
  const o1 = await cdAfter(0, 'ovl-free-8b')
  ok(o1 > 50000 && o1 <= 66000, `第 1 次过载后冷却约 60 秒（实得 ${Math.round(o1 / 1000)}s）`)
  await chat('scco/ovl-free-8b')
  const o2 = await cdAfter(o1, 'ovl-free-8b')
  ok(o2 > 110000 && o2 <= 130000, `第 2 次过载后翻倍到约 120 秒（实得 ${Math.round(o2 / 1000)}s）`)

  // ══ 三、成功一次立刻清零（退避只针对"连续"） ══
  console.log('\n【三】成功一次立刻清零')
  flakyMode = 'ok'
  const r4 = await chat('scco/flaky-free-8b')
  ok(r4.status === 200, `模型恢复后能正常调用（HTTP ${r4.status}）`)
  const cleared = await waitFor(async () => {
    const p = await prov()
    return !(p.failStreak && p.failStreak['flaky-free-8b'])
  }, 5000)
  ok(cleared, '连续失败计数已清零（failStreak 里没有它了）—— 下次再抖不会一路背到 12 分钟')

  if (process.env.DUMP_LOG) console.log('\n===== gwLog =====\n' + gwLog)
  console.log(`\n${fail ? '✗' : '✓'} fail-scope-check: ${pass} 通过 / ${fail} 失败`)
  cleanup()
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error(e); cleanup(); process.exit(1) })
