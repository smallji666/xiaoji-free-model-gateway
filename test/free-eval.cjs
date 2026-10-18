#!/usr/bin/env node
/*
 * 免费判定 · 事故回归库 + 准确率评估
 *
 * 为什么存在：README 第三节写满了血泪教训（cerebras 被社区源误标 openFree、智谱 glm-5.3-flash
 * 因「名字含 flash」被误判进池、Kilo 的 -1 负定价被当信息不足放行…），但**在本次改造前，
 * 这些教训一条都没变成测试** —— 它们只是散文。散文不会在回归时报警。
 *
 * 这个套件把每一条事故钉成**可执行样本**，并通过 POST /api/why 注入上游元数据，
 * 跑**完整四层判定**，最后给出准确率。离线可跑（沙箱 8800 + 假 Key + 假上游，不碰生产、不碰网络）。
 *
 * ⚠ 样本会依赖 free_whitelist.json 的真实数据。数据漂移时**必须报出来**，不能静默通过 ——
 *   所以开头有前置条件自校验（见 PRE），条件不成立就明说"样本假设已失效，请核对"。
 *
 * 用法：node test/free-eval.cjs
 */
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')

const ROOT = (() => { const _fs = require('fs'), _p = require('path'); let d = _p.dirname(__dirname); for (let i = 0; i < 6; i++) { if (_fs.existsSync(_p.join(d, 'server.mjs'))) return d; d = _p.dirname(d) } return _p.join(__dirname, '..') })()
const SB = path.join(__dirname, 'sb-eval')
const { freshSandbox } = require('./sb-util.cjs')
const PORT = 8800
const GW_KEY = 'evalcheck-' + '0'.repeat(32)
const FAKE_KEY = 'FAKE-KEY-NOT-REAL-0000'

