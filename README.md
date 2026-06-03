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
| `openclaw.json.example` | OpenClaw 配置模板（部署到 `~/.openclaw/`，勿在仓库内直接作运行配置） |
| `.env.example` | 复制到 `~/.openclaw/.env`（含 `STAR_TIDE_ROOT` 与密钥） |
| `scripts/setup-openclaw.sh` | 一键将模板部署到 `~/.openclaw` |

## 安装

OpenClaw **运行时**（插件 `npm/`、extensions、会话）放在 `~/.openclaw`；本仓库只保留流水线代码与配置模板。Agent 工作区通过环境变量 `STAR_TIDE_ROOT` 指向本仓库绝对路径。

1. 确保 Gateway 已运行，且本机已安装 `openclaw` CLI。

2. 部署配置与密钥（在**仓库根目录**执行）：

```bash
./scripts/setup-openclaw.sh
# 或手动：
mkdir -p ~/.openclaw
cp openclaw.json.example ~/.openclaw/star-tide-daily.json
cp .env.example ~/.openclaw/.env
# 编辑 ~/.openclaw/.env：STAR_TIDE_ROOT、SILICONFLOW_API_KEY、OPENCLAW_GATEWAY_TOKEN
```

3. 在 `~/.bashrc`（或 `~/.zshrc`、systemd `Environment=`）中加入：

```bash
export OPENCLAW_STATE_DIR="$HOME/.openclaw"
export OPENCLAW_CONFIG_PATH="$HOME/.openclaw/star-tide-daily.json"
```

保存后 `source ~/.bashrc`，确认：

```bash
openclaw config file
# 应输出 ~/.openclaw/star-tide-daily.json（而非仓库内路径）
```

4. 安装 Lobster 插件（可在任意目录执行，会装入 `~/.openclaw/npm/...`）：

```bash
openclaw plugins install @openclaw/lobster
```

5. 注册 agent（按需）

先执行：

```bash
openclaw agents list
```

若输出中**已有** `main`、`github-trending`、`opensource-analyzer`、`ppt-maker` 四个 id（步骤 2 部署的 `star-tide-daily.json` 已定义它们），**跳过本节**，无需再执行 `openclaw agents add`。

若**缺少**上述 id，再按需注册（`workspace` 须与配置中 `${STAR_TIDE_ROOT}/agents/...` 一致）：

```bash
ROOT="${STAR_TIDE_ROOT:-/绝对路径/star-tide-daily}"
openclaw agents add github-trending --workspace "$ROOT/agents/github-trending"
openclaw agents add opensource-analyzer --workspace "$ROOT/agents/opensource-analyzer"
openclaw agents add ppt-maker --workspace "$ROOT/agents/ppt-maker"
```

> **勿**将 `OPENCLAW_CONFIG_PATH` 指向仓库内的 `openclaw.json.example`，否则 `plugins install` 会在仓库下生成 `npm/`、`extensions/`。

**备选：** 使用默认 `~/.openclaw/openclaw.json`（不设 `OPENCLAW_CONFIG_PATH`），合并本仓库 `openclaw.json.example` 中的 `agents` 与 `plugins.entries.lobster`，并保证 `.env` 含 `STAR_TIDE_ROOT`。

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
