#!/usr/bin/env node
/*
 * 免费判定依据 受控测试 —— 验证 judgeFree 的每个出口都能给出「哪一层 + 为什么」，且 /api/why 如实暴露。
 *
 * 为什么需要它：判定引擎返回 boolean 时，"这个模型为什么被判免费"只能靠读代码推。
 * 判定不可解释 = 不可审计 = 不可验证 —— 外人只能相信 README 的叙述。
 * 这个套件把**历史事故**钉成回归用例（见 [3]，glm-5.3-flash 那条）：
 *   README 第三节写过"曾用『名字含 flash 即免费』的规则，把智谱收费模型误判进池"，
 *   但在此之前没有任何测试守着它。
 *
 * ⚠ 沙箱运行(8814)，config.json **全部使用假 Key**，首尾各算一次生产 config.json 哈希做"没碰生产"守卫。
 * 用法：node test/why-check.cjs
 */
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')

const ROOT = (() => { const _fs = require('fs'), _p = require('path'); let d = _p.dirname(__dirname); for (let i = 0; i < 6; i++) { if (_fs.existsSync(_p.join(d, 'server.mjs'))) return d; d = _p.dirname(d) } return _p.join(__dirname, '..') })()
const SB = path.join(__dirname, 'sb-why')
const { freshSandbox } = require('./sb-util.cjs')
const PORT = 8814
const FAKE_KEY = 'FAKE-KEY-NOT-REAL-0000'

