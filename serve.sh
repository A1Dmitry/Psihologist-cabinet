#!/bin/bash
# Локальный сервер для ES-модулей (нужен HTTP, не file://)
cd "$(dirname "$0")"
PORT="${1:-8765}"
echo "ПсихоПортал → http://127.0.0.1:$PORT/"
echo "Остановка: Ctrl+C"
python3 -m http.server "$PORT"
