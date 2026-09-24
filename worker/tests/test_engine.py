import sys
import types
from functools import partial
from pathlib import Path
from typing import Any, cast

import numpy as np
import pytest

from tests.fakes import FakeCppModel, FakeModel, seg
from transcriber_worker.engine import Engine, local_model_factory, named_model_factory
from transcriber_worker.errors import ErrorCode, WorkerError
from transcriber_worker.protocol import LoadModelParams
from transcriber_worker.whispercpp import run_whispercpp

CPU = LoadModelParams(model_dir="/m/medium", device="cpu", compute_type="int8")
CUDA = LoadModelParams(
    model_dir="/m/medium", device="cuda", compute_type="float16", cuda_lib_dir="/c"
)
CPP_GPU = LoadModelParams(model_dir="/m/ggml/medium", device="gpu", engine="whisper-cpp")
CPP_CPU = LoadModelParams(model_dir="/m/ggml/medium", device="cpu", engine="whisper-cpp")


class CppFactorySpy:
    def __init__(self, error: BaseException | None = None) -> None:
        self.calls: list[tuple[str, str]] = []
        self.error = error

    def __call__(self, model_dir: str, device: str) -> Any:
        self.calls.append((model_dir, device))
        if self.error is not None:
            raise self.error
        return FakeCppModel([(0.0, 1.0, "oi")])


class FactorySpy:
    def __init__(self, error: BaseException | None = None) -> None:
        self.calls: list[tuple[str, str, str]] = []
        self.error = error

    def __call__(self, model_dir: str, device: str, compute_type: str) -> Any:
        self.calls.append((model_dir, device, compute_type))
        if self.error is not None:
            raise self.error
        return object()


def test_model_before_load_raises() -> None:
    with pytest.raises(WorkerError) as info:
        _ = Engine(factory=FactorySpy()).model
    assert info.value.code is ErrorCode.MODEL_NOT_LOADED


def test_load_cpu_does_not_prepare_cuda() -> None:
    factory, prepared = FactorySpy(), list[str | None]()
    engine = Engine(factory=factory, prepare=prepared.append)
    assert engine.load(CPU) is True
    assert factory.calls == [("/m/medium", "cpu", "int8")]
    assert prepared == []
    assert engine.model is not None


def test_load_same_params_is_noop() -> None:
    factory = FactorySpy()
    engine = Engine(factory=factory, prepare=lambda _: None)
    engine.load(CPU)
    assert engine.load(CPU) is False
    assert len(factory.calls) == 1


def test_load_cuda_prepares_libraries() -> None:
    prepared: list[str | None] = []
    Engine(factory=FactorySpy(), prepare=prepared.append).load(CUDA)
    assert prepared == ["/c"]


@pytest.mark.parametrize(
    ("params", "error", "code"),
    [
        (CPU, RuntimeError("boom"), ErrorCode.MODEL_LOAD_FAILED),
        (CUDA, RuntimeError("boom"), ErrorCode.CUDA_FAILED),
        (CPU, MemoryError(), ErrorCode.OUT_OF_MEMORY),
    ],
)
def test_load_failure_is_classified(
    params: LoadModelParams, error: BaseException, code: ErrorCode
) -> None:
    engine = Engine(factory=FactorySpy(error), prepare=lambda _: None)
    with pytest.raises(WorkerError) as info:
        engine.load(params)
    assert info.value.code is code


def test_failed_load_unloads_previous_model() -> None:
    good = FactorySpy()
    engine = Engine(factory=good, prepare=lambda _: None)
    engine.load(CPU)
    engine._factory = FactorySpy(RuntimeError("boom"))  # troca para simular falha no próximo load
    with pytest.raises(WorkerError):
        engine.load(CUDA)
    with pytest.raises(WorkerError) as info:
        _ = engine.model
    assert info.value.code is ErrorCode.MODEL_NOT_LOADED


def _fake_faster_whisper(monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, dict[str, Any]]]:
    calls: list[tuple[str, dict[str, Any]]] = []

    def whisper_model(model_dir: str, **kwargs: Any) -> str:
        calls.append((model_dir, kwargs))
        return "modelo"

    fake = types.ModuleType("faster_whisper")
    fake.WhisperModel = whisper_model  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "faster_whisper", fake)
    return calls


