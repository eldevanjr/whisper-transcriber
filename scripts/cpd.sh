#!/usr/bin/env bash
# Detector de código duplicado (PMD CPD). Uso: scripts/cpd.sh <python|typescript> <dir> [dir...]
set -euo pipefail

PMD_VERSION="7.9.0"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TOOLS="$ROOT/.tools"
PMD_HOME="$TOOLS/pmd-bin-$PMD_VERSION"

if [ ! -x "$PMD_HOME/bin/pmd" ]; then
  mkdir -p "$TOOLS"
  curl -sSL -o "$TOOLS/pmd.zip" \
    "https://github.com/pmd/pmd/releases/download/pmd_releases%2F$PMD_VERSION/pmd-dist-$PMD_VERSION-bin.zip"
  unzip -q -o "$TOOLS/pmd.zip" -d "$TOOLS"
  rm "$TOOLS/pmd.zip"
fi

LANGUAGE="$1"
shift
DIR_ARGS=()
for dir in "$@"; do
  DIR_ARGS+=(--dir "$dir")
done

"$PMD_HOME/bin/pmd" cpd --minimum-tokens 70 --language "$LANGUAGE" "${DIR_ARGS[@]}"
