# star-tide-daily Lobster E2E 手工测试手册（L3 / L4）

本文档位于 `tests/` 目录，与正式工程代码分离。对应 **L3 单步冒烟** 与 **L4 全流程 E2E**。

执行前请先通过 L0：

```bash
./tests/preflight.sh
```

若上次 E2E 失败或中途中断，先释放磁盘与内存（analyze 会克隆仓库，失败时可能残留）：

```bash
./scripts/cleanup-pipeline.sh --all
# 若 Gateway 内存仍偏高，可再执行：
./scripts/cleanup-pipeline.sh --sessions --gateway
```

E2E 各步可加 `--cleanup-on-fail`，失败时自动清理克隆与误放仓库目录。

`pipeline-agent.mjs` 默认每次 run 使用独立 OpenClaw session（`--session-key agent:<id>:pipeline-<date>-<random>`），避免复用长会话导致 token 膨胀与 API 限流。需要连续对话调试时可加 `--reuse-session`。

遇到 SiliconFlow 429 时，pipeline 会自动指数退避重试（默认 3 次）；可用 `--max-retries`、`--retry-delay-ms` 调整。LLM fallback 见根目录 `README.md` 的「API 限流」专节。

自动化快检（L1 + L2）：

```bash
npm test
```

---

## 前置条件

- Gateway 已运行：`openclaw gateway status`
- 四个 agent 已注册：`openclaw agents list`
- `STAR_TIDE_ROOT` 指向本仓库根目录
- Node.js >= 22.19

建议固定测试日期便于复现：

```bash
export RUN_DATE=2026-06-04
export OUT_DIR=artifacts
```

---

## L3-A：trending 单步

```bash
cd "$STAR_TIDE_ROOT"
node scripts/fetch-github-trending.mjs \
  --run-date "$RUN_DATE" \
  | tee /tmp/trending.out.json

node tests/validate-output.mjs --step trending --file /tmp/trending.out.json
```

或使用单步脚本（含契约校验与 state 持久化）：

```bash
node scripts/run-pipeline-step.mjs --step trending --run-date "$RUN_DATE" --output-dir "$OUT_DIR" --force
```

**注意：**

- trending **默认脚本路径**（约数秒）；LLM 回退：`run-pipeline-step.mjs --use-llm`（可能触发 429 / context overflow，不推荐 E2E 常规跑）。
- 可选：在 `~/.openclaw/.env` 设置 `GITHUB_TOKEN`，领域不足 3 条时 Search API 补位更稳。
- 若 `tee` 的文件以 `{"runId":` 开头，说明误用了 `openclaw agent` 原始信封，应改用上述脚本。

**通过标准：** JSON 含 9 条 `items`（`ai` / `new_energy` / `autonomous_driving` 各 3 条）；无 `error`；仓库 URL 可访问。

---

## L3-B：analyze 单步

```bash
cat /tmp/trending.out.json | node scripts/pipeline-agent.mjs \
  --agent opensource-analyzer \
  --prompt-file prompts/analyze.md \
  --timeout 7200 \
  --run-date "$RUN_DATE" \
  --output-dir "$OUT_DIR" \
  | tee /tmp/analyze.out.json

node tests/validate-output.mjs --step analyze --file /tmp/analyze.out.json --check-files
```

**通过标准：**

- `reports.length === 9`（三领域各 3 条）；每条含 `purpose`、`installation`、`architecture`、`risks`（至少 1 条）
- `artifacts/$RUN_DATE/01-*.md` … `09-*.md` 共 9 个文件存在；每份报告含五节（用途、安装、架构、运行逻辑、风险）及 **2 个** `mermaid` 代码块
- `artifacts/$RUN_DATE/clones/` 下 9 个克隆目录存在

若校验提示报告文件缺失，但文件实际在 `agents/opensource-analyzer/` 工作区下，重新执行本步骤（`pipeline-agent.mjs` 会自动迁到 `artifacts/`）。

