from collections.abc import Callable
from pathlib import Path
from typing import Any

import av
import pytest

from tests.fakes import FakeModel
from transcriber_worker.commands import SELF_TEST_AUDIO, Dispatcher
from transcriber_worker.engine import Engine
from transcriber_worker.errors import ErrorCode, WorkerError
from transcriber_worker.events import Emit, Event
from transcriber_worker.protocol import (
    LoadModelCommand,
    LoadModelParams,
    SelfTestCommand,
    ShutdownCommand,
    TranscribeCommand,
    TranscribeParams,
)
from transcriber_worker.transcription import TranscriptionResult, WhisperLike

LOAD = LoadModelCommand(
    id="1",
    cmd="load_model",
    params=LoadModelParams(model_dir="/m", device="cpu", compute_type="int8"),
)
TRANSCRIBE = TranscribeCommand(
    id="2",
    cmd="transcribe",
    params=TranscribeParams(
        job_id="job-1", input_path="/v.mp4", language="pt", audio_out_path="/h/job-1/audio.m4a"
    ),
)


class TranscribeSpy:
    def __init__(self, error: BaseException | None = None) -> None:
        self.calls: list[dict[str, Any]] = []
        self.error = error

    def __call__(
        self,
        model: WhisperLike,
        input_path: str,
        language: str | None,
        job_id: str,
        emit: Emit,
        *,
        vad_filter: bool = True,
    ) -> TranscriptionResult:
        self.calls.append(
            {
                "model": model,
                "input": input_path,
                "language": language,
                "job": job_id,
                "vad": vad_filter,
            }
        )
        emit({"type": "segment", "job_id": job_id})
        if self.error is not None:
            raise self.error
        return TranscriptionResult(duration=2.0, language_detected="pt", segment_count=1)


class ExtractSpy:
    def __init__(self, error: BaseException | None = None) -> None:
        self.calls: list[tuple[str, str]] = []
        self.error = error

    def __call__(
        self,
        input_path: str,
        output_path: str,
        on_progress: Callable[[float, float], None] | None = None,
    ) -> None:
        self.calls.append((input_path, output_path))
        if self.error is not None:
            raise self.error
        if on_progress is not None:
            on_progress(1.0, 2.0)
            on_progress(2.0, 2.0)


def _make(
    extract: ExtractSpy | None = None, transcribe: TranscribeSpy | None = None
) -> tuple[Dispatcher, list[Event], ExtractSpy, TranscribeSpy, FakeModel]:
    model = FakeModel([])
    events: list[Event] = []
    extract = extract or ExtractSpy()
    transcribe = transcribe or TranscribeSpy()
    engine = Engine(factory=lambda *_: model, prepare=lambda _: None, transcribe=transcribe)
    dispatcher = Dispatcher(engine, events.append, extract=extract)
    return dispatcher, events, extract, transcribe, model


def test_load_model_emits_phase_and_result() -> None:
    dispatcher, events, *_ = _make()
    assert dispatcher.handle(LOAD) is True
    assert events == [
        {"type": "phase", "phase": "loading_model", "job_id": None},
        {"type": "result", "id": "1", "data": {"loaded": True}},
    ]


def test_transcribe_without_model_fails_fast() -> None:
    dispatcher, events, extract, *_ = _make()
    assert dispatcher.handle(TRANSCRIBE) is True
    assert events[-1]["code"] == "MODEL_NOT_LOADED"
    assert events[-1]["id"] == "2"
    assert events[-1]["job_id"] == "job-1"
    assert extract.calls == []


