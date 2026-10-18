#!/usr/bin/env node
/*
 * 免费校验闸门 受控测试 —— 验证"手动填写的模型名"会被隔离, 且正常路径不被误伤。
 *
 * ⚠ 2026-09-19 起**改为沙箱运行**(以前直接打生产 8787 并临时增删供应商):
 *   旧写法的三个真实隐患 ——
 *     ① 测试中途崩溃会留下一个 base_url 是 `gatecheck.invalid` 的供应商, 它在路由池里
 *        每次被选中都白等一个往返才失败;
 *     ② 第 4 步对真实供应商调 /update, 会把它的 cooldownUntil 与 err 归零(生产状态被改);
 *     ③ 会污染生产的 free_catalog.json / usage_log.json / 变动记录。
 *   现在: 独立沙箱目录 + 独立端口(8791) + 假上游(8792), 并在首尾各算一次**生产 config.json
 *   的哈希**, 断言完全没变 —— 这条是"不再碰生产"的回归守卫, 以后改测试也拦得住。
 *
 * 另外修掉一条**永远通过的假断言**: 旧代码写的是
 *   chk('隔离后 auto 池为空(不会被路由)', true, '')
 * 条件恒为 true, 等于什么都没验。现改为查 `/v1/models` 里真的看不到被隔离的模型。
 *
 * 用法：node test/gate-check.cjs
 */
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')
const { resetSandboxDir, stableConfigView } = require('./sb-util.cjs')

const ROOT = (() => { const _fs = require('fs'), _p = require('path'); let d = _p.dirname(__dirname); for (let i = 0; i < 6; i++) { if (_fs.existsSync(_p.join(d, 'server.mjs'))) return d; d = _p.dirname(d) } return _p.join(__dirname, '..') })()
const NODE = process.execPath
const GW_PORT = 8791
const UP_PORT = 8792
const KEY = 'freegw-gate-test-key-000000000000000'
const REAL_CONFIG = path.join(ROOT, 'config.json')
// ⚠ gatecheck 的 base_url **必须**是一个不落在沙箱白名单 hostname 下的地址。
// 白名单是按 `new URL(base_url).hostname` 查的（server.mjs 的 whitelistFor），不看端口，
// 所以 gatecheck 若也写 127.0.0.1，它就和 groq 共用了白名单条目 —— 添加供应商时触发的
// refreshCatalogSafe() 会把它的 models 同步成白名单里的 llama-3.3-70b-versatile，
// 手动填的 gpt-4o 被直接冲掉。于是第 5 步"解除隔离后回到池里"永远失败，
// 而且失败原因指向被测代码（看着像 unblock 有 bug），其实是夹具自伤。
// 用 localhost 而不是 127.0.0.1 正是为了拿到一个"无白名单覆盖的自定义厂商"——这也是
// 真实用户填手动模型名的典型场景。见第 [2] 步的"池未被覆盖"断言，防止以后又改回去。
const GC_BASE = `http://localhost:${UP_PORT}/v1`

let pass = 0, fail = 0
const chk = (label, cond, extra) => { if (cond) { pass++; console.log('  PASS  ' + label) } else { fail++; console.log('  FAIL  ' + label + (extra ? ' -> ' + extra : '')) } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const sha = (p) => { try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') } catch { return 'missing' } }

// 生产 config.json 的**语义摘要**（实现见 sb-util.cjs 的 stableConfigView）：
// 只守"供应商 / 模型 / Key / 启停"，剥掉 lastSweepAt / lastError / 冷却 等纯运行时字段 ——
// 否则线上实例自己写一次盘，就会让"生产被触碰"这条守卫误报。
const waitPort = async (port, timeout = 10000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    try { await fetch(`http://127.0.0.1:${port}/healthz`); return true } catch { await sleep(150) }
  }
  return false
}

// 假上游：只需要"能返回一个模型列表"就够 —— 闸门本身是纯元数据判定，不发上游请求。
// ⚠ 同时监听 IPv4 与 IPv6 环回：gatecheck 用的是 `localhost`（原因见下面 BASE 常量），
//   而 Node 17+ 的 DNS 默认 verbatim 解析，localhost 可能先命中 ::1；只绑 127.0.0.1 会让
//   那一路连不上，测试就退化成"靠连接失败躲过目录同步"，等于没验到东西。
function startFakeUpstream() {
  const handler = (req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      if (/\/models/.test(req.url)) {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ object: 'list', data: [{ id: 'llama-3.3-70b-versatile' }] }))
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        id: 'c1', object: 'chat.completion', model: 'llama-3.3-70b-versatile',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }))
    })
  }
  return new Promise((resolve) => {
    const srvs = []
    let pending = 2
    const done = () => { if (--pending === 0) resolve(srvs) }
    for (const host of ['127.0.0.1', '::1']) {
      const s = http.createServer(handler)
      s.on('error', done)   // 环境没有 IPv6 时忽略这一路，不因此判失败
      s.listen(UP_PORT, host, () => { srvs.push(s); done() })
    }
  })
}

