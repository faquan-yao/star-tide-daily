# 任务：GitHub 昨日趋势（分领域 Top 3）

找出 **昨日** star 增长最快的开源 GitHub 仓库，在以下三个领域 **各取 Top 3**，共 **9 条**：

| category | 领域 |
|----------|------|
| `ai` | AI — 大模型、机器学习、NLP、CV、AI Agent 等 |
| `new_energy` | 新能源 — 光伏、风电、储能、电池、充电桩等 |
| `autonomous_driving` | 自动驾驶 — ADAS、感知/规划/控制、车路协同等 |

- 「昨日」默认按 Asia/Shanghai 日历；若上文已设置 `runDate` 则以该日期为准。
- 仅公开仓库；除非 fork 有明显独立增长信号，否则排除 fork。
- 每条记录包含：`category`、`rank`（领域内 1–3）、`name`（owner/repo）、`url`、`starsDelta`（整数，昨日增量）。
- 同一仓库只归入一个领域；9 条记录互不重复。

按 AGENTS.md 中的 JSON 契约输出。不要写入其他文件；回复中仅输出 JSON。
