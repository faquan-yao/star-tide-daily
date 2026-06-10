# 任务：PPT 预览（需审批）

根据 **上一步输出** 中的分析 JSON：

1. 在 `outputDir/<date>/ppt/` 下制作 **可商用级别** 的演示文稿 **草稿**。
2. 包含：封面、执行摘要、按领域（AI / 新能源 / 自动驾驶）分组的 **9 个** 仓库各一节（指标、架构、亮点、风险）、结尾。
3. 写入 `preview.md` 及占位素材；待人工复核项写入 `pendingApproval`。

当前为 **preview** 阶段——尚未导出最终 `.pptx`。

按 AGENTS.md 预览契约返回 JSON（`phase` 为 `"preview"`）。
