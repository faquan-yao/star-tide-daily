# star-tide-daily（星潮日报）：趋势 -> 分析 -> PPT 预览（审批）-> PPT 定稿
# 在项目根目录运行
# 单步调试可传入手动输入（优先于上一步 stdout）：
#   githubUrl      — analyze 步骤：GitHub 项目地址
#   analyzeReport  — ppt_preview 步骤：分析报告 .md 路径
#   previewMd      — ppt_finalize 步骤：预览 .md 路径

name: star-tide-daily
args:
  runDate:
    default: ""
  outputDir:
    default: "artifacts"
  githubUrl:
    default: ""
  analyzeReport:
    default: ""
  previewMd:
    default: ""
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
      GITHUB_URL: "$LOBSTER_ARG_GITHUB_URL"
    command: >-
      node scripts/pipeline-agent.mjs
      --agent opensource-analyzer
      --prompt-file prompts/analyze.md
      --timeout 7200
      --output-dir "$OUTPUT_DIR"
      --run-date "$RUN_DATE"
      --github-url "$GITHUB_URL"
    stdin: $trending.stdout

  - id: ppt_preview
    env:
      RUN_DATE: "$LOBSTER_ARG_RUN_DATE"
      OUTPUT_DIR: "$LOBSTER_ARG_OUTPUT_DIR"
      ANALYZE_REPORT: "$LOBSTER_ARG_ANALYZE_REPORT"
    command: >-
      node scripts/pipeline-agent.mjs
      --agent ppt-maker
      --prompt-file prompts/ppt-preview.md
      --timeout 3600
      --output-dir "$OUTPUT_DIR"
      --run-date "$RUN_DATE"
      --analyze-report "$ANALYZE_REPORT"
    stdin: $analyze.stdout
    approval: required

  - id: ppt_finalize
    env:
      RUN_DATE: "$LOBSTER_ARG_RUN_DATE"
      OUTPUT_DIR: "$LOBSTER_ARG_OUTPUT_DIR"
      PREVIEW_MD: "$LOBSTER_ARG_PREVIEW_MD"
    command: >-
      node scripts/pipeline-agent.mjs
      --agent ppt-maker
      --prompt-file prompts/ppt-finalize.md
      --timeout 3600
      --output-dir "$OUTPUT_DIR"
      --run-date "$RUN_DATE"
      --preview-md "$PREVIEW_MD"
    stdin: $ppt_preview.stdout
    condition: $ppt_preview.approved
