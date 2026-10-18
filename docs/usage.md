# 安装与使用

> 本页是 [README](../README.md) 的展开章节。快速开始与项目定位请回 README。

## 怎么打开 / 关闭

双击项目目录里的 **`小鸡开关.bat`**：**网关直接隐藏启动**（后台运行，桌面不留窗口），提示窗口 5 秒后自动关闭。

再双击一次进入控制菜单（网关已在运行时）：

| 选项 | 作用 |
|---|---|
| `1` 启动网关 | 隐藏拉起网关（无窗口） |
| `2` 停止网关 | 结束网关进程（按 8787 端口精确定位 PID） |
| `3` 重启网关 | 改完配置/更新代码后用 |
| `4` 打开仪表盘 | 浏览器打开 http://localhost:8787 |
| `5` 查看运行日志 | 记事本打开 `logs\xiaoji.log` |
| `0` 退出 | 只关菜单窗口，**网关继续在后台运行** |

- 不做开机自启，一切启停都由你手动决定。开关脚本纯 ASCII + CRLF（防 cmd GBK 乱码），隐藏启动由同目录 `xiaoji-launcher.vbs` 完成。
- 日志由**服务端自己持有**（`logs\xiaoji.log`，分级 + 按 1MB 滚动保留 5 份）。启动脚本不做输出重定向 —— Windows 上被 cmd 占用的文件无法改名，服务端就没法滚动日志、只能原地截断丢历史。
- 也可命令行启动：`node server.mjs`

仪表盘 http://localhost:8787 ｜ OpenAI 兼容端点 http://localhost:8787/v1 ｜ 统一网关 Key 见仪表盘「统一出口」或 `config.json` 的 `gatewayKey`

---

## 使用流程

1. **接入供应商**：在「添加供应商」选一家（列表每天自动推导，见第四节），粘贴 API Key，点「拉取免费模型」—— 网关实时调用该 Key 的 `/v1/models`，过滤出**真正免费、可用于聊天**的模型（⭐=推荐，默认勾选）。
   拉不到时可**手动填模型名**兜底，但这类名字没经过免费校验，服务端会**先隔离、不进 auto 路由**（防静默扣费），确认免费后在卡片上点「解除」放行。
2. **验证与停用**：点「测试」验证 Key 可用；点「体检」对该家**每个已接入模型**逐个发最小请求，主动揪出「已悄悄转收费 / 已下架」的模型（命中特征当场拉黑）。每家模型以**勾选框**展示，**取消勾选即时停用**（不再参与 auto 路由，重新勾选立即恢复）；点「Keys」可粘贴**多个 Key**（每行一个，轮换抗限流）。
3. **免费模型目录**：标题旁显示**白名单同步时间**与**各上游源的状态**（「实时」= 每次同步即当下状态；带日期的源停更会标 ⚠）。
   服务启动时及每 6 小时自动重扫各家池子，**并把 auto 路由池自动同步为最新免费列表**（新转免费的自动进池、下架的自动出池），也可手动点「重新扫描」。
   供应商卡片底部有一枚 **「免费体检」** 徽标 —— **防静默扣费的闸门**，显示全池真实试调距今多久。超过 8 小时未跑、或最近一轮**一条都没验成功**（多为代理没开）会变橙色告警。**体检绝不谎报成功**：整池网络失败时不会写成"刚跑过"。
   不在免费池的模型（已拉黑/已隔离）默认只显示**一行摘要**，点「展开」才看明细 —— 否则几十个失效模型会把卡片撑爆。目录另单列「已排除 N 个非对话专用模型」（接口用途不适合 `/chat/completions`），可点「查看」确认。
4. **填进客户端**：Base URL + 统一 Key，模型名填：
   - `auto` —— 按健康度在所有「供应商 × 已勾选模型」间路由；同一对话 30 分钟内优先粘在同一家
     （保持风格连贯，但**仅当它仍接近最优**：综合分落后队首超过 4% 就不粘），失败自动切换下一家
   - `供应商名/模型名`（如 `mistral/mistral-medium-3-5`）—— 指定来源；`供应商名/*` 表示该家全部模型
   - 裸模型名 —— 在所有配了该模型的供应商中挑一个
5. **多协议原生接入**（同一网关 Key，自动与 OpenAI 格式互转，流式/非流式均支持）：
   - **Anthropic / Claude 系**：`POST /v1/messages`（含 `count_tokens` 近似实现），`x-api-key` 或 `Authorization`
   - **Gemini 系**：`POST /v1beta/models/<model>:generateContent` / `:streamGenerateContent`，`x-goog-api-key` 或 `?key=`（`<model>` 可填 `auto`）
   - **OpenAI Responses 系**（Codex CLI 等）：`POST /v1/responses`，`Authorization` 或 `x-api-key`。工具调用按 Responses 规范平铺成独立的 `function_call` output item，流式发 `response.output_text.delta` / `response.completed` 等事件
   - **Ollama 系**：`/api/chat`、`/api/generate`（NDJSON 流式）、`/api/tags`
   - 所有协议共用同一条路由链：健康度排序、分层冷却、拉黑复审、统计口径完全一致
   - **图片能带过去**：Anthropic 的 `{type:"image",source:{type:"base64"|"url"}}` 与 Gemini 的 `inlineData` / `fileData` 都会转成 OpenAI 的 `image_url`（base64 原样内联，网关**不做**缩放/转码 —— 认不认这个格式由上游决定，网关自作主张转码只会多一个失败面）。纯文本请求仍走字符串形态，**老路径一个字节都没变**
