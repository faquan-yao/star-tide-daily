# 任务：PPT 预览（需审批）

根据 **上一步输出** 中的分析 JSON 及各 `reportPath` Markdown：

1. 在 `outputDir/<date>/ppt/` 下制作 **可商用级别** 的演示文稿 **草稿**。
2. 结构建议：封面、执行摘要、按领域（AI / 新能源 / 自动驾驶）分组；**每个仓库至少 4 页**，须覆盖：
   - 项目用途（来自 `purpose` / 报告 §1）
   - 安装方法（来自 `installation` / 报告 §2）
   - 软件架构要点 + Mermaid 图摘录或文字化（报告 §3）
   - 运行逻辑要点 + Mermaid 图摘录或文字化（报告 §4）
   - 风险（来自 `risks` / 报告 §5）
3. 写入 `preview.md`；待人工复核项写入 `pendingApproval`。

当前为 **preview** 阶段——尚未导出最终 `.pptx`。

按 AGENTS.md 预览契约返回 JSON（`phase` 为 `"preview"`）。