---

## L3-C：ppt_preview 单步

```bash
cat /tmp/analyze.out.json | node scripts/pipeline-agent.mjs \
  --agent ppt-maker \
  --prompt-file prompts/ppt-preview.md \
  --timeout 3600 \
  --run-date "$RUN_DATE" \
  --output-dir "$OUT_DIR" \
  | tee /tmp/ppt-preview.out.json

node tests/validate-output.mjs --step ppt_preview --file /tmp/ppt-preview.out.json --check-files
```

**通过标准：** `phase: "preview"`；`preview.md` 存在；`pendingApproval` 非空。

**审批前检查：** 此阶段 **不应** 存在 `daily-report-*.pptx`。

```bash
ls "artifacts/$RUN_DATE/ppt/"   # 应有 preview.md，无最终 pptx
```

---

## L3-D：ppt_finalize 单步（预览通过后）

```bash
cat /tmp/ppt-preview.out.json | node scripts/pipeline-agent.mjs \
  --agent ppt-maker \
  --prompt-file prompts/ppt-finalize.md \
  --timeout 3600 \
  --run-date "$RUN_DATE" \
  --output-dir "$OUT_DIR" \
  | tee /tmp/ppt-finalize.out.json

node tests/validate-output.mjs --step ppt_finalize --file /tmp/ppt-finalize.out.json --check-files
```

**通过标准：** `phase: "finalize"`；`daily-report-$RUN_DATE.pptx` 存在且可打开。

---

## L3-E：单步脚本（state 持久化）

无需手动 `tee` / pipe，步骤 JSON 写入 `artifacts/$RUN_DATE/.pipeline/`：

```bash
cd "$STAR_TIDE_ROOT"
node scripts/run-pipeline-step.mjs --step trending --run-date "$RUN_DATE" --output-dir "$OUT_DIR"
node scripts/run-pipeline-step.mjs --step analyze --run-date "$RUN_DATE" --output-dir "$OUT_DIR"
node scripts/run-pipeline-step.mjs --step ppt_preview --run-date "$RUN_DATE" --output-dir "$OUT_DIR"
node scripts/run-pipeline-step.mjs --step ppt_finalize --run-date "$RUN_DATE" --output-dir "$OUT_DIR"
```

**通过标准：** 每步 stdout 可通过 `validate-output.mjs`；对应 `.pipeline/<step>.json` 存在。

---

## L3-F：通道自然语言触发（TUI / 微信 / QQ）

前置：Gateway 运行；微信/QQ 插件已安装并完成 login/pairing（见根目录 README「消息通道触发」）。

| 通道 | 操作 | 示例消息 | 通过标准 |
|------|------|----------|----------|
| TUI | `openclaw tui` → `/agent main` | 「跑 trending，日期 $RUN_DATE」 | main 调用 `run-pipeline-step`；回复含 9 个 repo 或产物路径 |
| TUI | 同上 | 「执行完整 star-tide-daily，日期 $RUN_DATE」 | Lobster 跑至 `needs_approval` 或完成 |
| 微信 | 私聊 main（配对后） | 同上 | 与 TUI 行为一致 |
| QQ | 私聊或 @ 机器人 | 同上 | 与 TUI 行为一致 |
| 任意 | 全流程暂停后 | 「批准 PPT 预览」 | `resume` 成功；最终 `.pptx` 生成 |

**注意：** 长任务可能超过默认消息 timeout；失败时查 Gateway 日志并考虑延长 timeout（≥14400s）。

---

## L4-01：Lobster 全流程（含审批）

通过 `main` agent 的 lobster 工具触发（在项目根目录会话中）：

```json
{
  "action": "run",
  "pipeline": "workflows/star-tide-daily.lobster",
  "argsJson": "{\"outputDir\":\"artifacts\",\"runDate\":\"2026-06-04\"}",
  "timeoutMs": 14400000
}
```