let pass = 0
let fail = 0
const t = (name, ok, extra = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}${extra ? '  → ' + extra : ''}`) }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const WL = JSON.parse(fs.readFileSync(path.join(ROOT, 'free_whitelist.json'), 'utf8')).hosts
const firstModel = (host) => ((WL[host] && WL[host].models) || [])[0] || null

// ── 前置条件：样本的假设必须与当前白名单数据一致，否则"通过"没有意义 ──
const PRE = [
  ['cerebras 仍是封闭名单（models 空 + force 覆盖社区源）',
    () => WL['api.cerebras.ai'] && WL['api.cerebras.ai'].openFree === false && (WL['api.cerebras.ai'].models || []).length === 0],
  ['longcat 仍是封闭名单（models 空）',
    () => WL['api.longcat.chat'] && WL['api.longcat.chat'].openFree === false && (WL['api.longcat.chat'].models || []).length === 0],
  ['groq 仍是开放视野（openFree=true）', () => WL['api.groq.com'] && WL['api.groq.com'].openFree === true],
  ['gemini 仍是 hybrid', () => WL['generativelanguage.googleapis.com'] && WL['generativelanguage.googleapis.com'].hybrid === true],
  ['智谱仍是封闭名单且名单非空',
    () => WL['open.bigmodel.cn'] && !WL['open.bigmodel.cn'].openFree && !WL['open.bigmodel.cn'].hybrid && (WL['open.bigmodel.cn'].models || []).length > 0],
  ['openrouter 名单里有 :free 模型', () => ((WL['openrouter.ai'] && WL['openrouter.ai'].models) || []).some((m) => /:free$/.test(m))],
]

// ── 样本库：每条 story 都对应一次真实误判或一条设计边界 ──
const CASES = [
  // ═══ A. 历史事故回归 ═══
  {
    id: 'cerebras-force',
    story: '2026-09 cerebras 事件：社区源仍把它标为 openFree，force 一旦失效付费模型就会被当免费放行',
    provider: 'cerebras', model: 'llama-3.3-70b',
    meta: null, expect: { free: false, layer: 'closed-list' },
  },
  {
    id: 'longcat-no-daily-free',
    story: 'LongCat 2026-06 取消每日免费额度（一次性赠送不算常态免费）',
    provider: 'longcat', model: 'LongCat-Flash',
    meta: null, expect: { free: false, layer: 'closed-list' },
  },
  {
    id: 'zhipu-flash-not-free',
    story: '「名字含 flash 即免费」的旧规则曾把智谱收费模型误判进池 —— 付费 plan 的 Key 一调就真扣钱',
    provider: 'zhipu', model: 'glm-5.3-flash',
    meta: null, expect: { free: false, layer: 'closed-list' },
  },
  {
    id: 'gemini-pro-mislisted',
    story: 'gemini-2.5-pro 被上游免费清单误收（Google 免费层早已不含 Pro）→ 硬排除必须压过清单',
    provider: 'gemini', model: 'gemini-2.5-pro',
    meta: { id: 'gemini-2.5-pro' }, expect: { free: false, layer: 'deny' },
  },
  {
    id: 'kilo-negative-pricing',
    story: 'Kilo 的 -1 负定价 = 按实际路由到的模型计费；旧代码返回 null(信息不足) 会被 openFree 无条件放行',
    provider: 'kilo', model: 'kilo-auto/frontier',
    meta: { id: 'kilo-auto/frontier', pricing: { prompt: '-1', completion: '-1' } },
    expect: { free: false, layer: 'meta-paid' },
  },
  {
    id: 'trusted-vendor-paid',
    story: '可信定价厂商明确收费 → 直接弃掉，不给白名单兜底机会',
    provider: 'openrouter', model: 'openai/gpt-4o',
    meta: { id: 'openai/gpt-4o', pricing: { prompt: '2.5', completion: '10' } },
    expect: { free: false, layer: 'meta-paid' },
  },

  // ═══ B. 四层判定正例 ═══
  {
    id: 'or-free-tag',
    story: 'OpenRouter 的 :free 后缀是硬标记 → 元数据层直接判免费（优先级最高）',
    provider: 'openrouter', model: 'some-vendor/some-model:free',
    meta: { id: 'some-vendor/some-model:free' }, expect: { free: true, layer: 'meta' },
  },
  {
    id: 'zhipu-in-list',
    story: '封闭名单厂商：在名单内 = 免费',
    provider: 'zhipu', model: firstModel('open.bigmodel.cn'),
    meta: null, expect: { free: true, layer: 'whitelist' },
  },
  {
    id: 'or-in-list',
    story: 'OpenRouter 名单内模型（:free）→ 白名单层',
    provider: 'openrouter', model: ((WL['openrouter.ai'] || {}).models || []).find((m) => /:free$/.test(m)),
    meta: null, expect: { free: true, layer: 'whitelist' },
  },
  {
    id: 'groq-open-free',
    story: '开放视野厂商：免费 Key 看不到收费模型，名单外仍放行',
    provider: 'groq', model: 'llama-3.3-70b-versatile',
    meta: null, expect: { free: true, layer: 'open-free' },
  },
  {
    id: 'gemini-hybrid-in-list',
    story: 'hybrid 厂商（gemini）：名单内命中',
    provider: 'gemini', model: firstModel('generativelanguage.googleapis.com'),
    meta: null, expect: { free: true, layer: 'whitelist' },
  },
  {
    id: 'gemini-hybrid-rule-miss',
    story: 'hybrid 厂商名单外 → 交给兜底规则；名字里没有 free，必须拒',
    provider: 'gemini', model: 'gemini-4-experimental',
    meta: null, expect: { free: false, layer: 'rule' },
  },
  {
    id: 'custom-rule-hit',
    story: '无白名单的自定义厂商 → 兜底启发式只认名字里明确的 free',
    provider: 'custom', model: 'my-free-model',
    meta: null, expect: { free: true, layer: 'rule' },
  },
  {
    id: 'custom-rule-miss',
    story: '无白名单的自定义厂商，名字不含 free → 绝不按 flash/lite/8b 猜测',
    provider: 'custom', model: 'some-flash-lite-8b',
    meta: null, expect: { free: false, layer: 'rule' },
  },

  // ═══ C. 非文字对话模型（设计边界，不是漏扫）═══
  {
    id: 'embedding',
    story: '嵌入模型即使免费也不接：统一入口是 /chat/completions',
    provider: 'mistral', model: 'mistral-embed',
    meta: null, expect: { free: false, layer: 'not-chat' },
  },
  {
    id: 'audio-by-modality',
    story: '靠上游 output_modalities 识别（名字完全看不出来）',
    provider: 'custom', model: 'some-model-x',
    meta: { id: 'some-model-x', output: ['audio'] }, expect: { free: false, layer: 'not-chat' },
  },

  // ═══ D. 优先级边界 ═══
  {
    id: 'meta-beats-closed-list',
    story: ':free 硬标记压过封闭名单 —— 元数据层优先级最高',
    provider: 'zhipu', model: 'glm-9-not-in-list:free',
    meta: { id: 'glm-9-not-in-list:free' }, expect: { free: true, layer: 'meta' },
  },
  {
    id: 'not-chat-beats-meta-free',
    story: '非对话模型压过免费元数据 —— 它再免费也不进文字对话池',
    provider: 'custom', model: 'embedding-x:free',
    meta: { id: 'embedding-x:free' }, expect: { free: false, layer: 'not-chat' },
  },
]

const hashProd = () => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'config.json'))).digest('hex').slice(0, 16)

const PROVIDERS = [
  ['gemini', 'https://generativelanguage.googleapis.com/v1beta'],
  ['mistral', 'https://api.mistral.ai/v1'],
  ['groq', 'https://api.groq.com/openai/v1'],
  ['openrouter', 'https://openrouter.ai/api/v1'],
  ['cerebras', 'https://api.cerebras.ai/v1'],
  ['zhipu', 'https://open.bigmodel.cn/api/paas/v4'],
  ['kilo', 'https://api.kilo.ai/api/v1'],
  ['longcat', 'https://api.longcat.chat/openai/v1'],
  ['custom', 'https://my-custom-llm.example.com/v1'],   // 不在白名单 → 走兜底规则层
]

const UP_PORT = 8803

function buildSandbox() {
  freshSandbox(SB)
  fs.mkdirSync(SB, { recursive: true })
  fs.copyFileSync(path.join(ROOT, 'server.mjs'), path.join(SB, 'server.mjs'))
  // 白名单：真表 + 一条指向假上游的注入条目 —— 让"白名单层"的判定与落盘也能离线验证。
  // fetched_at 置为当下，避免 refreshCatalog 触发一次注定失败的上游同步。
  const wl = JSON.parse(fs.readFileSync(path.join(ROOT, 'free_whitelist.json'), 'utf8'))
  wl.hosts['127.0.0.1'] = { source: 'EvalFake', models: ['glm-4.7-flash'], openFree: false, hybrid: false }
  wl.fetched_at = new Date().toISOString()
  fs.writeFileSync(path.join(SB, 'free_whitelist.json'), JSON.stringify(wl, null, 2))
  fs.writeFileSync(path.join(SB, 'config.json'), JSON.stringify({
    port: PORT, proxy: '', gatewayKey: GW_KEY, configVersion: 2, aliases: {},
    providers: [
      // 这些只用来给 /api/why 提供 host（判定不联网），设 enabled:false 以免扫描时白等
      ...PROVIDERS.map(([name, base_url], i) => ({
        id: 'e' + i, name, label: name, base_url, enabled: false, keys: [FAKE_KEY], models: [],
      })),
      // 走假上游的这家：hostname 127.0.0.1 命中上面注入的白名单条目
      { id: 'e-scan', name: 'sbscan', label: 'sbscan', base_url: `http://127.0.0.1:${UP_PORT}/v1`, enabled: true, keys: [FAKE_KEY], models: [] },
    ],
  }, null, 2))
}

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null
    const headers = data
      ? { 'content-type': 'application/json', authorization: 'Bearer ' + GW_KEY, 'content-length': Buffer.byteLength(data) }
      : {}
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers, timeout: 8000 }, (x) => {
      let b = ''
      x.on('data', (d) => { b += d })
      x.on('end', () => { try { resolve({ code: x.statusCode, body: JSON.parse(b) }) } catch { resolve({ code: x.statusCode, body: b }) } })
    })
    r.on('error', reject)
    r.on('timeout', () => { r.destroy(); reject(new Error('timeout')) })
    if (data) r.write(data)
    r.end()
  })
}

