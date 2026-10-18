#!/usr/bin/env node
/*
 * 新增功能 受控测试 —— 别名映射 / 多模态搬运 / developer role 归一 / 来源响应头 /
 * tools 实测学习 / Prometheus /metrics / 配置导出导入。
 *
 * 为什么单开一个套件而不是塞进 batch3:
 *   batch3 的主题是"后端与前端一致性", 而这些功能**刻意不上面板**(用户明确要求先不做 UI),
 *   混进去会让 batch3 的边界变模糊 —— 它的价值就在于"只验页面相关的那一摊"。
 *
 * 沙箱约定与 gate-check 完全一致: 独立目录 + 独立端口(8801) + 假上游(8802),
 * 首尾各算一次**生产 config.json 的语义摘要**做"没碰生产"的守卫。
 * 端口刻意避开 8791~8798(gate/batch1/batch4/batch3 在用), 可以并行跑。
 *
 * 用法：node test/features-check.cjs
 */
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { resetSandboxDir, stableConfigView } = require('./sb-util.cjs')

const ROOT = (() => { const _fs = require('fs'), _p = require('path'); let d = _p.dirname(__dirname); for (let i = 0; i < 6; i++) { if (_fs.existsSync(_p.join(d, 'server.mjs'))) return d; d = _p.dirname(d) } return _p.join(__dirname, '..') })()
const NODE = process.execPath
const GW_PORT = 8801
const UP_PORT = 8802
const KEY = 'freegw-feat-test-key-00000000000000'
const REAL_CONFIG = path.join(ROOT, 'config.json')
const MODEL = 'llama-3.3-70b-versatile'
const PROVIDER = 'feat'

let pass = 0, fail = 0
const chk = (label, cond, extra) => { if (cond) { pass++; console.log('  PASS  ' + label) } else { fail++; console.log('  FAIL  ' + label + (extra ? ' -> ' + extra : '')) } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 假上游: 记录最近一次 /chat/completions 收到的 payload(供"上游到底看到了什么"这类断言),
// 并对**带 tools 的请求**一律回 400「不支持」—— 用来验 tools 实测学习这条链路。
let lastChat = null
// 由用例控制: [2] 多模态搬运要求带图请求**成功**; [8] 视觉实测学习要求它**被拒收**。
// 用开关而不是"按模型名区分", 是为了不往沙箱 config 里塞第二个模型(那会连带改动 [7] 的候选数断言)。
let rejectImages = false
function startFakeUpstream() {
  const handler = (req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      if (req.method === 'GET' && /\/models/.test(req.url)) {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ object: 'list', data: [{ id: MODEL }] }))
      }
      let p = {}
      try { p = JSON.parse(body) } catch {}
      lastChat = p
      if (Array.isArray(p.tools) && p.tools.length) {
        res.writeHead(400, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ error: { message: 'tools is not supported by this model', type: 'invalid_request_error' } }))
      }
      // 带图请求: 由 rejectImages 开关决定(见上)。措辞刻意用真实上游常见的那种
      // "does not support image input" —— 它必须能被 server.mjs 的 NO_VISION_RE 认出来。
      const hasImage = Array.isArray(p.messages) && p.messages.some((m) =>
        Array.isArray(m && m.content) && m.content.some((c) => c && (c.type === 'image_url' || c.type === 'image')))
      if (rejectImages && hasImage) {
        res.writeHead(400, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ error: { message: 'This model does not support image input', type: 'invalid_request_error' } }))
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        id: 'c1', object: 'chat.completion', model: MODEL,
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }))
    })
  }
  return new Promise((resolve) => {
    const s = http.createServer(handler)
    s.listen(UP_PORT, '127.0.0.1', () => resolve(s))
  })
}

const waitPort = async (port, timeout = 10000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    try { await fetch(`http://127.0.0.1:${port}/healthz`); return true } catch { await sleep(150) }
  }
  return false
}

