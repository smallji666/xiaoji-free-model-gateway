// 分段截全页（每段 2x 可读）。用法: node test/shotseg.cjs [宽=1200] [前缀]
const { spawn } = require('child_process')
const fs = require('fs'), path = require('path'), os = require('os')
const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find((p) => fs.existsSync(p))
const W = parseInt(process.argv[2] || '1200', 10)
const PREFIX = process.argv[3] || 'dash'
// 网关端口: 默认生产 8787; 截沙箱实例时用 GW_PORT=<port>（例如截图前先起 8790 的临时实例）
const GW_PORT = parseInt(process.env.GW_PORT || '8787', 10)
const PORT = 9300 + Math.floor(Math.random() * 600)
const OUTDIR = path.join(__dirname, 'shots')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  fs.mkdirSync(OUTDIR, { recursive: true })
  // ⚠ profile 目录必须**每次都唯一**（2026-10-04 踩到）：原来用 `edge-seg-<PORT>`，而 PORT 是
  // 9300+random(600)，两次跑很容易撞上同一个 → 复用 profile 的磁盘缓存 → 截图是**上一版页面**，
  // 于是"改了没生效"的假象（实测服务端已返回新 HTML，截图却还是旧 note 文案）。
  // ⚠ 必须显式 `--proxy-server=direct://`：本机开着系统代理时，只写 `--no-proxy-server`
  // 在部分 Edge 版本上不生效 → 浏览器把 127.0.0.1:8787 也交给代理 → 代理不转发 loopback →
  // 截到的是 Edge 的「127.0.0.1 拒绝连接」错误页（页面尺寸只剩视口高 1000px，且没有 loadChanges）。
  const browser = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${PORT}`, '--disable-gpu', '--no-proxy-server', '--proxy-server=direct://', '--proxy-bypass-list=127.0.0.1;localhost', '--hide-scrollbars', '--disable-http-cache', '--disk-cache-size=1', `--window-size=${W},1200`, '--user-data-dir=' + path.join(os.tmpdir(), 'edge-seg-' + Date.now() + '-' + PORT), 'about:blank'], { stdio: 'ignore' })
  let target = null
  for (let i = 0; i < 60; i++) {
    try { const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); target = list.find((t) => t.type === 'page'); if (target && target.webSocketDebuggerUrl) break } catch {}
    await sleep(250)
  }
  if (!target) { browser.kill(); throw new Error('CDP 没起来') }
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  let id = 0; const pend = new Map()
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
  ws.addEventListener('message', (ev) => { let m; try { m = JSON.parse(ev.data) } catch { return }; if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } })
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, (m) => res(m.result)); ws.send(JSON.stringify({ id: i, method, params })) })

  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: 1000, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: `http://127.0.0.1:${GW_PORT}/?t=` + Date.now() })
  await sleep(3500)
  // 代码版本自检：截图说"改了没生效"时，先分清是**服务端没给新 HTML** 还是**浏览器用了缓存**。
  // 判据：浏览器里 loadChanges 的源码是否含新标识 + 生效的 CSS 规则里 pool_sync 是什么颜色。
  const chk = await send('Runtime.evaluate', { expression: `JSON.stringify({
    hasSyncN: typeof loadChanges === 'function' && String(loadChanges).includes('syncN'),
    syncColor: (()=>{ const out=[]; for(const ss of document.styleSheets){ try{ for(const r of ss.cssRules){ if(r.selectorText&&r.selectorText.includes('pool_sync')) out.push(r.style.color) } }catch{} } return out })(),
    firstSyncNote: (()=>{ const els=[...document.querySelectorAll('#changes .chg')]; const e=els.find(x=>x.querySelector('.tag.pool_sync')); return e? e.innerText.replace(/\\n/g,' | ') : '(无 pool_sync 行)' })()
  })`, returnByValue: true })
  console.log('  代码自检:', chk.result.value)

  const dim = (await send('Runtime.evaluate', { expression: 'JSON.stringify({h:document.documentElement.scrollHeight,w:document.documentElement.scrollWidth})', returnByValue: true })).result.value
  const { h, w } = JSON.parse(dim)
  console.log(`页面尺寸: ${w} x ${h}`)

  const SEG = 900
  const n = Math.ceil(h / SEG)
  for (let i = 0; i < n; i++) {
    const y = i * SEG
    const clipH = Math.min(SEG, h - y)
    const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y, width: w, height: clipH, scale: 1.6 } })
    const f = path.join(OUTDIR, `${PREFIX}-${String(i).padStart(2, '0')}.png`)
    fs.writeFileSync(f, Buffer.from(r.data, 'base64'))
    console.log('  ->', f)
  }
  browser.kill()
  console.log('完成，共', n, '段')
}
main().catch((e) => { console.log('ERR', e.message); process.exit(1) })
