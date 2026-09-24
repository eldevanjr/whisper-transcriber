import os
from pathlib import Path

import pytest

from transcriber_worker.errors import ErrorCode, WorkerError
from transcriber_worker.runtime import compute_type_for, prepare_cuda


def _fake_cuda_tree(root: Path) -> None:
    (root / "nvidia" / "cublas" / "bin").mkdir(parents=True)
    (root / "nvidia" / "cublas" / "bin" / "cublas64_12.dll").write_bytes(b"")
    (root / "nvidia" / "cudnn" / "bin").mkdir(parents=True)
    (root / "nvidia" / "cudnn" / "bin" / "cudnn64_9.dll").write_bytes(b"")
    (root / "nvidia" / "cudnn" / "include").mkdir(parents=True)
    (root / "nvidia" / "cudnn" / "include" / "cudnn.h").write_bytes(b"")


def test_prepare_cuda_without_dir_does_nothing() -> None:
    assert prepare_cuda(None) == []


def test_prepare_cuda_missing_dir_raises() -> None:
    with pytest.raises(WorkerError) as info:
        prepare_cuda("/nao/existe/cuda")
    assert info.value.code is ErrorCode.CUDA_UNAVAILABLE


def test_prepare_cuda_on_linux_relies_on_ld_library_path(tmp_path: Path) -> None:
    _fake_cuda_tree(tmp_path)
    registered: list[str] = []
    assert prepare_cuda(str(tmp_path), platform="linux", add_dll_directory=registered.append) == []
    assert registered == []


def test_prepare_cuda_on_windows_registers_dll_dirs(tmp_path: Path) -> None:
    _fake_cuda_tree(tmp_path)
    registered: list[str] = []
    dirs = prepare_cuda(str(tmp_path), platform="win32", add_dll_directory=registered.append)
    expected = sorted(
        [str(tmp_path / "nvidia" / "cublas" / "bin"), str(tmp_path / "nvidia" / "cudnn" / "bin")]
    )
    assert dirs == expected
    assert registered == expected


def test_prepare_cuda_on_windows_uses_os_add_dll_directory_by_default(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _fake_cuda_tree(tmp_path)
    registered: list[str] = []
    monkeypatch.setattr(os, "add_dll_directory", registered.append, raising=False)
    monkeypatch.setenv("PATH", "original")
    prepare_cuda(str(tmp_path), platform="win32")
    assert len(registered) == 2
    assert os.environ["PATH"].endswith(";original")


def test_compute_type_for() -> None:
    assert compute_type_for("cpu") == "int8"
    assert compute_type_for("cuda") == "float16"


def test_prepare_cuda_on_windows_prepends_dirs_to_path(tmp_path: Path) -> None:
    # O cuDNN 9 carrega suas sub-DLLs via LoadLibrary comum, que ignora add_dll_directory.
    _fake_cuda_tree(tmp_path)
    environ = {"PATH": "C:\\Windows"}
    dirs = prepare_cuda(
        str(tmp_path), platform="win32", add_dll_directory=lambda _: None, environ=environ
    )
    assert environ["PATH"] == ";".join([*dirs, "C:\\Windows"])


def test_prepare_cuda_on_windows_handles_missing_path(tmp_path: Path) -> None:
    _fake_cuda_tree(tmp_path)
    environ: dict[str, str] = {}
    dirs = prepare_cuda(
        str(tmp_path), platform="win32", add_dll_directory=lambda _: None, environ=environ
    )
    assert environ["PATH"] == ";".join(dirs)
