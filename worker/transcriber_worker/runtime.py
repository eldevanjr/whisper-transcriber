"""Preparação do ambiente de execução: CPU ou CUDA (bibliotecas NVIDIA baixadas pelo app)."""

import os
import sys
from collections.abc import Callable, MutableMapping
from pathlib import Path

from transcriber_worker.errors import ErrorCode, WorkerError
from transcriber_worker.protocol import ComputeType, Device

AddDllDirectory = Callable[[str], object]

_COMPUTE_TYPES: dict[str, ComputeType] = {"cpu": "int8", "cuda": "float16"}


def compute_type_for(device: Device) -> ComputeType:
    """Só para o faster-whisper (cpu/cuda); o whisper.cpp não usa compute_type."""
    return _COMPUTE_TYPES[device]


def prepare_cuda(
    cuda_lib_dir: str | None,
    *,
    platform: str = sys.platform,
    add_dll_directory: AddDllDirectory | None = None,
    environ: MutableMapping[str, str] | None = None,
) -> list[str]:
    """Torna as DLLs NVIDIA visíveis para o ctranslate2. Retorna os diretórios registrados.

    No Linux não há o que fazer aqui: o processo principal inicia o worker com
    LD_LIBRARY_PATH apontando para as bibliotecas (o loader lê a variável só no início).
    """
    if cuda_lib_dir is None:
        return []
    root = Path(cuda_lib_dir)
    if not root.is_dir():
        raise WorkerError(ErrorCode.CUDA_UNAVAILABLE, f"Bibliotecas CUDA não encontradas: {root}")
    if platform != "win32":
        return []
    register = add_dll_directory or _os_add_dll_directory()
    dirs = sorted({str(dll.parent) for dll in root.rglob("*.dll")})
    for directory in dirs:
        register(directory)
    # O cuDNN 9 carrega as próprias sub-DLLs via LoadLibrary comum, que só consulta o PATH.
    env = os.environ if environ is None else environ
    env["PATH"] = ";".join([*dirs, env["PATH"]] if env.get("PATH") else dirs)
    return dirs


def _os_add_dll_directory() -> AddDllDirectory:
    add: AddDllDirectory = getattr(os, "add_dll_directory")  # noqa: B009 - só existe no Windows
    return add
