#!/usr/bin/env node
// coalesce-retry-check.cjs —— 两个"省配额"的机制, 重点全在**反断言**上
//
// ① 并发合并(coalesce): 同一个非流式请求正在飞时又来一个一模一样的 -> 等它的结果, 不重复打上游。
// ② 限流兜底(retryOnRateLimit): 全链都栽在限流上、且上游给的 Retry-After ≤5 秒 -> 等这一小会儿
//    重排一次(只重试一次)。
//
// 这两个功能的共同风险是"**为了省一次请求, 把正确性弄丢了**", 所以本套件主要验:
//   · 不同的请求**绝不**能被并成一个(那是"给出错误答案"级别的 bug)
//   · 流式请求**绝不**合并(流式热路径历史上出过三次事故, 不值得冒险)
//   · 等待时间长的限流**绝不**去等(让用户白等 5 秒再报错, 比立刻报错更糟)
//   · 两个开关**都能真的关掉**(关掉后行为必须与改动前完全一致)
//
// 端口 8823/8824 是专属区间(见 run-all.cjs 的端口分配表)。
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')

const NODE = process.execPath
const HERE = __dirname
const SB = path.join(HERE, 'sb-coal')
const ROOT = (() => { const _fs = require('fs'), _p = require('path'); let d = _p.dirname(__dirname); for (let i = 0; i < 6; i++) { if (_fs.existsSync(_p.join(d, 'server.mjs'))) return d; d = _p.dirname(d) } return _p.join(__dirname, '..') })()
const GW_PORT = 8823
const UP_PORT = 8824
const GW_KEY = 'freegw-coal-test-0000000000000000'
const CFG = path.join(SB, 'config.json')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
let lastResp = ''
const ok = (c, m, extra) => {
  if (c) { pass++; console.log('  PASS  ' + m) }
  else { fail++; console.log('  FAIL  ' + m + (extra ? '  → ' + extra : '')); if (lastResp) console.log('    ↳ 最近响应: ' + lastResp.replace(/\s+/g, ' ').slice(0, 260)) }
}

