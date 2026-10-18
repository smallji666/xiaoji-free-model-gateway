// 版面体检：两列等高 / 字号分布 / 横向溢出 / JS 报错。
// 用真实 Edge CDP（headless 的 --window-size 会虚报布局宽度，必须用 Emulation.setDeviceMetricsOverride）。
//
// 为什么单独一个脚本：console-check 管交互与 hover 对比度，mobile-layout-check 管 390px 窄屏，
// 而「两列高度差」和「11px 字号占比」这两个指标**两个脚本都没覆盖** ——
// 实测 2026-09-25 两列差从 24px 漂到 72px、11px 占比 81.6%（红线目标 <40%），一路没人发现。
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
const ts = (name, why) => { skip++; console.log(`SKIP  ${name}  ${why}`) }

// ── 红线阈值（改这里就等于改标准，别在断言里散落魔法数字）──
// 网关端口: 默认生产 8787; 量沙箱实例时用 GW_PORT=<port>
const GW_PORT = parseInt(process.env.GW_PORT || '8787', 10)
const MAX_COL_DIFF = 60      // 两列高度差；超过就说明内容分配失衡，页面上会出现大片死白
const MAX_P11 = 40           // **最小档**叶子占比上限（红线：不能让所有文字都挤在最小档）
// 字号档位体系。⚠ 这里写的是**档位的当前值**，改 `--fs-*` 的值就必须同步改这一行 ——
// 2026-09-25 收紧到 10.5/11.5/14/21；2026-10-10 定到 11/12/14/22；
// 2026-10-11 第七轮曾提到 12/13/15/18/26；**同日用户"算了，恢复前天的样式"→ `dashboard.html`
// 整份回退到 10-09 版，这里同步退回 10.5/11.5/14/21**。
// 改 --fs-* 就必须同步改这一行，否则断言恒真（假 PASS）或恒假（假 FAIL）。
const ALLOWED_FS = ['10.5px', '11.5px', '14px', '21px']

// ── 目录数据固定（2026-09-26 第五轮补）──
// 为什么必须固定：这个脚本量的是**活数据**，而「免费模型目录」的高度随数据剧烈变化 ——
// 上游代理没开时 7 家里 6 家是失败态，整卡 351px；有数据时 578px（差 227px）。
// 于是同一次改动，代理开着判 PASS、关着判 FAIL（实测 09-26 基线 11/13，两列差 65/94px）。
// **一个会随用户 VPN 开关翻脸的版面指标，两个方向都不可信。** 固定成一份有代表性的样本
// （7 家、有长模型名、有失败家、有 0 模型家、有 +N 折叠）之后，这个数字才真正可比。
// ⚠ 代价：不再覆盖"真实数据里出现极端长名"的情况，样本里已尽量放长名兜住。
const INJECT = `(function(){
  if (typeof renderCatalog !== 'function') return 'no-fn';
  var mk=function(label,ids,total,excl,dead){
    return {label:label,name:label,total:total,excluded_total:excl,
      excluded:[{id:'models/'+label+'-embed',kind:'嵌入',reason:'r'},{id:'models/'+label+'-image',kind:'图像/视频生成',reason:'r'}],
      models:ids.map(function(id,i){
        return {id:id,rec:i%3===0,promo:i===2?{note:'限时免费活动',until:'2026-10-15'}:null,
          type:'文字对话',dead:(dead&&i===5)?'blocked':null,dead_reason:(dead&&i===5)?'HTTP 404 model is not found':null};
      })};
  };
  renderCatalog({updated_at:'2026-09-26T05:00:00.000Z',providers:[
    mk('groq',['allam-2-7b'],11,7),
    mk('gemini',['models/gemini-3.5-flash','models/gemini-3.1-flash-lite','models/gemini-3-flash-preview','models/gemini-3.1-flash-live-preview','models/gemini-3.5-pro','models/gemini-3.1-pro','models/gemini-3.5-flash-lite','models/gemini-3-pro-preview','models/gemini-3.1-flash'],61,26,true),
    mk('mistral',['codestral-2508','ministral-3b','magistral-small','mistral-medium-3','pixtral-large','devstral-small'],46,15),
    mk('amd',['DeepSeek-V4-Flash','DeepSeek-V4-Flash-Vision-Exp','MiniCPM5-2B','Qwen3.8-Flash-Next'],8,1),
    mk('openrouter',['z-ai/glm-4.6:free','qwen/qwen3-235b-a22b:free','deepseek/deepseek-chat-v3:free','meta-llama/llama-4-scout:free','google/gemma-3-27b-it:free','mistralai/mistral-nemo:free','moonshotai/kimi-k2:free','x-ai/grok-4-fast:free'],458,17,true),
    mk('empero',[],0,0),
    mk('sensenova',[],0,0)
  ]});
  return 'injected';
})()`

