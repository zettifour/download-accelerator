#!/bin/bash
# Build script for macOS
# Requires Homebrew Python to avoid Apple-framework signing issues with PyInstaller.
set -e
cd "$(dirname "$0")"

# ── Find a suitable Python ────────────────────────────────────────────────────
# Homebrew Python avoids the "Python.framework is damaged" problem because
# it is not an Apple-signed framework bundle.
PYTHON=""
for candidate in \
    /opt/homebrew/bin/python3 \
    /usr/local/bin/python3; do
    if [ -x "$candidate" ]; then
        PYTHON="$candidate"
        break
    fi
done

if [ -z "$PYTHON" ]; then
    echo ""
    echo "ERROR: Homebrew Python not found."
    echo "Install with:  brew install python"
    echo ""
    echo "Alternatively use install.sh (no build required)."
    exit 1
fi

echo "→ Using Python: $PYTHON ($($PYTHON --version))"

# ── Virtual environment ───────────────────────────────────────────────────────
VENV="build/venv"
echo "→ Setting up virtual environment …"
"$PYTHON" -m venv "$VENV"
PIP="$VENV/bin/pip"
PYINSTALLER="$VENV/bin/pyinstaller"

echo "→ Installing dependencies …"
"$PIP" install -q requests pyinstaller

# ── PyInstaller ───────────────────────────────────────────────────────────────
echo "→ Building binary …"
"$PYINSTALLER" host.py \
    --onedir \
    --name download_accelerator_host \
    --distpath dist \
    --workpath build \
    --specpath build \
    --hidden-import=requests \
    --hidden-import=urllib3 \
    --hidden-import=charset_normalizer \
    --hidden-import=certifi \
    --clean \
    --noconfirm

# ── Sign (ad-hoc) ─────────────────────────────────────────────────────────────
echo "→ Signing …"
xattr -cr dist/download_accelerator_host
codesign --force --deep --sign - dist/download_accelerator_host/download_accelerator_host

echo ""
echo "✓ dist/download_accelerator_host/ ready"
echo ""
echo "Next: ./install.sh EXTENSION_ID"
