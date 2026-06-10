# 任务：克隆并分析趋势仓库

根据 **上一步输出** 中的趋势 JSON（9 条，分 `ai` / `new_energy` / `autonomous_driving` 三个领域，每领域 Top 3）：

1. 将 **全部 9 个** 仓库克隆到 `STAR_TIDE_ROOT/artifacts/<date>/clones/`（浅克隆；**必须使用绝对路径**，例如 `git clone --depth 1 <url> "$STAR_TIDE_ROOT/artifacts/<date>/clones/owner-repo"`）。
2. **不得**在 `agents/opensource-analyzer/` 目录下克隆或写入文件；所有产物只在 `STAR_TIDE_ROOT/artifacts/<date>/`。
3. 每个仓库撰写 **深度** markdown 分析报告，结构严格遵循 `prompts/analyze-report-template.md`（五节 + 2 个 Mermaid 图）；建议文件名 `01-` … `09-`。
4. 分析前须阅读：`README*`、`docs/`（若有）、`package.json` / `pyproject.toml` / `go.mod`、CI 配置、主入口（`main`、`cmd/`、`src/` 等）；不得跳过可读文档。
5. 输出 JSON 中保留与趋势条目一致的 `category` 与 `rank`，并填写 `purpose`、`installation`、`architecture` 等摘要字段（完整内容在 `reportPath` 文件中）。

不得修改上游。除非克隆确实失败，否则不得跳过仓库（失败情况记入 `risks`）。

**两阶段**：先用工具完成 9 份克隆与报告；全部落盘后，**最后一轮**仅输出 AGENTS.md 契约 JSON（`reports` 长度为 **9**；禁止再调用工具）。