const PROBE = `JSON.stringify((() => {
  const out = {};
  // 「免费池变动」的列表长度必须钉死（2026-10-11 补）—— 它直接决定右列高度，
  // 而它本身是**活数据**：沙箱里条目数随启动同步 / 免 Key 巡检的进度浮动，
  // 实测两次完全相同的运行右列高度差 71px（1496 / 1425），而这个高度正是靠
  // #changes 的 max-height 手工补偿的 —— 源数据会飘，等于每次调参都在掷骰子。
  // ⚠ 必须放在 PROBE 里、紧贴测量之前：页面里 setInterval(loadChanges) 注册时就把
  //   函数引用拿走了，事后覆盖 window.loadChanges **拦不住它**（实测被覆盖回去，
  //   右列高度又飘）。PROBE 是一次同步求值，中间没有定时器插进来的机会。
  (function(){
    var b = '';
    for (var i = 0; i < 20; i++) b += '<div class="chg"><span class="tm">10月11日 02:0' + (i % 10) + '</span>'
      + '<span class="tag pool_sync">池同步</span>'
      + '<span class="bd"><b>provider-' + (i % 7) + '</b> <span class="mdl">model-name-' + (i % 5)
      + '</span> <span class="nt">4 个模型</span></span></div>';
    var c = document.getElementById('changes'); if (c) c.innerHTML = b;
    var w = document.getElementById('promowarn'); if (w) w.innerHTML = '';
    var k = document.getElementById('chgcard'); if (k) k.style.display = 'block';
  })();
  const grid = document.querySelector('.grid');
  out.cols = grid ? [...grid.children].filter(c => c.nodeType === 1).map(c => Math.round(c.getBoundingClientRect().height)) : null;
  out.scrollW = document.documentElement.scrollWidth;
  out.innerW = window.innerWidth;
  out.pageH = Math.round(document.body.scrollHeight);

  const NON_RENDER = new Set(['SCRIPT','STYLE','TITLE','META','LINK','HEAD','HTML']);
  const hasOwnText = (el) => { for (const n of el.childNodes) if (n.nodeType === 3 && n.textContent.trim()) return true; return false };
  const buckets = {}; let leaves = 0; const strays = [];
  for (const el of document.querySelectorAll('*')) {
    if (NON_RENDER.has(el.tagName)) continue;
    if (!hasOwnText(el)) continue;
    const fs = getComputedStyle(el).fontSize;
    buckets[fs] = (buckets[fs] || 0) + 1; leaves++;
    if (!${JSON.stringify(ALLOWED_FS)}.includes(fs) && strays.length < 8) strays.push(fs + ' @ ' + ((el.className||el.tagName)+'').slice(0,30));
  }
  out.leaves = leaves;
  // ⚠ 口径是"**最小档**占比"而不是写死的 '11px'：字号档位的值一改（11→10.5），
  //   写死字符串就会永远取到 0 → 断言恒真 = 假断言，指标从此没人守。
  out.p11 = leaves ? +((buckets[${JSON.stringify(ALLOWED_FS[0])}]||0) / leaves * 100).toFixed(1) : 0;
  out.strays = strays;
  out.buckets = Object.entries(buckets).sort((a,b)=>parseFloat(a[0])-parseFloat(b[0]));

  const rows = [...document.querySelectorAll('.prow')].map(r => Math.round(r.getBoundingClientRect().height));
  out.prowH = rows;

  // 横向溢出：按视觉判定。元素自己的盒超出视口不算数，只要祖先有 overflow 裁剪且该祖先没超视口，
  // 视觉上就是被裁掉的（.chg .bd 里 nowrap+ellipsis 的行内元素就是这种）。
  const clipped = (e) => {
    for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) {
      const pc = getComputedStyle(p);
      if (pc.overflowX !== 'visible' || pc.overflowY !== 'visible') {
        if (p.getBoundingClientRect().right <= innerWidth + 1) return true;
      }
    }
    return false;
  };
  out.overs = [...document.querySelectorAll('body *')].filter(e => {
    const b = e.getBoundingClientRect(), cs = getComputedStyle(e);
    if (cs.position === 'fixed' || b.width <= 1 || b.right <= innerWidth + 1) return false;
    if (cs.overflowX !== 'visible') return false;
    return !clipped(e);
  }).map(e => ((e.className||e.id||e.tagName)+'').slice(0,40)).slice(0,10);

  // 每张卡的实际高度（2026-10-11 补）：两列差越线时，光看总和不知道该调哪张卡 ——
  // 这张表直接指出"是哪张卡长出来的"，省掉一轮轮试。补偿位是 #changes 的 max-height。
  out.cards = [...document.querySelectorAll('.grid > .col')].map(col => [...col.children].map(c => {
    const h = c.querySelector('h2');
    return [h ? h.textContent.replace(/\s+/g, ' ').trim().slice(0, 12) : (c.id || c.className), Math.round(c.getBoundingClientRect().height)];
  }));
  const ch = document.getElementById('changes');
  out.chg = ch ? { h: ch.clientHeight, n: ch.querySelectorAll('.chg').length, max: getComputedStyle(ch).maxHeight } : null;
  return out;
})())`

