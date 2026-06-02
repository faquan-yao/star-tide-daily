# 任务：GitHub 昨日趋势

找出 **昨日** star 增长最快的 **Top 3** 开源 GitHub 仓库。

- 「昨日」默认按 Asia/Shanghai 日历；若上文已设置 `runDate` 则以该日期为准。
- 仅公开仓库；除非 fork 有明显独立增长信号，否则排除 fork。
- 每条记录包含：`rank`、`name`（owner/repo）、`url`、`starsDelta`（整数，昨日增量）。

按 AGENTS.md 中的 JSON 契约输出。不要写入其他文件；回复中仅输出 JSON。
