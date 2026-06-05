#!/usr/bin/env bash
# L0：star-tide-daily 环境与静态检查
# 用法:
#   ./tests/preflight.sh           # 完整检查（含 openclaw / gateway）
#   ./tests/preflight.sh --static  # 仅静态检查（CI / 无 openclaw 环境）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATIC_ONLY=0
if [[ "${1:-}" == "--static" ]]; then
  STATIC_ONLY=1
fi

PASS=0
FAIL=0
SKIP=0

pass() { echo "  OK   $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL $1"; FAIL=$((FAIL + 1)); }
skip() { echo "  SKIP $1"; SKIP=$((SKIP + 1)); }

require_file() {
  local label="$1" path="$2"
  if [[ -f "$path" ]]; then
    pass "$label"
  else
    fail "$label (missing: $path)"
  fi
}

echo "== L0 star-tide-daily preflight (static=$STATIC_ONLY) =="
echo "Project root: $ROOT"
echo ""

echo "-- L0-07/L0-08 工作流与路径 --"
require_file "workflow star-tide-daily.lobster" "$ROOT/workflows/star-tide-daily.lobster"
require_file "pipeline-agent.mjs" "$ROOT/scripts/pipeline-agent.mjs"
require_file "prompt trending.md" "$ROOT/prompts/trending.md"
require_file "prompt analyze.md" "$ROOT/prompts/analyze.md"
require_file "prompt ppt-preview.md" "$ROOT/prompts/ppt-preview.md"
require_file "prompt ppt-finalize.md" "$ROOT/prompts/ppt-finalize.md"
for agent in main github-trending opensource-analyzer ppt-maker; do
  require_file "agent $agent AGENTS.md" "$ROOT/agents/$agent/AGENTS.md"
done

LOBSTER="$ROOT/workflows/star-tide-daily.lobster"
if grep -q 'id: trending' "$LOBSTER" \
  && grep -q 'id: analyze' "$LOBSTER" \
  && grep -q 'id: ppt_preview' "$LOBSTER" \
  && grep -q 'id: ppt_finalize' "$LOBSTER" \
  && grep -q 'stdin: \$trending.stdout' "$LOBSTER" \
  && grep -q 'stdin: \$analyze.stdout' "$LOBSTER" \
  && grep -q 'stdin: \$ppt_preview.stdout' "$LOBSTER" \
  && grep -q 'approval: required' "$LOBSTER" \
  && grep -q 'condition: \$ppt_preview.approved' "$LOBSTER"; then
  pass "lobster stdin chain + approval + condition"
else
  fail "lobster stdin chain + approval + condition"
fi

echo ""
echo "-- L0-03 Node 版本 --"
if command -v node >/dev/null 2>&1; then
  NODE_VER="$(node -v | sed 's/^v//')"
  NODE_MAJOR="$(echo "$NODE_VER" | cut -d. -f1)"
  NODE_MINOR="$(echo "$NODE_VER" | cut -d. -f2)"
  if [[ "$NODE_MAJOR" -gt 22 ]] || { [[ "$NODE_MAJOR" -eq 22 ]] && [[ "$NODE_MINOR" -ge 19 ]]; }; then
    pass "node $NODE_VER (>= 22.19)"
  else
    if [[ "$STATIC_ONLY" -eq 1 ]]; then
      skip "node $NODE_VER (openclaw requires >= 22.19; static mode)"
    else
      fail "node $NODE_VER (openclaw requires >= 22.19)"
    fi
  fi
else
  fail "node not found"
fi

echo ""
echo "-- L0-02 环境变量 --"
if [[ -n "${STAR_TIDE_ROOT:-}" ]]; then
  if [[ "$STAR_TIDE_ROOT" == "$ROOT" ]] || [[ -d "$STAR_TIDE_ROOT" ]]; then
    pass "STAR_TIDE_ROOT=$STAR_TIDE_ROOT"
  else
    fail "STAR_TIDE_ROOT set but directory missing: $STAR_TIDE_ROOT"
  fi
