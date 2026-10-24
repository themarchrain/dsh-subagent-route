# Changelog

## 0.0.1 — 2026-10-24

首个版本。目标：让用户在会话里点名子代理的模型与思考程度，同时不损失宿主任何既有能力。

### 新增

- **会话内路由指令**：读取最后一条用户消息（或整个会话），解析出 `{provider, model, reasoningEffort}`，在派发时填入被派发子代理的 `agentOptions`。
- **名称智能比对**：大小写与分隔符折叠、完整 id / `provider/id` / id 末段 / 显示名 / 连续子串建键、最长匹配优先、同分报歧义而非猜测。匹配在原始文本上复核词边界，避免 `off` 命中 `office`、`high` 命中原 `xhigh`。
- **思考程度三段式**：模型声明的 `reasoning.efforts` → 用户别名 → 内置词表（含中文：极高/最高/关闭…）。模型没声明该等级时丢弃 effort、保留路由。
- **设置页**：注册到 `plugins.row.config`（`dsh-subagent-route#dsh-subagent-route`）与 `plugins.bundle.config`，含行为开关、匹配形态、模型别名表、思考程度别名表、补充模型表，以及**试算**面板。
- **子代理路由自述**：派发成功后向子代理上下文注入一行真实提示词，说明它当前跑在哪个 provider/model/effort。

### 兼容性承诺（均有测试钉死）

- 调用方显式传入 `agentOptions` 时**永不覆盖**。
- 用户未点名时返回**同一个 request 对象**（`===`），继承机制与未安装时完全一致。
- 目录读取失败、模型无法解析、名称歧义一律**退回继承**，只留日志，绝不阻塞派发。

### 工程

- 零运行时依赖（除 `@deepseek-ai/schemastery` 用于声明设置 schema）。
- 单一 matcher 实现：`scripts/build-client.mjs` 把 `lib/matcher.js` 内联进浏览器包，设置页试算与 Host 派发判定不会漂移。
- 72 条测试，其中 `test/integration.test.mjs` 驱动真实 `apply()` 走完整派发链路。
- `test/consistency.test.mjs` 断言 schema 与前端默认值一致、每个字段都 `volatile` 且有 `.default()`、构建产物与模板同步、manifest/patch/locale 完整。
