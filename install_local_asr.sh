#!/bin/sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
INSTALL_DIR="$HOME/Library/Application Support/Xiaoyuzhou Desktop Native Host"
VENV_DIR="$INSTALL_DIR/local-asr-venv"
WORKER_SOURCE="$SCRIPT_DIR/local_asr_worker.py"
WORKER_TARGET="$INSTALL_DIR/local_asr_worker.py"
UV_BIN="${UV_BIN:-$(command -v uv || true)}"

if [ "$(uname -s)" != "Darwin" ] || [ "$(uname -m)" != "arm64" ]; then
  echo "本地 Qwen ASR 仅支持 Apple Silicon macOS" >&2
  exit 1
fi
if [ -z "$UV_BIN" ]; then
  echo "未找到 uv，请先执行：brew install uv" >&2
  exit 1
fi
if ! command -v ffmpeg >/dev/null 2>&1 \
  && [ ! -x /opt/homebrew/bin/ffmpeg ] \
  && [ ! -x /usr/local/bin/ffmpeg ]; then
  echo "警告：未找到 ffmpeg，M4A/MP3 等播客音频将无法转写。" >&2
  echo "请执行：brew install ffmpeg" >&2
fi
if [ ! -f "$WORKER_SOURCE" ]; then
  echo "缺少本地 ASR Worker：$WORKER_SOURCE" >&2
  exit 1
fi

mkdir -p "$INSTALL_DIR"
cp "$WORKER_SOURCE" "$WORKER_TARGET"
chmod +x "$WORKER_TARGET"

if [ ! -x "$VENV_DIR/bin/python" ]; then
  "$UV_BIN" venv --python 3.12 "$VENV_DIR"
fi
"$UV_BIN" pip install \
  --python "$VENV_DIR/bin/python" \
  "mlx-qwen3-asr==0.3.5"

"$VENV_DIR/bin/python" -c \
  "import mlx_qwen3_asr; print('本地 Qwen ASR 已安装：' + mlx_qwen3_asr.__version__)"
echo "默认模型会在首次使用时下载；可在设置页选择 0.6B 或 1.7B。"