;(async () => {
  if (!EDGE) throw new Error('找不到 Edge')
  const port = 9600 + Math.floor(Math.random() * 80)
  const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-proxy-server', '--no-first-run',
    '--proxy-server=direct://', '--proxy-bypass-list=127.0.0.1;localhost',
    '--user-data-dir=' + path.join(os.tmpdir(), 'xiaoji-layout-' + port),
    '--remote-debugging-port=' + port, 'about:blank'],
    { stdio: 'ignore', env: { ...process.env, NO_PROXY: '*', no_proxy: '*' } })

  let wsUrl = ''
  for (let i = 0; i < 40 && !wsUrl; i++) {
    await sleep(250)
    try { wsUrl = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl } catch {}
  }
  if (!wsUrl) throw new Error('CDP 未启动')

  const ws = new WebSocket(wsUrl)
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
  let id = 0; const pending = new Map()
  const errors = []
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return }
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errors.push(m.params.entry.text)
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text || 'exception')
  })
  const send = (method, params = {}, sid) => new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params, ...(sid ? { sessionId: sid } : {}) })) })

  const target = await send('Target.createTarget', { url: 'about:blank' })
  const attached = await send('Target.attachToTarget', { targetId: target.result.targetId, flatten: true })
  const sid = attached.result.sessionId
  await send('Page.enable', {}, sid); await send('Runtime.enable', {}, sid); await send('Log.enable', {}, sid)

  // 桌面与窄屏各测一遍。字号分布与视口无关（同一套 CSS），只测一次省时间。
  const measure = async (w, h, mobile) => {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, mobile }, sid)
    await send('Page.navigate', { url: 'http://127.0.0.1:' + GW_PORT + '/' }, sid)
    await sleep(6000)
    // 先钉住目录数据，再量 —— 否则"代理开没开"会决定这次体检的结论（见 INJECT 注释）
    const inj = await send('Runtime.evaluate', { expression: INJECT, returnByValue: true }, sid)
    if (inj.result.result.value !== 'injected') console.log('  ⚠ 目录数据注入失败：' + JSON.stringify(inj.result.result.value))
    await sleep(400)
    const ev = await send('Runtime.evaluate', { expression: PROBE, returnByValue: true }, sid)
    return JSON.parse(ev.result.result.value)
  }

  const d = await measure(1200, 900, false)
  console.log(`桌面 1200px: 页高 ${d.pageH}  两列 [${d.cols}]  叶子 ${d.leaves}`)
  console.log('  字号分布: ' + d.buckets.map(([k, v]) => `${k}×${v}`).join('  '))
  if (d.cards) for (const [i, col] of d.cards.entries()) for (const [n, h] of col) console.log(`    ${i ? '右' : '左'} · ${n} = ${h}`)
  if (d.chg) console.log(`    #changes 高 ${d.chg.h} · ${d.chg.n} 行 · max-height ${d.chg.max}`)

  t('无横向滚动溢出（1200px）', d.scrollW <= d.innerW, `scrollW=${d.scrollW} innerW=${d.innerW}`)
  t('无超出屏幕的元素（1200px）', d.overs.length === 0, d.overs.join(', '))

  if (!d.cols || d.cols.length !== 2) ts('两列高度差 ≤ ' + MAX_COL_DIFF + 'px', '不是双列布局')
  else {
    const diff = Math.abs(d.cols[0] - d.cols[1])
    t(`两列高度差 ≤ ${MAX_COL_DIFF}px`, diff <= MAX_COL_DIFF, `实际 ${diff}px（${d.cols[0]} / ${d.cols[1]}）`)
  }

  if (d.prowH.length < 2) ts('供应商行等高', '供应商行少于 2 条')
  else t('供应商行等高', new Set(d.prowH).size === 1, `[${d.prowH.join(', ')}]`)

  t('字号只用 4 档体系', d.strays.length === 0, d.strays.join(', '))
  t(`最小档(${ALLOWED_FS[0]}) 叶子占比 < ${MAX_P11}%`, d.p11 < MAX_P11, `实际 ${d.p11}%（${d.leaves} 个叶子）`)

  // ── 大屏也要守（2026-09-26 补）──
  // 根因：`body{max-width:1380px}` → 在 1200~1380 之间"视口越宽 → 右列越宽 → chip 换行越少 →
  // 右列越矮"，两列差被放大。实测目录 chip 尺寸一改，1200px 差 11px 而 **1440px 冲到 62px**
  // （越过 60px 红线）—— 只守 1200px 就等于大屏没人守，而用户的大屏才是常见场景。
  const w = await measure(1440, 900, false)
  console.log(`桌面 1440px: 页高 ${w.pageH}  两列 [${w.cols}]`)
  t('无横向滚动溢出（1440px）', w.scrollW <= w.innerW, `scrollW=${w.scrollW} innerW=${w.innerW}`)
  t('无超出屏幕的元素（1440px）', w.overs.length === 0, w.overs.join(', '))
  if (!w.cols || w.cols.length !== 2) ts('两列高度差 ≤ ' + MAX_COL_DIFF + 'px（1440px）', '不是双列布局')
  else {
    const diff = Math.abs(w.cols[0] - w.cols[1])
    t(`两列高度差 ≤ ${MAX_COL_DIFF}px（1440px）`, diff <= MAX_COL_DIFF, `实际 ${diff}px（${w.cols[0]} / ${w.cols[1]}）`)
  }

  const m = await measure(390, 844, true)
  t('移动视口为 390px', m.innerW === 390, `vw=${m.innerW}`)
  t('无横向滚动溢出（390px）', m.scrollW <= m.innerW, `scrollW=${m.scrollW}`)
  t('无超出屏幕的元素（390px）', m.overs.length === 0, m.overs.join(', '))

  t('无 JS 报错', errors.length === 0, errors.slice(0, 3).join(' | '))

  console.log(`\n${fail ? '✗' : '✓'} ${pass}/${pass + fail} 通过${skip ? ` · ${skip} 跳过` : ''}`)
  ws.close(); proc.kill(); process.exit(fail ? 1 : 0)
})().catch((e) => { console.error('ERR', e.message); process.exit(1) })
