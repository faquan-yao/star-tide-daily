# 任务：PPT 定稿（审批通过后）

预览已获人工批准。根据 **上一步输出** 中的预览 JSON：

1. 在 `outputDir/<date>/ppt/` 下生成最终 `.pptx`（文件名：`daily-report-<date>.pptx`）。
2. 打磨版式以满足商用交付；未解决的 `pendingApproval` 项在 `delivery.notes` 中说明。
3. 确认所有文件路径已在磁盘上存在。

当前为 **finalize** 阶段。按 AGENTS.md 定稿契约返回 JSON（`phase` 为 `"finalize"`）。
