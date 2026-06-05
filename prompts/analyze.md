# 任务：克隆并分析趋势仓库

根据 **上一步输出** 中的趋势 JSON：

1. 将 3 个仓库克隆到 `STAR_TIDE_ROOT/tmp/clones/<date>/`（浅克隆即可；使用任务中的绝对路径）。
2. 每个仓库在 `STAR_TIDE_ROOT/<outputDir>/<date>/` 下撰写 markdown 分析报告（见 AGENTS.md）。
3. 概括结构、技术栈、亮点与风险。

不得修改上游。除非克隆确实失败，否则不得跳过仓库（失败情况记入 `risks`）。

按 AGENTS.md 返回分析结果 JSON（`reports` 数组长度为 3）。
