// 整页判定( PROMO_WATCH 的 page 模式 )验证
// 为什么单独测: 这个判定决定"限时活动结束了没有", 判错=继续放行已收费模型=静默扣费。
// 所以既要验"现在的真页面判成 free", 也要验"活动结束后的页面判成 paid" —— 只验前者不够,
// 因为一个永远返回 free 的正则也能通过前一半测试。
//
// ⚠ 分层: 前 10 条是**纯函数**判定（用固定文本，离线可跑、可进 CI）；
//   最后 1 条会**真实抓取** sensenova.cn 的落地页 —— 抓不到（没网/页面改版）只打 SKIP，
//   不算失败。所以本套件在无网环境下依然能给出有意义的结论。
const stripTags = (s) => String(s == null ? '' : s)
  .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/\s+/g, ' ').trim()

const PAGE = {
  free: /公测期完全免费|¥\s*0\s*\/\s*月/,
  paid: /公测(期)?(已)?结束|公测(已)?截止|付费档位(已|正式)(上线|推出)|恢复收费|不再免费|¥\s*[1-9]\d*\s*\/\s*月/,
}
const judge = (t) => (PAGE.paid.test(t) ? 'paid' : (PAGE.free.test(t) ? 'free' : null))

let pass = 0, fail = 0
const t = (name, got, want) => {
  const ok = got === want
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  got=${got} want=${want}`)
}

// ── 场景 1: 真页面(2026-09-17 实测原文片段) ──
const REAL = '订阅方案 公测期完全免费开放，付费档位即将上线 Free · 公测 限时放量 ¥ 0 /月 立即开始 60,000 积分 / 5 小时 特殊模型除外 SenseNova 6.8 Flash Lite 与 SenseNova U1 Fast Lite / Pro 即将上线 付费档位即将推出'
t('真页面 -> free', judge(REAL), 'free')
// 关键反例: "付费档位即将上线" 里的 "即将上线" 不能触发 paid, 否则今天就会误判成已收费
t('"付费档位即将上线"不误判 paid', judge('公测期完全免费开放，付费档位即将上线 ¥ 0 /月'), 'free')

// ── 场景 2: 活动结束后的页面形态 ──
t('价格变成 99/月 -> paid', judge('订阅方案 公测已结束 ¥ 99 /月 立即开始'), 'paid')
t('明确写"公测期已结束" -> paid', judge('公测期已结束，感谢参与 ¥ 0 /月'), 'paid')
t('付费档正式上线 -> paid', judge('付费档位已上线 ¥ 39 /月'), 'paid')
t('恢复收费 -> paid', judge('公测期结束，已恢复收费'), 'paid')
t('不再免费 -> paid', judge('本活动不再免费'), 'paid')
// 收费信号优先: 两种信号同时出现时按收费处理
t('免费+收费信号并存 -> paid', judge('公测期完全免费 ¥ 0 /月 … 公测已结束，恢复收费'), 'paid')

// ── 场景 3: 页面改版 / 判不准 -> null(保持原状, 绝不乱放行) ──
t('页面改版判不准 -> null', judge('欢迎使用 SenseNova 大模型平台 登录 注册'), null)
t('空白页 -> null', judge(''), null)

// ── 场景 4: 真实抓取 ──
;(async () => {
  try {
    const r = await fetch('https://www.sensenova.cn/token-plan', { headers: { 'user-agent': 'Mozilla/5.0 (compatible; XiaoJiFreeModel/1.0)' } })
    const full = stripTags(await r.text())
    t('线上真页面抓取 -> free', judge(full), 'free')
    console.log('   价格标记命中:', (full.match(/¥\s*\d+\s*\/\s*月/g) || []).join(' | ') || '(无)')
  } catch (e) {
    console.log('SKIP  线上抓取失败:', e.message)
  }
  console.log(`\n${fail ? '✗' : '✓'} ${pass}/${pass + fail} 通过`)
  process.exit(fail ? 1 : 0)
})()
