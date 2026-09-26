import sys
import types
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from tests.fakes import FakeCppModel
from transcriber_worker.audio import decode_pcm16k
from transcriber_worker.errors import ErrorCode, WorkerError
from transcriber_worker.events import Event
from transcriber_worker.protocol import Device
from transcriber_worker.whispercpp import (
    PyWhisperCppModel,
    find_ggml_model,
    find_speech_silero,
    local_cpp_factory,
    run_whispercpp,
)

SECONDS = 6.0
FIXTURE = Path(__file__).parent / "fixtures" / "fala-curta.wav"


def _audio(_path: str) -> Any:
    return np.zeros(int(16000 * SECONDS), dtype=np.float32)


def _whole(audio: Any) -> list[dict[str, int]]:
    return [{"start": 0, "end": len(audio)}]


class Clock:
    def __init__(self, step: float) -> None:
        self.now, self.step = 0.0, step

    def __call__(self) -> float:
        self.now += self.step
        return self.now


def test_run_emits_segments_progress_and_detected_language() -> None:
    model = FakeCppModel([(0.0, 2.0, "  Olá  "), (2.0, 2.5, "   "), (2.5, 4.0, "mundo")])
    events: list[Event] = []
    result = run_whispercpp(
        model,
        "/v.mp4",
        None,
        "job",
        events.append,
        decode=_audio,
        find_speech=_whole,
        clock=Clock(1.0),
    )
    segments = [e for e in events if e["type"] == "segment"]
    assert [(s["index"], s["text"]) for s in segments] == [(0, "Olá"), (1, "mundo")]
    progress = [e for e in events if e["type"] == "progress"]
    assert progress[-1]["pct"] == 100.0
    assert progress[0]["processed_s"] == 2.0
    assert result.duration == SECONDS
    assert result.language_detected == "pt"
    assert result.segment_count == 2
    assert model.calls == [(int(16000 * SECONDS), None)]


def test_run_throttles_progress_and_keeps_fixed_language() -> None:
    model = FakeCppModel([(0, 1, "a"), (1, 2, "b"), (2, 3, "c")], detected="en")
    events: list[Event] = []
    result = run_whispercpp(
        model,
        "/v",
        "pt",
        "j",
        events.append,
        decode=_audio,
        find_speech=_whole,
        clock=Clock(0.1),
        interval=0.25,
    )
    assert len([e for e in events if e["type"] == "progress"]) == 2  # primeiro + final
    assert result.language_detected == "pt"
    assert model.calls[0][1] == "pt"


def test_run_skips_the_model_when_vad_finds_no_speech() -> None:
    # Faixa muda (ex.: microfone sem fala na reunião): sem VAD o Whisper inventava "E aí" a
    # cada janela de 30 s.
    model = FakeCppModel([(0.0, 30.0, "E aí")])
    events: list[Event] = []
    result = run_whispercpp(
        model, "/v", "pt", "j", events.append, decode=_audio, find_speech=lambda _a: []
    )
    assert model.calls == []
    assert [e for e in events if e["type"] == "segment"] == []
    assert [e for e in events if e["type"] == "progress"][-1]["pct"] == 100.0
    assert result.segment_count == 0
    assert result.duration == SECONDS
    assert result.language_detected == "pt"


def test_run_sends_only_speech_and_restores_original_times() -> None:
    # Fala em 1 a 2 s e 4 a 5 s: o modelo recebe 2 s de áudio; os tempos voltam para o original.
    def speech(_audio: Any) -> list[dict[str, int]]:
        return [{"start": 16000, "end": 32000}, {"start": 64000, "end": 80000}]

    model = FakeCppModel([(0.0, 0.8, "um"), (1.2, 2.0, "dois")])
    events: list[Event] = []
    run_whispercpp(model, "/v", None, "j", events.append, decode=_audio, find_speech=speech)
    assert model.calls == [(32000, None)]
    segments = [(s["start"], s["end"], s["text"]) for s in events if s["type"] == "segment"]
    assert segments == [(1.0, 1.8, "um"), (4.2, 5.0, "dois")]


def test_run_without_vad_sends_the_whole_audio() -> None:
    def fail(_audio: Any) -> list[dict[str, int]]:
        raise AssertionError("VAD não deveria rodar")

    model = FakeCppModel([(2.5, 3.0, "hi")])
    events: list[Event] = []
    run_whispercpp(
        model, "/v", "en", "j", events.append, decode=_audio, vad_filter=False, find_speech=fail
    )
    assert model.calls == [(int(16000 * SECONDS), "en")]
    assert [(e["start"], e["end"]) for e in events if e["type"] == "segment"] == [(2.5, 3.0)]


def test_silero_finds_speech_only_where_someone_talks() -> None:
    assert find_speech_silero(np.zeros(16000 * 5, dtype=np.float32)) == []
    speech = find_speech_silero(decode_pcm16k(str(FIXTURE)))
    assert speech
    assert all(c["start"] < c["end"] for c in speech)


def test_find_ggml_model_in_folder_or_direct_file(tmp_path: Path) -> None:
    folder = tmp_path / "Área" / "small"
    folder.mkdir(parents=True)
    model = folder / "ggml-small.bin"
    model.write_bytes(b"x")
    (folder / ".complete").write_text("")
    assert find_ggml_model(str(folder)) == str(model)
    assert find_ggml_model(str(model)) == str(model)


