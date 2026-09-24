"""Códigos de erro estáveis, compartilhados com o app (a interface traduz pelo código)."""

import errno
from enum import StrEnum

from av.error import InvalidDataError


class ErrorCode(StrEnum):
    INVALID_MESSAGE = "INVALID_MESSAGE"
    MODEL_NOT_LOADED = "MODEL_NOT_LOADED"
    MODEL_LOAD_FAILED = "MODEL_LOAD_FAILED"
    OUT_OF_MEMORY = "OUT_OF_MEMORY"
    CUDA_UNAVAILABLE = "CUDA_UNAVAILABLE"
    CUDA_FAILED = "CUDA_FAILED"
    GPU_FAILED = "GPU_FAILED"
    INVALID_MEDIA = "INVALID_MEDIA"
    NO_AUDIO = "NO_AUDIO"
    FILE_NOT_FOUND = "FILE_NOT_FOUND"
    DISK_FULL = "DISK_FULL"
    LIVE_NOT_STARTED = "LIVE_NOT_STARTED"
    LIVE_ACTIVE = "LIVE_ACTIVE"
    INTERNAL = "INTERNAL"


class WorkerError(Exception):
    def __init__(self, code: ErrorCode, message: str, detail: str | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.detail = detail


# A ordem importa: "CUDA ... out of memory" deve virar OUT_OF_MEMORY, não CUDA_FAILED.
_MESSAGE_RULES: tuple[tuple[str, ErrorCode], ...] = (
    ("out of memory", ErrorCode.OUT_OF_MEMORY),
    ("cuda", ErrorCode.CUDA_FAILED),
    ("cublas", ErrorCode.CUDA_FAILED),
    ("cudnn", ErrorCode.CUDA_FAILED),
)
# whisper.cpp: backends Vulkan (Windows/Linux) e Metal (macOS). Só valem no caminho da GPU:
# fora dele, "metal" num caminho como ".../Heavy Metal/x.mp3" não é falha de GPU.
_GPU_RULES: tuple[tuple[str, ErrorCode], ...] = (
    ("vulkan", ErrorCode.GPU_FAILED),
    ("vk::", ErrorCode.GPU_FAILED),
    ("metal", ErrorCode.GPU_FAILED),
)


def classify_exception(
    exc: BaseException, fallback: ErrorCode = ErrorCode.INTERNAL, *, gpu: bool = False
) -> WorkerError:
    if isinstance(exc, WorkerError):
        return exc
    code = _code_for(exc, _MESSAGE_RULES + _GPU_RULES if gpu else _MESSAGE_RULES) or fallback
    return WorkerError(code, str(exc) or type(exc).__name__, detail=type(exc).__name__)


def _code_for(exc: BaseException, rules: tuple[tuple[str, ErrorCode], ...]) -> ErrorCode | None:
    if isinstance(exc, MemoryError):
        return ErrorCode.OUT_OF_MEMORY
    if isinstance(exc, FileNotFoundError):
        return ErrorCode.FILE_NOT_FOUND
    if isinstance(exc, OSError) and exc.errno == errno.ENOSPC:
        return ErrorCode.DISK_FULL
    if isinstance(exc, InvalidDataError):
        return ErrorCode.INVALID_MEDIA
    text = str(exc).lower()
    return next((code for needle, code in rules if needle in text), None)
