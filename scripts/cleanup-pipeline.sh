#!/usr/bin/env bash
# 清理流水线临时产物与孤儿进程，缓解测试失败/中断后的磁盘与内存占用。
# 用法:
#   ./scripts/cleanup-pipeline.sh              # 默认：克隆目录 + 孤儿 git 进程
#   ./scripts/cleanup-pipeline.sh --all        # 另清理 agent 工作区误放的克隆
#   ./scripts/cleanup-pipeline.sh --sessions   # 仅清理 OpenClaw 会话缓存（保留最近 1 个）
#   ./scripts/cleanup-pipeline.sh --gateway    # 重启 Gateway（释放长会话占用的内存）
set -euo pipefail

ROOT="${STAR_TIDE_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
STATE_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"

DO_CLONES=1
DO_WORKSPACE_CLONES=0
DO_SESSIONS=0
DO_PROCESSES=1
DO_GATEWAY=0

usage() {
  cat <<EOF
用法: $0 [选项]

  (无选项)     清理 artifacts/、孤儿 git clone 进程
  --all        额外清理 agent 工作区中误克隆的仓库目录
  --sessions   清理 ~/.openclaw/agents/*/sessions 中的旧会话（每 agent 保留最新 1 个）
  --gateway    重启 OpenClaw Gateway（释放 agent 长会话内存）
  --help       显示此帮助

环境变量: STAR_TIDE_ROOT, OPENCLAW_STATE_DIR
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --all)
      DO_WORKSPACE_CLONES=1
      shift
      ;;
    --sessions)
      DO_SESSIONS=1
      DO_CLONES=0
      DO_PROCESSES=0
      shift
      ;;
    --gateway)
      DO_GATEWAY=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "未知选项: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

log() { echo "[cleanup] $*"; }

kill_orphan_git_clones() {
  if ! command -v pgrep >/dev/null 2>&1; then
    log "skip orphan processes (pgrep unavailable)"
    return
  fi
  local pids
  pids="$(pgrep -f "git clone.*(${ROOT}|star-tide-daily|artifacts/|tmp/clones)" 2>/dev/null || true)"
  if [[ -z "$pids" ]]; then
    log "no orphan git clone processes"
    return
  fi
  log "terminating orphan git clone PIDs: $pids"
  kill -TERM $pids 2>/dev/null || true
  sleep 1
  kill -KILL $pids 2>/dev/null || true
}

remove_dir_if_exists() {
  local path="$1"
  if [[ -e "$path" ]]; then
    log "remove: $path"
    rm -rf "$path"
  fi
}

clean_project_artifacts() {
  remove_dir_if_exists "$ROOT/artifacts"
  # 兼容旧版产物路径
  remove_dir_if_exists "$ROOT/tmp/clones"
  remove_dir_if_exists "$ROOT/reports/daily"
  for agent in main github-trending opensource-analyzer ppt-maker; do
    remove_dir_if_exists "$ROOT/agents/$agent/tmp/clones"
    remove_dir_if_exists "$ROOT/agents/$agent/artifacts"
    remove_dir_if_exists "$ROOT/agents/$agent/reports"
  done
}

clean_workspace_misplaced_clones() {
  local git_dir clone_root dest date_dir clones_dir repo_name
  while IFS= read -r -d '' git_dir; do
    clone_root="$(dirname "$git_dir")"
    case "$clone_root" in
      "$ROOT"/agents/*/*)
        repo_name="$(basename "$clone_root")"
        if [[ -d "$ROOT/artifacts" ]]; then
          date_dir="$(find "$ROOT/artifacts" -mindepth 1 -maxdepth 1 -type d ! -name '.pipeline' 2>/dev/null | sort | tail -1)"
          if [[ -n "$date_dir" ]]; then
            clones_dir="$date_dir/clones"
            mkdir -p "$clones_dir"
            dest="$clones_dir/$repo_name"
            if [[ ! -e "$dest" ]]; then
              log "relocate misplaced clone to artifacts: $clone_root -> $dest"
              mv "$clone_root" "$dest"
              continue
            fi
          fi
        fi
        log "remove misplaced clone: $clone_root"
        rm -rf "$clone_root"
        ;;
    esac
  done < <(find "$ROOT/agents" -mindepth 3 -maxdepth 5 -type d -name .git -print0 2>/dev/null || true)
}

prune_agent_sessions() {
  if [[ ! -d "$STATE_DIR/agents" ]]; then
    log "skip sessions ($STATE_DIR/agents missing)"
    return
  fi
  local agent_dir sessions_dir keep
  for agent_dir in "$STATE_DIR/agents"/*/; do
    [[ -d "$agent_dir" ]] || continue
    sessions_dir="${agent_dir}sessions"
    [[ -d "$sessions_dir" ]] || continue
    keep="$(find "$sessions_dir" -maxdepth 1 -type f -name '*.jsonl' -printf '%T@ %p\n' 2>/dev/null | sort -nr | head -1 | cut -d' ' -f2- || true)"
    local f
    for f in "$sessions_dir"/*.jsonl "$sessions_dir"/*.json; do
      [[ -e "$f" ]] || continue
      [[ -n "$keep" && "$f" == "$keep" ]] && continue
      log "remove old session: $f"
      rm -f "$f"
    done
    for f in "$sessions_dir"/*.trajectory.jsonl "$sessions_dir"/*.trajectory-path.json; do
      [[ -e "$f" ]] || continue
      log "remove session artifact: $f"
      rm -f "$f"
    done
  done
}

restart_gateway() {
  if ! command -v openclaw >/dev/null 2>&1; then
    log "skip gateway restart (openclaw not found)"
    return
  fi
  log "restarting gateway"
  openclaw gateway restart 2>/dev/null || openclaw gateway stop 2>/dev/null || true
  openclaw gateway start 2>/dev/null || true
}

log "STAR_TIDE_ROOT=$ROOT"

if [[ "$DO_PROCESSES" -eq 1 ]]; then
  kill_orphan_git_clones
fi
if [[ "$DO_CLONES" -eq 1 ]]; then
  clean_project_artifacts
fi
if [[ "$DO_WORKSPACE_CLONES" -eq 1 ]]; then
  clean_workspace_misplaced_clones
fi
if [[ "$DO_SESSIONS" -eq 1 ]]; then
  prune_agent_sessions
fi
if [[ "$DO_GATEWAY" -eq 1 ]]; then
  restart_gateway
fi

log "done"
