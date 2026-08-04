#!/bin/sh
set -eu

HOST_NAME="com.xiaoyuzhou.desktop"
DEFAULT_EXTENSION_ID="ggemekebddifkcodgiahcelbboolmfpn"
EXTENSION_ID="${1:-$DEFAULT_EXTENSION_ID}"
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
SOURCE_HOST_SCRIPT="$SCRIPT_DIR/native_host.py"
INSTALL_DIR="$HOME/Library/Application Support/Xiaoyuzhou Desktop Native Host"
HOST_SCRIPT="$INSTALL_DIR/native_host.py"
HOST_LAUNCHER="$INSTALL_DIR/native-host"
MANIFEST_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
MANIFEST_PATH="$MANIFEST_DIR/$HOST_NAME.json"

case "$EXTENSION_ID" in
  *[!a-p]*|"")
    echo "无效的 Chrome 扩展 ID：$EXTENSION_ID" >&2
    exit 1
    ;;
esac

mkdir -p "$INSTALL_DIR"
cp "$SOURCE_HOST_SCRIPT" "$HOST_SCRIPT"
chmod +x "$HOST_SCRIPT"

cat > "$HOST_LAUNCHER" <<EOF
#!/bin/sh
exec /usr/bin/python3 "$HOST_SCRIPT"
EOF
chmod +x "$HOST_LAUNCHER"
mkdir -p "$MANIFEST_DIR"

/usr/bin/python3 - "$MANIFEST_PATH" "$HOST_LAUNCHER" "$EXTENSION_ID" <<'PY'
import json
import sys

manifest_path, host_launcher, extension_id = sys.argv[1:]
manifest = {
    "name": "com.xiaoyuzhou.desktop",
    "description": "Xiaoyuzhou Desktop local file and ASR helper",
    "path": host_launcher,
    "type": "stdio",
    "allowed_origins": [f"chrome-extension://{extension_id}/"],
}
with open(manifest_path, "w", encoding="utf-8") as file:
    json.dump(manifest, file, ensure_ascii=False, indent=2)
    file.write("\n")
PY

echo "本地助手已安装：$MANIFEST_PATH"
echo "允许的扩展 ID：$EXTENSION_ID"