let pass = 0
let fail = 0
const t = (name, ok, extra = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}${extra ? '  → ' + extra : ''}`) }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function req(p) {
  return new Promise((resolve, reject) => {
    const r = http.get({ host: '127.0.0.1', port: PORT, path: p, timeout: 8000 }, (x) => {
      let b = ''
      x.on('data', (d) => { b += d })
      x.on('end', () => {
        try { resolve({ code: x.statusCode, body: JSON.parse(b) }) }
        catch { resolve({ code: x.statusCode, body: b }) }
      })
    })
    r.on('error', reject)
    r.on('timeout', () => { r.destroy(); reject(new Error('timeout')) })
  })
}

const hashProd = () => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'config.json'))).digest('hex').slice(0, 16)

function buildSandbox() {
  freshSandbox(SB)
  fs.mkdirSync(SB, { recursive: true })
  fs.copyFileSync(path.join(ROOT, 'server.mjs'), path.join(SB, 'server.mjs'))
  // ⚠ .sandbox 标记：让 server.mjs 启动时跳过 syncUpstreamWhitelist（见 server.mjs 里的沙箱短路）。
  //   不写它 → 启动 1 秒内就去外网拉源，一边可能把下面这份夹具覆盖掉，一边在没网时刷一堆 WARN。
  fs.writeFileSync(path.join(SB, '.sandbox'), '')
  fs.writeFileSync(path.join(SB, 'free_whitelist.json'), JSON.stringify(buildWhitelistFixture(), null, 2))
  // 假配置：base_url 用真实域名（白名单按 hostname 匹配），Key 全是假的
  fs.writeFileSync(path.join(SB, 'config.json'), JSON.stringify({
    port: PORT,
    proxy: '',
    gatewayKey: 'whycheck-' + '0'.repeat(32),
    configVersion: 2,
    aliases: {},
    providers: [
      { id: 'w1', name: 'gemini', label: 'gemini', base_url: 'https://generativelanguage.googleapis.com/v1beta', enabled: true, keys: [FAKE_KEY], models: ['models/gemini-3.5-flash'] },
      { id: 'w2', name: 'mistral', label: 'mistral', base_url: 'https://api.mistral.ai/v1', enabled: true, keys: [FAKE_KEY], models: ['codestral-2508'] },
      { id: 'w3', name: 'groq', label: 'groq', base_url: 'https://api.groq.com/openai/v1', enabled: true, keys: [FAKE_KEY], models: ['llama-3.3-70b-versatile'] },
    ],
  }, null, 2))
}

// 白名单夹具必须**确定性** —— 断言用到的模型名不能被"上游今天发什么"牵着走。
// 实测 2026-10-08：gemini 的免费模型从 gemini-3.5-flash 换成了 gemini-3.6-flash，
// 于是"白名单命中 → layer=whitelist"这条断言变红，而判定逻辑一行都没改。
// 这与项目自己的原则一致：把真实源换成确定性桩，否则每隔几天就要改一次测试。
// 做法：以真实白名单为底（保住其它 host，避免影响别的判定分支），只把断言依赖的
// 两家 host 的**来源名与模型名补进去**（并集，不删原有条目）。
function buildWhitelistFixture() {
  let base = {}
  try { base = JSON.parse(fs.readFileSync(path.join(ROOT, 'free_whitelist.json'), 'utf8')) } catch { /* 没有就用空底 */ }
  const now = new Date().toISOString()
  const hosts = Object.assign({}, base.hosts)
  const pin = (host, source, models) => {
    const cur = hosts[host] || {}
    hosts[host] = Object.assign({ openFree: false, hybrid: false }, cur, {
      source: source || cur.source || host,
      models: [...new Set([...(cur.models || []), ...models])],
    })
  }
  pin('generativelanguage.googleapis.com', 'Google Gemini', ['gemini-3.5-flash'])
  pin('api.mistral.ai', 'Mistral AI', ['codestral-2508'])
  return Object.assign({}, base, { fetched_at: now, list_date: now.slice(0, 10), hosts })
}

async function main() {
  const before = hashProd()
  buildSandbox()
  const child = spawn(process.execPath, ['server.mjs'], { cwd: SB, stdio: 'ignore' })
  let up = false
  try {
    for (let i = 0; i < 60; i++) {
      try { const r = await req('/healthz'); if (r.code === 200) { up = true; break } } catch { /* 还没起来 */ }
      await sleep(250)
    }
    if (!up) throw new Error('沙箱网关未起来（8814）')

    console.log('[1] /api/why 基本契约')
    const r1 = await req('/api/why?provider=gemini&model=models/gemini-3.5-flash')
    t('返回 200', r1.code === 200, 'code=' + r1.code)
    t('带 free / layer / reason 三个字段',
      typeof r1.body.free === 'boolean' && !!r1.body.layer && !!r1.body.reason,
      JSON.stringify(r1.body).slice(0, 180))
    t('meta_available 如实标 false（元数据扫描后就丢弃了，不能假装能复现）', r1.body.meta_available === false)
    t('回显 whitelist 命中详情（来源 + 是否命中）', !!r1.body.whitelist && typeof r1.body.whitelist.hit === 'boolean',
      JSON.stringify(r1.body.whitelist))

    console.log('[2] 四层判定各走一遍（依据必须指向正确的那一层）')
    const wlHit = await req('/api/why?provider=gemini&model=models/gemini-3.5-flash')
    t('白名单命中 → layer=whitelist', wlHit.body.free === true && wlHit.body.layer === 'whitelist',
      `${wlHit.body.free}/${wlHit.body.layer}`)
    t('理由里带出白名单来源名', /Google Gemini/.test(String(wlHit.body.reason)), wlHit.body.reason)

    const deny = await req('/api/why?provider=gemini&model=gemini-2.5-pro')
    t('名字含独立词 pro → layer=deny（硬排除优先于白名单）',
      deny.body.free === false && deny.body.layer === 'deny', `${deny.body.free}/${deny.body.layer}`)

    const closed = await req('/api/why?provider=mistral&model=glm-5.3-flash')
    t('封闭名单厂商 + 名字像免费 → layer=closed-list（**glm-5.3-flash 历史误判回归**）',
      closed.body.free === false && closed.body.layer === 'closed-list', `${closed.body.free}/${closed.body.layer}`)

    const openFree = await req('/api/why?provider=groq&model=llama-3.3-70b-versatile')
    t('开放视野厂商名单外 → layer=open-free（可见即免费）',
      openFree.body.free === true && openFree.body.layer === 'open-free', `${openFree.body.free}/${openFree.body.layer}`)

    const notChat = await req('/api/why?provider=mistral&model=text-embedding-3-small')
    t('嵌入模型 → layer=not-chat（非文字对话不接入）',
      notChat.body.free === false && notChat.body.layer === 'not-chat', `${notChat.body.free}/${notChat.body.layer}`)

    const mistralHit = await req('/api/why?provider=mistral&model=codestral-2508')
    t('mistral 名单内模型 → layer=whitelist', mistralHit.body.free === true && mistralHit.body.layer === 'whitelist',
      `${mistralHit.body.free}/${mistralHit.body.layer}`)

    console.log('[3] 判定结果与实际去向必须对得上')
    const inPool = await req('/api/why?provider=gemini&model=models/gemini-3.5-flash')
    t('在池模型 in_pool=true', inPool.body.in_pool === true)
    t('未在池的模型 in_pool=false 且给出 blocked/quarantine/disabled 三态', (() => {
      return inPool.body.blocked === false && inPool.body.quarantine === null && inPool.body.disabled === false
    })())
    const outPool = await req('/api/why?provider=gemini&model=gemini-2.5-pro')
    t('判收费的模型不在池', outPool.body.in_pool === false)

    console.log('[4] 非法入参给出可读错误')
    const noArgs = await req('/api/why')
    t('缺参数 → 400 且说明要哪两个参数', noArgs.code === 400 && /provider/.test(String(noArgs.body.error)), `code=${noArgs.code}`)
    const noProv = await req('/api/why?provider=nosuchvendor&model=x')
    t('未知供应商 → 404 且列出可用供应商', noProv.code === 404 && Array.isArray(noProv.body.providers) && noProv.body.providers.length === 3,
      `code=${noProv.code} providers=${JSON.stringify(noProv.body.providers)}`)

    console.log('[5] 生产未被触碰')
    t('生产 config.json 哈希未变', hashProd() === before)
  } finally {
    try { child.kill() } catch { /* 已退出 */ }
    await sleep(400)
    try { freshSandbox(SB) } catch { /* 清理失败不掩盖断言结果 */ }
  }

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error('套件异常:', (e && e.message) || e)
  try { freshSandbox(SB) } catch { /* ignore */ }
  process.exit(1)
})
