#!/bin/bash
cd "$(dirname "$0")"
PORT="${1:-8765}"
echo "PsihoPortal -> http://127.0.0.1:$PORT/"
python3 -m http.server "$PORT"
