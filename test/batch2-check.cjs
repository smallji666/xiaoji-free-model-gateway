#!/usr/bin/env node
/*
 * 第 2 批（可观测性数据层）回归测试 —— 全部在沙箱跑，不碰生产 8787。
 *
 * 覆盖：
 *   2.1 请求 ID：x-request-id 响应头、错误体里的 request_id、usage 记录能对上同一个 id
 *   2.2 usage_log 扩字段：id/ms/ttfb/status/tin/tout/kind/cand 都落到记录里
 *   2.5 /api/usage 支持 limit/provider/model/id/ok 过滤与分页，total 与 matched 分得清
 *   2.3 metrics.json 小时聚合：/api/metrics 出连续时序、p50/p95、按供应商计数
 *   2.4 hours 参数范围钳制（1~168）
 *   2.6 /v1/models 30s 缓存：连打两次命中缓存；配置一改立刻失效
 *
 * 用法：node test/batch2-check.cjs
 */
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { resetSandboxDir } = require('./sb-util.cjs')

const ROOT = (() => { const _fs = require('fs'), _p = require('path'); let d = _p.dirname(__dirname); for (let i = 0; i < 6; i++) { if (_fs.existsSync(_p.join(d, 'server.mjs'))) return d; d = _p.dirname(d) } return _p.join(__dirname, '..') })()
const NODE = process.execPath
const GW_PORT = 8795
const UP_PORT = 8796
const KEY = 'freegw-batch2-test-key-000000000000'

let pass = 0, fail = 0
const ok = (n, cond, d = '') => { if (cond) { pass++; console.log('  PASS ' + n) } else { fail++; console.log('  FAIL ' + n + (d ? '  → ' + d : '')) } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const waitPort = async (port, timeout = 10000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    try { await fetch(`http://127.0.0.1:${port}/healthz`); return true } catch { await sleep(150) }
  }
  return false
}

// ── 假上游 ──
// model=bad-model -> 429（用来造失败记录）
// body.stream     -> SSE（尾部带 usage）
// 其它            -> 一次性 JSON（带 usage）
let upHits = 0
function startFakeUpstream() {
  const srv = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      upHits++
      if (/\/models/.test(req.url)) {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ object: 'list', data: [{ id: 'test-model' }] }))
      }
      let p = {}
      try { p = JSON.parse(body) } catch {}
      if (p.model === 'bad-model') {
        res.writeHead(429, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ error: { message: 'rate limited' } }))
      }
      if (p.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'he' } }] })}\n\n`)
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'llo' } }] })}\n\n`)
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {} }], usage: { prompt_tokens: 3, completion_tokens: 9, total_tokens: 12 } })}\n\n`)
        res.write('data: [DONE]\n\n')
        return res.end()
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        id: 'chatcmpl-x', object: 'chat.completion', model: p.model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
      }))
    })
  })
  return new Promise((r) => srv.listen(UP_PORT, '127.0.0.1', () => r(srv)))
}

function makeSandbox(name) {
  const dir = path.join(__dirname, 'sb2-' + name)
  // ⚠ 非递归重置（safe-delete 守卫），见 sb-util.cjs
  resetSandboxDir(dir)
  // .sandbox 标记: 跳过启动时的 syncUpstreamWhitelist（见 server.mjs 注释）
  fs.writeFileSync(path.join(dir, '.sandbox'), '')
  fs.copyFileSync(path.join(ROOT, 'server.mjs'), path.join(dir, 'server.mjs'))
  fs.copyFileSync(path.join(ROOT, 'dashboard.html'), path.join(dir, 'dashboard.html'))
  fs.writeFileSync(path.join(dir, 'free_whitelist.json'), JSON.stringify({ hosts: {} }))
  const cfg = {
    port: GW_PORT,
    proxy: '',
    gatewayKey: KEY,
    providers: [{
      id: 'up', name: 'up', label: 'Up', base_url: `http://127.0.0.1:${UP_PORT}/v1`,
      keys: ['sk-up'], api_key: 'sk-up', model: 'test-model',
      models: ['test-model', 'stream-model', 'bad-model'],
      needs_proxy: false, enabled: true, ok: 0, err: 0,
      lastSweepAt: '2026-09-18T00:00:00.000Z', lastSweep: { at: '2026-09-18T00:00:00.000Z' },
      disabledModels: {},
    }],
  }
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2))
  return dir
}
function spawnGw(dir) {
  const p = spawn(NODE, ['server.mjs'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] })
  p.stdout.on('data', () => {})
  p.stderr.on('data', () => {})
  return p
}

