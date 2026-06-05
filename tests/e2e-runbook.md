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
export OUT_DIR=reports/daily
```

---

## L3-A：trending 单步

```bash
cd "$STAR_TIDE_ROOT"
node scripts/pipeline-agent.mjs \
  --agent github-trending \
  --prompt-file prompts/trending.md \
  --timeout 1800 \
  --run-date "$RUN_DATE" \
  --output-dir "$OUT_DIR" \
  | tee /tmp/trending.out.json

node tests/validate-output.mjs --step trending --file /tmp/trending.out.json
```

**通过标准：** JSON 含 3 条 `items`；无 `error`；仓库 URL 可访问。

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

- `reports.length === 3`
- `reports/daily/$RUN_DATE/01-*.md` 等 3 个文件存在（`pipeline-agent.mjs` 会自动将 agent 工作区下的产物迁移/链接到项目根目录）
- `tmp/clones/$RUN_DATE/` 下 3 个克隆目录存在

若校验提示报告文件缺失，但文件实际在 `agents/opensource-analyzer/reports/` 下，说明是旧版未迁移；重新执行本步骤的 `pipeline-agent.mjs` 命令即可（无需重跑 agent）。

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
ls "reports/daily/$RUN_DATE/ppt/"   # 应有 preview.md，无最终 pptx
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

## L4-01：Lobster 全流程（含审批）

通过 `main` agent 的 lobster 工具触发（在项目根目录会话中）：

```json
{
  "action": "run",
  "pipeline": "workflows/star-tide-daily.lobster",
  "argsJson": "{\"outputDir\":\"reports/daily\",\"runDate\":\"2026-06-04\"}",
  "timeoutMs": 14400000
}
```

### 阶段检查表

| 阶段 | 观察点 | 通过标准 |
|------|--------|----------|
| Step 1 trending | Lobster 步骤日志 | 成功，stdout 为合法 trending JSON |
| Step 2 analyze | 步骤日志 + 磁盘 | 3 份 `.md` + 克隆目录 |
| Step 3 ppt_preview | 返回体 | 状态 `needs_approval`，含 `resumeToken` |
| 审批前 | `reports/daily/<date>/ppt/` | 仅有 preview 产物，**无** `.pptx` |
| resume | 见下方 | `ppt_finalize` 执行并成功 |
| 完成 | 产物目录 | 3 md + 1 pptx |

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
reports/daily/<date>/
  01-<repo>.md
  02-<repo>.md
  03-<repo>.md
  ppt/
    preview.md
    daily-report-<date>.pptx
tmp/clones/<date>/
  <owner-repo>/  (x3)
```