function makeSandbox() {
  const dir = path.join(__dirname, 'sb-feat')
  resetSandboxDir(dir)
  fs.copyFileSync(path.join(ROOT, 'server.mjs'), path.join(dir, 'server.mjs'))
  // .sandbox 标记: 让 server.mjs 跳过 syncUpstreamWhitelist, 否则启动 600ms 内就会把
  // 下面这份精心构造的白名单覆盖成真实白名单, whitelistFor(127.0.0.1) 返回 null,
  // 免费闸门掉到启发式, 池子内容就不是我们构造的那个了。
  fs.writeFileSync(path.join(dir, '.sandbox'), '')
  fs.writeFileSync(path.join(dir, 'free_whitelist.json'), JSON.stringify({
    fetched_at: new Date().toISOString(),
    list_date: new Date().toISOString().slice(0, 10),
    hosts: { '127.0.0.1': { source: 'sandbox', models: [MODEL] } },
  }))
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    port: GW_PORT, proxy: '', gatewayKey: KEY, aliases: {},
    providers: [{
      id: 'ffff1111-2222-3333-4444-555555555555', name: PROVIDER, label: PROVIDER,
      base_url: `http://127.0.0.1:${UP_PORT}/v1`, keys: ['sk-feat-000'], api_key: 'sk-feat-000',
      model: MODEL, models: [MODEL], needs_proxy: false, enabled: true, ok: 3, err: 0,
      cooldownUntil: 0, lastSweepAt: new Date(Date.now() + 3600e3).toISOString(), disabledModels: {},
    }],
  }, null, 2))
  return dir
}