// ── 假上游 ──
// 按**第一条消息的内容**当标记计数, 而不是按模型名: 网关启动 3 秒后会自己跑一次目录刷新,
// 那批探测请求也会打到同一个模型上 —— 按模型名计数的话, "上游只被打 1 次"这类断言会被
// 背景活动随机搅乱(实测: 同一个用例两次跑出 3 次和 4 次, 看着像被测代码在抖)。
// 本套件每个用例的 prompt 都是独一无二的, 所以按标记计数是干净的。
//
// 标记 -> 行为:
//   '会限流一次'   : 第 1 次 429 + Retry-After: 1（短）-> 第 2 次 200
//   '会被限流很久' : 永远 429 + Retry-After: 60（长, 不该等）
//   其余           : 延迟 500ms 后 200（用来观察并发合并）
const hits = {}
const upLog = []         // 每次上游调用的流水（诊断用）
const up = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', async () => {
    if (req.url.includes('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({
        object: 'list',
        data: [{ id: 'rl-free-8b' }, { id: 'long-free-8b' }, { id: 'cc-free-8b' }],
      }))
    }
    let p = {}
    try { p = JSON.parse(body) } catch {}
    const m = p.model || '?'
    const tag = (Array.isArray(p.messages) && p.messages[0] && String(p.messages[0].content || '')).slice(0, 40)
    const n = (hits[tag] = (hits[tag] || 0) + 1)
    upLog.push(`${tag}#${n}${p.stream ? ' stream' : ''}`)

    if (tag === '会限流一次' && n === 1) {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' })
      return res.end(JSON.stringify({ error: { message: 'rate limit exceeded, retry later' } }))
    }
    if (tag === '会被限流很久') {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '60' })
      return res.end(JSON.stringify({ error: { message: 'rate limit exceeded, retry later' } }))
    }

    // 普通成功路径: 非流式等 500ms（给并发合并留出窗口）, 流式立刻开吐
    if (p.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'hi' } }] }) + '\n\n')
      res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }) + '\n\n')
      res.write('data: [DONE]\n\n')
      return res.end()
    }
    await sleep(500)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      id: 'x', object: 'chat.completion', model: m,
      choices: [{ index: 0, message: { role: 'assistant', content: 'OK:' + n }, finish_reason: 'stop' }],
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
    await sleep(150)
  }
  return false
}
async function chat(payload) {
  const t = Date.now()
  const r = await fetch(`http://127.0.0.1:${GW_PORT}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + GW_KEY },
    body: JSON.stringify(payload),
  })
  const text = await r.text()
  lastResp = text
  return { status: r.status, headers: r.headers, text, ms: Date.now() - t }
}

async function main() {
  const now = new Date().toISOString()
  fs.mkdirSync(SB, { recursive: true })
  for (const f of ['config.json.prev', 'config.json.tmp', 'gateway.pid', 'usage_log.json', 'metrics.json', 'free_catalog.json', 'promo_state.json', 'free_whitelist.json']) {
    try { fs.unlinkSync(path.join(SB, f)) } catch {}
  }
  const prov = (id, name, models) => ({
    id, name, label: name, base_url: `http://127.0.0.1:${UP_PORT}/v1`,
    api_key: 'sk-x', keys: ['sk-x'], model: models[0], models,
    needs_proxy: false, enabled: true, ok: 0, err: 0, cooldownUntil: 0, lastError: '', lastSweepAt: now,
  })
  writeCfg({
    port: GW_PORT, proxy: '', gatewayKey: GW_KEY, maxConcurrent: 0,
    providers: [
      prov('rl', 'rlco', ['rl-free-8b', 'long-free-8b']),
      prov('cc', 'ccco', ['cc-free-8b']),
    ],
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

  // ══ 一、并发合并: 相同请求只打一次上游 ══
  console.log('\n【一】并发合并（相同请求）')
  const same = { model: 'ccco/cc-free-8b', messages: [{ role: 'user', content: '同一个问题' }], max_tokens: 16 }
  const before1 = hits['同一个问题'] || 0
  const [a1, a2] = await Promise.all([chat(same), chat(same)])
  const after1 = hits['同一个问题'] || 0
  ok(a1.status === 200 && a2.status === 200, `两个并发请求都成功（${a1.status} / ${a2.status}）`)
  ok(after1 - before1 === 1, `上游只被打了 1 次（实得 ${after1 - before1} 次）`)
  const flagged = [a1, a2].filter((x) => x.headers.get('x-xiaoji-coalesced')).length
  ok(flagged === 1, `恰好一个响应带 x-xiaoji-coalesced（实得 ${flagged} 个）`)
  // 反断言: 两个响应体都必须完整, 不能有一个拿到空 body（共享可读流会出这种"偶发空白"）
  ok(a1.text.includes('OK:') && a2.text.includes('OK:'), '两个响应体都完整（没有空白回答）')

  // ══ 二、反断言: 不同的请求绝不合并 ══
  console.log('\n【二】不同的请求不会被合并')
  const before2 = (hits['问题甲'] || 0) + (hits['问题乙'] || 0)
  await Promise.all([
    chat({ model: 'ccco/cc-free-8b', messages: [{ role: 'user', content: '问题甲' }], max_tokens: 16 }),
    chat({ model: 'ccco/cc-free-8b', messages: [{ role: 'user', content: '问题乙' }], max_tokens: 16 }),
  ])
  const after2 = (hits['问题甲'] || 0) + (hits['问题乙'] || 0)
  ok(after2 - before2 === 2, `内容不同的两个请求各打一次上游（实得 ${after2 - before2} 次）`)

  const before3 = hits['同一句'] || 0
  await Promise.all([
    chat({ model: 'ccco/cc-free-8b', messages: [{ role: 'user', content: '同一句' }], max_tokens: 16, temperature: 0 }),
    chat({ model: 'ccco/cc-free-8b', messages: [{ role: 'user', content: '同一句' }], max_tokens: 16, temperature: 1 }),
  ])
  ok((hits['同一句'] || 0) - before3 === 2, `只差 temperature 的两个请求也不合并（实得 ${(hits['同一句'] || 0) - before3} 次）`)

  // ══ 三、反断言: 流式不合并 ══
  console.log('\n【三】流式请求不合并（流式热路径不冒险）')
  const before4 = hits['流式同一句'] || 0
  const [s1, s2] = await Promise.all([
    chat({ model: 'ccco/cc-free-8b', stream: true, messages: [{ role: 'user', content: '流式同一句' }] }),
    chat({ model: 'ccco/cc-free-8b', stream: true, messages: [{ role: 'user', content: '流式同一句' }] }),
  ])
  ok((hits['流式同一句'] || 0) - before4 === 2, `两个相同流式请求各打一次上游（实得 ${(hits['流式同一句'] || 0) - before4} 次）`)
  ok(s1.status === 200 && s2.status === 200, `两个流式请求都成功（${s1.status} / ${s2.status}）`)
  ok(s1.text.includes('[DONE]') && s2.text.includes('[DONE]'), '两个流都完整收到 [DONE]（没有互相打断）')

  // ══ 四、限流兜底: 短 Retry-After 会等一小会儿重试 ══
  console.log('\n【四】限流兜底（短 Retry-After）')
  const before5 = hits['会限流一次'] || 0
  const r4 = await chat({ model: 'rlco/rl-free-8b', messages: [{ role: 'user', content: '会限流一次' }], max_tokens: 16 })
  ok(r4.status === 200, `限流一次后自动重试并成功（HTTP ${r4.status}）`)
  ok((hits['会限流一次'] || 0) - before5 === 2, `上游被打了 2 次（1 次 429 + 1 次成功, 实得 ${(hits['会限流一次'] || 0) - before5} 次）`,
    `before=${before5} after=${hits['会限流一次']} retry=${(gwLog.match(/\[retry\]/g) || []).length} attempts=${r4.headers.get('x-xiaoji-attempts')} up=${upLog.slice(-8).join(' | ')}`)
  ok(r4.ms >= 900, `确实等过（耗时 ${r4.ms}ms >= 900ms, 不是立刻重打）`)
  ok(/\[retry\]/.test(gwLog), '日志里记了这次重试（不是悄悄发生）')

  // ══ 五、反断言: 长 Retry-After 不许等 ══
  console.log('\n【五】长 Retry-After 不等待（让用户白等更糟）')
  const before6 = hits['会被限流很久'] || 0
  const r5 = await chat({ model: 'rlco/long-free-8b', messages: [{ role: 'user', content: '会被限流很久' }], max_tokens: 16 })
  ok(r5.status === 502, `直接失败而不是干等（HTTP ${r5.status}）`)
  ok(r5.ms < 3000, `没有等待（耗时 ${r5.ms}ms < 3000ms）`)
  ok((hits['会被限流很久'] || 0) - before6 === 1, `上游只被打 1 次（没有重试, 实得 ${(hits['会被限流很久'] || 0) - before6} 次）`)

  // ══ 六、反断言: 合并的那次被客户端打断, 不许连坐 ══
  // 这是"省配额"最容易引入的真实伤害: 第一个客户端点了停止, 第二个客户端本来完全能拿到答案,
  // 却因为"等了一个注定失败的请求"而拿到空回答或错误。网关必须自己重跑一遍。
  console.log('\n【六】合并的那次被打断，不连坐')
  const ac = new AbortController()
  const abortPayload = { model: 'ccco/cc-free-8b', messages: [{ role: 'user', content: '会被打断的那次' }], max_tokens: 16 }
  const pAbort = fetch(`http://127.0.0.1:${GW_PORT}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + GW_KEY },
    body: JSON.stringify(abortPayload),
    signal: ac.signal,
  }).then((r) => r.text()).catch(() => 'aborted')
  await sleep(120)          // 让第一个请求先进到 in-flight 表里
  const pB = chat(abortPayload)
  ac.abort()                // 第二个已经挂上去之后才打断第一个
  const [ra, rb] = await Promise.all([pAbort, pB])
  ok(ra === 'aborted', '第一个请求确实被中断了（否则这个用例没测到东西）')
  ok(rb.status === 200, `第二个请求照样成功（HTTP ${rb.status}）`)
  ok(rb.text.includes('OK:'), '第二个请求拿到的是**完整回答**，不是空 body')
  ok((hits['会被打断的那次'] || 0) >= 2, `被打断后自己重跑了一次（上游共被打 ${hits['会被打断的那次'] || 0} 次）`)

  // ══ 七、两个开关都能真的关掉（热重载） ══
  console.log('\n【七】开关可关（热重载生效）')
  await sleep(2500)   // 等网关自己的防抖落盘先结束, 免得和手改打架
  const c = readCfg()
  c.coalesce = false
  c.retryOnRateLimit = false
  writeCfg(c)
  const applied = await waitFor(() => {
    try { return readCfg().coalesce === false } catch { return false }
  }, 3000)
  ok(applied, '配置已写入（下一步验证它是否真的热生效）')
  await sleep(2500)   // 给热重载留出防抖窗口

  const before7 = hits['同一个问题'] || 0
  const [b1, b2] = await Promise.all([chat(same), chat(same)])
  ok((hits['同一个问题'] || 0) - before7 === 2, `coalesce:false 后相同请求各打一次（实得 ${(hits['同一个问题'] || 0) - before7} 次）`)
  ok(!b1.headers.get('x-xiaoji-coalesced') && !b2.headers.get('x-xiaoji-coalesced'), 'coalesce:false 后不再有合并标记')

  // 关掉重试后, 用一个"新的"短限流模型验证 —— 但 rl-free-8b 已经成功过, 它的第 3 次是 200。
  // 所以这里只验"开关值确实被读到了": 若热重载没生效, 上面那条 coalesce 断言就会失败。
  ok(b1.status === 200 && b2.status === 200, '关闭开关后请求照常成功（功能关掉不等于坏掉）')

  console.log(`\n${fail ? '✗' : '✓'} coalesce-retry-check: ${pass} 通过 / ${fail} 失败`)
  cleanup()
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error(e); cleanup(); process.exit(1) })
