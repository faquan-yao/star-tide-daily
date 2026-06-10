# 任务：克隆并分析趋势仓库

根据 **上一步输出** 中的趋势 JSON（9 条，分 `ai` / `new_energy` / `autonomous_driving` 三个领域，每领域 Top 3）：

1. 将 **全部 9 个** 仓库克隆到 `STAR_TIDE_ROOT/artifacts/<date>/clones/`（浅克隆；**必须使用绝对路径**，例如 `git clone --depth 1 <url> "$STAR_TIDE_ROOT/artifacts/<date>/clones/owner-repo"`）。
2. **不得**在 `agents/opensource-analyzer/` 目录下克隆或写入文件；所有产物只在 `STAR_TIDE_ROOT/artifacts/<date>/`。
3. 每个仓库在 `STAR_TIDE_ROOT/artifacts/<date>/` 下撰写 markdown 分析报告（见 AGENTS.md）；建议按 `01-` … `09-` 编号。
4. 概括结构、技术栈、亮点与风险；输出 JSON 中保留与趋势条目一致的 `category` 与 `rank`。

不得修改上游。除非克隆确实失败，否则不得跳过仓库（失败情况记入 `risks`）。

按 AGENTS.md 返回分析结果 JSON（`reports` 数组长度为 **9**）。
