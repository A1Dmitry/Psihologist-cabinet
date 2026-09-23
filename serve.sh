#!/bin/bash
cd "$(dirname "$0")"
PORT="${1:-8765}"
echo "PsihoPortal -> http://127.0.0.1:$PORT/"
# devserver.py: статика + SPA-fallback (глубокие ссылки /psy/{slug}) + подстановка %BASE%
exec python3 devserver.py "$PORT" /
