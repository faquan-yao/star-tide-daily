#!/usr/bin/env bash
# 将 openclaw 配置模板部署到 ~/.openclaw，与 star-tide-daily 仓库隔离。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
CONFIG_DEST="$STATE_DIR/star-tide-daily.json"
ENV_DEST="$STATE_DIR/.env"

mkdir -p "$STATE_DIR"

if [[ -f "$CONFIG_DEST" ]]; then
  echo "已存在，跳过: $CONFIG_DEST"
else
  cp "$ROOT/openclaw.json.example" "$CONFIG_DEST"
  echo "已创建: $CONFIG_DEST"
fi

if [[ -f "$ENV_DEST" ]]; then
  if ! grep -q '^STAR_TIDE_ROOT=' "$ENV_DEST" 2>/dev/null; then
    echo "STAR_TIDE_ROOT=$ROOT" >> "$ENV_DEST"
    echo "已向 $ENV_DEST 追加 STAR_TIDE_ROOT=$ROOT"
  else
    echo "已存在 STAR_TIDE_ROOT，跳过: $ENV_DEST"
  fi
else
  sed "s|STAR_TIDE_ROOT=/绝对路径/star-tide-daily|STAR_TIDE_ROOT=$ROOT|" \
    "$ROOT/.env.example" > "$ENV_DEST"
  echo "已创建: $ENV_DEST（请补全 API Key 与 Gateway token）"
fi

echo ""
echo "请将以下内容加入 ~/.bashrc（或 systemd Environment）："
echo ""
echo "export OPENCLAW_STATE_DIR=\"\$HOME/.openclaw\""
echo "export OPENCLAW_CONFIG_PATH=\"\$HOME/.openclaw/star-tide-daily.json\""
echo ""
echo "然后: source ~/.bashrc"
echo "验证: openclaw config file"
echo "安装插件: openclaw plugins install @openclaw/lobster"
