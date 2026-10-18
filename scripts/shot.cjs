// 局部截图复检：node scripts/shot.cjs "<选择器>" <out.png> [视口宽=1200] [缩放=2] ["先执行的JS"]
// 为什么需要它：整页截图在聊天窗口里会被缩到 ~0.57x，字体/字距/圆角/内边距全糊掉 ——
// 用户说某块"丑"时，必须看 2x 局部图才找得到真因（2026-09-25 实测：整页只觉得"有点乱"，
// 2x 局部图一眼看出那排标签用的是等宽字体）。
// 第 6 个参数用于先展开折叠区（默认收起的面板截不到内容）。
// 端口用 GW_PORT 覆盖（2026-10-11 补）：和 layout-check 同一套口径 —— 要量/截**沙箱**实例时
// 必须能改端口，否则只能去动生产目录，而生产目录一起网关就会按当时的网络条件改写白名单。
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')

const GW = process.env.GW_PORT || '8787'

const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p))

const sel = process.argv[2] || 'body'
const out = path.resolve(process.argv[3] || 'shot.png')
const W = parseInt(process.argv[4] || '1200', 10)
const SCALE = parseFloat(process.argv[5] || '2')
const PRE = process.argv[6] || ''
// ⚠ 端口和 user-data-dir 必须**每个进程独立**：写死的话，并行跑两次截图时第二个 Edge 会发现
//   同 user-data-dir 已有实例，把请求转过去 → 截到的是**上一个进程的页面状态**（实测：默认态
//   截出来是上一次的展开态，而且 clip 尺寸还算在别的元素上）。随机端口即可。
const PORT = 9300 + Math.floor(Math.random() * 600)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  if (!EDGE) throw new Error('找不到 Edge')
  const browser = spawn(EDGE, [
    '--headless=new', `--remote-debugging-port=${PORT}`, '--disable-gpu',
    // --no-proxy-server 必加：shell 里的 http_proxy 会把 127.0.0.1 也转给外部代理，得到假故障
    '--no-proxy-server', '--hide-scrollbars', `--window-size=${W},1200`,
    '--user-data-dir=' + path.join(os.tmpdir(), 'edge-shot-' + PORT), 'about:blank',
  ], { stdio: 'ignore' })

  let target = null
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      target = list.find((t) => t.type === 'page')
      if (target && target.webSocketDebuggerUrl) break
    } catch {}
    await sleep(250)
  }
  if (!target) { browser.kill(); throw new Error('CDP 没起来') }

  const ws = new WebSocket(target.webSocketDebuggerUrl)
  let id = 0
  const pend = new Map()
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
  ws.addEventListener('message', (ev) => {
    let m; try { m = JSON.parse(ev.data) } catch { return }
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) }
  })
  const send = (method, params = {}) => new Promise((res) => {
    const i = ++id; pend.set(i, (m) => res(m.result)); ws.send(JSON.stringify({ id: i, method, params }))
  })

  await send('Page.enable')
  // ⚠ 必须用 Emulation.setDeviceMetricsOverride：headless 的 --window-size 会虚报布局宽度
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: 1200, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: `http://127.0.0.1:${GW}/` })
  await sleep(6000)

  // ⚠ 剥离 :hover 规则（2026-09-26 实测，这条坑过一次视觉判断）：
  //   `Page.captureScreenshot{captureBeyondViewport:true}` 会把 **:hover 态渲染进图里** ——
  //   实测供应商行按钮 computed color 是灰 `--sub`，截图里却全是蓝/红（hover 态），
  //   而同一次会话里 JS 查 `document.querySelectorAll(':hover').length === 0`。
  //   于是"默认灰、hover 才亮"的设计在截图里看起来像"一屏 35 个彩色文字按钮"，
  //   基于截图得出的结论（"红色被稀释了，该改"）全是错的。
  //   视觉复检要看的是**默认态**（用户 99% 时间看到的），所以默认剥掉全部 hover 规则。
  //   剥完在 stdout 打出条数，别让它静默发生。
  const stripped = await send('Runtime.evaluate', {
    expression: `(()=>{let n=0;const drop=(list,del)=>{for(let i=list.length-1;i>=0;i--){
        const r=list[i];
        if(r.selectorText){ if(/:hover/.test(r.selectorText)){del(i);n++} }
        else if(r.cssRules){ drop(r.cssRules,(j)=>r.deleteRule(j)) }
      }};
      for(const ss of document.styleSheets){ try{ drop(ss.cssRules,(i)=>ss.deleteRule(i)) }catch(e){} }
      return n})()`,
    returnByValue: true,
  })
  console.log('stripped hover rules:', stripped.result?.value)

  if (PRE) {
    const r = await send('Runtime.evaluate', { expression: PRE, returnByValue: true, awaitPromise: true })
    console.log('pre:', JSON.stringify(r.result?.value ?? r.exceptionDetails?.text ?? '').slice(0, 300))
    await sleep(900)
  }

  // 用 closest('.card') 兜一层：直接量内容容器会把卡片内边距和标题切掉
  const box = await send('Runtime.evaluate', {
    expression: `(()=>{const e=document.querySelector(${JSON.stringify(sel)});
      if(!e) return null; const c=e.closest('.card')||e; const r=c.getBoundingClientRect();
      return {x:r.x+scrollX,y:r.y+scrollY,width:r.width,height:r.height}})()`,
    returnByValue: true,
  })
  if (!box?.result?.value) { ws.close(); browser.kill(); throw new Error('选择器没匹配到: ' + sel) }
  const b = box.result.value
  const shot = await send('Page.captureScreenshot', {
    format: 'png', captureBeyondViewport: true,   // 元素在视口外也要能截
    // ⚠ clip 用文档坐标（要加 scrollY），不是视口坐标
    clip: { x: Math.max(0, b.x - 6), y: Math.max(0, b.y - 6), width: b.width + 12, height: b.height + 12, scale: SCALE },
  })
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'))
  console.log('ok', out, `${Math.round(b.width)}x${Math.round(b.height)} @${SCALE}x`)
  ws.close(); browser.kill()
}
main().catch((e) => { console.error('FAIL', e.message); process.exit(1) })