### 阶段检查表

| 阶段 | 观察点 | 通过标准 |
|------|--------|----------|
| Step 1 trending | Lobster 步骤日志 | 成功，stdout 为合法 trending JSON |
| Step 2 analyze | 步骤日志 + 磁盘 | 9 份 `.md` + 克隆目录 |
| Step 3 ppt_preview | 返回体 | 状态 `needs_approval`，含 `resumeToken` |
| 审批前 | `artifacts/<date>/ppt/` | 仅有 preview 产物，**无** `.pptx` |
| resume | 见下方 | `ppt_finalize` 执行并成功 |
| 完成 | 产物目录 | 9 md + 1 pptx |

### resumeToken 行为记录

当 Lobster 在 `ppt_preview` 暂停时，响应中通常包含：

- `status` / `state`：`needs_approval`（或等价字段）
- `resumeToken`：用于恢复的唯一令牌
- `ppt_preview` 步骤的 stdout：预览 JSON（含 `previewPath`、`summary`、`pendingApproval`）

**批准并继续：**

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

**记录模板（每次 E2E 填写）：**

```
日期:
runDate:
resumeToken: 
needs_approval 返回时间:
resume 发送时间:
ppt_finalize 完成时间:
最终 pptx 路径:
异常/备注:
```

**人工动作：** 打开 `previewPath` 对应 markdown，核对 `pendingApproval` 所列条目后再 `approve: true`。

---

## L4-02：审批拒绝路径

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": false
}
```

**期望：**

- `ppt_finalize` 不执行（workflow 中 `condition: $ppt_preview.approved`）
- 工作流标记为失败或保持待审批（记录实际 Lobster 版本行为到「异常/备注」）

---

## L4-03：中途失败传播

将非法 JSON 管道注入 analyze 步骤（或临时让某步 timeout 为 5s）：

```bash
echo '{"invalid":true}' | node scripts/pipeline-agent.mjs \
  --agent opensource-analyzer \
  --prompt-file prompts/analyze.md \
  --timeout 60
```

**期望：** 非零退出；若在全流程中，后续步骤不执行；`main` agent 应通知负责人（见 `agents/main/AGENTS.md`）。

**失败后清理：**

```bash
./scripts/cleanup-pipeline.sh --all
./scripts/cleanup-pipeline.sh --sessions --gateway   # 可选，释放 Gateway 长会话内存
```

---

## 常见问题

### validate-output 报「OpenClaw 信封未能拆出步骤契约 JSON」

- **原因：** `/tmp/*.out.json` 保存的是 `openclaw agent --json` 原始信封（含 `runId`、`status`、`result`），或 agent 超时/中止时 `payloads` 为空。
- **处理：** 用 `pipeline-agent.mjs` 重跑对应步骤；确认 stdout 以 `{"date":` 或步骤契约字段开头，而非 `{"runId":`。
- **限流/超时：** 见根目录 [README.md](../README.md)「SiliconFlow / LLM API 限流（429）」；超时可在 `openclaw.json` 的 `models.providers.*.timeoutSeconds` 调整（模板默认 600）。

---

## L5：定时任务验证（可选）

```bash
openclaw cron add \
  --name "star-tide-daily-test" \
  --cron "0 9 * * *" \
  --tz "Asia/Shanghai" \
  --session isolated \
  --timeout-seconds 14400 \
  --message "执行常驻程序「star-tide-daily」：运行 workflows/star-tide-daily.lobster。若返回 needs_approval，推送 PPT 预览并等待我 approve 后 resume。" \
  --announce \
  --channel <channel> \
  --to "<target>"

openclaw cron run --id <job-id>
openclaw cron runs --id <job-id>
```

---

## 产物验收清单

```
artifacts/<date>/
  01-<repo>.md … 09-<repo>.md
  clones/
    <owner-repo>/  (x9)
  ppt/
    preview.md
    daily-report-<date>.pptx
```