async function main() {
  const before = hashProd()
  // 假上游：只回答 /v1/models，让沙箱网关真的跑一次目录扫描（验证"依据落盘"看的是数据，不是代码）
  const upSrv = http.createServer((rq, rs) => {
    if (/\/models/.test(rq.url || '')) {
      rs.writeHead(200, { 'content-type': 'application/json' })
      return rs.end(JSON.stringify({ data: [{ id: 'glm-4.7-flash' }, { id: 'my-free-model' }, { id: 'text-embedding-3-small' }] }))
    }
    rs.writeHead(404, { 'content-type': 'application/json' })
    rs.end('{}')
  })
  await new Promise((r) => upSrv.listen(UP_PORT, '127.0.0.1', r))

  console.log('[0] 前置条件（白名单数据必须仍符合样本假设）')
  let preOk = true
  for (const [name, fn] of PRE) {
    let ok = false
    try { ok = !!fn() } catch { ok = false }
    if (!ok) preOk = false
    t(name, ok, ok ? '' : '样本假设已失效，请核对 free_whitelist.json 与本文件的 CASES')
  }
  if (!preOk) console.log('  ⚠ 前置条件不成立 —— 下面的样本结论不可信，先核对样本再跑')

  buildSandbox()
  const child = spawn(process.execPath, ['server.mjs'], { cwd: SB, stdio: 'ignore' })
  let up = false
  try {
    for (let i = 0; i < 60; i++) {
      try { const r = await req('GET', '/healthz'); if (r.code === 200) { up = true; break } } catch { /* 还没起来 */ }
      await sleep(250)
    }
    if (!up) throw new Error('沙箱网关未起来（' + PORT + '）')

    console.log('\n[1] 事故回归 + 四层判定（POST /api/why 注入元数据，跑完整判定链）')
    let hit = 0
    for (const c of CASES) {
      const r = await req('POST', '/api/why', { provider: c.provider, model: c.model, meta: c.meta })
      const b = r.body || {}
      const ok = r.code === 200 && b.free === c.expect.free && b.layer === c.expect.layer
      if (ok) hit++
      const got = `free=${b.free} layer=${b.layer}`
      const want = `free=${c.expect.free} layer=${c.expect.layer}`
      t(`${c.id.padEnd(24)} ${ok ? '' : `[期望 ${want} / 实得 ${got}]`}`, ok,
        ok ? '' : `(${c.provider}/${c.model}) ${b.reason || b.error || ''}`)
      if (!ok) console.log(`        ↳ 事故背景：${c.story}`)
    }

    console.log('\n[2] POST 确实跑了元数据层（GET 拿不到）')
    const g = await req('GET', '/api/why?provider=openrouter&model=some-vendor/some-model:free')
    t('GET 未给 meta → meta_available=false', g.body.meta_available === false)
    const p = await req('POST', '/api/why', { provider: 'openrouter', model: 'some-vendor/some-model:free', meta: { id: 'some-vendor/some-model:free' } })
    t('POST 给了 meta → meta_available=true', p.body.meta_available === true)
    t('POST 能判出元数据层（layer=meta）', p.body.layer === 'meta', 'layer=' + p.body.layer)

    console.log('\n[3] 判定依据真的落盘了（看 catalog 数据，不看代码在跑）')
    await req('GET', '/api/catalog?refresh=1')
    let ce = null
    for (let i = 0; i < 40; i++) {
      await sleep(250)
      const cat = await req('GET', '/api/catalog')
      ce = ((cat.body && cat.body.catalog && cat.body.catalog.providers) || []).find((x) => x.name === 'sbscan')
      if (ce && Array.isArray(ce.models) && ce.models.length) break
    }
    t('扫描后 catalog 里出现该供应商', !!ce, '没找到 sbscan（扫描可能没跑完）')
    const m0 = ce && Array.isArray(ce.models) ? ce.models[0] : null
    t('模型条目带 why（判定所在层）', !!(m0 && m0.why), m0 ? JSON.stringify(m0) : '无条目')
    t('why 正确指向白名单层', !!(m0 && m0.why === 'whitelist'), m0 ? 'why=' + m0.why : '')
    t('厂商级 why_source 记录了白名单来源', !!(ce && ce.why_source === 'EvalFake'), ce ? 'why_source=' + ce.why_source : '')
    t('名单外、名字像免费的模型没进池（closed-list）', !!(ce && !ce.models.some((m) => m.id === 'my-free-model')))
    t('非对话模型没进池（not-chat）', !!(ce && !ce.models.some((m) => /embedding/.test(m.id))))

    console.log('\n[4] 生产未被触碰')
    t('生产 config.json 哈希未变', hashProd() === before)

    const total = CASES.length
    console.log(`\n准确率: ${hit}/${total} = ${total ? Math.round((hit / total) * 100) : 0}%`)
    console.log(`结果: ${pass} 通过 / ${fail} 失败`)
  } finally {
    try { child.kill() } catch { /* 已退出 */ }
    try { upSrv.close() } catch { /* 已关闭 */ }
    await sleep(400)
    try { freshSandbox(SB) } catch { /* 清理失败不掩盖断言结果 */ }
  }
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error('套件异常:', (e && e.message) || e)
  try { freshSandbox(SB) } catch { /* ignore */ }
  process.exit(1)
})