;(async () => {
  const realBefore = stableConfigView(REAL_CONFIG)
  const up = await startFakeUpstream()
  const dir = makeSandbox()
  const gw = spawn(NODE, ['server.mjs'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] })
  gw.stdout.on('data', () => {}); gw.stderr.on('data', () => {})
  if (!await waitPort(GW_PORT)) { console.log('沙箱网关未能启动，测试中止'); process.exit(1) }

  // 等"启动 3 秒后自动跑的那一轮目录扫描"落盘再动手 —— 与 gate-check 同一原因:
  // 抢在它前面改路由池, 结果会被它覆盖, 断言随机失败(看起来像被测代码坏了)。
  {
    const pidFile = path.join(dir, 'gateway.pid')
    const catFile = path.join(dir, 'free_catalog.json')
    let listenAt = 0
    try { listenAt = fs.statSync(pidFile).mtimeMs } catch {}
    for (let i = 0; i < 80; i++) {
      let catAt = 0
      try { catAt = fs.statSync(catFile).mtimeMs } catch {}
      if (listenAt && Date.now() - listenAt >= 3200 && catAt >= listenAt + 3000) break
      if (!listenAt && i > 40) break
      await sleep(100)
    }
  }

  const BASE = `http://127.0.0.1:${GW_PORT}`
  const j = async (p, opt) => {
    const r = await fetch(BASE + p, opt)
    const t = await r.text()
    let body
    try { body = JSON.parse(t) } catch { body = t }
    return { status: r.status, body, headers: r.headers }
  }
  const auth = { authorization: 'Bearer ' + KEY }
  const post = (p, o) => j(p, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(o || {}) })
  const chat = (o) => post('/v1/chat/completions', o)
  const native = (p, o, headers = {}) => j(p, { method: 'POST', headers: { ...auth, 'content-type': 'application/json', ...headers }, body: JSON.stringify(o || {}) })
  const models = async () => (await j('/v1/models', { headers: auth })).body

  try {
    // ── 1. 别名映射 ──
    console.log('\n[1] 模型别名')
    const a1 = await post('/api/aliases', { name: 'gpt-4o', target: 'auto' })
    chk('新增别名 gpt-4o -> auto', a1.status === 200 && a1.body.ok === true, JSON.stringify(a1.body))
    const a2 = await j('/api/aliases', { headers: auth })
    chk('GET 能读回该别名', a2.body.aliases && a2.body.aliases['gpt-4o'] === 'auto', JSON.stringify(a2.body))

    const a3 = await post('/api/aliases', { name: PROVIDER, target: 'auto' })
    chk('别名与已接入供应商同名 -> 400', a3.status === 400, JSON.stringify(a3.body))
    const a4 = await post('/api/aliases', { name: 'auto', target: 'x' })
    chk('占用内置名 auto -> 400', a4.status === 400, JSON.stringify(a4.body))
    const a5 = await post('/api/aliases', { name: 'chain1', target: 'gpt-4o' })
    chk('别名指向别名 -> 400（只解析一层）', a5.status === 400, JSON.stringify(a5.body))
    const a6 = await post('/api/aliases', { name: 'self', target: 'self' })
    chk('指向自己 -> 400', a6.status === 400, JSON.stringify(a6.body))

    const m1 = await models()
    const aliasEntry = (m1.data || []).find((x) => x.id === 'gpt-4o')
    chk('/v1/models 里能看到别名', !!aliasEntry && aliasEntry.owned_by === 'xiaoji-alias', JSON.stringify(aliasEntry))

    const c1 = await chat({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] })
    chk('用别名发请求能路由成功', c1.status === 200 && c1.body.choices, JSON.stringify(c1.body).slice(0, 160))
    chk('响应头 x-xiaoji-alias 标出别名', c1.headers.get('x-xiaoji-alias') === 'gpt-4o', String(c1.headers.get('x-xiaoji-alias')))

    const a7 = await post('/api/aliases', { name: 'nope', target: 'nosuchvendor/some-model' })
    chk('指向不存在的供应商仍可写入(不预判目标是否存在)', a7.status === 200, JSON.stringify(a7.body))
    const c2 = await chat({ model: 'nope', messages: [{ role: 'user', content: 'hi' }] })
    const msg2 = (c2.body && c2.body.error && c2.body.error.message) || ''
    chk('报错用的是**解析后的目标**而不是别名本身', c2.status === 404 && msg2.includes('nosuchvendor/some-model') && msg2.includes('别名 nope'), msg2.slice(0, 200))

    const a8 = await post('/api/aliases', { name: 'gpt-4o', target: '' })
    chk('target 传空串 = 删除该别名', a8.status === 200 && !a8.body.aliases['gpt-4o'], JSON.stringify(a8.body))
    const a9 = await post('/api/aliases', { name: 'gpt-4o', target: '' })
    chk('删除不存在的别名 -> 404', a9.status === 404, JSON.stringify(a9.body))

    // ── 2. 多模态: Anthropic / Gemini 的图片块必须被搬到上游 ──
    console.log('\n[2] 多模态图片跨协议搬运')
    lastChat = null
    const an1 = await native('/v1/messages', {
      model: `${PROVIDER}/${MODEL}`, max_tokens: 64,
      messages: [{
        role: 'user', content: [
          { type: 'text', text: '这是什么' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
        ],
      }],
    })
    chk('Anthropic 带图请求成功', an1.status === 200, JSON.stringify(an1.body).slice(0, 160))
    const ac = lastChat && lastChat.messages && lastChat.messages[0] && lastChat.messages[0].content
    chk('上游收到的是 parts 数组(不是被压成纯文本)', Array.isArray(ac), JSON.stringify(ac).slice(0, 160))
    chk('图片被转成 OpenAI 的 image_url 且是 data: 内联', Array.isArray(ac) && ac.some((p) => p.type === 'image_url' && /^data:image\/png;base64,/.test((p.image_url || {}).url || '')), JSON.stringify(ac).slice(0, 200))
    chk('文字部分仍在', Array.isArray(ac) && ac.some((p) => p.type === 'text' && p.text === '这是什么'), JSON.stringify(ac).slice(0, 200))

    lastChat = null
    const gm1 = await native(`/v1beta/models/${encodeURIComponent(PROVIDER + '/' + MODEL)}:generateContent`, {
      contents: [{ role: 'user', parts: [{ text: '这是什么' }, { inlineData: { mimeType: 'image/jpeg', data: '/9j/4AAQ' } }] }],
    })
    chk('Gemini 带图请求成功', gm1.status === 200, JSON.stringify(gm1.body).slice(0, 160))
    const gc = lastChat && lastChat.messages && lastChat.messages[0] && lastChat.messages[0].content
    chk('Gemini inlineData 被转成 image_url', Array.isArray(gc) && gc.some((p) => p.type === 'image_url' && /^data:image\/jpeg;base64,/.test((p.image_url || {}).url || '')), JSON.stringify(gc).slice(0, 200))

    // 纯文本这条老路径必须**一个字节都不变**(仍是字符串, 不是单元素数组)——
    // 否则所有历史客户端的请求形状都会变, 风险远大于收益。
    lastChat = null
    await native('/v1/messages', { model: `${PROVIDER}/${MODEL}`, max_tokens: 32, messages: [{ role: 'user', content: [{ type: 'text', text: '纯文本' }] }] })
    const pc = lastChat && lastChat.messages && lastChat.messages[0] && lastChat.messages[0].content
    chk('纯文本仍走字符串(老路径零变化)', typeof pc === 'string' && pc === '纯文本', JSON.stringify(pc))

    // ── 3. developer role 归一 ──
    console.log('\n[3] developer role 归一为 system')
    lastChat = null
    const d1 = await chat({ model: `${PROVIDER}/${MODEL}`, messages: [{ role: 'developer', content: '你是助手' }, { role: 'user', content: 'hi' }] })
    chk('带 developer role 的请求成功', d1.status === 200, JSON.stringify(d1.body).slice(0, 160))
    chk('上游收到的是 role=system', lastChat && lastChat.messages[0].role === 'system', JSON.stringify(lastChat && lastChat.messages[0]).slice(0, 120))

    // ── 4. 来源响应头 ──
    console.log('\n[4] 来源响应头')
    const h1 = await chat({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] })
    chk('x-xiaoji-provider 标出实际供应商', h1.headers.get('x-xiaoji-provider') === PROVIDER, String(h1.headers.get('x-xiaoji-provider')))
    chk('x-xiaoji-model 标出实际模型', h1.headers.get('x-xiaoji-model') === MODEL, String(h1.headers.get('x-xiaoji-model')))
    chk('x-xiaoji-attempts=1(一发命中)', h1.headers.get('x-xiaoji-attempts') === '1', String(h1.headers.get('x-xiaoji-attempts')))

    // ── 5. Prometheus /metrics ──
    console.log('\n[5] Prometheus /metrics')
    const mt = await j('/metrics')
    chk('200 且 content-type 是 text/plain', mt.status === 200 && /text\/plain/.test(mt.headers.get('content-type') || ''), mt.headers.get('content-type'))
    chk('含 xiaoji_uptime_seconds', /^xiaoji_uptime_seconds \d+/m.test(mt.body))
    chk('含逐供应商的 up 指标', new RegExp(`xiaoji_provider_up\\{provider="${PROVIDER}"\\} 1`).test(mt.body), String(mt.body).slice(0, 200))
    chk('含 # TYPE 声明(Prometheus 解析必需)', /# TYPE xiaoji_requests_total counter/.test(mt.body))
    chk('免鉴权也能读(与 /healthz 同定位)', mt.status === 200)

    // ── 6. 配置导出 / 导入 ──
    console.log('\n[6] 配置导出 / 导入')
    const ex = await post('/api/config/export', {})
    chk('导出成功', ex.status === 200 && ex.body.ok === true, JSON.stringify(ex.body).slice(0, 120))
    chk('导出内容含**明文** Key(掩码等于没导出)', ex.body.config.providers[0].api_key === 'sk-feat-000', JSON.stringify(ex.body.config.providers[0].api_key))
    const bad = await post('/api/config/import', { config: { providers: 'not-an-array' } })
    chk('坏配置 -> 400 且给出人话原因', bad.status === 400 && /providers/.test(bad.body.error || ''), JSON.stringify(bad.body))
    const st = await j('/api/state')
    chk('坏导入之后供应商数没变(什么都没写)', (st.body.providers || []).length === 1, String((st.body.providers || []).length))
    const good = await post('/api/config/import', { config: ex.body.config })
    chk('原样回灌 -> 200 且 providers 数不变', good.status === 200 && good.body.providers === 1, JSON.stringify(good.body))

    // ── 7. tools 实测学习（放最后: 它会让这个模型在带 tools 的请求里被剔除）──
    console.log('\n[7] tools 实测学习')
    const r0 = await j('/api/route?tools=1', { headers: auth })
    chk('学习前: 带 tools 的链里有 1 个候选', r0.body.candidates === 1, JSON.stringify(r0.body.candidates))
    const t1 = await chat({ model: 'auto', messages: [{ role: 'user', content: 'hi' }], tools: [{ type: 'function', function: { name: 'demo', parameters: { type: 'object' } } }] })
    chk('上游拒收 tools -> 请求失败(不谎报成功)', t1.status >= 400, String(t1.status))
    const m2 = await models()
    const entry = (m2.data || []).find((x) => x.id === `${PROVIDER}/${MODEL}`)
    chk('/v1/models 里该模型被标 x_tools:false', !!entry && entry.x_tools === false, JSON.stringify(entry))
    const r1 = await j('/api/route?tools=1', { headers: auth })
    chk('学习后: 带 tools 的链里不再有它', r1.body.candidates === 0, JSON.stringify(r1.body.candidates))
    const r2 = await j('/api/route', { headers: auth })
    chk('不带 tools 时它仍在链上(没有把整个模型封掉)', r2.body.candidates === 1, JSON.stringify(r2.body.candidates))

    // ── 8. 视觉实测学习（同 [7]: 会让这个模型在带图请求里被剔除, 所以也放最后）──
    console.log('\n[8] 视觉实测学习（带图请求优先视觉模型）')
    const has = (b) => (b.top || []).some((x) => x.model === MODEL)
    const v0 = await j('/api/route?vision=1&n=20', { headers: auth })
    chk('/api/route?vision=1 回 vision:true', v0.body.vision === true, String(v0.body.vision))
    chk('学习前: 带图请求的链里有它（名字无视觉信号只降档, 不排除）', has(v0.body), JSON.stringify((v0.body.top || []).map((x) => x.model)))
    // 让假上游开始拒收图片, 发一次真实带图请求 -> 失败并被记进 noVision
    rejectImages = true
    const iv = await chat({
      model: 'auto',
      messages: [{ role: 'user', content: [{ type: 'text', text: '这是什么' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } }] }],
    })
    chk('上游拒收图片 -> 请求失败(不谎报成功)', iv.status >= 400, String(iv.status))
    const m3 = await models()
    const e3 = (m3.data || []).find((x) => x.id === `${PROVIDER}/${MODEL}`)
    chk('/v1/models 里该模型被标 x_vision:false', !!e3 && e3.x_vision === false, JSON.stringify(e3))
    const v1 = await j('/api/route?vision=1&n=20', { headers: auth })
    chk('学习后: 带图请求的链里不再有它', !has(v1.body), JSON.stringify((v1.body.top || []).map((x) => x.model)))
    const v2 = await j('/api/route?n=20', { headers: auth })
    chk('不带图时它仍在链上(没有把整个模型封掉)', has(v2.body), JSON.stringify((v2.body.top || []).map((x) => x.model)))
    rejectImages = false
  } catch (e) {
    fail++
    console.log('  FAIL  测试过程抛出异常 -> ' + ((e && e.stack) || e))
  }

  // ── 收尾: 关沙箱 + 守"生产未被触碰" ──
  try { gw.kill() } catch {}
  try { up.close() } catch {}
  await sleep(300)
  const realAfter = stableConfigView(REAL_CONFIG)
  console.log('')
  chk('生产 config.json 未被触碰（供应商/模型/Key 摘要一致）', realBefore === realAfter, realBefore.slice(0, 12) + ' vs ' + realAfter.slice(0, 12))

  console.log(`\n═══ 新增功能: ${pass} 通过 / ${fail} 失败 ═══`)
  process.exit(fail ? 1 : 0)
})()
