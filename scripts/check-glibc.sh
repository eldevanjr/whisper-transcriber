#!/usr/bin/env bash
# Falha se algum binário ELF da pasta exigir glibc mais nova que o mínimo suportado
# (Ubuntu 22.04 / Debian 12 → 2.35). Uso: scripts/check-glibc.sh <pasta> [máximo]
set -euo pipefail

DIR="$1"
MAX="${2:-2.35}"
worst="0"
offenders=""
while IFS= read -r -d '' file; do
  head -c 4 "$file" | grep -q $'\x7fELF' || continue
  need=$(objdump -T "$file" 2>/dev/null | grep -o 'GLIBC_[0-9.]*' | sed 's/GLIBC_//' | sort -V | tail -1 || true)
  [ -n "$need" ] || continue
  if [ "$(printf '%s\n%s\n' "$MAX" "$need" | sort -V | tail -1)" != "$MAX" ]; then
    offenders+="  $need  ${file#"$DIR"/}"$'\n'
  fi
  worst=$(printf '%s\n%s\n' "$worst" "$need" | sort -V | tail -1)
done < <(find "$DIR" -type f \( -name '*.so*' -o -perm -u+x \) -print0)

if [ -n "$offenders" ]; then
  echo "Exigem glibc acima de $MAX:"
  printf '%s' "$offenders" | sort -V
  exit 1
fi
echo "glibc máxima exigida: $worst (limite $MAX)"
