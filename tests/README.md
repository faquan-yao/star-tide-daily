# 测试目录（与正式工程分离）

本目录包含 **star-tide-daily** 流水线的全部测试资产；正式运行代码在仓库根目录的 `workflows/`、`scripts/`、`prompts/`、`agents/` 中。

## 结构

| 路径 | 层级 | 说明 |
|------|------|------|
| `preflight.sh` | L0 | 环境与静态检查 |
| `pipeline-agent.test.mjs` | L1 | `pipeline-agent.mjs` 单元测试（含 session 隔离、429 重试） |
| `run-pipeline-step.test.mjs` | L1 | `run-pipeline-step.mjs` 单步脚本单元测试 |
| `validate-output.mjs` | L2 | 各步骤 JSON 契约校验 |
| `fixtures/` | L2 | 标准样例 JSON |
| `run-e2e.mjs` / `e2e` | L3 | **E2E 快捷入口**（只需步骤名 + 可变参数） |
| `e2e-runbook.md` | L3/L4 | 手工 E2E 与审批流程手册（含底层命令详解） |

## 运行

在仓库根目录：

```bash
npm test
```

或进入本目录：

```bash
cd tests
npm test
npm run test:static      # L0 静态（CI）
npm run test:preflight   # L0 完整（含 gateway）
```

**L3 手工测试推荐：**

```bash
./tests/e2e preflight
./tests/e2e trending
./tests/e2e analyze --github-url openclaw/openclaw
./tests/e2e ppt-preview
./tests/e2e ppt-finalize
# 或: npm run e2e -- analyze --github-url openclaw/openclaw
```

底层命令与 Lobster 审批流程见 [e2e-runbook.md](e2e-runbook.md)。

`pipeline-agent.mjs` 常用参数：`--run-date`、`--timeout`、`--max-retries`、`--retry-delay-ms`、`--reuse-session`、`--cleanup-on-fail`；单步手动输入：`--github-url`（analyze）、`--analyze-report`（ppt_preview）、`--preview-md`（ppt_finalize）。

`run-pipeline-step.mjs` 常用参数：`--step`、`--run-date`、`--output-dir`、`--stdin-file`、`--force`，以及同上三个手动输入参数。详见根目录 [README.md](../README.md) 与 [e2e-runbook.md](e2e-runbook.md) L3-B/C/D/E。
