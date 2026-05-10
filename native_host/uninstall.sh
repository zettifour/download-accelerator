#!/bin/bash
# Uninstaller for the Download Accelerator native messaging host (macOS).
set -e

MANIFEST_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"

echo "→ Removing manifests …"
# Current name
rm -f "$MANIFEST_DIR/com.downloadaccelerator.native_host.json"
# Legacy name (before rename)
rm -f "$MANIFEST_DIR/com.pdm.native_host.json"

echo "→ Removing host files …"
# Current install dir
rm -rf "$HOME/.download_accelerator_host"
# Legacy install dir (before rename)
rm -rf "$HOME/.pdm_host"

echo ""
echo "✓ Download Accelerator native host removed."
echo "  Reload or remove the Chrome extension manually at chrome://extensions"
