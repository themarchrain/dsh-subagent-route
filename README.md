# `dsh-subagent-route`

DeepSeek Harness 插件：**让用户在会话里用一句话决定下一次子代理派发用哪个模型、什么思考程度；用户没说时，原有的继承机制分毫不动。**

```
用户：「这次大任务，子agent用 gpt6luna 思考程度xhigh」
                    ↓
        派发的子代理：magpie-responses/codex/gpt-6-luna，effort=xhigh
```

---

## 它解决什么问题

在 0.2.1 的 harness 里，子代理的模型只有两种命运：

1. **继承父会话**（默认，也是绝大多数情况）；
2. **主会话的模型在工具参数里显式写 `provider` / `model`**——但用户没法参与这个决定，只能事后看运气。

于是「这批活我想让便宜模型跑」「这段分析用最强的思考等级」这类**只对本轮/本次任务有效**的要求，无处表达。

本插件补上第三种：**用户在会话消息里说清楚，派发时就用它。**

---

## 三条不可动摇的兼容承诺

这是本项目的全部设计重心，也是测试重点（`test/integration.test.mjs`）：

| 承诺 | 含义 | 如何验证 |
|---|---|---|
| **不覆盖** | 主会话/工具在调用里写了 `agentOptions`，一律原样放行 | `an explicit per-call route is never overridden` |
| **不改变默认** | 用户没点名 / 解析失败 / 有歧义 → 返回**同一个 request 对象**（`===`，不是内容相等的副本） | `a silent user gets the identical request object back` |
| **不阻塞** | 目录读不到、模型对不上、provider 抛错 → 退回继承，只留一行日志，绝不导致子代理启动失败 | `a catalog read failure degrades to inheritance` |

换句话说：**把它关了等于没装，装上之后宿主原有的每一种能力都还在**。

---

## 工作原理（三个落点）

```
                    ┌──────────────────────────────────────────┐
会话消息 ──────────► │ ① matcher：会话文本 → {provider,model,effort} │
"子agent用 gpt6luna" │    折叠大小写/分隔符 · 最长匹配优先 · 同分报歧义 │
                    └───────────────────┬──────────────────────┘
                                        │ 解析成功才注入
                    ┌───────────────────▼──────────────────────┐
派发 ─────────────► │ ② ctx.subagents.startActivation 包装       │
                    │    request.agentOptions === undefined     │
                    │      ? 填 {provider, model, reasoningEffort}│
                    │      : 原样放行                            │
                    └───────────────────┬──────────────────────┘
                                        │
                    ┌───────────────────▼──────────────────────┐
子代理 ───────────► │ ③ agent/created：把真实路由写进子代理上下文  │
                    │    （它因此能回答"我是什么模型"）             │
                    └──────────────────────────────────────────┘
```

**为什么包 `startActivation`**：0.2.1 里 `subagent` / `subagent_fork` / workflow agent / `spawn_teammate` **全部**只走这一个入口（宿主源码 `tool-subagent/src/index.ts:325`）。包服务一处，覆盖全部；包工具只能覆盖一个工具实例。

**为什么不用 `agent/request` 改路由**：宿主明确禁止。`agent-loop/src/agent.ts:629` 会抛
`agent/request proposed "…" after step preparation fixed "…"; use agent.model.select() before step preparation`。
路由必须在 step preparation **之前**确定，所以只能从派发入口改。（如果你要"中途换模型"，那是 `agent.model.select()` 的事，不是本插件的事。）

---

## 名称智能比对

用户不会按 provider 的拼法写模型名，所以比对分三步，逐层收窄：

1. **折叠**：小写 + 去掉一切非字母数字。`GPT-6-Luna`、`gpt_6_luna`、`gpt6luna` 全部 → `gpt6luna`
2. **多形态建键**：完整 id、`provider/id`、id 末段、显示名、以及被分隔符切开的连续子串（`gpt` / `6` / `luna` / `gpt6` / `6luna` / `gpt6luna`）
3. **最长匹配优先**：写全 id 的赢过写片段的；**两个不同路由同分 → 报歧义，不猜**

边界处理是刻意做的：折叠会抹掉分隔符，`off` 会误命中 `office`、`high` 会误命中 `xhigh`，所以匹配会在**原始文本**上复核边界（内部用带索引映射的 squash，`matcher.js` 的 `squash`）。

**三段式保底**（针对目录里根本没有的写法）：

- **别名表**：设置页配 `luna → magpie-responses/codex/gpt-6-luna`（必须指向真实存在的路由，别名不能凭空造路由）
- **补充模型**：`extraModels` 给不公布目录的网关补行，它才能被点名
- **思考程度**：先用模型自己声明的 `reasoning.efforts`（adapter 拥有词汇表），再用用户别名，最后才落到内置词表（`xhigh` / `极高` / `very high` …）

模型声明了 effort 但没有这个等级 → **丢 effort、保路由**（只注入 provider/model），而不是让请求失败。

---

## 设置页

位置：**设置 → 插件 → 找到 `dsh-subagent-route` → 配置**（也可从该插件详情页进入）。

页面分四段：

