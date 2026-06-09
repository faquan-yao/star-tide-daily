# TOOLS.md - Local Notes

Skills define _how_ tools work. This file is for _your_ specifics — the stuff that's unique to your setup.

## star-tide-daily 环境

- **STAR_TIDE_ROOT：** 本仓库绝对路径（Gateway systemd 与 shell 均需设置）
- **产物目录：** `artifacts/<date>/`（报告）、`artifacts/<date>/clones/`、`artifacts/<date>/ppt/`
- **单步 state：** `artifacts/<date>/.pipeline/<step>.json`
- **单步脚本：** `node scripts/run-pipeline-step.mjs --step trending|analyze|ppt_preview|ppt_finalize`
- **Lobster 工作流：** `workflows/star-tide-daily.lobster`

## 消息通道

| 通道 | OpenClaw channel id | 路由 |
|------|---------------------|------|
| TUI | webchat / tui | `/agent main` |
| 微信 | `openclaw-weixin` | bindings → main |
| QQ | `qqbot` | bindings → main |

长任务（analyze / 全流程）可能超过默认消息 timeout；必要时在 Gateway 或 agent 配置中延长 timeout（建议 ≥14400s）。

## Related

- [Agent workspace](/concepts/agent-workspace)
