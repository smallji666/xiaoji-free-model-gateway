# 发布为 WorkBuddy 技能

> 本页说明怎么把本项目打成可安装/可上架的技能包，以及发布前必须过的那道盘查。

## 一、产物是什么

一个**含 `SKILL.md` 的 zip**。WorkBuddy 的「技能 → 添加技能 → 上传技能」接受文件夹或 `.zip`，
硬要求只有一条：包内必须有 `SKILL.md`（可以在根，也可以在子目录里），且 YAML 里有 `name` + `description`。

技能包结构：

```
xiaoji-free-model-gateway/
├── SKILL.md                    给 AI 的操作说明（触发条件 + 部署步骤 + 红线）
├── README.md                   给人看的 3 分钟上手
├── assets/gateway/             可直接运行的网关（零依赖）
├── scripts/deploy.cjs          一键部署 + 环境自检
└── references/                 配置 / 厂商 / 排障 / 安全 四篇展开文档
```

技能包**不放**：测试台（18MB，部署者用不上）、`config.json`、任何运行态文件、截图。

## 二、一键重建

```bash
npm run skill
```

等价于：

```bash
node scripts/sync-skill-dist.cjs   # 项目源码 → 技能包（含去敏改写 + 自检）
node scripts/pack-skill.cjs        # 自检 → dist/xiaoji-free-model-gateway-skill.zip
```

- `sync-skill-dist.cjs --check` 只列清单不写盘
- `sync-skill-dist.cjs --with-tests` 连测试台一起带（默认不带）
- `pack-skill.cjs --list` 只列会进包的文件

技能包本体在 `~/.workbuddy-ai/skills/xiaoji-free-model-gateway/`（**不在仓库里**），
所以 `SKILL.md` 与 `references/*.md` 是**手写维护**的源文件，`assets/gateway/` 由同步脚本生成。

## 三、发布前盘查（每次都要重跑）

```bash
node scripts/check-secrets.cjs      # 工作区密钥闸门（跳过 .gitignore 覆盖的隐私文件）
npm run skill                       # 出包前再扫一遍：密钥 + 个人信息 + 违禁文件名
```

`publish-rules.cjs` 是判据的**唯一来源**，`sync-skill-dist` 与 `pack-skill` 都 require 它。
命中任何一条就整体拒绝出包、不留产物。

### 必须确认的四件事

| # | 查什么 | 怎么查 |
|---|---|---|
| 1 | 没有 API Key | 上面两道闸门；`config.json` / `*.prev` / `test/sb-*/config.json` 一律不进包 |
| 2 | 没有本机用户名与绝对路径 | `publish-rules.cjs` 的 `PERSONAL_RES`，只认 `Users/<名字>` 这种能定位到人的写法 |
| 3 | 没有内部目录名 | `\.workbuddy-ai/testinst` 等 |
| 4 | 没有真实用量截图 | 技能包不带截图；仪表盘截图含真实厂商与用量，**不进包** |

### 2026-10-19 那次盘查的结论（留档）

- 仓库受控文件 **102 个，0 命中**（`git ls-files` 里没有 `config.json` / `*.prev` / `logs/` / 沙箱目录）
- 本机工作区里有 **9 份含真 Key 的配置副本**（`config.json` + `*.prev` + `test/sb-*/config.json`），
  全部在 `.gitignore` 覆盖范围内，**从未进包**
- 无 `C:\Users\<名字>`、无代理端口、无邮箱、无公网 IP（SVG 里那些"IP"是路径坐标，误报）
- 唯一残留是注释里的个人化归属措辞，由 `SANITIZE` 在**技能包副本**上改写，项目源码保留原样

### 已知坑：品牌名与系统用户名同名

开发机的系统用户名恰好与本项目品牌名相同。早期版本的去敏规则做**裸词替换**，
会把 `xiaoji-free-model` / `logs\xiaoji.log` / `set "VBS=%DIR%xiaoji-launcher.vbs"` 一起改坏 ——
包**自检通过**，装上去却起不来（`.bat` 找不到 launcher）。

现已改为**只按路径上下文匹配**（`Users/<名字>`），品牌名一律不动。
回归验证：出包后 `grep launcher.vbs` 必须仍指向 `xiaoji-launcher.vbs`，且 `node --check server.mjs` 通过。

## 四、上传（自己用 / 给同事）

1. 打开 WorkBuddy →「技能」→「添加技能」→「上传技能」
2. 拖入 `dist/xiaoji-free-model-gateway-skill.zip`
3. 启用后，对话里说「帮我部署小鸡免费模型网关」即可触发

> 本地调试也可以直接把技能包目录放到 `~/.workbuddy-ai/skills/` 下，客户端重启后可见。

## 五、上架到公开技能市场

公开分发走**开放平台**，不是本地操作：

1. 入驻 <https://open.workbuddy.cn>（个人开发者或企业资质，需审核）
2. 在「技能」里新建，上传上面那个 zip
3. 填名称、简介、分类、触发词、详细说明（文案见下一节）
4. 提交审核 → 通过后在技能列表里「上架」→ 用户可在 WorkBuddy 技能入口搜到

审核周期以平台通知为准。上架前建议先自己装一遍、跑通一次完整部署。

## 六、可直接复制的提交文案

**名称**：小鸡免费模型网关

**一句话简介**：
把 Groq、Gemini、Mistral、OpenRouter 等多家免费大模型聚合成一个 OpenAI 兼容端点，一个地址一个 Key，带自动路由与防扣费。

**分类**：开发工具 / AI 基础设施

**触发词**：免费大模型、模型聚合、OpenAI 兼容、API 网关、免费 API、多模型路由、本地网关、防扣费

**详细说明**：

> 手里有几家平台的免费额度，但接口地址、Key、模型名各不相同，客户端里配一堆很烦，某家限流了还得手动换 ——
> 这个技能把这件事收成三步：选目录、拷文件、启动。
>
> 装好之后你会得到一个本地服务 `http://127.0.0.1:8787/v1`：一个地址、一个 Key，就能用上所有免费模型。
> 模型名填 `auto`，它会按实测首字节与吞吐挑当前最快最健康的一家，失败自动换下一家；
> 只放行确认免费的模型，撞到收费特征当场拉黑，不会因为手滑刷爆账单。
>
> 零依赖，只要 Node.js 18+，不需要 npm install；只监听本机，没有遥测、没有云端。
> 支持 OpenAI / Anthropic / Gemini / Ollama 四种协议原生互转，Claude Code、Gemini CLI、Cursor、
> Cherry Studio 这类客户端都能直接接。
>
> 附带的仪表盘能加供应商、一键拉取该家的免费模型、看每次请求到底走了谁、以及某个模型为什么被判免费。

**预览图**：建议用一张**全新实例**的截图（供应商为空、无用量），不要用真实使用中的仪表盘。

## 七、版本升级

1. 改项目源码 → 跑 `npm test` 确认没坏
2. `npm run skill` 重新出包
3. 改 `package.json` 的 `version`（技能包里的版本号由同步脚本从这里取，不手抄）
4. 上传新 zip，覆盖同名技能