else
  if [[ "$STATIC_ONLY" -eq 1 ]]; then
    skip "STAR_TIDE_ROOT not set (static mode)"
  else
    fail "STAR_TIDE_ROOT not set"
  fi
fi

if [[ -n "${OPENCLAW_STATE_DIR:-}" ]]; then
  pass "OPENCLAW_STATE_DIR=$OPENCLAW_STATE_DIR"
else
  if [[ "$STATIC_ONLY" -eq 1 ]]; then
    skip "OPENCLAW_STATE_DIR not set (static mode)"
  else
    fail "OPENCLAW_STATE_DIR not set"
  fi
fi

if [[ "$STATIC_ONLY" -eq 1 ]]; then
  echo ""
  echo "Static mode: skipping openclaw runtime checks (L0-01,04-06,09)."
  echo ""
  echo "== Summary: pass=$PASS fail=$FAIL skip=$SKIP =="
  [[ "$FAIL" -eq 0 ]]
  exit $?
fi

echo ""
echo "-- L0-01 OpenClaw 配置 --"
if command -v openclaw >/dev/null 2>&1; then
  CONFIG_FILE="$(openclaw config file 2>/dev/null || true)"
  if [[ -n "$CONFIG_FILE" ]] && [[ -f "$CONFIG_FILE" ]]; then
    pass "openclaw config file: $CONFIG_FILE"
  else
    fail "openclaw config file not found"
  fi
else
  fail "openclaw CLI not found"
fi

echo ""
echo "-- L0-04 Gateway --"
if command -v openclaw >/dev/null 2>&1; then
  if openclaw gateway status 2>/dev/null | grep -qiE 'running|online|active|listening'; then
    pass "gateway appears running"
  elif openclaw gateway status 2>/dev/null | grep -qiE 'stopped|offline|not running'; then
    fail "gateway not running"
  else
    if openclaw gateway status >/dev/null 2>&1; then
      skip "gateway status unclear (check manually)"
    else
      fail "gateway status command failed"
    fi
  fi
fi

echo ""
echo "-- L0-05 Agent 注册 --"
if command -v openclaw >/dev/null 2>&1; then
  AGENTS_LIST="$(openclaw agents list 2>/dev/null || true)"
  for id in main github-trending opensource-analyzer ppt-maker; do
    if echo "$AGENTS_LIST" | grep -q "$id"; then
      pass "agent registered: $id"
    else
      fail "agent missing: $id"
    fi
  done
fi

echo ""
echo "-- L0-06 Lobster 插件 --"
if command -v openclaw >/dev/null 2>&1; then
  PLUGINS="$(openclaw plugins list 2>/dev/null || true)"
  if echo "$PLUGINS" | grep -qi 'lobster'; then
    pass "lobster plugin listed"
  else
    fail "lobster plugin not found (run: openclaw plugins install @openclaw/lobster)"
  fi
fi

echo ""
echo "-- L0-09 密钥 --"
ENV_FILE="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/.env"
if [[ -f "$ENV_FILE" ]]; then
  pass ".env exists: $ENV_FILE"
  for key in SILICONFLOW_API_KEY OPENCLAW_GATEWAY_TOKEN; do
    if grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
      val="$(grep "^${key}=" "$ENV_FILE" | head -1 | cut -d= -f2-)"
      if [[ -z "$val" ]] || [[ "$val" == *"your-"* ]] || [[ "$val" == *"changeme"* ]] || [[ "$val" == *"绝对路径"* ]]; then
        fail "$key looks like placeholder"
      else
        pass "$key configured"
      fi
    else
      fail "$key missing in $ENV_FILE"
    fi
  done
else
  fail ".env missing: $ENV_FILE"
fi

echo ""
echo "== Summary: pass=$PASS fail=$FAIL skip=$SKIP =="
[[ "$FAIL" -eq 0 ]]
