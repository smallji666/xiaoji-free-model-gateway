#!/usr/bin/env node
'use strict'
/*
 * publish-rules.cjs —— 发布闸门的**唯一判据来源**。
 *
 * 为什么单拎一个文件：密钥特征表原来在 check-secrets / sync-skill-dist / pack-skill 里各抄一份，
 * 三份判据必然漂（项目铁律：同一份源数据不能有两套过滤条件）。这里定义一次，其余 require 它。
 *
 * ⚠ 用户名为什么必须**按路径上下文**匹配：
 *   开发机的系统用户名与本项目品牌名恰好同名（都是 `xiaoji`）。若照旧做裸词替换，
 *   `xiaoji-free-model` / `logs\xiaoji.log` / `set "VBS=%DIR%xiaoji-launcher.vbs"` 会被一起改掉 ——
 *   包看起来"自检通过"，装上去却起不来（.bat 找不到 launcher）。
 *   所以只认 `Users/<名字>` 这种**能定位到人**的写法，品牌名一律不动。
 */
const os = require('node:os')

const USER = os.userInfo().username
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// ── 密钥特征（命中即拒绝出包）──
const SECRET_RES = [
  ['网关统一 Key', /freegw-[0-9a-f]{32}/],
  ['Groq Key', /gsk_[A-Za-z0-9]{20,}/],
  ['OpenRouter Key', /sk-or-v1-[A-Za-z0-9]{20,}/],
  ['Anthropic Key', /sk-ant-[A-Za-z0-9_-]{20,}/],
  ['Google Key', /AIza[A-Za-z0-9_-]{30,}/],
  ['OpenAI Key', /sk-(?:proj-)?[A-Za-z0-9_-]{40,}/],
  ['HuggingFace Key', /hf_[A-Za-z0-9]{30,}/],
  ['NVIDIA Key', /nvapi-[A-Za-z0-9_-]{30,}/],
  ['Cerebras Key', /csk-[A-Za-z0-9]{30,}/],
  ['任意 Bearer', /Bearer\s+[A-Za-z0-9._-]{30,}/],
]

// ── 个人信息特征（命中即拒绝出包）──
const PERSONAL_RES = [
  ['本机用户名（路径）', new RegExp(`(?:Users|users)[\\\\/]+${esc(USER)}\\b`)],
  ['个人化归属措辞', /用户原话|用户明确|用户说|用户反馈|用户要求|用户问|起因\(用户\)|按你的要求/],
  ['旧测试目录名', /\.workbuddy-ai[\\/]testinst/],
]

// ── 去敏改写（只作用于技能包副本，不动项目源文件）──
// ⚠ 只换名词短语、不插冒号 —— 原文标点照旧才读得顺（见 2026-09-30 的教训）。
const SANITIZE = [
  // ① 用户名只改路径里的那一处，品牌名保持原样
  [new RegExp(`(Users[\\\\/]+)${esc(USER)}\\b`, 'g'), '$1<用户名>'],
  // ② 个人化归属措辞 → 中性设计说明（长词在前）
  [/用户明确反感过/g, '曾被否过'],
  [/用户明确问过/g, '曾确认过'],
  [/用户明确否掉过/g, '已明确否掉过'],
  [/用户明确要求/g, '既定约束'],
  [/用户明确提出的/g, '既定原则'],
  [/用户明确/g, '既定要求'],
  [/用户原话/g, '设计约定'],
  [/用户反馈/g, '设计反馈'],
  [/用户要求/g, '设计约束'],
  [/用户说过/g, '反馈过'],
  [/用户认可/g, '既定认可'],
  [/用户说/g, '约定'],
  [/用户报障时/g, '排查故障时'],
  // ③ 含第一人称的引用整句改写（引文常跨行，分隔符必须容忍续行注释）
  [/新增的怎么都是英文api,?[\s\S]{0,40}?我作为普通用户都不知道[\s\S]{0,40}?是干嘛的/g, '新增的全是英文 api，看不出是哪家'],
  [/我作为普通用户都不知道\s*那几个是干嘛的/g, '裸域名看不出是哪家'],
  [/我不信每次都是那18家,?[\s\S]{0,30}?总有新的大厂给到免费模型,?[\s\S]{0,20}?比如阶跃星辰/g, '免费厂商名单长期不变'],
  [/你实测通过的怎么没往上面加？[\s\S]{0,20}?上面的列表没变过/g, '实测通过的厂商没进下拉'],
  [/不能它写什么我们就信什么/g, '不能源写什么就信什么'],
  [/候选的厂家为什么你不测试呢,?\s*必须得我提供 ?key\?/g, '候选厂商能不能不接 Key 就给出结论'],
  [/候选的厂家为什么你不测试/g, '候选厂商能不能不接 Key 就测'],
  [/起因\(用户\)[:：]?\s*/g, '起因：'],
  [/这正是用户问/g, '这正是回答'],
  [/用户问过/g, '曾有过一问'],
  [/用户问/g, '曾有一问'],
  [/按你的要求/g, '按既定约束'],
]

// 违禁文件名：这些出现在包里就是出事了（含明文 Key 或本机运行态）
const FORBIDDEN_NAME = [
  /^config\.json$/i, /\.prev$/i, /\.corrupt\./i, /\.import-bak\./i,
  /^gateway\.pid$/i, /^logs?$/i, /^metrics\.json/i, /^usage_log\.json/i,
  /^promo_state\.json/i, /^free_catalog\.json/i, /^server\.log/i,
]

module.exports = { USER, SECRET_RES, PERSONAL_RES, SANITIZE, FORBIDDEN_NAME }
