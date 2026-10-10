#!/usr/bin/env bash
# Pede músicas à VPS e transcreve neste Mac até você fechar (Ctrl+C).
set -euo pipefail
CASA="${HOME}/.piano-mac"
cd "$(dirname "$0")/.."
export MAC_TOKEN="$(cat "$CASA/token")"
exec "$CASA/venv/bin/python" -m app.mac "$@"