def test_named_factory_accepts_model_names(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = _fake_faster_whisper(monkeypatch)
    assert cast(object, named_model_factory("medium", "cpu", "int8")) == "modelo"
    assert calls == [("medium", {"device": "cpu", "compute_type": "int8"})]


def test_local_factory_never_downloads(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    calls = _fake_faster_whisper(monkeypatch)
    assert cast(object, local_model_factory(str(tmp_path), "cpu", "int8")) == "modelo"
    assert calls == [
        (str(tmp_path), {"device": "cpu", "compute_type": "int8", "local_files_only": True})
    ]


def test_local_factory_rejects_missing_dir_or_model_name(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    calls = _fake_faster_whisper(monkeypatch)
    for model_dir in ("tiny", str(tmp_path / "apagado")):
        with pytest.raises(WorkerError) as info:
            local_model_factory(model_dir, "cpu", "int8")
        assert info.value.code is ErrorCode.MODEL_LOAD_FAILED
    assert calls == []


def test_engine_defaults_to_local_factory() -> None:
    with pytest.raises(WorkerError) as info:
        Engine(prepare=lambda _: None).load(
            LoadModelParams(model_dir="tiny", device="cpu", compute_type="int8")
        )
    assert info.value.code is ErrorCode.MODEL_LOAD_FAILED


def test_whisper_cpp_load_uses_cpp_factory_and_never_prepares_cuda() -> None:
    cpp, prepared = CppFactorySpy(), list[str | None]()
    engine = Engine(factory=FactorySpy(), cpp_factory=cpp, prepare=prepared.append)
    assert engine.load(CPP_GPU) is True
    assert engine.load(CPP_GPU) is False
    assert engine.load(CPP_CPU) is True
    assert cpp.calls == [("/m/ggml/medium", "gpu"), ("/m/ggml/medium", "cpu")]
    assert prepared == []


@pytest.mark.parametrize(
    ("params", "code"), [(CPP_GPU, ErrorCode.GPU_FAILED), (CPP_CPU, ErrorCode.MODEL_LOAD_FAILED)]
)
def test_whisper_cpp_load_failure_is_classified(params: LoadModelParams, code: ErrorCode) -> None:
    engine = Engine(cpp_factory=CppFactorySpy(RuntimeError("boom")), prepare=lambda _: None)
    with pytest.raises(WorkerError) as info:
        engine.load(params)
    assert info.value.code is code


def test_transcribe_delegates_to_the_loaded_engine() -> None:
    engine = Engine(
        factory=lambda *_: FakeModel([seg(0, 1, "fw")], duration=1.0),
        cpp_factory=CppFactorySpy(),
        prepare=lambda _: None,
        transcribe_cpp=partial(run_whispercpp, decode=lambda _: np.zeros(16000, np.float32)),
    )
    texts: list[str] = []

    def collect(event: Any) -> None:
        if event["type"] == "segment":
            texts.append(event["text"])

    engine.load(CPU)
    engine.transcribe("/v", "pt", "j", collect)
    engine.load(CPP_GPU)
    result = engine.transcribe("/v", "pt", "j", collect)
    assert texts == ["fw", "oi"]
    assert result.duration == 1.0


def test_transcribe_without_model_raises() -> None:
    with pytest.raises(WorkerError) as info:
        Engine().transcribe("/v", None, "j", lambda _: None)
    assert info.value.code is ErrorCode.MODEL_NOT_LOADED


def test_engine_defaults_to_local_cpp_factory(tmp_path: Path) -> None:
    with pytest.raises(WorkerError) as info:
        Engine(prepare=lambda _: None).load(
            LoadModelParams(model_dir=str(tmp_path), device="cpu", engine="whisper-cpp")
        )
    assert info.value.code is ErrorCode.MODEL_LOAD_FAILED


@pytest.mark.parametrize(
    ("params", "code"), [(CPP_GPU, ErrorCode.GPU_FAILED), (CPP_CPU, ErrorCode.INTERNAL)]
)
def test_whisper_cpp_runtime_gpu_errors_are_classified_by_device(
    params: LoadModelParams, code: ErrorCode
) -> None:
    def lost(*_: Any, **__: Any) -> Any:
        raise RuntimeError("ggml_vulkan: vk::Queue::submit: ErrorDeviceLost")

    engine = Engine(cpp_factory=CppFactorySpy(), prepare=lambda _: None, transcribe_cpp=lost)
    engine.load(params)
    with pytest.raises(WorkerError) as info:
        engine.transcribe("/v", "pt", "j", lambda _: None)
    assert info.value.code is code


def test_transcribe_array_faster_whisper() -> None:
    model = FakeModel([seg(0.0, 1.2, " oi"), seg(1.2, 2.0, "tudo bem")])
    engine = Engine(factory=lambda *_: model, prepare=lambda _: None)
    engine.load(CPU)
    audio = np.zeros(32000, np.float32)
    assert engine.transcribe_array(audio, "pt") == [(0.0, 1.2, " oi"), (1.2, 2.0, "tudo bem")]
    got_audio, kwargs = model.calls[0]
    assert got_audio is audio
    assert kwargs["language"] == "pt"
    assert kwargs["vad_filter"] is False  # o recorte já foi feito pelo ao vivo


def test_transcribe_array_whisper_cpp_e_erro_de_gpu() -> None:
    cpp = FakeCppModel([(0.0, 1.0, "olá")])
    engine = Engine(cpp_factory=lambda *_: cpp, prepare=lambda _: None)
    engine.load(CPP_GPU)
    assert engine.transcribe_array(np.zeros(16000, np.float32), None) == [(0.0, 1.0, "olá")]

    class Broken(FakeCppModel):
        def transcribe(self, audio: Any, language: str | None, on_segment: Any) -> str | None:
            raise RuntimeError("ggml_vulkan: device lost")

    engine = Engine(cpp_factory=lambda *_: Broken([]), prepare=lambda _: None)
    engine.load(CPP_GPU)
    with pytest.raises(WorkerError) as info:
        engine.transcribe_array(np.zeros(16000, np.float32), None)
    assert info.value.code is ErrorCode.GPU_FAILED


def test_transcribe_array_sem_modelo() -> None:
    with pytest.raises(WorkerError) as info:
        Engine().transcribe_array(np.zeros(1, np.float32), None)
    assert info.value.code is ErrorCode.MODEL_NOT_LOADED
