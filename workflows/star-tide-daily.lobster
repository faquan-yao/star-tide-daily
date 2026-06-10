# star-tide-daily（星潮日报）：趋势 -> 分析 -> PPT 预览（审批）-> PPT 定稿
# 在项目根目录运行

name: star-tide-daily
args:
  runDate:
    default: ""
  outputDir:
    default: "artifacts"
steps:
  - id: trending
    env:
      RUN_DATE: "$LOBSTER_ARG_RUN_DATE"
      OUTPUT_DIR: "$LOBSTER_ARG_OUTPUT_DIR"
    command: >-
      node scripts/fetch-github-trending.mjs
      --run-date "$RUN_DATE"

  - id: analyze
    env:
      RUN_DATE: "$LOBSTER_ARG_RUN_DATE"
      OUTPUT_DIR: "$LOBSTER_ARG_OUTPUT_DIR"
    command: >-
      node scripts/pipeline-agent.mjs
      --agent opensource-analyzer
      --prompt-file prompts/analyze.md
      --timeout 7200
      --output-dir "$OUTPUT_DIR"
      --run-date "$RUN_DATE"
    stdin: $trending.stdout

  - id: ppt_preview
    env:
      RUN_DATE: "$LOBSTER_ARG_RUN_DATE"
      OUTPUT_DIR: "$LOBSTER_ARG_OUTPUT_DIR"
    command: >-
      node scripts/pipeline-agent.mjs
      --agent ppt-maker
      --prompt-file prompts/ppt-preview.md
      --timeout 3600
      --output-dir "$OUTPUT_DIR"
      --run-date "$RUN_DATE"
    stdin: $analyze.stdout
    approval: required

  - id: ppt_finalize
    env:
      RUN_DATE: "$LOBSTER_ARG_RUN_DATE"
      OUTPUT_DIR: "$LOBSTER_ARG_OUTPUT_DIR"
    command: >-
      node scripts/pipeline-agent.mjs
      --agent ppt-maker
      --prompt-file prompts/ppt-finalize.md
      --timeout 3600
      --output-dir "$OUTPUT_DIR"
      --run-date "$RUN_DATE"
    stdin: $ppt_preview.stdout
    condition: $ppt_preview.approved
