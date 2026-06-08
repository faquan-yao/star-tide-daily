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
    command: >-
      node scripts/pipeline-agent.mjs
      --agent github-trending
      --prompt-file prompts/trending.md
      --timeout 1800
      --output-dir artifacts

  - id: analyze
    command: >-
      node scripts/pipeline-agent.mjs
      --agent opensource-analyzer
      --prompt-file prompts/analyze.md
      --timeout 7200
      --output-dir artifacts
    stdin: $trending.stdout

  - id: ppt_preview
    command: >-
      node scripts/pipeline-agent.mjs
      --agent ppt-maker
      --prompt-file prompts/ppt-preview.md
      --timeout 3600
      --output-dir artifacts
    stdin: $analyze.stdout
    approval: required

  - id: ppt_finalize
    command: >-
      node scripts/pipeline-agent.mjs
      --agent ppt-maker
      --prompt-file prompts/ppt-finalize.md
      --timeout 3600
      --output-dir artifacts
    stdin: $ppt_preview.stdout
    condition: $ppt_preview.approved