const api = (p, opt = {}) => fetch(`http://127.0.0.1:${GW_PORT}${p}`, opt)
const auth = { authorization: 'Bearer ' + KEY }
const chat = (body, extra = {}) => api('/v1/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...auth, ...extra },
  body: JSON.stringify(body),
})
const jget = async (p) => (await api(p)).json()

;(async () => {
  const up = await startFakeUpstream()
  const dir = makeSandbox('main')
  const gw = spawnGw(dir)
  if (!await waitPort(GW_PORT)) { console.log('网关未能启动，测试中止'); process.exit(1) }
  await sleep(600)

  // ─────────── 2.1 请求 ID ───────────
  console.log('\n── 2.1 请求 ID 贯通 ──')
  let rid1, rid2, ridBad
  {
    const r1 = await chat({ model: 'up/test-model', messages: [{ role: 'user', content: 'hi' }] })
    rid1 = r1.headers.get('x-request-id')
    ok('2.1 响应头带 x-request-id', !!rid1, '实际=' + rid1)
    ok('2.1 id 是 8 位十六进制', /^[0-9a-f]{8}$/.test(rid1 || ''), '实际=' + rid1)

    const r2 = await chat({ model: 'up/test-model', messages: [{ role: 'user', content: 'hi again' }] })
    rid2 = r2.headers.get('x-request-id')
    ok('2.1 两次请求 id 不同', rid1 && rid2 && rid1 !== rid2, `${rid1} vs ${rid2}`)

    // 失败路径也要带 id（且能对上响应头）
    const rb = await chat({ model: 'up/bad-model', messages: [{ role: 'user', content: 'x' }] })
    ridBad = rb.headers.get('x-request-id')
    const jb = await rb.json()
    ok('2.1 失败响应体带 request_id', jb && jb.error && jb.error.request_id === ridBad, JSON.stringify(jb).slice(0, 160))
    ok('2.1 失败响应头也有 x-request-id', !!ridBad)
  }

  // ─────────── 2.2 usage_log 扩字段 + 2.5 过滤分页 ───────────
  console.log('\n── 2.2 usage_log 扩字段 / 2.5 /api/usage 过滤 ──')
  {
    // 流式也来一发，确认流式路径也写 id
    const rs = await chat({ model: 'up/stream-model', stream: true, messages: [{ role: 'user', content: 'stream please' }] })
    const ridStream = rs.headers.get('x-request-id')
    const txt = await rs.text()
    ok('2.1 流式响应也带 x-request-id', !!ridStream, '实际=' + ridStream)
    // ⚠ 断言要看**原始 SSE 报文**: 假上游把 hello 拆成 'he'+'llo' 两块发,
    // 所以原始文本里根本没有字面量 "hello" —— 只能逐块查 content 字段。
    ok('2.1 流式内容完整（两块 delta + [DONE]）',
      txt.includes('"content":"he"') && txt.includes('"content":"llo"') && txt.includes('[DONE]'),
      '实际报文=' + JSON.stringify(txt.slice(0, 300)))

    await sleep(400)
    const u = await jget('/api/usage?limit=20')
    ok('2.5 返回 total/matched/okCount/failCount', typeof u.total === 'number' && typeof u.matched === 'number' && typeof u.okCount === 'number' && typeof u.failCount === 'number', JSON.stringify({ total: u.total, matched: u.matched }))
    ok('2.5 total >= 4（含流式与失败）', u.total >= 4, '实际=' + u.total)

    const okRec = u.records.find((x) => x.ok && x.id === rid1)
    ok('2.2 成功记录能按 id 找到', !!okRec, 'id=' + rid1)
    if (okRec) {
      ok('2.2 记录带 ms', typeof okRec.ms === 'number' && okRec.ms >= 0, 'ms=' + okRec.ms)
      ok('2.2 记录带 status=200', okRec.status === 200, 'status=' + okRec.status)
      ok('2.2 记录带 kind=openai', okRec.kind === 'openai', 'kind=' + okRec.kind)
      ok('2.2 记录带 cand>=1', typeof okRec.cand === 'number' && okRec.cand >= 1, 'cand=' + okRec.cand)
      ok('2.2 记录带 ttfb>0', typeof okRec.ttfb === 'number' && okRec.ttfb > 0, 'ttfb=' + okRec.ttfb)
    }
    const badRec = u.records.find((x) => !x.ok && x.id === ridBad)
    ok('2.2 失败记录带 status=429', !!badRec && badRec.status === 429, badRec ? 'status=' + badRec.status : '找不到失败记录')

    const sRec = u.records.find((x) => x.id === ridStream)
    ok('2.2 流式记录也在（id 对得上）', !!sRec, 'id=' + ridStream)

    // 过滤
    const onlyOk = await jget('/api/usage?limit=50&ok=1')
    ok('2.5 ok=1 只回成功记录', onlyOk.records.length > 0 && onlyOk.records.every((x) => x.ok))
    const onlyFail = await jget('/api/usage?limit=50&ok=0')
    ok('2.5 ok=0 只回失败记录', onlyFail.records.length > 0 && onlyFail.records.every((x) => !x.ok))
    const byId = await jget('/api/usage?limit=50&id=' + rid1)
    ok('2.5 id 过滤只回该请求的记录', byId.records.length >= 1 && byId.records.every((x) => x.id === rid1), 'len=' + byId.records.length)
    const byProv = await jget('/api/usage?limit=50&provider=up')
    ok('2.5 provider 过滤生效', byProv.records.length > 0 && byProv.records.every((x) => x.provider === 'up'))
    const byModel = await jget('/api/usage?limit=50&model=test-model')
    ok('2.5 model 过滤生效', byModel.records.length > 0 && byModel.records.every((x) => x.model === 'test-model'))
    const lim1 = await jget('/api/usage?limit=1')
    ok('2.5 limit=1 只回 1 条但 total 仍报全量', lim1.records.length === 1 && lim1.total >= 4, JSON.stringify({ got: lim1.records.length, total: lim1.total }))
    const okCounts = await jget('/api/usage?limit=50')
    ok('2.5 okCount+failCount = matched', okCounts.okCount + okCounts.failCount === okCounts.matched, JSON.stringify({ ok: okCounts.okCount, fail: okCounts.failCount, m: okCounts.matched }))
  }

  // ─────────── 2.3 / 2.4 metrics ───────────
  console.log('\n── 2.3 metrics 小时聚合 / 2.4 hours 钳制 ──')
  {
    const m = await jget('/api/metrics')
    ok('2.3 默认返回 24 个小时桶', Array.isArray(m.series) && m.series.length === 24, 'len=' + (m.series && m.series.length))
    ok('2.3 totals.n 记到了请求', m.totals && m.totals.n >= 4, JSON.stringify(m.totals && { n: m.totals.n }))
    ok('2.3 totals.ok >= 2', m.totals && m.totals.ok >= 2, 'ok=' + (m.totals && m.totals.ok))
    ok('2.3 totals.fail >= 1', m.totals && m.totals.fail >= 1, 'fail=' + (m.totals && m.totals.fail))
    ok('2.3 按供应商计数含 up', !!(m.totals && m.totals.prov && m.totals.prov.up >= 1), JSON.stringify(m.totals && m.totals.prov))
    ok('2.3 success_rate 是数字', typeof m.totals.success_rate === 'number', 'v=' + m.totals.success_rate)
    ok('2.3 totals.tout > 0（token 统计通了）', m.totals && m.totals.tout > 0, 'tout=' + (m.totals && m.totals.tout))

    const last = m.series[m.series.length - 1]
    ok('2.3 最后一个桶有 n>0', last.n > 0, 'n=' + last.n)
    ok('2.3 有 ms_p50', typeof last.ms_p50 === 'number', 'p50=' + last.ms_p50)
    ok('2.3 有 ms_p95 且 >= p50', typeof last.ms_p95 === 'number' && last.ms_p95 >= last.ms_p50, `p50=${last.ms_p50} p95=${last.ms_p95}`)
    ok('2.3 桶键是本地小时格式', /^\d{4}-\d{2}-\d{2}T\d{2}$/.test(last.t || ''), 't=' + last.t)
    ok('2.3 序列连续且时间递增', m.series.every((b, i) => i === 0 || b.t > m.series[i - 1].t))

    const h1 = await jget('/api/metrics?hours=1')
    ok('2.4 hours=1 只回 1 个桶', h1.series.length === 1, 'len=' + h1.series.length)
    const h999 = await jget('/api/metrics?hours=999')
    ok('2.4 hours 上限钳到 168', h999.series.length === 168, 'len=' + h999.series.length)
    // ⚠ 期望值在第 3 批改过: 原来 hours=0 会被 `Number(x) || 24` 吞成 24, 下限其实是 1。
    // 现在区分"没传"(→24) 与"传了但太小"(→钳到 1)。这条断言必须跟着改, 否则它会一直报假失败。
    const h0 = await jget('/api/metrics?hours=0')
    ok('2.4 hours=0 钳到下限 1（不是回退默认 24）', h0.series.length === 1, 'len=' + h0.series.length)
    const hNone = await jget('/api/metrics')
    ok('2.4 不传 hours 才用默认 24', hNone.series.length === 24, 'len=' + hNone.series.length)
  }

  // ─────────── 2.6 /v1/models 缓存 ───────────
  console.log('\n── 2.6 /v1/models 缓存与失效 ──')
  {
    // ⚠ /v1/models 属于"模型 API", 一律要网关 Key（GET /api/* 才免鉴权）—— 不带 Key 会 401
    const models = () => api('/v1/models', { headers: { ...auth } })
    const aRes = await models()
    const aTxt = await aRes.text()
    let a = {}
    try { a = JSON.parse(aTxt) } catch {}
    ok('2.6 /v1/models 返回合法 JSON 且含 data', Array.isArray(a.data), 'status=' + aRes.status + ' body=' + JSON.stringify(aTxt.slice(0, 200)))
    const b = await (await models()).json()
    ok('2.6 两次调用内容一致（命中缓存）', JSON.stringify(a) === JSON.stringify(b))
    ok('2.6 缓存里有 test-model', (a.data || []).some((x) => x.id === 'up/test-model'))
    const n0 = (a.data || []).length

    // 写配置（加一家供应商）-> 缓存必须立刻失效
    const add = await api('/api/providers', {
      method: 'POST', headers: { 'content-type': 'application/json', ...auth },
      body: JSON.stringify({
        name: 'up2', label: 'Up2', base_url: `http://127.0.0.1:${UP_PORT}/v1`,
        api_key: 'sk-up2', models: ['extra-model'],
      }),
    })
    const addJ = await add.json()
    ok('2.6 新增供应商成功', add.status === 200 && addJ.ok !== false, 'status=' + add.status + ' ' + JSON.stringify(addJ).slice(0, 160))

    const cRes = await models()
    const cTxt = await cRes.text()
    let c = {}
    try { c = JSON.parse(cTxt) } catch {}
    ok('2.6 失效后 /v1/models 仍返回合法 JSON', Array.isArray(c.data), 'status=' + cRes.status + ' body=' + JSON.stringify(cTxt.slice(0, 200)))
    ok('2.6 配置改动后缓存立刻失效', (c.data || []).length > n0, `${n0} -> ${(c.data || []).length}`)
    ok('2.6 新模型立刻可见', (c.data || []).some((x) => x.id === 'up2/extra-model'), '未见 up2/extra-model；实际前几个=' + JSON.stringify((c.data || []).slice(0, 4)))
  }

  // ─────────── 落盘 ───────────
  console.log('\n── 落盘检查 ──')
  {
    await sleep(5000)   // metrics 写盘防抖 4s
    const mf = path.join(dir, 'metrics.json')
    ok('2.3 metrics.json 已落盘', fs.existsSync(mf))
    if (fs.existsSync(mf)) {
      const mj = JSON.parse(fs.readFileSync(mf, 'utf8'))
      ok('2.3 metrics.json 结构含 hours', mj && mj.hours && typeof mj.hours === 'object' && !Array.isArray(mj.hours))
      ok('2.3 metrics.json 有 updated_at', !!mj.updated_at)
      const keys = Object.keys(mj.hours)
      ok('2.3 桶数不超过 168', keys.length <= 168, 'buckets=' + keys.length)
    }
    const uf = path.join(dir, 'usage_log.json')
    ok('2.2 usage_log.json 已落盘', fs.existsSync(uf))
    if (fs.existsSync(uf)) {
      const uj = JSON.parse(fs.readFileSync(uf, 'utf8'))
      ok('2.2 usage_log.json 是数组且非空', Array.isArray(uj) && uj.length > 0, 'len=' + (Array.isArray(uj) ? uj.length : 'n/a'))
      ok('2.2 落盘记录保留 id 字段', uj.some((x) => typeof x.id === 'string' && x.id.length === 8))
    }
    ok('2.6 缓存没有把上游打爆（上游请求数合理）', upHits < 200, 'upHits=' + upHits)
  }

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
  try { gw.kill() } catch {}
  try { up.close() } catch {}
  await sleep(300)
  // 沙箱目录**故意保留**（递归删会被本机 safe-delete 守卫拦下，且删目录也太宽）；
  // 状态文件已在下轮 makeSandbox 里重置。要彻底清理请手动删该目录。
  process.exit(fail ? 1 : 0)
})().catch((e) => { console.error('测试崩溃:', e); process.exit(1) })
