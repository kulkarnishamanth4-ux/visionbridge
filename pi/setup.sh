#!/bin/bash
# ─────────────────────────────────────────────
#  VisionBridge Pi — Setup Script
#  Delegates to the modular Python installer.
#
#  Usage:
#    chmod +x setup.sh && ./setup.sh
#
#  Options (passed through to install.py):
#    --dry-run       Show what would be done
#    --verify        Run verification only
#    --skip-system   Skip apt package installation
#    --skip-python   Skip venv/pip setup
# ─────────────────────────────────────────────

cd "$(dirname "$0")"

# Ensure Python 3 is available
if ! command -v python3 &> /dev/null; then
    echo "ERROR: python3 is not installed."
    echo "Run: sudo apt-get update && sudo apt-get install -y python3"
    exit 1
fi

# Run the modular installer
python3 install.py "$@"
