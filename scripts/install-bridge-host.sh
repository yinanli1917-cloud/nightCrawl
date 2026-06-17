#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# install-bridge-host.sh — set up the nightCrawl real-browser bridge (Engine R).
#
# Does three things, all locally (nothing leaves your machine):
#   1. Pins the extension's ID by generating a key and writing it into the
#      extension manifest (so the native-messaging allowlist is stable).
#   2. Installs a native-messaging host manifest pointing at a wrapper that runs
#      src/bridge-host.ts, allow-listed to exactly that extension ID.
#   3. Prints the next manual step (load the unpacked extension).
#
# Re-runnable (idempotent). macOS / Chromium-family browsers.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

HOST_NAME="com.nightcrawl.bridge"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT_DIR="$REPO_ROOT/stealth/extensions/nightcrawl-bridge"
HOST_SCRIPT="$REPO_ROOT/stealth/browser/src/bridge-host.ts"
KEY_PEM="$EXT_DIR/.bridge-key.pem"
WRAPPER="$EXT_DIR/.bridge-host-wrapper.sh"

BUN_BIN="$(command -v bun || echo "$HOME/.bun/bin/bun")"
[ -x "$BUN_BIN" ] || { echo "ERROR: bun not found. Install bun first."; exit 1; }
[ -f "$HOST_SCRIPT" ] || { echo "ERROR: missing $HOST_SCRIPT"; exit 1; }

echo "==> nightCrawl bridge install"
echo "    extension: $EXT_DIR"

# 1. Key + deterministic extension ID ----------------------------------------
if [ ! -f "$KEY_PEM" ]; then
  openssl genrsa 2048 >"$KEY_PEM" 2>/dev/null
  chmod 600 "$KEY_PEM"
  echo "    generated extension key"
fi
PUB_DER_B64="$(openssl rsa -in "$KEY_PEM" -pubout -outform DER 2>/dev/null | base64 | tr -d '\n')"
# Chrome extension ID = first 16 bytes of SHA256(DER pubkey), hex 0-f mapped to a-p.
EXT_ID="$(openssl rsa -in "$KEY_PEM" -pubout -outform DER 2>/dev/null \
  | openssl dgst -sha256 -binary | xxd -p -c 32 | head -c 32 | tr '0-9a-f' 'a-p')"
echo "    extension id: $EXT_ID"

# Patch manifest.json: set the "key" field so Chrome pins this ID.
python3 - "$EXT_DIR/manifest.json" "$PUB_DER_B64" <<'PY'
import json, sys
path, key = sys.argv[1], sys.argv[2]
m = json.load(open(path))
m["key"] = key
json.dump(m, open(path, "w"), indent=2)
open(path, "a").write("\n")
PY
echo "    pinned id in manifest.json"

# 2. Host wrapper + native-messaging manifest ---------------------------------
cat >"$WRAPPER" <<WRAP
#!/usr/bin/env bash
exec "$BUN_BIN" run "$HOST_SCRIPT"
WRAP
chmod +x "$WRAPPER"

read -r -d '' HOST_MANIFEST <<JSON || true
{
  "name": "$HOST_NAME",
  "description": "nightCrawl real-browser bridge",
  "path": "$WRAPPER",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
JSON

INSTALLED=0
for DIR in \
  "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts" \
  "$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts" \
  "$HOME/Library/Application Support/Arc/User Data/NativeMessagingHosts" \
  "$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts"; do
  PARENT="$(dirname "$DIR")"
  if [ -d "$PARENT" ]; then
    mkdir -p "$DIR"
    printf '%s\n' "$HOST_MANIFEST" >"$DIR/$HOST_NAME.json"
    echo "    installed host manifest → $DIR"
    INSTALLED=$((INSTALLED+1))
  fi
done
[ "$INSTALLED" -gt 0 ] || echo "    WARNING: no Chromium browser dir found; manifest not installed."

cat <<NEXT

==> Done. Final manual step (one time):
    1. Open Chrome → chrome://extensions → enable Developer mode.
    2. "Load unpacked" → select:
       $EXT_DIR
    3. Confirm the ID shown is: $EXT_ID
    4. Start nightcrawl (any 'nc goto ...'), then verify:
       nc goto https://example.com --engine=real
       (drives THIS Chrome in a background tab; check ~/.nightcrawl logs for "bridge connected")

To uninstall: remove the extension and delete the host manifest(s) named $HOST_NAME.json.
NEXT
