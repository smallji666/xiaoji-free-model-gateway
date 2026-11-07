#!/usr/bin/env node
/*
 * 停更熔断的端到端验证（离线、确定性）。
 *
 * 为什么不能只靠单测：单测只证明 `sourceStaleDays` 算得对 + 源码里有那句 `continue`。
 * "整源真的不合并"这件事只有在**跑一次真实同步**、再看落盘的 free_whitelist.json 才算证明。
 * 做法：把 3 个真实源的 fetch() 换成确定性桩（不碰网络），再追加一个"停更源"，
 *      然后启动网关、等它写完白名单、读文件断言。
 *
 * 期望：fresh-* 三家在 hosts 里；stale-fake.example.com **不在**；sources.fakesrc 带"已忽略"。
 */
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process')
const T = __dirname
const ROOT = (() => { const _fs = require('fs'), _p = require('path'); let d = _p.dirname(__dirname); for (let i = 0; i < 6; i++) { if (_fs.existsSync(_p.join(d, 'server.mjs'))) return d; d = _p.dirname(d) } return _p.join(__dirname, '..') })()
const SB = path.join(T, 'sb-stale')
const { freshSandbox } = require('./sb-util.cjs')
const PORT = 8813
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  freshSandbox(SB)
  fs.mkdirSync(SB, { recursive: true })
  // ⚠ 必须删掉上一轮的白名单。本套件的等待条件是"文件里出现 sources.fakesrc"，而上一轮跑完
  //   留下的那份**已经满足**这个条件 —— 于是循环第一次就 break、立刻 kill 网关，日志里那句
  //   "本轮不参与合并"还没刷出来就判 FAIL。表现为**第一次跑绿、之后每次都红**（2026-10-23
  //   实测：残留文件 fetched_at 是 10-17，前 5 项断言全部假通过，只有日志那条红）。
  //   freshSandbox 刻意不动 free_whitelist.json（它是运行态而非"测试认识的状态文件"），
  //   所以这一步必须由本套件自己做。
  // ⚠ 同理必须删 `.sandbox`：`syncUpstreamWhitelist()` 一看到这个标记就直接 return（"沙箱里
  //   不许碰真实白名单"），于是本套件要验的那次同步**根本不会跑**，20 秒后报"未拿到同步结果"。
  //   本套件恰恰需要同步真跑一遍 —— 源已经全被桩掉了，写出来的只会落在 sb-stale 里。
  for (const f of ['free_whitelist.json', 'free_whitelist.json.prev', 'free_whitelist.json.tmp', '.sandbox']) {
    try { fs.unlinkSync(path.join(SB, f)) } catch {}
  }

  // 1) 复制运行态（与 sb-build.cjs 同一份清单）
  for (const f of ['dashboard.html', 'free_catalog.json', 'usage_log.json', 'metrics.json', 'promo_state.json']) {
    const s = path.join(ROOT, f); if (fs.existsSync(s)) fs.copyFileSync(s, path.join(SB, f))
  }
  fs.cpSync(path.join(ROOT, 'assets'), path.join(SB, 'assets'), { recursive: true })

  // 2) config: 只改端口 + 清空 providers（→ 不触发真实目录扫描, 全程离线）
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'))
  cfg.port = PORT
  cfg.providers = []
  fs.writeFileSync(path.join(SB, 'config.json'), JSON.stringify(cfg, null, 2))

  // 3) 打补丁版 server.mjs: 桩掉真实源 + 追加停更源
  // ⚠ 桩的清单日期**必须相对今天算**, 不能写死。写死 '2026-10-06' 时它是新鲜的, 但过了 14 天
  //   (SOURCE_STALE_DAYS) 就自己变成"停更源" —— 于是四个源一起被判停更、同步报"所有上游源均未
  //   返回数据", 本套件从绿变红而**代码一行没动**(2026-10-23 实测: 硬编码的 10-06 已停更 16 天)。
  //   这类"写死日期"的测试比没有测试更糟: 它训练人忽略红灯。
  const FRESH_DATE = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10)   // 2 天前, 稳定新鲜
  let src = fs.readFileSync(path.join(ROOT, 'server.mjs'), 'utf8')
  const anchor = "// freellm.net 的清单仓库(开源, 每日自动刷新)"
  if (!src.includes(anchor)) { console.error('锚点丢失, 无法打补丁'); process.exit(2) }
  const patch = `
// [E2E 补丁] 真实源换确定性桩; 追加一个"停更源"(清单日期 2026-08-01) 与一个"正常源"
// ok-fake 的存在是为了第二阶段: 它在第一轮**实打实进过 hosts**, 第二轮变成停更 —— 只有这种
// "上一轮在、这一轮因停更而该消失"的源, 才能证明"沿用逻辑没有越界去救停更源"。
for (const s of WHITELIST_SOURCES) {
  s.fetch = async () => ({ date: '${FRESH_DATE}', hosts: { ['fresh-' + s.id + '.example.com']: { source: 'fresh-' + s.id, models: ['m1'] } } })
}
WHITELIST_SOURCES.push({
  id: 'fakesrc', name: '假停更源',
  async fetch() { return { date: '2026-08-01', hosts: { 'stale-fake.example.com': { source: 'StaleFake', models: ['stale-1', 'stale-2'] } } } },
})
WHITELIST_SOURCES.push({
  id: 'oksrc', name: '假正常源',
  async fetch() { return { date: '${FRESH_DATE}', hosts: { 'ok-fake.example.com': { source: 'OkFake', models: ['ok-1'] } } } },
})

`
  src = src.replace(anchor, patch + anchor)
  fs.writeFileSync(path.join(SB, 'server.mjs'), src)

  // 4) 启动 -> 等同步落盘 -> 读文件
  const gw = cp.spawn(process.execPath, ['server.mjs'], { cwd: SB, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  let gwExit = null
  gw.stdout.on('data', (d) => { log += d })
  gw.stderr.on('data', (d) => { log += d })
  // ⚠ 网关**起不来**时不能干等 20 秒：旧实现的等待条件只认"sources.fakesrc 存在"，
  //   于是「端口被占 / 启动即崩 / 上一轮残留的网关进程还在写这个文件」都会让本套件
  //   读到**上一轮的结果**——断言 1~4 假通过、第 5 条日期对不上而报 FAIL，看起来像代码坏了
  //   （2026-10-25 实测：整组连跑时红、单独跑绿，读到的 list_date 是 10-20 的陈旧值）。
  //   现在两件事一起做：① 进程一退出就立刻判失败并把日志打出来（根因一眼可见）；
  //   ② 判据从"有 fakesrc"收紧成"list_date === 本轮 FRESH_DATE"，旧结果再也不可能冒充新结果。
  gw.on('exit', (code, sig) => { gwExit = { code, sig } })
  gw.on('error', (e) => { gwExit = { code: -1, sig: String(e && e.message) } })

  const WL = path.join(SB, 'free_whitelist.json')
  let wl = null
  for (let i = 0; i < 40; i++) {
    await sleep(500)
    if (gwExit) break   // 进程已退出，再等也不会写出新文件
    try {
      const j = JSON.parse(fs.readFileSync(WL, 'utf8'))
      // 只认**本轮**写的：桩给所有新鲜源的日期都是 FRESH_DATE，list_date 取其中最新 → 必然等于它。
      if (j && j.sources && j.sources.fakesrc && j.list_date === FRESH_DATE) { wl = j; break }
    } catch {}
  }
  if (!wl && gwExit) {
    console.error(`网关进程提前退出(code=${gwExit.code}, sig=${gwExit.sig})，未写出本轮白名单。日志:\n` + log.slice(-2000))
    process.exit(1)
  }
  // ⚠ 杀之前先等那行警告刷出来：网关是**先 `console.warn` 再落盘**，但 stderr 走的是异步管道 ——
  //   测试一看到白名单文件就把进程杀掉，可能把还在管道里的那行警告一起带走
  //   （2026-10-08 实测过一次偶发 FAIL：文件已落盘，日志却少一行）。
  //   这里只等"日志出现"，等不到就照常超时判 FAIL —— 是消除竞态，不是掩盖失败。
  for (let i = 0; i < 20 && !/本轮不参与合并/.test(log); i++) await sleep(150)
  try { gw.kill() } catch {}
  // Windows 上 SIGTERM 不一定能让 node 子进程立刻退出（本项目在 Windows 上本来就没有真信号），
  // 补一发硬杀兜底；类 Unix 上 gw.kill() 已经够了，且没有 taskkill 这个命令。
  if (process.platform === 'win32') {
    try { cp.execSync('taskkill /PID ' + gw.pid + ' /F', { stdio: 'ignore' }) } catch {}
  }

  if (!wl) { console.error('未拿到同步结果。日志:\n' + log.slice(-2000)); process.exit(1) }
  const hosts = Object.keys(wl.hosts || {})
  let pass = 0, fail = 0
  const ck = (n, ok, extra) => { console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok ? '' : '  << ' + (extra || ''))); ok ? pass++ : fail++ }

  ck('新鲜源(2家)进入 hosts', ['fresh-openrouter.example.com', 'fresh-freellm.example.com'].every((h) => hosts.includes(h)), hosts.join(','))
  // 第二阶段的基线：ok-fake 这一轮必须在名单里，否则"下一轮它变成停更后消失"证明不了任何事。
  ck('正常源(ok-fake)进入 hosts（第二阶段的基线）', hosts.includes('ok-fake.example.com'), hosts.join(','))
  ck('第一轮已落盘归属记录 hostSources', Array.isArray((wl.hostSources || {})['ok-fake.example.com'])
    && (wl.hostSources['ok-fake.example.com'] || []).includes('oksrc'), JSON.stringify((wl.hostSources || {})['ok-fake.example.com']))
  ck('停更源(2026-08-01)的厂商**没有**进入 hosts', !hosts.includes('stale-fake.example.com'), hosts.join(','))
  ck('停更源也没混进候选', !Object.keys(wl.candidates || {}).includes('stale-fake.example.com'), Object.keys(wl.candidates || {}).join(','))
  ck('源状态写明"已忽略"', /^2026-08-01 ⚠停更\d+天, 已忽略$/.test(String(wl.sources.fakesrc || '')), JSON.stringify(wl.sources))
  ck('新鲜源状态照常记日期', wl.sources.freellm === FRESH_DATE, JSON.stringify(wl.sources))
  ck('日志里有一条明确警告', /本轮不参与合并/.test(log), log.slice(-800))
  // 2026-11-07 加：归属历史是"只增不减"的诊断账本。熔断轮会从零重建 hosts/hostSources，
  // 若它也被一起清空，下一轮连"失败源该沿用谁"都查不到 —— 这正是 10-29 那次 26→12 家
  // 之后久久不自愈的机理。所以必须单独落盘、单独断言。
  ck('第一轮落盘 contributionHistory 归属历史', Array.isArray((wl.contributionHistory || {})['fresh-openrouter.example.com'])
    && wl.contributionHistory['fresh-openrouter.example.com'].includes('openrouter'), JSON.stringify(wl.contributionHistory))

  // ══ 第二阶段：源"拉取失败"必须**沿用上一轮该源的贡献**（2026-10-29 加）══
  // 与停更熔断刻意相反：停更 = "拉到了但不新" → 主动不用；失败 = "压根没拉到" → 沿用上次的。
  // 两者的分界线就是这次修复的全部难点，所以必须各有一条端到端断言：
  // 只测"失败会沿用"而不测"停更仍不沿用"，就会把 ① 那条边界改坏而毫无察觉。
  const patch2 = `
// [E2E 补丁·第二阶段] freellm 拉取失败(应沿用) + oksrc 变成停更(不该沿用) + 停更源保持原样
for (const s of WHITELIST_SOURCES) {
  s.fetch = async () => {
    if (s.id === 'freellm') throw new Error('模拟 TLS 断连（E2E）')
    return { date: '${FRESH_DATE}', hosts: { ['fresh-' + s.id + '.example.com']: { source: 'fresh-' + s.id, models: ['m1'] } } }
  }
}
WHITELIST_SOURCES.push({
  id: 'fakesrc', name: '假停更源',
  async fetch() { return { date: '2026-08-01', hosts: { 'stale-fake.example.com': { source: 'StaleFake', models: ['stale-1', 'stale-2'] } } } },
})
WHITELIST_SOURCES.push({
  id: 'oksrc', name: '假正常源(本轮变停更)',
  async fetch() { return { date: '2026-08-01', hosts: { 'ok-fake.example.com': { source: 'OkFake', models: ['ok-1'] } } } },
})

`
  const src2 = src.replace(patch, patch2)
  if (src2 === src) { console.error('第二阶段补丁未生效（锚点变了）'); process.exit(2) }
  fs.writeFileSync(path.join(SB, 'server.mjs'), src2)

  const prevAt = wl.fetched_at
  const gw2 = cp.spawn(process.execPath, ['server.mjs'], { cwd: SB, stdio: ['ignore', 'pipe', 'pipe'] })
  let log2 = ''
  let gw2Exit = null
  gw2.stdout.on('data', (d) => { log2 += d })
  gw2.stderr.on('data', (d) => { log2 += d })
  gw2.on('exit', (code, sig) => { gw2Exit = { code, sig } })
  gw2.on('error', (e) => { gw2Exit = { code: -1, sig: String(e && e.message) } })
  // 判据必须同时满足三件事，否则会读到**第一阶段**的结果：① freellm 状态是失败 ② fetched_at 变了
  // ③ 沿用那行日志已经刷出来（沿用发生在落盘之前，日志可能还在管道里）。
  let wl2 = null
  for (let i = 0; i < 40; i++) {
    await sleep(500)
    if (gw2Exit) break
    try {
      const j = JSON.parse(fs.readFileSync(WL, 'utf8'))
      if (j && j.fetched_at !== prevAt && String((j.sources || {}).freellm || '').startsWith('失败') && /沿用上一轮它贡献的 \d+ 家厂商/.test(log2)) { wl2 = j; break }
    } catch {}
  }
  try { gw2.kill() } catch {}
  if (process.platform === 'win32') {
    try { cp.execSync('taskkill /PID ' + gw2.pid + ' /F', { stdio: 'ignore' }) } catch {}
  }
  if (!wl2) {
    ck('第二阶段(源失败沿用)拿到本轮结果', false, (gw2Exit ? `进程提前退出 code=${gw2Exit.code}` : '超时') + '\n' + log2.slice(-1200))
  } else {
    const h2 = Object.keys(wl2.hosts || {})
    ck('失败源的厂商被沿用回来（不丢知识）', h2.includes('fresh-freellm.example.com'), h2.join(','))
    ck('沿用后源状态写明失败与沿用家数', /^失败:.*（沿用上一轮 1 家）$/.test(String(wl2.sources.freellm || '')), JSON.stringify(wl2.sources))
    ck('日志说明沿用了几家', /沿用上一轮它贡献的 1 家厂商/.test(log2), log2.slice(-600))
    ck('失败源的归属记录已落盘', Array.isArray((wl2.hostSources || {})['fresh-freellm.example.com'])
      && (wl2.hostSources['fresh-freellm.example.com'] || []).includes('freellm'), JSON.stringify((wl2.hostSources || {})['fresh-freellm.example.com']))
    // ⚠ 这两条是防止"沿用"把边界搞坏的关键：停更源**仍然**不许复活。
    //   ok-fake 在第一轮是实打实进过 hosts 的，这一轮它只是"变成停更" —— 若沿用逻辑误对停更生效，
    //   它就会被复活回来，而那条路径正是"用过期清单判定免费"的入口（可能真扣钱）。
    ck('沿用只对"拉取失败"生效：变停更的源**不**复活', !h2.includes('ok-fake.example.com'), h2.join(','))
    ck('变停更的源状态写明已忽略', /⚠停更\d+天, 已忽略/.test(String((wl2.sources || {}).oksrc || '')), JSON.stringify(wl2.sources))
    ck('停更源(从未进过名单)也不复活', !h2.includes('stale-fake.example.com'), h2.join(','))
    // 2026-11-07 加：名单缩水必须**可见**，否则仪表盘会一直显示一份残缺名单而没人知道。
    ck('名单缩水记进 droppedHosts（可见而非静默）', (wl2.droppedHosts || []).includes('ok-fake.example.com'), JSON.stringify(wl2.droppedHosts))
    // 反断言：ok-fake 已被熔断移出本轮 hosts/hostSources，但归属历史**不许**被抹掉 ——
    // 它证明"这个源曾经给过这家"，是将来判定"沿用范围"的唯一硬事实。
    ck('⚠ 反断言: 归属历史跨熔断轮仍在，不被重建抹掉', !(wl2.hostSources || {})['ok-fake.example.com']
      && Array.isArray((wl2.contributionHistory || {})['ok-fake.example.com'])
      && wl2.contributionHistory['ok-fake.example.com'].includes('oksrc'), JSON.stringify(wl2.contributionHistory))
  }

  // ══ 第三阶段：绕缓存复验（2026-11-07 加）══
  // 病因：sourceStaleDays() 判的是**正文里声明的日期**，而正文可能是 CDN/代理缓存的旧副本。
  // 此时"停更 17 天"说的是"这份缓存 17 天没换"，不是"上游 17 天没更新"，却被当成后者 →
  // 整源熔断、名单一夜少 14 家，重建还把 hostSources 归属抹掉，连"失败源沿用"都补不回来。
  // 修法只在**即将熔断**时发一次无条件(绕缓存)请求；日期变新鲜才按新鲜源合并。
  // ⚠ 反断言必须同时锁住：真停更源复验后**仍然不合并** —— 否则就是把防扣费红线改坏了。
  const patch3 = `
// [E2E 补丁·第三阶段] 缓存陈旧 -> 复验救回; 真停更 -> 复验后仍熔断; 新失败源 -> 记 degraded
for (const s of WHITELIST_SOURCES) {
  s.fetch = async () => ({ date: '${FRESH_DATE}', hosts: { ['fresh-' + s.id + '.example.com']: { source: 'fresh-' + s.id, models: ['m1'] } } })
}
let cachedCalls = 0
WHITELIST_SOURCES.push({
  id: 'cachedsrc', name: '假缓存陈旧源',
  async fetch() {
    // ⚠ 不能靠 cond 是否为 null 区分首轮与复验：同步首轮就是 s.fetch(prevCond[id] || null)，
    //   没存过 etag 时传的同样是 null。只有"第几次调用"是可靠判据。
    cachedCalls++
    if (cachedCalls >= 2) return { date: '${FRESH_DATE}', hosts: { 'cached-fresh.example.com': { source: 'CachedFresh', models: ['cf-1'] } } }
    return { date: '2026-08-01', hosts: { 'cached-stale.example.com': { source: 'CachedStale', models: ['cs-1'] } } }
  },
})
WHITELIST_SOURCES.push({
  id: 'fakesrc', name: '真停更源',
  async fetch() { return { date: '2026-08-01', hosts: { 'stale-fake.example.com': { source: 'StaleFake', models: ['stale-1'] } } } },
})
WHITELIST_SOURCES.push({
  id: 'deadsrc', name: '从未贡献过的失败源',
  async fetch() { throw new Error('模拟拉取失败（E2E）') },
})

`
  const src3 = src.replace(patch, patch3)
  if (src3 === src) { console.error('第三阶段补丁未生效（锚点变了）'); process.exit(2) }
  fs.writeFileSync(path.join(SB, 'server.mjs'), src3)

  const prevAt3 = (() => { try { return JSON.parse(fs.readFileSync(WL, 'utf8')).fetched_at } catch { return '' } })()
  const gw3 = cp.spawn(process.execPath, ['server.mjs'], { cwd: SB, stdio: ['ignore', 'pipe', 'pipe'] })
  let log3 = ''
  let gw3Exit = null
  gw3.stdout.on('data', (d) => { log3 += d })
  gw3.stderr.on('data', (d) => { log3 += d })
  gw3.on('exit', (code, sig) => { gw3Exit = { code, sig } })
  gw3.on('error', (e) => { gw3Exit = { code: -1, sig: String(e && e.message) } })
  let wl3 = null
  for (let i = 0; i < 40; i++) {
    await sleep(500)
    if (gw3Exit) break
    try {
      const j = JSON.parse(fs.readFileSync(WL, 'utf8'))
      if (j && j.fetched_at !== prevAt3 && j.sources && j.sources.cachedsrc === FRESH_DATE) { wl3 = j; break }
    } catch {}
  }
  // 顺手在这个还在跑的网关上验 /healthz 浅检的 issues[] 契约（省一次起进程）。
  // 反断言的重点是"浅检零 I/O"：代理不通也绝不能在浅检里等 2.5s 的 TCP 超时。
  let hz3 = null, hz3ms = 0
  for (let i = 0; i < 20; i++) {
    const t0 = Date.now()
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/healthz`, { signal: AbortSignal.timeout(1500) })
      if (r.ok) { hz3 = await r.json(); hz3ms = Date.now() - t0; break }
    } catch {}
    await sleep(300)
  }
  try { gw3.kill() } catch {}
  if (process.platform === 'win32') {
    try { cp.execSync('taskkill /PID ' + gw3.pid + ' /F', { stdio: 'ignore' }) } catch {}
  }

  if (!wl3) {
    ck('第三阶段(绕缓存复验)拿到本轮结果', false, (gw3Exit ? `进程提前退出 code=${gw3Exit.code}` : '超时') + '\n' + log3.slice(-1200))
  } else {
    const h3 = Object.keys(wl3.hosts || {})
    ck('日志明确写出"绕缓存复验"而不是静默改判', /绕缓存复验拿到/.test(log3), log3.slice(-900))
    ck('缓存陈旧源按**新鲜源**合并（状态是日期，不是"已忽略"）', wl3.sources.cachedsrc === FRESH_DATE, JSON.stringify(wl3.sources))
    ck('复验拿到的厂商进入 hosts', h3.includes('cached-fresh.example.com'), h3.join(','))
    ck('⚠ 反断言: 缓存里那份过期正文的厂商没进 hosts', !h3.includes('cached-stale.example.com'), h3.join(','))
    ck('⚠ 反断言: 真停更源复验后仍不合并（防扣费红线未破）', !h3.includes('stale-fake.example.com')
      && /⚠停更\d+天, 已忽略/.test(String(wl3.sources.fakesrc || '')), h3.join(',') + ' | ' + JSON.stringify(wl3.sources.fakesrc))
    ck('新一轮归属写进 contributionHistory', Array.isArray((wl3.contributionHistory || {})['cached-fresh.example.com'])
      && wl3.contributionHistory['cached-fresh.example.com'].includes('cachedsrc'), JSON.stringify((wl3.contributionHistory || {})['cached-fresh.example.com']))
    ck('没补上数据的失败源记进 degradedSources', (wl3.degradedSources || []).includes('deadsrc'), JSON.stringify(wl3.degradedSources))
    // ── /healthz 浅检 issues[]：只追加可见性，不改 ok/alive 语义、不引入网络 I/O ──
    ck('浅检仍是 200 且 ok/alive 语义不变', hz3 && hz3.ok === true && hz3.alive === true && hz3.deep === undefined, JSON.stringify(hz3))
    ck('⚠ 反断言: 浅检秒回（没在请求路径上发代理探测）', hz3ms < 800, hz3ms + 'ms')
    ck('浅检 issues 把降级源说清楚', hz3 && Array.isArray(hz3.issues)
      && hz3.issues.some((s) => /白名单数据源降级/.test(s) && /deadsrc/.test(s)), JSON.stringify(hz3 && hz3.issues))
  }

  // ══ 第四阶段：304 短路必须让位于「停更熔断」（2026-11-07 加）══
  // 病因：短路发生在停更判断**之前**。源一直回 304 时正文不变、日期却随时间变老，
  // 于是 sourceStaleDays / 绕缓存复验 / 熔断整段不可达 —— 过期的免费证据被无限期沿用。
  // 这条只有「预置一份陈旧快照 + 所有源都回 304」才能复现，单测覆盖不到。
  const STALE30 = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10)
  const patch4 = `
// [E2E 补丁·第四阶段] 所有源首轮回 304；只有被强制重建时才交出全量正文（日期已停更 30 天）
for (const s of WHITELIST_SOURCES) {
  s.fetch = async (cond) => {
    if (cond) return { notModified: true, cond: { etag: 'e-' + s.id } }
    if (s.id === 'openrouter') return { live: true, hosts: { 'live-fake.example.com': { source: 'Live', models: ['l-1'] } }, cond: { etag: 'e-' + s.id } }
    return { date: '${STALE30}', hosts: { ['cached-' + s.id + '.example.com']: { source: 'Cached', models: ['c-1'] } }, cond: { etag: 'e-' + s.id } }
  }
}

`
  const src4 = src.replace(patch, patch4)
  if (src4 === src) { console.error('第四阶段补丁未生效（锚点变了）'); process.exit(2) }
  fs.writeFileSync(path.join(SB, 'server.mjs'), src4)

  // 预置一份"各源都没变、但日期已经停更 30 天"的快照：这正是短路会误判成"最新"的形态。
  const seedAt = new Date(Date.now() - 3600000).toISOString()
  fs.writeFileSync(WL, JSON.stringify({
    list_date: STALE30, fetched_at: seedAt,
    sources: { openrouter: '实时', freellm: STALE30, modelsdev: STALE30 },
    hosts: { 'cached-freellm.example.com': { source: 'Cached', models: ['c-1'], openFree: false, hybrid: false } },
    candidates: {},
    hostSources: { 'cached-freellm.example.com': ['freellm'] },
    contributionHistory: { 'cached-freellm.example.com': ['freellm'] },
    degradedSources: [],
    sourceCond: { openrouter: { etag: 'eo' }, freellm: { etag: 'ef' }, modelsdev: { etag: 'em' } },
    sourceFetchedAt: { openrouter: Date.now(), freellm: Date.now(), modelsdev: Date.now() },
    sourceHash: {},
  }, null, 2))

  const gw4 = cp.spawn(process.execPath, ['server.mjs'], { cwd: SB, stdio: ['ignore', 'pipe', 'pipe'] })
  let log4 = ''
  let gw4Exit = null
  gw4.stdout.on('data', (d) => { log4 += d })
  gw4.stderr.on('data', (d) => { log4 += d })
  gw4.on('exit', (code, sig) => { gw4Exit = { code, sig } })
  gw4.on('error', (e) => { gw4Exit = { code: -1, sig: String(e && e.message) } })
  let wl4 = null
  for (let i = 0; i < 40; i++) {
    await sleep(500)
    if (gw4Exit) break
    try {
      const j = JSON.parse(fs.readFileSync(WL, 'utf8'))
      // 判据：这是**本轮**写的（fetched_at 变了）且熔断确实执行了（freellm 状态带"已忽略"）
      if (j && j.fetched_at !== seedAt && /⚠停更\d+天, 已忽略/.test(String((j.sources || {}).freellm || ''))) { wl4 = j; break }
    } catch {}
  }
  try { gw4.kill() } catch {}
  if (process.platform === 'win32') {
    try { cp.execSync('taskkill /PID ' + gw4.pid + ' /F', { stdio: 'ignore' }) } catch {}
  }

  if (!wl4) {
    ck('第四阶段(304 短路 vs 停更熔断)拿到本轮结果', false, (gw4Exit ? `进程提前退出 code=${gw4Exit.code}` : '超时') + '\n' + log4.slice(-1200))
  } else {
    const h4 = Object.keys(wl4.hosts || {})
    ck('⚠ 反断言: 源全回 304 但已停更时，短路必须让位（日志可见）', /强制重建，让熔断判据真正执行一次/.test(log4), log4.slice(-900))
    ck('⚠ 反断言: 停更源的旧厂商没有借短路继续留在名单里', !h4.includes('cached-freellm.example.com'), h4.join(','))
    ck('健康源仍在名单里（重建没有误伤）', h4.includes('live-fake.example.com'), h4.join(','))
    ck('熔断也记进 degradedSources（残缺状态下一轮不会被短路钉死）',
      (wl4.degradedSources || []).includes('freellm'), JSON.stringify(wl4.degradedSources))
  }

  console.log(`\n== ${pass} passed, ${fail} failed ==`)
  process.exit(fail ? 1 : 0)
}
main().catch((e) => { console.error('HARNESS ERROR', e); process.exit(1) })
