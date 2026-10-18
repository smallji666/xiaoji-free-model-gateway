// 端到端验证: 限时活动巡检(含整页判定)在真实网关里的行为
// 验四件事:
//   ① 商汤被自动巡检到, 结论 free, 且仪表盘能把它显示成"限时免费中"(preset state = promo)
//   ② B.AI 的逐模型判定仍然工作(没被整页模式的改动破坏)
//   ③ health 里没有"静默失效"告警
//   ④ 覆盖缺口 unwatched 为空 —— 人工 PROMO 表里的厂商都已纳入自动巡检
const fs = require('fs')
const cfg = JSON.parse(fs.readFileSync('config.json', 'utf8'))
const key = cfg.key || cfg.gatewayKey || cfg.apiKey
const H = { authorization: 'Bearer ' + key, 'content-type': 'application/json' }
const base = 'http://127.0.0.1:8787'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0, fail = 0
const t = (name, ok, extra) => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`) }

;(async () => {
  // 等网关起来
  for (let i = 0; i < 30; i++) {
    try { const r = await fetch(base + '/healthz'); if (r.ok) break } catch {}
    await sleep(1000)
  }
  const hz = await (await fetch(base + '/healthz')).json()
  t('网关已就绪', hz && hz.ok === true, `providers=${hz && hz.providers}`)

  const before = await (await fetch(base + '/api/promo', { headers: H })).json()
  const at0 = (before.promo && before.promo.at) || ''
  console.log('   触发前巡检时间:', at0 || '(从未)')

  await fetch(base + '/api/promo?refresh=1', { headers: H })
  let p = null
  for (let i = 0; i < 40; i++) {
    await sleep(2000)
    const r = await (await fetch(base + '/api/promo', { headers: H })).json()
    p = r.promo
    if (p && p.at && p.at !== at0) break
  }
  t('巡检已执行并写入时间戳', !!(p && p.at && p.at !== at0), 'at=' + (p && p.at))

  const items = (p && p.items) || []
  const sn = items.filter((x) => x.key.startsWith('sensenova:'))
  const bai = items.filter((x) => x.key.startsWith('bai:'))
  t('商汤被自动巡检到', sn.length > 0, `${sn.length} 条: ${sn.map((x) => x.model + '=' + x.state).join(', ')}`)
  t('商汤结论 = free(公测免费档仍在)', sn.length > 0 && sn.every((x) => x.state === 'free'))
  t('B.AI 逐模型判定未受影响', bai.length > 0, `${bai.length} 条: ${bai.map((x) => x.model + '=' + x.state).join(', ')}`)
  // 上面那条只验证"有判定", 这条验证"判对了": 活动已结束就必须全是 paid, 不能混进 free。
  // B.AI 现在已从厂商列表隐藏, 这条是它唯一还在被校验的地方, 不能少。
  t('B.AI 结论 = paid(活动已结束, 没被误判成免费)', bai.length > 0 && bai.every((x) => x.state === 'paid'), bai.map((x) => x.model + '=' + x.state).join(', '))

  const health = (p && p.health) || []
  const bad = health.filter((h) => h.failCount > 0)
  t('巡检无"静默失效"告警', bad.length === 0, bad.length ? bad.map((h) => `${h.pname}: ${h.lastError}`).join(' | ') : health.map((h) => `${h.pname} ok(matched ${h.matched}/${h.total})`).join(', '))

  const unwatched = (p && p.unwatched) || []
  t('无"仅人工维护"的厂商(覆盖无缺口)', unwatched.length === 0, unwatched.length ? unwatched.map((u) => u.label).join(', ') : '人工表里的厂商都已自动巡检')
  t('watching 列表含两家', ((p && p.watching) || []).length === 2, ((p && p.watching) || []).map((w) => w.label).join(', '))

  // preset 档位: 商汤应显示为 promo(限时免费中), 而不是普通 free
  const st = await (await fetch(base + '/api/state', { headers: H })).json()
  const snp = (st.presets || []).find((x) => x.name === 'sensenova')
  t('商汤在厂商列表里显示为"限时免费中"', !!snp && snp.status.state === 'promo', snp ? JSON.stringify(snp.status).slice(0, 160) : 'not found')
  const baip = (st.presets || []).find((x) => x.name === 'bai')
  // B.AI 的限时活动已结束(转收费) -> 当前无免费档。按"无免费档的厂商不进候选列表"的产品约定
  // (用户 2026-09-19 要求"没免费名单的厂家不用显示出来", computePresets 只返回 free/promo),
  // 它应当**不在** presets 里, 而不是显示为 paid。判定本身由上面 promo_state 的逐模型结论守住。
  t('B.AI 无免费档 -> 已从厂商列表隐藏', !baip, baip ? '仍显示: ' + String(baip.status.note).slice(0, 80) : '已隐藏(符合预期)')

  console.log(`\n${fail ? '✗' : '✓'} ${pass}/${pass + fail} 通过`)
  process.exit(fail ? 1 : 0)
})().catch((e) => { console.error('ERR', e.message); process.exit(1) })
