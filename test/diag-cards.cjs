// diag-cards.cjs —— 两列高度差的**分卡定位**工具（layout-check 只报总差，这个报"差在哪张卡"）。
//
// 什么时候用它：layout-check 报两列越线（>60px）时，先看总差；若总差来源不明，
//   再用本工具逐卡量高度，定位到"是哪张卡长大了"。
// 为什么单独一个脚本：layout-check 是**断言**（红/绿），本工具是**排查**（给数）。
//   把排查逻辑塞进断言脚本会让断言变复杂，而排查只在越线时才需要。
// 复用 layout-check.cjs 里的 INJECT 固定样本（避免复制走样）。
const { spawn } = require('child_process')
const fs = require('fs'); const path = require('path'); const os = require('os')

const ROOT = (() => { const _fs = require('fs'), _p = require('path'); let d = _p.dirname(__dirname); for (let i = 0; i < 6; i++) { if (_fs.existsSync(_p.join(d, 'server.mjs'))) return d; d = _p.dirname(d) } return _p.join(__dirname, '..') })()
const src = fs.readFileSync(path.join(__dirname, 'layout-check.cjs'), 'utf8')
const INJECT = src.match(/const INJECT = `([\s\S]*?)`\n/)[1]

const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find((p) => fs.existsSync(p))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const PROBE = `JSON.stringify((()=>{
  const cards = [...document.querySelectorAll('#view-dash .grid > .col')].map((col,ci)=>({
    col: ci,
    total: Math.round(col.getBoundingClientRect().height),
    items: [...col.children].map(e=>{
      const h2 = e.querySelector('h2');
      const name = (e.id || (h2 ? h2.textContent.trim().slice(0,10) : e.className)).slice(0,18);
      return name + '=' + Math.round(e.getBoundingClientRect().height);
    })
  }));
  return { w: innerWidth, cards };
})())`

;(async () => {
  const port = 9700 + Math.floor(Math.random() * 200)
  const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-proxy-server', '--no-first-run',
    '--user-data-dir=' + path.join(os.tmpdir(), 'diag-' + port), '--remote-debugging-port=' + port, 'about:blank'],
    { stdio: 'ignore', env: { ...process.env, NO_PROXY: '*', no_proxy: '*' } })
  let wsUrl = ''
  for (let i = 0; i < 40 && !wsUrl; i++) { await sleep(250); try { wsUrl = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl } catch {} }
  if (!wsUrl) throw new Error('CDP 未启动')
  const ws = new WebSocket(wsUrl)
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
  let id = 0; const pending = new Map()
  ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } })
  const send = (method, params = {}, sid) => new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params, ...(sid ? { sessionId: sid } : {}) })) })

  const t = await send('Target.createTarget', { url: 'about:blank' })
  const sid = (await send('Target.attachToTarget', { targetId: t.result.targetId, flatten: true })).result.sessionId
  await send('Page.enable', {}, sid); await send('Runtime.enable', {}, sid)

  for (const W of [1200, 1280, 1360, 1440, 1600]) {
    await send('Emulation.setDeviceMetricsOverride', { width: W, height: 900, deviceScaleFactor: 1, mobile: false }, sid)
    await send('Page.navigate', { url: 'http://127.0.0.1:8787/' }, sid)
    await sleep(3500)
    const inj = await send('Runtime.evaluate', { expression: INJECT, returnByValue: true }, sid)
    if (inj.result.result.value !== 'injected') { console.log(`${W}px 注入失败:`, JSON.stringify(inj.result.result.value)); continue }
    await sleep(300)
    const r = await send('Runtime.evaluate', { expression: PROBE, returnByValue: true }, sid)
    const d = JSON.parse(r.result.result.value)
    const [a, b] = d.cards.map((c) => c.total)
    console.log(`${W}px  左 ${a} / 右 ${b}  差 ${Math.abs(a - b)}px  ${Math.abs(a - b) <= 60 ? 'OK' : '❌ 越线'}`)
    if (W === 1440) for (const c of d.cards) { console.log(`   列${c.col}: ` + c.items.join(' | ')) }
  }
  ws.close(); proc.kill()
})().catch((e) => { console.error('FAIL', e.message); process.exit(1) })
