// shotsnap3.cjs —— 界面视觉复检截图（走 CDP 真视口 + 按元素裁剪 + 2 倍像素比）
//
// 为什么必须"按元素裁剪 + 2x":
//   整页截图在 Read 工具里会被等比缩到 ~600px 宽, 卡片里 10~12px 的小字全糊掉, 没法做视觉复检。
//   裁剪成单个卡片再放大 2 倍, 才有足够像素密度看清字号、间距、颜色和 hover 态。
// 为什么走 CDP 而不是 --window-size:
//   headless 的最小宽度约 500px, `--window-size=390` 是**假视口**, 窄屏问题验不出来。
//
// 用法: node test/shotsnap3.cjs [url]   输出到 test/shots/, 用 Read 工具看图。
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')

const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find((p) => fs.existsSync(p))
const URL = process.argv[2] || 'http://127.0.0.1:8787/'
const OUT = path.join(__dirname, 'shots')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const port = 9500 + Math.floor(Math.random() * 60)
  const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-proxy-server', '--no-first-run',
    '--user-data-dir=' + path.join(os.tmpdir(), 'edge-ss3-' + port), '--remote-debugging-port=' + port, 'about:blank'],
    { stdio: 'ignore', env: { ...process.env, NO_PROXY: '*', no_proxy: '*' } })

  let wsUrl = null
  for (let i = 0; i < 40 && !wsUrl; i++) {
    await sleep(300)
    try { wsUrl = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl } catch {}
  }
  if (!wsUrl) throw new Error('连不上 Edge 调试端口')
  const ws = new WebSocket(wsUrl)
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
  let mid = 0
  const pending = new Map()
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  })
  const send = (method, params, sid) => new Promise((res) => {
    const id = ++mid
    pending.set(id, res)
    ws.send(JSON.stringify(sid ? { id, method, params, sessionId: sid } : { id, method, params }))
  })

  const t = await send('Target.createTarget', { url: 'about:blank' })
  const at = await send('Target.attachToTarget', { targetId: t.result.targetId, flatten: true })
  const sid = at.result.sessionId
  await send('Page.enable', {}, sid)
  await send('Runtime.enable', {}, sid)
  // 1200px 宽: 单栏约 600px, 裁下来再 2 倍正好是 1200px 的图, 缩到 600 仍能看清小字
  await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 1000, deviceScaleFactor: 1, mobile: false }, sid)
  await send('Page.navigate', { url: URL }, sid)
  await sleep(7000)

  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sid)
    if (r.result && r.result.exceptionDetails) console.log('  ⚠ 求值异常:', r.result.exceptionDetails.text)
    return r.result && r.result.result ? r.result.result.value : undefined
  }
  const save = (name, data) => {
    const f = path.join(OUT, name + '.png')
    fs.writeFileSync(f, Buffer.from(data, 'base64'))
    console.log('  ' + name + '.png  ' + fs.statSync(f).size + ' bytes')
  }
  // 整屏截图（只看整体布局与双栏配平, 不看小字）
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' }, sid)
    save(name, r.result.data)
  }
  const boxOf = (sel) => ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;const b=e.getBoundingClientRect();return {x:b.x+window.scrollX,y:b.y+window.scrollY,w:b.width,h:b.height}})()`)
  // 按元素裁剪 + 2 倍放大（看小字、间距、颜色）
  const shotEl = async (name, sel, pad = 6) => {
    const first = await ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;e.scrollIntoView({block:'center'});return 1})()`)
    if (!first) { console.log('  ⚠ 找不到元素 ' + sel); return }
    await sleep(350)
    const b = await boxOf(sel)
    if (!b) { console.log('  ⚠ 找不到元素 ' + sel); return }
    const r = await send('Page.captureScreenshot', {
      format: 'png', captureBeyondViewport: true,
      clip: { x: Math.max(0, b.x - pad), y: Math.max(0, b.y - pad), width: b.w + pad * 2, height: b.h + pad * 2, scale: 2 },
    }, sid)
    save(name, r.result.data)
  }
  // 把鼠标移到某元素中心 —— 专门用来验 hover 态（"悬停时看不清字"就是这么发现的）
  const hover = async (sel) => {
    const ok = await ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;e.scrollIntoView({block:'center'});return 1})()`)
    if (!ok) { console.log('  ⚠ 找不到元素 ' + sel); return }
    await sleep(250)
    const b = await ev(`(()=>{const r=document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b.x, y: b.y, buttons: 0 }, sid)
    await sleep(300)
  }

  // 1) 整体布局 + 各卡片特写
  await shot('new-dash-full')
  await shotEl('new-topbar', '.topbar')
  await shotEl('new-hero', '.hero')
  await shotEl('new-stats', '#statsbar')
  await shotEl('new-catalog', '#catalog')
  // 候选厂商面板（2026-09-21 起承载"无 Key 巡检"结论徽标）—— 必须单独复检:
  // 徽标/汇总行都是窄屏 min-content 的高危区, 只看整屏缩略图发现不了换行错乱。
  await shotEl('new-candbox', '#candbox')
  await shotEl('new-changes', '#chgcard')
  await shotEl('new-usage', '#usgcard')

  // 2) 厂商下拉展开（hover 到某一行, 验证 hover 态读得清）
  await ev(`openVpop()`)
  await sleep(500)
  await shotEl('new-vpop', '#vpop')
  await hover('.vopt')
  await shotEl('new-vpop-hover', '#vpop')
  await ev(`closeVpop()`)

  // 3) 配置片段弹层：切到 Node.js 并 hover —— 用户截图反馈"悬停看不清字"的就是这里
  await ev(`openSnippets();snipTab('node')`)
  await sleep(400)
  await shotEl('new-modal-snippets', '#modal .modal')
  await hover('[data-act="snip-tab"][data-k="claude"]')
  await shotEl('new-modal-snippets-hover', '#modal .modal')

  // 4) Key 管理弹层
  await ev(`(async()=>{closeModal();const p=LAST.find(x=>x.keyCount>1)||LAST[0];await openKeysModal(p.id)})()`)
  await sleep(900)
  await shotEl('new-modal-keys', '#modal .modal')
  await ev(`closeModal()`)

  // 5) 链路自检：空态 + 跑一次真实流式请求
  await ev(`switchView('play')`)
  await sleep(2000)
  await shotEl('new-play-empty', '#view-play .card')
  await ev(`(async()=>{document.getElementById('pg_in').value='用一句话说明你是什么模型';await playRun()})()`)
  await sleep(600)
  await shotEl('new-play-run', '#view-play .card')
  await ev(`switchView('dash')`)

  // 6) 窄屏（真移动视口）
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, sid)
  await sleep(1200)
  await shot('new-mobile-full')
  await ev(`document.getElementById('usgcard').scrollIntoView({block:'start'})`)
  await sleep(400)
  await shot('new-mobile-log')

  ws.close(); proc.kill()
  console.log('完成 → ' + OUT)
}
main().catch((e) => { console.log('出错:', e.message); process.exit(1) })