@pytest.mark.parametrize("setup", ["missing", "empty", "two"])
def test_find_ggml_model_rejects_ambiguous_or_missing(tmp_path: Path, setup: str) -> None:
    folder = tmp_path / "m"
    if setup != "missing":
        folder.mkdir()
    if setup == "two":
        (folder / "ggml-a.bin").write_bytes(b"x")
        (folder / "ggml-b.bin").write_bytes(b"x")
    with pytest.raises(WorkerError) as info:
        find_ggml_model(str(folder))
    assert info.value.code is ErrorCode.MODEL_LOAD_FAILED


def _fake_pywhispercpp(
    monkeypatch: pytest.MonkeyPatch,
    lang: str = "pt",
    log: str = "whisper_backend_init_gpu: using Vulkan0 backend\n",
) -> list[dict[str, Any]]:
    created: list[dict[str, Any]] = []
    native_log = [log]

    class Segment:
        def __init__(self, t0: int, t1: int, text: str) -> None:
            self.t0, self.t1, self.text = t0, t1, text

    class Model:
        def __init__(self, path: str, **kwargs: Any) -> None:
            created.append({"path": path, **kwargs})
            self._ctx = "ctx"
            target = kwargs.get("redirect_whispercpp_logs_to")
            if isinstance(target, str):
                Path(target).write_text(native_log[0], encoding="utf-8")

        def transcribe(self, audio: Any, **kwargs: Any) -> list[Any]:
            created[-1]["transcribe"] = kwargs.copy()
            callback = kwargs["new_segment_callback"]
            callback(Segment(0, 150, " oi"))
            callback(Segment(150, 420, " tudo bem"))
            return []

    model_module = types.ModuleType("pywhispercpp.model")
    model_module.Model = Model  # type: ignore[attr-defined]
    package = types.ModuleType("pywhispercpp")
    native = types.ModuleType("_pywhispercpp")
    native.whisper_full_lang_id = lambda ctx: 7 if ctx == "ctx" else -1  # type: ignore[attr-defined]
    native.whisper_lang_str = lambda lang_id: lang if lang_id == 7 else None  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "pywhispercpp", package)
    monkeypatch.setitem(sys.modules, "pywhispercpp.model", model_module)
    monkeypatch.setitem(sys.modules, "_pywhispercpp", native)
    return created


def test_adapter_converts_centiseconds_and_reads_detected_language(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    created = _fake_pywhispercpp(monkeypatch)
    model = PyWhisperCppModel("/m/ggml-small.bin", use_gpu=True, threads=4)
    got: list[tuple[float, float, str]] = []
    detected = model.transcribe(np.zeros(10, dtype=np.float32), None, lambda *s: got.append(s))
    assert got == [(0.0, 1.5, " oi"), (1.5, 4.2, " tudo bem")]
    assert detected == "pt"
    assert created[0]["path"] == "/m/ggml-small.bin"
    assert created[0]["context_params"] == {"use_gpu": True}
    assert created[0]["n_threads"] == 4
    assert created[0]["print_progress"] is False
    assert created[0]["transcribe"]["language"] == "auto"
    model.transcribe(np.zeros(1, dtype=np.float32), "pt", lambda *_: None)
    assert created[0]["transcribe"]["language"] == "pt"


def test_local_cpp_factory_finds_model_and_picks_threads(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    created = _fake_pywhispercpp(monkeypatch)
    (tmp_path / "ggml-tiny.bin").write_bytes(b"x")
    local_cpp_factory(str(tmp_path), "cpu")
    assert created[0]["context_params"] == {"use_gpu": False}
    assert 1 <= created[0]["n_threads"] <= 8
    monkeypatch.setattr("os.cpu_count", lambda: None)
    local_cpp_factory(str(tmp_path), "gpu")
    assert created[1]["context_params"] == {"use_gpu": True}
    assert created[1]["n_threads"] == 4


def test_adapter_fails_when_whisper_cpp_finds_no_gpu(
    monkeypatch: pytest.MonkeyPatch, capfd: pytest.CaptureFixture[str]
) -> None:
    # Sem dispositivo Vulkan/Metal o whisper.cpp só loga e segue na CPU: vira GPU_FAILED.
    _fake_pywhispercpp(monkeypatch, log="whisper_backend_init_gpu: no GPU found\n")
    with pytest.raises(WorkerError) as info:
        PyWhisperCppModel("/m/ggml-small.bin", use_gpu=True, threads=4)
    assert info.value.code is ErrorCode.GPU_FAILED
    assert "no GPU found" in capfd.readouterr().err  # o log nativo continua no stderr


def test_adapter_keeps_native_logs_and_skips_the_check_on_cpu(
    monkeypatch: pytest.MonkeyPatch, capfd: pytest.CaptureFixture[str]
) -> None:
    created = _fake_pywhispercpp(monkeypatch)
    PyWhisperCppModel("/m/ggml-small.bin", use_gpu=True, threads=4)
    assert "using Vulkan0 backend" in capfd.readouterr().err
    PyWhisperCppModel("/m/ggml-small.bin", use_gpu=False, threads=4)
    assert created[1].get("redirect_whispercpp_logs_to", False) is False


@pytest.mark.parametrize("device", ["cpu", "gpu"])
def test_missing_native_engine_is_a_gpu_failure(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, device: Device
) -> None:
    # Ex.: Windows sem vulkan-1.dll ou Linux sem libvulkan.so.1 — o motor nem importa,
    # em CPU ou GPU. Não é problema do modelo (MODEL_LOAD_FAILED mandaria rebaixá-lo).
    monkeypatch.setitem(sys.modules, "pywhispercpp.model", None)
    (tmp_path / "ggml-tiny.bin").write_bytes(b"x")
    with pytest.raises(WorkerError) as info:
        local_cpp_factory(str(tmp_path), device)
    assert info.value.code is ErrorCode.GPU_FAILED
