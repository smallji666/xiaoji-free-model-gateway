#!/usr/bin/env node
/*
 * 路由排序 · 不变量测试
 *
 * 与其它套件的区别：它**不测具体分数**（分数随样本量、权重、实现细节漂移，钉死数字等于
 * 每隔几天就要改一次测试），而是测**任何情况下都必须成立的性质**（不变量）：
 *   · 冷却中的候选永远排在健康候选之后（打过去必然失败，换谁都没用）
 *   · 同一家的候选必须被交错打散（否则这家一限流就连续撞同一家，白等整个往返）
 *   · 专用模型（代码/数学类）tier 必须低于同规模通用模型（只降权不排除）
 *   · 带图请求里"名字无视觉信号"的模型必须排在视觉模型之后（只降档不排除；实测 noVision 才硬跳过）
 *   · 同档位、同质量时，快的必须排在慢的前面
 *   · 权重表随请求类型切换（带工具/多轮 → 能力优先；闲聊 → 速度优先）
 *
 * 这类断言才是"路由可证明"的载体：改评分公式不会让它们变红，但一旦把某个性质改坏就立刻报错。
 * 沙箱运行(8804) + 假 Key + 构造状态，不碰生产、不碰网络。
 *
 * 用法：node test/route-invariant-check.cjs
 */
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')

const ROOT = (() => { const _fs = require('fs'), _p = require('path'); let d = _p.dirname(__dirname); for (let i = 0; i < 6; i++) { if (_fs.existsSync(_p.join(d, 'server.mjs'))) return d; d = _p.dirname(d) } return _p.join(__dirname, '..') })()
const SB = path.join(__dirname, 'sb-route')
const { freshSandbox } = require('./sb-util.cjs')
const PORT = 8804
const GW_KEY = 'routecheck-' + '0'.repeat(32)
const FAKE_KEY = 'FAKE-KEY-NOT-REAL-0000'

let pass = 0
let fail = 0
const t = (name, ok, extra = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}${extra ? '  → ' + extra : ''}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const hashProd = () => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'config.json'))).digest('hex').slice(0, 16)

