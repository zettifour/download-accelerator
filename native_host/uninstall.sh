#!/bin/bash
# Uninstaller for the Download Accelerator native messaging host (macOS).
set -e

INSTALL_DIR="$HOME/.download_accelerator_host"
MANIFEST="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.downloadaccelerator.native_host.json"

echo "→ Removing manifest …"
rm -f "$MANIFEST"

echo "→ Removing host files …"
rm -rf "$INSTALL_DIR"

echo ""
echo "✓ Download Accelerator native host removed."
echo "  Reload or remove the Chrome extension manually at chrome://extensions"
