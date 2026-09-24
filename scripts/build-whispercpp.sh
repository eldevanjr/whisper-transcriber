#!/usr/bin/env bash
# Compila o wheel do pywhispercpp com aceleração por GPU:
#   Linux → Vulkan (precisa de libvulkan-dev, glslc e spirv-headers, ou do Vulkan SDK em $VULKAN_SDK)
#   macOS → Metal (biblioteca de shaders embutida)
# Estático e PIC: um único módulo nativo, fácil de empacotar com o PyInstaller.
# Uso: scripts/build-whispercpp.sh [pasta-de-saída]   (EXTRA_CMAKE_ARGS para ajustes locais)
set -euo pipefail

VERSION="1.5.1"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$ROOT/dist/whispercpp}"

case "$(uname -s)" in
  # Sem -march/-mcpu=native: o binário não pode herdar extensões da CPU do runner (AVX-512,
  # i8mm do M2+), senão cai com SIGILL em máquinas mais antigas.
  Linux) GPU_FLAGS="-DGGML_VULKAN=ON -DGGML_NATIVE=OFF -DGGML_AVX=ON -DGGML_AVX2=ON -DGGML_FMA=ON -DGGML_F16C=ON" ;;
  Darwin) GPU_FLAGS="-DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON -DGGML_NATIVE=OFF -DGGML_CPU_ARM_ARCH=armv8.2-a+dotprod+fp16" ;;
  *) echo "Sistema não suportado: $(uname -s)" >&2; exit 1 ;;
esac
if [ -n "${VULKAN_SDK:-}" ]; then
  export PATH="$VULKAN_SDK/bin:$PATH"
fi

export GGML_VULKAN=$([ "$(uname -s)" = Linux ] && echo 1 || echo 0)
export CMAKE_ARGS="$GPU_FLAGS -DBUILD_SHARED_LIBS=OFF -DCMAKE_POSITION_INDEPENDENT_CODE=ON ${EXTRA_CMAKE_ARGS:-}"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"  # absoluto: o pip roda dentro de worker/
cd "$ROOT/worker"
uv run --with pip python -m pip wheel --no-deps --no-binary pywhispercpp \
  "pywhispercpp==$VERSION" -w "$OUT"
ls -la "$OUT"
