#!/bin/bash
# macOS installer for the Download Accelerator native messaging host.
# Uses the pre-built Swift binary (dist/download_accelerator_host) if available,
# otherwise compiles from host.swift (requires Xcode Command Line Tools).
set -e

DEFAULT_ID="blnkpmlpabmgkmkdhkdnnphflbddnhjh"
EXTENSION_ID="${1:-$DEFAULT_ID}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_DIR="$HOME/.download_accelerator_host"

# ── Clean up legacy installations ─────────────────────────────────────────────
# Legacy name (before rename from pdm_host)
rm -rf "$HOME/.pdm_host"
rm -f  "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.pdm.native_host.json"
# Legacy PyInstaller onedir subdir (before Swift rewrite)
rm -rf "$INSTALL_DIR/download_accelerator_host"

mkdir -p "$INSTALL_DIR"

# ── Choose binary source ──────────────────────────────────────────────────────
BINARY_SRC="$SCRIPT_DIR/dist/download_accelerator_host"

if [ ! -f "$BINARY_SRC" ]; then
    echo "→ No pre-built binary found – compiling from source …"
    if ! command -v swiftc &>/dev/null; then
        echo ""
        echo "ERROR: swiftc not found."
        echo "Install Xcode Command Line Tools with:  xcode-select --install"
        echo ""
        exit 1
    fi
    mkdir -p "$SCRIPT_DIR/dist"
    swiftc -O -o "$BINARY_SRC" "$SCRIPT_DIR/host.swift"
    xattr -cr "$BINARY_SRC"
    codesign --force --sign - "$BINARY_SRC"
    echo "✓ Compiled successfully."
fi

echo "→ Installing binary …"
cp "$BINARY_SRC" "$INSTALL_DIR/download_accelerator_host"
chmod +x "$INSTALL_DIR/download_accelerator_host"
# Re-sign after copy so macOS accepts the binary from its new location
xattr -cr "$INSTALL_DIR/download_accelerator_host"
codesign --force --sign - "$INSTALL_DIR/download_accelerator_host"

LAUNCHER="$INSTALL_DIR/download_accelerator_host"

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
