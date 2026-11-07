// 用真实 Edge CDP 校验移动端：宽度、横向溢出、核心控件可见性。
// Headless 的 --window-size 在窄屏会虚报布局宽度，必须用 Emulation.setDeviceMetricsOverride。
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')
const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0, skip = 0
const t = (name, ok, detail = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`) }
// 跳过：前提不成立时不算失败。典型场景 —— 元素只在用户操作后才渲染（.mchip 要先点「拉取免费模型」
// 才有内容，装它的 #modellist 默认 display:none）。把"没渲染"当 FAIL 会长期报假失败，把真信号淹掉。
const ts = (name, why) => { skip++; console.log(`SKIP  ${name}  ${why}`) }

;(async () => {
  if (!EDGE) throw new Error('找不到 Edge')
  const port = 9470 + Math.floor(Math.random() * 80)
  const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-proxy-server', '--no-first-run', '--user-data-dir=' + path.join(os.tmpdir(), 'xiaoji-mobile-' + port), '--remote-debugging-port=' + port, 'about:blank'], { stdio: 'ignore', env: { ...process.env, NO_PROXY: '*', no_proxy: '*' } })
  let wsUrl = ''
  for (let i = 0; i < 40 && !wsUrl; i++) { await sleep(250); try { wsUrl = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl } catch {} }
  if (!wsUrl) throw new Error('CDP 未启动')
  const ws = new WebSocket(wsUrl)
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
  let id = 0; const pending = new Map()
  ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } })
  const send = (method, params = {}, sessionId) => new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) })) })
  const target = await send('Target.createTarget', { url: 'about:blank' })
  const attached = await send('Target.attachToTarget', { targetId: target.result.targetId, flatten: true })
  const sid = attached.result.sessionId
  await send('Page.enable', {}, sid); await send('Runtime.enable', {}, sid)
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, sid)
  await send('Page.navigate', { url: 'http://127.0.0.1:8787/' }, sid)
  await sleep(6500)
  const ev = await send('Runtime.evaluate', { expression: `JSON.stringify((() => {
    const rect = (s) => { const e=document.querySelector(s),b=e&&e.getBoundingClientRect(); return b&&{x:b.x,y:b.y,w:b.width,h:b.height,right:b.right} }
    // 溢出判定要看"用户是否真的看到它溢出": 元素自己的布局盒超出视口不算数,
    // 只要**祖先里有 overflow 裁剪且该祖先本身没超视口**, 视觉上就是被裁掉的(例: .chg .bd 里的
    // 行内 .nt —— 父级 nowrap+ellipsis, 超长部分根本画不出来)。只按 getBoundingClientRect 判会误报。
    const clipped = (e) => {
      for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) {
        const pc = getComputedStyle(p)
        if (pc.overflowX !== 'visible' || pc.overflowY !== 'visible') {
          if (p.getBoundingClientRect().right <= innerWidth + 1) return true
        }
      }
      return false
    }
    const overs=[...document.querySelectorAll('body *')].filter(e=>{
      const b=e.getBoundingClientRect(), cs=getComputedStyle(e)
      if(cs.position==='fixed'||b.width<=1||b.right<=innerWidth+1) return false
      if(cs.overflowX!=='visible') return false      // 自己就是裁剪容器(内部滚动), 不算页面溢出
      return !clipped(e)
    }).map(e=>e.className||e.id||e.tagName).slice(0,12)
    return { vw:innerWidth, scrollW:document.documentElement.scrollWidth, overs, grid:rect('.grid'), topbar:rect('.topbar'), live:rect('.live'), hero:rect('.card.hero'), mchip:rect('.mchip'), mchipHidden:(()=>{const e=document.querySelector('.mchip');return e?e.offsetParent===null:null})(), buttons:[...document.querySelectorAll('#wlsync')].map(e=>({id:e.id,display:getComputedStyle(e).display,rect:rect('#'+e.id)})) }
  })())`, returnByValue: true }, sid)
  const data = JSON.parse(ev.result.result.value)
  console.log(JSON.stringify(data, null, 2))
  t('移动视口为 390px', data.vw === 390, `vw=${data.vw}`)
  t('无横向滚动溢出', data.scrollW <= data.vw, `scrollW=${data.scrollW}`)
  t('无超出屏幕的普通元素', data.overs.length === 0, data.overs.join(', '))
  t('双栏在移动端收为单栏', data.grid && data.grid.w <= 391, JSON.stringify(data.grid))
  if (data.mchipHidden === null) ts('模型 chip 在移动端可见', '页面上没有 .mchip')
  else if (data.mchipHidden) ts('模型 chip 在移动端可见', '.mchip 所在容器默认隐藏（要先点「拉取免费模型」）')
  else t('模型 chip 在移动端可见', data.mchip && data.mchip.w > 0)
  t('顶部运行状态可见', data.live && data.live.right <= data.vw + 1)
  t('免费池刷新按钮在移动端可见', data.buttons.every((b) => b.display !== 'none' && b.rect && b.rect.w > 0), JSON.stringify(data.buttons))
  console.log(`\n${fail ? '✗' : '✓'} ${pass}/${pass + fail} 通过${skip ? ` · ${skip} 跳过` : ''}`)
  ws.close(); proc.kill(); process.exit(fail ? 1 : 0)
})().catch((e) => { console.error('ERR', e.message); process.exit(1) })