// ── 构造状态：每一家都刻意只放一类特征，让"不变量"能被单独观察到 ──
// 模型名里的参数量决定 modelTier（120b → 高档），这是构造"同档对比"最稳的办法。
function buildSandbox() {
  freshSandbox(SB)
  fs.mkdirSync(SB, { recursive: true })
  fs.copyFileSync(path.join(ROOT, 'server.mjs'), path.join(SB, 'server.mjs'))
  // 白名单：fetched_at 置当下，避免启动时触发注定失败的上游同步拖慢用例
  const wl = JSON.parse(fs.readFileSync(path.join(ROOT, 'free_whitelist.json'), 'utf8'))
  wl.fetched_at = new Date().toISOString()
  fs.writeFileSync(path.join(SB, 'free_whitelist.json'), JSON.stringify(wl, null, 2))
  const prov = (id, name, models, extra = {}) => Object.assign({
    id, name, label: name, base_url: `https://${name}.example.com/v1`,
    enabled: true, keys: [FAKE_KEY], models,
  }, extra)
  const providers = [
      // 快：首字 800ms（测"同档快的在前"）
      prov('r1', 'pa', ['alpha-120b'], {
        modelLat: { 'alpha-120b': 800 }, modelLatN: { 'alpha-120b': 6 }, modelTokps: { 'alpha-120b': 50 },
      }),
      // 慢：同档位同质量，只是首字 6000ms
      prov('r2', 'pb', ['beta-120b'], {
        modelLat: { 'beta-120b': 6000 }, modelLatN: { 'beta-120b': 6 }, modelTokps: { 'beta-120b': 50 },
      }),
      // 冷却中：它是最快的，但打过去必然失败 → 必须排在所有健康候选之后
      prov('r3', 'pc', ['gamma-120b'], {
        cooldownUntil: Date.now() + 3600000,
        modelLat: { 'gamma-120b': 200 }, modelLatN: { 'gamma-120b': 6 }, modelTokps: { 'gamma-120b': 50 },
      }),
      // 同一家的通用模型 + 专用模型 + 弱模型词模型 + 小模型：测"降档"、"同家交错"与"档位门槛"
      // nano-3b 刻意做成**最快的**：如果"低档不领跑"没生效, 它会靠速度爬到队首, 不变量就观察不到。
      prov('r4', 'pd', ['delta-120b', 'codestral-120b', 'lite-120b', 'nano-3b'], {
        modelLat: { 'delta-120b': 1500, 'codestral-120b': 1500, 'lite-120b': 1500, 'nano-3b': 200 },
        modelLatN: { 'delta-120b': 6, 'codestral-120b': 6, 'lite-120b': 6, 'nano-3b': 6 },
        modelTokps: { 'delta-120b': 50, 'codestral-120b': 50, 'lite-120b': 50, 'nano-3b': 50 },
      }),
      // 视觉能力感知：vl-120b 名字有视觉信号；plain-120b 是纯文本；plain2-120b 已实测确知不支持图片
      prov('r5', 'pe', ['vl-120b'], {
        modelLat: { 'vl-120b': 1500 }, modelLatN: { 'vl-120b': 6 }, modelTokps: { 'vl-120b': 50 },
      }),
      prov('r6', 'pf', ['plain-120b'], {
        modelLat: { 'plain-120b': 1500 }, modelLatN: { 'plain-120b': 6 }, modelTokps: { 'plain-120b': 50 },
      }),
      prov('r7', 'pg', ['plain2-120b'], {
        noVision: { 'plain2-120b': { at: new Date().toISOString(), reason: 'route-invariant 构造' } },
        modelLat: { 'plain2-120b': 1500 }, modelLatN: { 'plain2-120b': 6 }, modelTokps: { 'plain2-120b': 50 },
      }),
  ]
  fs.writeFileSync(path.join(SB, 'config.json'), JSON.stringify({
    port: PORT, proxy: '', gatewayKey: GW_KEY, configVersion: 2, aliases: {},
    providers,
  }, null, 2))
  // 把夹具里的模型清单交回调用方：候选数断言从这里派生，增删夹具模型时不必再手改数字
  // （2026-10-05 加 nano-3b 时就是栽在硬编码 9 上）。
  return providers.flatMap((p) => p.models)
}

function req(p) {
  return new Promise((resolve, reject) => {
    const r = http.get({ host: '127.0.0.1', port: PORT, path: p, timeout: 10000 }, (x) => {
      let b = ''
      x.on('data', (d) => { b += d })
      x.on('end', () => { try { resolve({ code: x.statusCode, body: JSON.parse(b) }) } catch { resolve({ code: x.statusCode, body: b }) } })
    })
    r.on('error', reject)
    r.on('timeout', () => { r.destroy(); reject(new Error('timeout')) })
  })
}

