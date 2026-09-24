#!/usr/bin/env bash
# Empacota o worker com PyInstaller (onedir) e copia para app/resources/worker/.
# WHISPERCPP_WHEEL=<wheel> troca o pywhispercpp do PyPI pelo compilado com GPU (build-whispercpp).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WHEEL="${WHISPERCPP_WHEEL:-}"
if [ -n "$WHEEL" ]; then
  WHEEL="$(cd "$(dirname "$WHEEL")" && pwd)/$(basename "$WHEEL")"  # absoluto: o uv roda em worker/
fi
cd "$ROOT/worker"
# --frozen: o CI grava a versão do release no pyproject; o lock (dependências) segue o mesmo.
uv sync --frozen --group build
if [ -n "$WHEEL" ]; then
  uv pip install --reinstall-package pywhispercpp "$WHEEL"
fi
uv run --no-sync pyinstaller --noconfirm --clean transcriber_worker.spec \
  --distpath build/dist --workpath build/work
rm -rf "$ROOT/app/resources/worker"
cp -R build/dist/transcriber-worker "$ROOT/app/resources/worker"
echo "worker empacotado em app/resources/worker"
