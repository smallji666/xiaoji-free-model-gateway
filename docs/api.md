# 接口与文件一览

> 本页是 [README](../README.md) 的展开章节。快速开始与项目定位请回 README。

## 文件一览

| 文件 | 作用 |
|---|---|
| `server.mjs` | 网关主程序（判定规则/白名单同步/路由/协议转换全在此） |
| `dashboard.html` | 仪表盘（浅色单主题，单文件无依赖） |
| `config.json` | 供应商与 Key、端口、代理、网关 Key、各家运行指标 |
| `free_whitelist.json` | 每日自动同步的免费模型白名单（多源合并，带各源状态） |
| `free_catalog.json` | 最近一次目录扫描结果 + 变动记录（最近 300 条） |
| `promo_state.json` | 限时活动巡检状态（每个活动模型当前免费/已收费 + 巡检自身健康度） |
| `usage_log.json` | **候选级**使用记录（成功/失败都留痕，最近 2000 条）。每条带 `id`(请求 ID) / `ms` / `ttfb` / `status` / `tin` / `tout` / `kind` / `cand`(第几个候选) |
| `metrics.json` | **请求级**指标聚合（按小时分桶，滚动 7 天 = 168 桶，每桶最多 120 个耗时样本用于算 p50/p95） |
| `小鸡开关.bat` / `xiaoji-launcher.vbs` | 隐藏启停（bat 为纯 ASCII + CRLF，防 cmd 乱码） |
| `logs/xiaoji.log` | 运行日志（服务端自持：带时间戳与 `INFO/WARN/ERROR` 级别，超 1MB 自动滚成 `.1`~`.5`） |

**自动任务节奏**（全自动，不需要人工拉）：

| 周期 | 做什么 |
|---|---|
| 每 **30 分钟** | 同步免费白名单（多源并行合并：OpenRouter + freellm.net + models.dev 发现源）。**带条件请求**：源没变就只回一次 304（或正文指纹相同），既不重建名单、也不触发目录扫描 |
| 每 **30 分钟** | 重扫**已接入**厂商的目录 → 自动同步路由池（新转免费的自动进池、下架的自动出池）。全池真实试调体检另有 5 小时门槛，不会跟着变密 |
| 每 **6 小时** | 名单巡检：对没配 Key 的厂商打真实请求，端点不通/模型不存在的证伪与剔除 |
| 每 **2 小时** | 抓各厂商官方公告页（当前 2 家：B.AI、商汤），核对限时免费活动是否还在 |
| 每 **4 小时** | 发现源 models.dev（5.9MB）检查有没有新厂商；带 ETag，没变只回 304 |
| 每 **1 天** | 被拉黑的模型做一次最小实测复审，恢复了自动放回 |
| 扫描失败时 | 5 分钟后自动补扫（6 小时窗口内限 12 次，防止刷屏式重试） |

**只读排查接口**（GET，免鉴权，不含任何密钥）：

| 接口 | 用途 |
|---|---|
| `GET /healthz` / `?deep=1` | 存活 / 就绪（深检逐家探上游，不就绪返 503） |
| `GET /api/metrics?hours=24` | 请求级指标时序（1~168 小时）。每小时给出 `n/ok/fail/abort`、`ms_p50`、`ms_p95`、`ms_avg`、`ttfb_avg`、`tin/tout` 与按供应商的请求数；`totals.success_rate` 的**分母不含 abort**（用户自己点停止不算模型失败）；`totals.overall` 是**整个窗口合并样本后**算出的 p50/p95（不是各桶分位的平均——分位数不可平均） |
| `GET /api/usage?limit=100&provider=&model=&ok=1&id=` | 候选级日志查询。返回 `total`/`matched`/`okCount`/`failCount`/`records`。`model=` 走**子串**匹配（大小写不敏感）；`provider=` 与 `id=` 是**精确**匹配 |
| `GET /api/route?tools=1&messages=8&chars=40000&n=12` | 解释一次假想请求会怎么排序（评分构成 + 样本量）。加 `vision=1` 可模拟**带图片**的请求（候选带 `vision_ok` 标记，能直接看出谁被降了档）；加 `model=<别名/路由组/显式模型名>` 可换掉被测模型（不传即 `auto`），响应里的 `group` 回该名字展开成的成员数组（名字拼错时为 `null`）、`candidates` 回展开出几个候选。**按需排查用，不挂仪表盘** |
| `GET` / `POST /api/why` | 解释**一个模型为什么被判免费/收费**。GET 用实时状态判定（`?provider=gemini&model=gemini-3.5-flash`）；POST 可**带上游元数据跑完整四层判定**（body `{provider, model, meta}`，需网关 Key）—— 这是判定引擎的**自验证入口**：你不必读 `server.mjs` 就能自己核对判定。返回 `free` / `layer`（`deny` `not-chat` `promo-expired` `meta` `meta-paid` `whitelist` `open-free` `closed-list` `rule`）/ `reason`，以及 `catalog`（最近一次扫描**当时**留下的依据 `why` + 白名单来源，与实时结果并列 —— 两者不一致通常意味着它已从免费名单掉了出去）、白名单命中详情、`in_pool` 与「判免费却在池外」的三态（`blocked` / `quarantine` / `disabled`）。`meta_available` 如实反映这次判定有没有拿到元数据（GET 恒为 `false`） |
| `GET /metrics` | **Prometheus 文本格式**（零依赖手写）。给的是进程累计（`xiaoji_requests_total` / `xiaoji_tokens_total`）+ 24 小时窗口（`xiaoji_window_requests` / `xiaoji_request_duration_ms` 的 p50/p95/avg / `xiaoji_ttfb_ms_avg`）+ 逐供应商（`xiaoji_provider_up` / `_cooldown_seconds` / `_models{state}` / `_requests`）。与 `/healthz` 同定位：只读、免鉴权、不含任何密钥 |

