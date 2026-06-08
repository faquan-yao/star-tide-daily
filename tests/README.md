# 测试目录（与正式工程分离）

本目录包含 **star-tide-daily** 流水线的全部测试资产；正式运行代码在仓库根目录的 `workflows/`、`scripts/`、`prompts/`、`agents/` 中。

## 结构

| 路径 | 层级 | 说明 |
|------|------|------|
| `preflight.sh` | L0 | 环境与静态检查 |
| `pipeline-agent.test.mjs` | L1 | `pipeline-agent.mjs` 单元测试（含 session 隔离、429 重试） |
| `validate-output.mjs` | L2 | 各步骤 JSON 契约校验 |
| `fixtures/` | L2 | 标准样例 JSON |
| `e2e-runbook.md` | L3/L4 | 手工 E2E 与审批流程手册 |

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

手工全流程见 [e2e-runbook.md](e2e-runbook.md)（含 `pipeline-agent.mjs` 输出格式说明与校验失败排查）。

`pipeline-agent.mjs` 常用参数：`--run-date`、`--timeout`、`--max-retries`、`--retry-delay-ms`、`--reuse-session`、`--cleanup-on-fail`。详见根目录 [README.md](../README.md)。
