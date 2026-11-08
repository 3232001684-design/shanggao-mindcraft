# 商高 MindCraft 训练系统

多 bot 的 Minecraft LLM 训练系统：一个 LLM「教官」(trainer) 用 RCON 硬核验收，把多个 bot 按 R1→R6 任务课程逐级练成真人级生存能力；底层模型走「多免费 LLM 池轮转」(NVIDIA NIM / agnes / Kilo)，每路带独立令牌桶限流；bot 还能**自己写行动代码**(`!newAction`) 沉淀成可复用的技能函数。

基于 [mindcraft](https://github.com/mindcraft-bots/mindcraft) 框架（mineflayer），在其上叠加了三块自研：

- **教官** `src/trainer.js`：任务课程 + RCON 数背包验收 + 卡死检测 + 三振退役 + 自力/协助记账
- **多模型池路由** `framework-overrides/.../hybrid.js`：nv/ag/kilo 三池轮转 + 每路令牌桶 + 同路重试 + 429 熔断换路
- **真人化** `framework-overrides/.../agent.js`：自发小目标、多语言过滤、防卡死 unstuck

> 人设/记忆：三个 bot（DeepSeek / Luna / Nemo）的人设逻辑在 `profiles/`。它们运行时会生成私人记忆到 `bots/<name>/`（memory.json、histories、自创 action-code），**这些不入库**（见 `.gitignore`），开源版只保留人设骨架。

---

## 目录结构

```
├─ src/
│  ├─ trainer.js      # 教官: 任务课程 + RCON 验收 + 卡死/退役/记账 (自研核心)
│  └─ start_bot.js    # 启动器: 拉 N 个 bot 人设进同一个 MC 世界 (自研)
├─ profiles/          # 三个 bot 的人设配置 (对话规则/技能/说话风格/模型亲和)
│  ├─ deepseek.json
│  ├─ nemo.json
│  └─ luna.json
├─ framework-overrides/   # 对 mindcraft 框架的定制 (见下)
│  ├─ main.js
│  └─ src/... (agent.js / actions.js / hybrid.js / coder.js / gpt.js / prompter.js ...)
├─ keys.example.json      # 三池密钥模板 (拷成 keys.json 填真值)
├─ scripts/sync-overrides.js  # 把定制覆盖层打进 node_modules/mindcraft
└─ package.json
```

---

## 安装

```bash
git clone <this-repo> && cd <this-repo>
npm install        # 装 mindcraft@0.1.4-2 + mineflayer; 之后自动跑 sync-overrides 覆盖定制层
cp keys.example.json keys.json   # 填你三池的真实 API key
```

- **Node 18 或 20**（24+ 可能有原生依赖问题，框架限制）
- 一个正在运行的 Minecraft Java 服务端（1.21.x），且开启 RCON
- 三个 pool 里至少配一个可用的 key；没配的池会自动被跳过

### 定制框架层说明

本仓库不 vendor 整个 `node_modules`。我们只改了 mindcraft 的几个源文件（见 `framework-overrides/`），`npm install` 后由 `scripts/sync-overrides.js`（`postinstall`）把它们拷回 `node_modules/mindcraft/`。升级框架版本后跑 `npm run sync` 重新应用即可。

---

## 配置

### 密钥 `keys.json`（从 `keys.example.json` 拷）

| 键 | 用途 |
|---|---|
| `NVIDIA_API_KEY` | NIM 池（DeepSeek / GLM / Nemotron flash 轮转） |
| `DEEPSEEK_API_KEY` | DeepSeek 池 |
| `OPENAI_API_KEY` | 经 OpenAI 兼容端点访问 agnes 池 |

### 服务端 / RCON（`src/trainer.js` 顶部）

```js
const RC = { host: '127.0.0.1', port: 25575, pw: 'sg2026bot' };   // RCON
const BOTS = ['DeepSeek', 'Nemo', 'Luna'];                        // 被训练的 bot
coach: { host: '127.0.0.1', port: 25566, username: 'coach', version: '1.21.4' }  // 教官连接参数
```

按你的服务器/版本改这几处即可。

### 人设 `profiles/*.json`

每个 bot 一份，含对话规则、说话风格、技能库、`model`（模型路由偏好 + `purpose` 标签）。模型路由的实际选择由 `hybrid.js` 的 `PLAN` 表决定，profile 里的 `model` 段只做亲和/兜底标注。

---

## 运行

```bash
npm run bots      # 启动 3 个 bot 人设进同一个世界
npm run trainer   # 另开一个终端, 跑教官
```

教官主循环：`idle 派发 → sent 等待 → verify RCON 数背包验收 → pass/retry/resupply/skip`，每轮 ~39s。关键机制：

- **RCON 硬核验收**：`data get entity <bot> Inventory` 数背包，比"嘴上说完成"硬
- **防卡死**：位置不动 + 动作重复 + 连续死亡 → 触发 unstuck
- **三振退役**：同一道题累计 skip 3 次永久退役换下一题
- **自力/协助记账**：喂过料的题标 `[assisted]`，只有全自力的 `!newAction` 才进技能库候选

---

## 多模型池路由（`framework-overrides/.../hybrid.js`）

三条路按 `PLAN` 表轮转：

```
chat:   nv → ag
auto:   nv → ag
memory: nv → ag
decide: nv → ag
code:   nv → ag
vision: nv(vl) → ag(vl)
```

- 每路独立**令牌桶**限流（nv/ag 各 18/min，kilo 200/h）
- 同路 transient 错误重试 1 次
- 429/超时/5xx 触发**熔断换路**（换 key / 换池）
- 空内容 / 兜底话（"脑子嗡了一下"）不认账，当失败处理

---

## 隐私与合规

- 三池均为免费/配额型 LLM 端点，密钥**只放本地 `keys.json`**，永不入库（`.gitignore`）
- `allow_insecure_coding`（让 LLM 在本地写跑代码）**默认关闭**——不要对公网服务器开它
- 运行产物（私人记忆 / 诊断日志 / 自学习 action-code）默认 gitignore

## License

MIT（应用层）。底层框架 mindcraft 沿用其自身 license。
