// 截任意 URL（需要时走 HTTPS_PROXY 指定的代理）—— 用来看**真实参考设计**，不是自检自己的页面。
//
// 为什么需要它：用户说"不好看 / 你不会设计"时，凭印象改是低效的 —— 实测 2026-09-26 连改三轮
// 都没过（在"分隔线 / 纯文字 / 淡底标签"之间来回）。第四轮先截了 openrouter.ai/models 来对照，
// 差距一眼可见：人家每个条目是**独立卡片**、主标题明显更大、还有**彩色小徽标**做亮点。
//
//   node scripts/webshot.cjs <url> <out.png> [宽=1440] [高=1200] [full] [等待ms=12000]
//
// 代理：读环境变量 `HTTPS_PROXY` / `HTTP_PROXY`，**不设就直连**（2026-09-26 修）。
// 原来无条件挂 `--proxy-server`，代理一关就截到一堆 413px 高的代理错误页 —— 而且三张参考图
// 高度全是 413，看起来像"这几个站都是 SPA"，其实是同一个错误页。没代理就直连。
// 截本机页面用的 `scripts/shot.cjs` 相反，永远要 `--no-proxy-server`。
const { spawn } = require('child_process')
const fs = require('fs'), path = require('path'), os = require('os')

const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p))

const url = process.argv[2]
const out = path.resolve(process.argv[3] || 'ref.png')
const W = parseInt(process.argv[4] || '1440', 10)
const H = parseInt(process.argv[5] || '1200', 10)
const FULL = process.argv[6] === 'full'
const WAIT = parseInt(process.argv[7] || '12000', 10)
// 端口随机：写死会让并行/连续的两次截图抢同一个实例
const PORT = 9600 + Math.floor(Math.random() * 300)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  if (!EDGE) throw new Error('找不到 Edge')
  if (!url) throw new Error('用法: node scripts/webshot.cjs <url> <out.png> [宽] [高] [full] [等待ms]')
  // 代理从环境变量取；不设就直连。
  const PROXY = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || null
  console.log('proxy:', PROXY || '（未开，直连）')

  const browser = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${PORT}`, '--disable-gpu',
    ...(PROXY ? [`--proxy-server=${PROXY}`] : []), '--hide-scrollbars', `--window-size=${W},${H}`,
    '--user-data-dir=' + path.join(os.tmpdir(), 'edge-web-' + PORT), 'about:blank'], { stdio: 'ignore' })

  let t = null
  for (let i = 0; i < 80; i++) {
    try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); t = l.find((x) => x.type === 'page'); if (t?.webSocketDebuggerUrl) break } catch {}
    await sleep(250)
  }
  if (!t) { browser.kill(); throw new Error('CDP 没起来') }

  const ws = new WebSocket(t.webSocketDebuggerUrl)
  let id = 0; const pend = new Map()
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
  ws.addEventListener('message', (ev) => { let m; try { m = JSON.parse(ev.data) } catch { return } if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } })
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, (m) => res(m.result)); ws.send(JSON.stringify({ id: i, method, params })) })

  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url })
  await sleep(WAIT)   // 这类站全是前端渲染，等不够会截到骨架屏
  const info = await send('Runtime.evaluate', { expression: `JSON.stringify({t:document.title,h:document.body.scrollHeight})`, returnByValue: true })
  console.log('page:', info.result.value)
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: FULL })
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'))
  console.log('ok', out)
  ws.close(); browser.kill()
}
main().catch((e) => { console.error('FAIL', e.message); process.exit(1) })
