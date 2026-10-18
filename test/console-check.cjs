// console-check.cjs —— 打开仪表盘，收集 JS 报错 / 未捕获异常 / 失败的请求，
// 并跑一遍交互冒烟（厂商下拉、展开、切视图、发一次真实流式请求、弹层、ESC 关闭），
// 再对几个关键控件做 **hover 对比度** 实测。改完 dashboard.html 后跑一次，比肉眼看截图可靠得多。
//
// ⚠ 打的是线上 8787，所以改完代码**不重启 8787** 就跑它，等于在验旧进程。
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')

const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find((p) => fs.existsSync(p))
const URL = process.argv[2] || 'http://127.0.0.1:8787/'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const port = 9450 + Math.floor(Math.random() * 40)
  const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-proxy-server', '--no-first-run',
    '--user-data-dir=' + path.join(os.tmpdir(), 'edge-cc-' + port), '--remote-debugging-port=' + port, 'about:blank'],
    { stdio: 'ignore', env: { ...process.env, NO_PROXY: '*', no_proxy: '*' } })

  let wsUrl = null
  for (let i = 0; i < 40 && !wsUrl; i++) {
    await sleep(300)
    try { wsUrl = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl } catch {}
  }
  const ws = new WebSocket(wsUrl)
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
  let id = 0
  const pending = new Map()
  const problems = []
  ws.addEventListener('message', (ev) => {
    let m; try { m = JSON.parse(ev.data) } catch { return }
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return }
    if (m.method === 'Runtime.exceptionThrown') problems.push('未捕获异常: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text))
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') problems.push('console.error: ' + m.params.args.map((a) => a.value || a.description || '').join(' '))
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') problems.push('日志错误: ' + m.params.entry.text)
  })
  const send = (method, params = {}, sessionId) => new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) })) })
  const t = await send('Target.createTarget', { url: 'about:blank' })
  const a = await send('Target.attachToTarget', { targetId: t.result.targetId, flatten: true })
  const sid = a.result.sessionId
  await send('Page.enable', {}, sid); await send('Runtime.enable', {}, sid); await send('Log.enable', {}, sid)
  await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 1000, deviceScaleFactor: 1, mobile: false }, sid)
  await send('Page.navigate', { url: URL }, sid)
  await sleep(7000)

  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sid)
    if (r.result && r.result.exceptionDetails) problems.push('求值异常: ' + JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text))
    return r.result && r.result.result ? r.result.result.value : undefined
  }

  console.log('== 交互冒烟 ==')
  const steps = [
    ['厂商下拉可打开', `(()=>{openVpop();return document.querySelectorAll('#vlist .vopt').length})()`],
    ['下拉搜索过滤', `(()=>{renderVlist('cohere');return document.querySelectorAll('#vlist .vopt').length})()`],
    ['选中一家并回填', `(()=>{pickPreset('openrouter');return document.getElementById('p_base').value})()`],
    ['下拉可关闭', `(()=>{closeVpop();return document.getElementById('vpop').style.display})()`],
    ['死模型可展开', `(()=>{const a=document.querySelector('.prow .deadline a');if(!a)return '无死模型行';const k=a.id.replace(/-t$/,'');toggleBox(k);return document.getElementById(k+'-b').style.display})()`],
    // 2026-10-17：目录从 chips 墙改成表行，折叠入口 `.chip.more` → `.mrow.more`。
    // 类名一改这条就静默失效（返回 '无折叠' 也只是打印出来，不会 FAIL），所以必须同步。
    ['目录「还有 N 个」可展开', `(()=>{const c=document.querySelector('.mrow.more');if(!c)return '无折叠';c.click();return document.querySelectorAll('#catalog .mrow').length})()`],
    ['统计条已渲染', `document.querySelectorAll('#statsbar .stat').length`],
    ['供应商卡片已渲染', `document.querySelectorAll('.prow').length`],
    ['模型 chip 上不再有「强/轻」能力档徽标', `document.querySelectorAll('.mchip .mt').length`],
    ['免费池变动/使用记录最多两行', `(()=>{const bds=[...document.querySelectorAll('.chg .bd')];if(!bds.length)return '无记录行';const bad=bds.filter(b=>b.scrollHeight>parseFloat(getComputedStyle(b).lineHeight)*2.5);return {行数:bds.length,超两行:bad.length}})()`],
    ['白名单新鲜度看的是同步时间而不是名单日期', `document.getElementById('rulesmeta').textContent`],
    // 候选厂商区(2026-09-21 新增): 回答"为什么总是那18家" —— 白名单的发现源每轮都捞到几十家新厂商,
    // 但只进 candidates 不进 hosts, 以前只在 meta 行报个数。现在必须真的能看、能搜、能填表。
    ['候选厂商区已渲染且带中文名', `(()=>{const b=document.getElementById('candbox');if(!b)return '缺 candbox';if(b.style.display==='none')return '未显示(候选为空?)';const rows=[...document.querySelectorAll('#candbox .vopt')];if(!rows.length)return '无候选行';const named=rows.filter(r=>!r.querySelector('.vs.cand')).length;return {候选行:rows.length,带中文名:named}})()`],
    ['候选区可搜索过滤', `(()=>{if(!document.getElementById('candbox')||document.getElementById('candbox').style.display==='none')return '候选为空,跳过';CAND_Q='tencent';renderCandidates(LAST_WL);const n=document.querySelectorAll('#candbox .vopt').length;CAND_Q='';renderCandidates(LAST_WL);return n})()`],
    ['点候选行会回填接入信息而不直接接入', `(()=>{if(!document.getElementById('candbox')||document.getElementById('candbox').style.display==='none')return '候选为空,跳过';if(!CAND.length)return '无候选数据';const h=CAND[0].host;pickCandidate(h);return {base:document.getElementById('p_base').value,匹配:h&&document.getElementById('p_base').value.includes(h)}})()`],
    // 2026-09-21: 无 Key 巡检的结论要真的画到候选行上(回答"候选厂家为什么不测试")。
    // ⚠ 同时守住类名边界: 巡检徽标必须用自己的 p_* 类, 不许复用 .vs.cand ——
    //   上面那条断言正是用"没有 .vs.cand"判断"这行有中文名", 借用了就会出假回归。
    ['候选行显示无 Key 实测结论', `(()=>{const b=document.getElementById('candbox');if(!b||b.style.display==='none')return '候选为空,跳过';const rows=[...document.querySelectorAll('#candbox .vopt')];const tally={};let misuse=0;rows.forEach(r=>{const sp=r.querySelector('[class*="vs p_"]');if(sp){const k=sp.textContent.replace(/[0-9]+/g,'N');tally[k]=(tally[k]||0)+1;if(sp.classList.contains('cand'))misuse++}});return {实测徽标行:Object.values(tally).reduce((a,c)=>a+c,0),明细:tally,错用cand类:misuse}})()`],

    // ── 视图切换 / 链路自检 ──
    ['切到链路自检', `(async()=>{switchView('play');await new Promise(r=>setTimeout(r,1500));return document.getElementById('view-play').style.display===''&&document.getElementById('view-dash').style.display==='none'})()`],
    ['自检台模型下拉已填充', `document.querySelectorAll('#pg_model option').length`],
    ['下拉里没有重复项', `(()=>{const v=[...document.querySelectorAll('#pg_model option')].map(o=>o.value);return v.length===new Set(v).size?true:[v.length,new Set(v).size]})()`],
    ['下拉项数 = 路由池模型数 + 1', `(()=>{const opt=document.querySelectorAll('#pg_model option').length;const pool=LAST.filter(p=>p.enabled!==false).reduce((a,p)=>{const blk=Object.keys(p.blocked||{}),qtn=Object.keys(p.quarantine||{}),dis=Object.keys(p.disabledModels||{});return a+(p.models||[]).filter(m=>!blk.includes(m)&&!qtn.includes(m)&&!dis.includes(m)).length},0);return opt===pool+1?true:{opt,pool}})()`],
    ['auto 在首位', `document.getElementById('pg_model').options[0].value`],
    ['已移除双模型对比与调参控件', `({对比:!!document.getElementById('pg_cmp'),温度:!!document.getElementById('pg_temp'),max_tokens:!!document.getElementById('pg_max'),对比列:!!document.getElementById('pg_col_b')})`],
    // 真的发一次流式请求 —— 这是唯一能证明 SSE 消费端正确的方式（含按行缓冲、[DONE]、usage）
    ['自检台发一次真实流式请求', `(async()=>{document.getElementById('pg_in').value='用一句话说明你是什么模型';await playRun();const t=document.getElementById('pg_out_a').textContent;return {长度:t.length,截断:/截断|finish=/.test(document.getElementById('pg_stat_a').textContent),状态:document.getElementById('pg_stat_a').textContent.slice(0,60)}})()`],
    ['自检台输出非空', `document.getElementById('pg_out_a').textContent.trim().length>0`],
    ['自检台拿到请求 ID', `document.getElementById('pg_tip').textContent.includes('请求 ID')`],
    ['切回仪表盘', `(()=>{switchView('dash');return document.getElementById('view-dash').style.display===''})()`],

    // ── 使用记录（已改回简单列表：无筛选 / 搜索 / 加载更多）──
    ['使用记录卡已显示', `document.getElementById('usgcard').style.display`],
    ['使用记录有记录行', `document.querySelectorAll('#usagelist .chg').length`],
    ['使用记录不再有筛选/搜索/加载更多', `({供应商下拉:!!document.getElementById('ug_prov'),成败下拉:!!document.getElementById('ug_ok'),搜索框:!!document.getElementById('ug_model'),加载更多:!!document.querySelector('[data-act="ug-more"]')})`],
    ['已移除运行趋势整块', `({趋势卡:!!document.getElementById('trendcard'),图表容器:!!document.getElementById('trendbox'),切换按钮:document.querySelectorAll('[data-act="range"]').length})`],
    ['已移除限时活动巡检展示模块', `({展示模块:!!document.getElementById('promobox'),检查活动按钮:!!document.getElementById('promobtn'),告警出口:!!document.getElementById('promowarn')})`],
    // 2026-09-19 砍实测徽标(用户原话"显得好乱"): 5 个标签都不能复活。注意浏览器里没有 `sleep`, 要用 setTimeout。
    ['vopt 已无实测徽标', `(async()=>{openVpop();await new Promise(r=>setTimeout(r,80));const all=[...document.querySelectorAll('#vlist .vopt')].map(n=>n.textContent);closeVpop();const bad=['已接入','端点实测','需Key','路径未探到','端点不通'];const hit=bad.filter(t=>all.some(s=>s.includes(t)));return hit.length?('还有: '+hit.join(',')):'已清除'})()`],

    // ── 配置片段弹层 ──
    ['打开配置片段', `(()=>{openSnippets();return document.getElementById('modal').style.display})()`],
    ['片段有内容', `document.getElementById('snip_pre').textContent.length`],
    ['片段含 Base URL 与 Key 提示', `/Base URL/.test(document.getElementById('snip_pre').textContent)`],
    ['片段有 7 个客户端 tab', `document.querySelectorAll('.snip-tab').length`],
    ['切到 curl 片段', `(()=>{document.querySelector('[data-act="snip-tab"][data-k="curl"]').click();return document.getElementById('snip_pre').textContent.includes('curl')})()`],
    ['片段里不含未替换的占位符', `/__GATEWAY_KEY__|undefined/.test(document.getElementById('snip_pre').textContent)?'有':'无'`],
    ['ESC 可关弹层', `(()=>{document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));return document.getElementById('modal').style.display})()`],

    // ── 多 Key 弹层 ──
    ['打开 Key 管理', `(async()=>{const p=LAST.find(x=>x.keyCount>0)||LAST[0];await openKeysModal(p.id);return {标题:document.getElementById('modal_title').textContent,行数:document.querySelectorAll('#modal_body .krow').length}})()`],
    ['每把 Key 都只显示掩码', `(()=>{const ks=[...document.querySelectorAll('#modal_body .krow .kid')];return ks.length?ks.every(k=>k.textContent.includes('…')):'无行'})()`],
    ['有新增 Key 的输入框', `!!document.getElementById('k_new')`],
    ['Key 行有启停/解冷/删除三个动作', `(()=>{const r=document.querySelector('#modal_body .krow');return r?[...r.querySelectorAll('[data-act]')].map(b=>b.dataset.act).join(','):'无行'})()`],
    ['点背景可关弹层', `(()=>{document.getElementById('modal').click();return document.getElementById('modal').style.display})()`],

    // ⚠ 2026-09-25 修假阳性：这个断言扫 body.innerText 找 `undefined|NaN`，用来抓
    //   "本该是数值的地方渲染出了 NaN" 这类 JS bug。但厂商名是**上游数据**，实测真有一家
    //   叫 `api.nan.builders`（候选区显示为「NaN Builders」）—— 候选区一有内容就必然误报，
    //   看着像新回归。所以先把"展示上游厂商名"的节点临时藏起来再取 innerText，取完立刻恢复。
    //   （只藏不删：删掉会改变布局，影响后面按坐标取样的用例。）
    ['无「undefined/NaN」泄漏到页面', `(()=>{
      const nodes=[...document.querySelectorAll('.vn,.vopt,.pname,.cand .cn')];
      const saved=nodes.map(e=>[e,e.style.display]);
      saved.forEach(([e])=>e.style.display='none');
      const t=document.body.innerText;
      saved.forEach(([e,v])=>e.style.display=v);
      const m=t.match(/undefined|NaN/g);
      return m?m.slice(0,5).join(','):'无';
    })()`],
  ]
  for (const [name, expr] of steps) {
    const v = await ev(expr)
    console.log(`  ${name}: ${JSON.stringify(v)}`)
  }

  // ── 上游配额项专项（2026-10-09 新增功能）──
  // ⚠ 为什么必须**注入**数据、而不是等真实数据: 只有回过 `x-ratelimit-*` 的家才有这一项,
  //   而测试环境里多半一家都没有 —— 靠真实数据的话这段代码**永远不跑**, 等于没测。
  // ⚠ 为什么值得单独立断言: 字段名是跨进程**手写**的(服务端 `recordQuota` 写 `remainreq`,
  //   前端读 `p.quota.remainreq`)。写错一个字母的表现是"界面上什么都不显示"——**静默失败**,
  //   正是本项目反复踩的那一类。所以这里连"数字怎么格式化"一起钉住。
  console.log('\n== 上游配额项 ==')
  const qres = await ev(`(()=>{
    const p=LAST[0]; if(!p) return '无供应商'
    const bak=p.quota
    p.quota={at:new Date().toISOString(),remainreq:42,limitreq:100,remaintok:250000,resetreq:179.56}
    renderProviders()
    const el=document.querySelector('.prow[data-prov-id="'+p.id+'"] .pfoot .quota')
    const txt=el?el.textContent.trim():''
    const tip=el?(el.getAttribute('title')||''):''
    p.quota=bak; renderProviders()
    return {文本:txt,含剩余:/42\\/100 次/.test(txt),含重置:/3 分钟后重置/.test(txt),含token:/250\\.0k/.test(txt),有来源说明:tip.includes('上游响应头实测')}
  })()`)
  console.log('  ' + JSON.stringify(qres))
  if (!qres || qres.含剩余 !== true) problems.push('配额项没渲染出「剩余 42/100 次」: ' + JSON.stringify(qres))
  if (!qres || qres.含重置 !== true) problems.push('配额项没把 179.56s 显示成「3 分钟后重置」: ' + JSON.stringify(qres))
  if (!qres || qres.含token !== true) problems.push('配额项没把 250000 压缩成「250.0k」: ' + JSON.stringify(qres))
  if (!qres || qres.有来源说明 !== true) problems.push('配额项缺少说明数据来源的 tooltip（用户无法判断这个数可不可信）: ' + JSON.stringify(qres))

  // ── hover 对比度专项 ──
  // 全局 `button:hover` 曾经把变体按钮(.snip-tab / .vbtn / .tab)的背景染成主题蓝, 而它们的
  // 文字颜色不是白色 —— 悬停时就成了"蓝底灰字", 几乎看不见(用户截图反馈过)。
  // 光看代码很容易漏, 所以这里真的把鼠标移上去, 再按 WCAG 算一次对比度。
  console.log('\n== hover 对比度（≥3 才算可读，正常文字应 ≥4.5）==')
  const lumOf = `(c)=>{const m=String(c).match(/[\\d.]+/g);if(!m||m.length<3)return null;const [r,g,b]=m.slice(0,3).map(Number).map(v=>{v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4)});return 0.2126*r+0.7152*g+0.0722*b}`
  // 把鼠标移上去 → 读计算样式 → 按 WCAG 算对比度。
  // ⚠ 背景可能带 alpha(顶栏 tab 就是"半透明白底压在深蓝栏上"), 必须**从下往上逐层合成**,
  // 只看元素自己的 backgroundColor 会把顶栏 tab 误判成"白底白字"。底衬假定为白(页面底色)。
  const contrastOf = async (sel) => {
    const ok = await ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return false;e.scrollIntoView({block:'center'});return true})()`)
    if (!ok) return '元素不存在'
    await sleep(250)
    const box = await ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, buttons: 0 }, sid)
    await sleep(250)
    const v = await ev(`(()=>{
      const e=document.querySelector(${JSON.stringify(sel)}), s=getComputedStyle(e)
      const parse=(c)=>{const m=String(c).match(/[\\d.]+/g);if(!m||m.length<3)return null;return [Number(m[0]),Number(m[1]),Number(m[2]),m.length>=4?Number(m[3]):1]}
      const layers=[]; let el=e
      while(el){ const c=parse(getComputedStyle(el).backgroundColor); if(c&&c[3]>0) layers.push(c); el=el.parentElement }
      let bg=[255,255,255]                       // 页面底色
      for(let i=layers.length-1;i>=0;i--){ const [r,g,b,al]=layers[i]; bg=[r*al+bg[0]*(1-al), g*al+bg[1]*(1-al), b*al+bg[2]*(1-al)] }
      const fg=parse(s.color)||[0,0,0,1]
      const lum=([r,g,b])=>{const f=(v)=>{v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4)};return 0.2126*f(r)+0.7152*f(g)+0.0722*f(b)}
      const L1=lum(fg), L2=lum(bg)
      const hi=Math.max(L1,L2), lo=Math.min(L1,L2)
      return {文字:s.color,合成底色:'rgb('+bg.map(Math.round).join(', ')+')',对比度:Math.round(((hi+0.05)/(lo+0.05))*100)/100}
    })()`)
    return v
  }
  // 每一组都自带 setup / teardown —— 之前写成"全部 setup 完再统一测量", 结果测配置片段时
  // 弹层已经被后面的 setup 关掉了, 报了一串假的"元素不存在"。
  const hoverGroups = [
    { prep: `openSnippets();snipTab('node')`, done: `closeModal()`, cases: [['配置片段 tab', '[data-act="snip-tab"][data-k="claude"]'], ['弹层里的普通按钮', '#modal .mfoot button.small.gray']] },
    { prep: `openVpop()`, done: `closeVpop()`, cases: [['厂商下拉里的行', '#vlist .vopt'], ['厂商选择按钮', '#vbtn']] },
    { prep: `switchView('play')`, done: `switchView('dash')`, cases: [['顶栏 tab', '#tab-dash'], ['自检台的发送按钮', '#pg_run']] },
  ]
  for (const g of hoverGroups) {
    if (g.prep) { await ev(g.prep); await sleep(400) }
    for (const [label, sel] of g.cases) {
      const r = await contrastOf(sel)
      const ratio = r && typeof r === 'object' ? r.对比度 : r
      const bad = typeof ratio === 'number' && ratio < 3
      console.log(`  ${label}: ${JSON.stringify(r)}${bad ? '  ← 对比度过低，悬停会看不清字' : ''}`)
      if (bad) problems.push(`hover 对比度过低(${ratio}): ${label}`)
    }
    if (g.done) { await ev(g.done); await sleep(200) }
  }

  console.log('\n== 问题清单 ==')
  if (!problems.length) console.log('  无 JS 报错 / 无失败请求 / hover 对比度正常')
  else [...new Set(problems)].forEach((p) => console.log('  ⚠ ' + p))

  // 汇总行，供 run-all.cjs 统计项数（它认 `N 通过 / M 失败` 这种格式）。
  // ⚠ 这里的"通过"指的是**这一步没有抛错**，不是"这一步的值符合预期" —— steps 里的值是
  //   打印出来给人核对的（见上方那个循环），真正的断言只有三条：无 JS 报错 / 无失败请求 /
  //   hover 对比度达标。所以别把它读成"50 条断言全绿"，它是一次**冒烟**。
  const total = steps.length + hoverGroups.reduce((a, g) => a + g.cases.length, 0)
  const failed = Math.min(problems.length, total)
  console.log(`\n  ${total - failed} 通过 / ${failed} 失败`)

  ws.close(); proc.kill()
  process.exit(problems.length ? 1 : 0)
}
main().catch((e) => { console.log('出错:', e.message); process.exit(1) })