6. **每次请求都有 ID**：所有响应（含错误）都带 `x-request-id`（8 位十六进制），错误响应体里也有 `request_id`。拿它就能在 `usage_log.json` / `GET /api/usage?id=<id>` 精确捞到那一次的全部候选记录。
7. **仪表盘右上角两个视图**：
   - **仪表盘** —— 统计条、供应商状态、免费模型目录、免费池变动、模型使用记录。
     **模型使用记录**是**候选级**日志（一次请求回退过几家就有几条），固定显示最近 30 条，每行**单行**展示、完整内容挂在悬停提示里；每行带请求 ID，点一下复制，粘到 `/api/usage?id=` 就能拉出同一次请求的全部轨迹。
   - **链路自检** —— 直接打网关自己的 `/v1/chat/completions`（**走完整路由链，测的就是真实链路**），流式输出。输出结束后会用请求 ID 反查并显示**这次到底是谁答的**；`finish_reason` 不是 `stop` 时明确标出「内容被截断」—— 半截答案看起来和答完了一模一样。点「停止」会**同时中止上游请求**，不再空烧免费额度。
8. **一键接入配置片段**：hero 卡上的「配置片段」给出 WorkBuddy / curl / Python / Node / Claude Code / Gemini / Ollama 七套现成配置，Base URL 与网关 Key 已填好，复制即用。
9. **逐 Key 精细管理**：「Keys」弹层能看到每把 Key 的掩码、是否冷却（冷却到几点）、人工启停状态、**各自的成功/失败次数**与最近使用时间，并单独启停/解除冷却/删除/新增。
   某把 Key 悄悄失效时，以前只能从"这家最近老失败"里猜、还会错怪整个厂商；现在一眼看出是哪一把。注定会被拒的操作（删到 0 把、停用最后一把）按钮**直接置灰**并写明原因。
10. **模型别名**（把客户端的「熟名字」接到免费池）：客户端（WorkBuddy / Cursor / LobeChat / Cherry Studio）的模型下拉里全是 `gpt-4o`、`claude-3-5-sonnet` 这类**付费**名字，免费池里一个都没有 —— 以前要么每次手打 `groq/openai/gpt-oss-120b`，要么就得改客户端配置。现在在 `config.json` 里配一张别名表即可：

    ```json
    "aliases": { "gpt-4o": "auto", "claude-3-5-sonnet": "auto", "快速模型": "gemini/gemini-3.5-flash" }
    ```

    客户端照旧填 `gpt-4o`，网关会按 `auto` 规则路由。也可以用接口增删（**只解析一层**，别名不能指向别名）：

    ```bash
    curl -X POST http://localhost:8787/api/aliases -H "Authorization: Bearer <网关Key>" \
         -H "content-type: application/json" -d '{"name":"gpt-4o","target":"auto"}'
    curl http://localhost:8787/api/aliases -H "Authorization: Bearer <网关Key>"   # 查看全部
    curl -X POST http://localhost:8787/api/aliases -H "Authorization: Bearer <网关Key>" \
         -H "content-type: application/json" -d '{"name":"gpt-4o","target":""}'   # target 传空串 = 删除
    ```

    别名会出现在 `/v1/models` 里（`owned_by: xiaoji-alias`），客户端下拉直接能选到。配错时不静默跑偏：目标不存在时**报错里用的是解析后的目标**（"别名 gpt-4o → nosuchvendor/x"），不会让人对着别名发懵。
11. **路由组**（一个名字 = 一组候选）：别名只能指到**一个**目标，路由组能指到**一组** —— 用来表达"这次只想在这几个模型里选"，比如 `local-only`（只走本机/免 Key 那几家）、`vision`（只放能看图的）、`省钱组`。

    ```json
    "groups": {
      "local-only": ["ovh/*", "kilo/llama-3.3-70b"],
      "vision": ["gemini/gemini-3.5-flash", "openrouter/google/gemini-2.5-pro"],
      "省钱组": ["groq/openai/gpt-oss-120b", "mistral/mistral-small-latest"]
    }
    ```

    ```bash
    curl -X POST http://localhost:8787/api/groups -H "Authorization: Bearer <网关Key>" \
         -H "content-type: application/json" -d '{"name":"vision","members":["gemini/gemini-3.5-flash"]}'
    curl http://localhost:8787/api/groups -H "Authorization: Bearer <网关Key>"   # 查看全部
    curl -X POST http://localhost:8787/api/groups -H "Authorization: Bearer <网关Key>" \
         -H "content-type: application/json" -d '{"name":"vision","members":[]}'  # members 传空数组 = 删除
    ```

    组名直接当模型名用（客户端里填 `vision` 即可），也会出现在 `/v1/models` 里（`owned_by: xiaoji-group`）。

    ⚠ **组只收窄候选集合，不改变排序规则** —— 组内候选照样走同一套加权评分与故障转移。想让某个成员永远领跑，应该去改它的实测证据（多打几次让它学到延迟/成功率），而不是靠组里的书写顺序；声明顺序只在**同分**时做 tiebreak。这条是刻意的：本项目已经因为"单个指标/单点判据定生死"踩过三次坑。

    成员写法与显式指定模型完全一致：`厂商/模型`、`厂商/*`、裸模型名。**不接受 `auto`**（含 auto 的组等价于 auto 本身，收窄的意图会被自己取消），**不能嵌套组**、**成员不能是别名**（否则 `组→别名→组` 能绕成环，而这条解析路径上没有递归保护）。别名指向组是可以的（各解析一层），所以"`gpt-4o` → 我的组"这种写法天然可用。

    排查：`GET /api/route?model=<组名>` 会回 `group`（组被认出来没有）与 `candidates`（展开出几个候选）—— 名字拼错时 `group` 是 `null`、`candidates` 是 0，一眼定位。

    ⚠ 组名和别名都**优先于同名模型**：如果恰好起了个跟池里某个模型一样的名字，那个模型会被遮住。起名前用 `/v1/models` 扫一眼即可。

---
