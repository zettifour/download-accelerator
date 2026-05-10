#!/bin/bash
# macOS installer for the Download Accelerator native messaging host.
# Uses the pre-built binary (dist/download_accelerator_host) if available,
# otherwise creates a shell-launcher (no build required).
set -e

DEFAULT_ID="blnkpmlpabmgkmkdhkdnnphflbddnhjh"
EXTENSION_ID="${1:-$DEFAULT_ID}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_DIR="$HOME/.download_accelerator_host"
mkdir -p "$INSTALL_DIR"

# ── Choose binary or shell launcher ──────────────────────────────────────────
if [ -d "$SCRIPT_DIR/dist/download_accelerator_host" ]; then
    echo "→ Using pre-built binary …"
    rm -rf "$INSTALL_DIR/download_accelerator_host"
    cp -R "$SCRIPT_DIR/dist/download_accelerator_host" "$INSTALL_DIR/download_accelerator_host"
    chmod +x "$INSTALL_DIR/download_accelerator_host/download_accelerator_host"
    # Re-sign after copy so macOS accepts the binary from its new location
    xattr -cr "$INSTALL_DIR/download_accelerator_host"
    codesign --force --deep --sign - "$INSTALL_DIR/download_accelerator_host/download_accelerator_host"
    LAUNCHER="$INSTALL_DIR/download_accelerator_host/download_accelerator_host"
else
    echo "→ No binary found – creating shell launcher …"
    echo "  (Run build.sh first to build a self-contained binary)"

    # Ensure requests is installed
    python3 -c "import requests" 2>/dev/null || python3 -m pip install --user requests

    PYTHON3="$(which python3 2>/dev/null || which python)"
    if [ -z "$PYTHON3" ]; then
        echo "ERROR: python3 not found."; exit 1
    fi

    cp "$SCRIPT_DIR/host.py" "$INSTALL_DIR/host.py"

    LAUNCHER="$INSTALL_DIR/download_accelerator_host_launcher"
    cat > "$LAUNCHER" << EOF
#!/bin/bash
exec "$PYTHON3" "$INSTALL_DIR/host.py" "\$@"
EOF
    chmod +x "$LAUNCHER"
fi

# ── Write Chrome manifest ─────────────────────────────────────────────────────
MANIFEST_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
mkdir -p "$MANIFEST_DIR"

cat > "$MANIFEST_DIR/com.downloadaccelerator.native_host.json" << EOF
{
  "name": "com.downloadaccelerator.native_host",
  "description": "Download Accelerator Native Host",
  "path": "$LAUNCHER",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXTENSION_ID/"]
}
EOF

echo ""
echo "✓ Installed!"
echo "  Host:     $LAUNCHER"
echo "  Manifest: $MANIFEST_DIR/com.downloadaccelerator.native_host.json"
echo ""
echo "Reload the Chrome extension – done."
