# star-tide-daily（星潮日报）

基于 OpenClaw + Lobster 的每日 GitHub 开源报告流水线：昨日 star 增速 Top 3 → 克隆分析 → 可商用 PPT（预览需人工审批）。

主 agent `main` 通过 Lobster 工作流串联三个子 agent。

**项目根目录：** 本仓库根目录（下文路径均相对此目录）

## 目录结构

| 路径 | 说明 |
|------|------|
| `workflows/star-tide-daily.lobster` | Lobster 四步流水线 |
| `scripts/pipeline-agent.mjs` | 调用 `openclaw agent --json` 的管道脚本 |
| `prompts/*.md` | 各步骤任务提示（中文） |
| `agents/*/AGENTS.md` | 各 agent 职责与 JSON 契约（中文） |
| `openclaw.json.example` | OpenClaw 配置模板；可通过 `OPENCLAW_CONFIG_PATH` 直接指向本文件 |

## 安装

1. 确保 Gateway 已运行，且本机已安装 `openclaw` CLI。
2. 配置 OpenClaw 读取本仓库的配置（推荐）：

在 `~/.bashrc`（或 `~/.zshrc`）末尾加入，将路径换成你本机克隆目录的**绝对路径**：

```bash
export OPENCLAW_CONFIG_PATH="/绝对路径/star-tide-daily/openclaw.json.example"
```

保存后执行 `source ~/.bashrc`（或重开终端），确认生效：

```bash
openclaw config file
```

输出应为 `OPENCLAW_CONFIG_PATH` 所指向的配置文件绝对路径。

> 使用仓库内 `openclaw.json.example` 时，修改配置会直接影响流水线；若需本地密钥或私有覆盖，可复制为同目录下的 `openclaw.json`（勿提交仓库）并改 `OPENCLAW_CONFIG_PATH` 指向该文件。

**备选：** 合并到默认路径 `~/.openclaw/openclaw.json`（不设 `OPENCLAW_CONFIG_PATH`）：

```powershell
Copy-Item openclaw.json.example $env:USERPROFILE\.openclaw\openclaw.json
# 若已有 openclaw.json，请手动合并 agents.list 与 plugins.entries.lobster
```

```bash
cp openclaw.json.example ~/.openclaw/openclaw.json
# 若已有 openclaw.json，请手动合并 agents.list 与 plugins.entries.lobster
```

3. 注册 agent（若尚未存在）：

```bash
openclaw agents add github-trending --workspace "agents/github-trending"
openclaw agents add opensource-analyzer --workspace "agents/opensource-analyzer"
openclaw agents add ppt-maker --workspace "agents/ppt-maker"
```

## 手动运行 Lobster

在**项目根目录**执行（或由 `main` 调用 lobster 工具）：

```json
{
  "action": "run",
  "pipeline": "workflows/star-tide-daily.lobster",
  "argsJson": "{\"outputDir\":\"reports/daily\"}",
  "timeoutMs": 14400000
}
```

审批通过后恢复执行：

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

单步调试：

```bash
node scripts/pipeline-agent.mjs --agent github-trending --prompt-file prompts/trending.md --timeout 1800
```

## 每日 9:00 定时任务

将 `<channel>` 与 `<target>` 替换为你的通知通道（如 telegram、slack）：

```bash
openclaw cron add \
  --name "star-tide-daily" \
  --cron "0 9 * * *" \
  --tz "Asia/Shanghai" \
  --session isolated \
  --timeout-seconds 14400 \
  --message "执行常驻程序「star-tide-daily」：运行 workflows/star-tide-daily.lobster。若返回 needs_approval，推送 PPT 预览并等待我 approve 后 resume。" \
  --announce \
  --channel <channel> \
  --to "<target>"
```

## 流程说明

1. **trending** — `github-trending` 输出昨日 star 增速 Top 3（JSON）
2. **analyze** — `opensource-analyzer` 克隆并分析，写入 `reports/daily/<date>/`
3. **ppt_preview** — `ppt-maker` 生成草稿，**需人工 approve**
4. **ppt_finalize** — 批准后导出 `.pptx`

## 验证清单

1. `openclaw agents list` 可见四个 agent id
2. 手动运行 trending 步骤返回合法 JSON
3. Lobster 全流程运行至 `needs_approval`
4. `resume` 且 `approve: true` 后生成 `.pptx`
5. `openclaw cron runs --id <job-id>` 显示定时执行成功
