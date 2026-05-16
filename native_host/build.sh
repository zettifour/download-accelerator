#!/bin/bash
# Build script for macOS — compiles the Swift native host into a single binary.
# Requires Xcode Command Line Tools: xcode-select --install
set -e
cd "$(dirname "$0")"

# ── Check for swiftc ─────────────────────────────────────────────────────────
if ! command -v swiftc &>/dev/null; then
    echo ""
    echo "ERROR: swiftc not found."
    echo "Install Xcode Command Line Tools with:  xcode-select --install"
    echo ""
    exit 1
fi

echo "→ Using $(swiftc --version | head -1)"

# ── Compile ───────────────────────────────────────────────────────────────────
mkdir -p dist
echo "→ Compiling host.swift …"
swiftc -O -o dist/download_accelerator_host host.swift

# ── Sign (ad-hoc) ─────────────────────────────────────────────────────────────
echo "→ Signing …"
xattr -cr dist/download_accelerator_host
codesign --force --sign - dist/download_accelerator_host

echo ""
echo "✓ dist/download_accelerator_host ready"
echo ""
echo "Next: ./install.sh"