**需要鉴权**（`Authorization: Bearer <网关 Key>` 或 `?key=`）：

| 接口 | 用途 |
|---|---|
| `GET /api/providers/:id/keys` | 逐 Key 状态：掩码、冷却中/至何时、人工启停、各自成功失败次数、当前实际在用的那一把。`:id` 既可传内部 id（UUID），也可传 `groq` 这种名字 |
| `POST /api/providers/:id/keys/add` | 新增一把 Key（body `{key}`）。同一家不重复收同一把 |
| `POST /api/providers/:id/keys/remove` | 删除指定 Key（body `{idx}`）。删后其余 Key 的冷却与统计**整体前移**，不会错位 |
| `POST /api/providers/:id/keys/toggle` | 人工启停某把 Key（body `{idx, enabled}`）。停用的优先级高于自动冷却 |
| `POST /api/providers/:id/keys/reset` | 解除冷却（body `{idx}`；不传 `idx` = 全部解除） |
| `GET` / `POST /api/aliases` | 模型别名：GET 读全部；POST `{name, target}` 增改，`target` 传空串则删除 |
| `GET` / `POST /api/groups` | **路由组**（一个名字 = 一组候选）：GET 读全部；POST `{name, members:[...]}` 增改，`members` 传空数组则删除。成员写法同显式指定模型（`厂商/模型` · `厂商/*` · 裸模型名）；不接受 `auto`、不能嵌套组、成员不能是别名（防 `组→别名→组` 绕环）。组名可直接当 `model` 用，并出现在 `/v1/models`（`owned_by: xiaoji-group`） |
| `POST /api/config/export` | 导出完整配置（**含各家明文 Key**）。刻意走 POST 而不是 GET —— GET 的完整 URL 会留在浏览器历史/代理日志里 |
| `POST /api/config/import` | 导入配置（body 为导出的那个对象，或 `{config:{...}}`）。导入前自动备份当前配置到 `config.json.import-bak.<时间戳>`；校验不过**什么都不写**。端口/代理改动需重启生效 |
| `GET` / `POST /api/snapshots` | **配置快照**。GET 列出 `config.json.snap-*`（名字/时间/供应商数/字节）；POST `{action:'save'\|'restore'\|'delete', name}`。`restore` 只覆盖**纯配置键**（`proxy`/`maxConcurrent`/`auth`/`gatewayKey`/`aliases`/`groups`/`port` + 供应商的 `name`/`label`/`base_url`/`needs_proxy`/`enabled`/`model`/`models`/`api_key`/`keys`/`anon`/`headers`），**冷却 / 拉黑 / 实测学习一律保留当前值** —— 整份覆盖等于把防扣费防线重置回出厂状态。回滚前当前配置会先备份成 `config.json.pre-restore.<时间戳>`，所以回滚本身也可撤销 |

> 两条红线：**不允许删到 0 把**、**不允许停用最后一把启用中的 Key**。否则这家会变成"占着路由池却永远没有 Key"的死供应商——每次路由都选中它、再白等一个往返才发现没 Key。要清空请直接删供应商。

> `usage_log.json` 是**候选级事件**（一次请求可能多条，回答"为什么回退"），`metrics.json` 是**请求级聚合**（回答"这一小时整体如何"）。刻意分开 —— 混在一起会出现"一个请求产生 3 条失败记录、图上就显示 3 个失败请求"的假象。