| 段 | 内容 |
|---|---|
| 行为开关 | 启用、必须出现触发词、告知子代理、回报主会话、严格模式 |
| 匹配形态 | 读取范围（最后一条消息 / 整个会话）、默认思考程度、触发词、出现距离、最短匹配长度 |
| 三张表 | 模型别名、思考程度别名、补充模型 |
| **试算** | 输入一句话，当场显示会解析成什么；**只解析，不保存、不派发** |

试算用的是**宿主那一份 matcher**：`node scripts/build-client.mjs` 把 `lib/matcher.js` 内联进浏览器包，所以预览和真实派发永远同一个判定。

页面自己的控件全部自绘，只用 `--dsw-alias-*` 主题 token——不 `require` 任何 Harness 客户端包，主题切换和小屏都跟着走。

---

## 配置项

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关；关掉等于没装 |
| `requireTrigger` | `true` | 必须出现触发词才读消息，避免误判闲聊 |
| `scope` | `last-user-message` | 读最后一条用户消息，还是整个会话 |
| `triggerWords` | `["子agent","子代理","subagent","派发","委派"]` | 触发词 |
| `aliases` | `[]` | `{alias, provider, model}` |
| `effortAliases` | `[]` | `{alias, effort}` |
| `defaultEffort` | `""` | 点了模型没提强度时用；空 = 交给模型默认 |
| `proximity` | `80` | 触发词之后多少个字符内允许出现模型名 |
| `minKeyLength` | `4` | 最短匹配片段，太短会误匹配 |
| `extraModels` | `[]` | `{provider, model, name}` |
| `notifyChild` | `true` | 把真实路由写进子代理上下文 |
| `notifyParent` | `false` | 派发后向主会话追加一条注入消息 |
| `strict` | `false` | 名字有歧义时拒绝派发，而不是退回继承 |

也可以在 `cordis.patch.yml` 里直接写：

```yaml
- id: dsh-subagent-route
  config:
    enabled: true
    triggerWords: ['子agent', 'subagent']
    aliases:
      - { alias: luna, provider: magpie-responses, model: codex/gpt-6-luna }
```

---

## 安装

```bash
dsh plugin --profile desktop add /绝对路径/dsh-subagent-route
```

或在 Web 界面：**设置 → 插件 → 添加**，填包目录的绝对路径。

**安装后首次启动前必须先在包目录里装依赖**（链接安装不会代跑依赖安装）：

```bash
cd /绝对路径/dsh-subagent-route && npm install
```

`@deepseek-ai/schemastery` 是唯一运行时依赖，用于声明设置 schema。漏装的表现是插件条目 `failed to import: Cannot find package '@deepseek-ai/schemastery'`。

装完重启 DSH。卸载：从 profile 移除该包即可，本插件不在宿主里留任何持久状态。

---

## 开发

```bash
node --test                      # 全部测试（72 条）
node scripts/build-client.mjs    # 改过 src/client.template.js 或 lib/matcher.js 后重建浏览器包
```

### 目录

```
lib/matcher.js          纯函数匹配器（零依赖，可单独测）
lib/message.js          无依赖的消息构造（冻结 + 随机 id）
lib/route.js            决策与副作用边界（配置读取、目录读取、request 注入）
lib/index.js            Cordis 入口：Config schema + 两个落点的接线
src/client.template.js  设置页源码（含 @inline-matcher 占位）
lib/client.js           构建产物（不要手改）
test/                   matcher / host / client / integration / consistency
```

### 测试分五层

| 文件 | 覆盖 |
|---|---|
| `test/matcher.test.mjs` | 匹配器纯逻辑：折叠、别名、歧义、effort 回退、中文触发词 |
| `test/host.test.mjs` | 决策纯函数：身份不变、显式值优先、通知文本、额外模型合并 |
| `test/client.test.mjs` | 浏览器包自注册、两个插槽的 key、内联 matcher 能跑通 |
| `test/integration.test.mjs` | **真实 `apply()` 对着仿真 Host 跑通全链路**（16 条兼容性断言） |
| `test/consistency.test.mjs` | schema ↔ 前端默认值不漂移、构建产物与模板不脱节、manifest/patch/locale 完整 |

改行为时先改测试——尤其 `test/integration.test.mjs` 里那三条"不覆盖 / 不改变默认 / 不阻塞"，它们是这个插件的存在理由。

---

## 已知限制

- **只在根会话读指令**。子代理自己再派发时不会被重新解析——它沿用被派发时定的路由，避免"孙代理读祖父的闲聊"。
- **不做故障转移**。参考插件 `dsh-subagent-default-model` 的多模型轮询/失败切换是另一种能力，本项目不提供。
- **同时启用两者会互相覆盖**。两个包都改 `startActivation`，按加载顺序叠加；默认值语义会打架，建议只留一个。
- **`agent/created` 里拿不到"这次派发的决策"与子代理的强绑定**（宿主没提供该关联），所以用 `parent.id → 决策 + 120s TTL` 关联。并发子代理在 120s 内派发时，理论上可能张冠李戴地共享同一决策；因为决策只用于"告知子代理它的路由"（路由本身已在 request 上确定），影响仅限于提示文本，不影响实际路由。
- **`notifyChild` 写的是 runtime context**（`systemPrompt.context()`）。这是一个模型可见输入，落在子代理自己的会话日志里，符合宿主"model-visible ⟺ logged"的约定。
