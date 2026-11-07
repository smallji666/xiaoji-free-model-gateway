#!/usr/bin/env node
/*
 * auto 路由 · 实况探针（只读，不碰生产 8787，不打上游）
 *
 * 与 route-invariant-check.cjs 的区别：那个用**假夹具**验证"不变量"，这个用**真实 config.json**
 * 把当前真实池子里的链序打出来 —— 用来回答"用户这条请求实际会先走哪个模型、排第几"。
 *
 * /api/route 是只读的（不发上游请求），所以这里跑一遍不会消耗任何免费额度。
 * 沙箱端口 8815，与生产 8787 / 其它测试套件都错开。
 *
 * 用法：node test/probe-route.cjs
 */
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')

const ROOT = (() => { const _fs = require('fs'), _p = require('path'); let d = _p.dirname(__dirname); for (let i = 0; i < 6; i++) { if (_fs.existsSync(_p.join(d, 'server.mjs'))) return d; d = _p.dirname(d) } return _p.join(__dirname, '..') })()
const SB = path.join(__dirname, 'sb-probe')
const { freshSandbox } = require('./sb-util.cjs')
const PORT = 8815
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function buildSandbox() {
  freshSandbox(SB)
  fs.mkdirSync(SB, { recursive: true })
  fs.copyFileSync(path.join(ROOT, 'server.mjs'), path.join(SB, 'server.mjs'))
  // 真实 config：只改端口，其余原样（池子/学习到的延迟/冷却都是真实的）
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'))
  cfg.port = PORT
  fs.writeFileSync(path.join(SB, 'config.json'), JSON.stringify(cfg, null, 2))
  for (const f of ['free_whitelist.json', 'free_catalog.json']) {
    const src = path.join(ROOT, f)
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(SB, f))
  }
  return cfg
}

function req(p) {
  return new Promise((resolve, reject) => {
    const r = http.get({ host: '127.0.0.1', port: PORT, path: p, timeout: 15000 }, (x) => {
      let b = ''
      x.on('data', (d) => { b += d })
      x.on('end', () => { try { resolve({ code: x.statusCode, body: JSON.parse(b) }) } catch { resolve({ code: x.statusCode, body: b }) } })
    })
    r.on('error', reject)
    r.on('timeout', () => { r.destroy(); reject(new Error('timeout')) })
  })
}

const SCENES = [
  ['闲聊（无工具/单轮）', '/api/route?n=6'],
  ['agent（带工具+多轮）', '/api/route?n=6&tools=1&messages=10'],
  ['agent + 代码题（WorkBuddy 真实形态）', '/api/route?n=6&tools=1&messages=10&ask=' + encodeURIComponent('帮我写个排序函数，这段代码为什么报错')],
  ['agent + 数学题', '/api/route?n=6&tools=1&messages=10&ask=' + encodeURIComponent('求解这个方程并证明该定理')],
  ['带图（工具+图+多轮）', '/api/route?n=6&tools=1&messages=10&vision=1'],
  ['长上下文（40万字符）', '/api/route?n=6&tools=1&chars=400000'],
]

async function main() {
  buildSandbox()
  const child = spawn(process.execPath, ['server.mjs'], { cwd: SB, stdio: 'ignore' })
  try {
    let up = false
    for (let i = 0; i < 60; i++) {
      try { const r = await req('/healthz'); if (r.code === 200) { up = true; break } } catch {}
      await sleep(250)
    }
    if (!up) throw new Error('探针网关未起来（' + PORT + '）')
    for (const [name, q] of SCENES) {
      const b = (await req(q)).body
      const top = (b.top || [])
      console.log(`\n=== ${name} ===`)
      console.log(`  候选 ${b.candidates} · req_tier ${b.request_tier} · task ${b.task} · 权重 ${JSON.stringify(b.weights)}`)
      for (const x of top) {
        const flag = [x.route_rank === 2 ? '硬门槛' : '', x.route_rank === 1 ? '不领跑' : '',
          (x.demoted || []).join('+')].filter(Boolean).join(' ')
        const lat = x.samples ? `lat=${x.samples.lat_model}/${x.samples.lat_prov}(conf ${x.samples.lat_conf})` : ''
        const pw = x.parts || {}
        console.log(`  #${x.rank} rr=${x.route_rank} ${String(x.score).slice(0, 5)}  ${x.provider}/${x.model}  tier=${x.tier} ttfb=${x.ttfb_ms} ${lat} ${flag}`)
        console.log(`        parts: tier=${pw.tier} q=${pw.quality} av=${pw.avail} sp=${pw.speed} ld=${pw.load}`)
      }
    }
  } finally {
    try { child.kill() } catch {}
    await sleep(200)
    try { freshSandbox(SB) } catch {}
  }
}
main().catch((e) => { console.error(e); process.exit(1) })
