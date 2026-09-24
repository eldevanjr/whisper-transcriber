import errno
from pathlib import Path

import av
import pytest
from av.error import InvalidDataError

from transcriber_worker.errors import ErrorCode, WorkerError, classify_exception


def test_worker_error_keeps_code_message_and_detail() -> None:
    error = WorkerError(ErrorCode.NO_AUDIO, "sem áudio", detail="x")
    assert error.code is ErrorCode.NO_AUDIO
    assert error.message == "sem áudio"
    assert error.detail == "x"
    assert str(error) == "sem áudio"


def test_worker_error_detail_defaults_to_none() -> None:
    assert WorkerError(ErrorCode.INTERNAL, "x").detail is None


def test_classify_returns_worker_error_unchanged() -> None:
    error = WorkerError(ErrorCode.NO_AUDIO, "x")
    assert classify_exception(error) is error


@pytest.mark.parametrize(
    ("exc", "code"),
    [
        (MemoryError(), ErrorCode.OUT_OF_MEMORY),
        (FileNotFoundError(errno.ENOENT, "No such file"), ErrorCode.FILE_NOT_FOUND),
        (OSError(errno.ENOSPC, "No space left on device"), ErrorCode.DISK_FULL),
        (RuntimeError("CUDA failed with error out of memory"), ErrorCode.OUT_OF_MEMORY),
        (RuntimeError("CUDA driver version is insufficient"), ErrorCode.CUDA_FAILED),
        (RuntimeError("Library libcublas.so.12 is not found"), ErrorCode.CUDA_FAILED),
        (RuntimeError("Could not load library cudnn_ops64_9.dll"), ErrorCode.CUDA_FAILED),
    ],
)
def test_classify_known_failures(exc: BaseException, code: ErrorCode) -> None:
    assert classify_exception(exc).code is code


@pytest.mark.parametrize(
    ("exc", "code"),
    [
        (RuntimeError("ggml_vulkan: device lost"), ErrorCode.GPU_FAILED),
        (RuntimeError("vk::DeviceLostError"), ErrorCode.GPU_FAILED),
        (RuntimeError("ggml_metal_init: error"), ErrorCode.GPU_FAILED),
        (RuntimeError("ggml_vulkan: out of memory"), ErrorCode.OUT_OF_MEMORY),
    ],
)
def test_classify_gpu_failures_only_on_the_gpu_path(exc: BaseException, code: ErrorCode) -> None:
    assert classify_exception(exc, gpu=True).code is code


def test_gpu_words_outside_the_gpu_path_are_not_gpu_failures() -> None:
    # Um arquivo em ".../Heavy Metal/" não pode virar "a GPU falhou" para quem usa a CPU.
    exc = PermissionError(13, "Permission denied", "/home/u/Músicas/Heavy Metal/x.mp3")
    assert classify_exception(exc).code is ErrorCode.INTERNAL
    assert classify_exception(RuntimeError("vulkan"), ErrorCode.MODEL_LOAD_FAILED).code is (
        ErrorCode.MODEL_LOAD_FAILED
    )


def test_classify_invalid_media(tmp_path: Path) -> None:
    bad = tmp_path / "ruim.mp4"
    bad.write_bytes(b"isto nao e midia" * 10)
    with pytest.raises(InvalidDataError) as info:
        av.open(str(bad))
    assert classify_exception(info.value).code is ErrorCode.INVALID_MEDIA


def test_classify_other_oserror_uses_fallback() -> None:
    error = classify_exception(OSError(errno.EACCES, "Permission denied"))
    assert error.code is ErrorCode.INTERNAL


def test_classify_unknown_uses_given_fallback() -> None:
    error = classify_exception(ValueError("boom"), fallback=ErrorCode.MODEL_LOAD_FAILED)
    assert error.code is ErrorCode.MODEL_LOAD_FAILED
    assert error.message == "boom"
    assert error.detail == "ValueError"


def test_classify_empty_message_uses_class_name() -> None:
    assert classify_exception(RuntimeError()).message == "RuntimeError"