def test_transcribe_happy_path_event_order() -> None:
    dispatcher, events, extract, transcribe, model = _make()
    dispatcher.handle(LOAD)
    events.clear()
    dispatcher.handle(TRANSCRIBE)
    assert [e["type"] if e["type"] != "phase" else e["phase"] for e in events] == [
        "extracting_audio",
        "progress",  # extração: a barra anda enquanto o vídeo vira áudio
        "progress",
        "transcribing",
        "segment",
        "done",
        "result",
    ]
    assert extract.calls == [("/v.mp4", "/h/job-1/audio.m4a")]
    assert events[2]["job_id"] == "job-1"
    assert events[2]["pct"] == 100.0
    assert events[2]["processed_s"] == 2.0
    assert transcribe.calls == [
        # transcreve do áudio extraído (só a faixa de áudio: decodifica mais rápido que o vídeo)
        {
            "model": model,
            "input": "/h/job-1/audio.m4a",
            "language": "pt",
            "job": "job-1",
            "vad": True,
        }
    ]
    assert events[-2] == {
        "type": "done",
        "job_id": "job-1",
        "duration": 2.0,
        "language_detected": "pt",
    }
    assert events[-1] == {"type": "result", "id": "2", "data": {"segments": 1}}


def test_extract_failure_reports_error_and_next_command_still_works() -> None:
    extract = ExtractSpy(WorkerError(ErrorCode.NO_AUDIO, "sem áudio"))
    dispatcher, events, *_ = _make(extract=extract)
    dispatcher.handle(LOAD)
    assert dispatcher.handle(TRANSCRIBE) is True
    assert events[-1] == {
        "type": "error",
        "code": "NO_AUDIO",
        "message": "sem áudio",
        "id": "2",
        "job_id": "job-1",
    }
    extract.error = None
    dispatcher.handle(TRANSCRIBE)
    assert events[-1]["type"] == "result"


def test_unexpected_exception_becomes_internal_error() -> None:
    dispatcher, events, *_ = _make(transcribe=TranscribeSpy(RuntimeError("boom")))
    dispatcher.handle(LOAD)
    dispatcher.handle(TRANSCRIBE)
    assert events[-1]["code"] == "INTERNAL"
    assert events[-1]["message"] == "boom"


def test_self_test_uses_bundled_audio_and_discards_events() -> None:
    transcribe = TranscribeSpy()
    dispatcher, events, *_ = _make(transcribe=transcribe)
    dispatcher.handle(LOAD)
    events.clear()
    dispatcher.handle(SelfTestCommand(id="3", cmd="self_test"))
    assert events == [{"type": "result", "id": "3", "data": {"ok": True, "duration": 2.0}}]
    assert transcribe.calls[0]["input"] == str(SELF_TEST_AUDIO)
    assert transcribe.calls[0]["language"] == "en"
    assert transcribe.calls[0]["vad"] is False


def test_self_test_asset_is_two_second_wav() -> None:
    assert SELF_TEST_AUDIO.is_file()
    with av.open(str(SELF_TEST_AUDIO)) as container:
        assert container.duration is not None
        assert container.duration / 1_000_000 == pytest.approx(2.0, abs=0.05)


def test_shutdown_returns_false() -> None:
    dispatcher, events, *_ = _make()
    assert dispatcher.handle(ShutdownCommand(id="4", cmd="shutdown")) is False
    assert events == [{"type": "result", "id": "4", "data": {}}]


def test_default_self_test_audio_path() -> None:
    assert Path(SELF_TEST_AUDIO).name == "self_test.wav"


def test_transcribe_reuses_audio_already_extracted(tmp_path: Path) -> None:
    # Cancelado e refeito: o áudio extraído antes é reaproveitado (sem extrair de novo).
    audio = tmp_path / "audio.m4a"
    audio.write_bytes(b"m4a")
    dispatcher, events, extract, transcribe, _ = _make()
    dispatcher.handle(LOAD)
    events.clear()
    params = TRANSCRIBE.params.model_copy(update={"audio_out_path": str(audio)})
    dispatcher.handle(TRANSCRIBE.model_copy(update={"params": params}))
    assert extract.calls == []
    assert transcribe.calls[0]["input"] == str(audio)
    assert [e["phase"] for e in events if e["type"] == "phase"] == ["transcribing"]
