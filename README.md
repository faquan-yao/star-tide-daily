# star-tide-daily（星潮日报）

基于 OpenClaw + Lobster 的每日 GitHub 开源报告流水线：昨日 star 增速 Top 3 → 克隆分析 → 可商用 PPT（预览需人工审批）。

主 agent `main` 通过 Lobster 工作流串联三个子 agent。

**项目根目录：** 本仓库根目录（下文路径均相对此目录）

## 目录结构

| 路径 | 说明 |
|------|------|
| `workflows/star-tide-daily.lobster` | Lobster 四步流水线 |
| `scripts/pipeline-agent.mjs` | 调用 `openclaw agent --json` 的管道脚本 |
| `scripts/setup-openclaw.sh` | 一键将模板部署到 `~/.openclaw` |
| `prompts/*.md` | 各步骤任务提示（中文） |
| `agents/*/AGENTS.md` | 各 agent 职责与 JSON 契约（中文） |
| `openclaw.json.example` | OpenClaw 配置模板（部署到 `~/.openclaw/`，勿在仓库内直接作运行配置） |
| `.env.example` | 复制到 `~/.openclaw/.env`（含 `STAR_TIDE_ROOT` 与密钥） |

**测试（独立于正式工程，见 `tests/`）：**

| 路径 | 说明 |
|------|------|
| `tests/preflight.sh` | L0 环境与静态检查 |
| `tests/pipeline-agent.test.mjs` | L1 单元测试 |
| `tests/validate-output.mjs` | L2 JSON 契约校验 |
| `tests/fixtures/` | 步骤间标准样例 |
| `tests/e2e-runbook.md` | L3/L4 手工 E2E 手册 |

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

3. 在 `~/.bashrc`（或 `~/.zshrc`）中加入（供 CLI 与交互式 shell 使用；Gateway 另见步骤 4）：

```bash
export OPENCLAW_STATE_DIR="$HOME/.openclaw"
export OPENCLAW_CONFIG_PATH="$HOME/.openclaw/star-tide-daily.json"
export STAR_TIDE_ROOT=/绝对路径/star-tide-daily   # 须与 ~/.openclaw/.env 中一致
```

保存后 `source ~/.bashrc`，确认：

```bash
openclaw config file
# 应输出 ~/.openclaw/star-tide-daily.json（而非仓库内路径）
echo "$STAR_TIDE_ROOT"
# 应输出本仓库绝对路径
```

4. 配置 Gateway systemd 服务（**必须**）

Gateway 以 systemd 用户服务运行，**不会**继承 `~/.bashrc` 中的环境变量。若只配置了 shell 而未改 systemd，会出现：

- `openclaw agents list` 能看到四个 agent id
- `openclaw agent --agent github-trending` 报 `unknown agent id "github-trending"`

原因是 CLI 读的是 `star-tide-daily.json`，而 Gateway 进程仍用默认的 `~/.openclaw/openclaw.json`。

编辑 `~/.config/systemd/user/openclaw-gateway.service`，在 `[Service]` 段加入（路径替换为实际值）：

```ini
Environment=OPENCLAW_STATE_DIR=/home/<user>/.openclaw
Environment=OPENCLAW_CONFIG_PATH=/home/<user>/.openclaw/star-tide-daily.json
Environment=STAR_TIDE_ROOT=/绝对路径/star-tide-daily
```

保存后重载并重启：

```bash
systemctl --user daemon-reload
openclaw gateway restart
openclaw gateway status
```

验证 Gateway 已加载正确配置：

```bash
# 应能成功返回 JSON，不再报 unknown agent id
openclaw agent --agent github-trending --message "ping" --json --timeout 60

# Gateway 日志中的 model 应与 star-tide-daily.json 一致（非 openclaw.json 中的模型）
grep "agent model" /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log | tail -1
```

5. 安装 Lobster 插件（可在任意目录执行，会装入 `~/.openclaw/npm/...`）：

```bash
openclaw plugins install @openclaw/lobster
```

6. 注册 agent（按需）

先执行：

```bash
openclaw agents list
```

若输出中**已有** `main`、`github-trending`、`opensource-analyzer`、`ppt-maker` 四个 id（步骤 2 部署的 `star-tide-daily.json` 已定义它们），**跳过本节**，无需再执行 `openclaw agents add`。

若**缺少**上述 id，再按需注册（`workspace` 须与配置中 `${STAR_TIDE_ROOT}/agents/...` 一致）：

```bash
openclaw agents add github-trending --workspace "$STAR_TIDE_ROOT/agents/github-trending"
openclaw agents add opensource-analyzer --workspace "$STAR_TIDE_ROOT/agents/opensource-analyzer"
openclaw agents add ppt-maker --workspace "$STAR_TIDE_ROOT/agents/ppt-maker"
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

## 自动化测试

测试代码均在 [`tests/`](tests/) 目录，与流水线正式文件分离：

```bash
npm test                      # L1 单测 + L2 fixture 契约校验
npm run test:static --prefix tests   # L0 静态检查（CI / 无 openclaw 环境）
./tests/preflight.sh          # L0 完整环境检查（含 gateway / agents）
```

手工 E2E（L3/L4，含 `resumeToken` 审批流程）见 [tests/e2e-runbook.md](tests/e2e-runbook.md)。

## 验证清单

1. `openclaw agents list` 可见四个 agent id
2. 手动运行 trending 步骤返回合法 JSON
3. Lobster 全流程运行至 `needs_approval`
4. `resume` 且 `approve: true` 后生成 `.pptx`
5. `openclaw cron runs --id <job-id>` 显示定时执行成功
