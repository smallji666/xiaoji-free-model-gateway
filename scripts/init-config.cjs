#!/usr/bin/env node
'use strict'
/*
 * init-config.cjs —— 新克隆首次跑测试前，补一份最小可用的 config.json。
 *
 * 为什么需要它：`config.json` 里是明文 API Key，**必须**被 .gitignore 排除，
 * 于是刚 clone 下来的人手上没有这个文件；而一部分离线套件（why-check / free-eval /
 * route-invariant-check / stale-source-check）要读它来判断路由与闸门，缺了就直接
 * ENOENT 退出 1 —— 新贡献者看到的是"测试全红"，实际只是少了份配置。
 *
 * 行为：
 *   · 文件已存在 → 什么都不做（绝不覆盖任何人的真实配置）
 *   · 文件不存在 → 写一份最小配置：随机网关 Key + 空供应商列表，与首启时 server.mjs 生成的形状一致
 *
 * 用法：node scripts/init-config.cjs
 */
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const ROOT = path.dirname(__dirname)
const FILE = path.join(ROOT, 'config.json')

if (fs.existsSync(FILE)) {
  console.log('[init-config] config.json 已存在，跳过（不会覆盖）')
  process.exit(0)
}

const config = {
  port: 8787,
  proxy: '',
  gatewayKey: 'freegw-' + crypto.randomBytes(16).toString('hex'),
  configVersion: 2,
  maxConcurrent: 0,
  auth: { mode: 'local' },
  aliases: {},
  providers: [],
}

fs.writeFileSync(FILE, JSON.stringify(config, null, 2))
console.log('[init-config] 已生成最小 config.json（随机网关 Key + 空供应商列表）')