function makeSandbox() {
  const dir = path.join(__dirname, 'sb-gate')
  // ⚠ 非递归重置（safe-delete 守卫），见 sb-util.cjs
  resetSandboxDir(dir)
  fs.copyFileSync(path.join(ROOT, 'server.mjs'), path.join(dir, 'server.mjs'))
  // ⚠ .sandbox 标记文件: 让 server.mjs 启动时跳过 syncUpstreamWhitelist,
  //   否则它会在 600ms 启动窗口内把测试精心构造的 free_whitelist.json
  //   覆盖成真实白名单(只剩 api.groq.com / openrouter.ai 这种真域名),
  //   whitelistFor(假上游=127.0.0.1) 就返回 null, free-gate 掉到 FREE_RULES['groq']=() => true,
  //   'manual-paid-x' 这类手动收费模型就会被放行 → gate-check 5b 间歇性 flake
  //   (见 server.mjs syncUpstreamWhitelist 头的注释)。
  fs.writeFileSync(path.join(dir, '.sandbox'), '')
  // ⚠ 白名单按 base_url 的 **hostname** 匹配（whitelistFor，不看端口），沙箱上游是 127.0.0.1，
  // 所以 groq 这条的 key 必须是 '127.0.0.1' 而不是 'api.groq.com'。
  // 而 gatecheck 用 localhost —— 故意落在白名单之外，见 GC_BASE 的注释。
  fs.writeFileSync(path.join(dir, 'free_whitelist.json'), JSON.stringify({
    fetched_at: new Date().toISOString(),
    list_date: new Date().toISOString().slice(0, 10),
    hosts: { '127.0.0.1': { source: 'sandbox', models: ['llama-3.3-70b-versatile'] } },
  }))
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    port: GW_PORT, proxy: '', gatewayKey: KEY,
    providers: [{
      id: 'aaaa1111-2222-3333-4444-555555555555', name: 'groq', label: 'groq',
      base_url: `http://127.0.0.1:${UP_PORT}/v1`, keys: ['sk-real-000'], api_key: 'sk-real-000',
      model: 'llama-3.3-70b-versatile', models: ['llama-3.3-70b-versatile'],
      needs_proxy: false, enabled: true, ok: 3, err: 2, cooldownUntil: 0,
      lastSweepAt: new Date(Date.now() + 3600e3).toISOString(),
      disabledModels: {},
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
  await sleep(600)
  // ⚠ 必须等"启动 3 秒后自动跑的那一轮目录扫描"彻底结束, 再开始动路由池。
  //   起因(2026-09-22 实测复现, 约 1/3 概率): 启动扫描的 pool_sync 会把"不在目录里的手动模型"
  //   重新剔出 p.models —— 这本身是**正确行为**(目录扫描对 auto 池是权威的), 但它的触发时刻
  //   (listen+3000ms) 与第 [5b] 步 unblock 的时刻(listen+~3050ms)只差几十毫秒, 谁先谁后随机。
  //   一旦它落在 unblock 之后, 刚被放回的 manual-paid-x 又被删掉, 5b 就报假 FAIL
  //   —— 现象是"解除后模型没回到 /v1/models", 看起来像被测代码有 bug, 其实代码是对的。
  //   实测 trace(listen 24.249):
  //     26.869 /api/catalog?refresh=1 -> [pool] groq: 2 -> 1
  //     27.255 启动定时器(server.mjs 的 setTimeout(refreshCatalogSafe, 3000)) -> [pool] groq: 2 -> 1
  //   这里用 gateway.pid 的 mtime 当 listen 时刻(server.mjs 在 listen 回调里写它),
  //   等到"启动扫描已落盘"(free_catalog.json mtime >= listen+3000)再放行。
  {
    const pidFile = path.join(dir, 'gateway.pid')
    const catFile = path.join(dir, 'free_catalog.json')
    let listenAt = 0
    try { listenAt = fs.statSync(pidFile).mtimeMs } catch {}
    if (!listenAt) {
      console.log('  ⚠ 取不到沙箱 listen 时刻, 跳过"等启动扫描"保护（后续可能仍与后台刷新竞争）')
    } else {
      let settled = false
      for (let i = 0; i < 80; i++) {
        let catAt = 0
        try { catAt = fs.statSync(catFile).mtimeMs } catch {}
        if (Date.now() - listenAt >= 3200 && catAt >= listenAt + 3000) { settled = true; break }
        await sleep(100)
      }
      if (!settled) console.log('  ⚠ 等待启动目录扫描落盘超时, 继续执行（可能仍有后台刷新竞争）')
    }
  }

  const BASE = `http://127.0.0.1:${GW_PORT}`
  const j = async (p, opt) => {
    const r = await fetch(BASE + p, opt)
    const t = await r.text()
    try { return { status: r.status, body: JSON.parse(t) } } catch { return { status: r.status, body: t } }
  }
  const post = (p, o) => j(p, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + KEY }, body: JSON.stringify(o || {}) })
  const state = async () => (await j('/api/state')).body
  const find = (s, name) => (s.providers || []).find((x) => x.name === name)
  const models = async () => (await j('/v1/models', { headers: { authorization: 'Bearer ' + KEY } })).body

  const before = await state()
  const n0 = before.providers.length
  console.log('沙箱起始供应商数:', n0, '| 生产 config.json 语义摘要:', realBefore.slice(0, 12))

  // ── 1. 手动填写的模型名必须被隔离 ──
  console.log('\n[1] 添加供应商, 模型全部走"手动填写"')
  const r1 = await post('/api/providers', {
    name: 'gatecheck', label: 'gatecheck',
    base_url: GC_BASE, api_key: 'sk-gate-test-000',
    models: [], manual: ['gpt-4o', 'claude-3-opus-20240229'],
  })
  chk('HTTP 200 且 ok', r1.status === 200 && r1.body.ok === true, JSON.stringify(r1.body))
  chk('响应 unverified 含两个模型', Array.isArray(r1.body.unverified) && r1.body.unverified.length === 2, JSON.stringify(r1.body.unverified))
  const id = r1.body.id

  // ── 2. 隔离状态落到 config 并反映在 /api/state ──
  // 等添加时触发的那次目录扫描跑完再断言：目录同步（pool_sync）是异步的，若不等它，
  // "被隔离的模型不在池里"这条可能只是"扫描还没跑到"，验不到真东西。
  console.log('\n[2] 校验隔离状态（等目录扫描跑完）')
  await sleep(1800)
  const s2 = await state()
  const p2 = find(s2, 'gatecheck')
  chk('供应商已存在', !!p2)
  const q = (p2 && p2.quarantine) || {}
  chk('两个模型都进了隔离', Object.keys(q).length === 2, JSON.stringify(Object.keys(q)))
  chk('隔离原因标记为闸门(gate:true)', Object.values(q).every((v) => v.gate === true), JSON.stringify(q))
  // 目录同步不得把"手动填写的模型"从池里抹掉 —— 这正是夹具里 gatecheck 必须避开白名单 hostname 的原因
  chk('目录同步未覆盖手动填写的模型（池仍是这两条）',
    JSON.stringify((p2.models || []).slice().sort()) === JSON.stringify(['claude-3-opus-20240229', 'gpt-4o']),
    JSON.stringify(p2.models))
  // ⚠ 这条以前写的是 chk(..., true, '') —— 恒真，等于没验。真验：被隔离的模型不得出现在 /v1/models
  const ml = (await models()).data.map((x) => x.id)
  chk('被隔离的模型真的不在 /v1/models 里（不会被路由）',
    !ml.includes('gatecheck/gpt-4o') && !ml.includes('gatecheck/claude-3-opus-20240229'),
    ml.filter((x) => x.startsWith('gatecheck/')).join(',') || '(无 gatecheck 条目)')
  chk('未隔离的正常模型仍可路由', ml.includes('groq/llama-3.3-70b-versatile'), ml.filter((x) => x.startsWith('groq/')).join(','))

  // ── 3. 只更新 keys 时不得误伤已有模型 ──
  console.log('\n[3] 仅更新 keys, 不应产生新的 unverified')
  const r3 = await post(`/api/providers/${id}/update`, { keys: ['sk-gate-test-000'] })
  chk('unverified 为空', Array.isArray(r3.body.unverified) && r3.body.unverified.length === 0, JSON.stringify(r3.body.unverified))
  const s3 = await state()
  const p3 = find(s3, 'gatecheck')
  chk('隔离状态保持不变(仍是 2 个)', Object.keys(p3.quarantine || {}).length === 2, JSON.stringify(Object.keys(p3.quarantine || {})))

  // ── 4. 对已有真实免费池的供应商只更新 keys, 不得误隔离 ──
  console.log('\n[4] 对已有免费池的供应商(groq)只更新 keys, 不得误隔离')
  const groq = before.providers.find((x) => x.name === 'groq')
  const groqPool = (groq.models || []).slice()
  const r4 = await post(`/api/providers/${groq.id}/update`, { keys: ['sk-real-000'] })
  chk('unverified 为空(无新模型写入)', Array.isArray(r4.body.unverified) && r4.body.unverified.length === 0, JSON.stringify(r4.body.unverified))
  const s4 = await state()
  const g4 = s4.providers.find((x) => x.id === groq.id)
  chk('groq 路由池未被改动', JSON.stringify(g4.models) === JSON.stringify(groqPool), JSON.stringify(g4.models))
  chk('groq 隔离项未增加',
    Object.keys(g4.quarantine || {}).length === Object.keys(groq.quarantine || {}).length,
    `before=${Object.keys(groq.quarantine || {}).length} after=${Object.keys(g4.quarantine || {}).length}`)
  // 非空 keys 会走"整份替换"分支 → 顺带验一下逐 Key 的统计与启停被一起清掉（下标作废）
  chk('整份替换 keys 时清掉逐 Key 统计/启停（避免旧下标套到新 Key 上）',
    Object.keys(g4.keyStats || {}).length === 0 && Object.keys(g4.keyDisabled || {}).length === 0,
    JSON.stringify({ keyStats: g4.keyStats, keyDisabled: g4.keyDisabled }))

  // ── 5. 手动解除隔离后应能进入路由池 ──
  console.log('\n[5] 手动解除隔离后放回可用池')
  const r5 = await post(`/api/providers/${id}/unblock`, { model: 'gpt-4o' })
  chk('解除成功', r5.status === 200 && r5.body.ok === true, JSON.stringify(r5.body))
  const ml5 = (await models()).data.map((x) => x.id)
  chk('解除后 gpt-4o 出现在 /v1/models', ml5.includes('gatecheck/gpt-4o'), ml5.filter((x) => x.startsWith('gatecheck/')).join(','))
  chk('另一个仍被隔离', !ml5.includes('gatecheck/claude-3-opus-20240229'))

  // ── 5b. 已被目录同步剔出池的模型, 解除后必须真的回到池里 ──
  // 沙箱化时顺带发现的**真缺陷**: refreshCatalog 的 pool_sync 只把"当前判定免费"的模型写进
  // p.models（free 列表本身已 filter 掉隔离/拉黑的），所以被隔离的模型在那一轮就被剔出池了；
  // 而 unblock 原先只删标记、不补回池。用户点「解除」→ 标记没了、弹窗说"已放回可用池",
  // 模型却不在池里 —— 路由永远选不到, 表现为"这个按钮点了没反应"。
  // 这里刻意走真实路径: 先让 pool_sync 真的把它剔掉, 再解除。
  console.log('\n[5b] 解除一个"已被目录同步剔出池"的模型, 必须真的回到池里')
  const paid = 'manual-paid-x'
  const r5b1 = await post(`/api/providers/${groq.id}/update`, { models: ['llama-3.3-70b-versatile', paid] })
  chk('新填的手动模型被隔离', (r5b1.body.unverified || []).includes(paid), JSON.stringify(r5b1.body.unverified))
  chk('此刻它仍在 p.models 里（还没被同步剔除）', (find(await state(), 'groq').models || []).includes(paid))
  await j('/api/catalog?refresh=1', { headers: { authorization: 'Bearer ' + KEY } })
  let dropped = false
  for (let i = 0; i < 40; i++) {
    await sleep(300)
    const g = find(await state(), 'groq')
    if (g && !(g.models || []).includes(paid)) { dropped = true; break }
  }
  chk('前置条件: 目录同步已把被隔离的模型剔出池', dropped, JSON.stringify((find(await state(), 'groq') || {}).models))
  const r5b2 = await post(`/api/providers/${groq.id}/unblock`, { model: paid })
  chk('解除成功', r5b2.status === 200 && r5b2.body.ok === true, JSON.stringify(r5b2.body))
  const ml5b = (await models()).data.map((x) => x.id)
  chk('解除后它真的回到了 /v1/models（不再是"点了没反应"）', ml5b.includes(`groq/${paid}`), ml5b.filter((x) => x.startsWith('groq/')).join(','))

  // ── 5c. 全部解除: blocked/quarantine 里记着的模型也要一并放回 ──
  console.log('\n[5c] 全部解除同样要把模型放回池里')
  const paid2 = 'manual-paid-y'
  await post(`/api/providers/${groq.id}/update`, { models: ['llama-3.3-70b-versatile', paid, paid2] })
  const r5c = await post(`/api/providers/${groq.id}/unblock`, {})
  chk('全部解除成功', r5c.status === 200 && r5c.body.ok === true, JSON.stringify(r5c.body))
  const ml5c = (await models()).data.map((x) => x.id)
  chk('两个手动模型都在 /v1/models 里', ml5c.includes(`groq/${paid}`) && ml5c.includes(`groq/${paid2}`), ml5c.filter((x) => x.startsWith('groq/')).join(','))
  // 复原 groq 的池, 免得影响第 6 步的断言
  await post(`/api/providers/${groq.id}/update`, { models: ['llama-3.3-70b-versatile'] })

  // ── 6. 清理 + 生产未被触碰 ──
  console.log('\n[6] 清理临时供应商 + 生产未被触碰')
  await j(`/api/providers/${id}`, { method: 'DELETE', headers: { authorization: 'Bearer ' + KEY } })
  const s6 = await state()
  chk('gatecheck 已删除', !find(s6, 'gatecheck'))
  chk('沙箱供应商数回到起始值', s6.providers.length === n0, `${s6.providers.length} vs ${n0}`)

  gw.kill()
  for (const s of up) s.close()
  await sleep(400)
  // ⚠ 本测试的**核心回归守卫**：整轮跑完，生产 config.json 的语义内容必须一个字节都没变。
  // （用 stableConfigView 而非整文件哈希，理由见该函数上方注释）
  const realAfter = stableConfigView(REAL_CONFIG)
  chk('生产 config.json 未被触碰（供应商/模型/Key 摘要一致）', realBefore === realAfter,
    `${String(realBefore).slice(0, 12)} vs ${String(realAfter).slice(0, 12)}`)

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
  process.exit(fail ? 1 : 0)
})().catch((e) => { console.error('测试异常:', e.message); process.exit(1) })