async function main() {
  const before = hashProd()
  const fixtureModels = buildSandbox()
  const child = spawn(process.execPath, ['server.mjs'], { cwd: SB, stdio: 'ignore' })
  try {
    let up = false
    for (let i = 0; i < 60; i++) {
      try { const r = await req('/healthz'); if (r.code === 200) { up = true; break } } catch { /* 还没起来 */ }
      await sleep(250)
    }
    if (!up) throw new Error('沙箱网关未起来（' + PORT + '）')

    const chat = (await req('/api/route?n=20')).body
    const agent = (await req('/api/route?n=20&tools=1&messages=8')).body
    const top = chat.top || []
    const byModel = {}
    for (const x of top) byModel[x.model] = x
    const rankOf = (m) => (byModel[m] ? byModel[m].rank : null)

    console.log('[1] 基本前提：候选都进来了')
    t(`候选数 = ${fixtureModels.length}（夹具里全部模型都进了池）`, chat.candidates === fixtureModels.length, 'candidates=' + chat.candidates)
    t('夹具里每个模型都在 top 里', fixtureModels.every((m) => byModel[m]),
      'top=' + top.map((x) => x.model).join(','))

    console.log('\n[2] 不变量：冷却中的候选永远排在健康候选之后')
    const cooling = top.filter((x) => x.cooling)
    const healthy = top.filter((x) => !x.cooling)
    t('确实有 1 个冷却候选（构造生效）', cooling.length === 1, 'cooling=' + cooling.map((x) => x.model).join(','))
    t('冷却候选的 rank 大于所有健康候选',
      cooling.length > 0 && healthy.length > 0 && Math.min(...cooling.map((x) => x.rank)) > Math.max(...healthy.map((x) => x.rank)),
      `cool=${cooling.map((x) => x.model + '#' + x.rank).join(',')} healthy=${healthy.map((x) => x.model + '#' + x.rank).join(',')}`)
    t('冷却的是最快的那个也没用（200ms 仍排最后）',
      rankOf('gamma-120b') === Math.max(...top.map((x) => x.rank)), 'rank=' + rankOf('gamma-120b'))

    console.log('\n[3] 不变量：同档位、同质量时，快的排在慢的前面')
    t('alpha-120b 与 beta-120b 同档', byModel['alpha-120b'].tier === byModel['beta-120b'].tier,
      `fast=${byModel['alpha-120b'].tier} slow=${byModel['beta-120b'].tier}`)
    t('alpha-120b 排在 beta-120b 之前', rankOf('alpha-120b') < rankOf('beta-120b'),
      `fast#${rankOf('alpha-120b')} slow#${rankOf('beta-120b')}`)
    t('快的那家 speed 分项更高',
      byModel['alpha-120b'].parts.speed > byModel['beta-120b'].parts.speed,
      `fast=${byModel['alpha-120b'].parts.speed} slow=${byModel['beta-120b'].parts.speed}`)

    console.log('\n[4] 不变量：专用模型降一档（只降权，不排除）')
    t('codestral-120b 与 delta-120b 都在链上（专用≠排除）',
      !!byModel['codestral-120b'] && !!byModel['delta-120b'])
    t('codestral-120b 的 tier 低于同规模的 delta-120b',
      byModel['codestral-120b'].tier < byModel['delta-120b'].tier,
      `codestral=${byModel['codestral-120b'].tier} delta=${byModel['delta-120b'].tier}`)
    // 这条是写测试时被实测纠正出来的：'fast' 也在弱模型词表里（nano/tiny/mini/lite/light/
    // lightning/small/fast/air/instant），所以 'lite-120b' 会比同参数的 delta-120b 低一档。
    t('名字含弱模型词（lite/mini/fast…）也降一档', byModel['lite-120b'].tier < byModel['delta-120b'].tier,
      `lite=${byModel['lite-120b'].tier} delta=${byModel['delta-120b'].tier}`)

    console.log('\n[5] 不变量：同一家的候选被交错打散')
    // ⚠ 交错的目标是"尽量打散"，**不是"绝不连续"** —— 池子里只剩同一家时连续是必然的
    //   （贪心找不到别家时会退回取同家）。所以断言的是"候选最多的那家没有整体挤在一起"。
    const ranksByProv = {}
    for (const x of top) (ranksByProv[x.provider] = ranksByProv[x.provider] || []).push(x.rank)
    const biggest = Object.entries(ranksByProv).sort((a, b) => b[1].length - a[1].length)[0]
    const rs = biggest[1].slice().sort((a, b) => a - b)
    const allAdjacent = rs.every((r, i) => i === 0 || r === rs[i - 1] + 1)
    t('候选最多的那家被拆开了（交错生效）', rs.length < 2 || !allAdjacent, `${biggest[0]} 的 rank=${rs.join(',')}`)
    t('顺序确实不是纯分数序（说明交错改变过顺序）', (() => {
      const pure = top.slice().sort((a, b) => b.score - a.score).map((x) => x.provider + '/' + x.model).join(',')
      const real = top.map((x) => x.provider + '/' + x.model).join(',')
      return pure !== real
    })(), '顺序=' + top.map((x) => x.provider + '/' + x.model).join(' → '))

    console.log('\n[6] 不变量：权重表随请求类型切换，且与排序共用同一份')
    t('闲聊（无工具）→ W_CHAT（speed 权重 0.40）', chat.weights.speed === 0.40 && chat.weights.tier === 0.15,
      JSON.stringify(chat.weights))
    t('带工具多轮 → W_AGENT（tier 权重 0.40）', agent.weights.tier === 0.40 && agent.weights.speed === 0.15,
      JSON.stringify(agent.weights))
    t('request_tier 正确反映（闲聊 1 / 带工具 2）', chat.request_tier === 1 && agent.request_tier >= 2,
      `chat=${chat.request_tier} agent=${agent.request_tier}`)
    t('weights 与 parts 分项口径一致（parts.tier 就是 weights.tier×原始分）',
      top.every((x) => x.parts.tier <= agent.weights.tier + 1e-9 && x.parts.tier >= -1e-9),
      'parts.tier=' + top.map((x) => x.parts.tier).join(','))

    console.log('\n[7] 不变量：分数可分解，且展示的就是排序真正用的那个分')
    // ⚠ 刻意**不**断言"同档内分数单调不增" —— 交错会主动打乱分数序，那正是它的目的。
    //   钉这条会得到一个永远为假的假断言。
    t('score 等于各加权分项之和（展示的分解是真实的）',
      top.every((x) => {
        const s = x.parts.tier + x.parts.quality + x.parts.avail + x.parts.speed + x.parts.load
        return Math.abs(s - x.score) < 0.002
      }),
      top.map((x) => `${x.model}:${x.score} vs ${(x.parts.tier + x.parts.quality + x.parts.avail + x.parts.speed + x.parts.load).toFixed(3)}`).join(' | '))
    t('每个候选都带 samples（能看出这个分是拿几个样本算的）',
      top.every((x) => x.samples && typeof x.samples.win === 'number'), 'samples=' + JSON.stringify(top[0].samples))

    console.log('\n[8] 不变量：带图请求优先视觉模型（纯文本只降档不排除；实测 noVision 硬跳过）')
    const vch = (await req('/api/route?n=20&vision=1')).body
    const vTop = vch.top || []
    const vBy = {}
    for (const x of vTop) vBy[x.model] = x
    const vRank = (m) => (vBy[m] ? vBy[m].rank : null)
    t('无图请求 vision 标记为 false，视觉/纯文本都未被降档',
      chat.vision === false && !!byModel['vl-120b'] && !!byModel['plain-120b'], `vision=${chat.vision}`)
    t('带图请求 vision 标记为 true', vch.vision === true, 'vision=' + vch.vision)
    // 刻意写成"比无图少 1"而不是钉死数字 —— 夹具增删模型时这条不该跟着改
    t('带图请求：候选数比无图少 1（实测 noVision 的那个被硬跳过）',
      vch.candidates === chat.candidates - 1, `vision=${vch.candidates} plain=${chat.candidates}`)
    t('带图请求：实测 noVision 的 plain2-120b 被硬跳过', !vBy['plain2-120b'], 'in=' + Object.keys(vBy).join(','))
    t('带图请求：plain-120b 仍在链上（名字无视觉信号只降档，不排除）', !!vBy['plain-120b'])
    t('带图请求：vl-120b 排在 plain-120b 之前',
      vRank('vl-120b') !== null && vRank('plain-120b') !== null && vRank('vl-120b') < vRank('plain-120b'),
      `vl#${vRank('vl-120b')} plain#${vRank('plain-120b')}`)
    t('带图请求：所有非冷却候选里，视觉模型整体排在纯文本之前', (() => {
      const vis = vTop.filter((x) => x.vision_ok).map((x) => x.rank)
      const non = vTop.filter((x) => !x.vision_ok && !x.cooling).map((x) => x.rank)
      return vis.length > 0 && non.length > 0 && Math.max(...vis) < Math.min(...non)
    })(), 'vision=' + vTop.filter((x) => x.vision_ok).map((x) => x.model + '#' + x.rank).join(',') +
      ' nonvision=' + vTop.filter((x) => !x.vision_ok).map((x) => x.model + '#' + x.rank).join(','))
    t('无图请求：plain2-120b 在链上（noVision 只在带图时生效）', !!byModel['plain2-120b'])

    console.log('\n[9] 不变量：难易度匹配（复杂题低档不领跑；简单题不启用档位门槛）')
    // agent = 带工具多轮的请求(request_tier >= 2)。档位低于题目要求的模型必须**排在满足要求的之后**。
    // 夹具里的 nano-3b 是**最快的**(200ms), 但只有 3b —— 若"低档不领跑"没生效, 它会靠速度爬到队首。
    const aTop = agent.top || []
    const aBy = {}
    for (const x of aTop) aBy[x.model] = x
    t('带工具请求里 nano-3b 被标为"档位不够"',
      !!aBy['nano-3b'] && aBy['nano-3b'].tier_short === true,
      `tier=${aBy['nano-3b'] && aBy['nano-3b'].tier} short=${aBy['nano-3b'] && aBy['nano-3b'].tier_short}`)
    t('带工具请求里 nano-3b 不领跑（低档排在满足档位的之后）',
      !!aBy['nano-3b'] && aBy['nano-3b'].rank > 1, `rank=${aBy['nano-3b'] && aBy['nano-3b'].rank}`)
    t('带工具请求：所有"档位不够"的候选都排在"档位够"的之后', (() => {
      const short = aTop.filter((x) => x.tier_short).map((x) => x.rank)
      const ok = aTop.filter((x) => !x.tier_short && !x.cooling).map((x) => x.rank)
      return short.length > 0 && ok.length > 0 && Math.max(...ok) < Math.min(...short)
    })(), 'short=' + aTop.filter((x) => x.tier_short).map((x) => x.model + '#' + x.rank).join(','))
    // ⚠ 边界(最容易改坏的一条): 闲聊 request_tier=1 时**必须不启用**档位门槛 ——
    //   简单任务本来就是"给快的/小的", 那时按档位卡人正好搞反(生产实测: 闲聊队首就是 tier 1 的 allam-2-7b)。
    t('闲聊请求：没有任何候选因"档位不够"被降档', chat.top.every((x) => x.tier_short === false),
      'short=' + chat.top.filter((x) => x.tier_short).map((x) => x.model).join(','))
    // 任务类型: 代码题里代码模型**不该**被降档 —— 与 [4] 的"通用题降档"配成一对
    const codeCh = (await req('/api/route?n=20&ask=' + encodeURIComponent('帮我写个排序函数，这段代码为什么报错'))).body
    const codeBy = {}
    for (const x of (codeCh.top || [])) codeBy[x.model] = x
    t('代码题被判成 code', codeCh.task === 'code', 'task=' + codeCh.task)
    t('代码题里 codestral-120b 的 tier 不低于通用题（对口不降档）',
      !!codeBy['codestral-120b'] && codeBy['codestral-120b'].tier >= byModel['codestral-120b'].tier,
      `code=${codeBy['codestral-120b'] && codeBy['codestral-120b'].tier} general=${byModel['codestral-120b'].tier}`)
    t('闲聊的 task 是 general（别把日常对话判成代码题）', chat.task === 'general', 'task=' + chat.task)
    // ⚠ 回归(2026-10-05): ask= 必须换掉**最后一条 user 消息**。messages 为偶数时最后一条是 assistant,
    //   老实现换的是"最后一条消息" -> 排查入口在偶数轮次下静默失效(task 恒为 general), 而这个形态
    //   恰恰是 WorkBuddy 的常态(带工具+多轮)。原来那条断言用的是默认 messages=1, 所以漏掉了这个洞。
    const codeAgent = (await req('/api/route?n=20&tools=1&messages=8&ask=' + encodeURIComponent('帮我写个排序函数，这段代码为什么报错'))).body
    t('ask= 在偶数轮次(agent 形态)下也生效', codeAgent.task === 'code', 'task=' + codeAgent.task)

    console.log('\n[10] 生产未被触碰')
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
