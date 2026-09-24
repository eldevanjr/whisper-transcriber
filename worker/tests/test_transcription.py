from collections.abc import Iterator
from typing import Any

import pytest

from tests.fakes import FakeModel, seg
from transcriber_worker.events import Event
from transcriber_worker.transcription import TranscriptionResult, run_transcription


def _clock(*values: float) -> Any:
    iterator = iter(values)
    return lambda: next(iterator)


def _of(events: list[Event], kind: str) -> list[Event]:
    return [event for event in events if event["type"] == kind]


def test_emits_segments_and_returns_result() -> None:
    model = FakeModel([seg(0.0, 2.0, "  Olá  "), seg(2.0, 4.0, "mundo")], duration=4.0)
    events: list[Event] = []
    result = run_transcription(model, "/v.mp4", "pt", "job-1", events.append)
    assert result == TranscriptionResult(duration=4.0, language_detected="pt", segment_count=2)
    segments = _of(events, "segment")
    assert [(s["index"], s["text"]) for s in segments] == [(0, "Olá"), (1, "mundo")]
    assert all(s["job_id"] == "job-1" for s in segments)


def test_passes_options_to_model() -> None:
    model = FakeModel([])
    run_transcription(model, "/v.mp4", None, "j", lambda _: None)
    assert model.calls == [("/v.mp4", {"language": None, "beam_size": 5, "vad_filter": True})]
    run_transcription(model, "/v.mp4", "en", "j", lambda _: None, vad_filter=False)
    assert model.calls[1][1]["vad_filter"] is False


def test_skips_empty_segments_keeping_indexes_sequential() -> None:
    model = FakeModel([seg(0, 1, "a"), seg(1, 2, "   "), seg(2, 3, "b")], duration=3.0)
    events: list[Event] = []
    result = run_transcription(model, "/v", None, "j", events.append)
    assert [(s["index"], s["text"]) for s in _of(events, "segment")] == [(0, "a"), (1, "b")]
    assert result.segment_count == 2


def test_throttles_progress_events() -> None:
    model = FakeModel([seg(0, 1, "a"), seg(1, 2, "b"), seg(2, 3, "c")], duration=6.0)
    events: list[Event] = []
    # início=0.0; segmentos em 0.1 (emite), 0.2 (não), 0.4 (emite); final em 0.5
    run_transcription(model, "/v", None, "j", events.append, clock=_clock(0.0, 0.1, 0.2, 0.4, 0.5))
    progress = _of(events, "progress")
    assert [p["processed_s"] for p in progress] == [1.0, 3.0, 6.0]
    assert progress[-1]["pct"] == 100.0


def test_no_segments_and_zero_duration_still_finishes_at_100() -> None:
    events: list[Event] = []
    result = run_transcription(FakeModel([], duration=0.0), "/v", None, "j", events.append)
    assert result.segment_count == 0
    assert _of(events, "segment") == []
    assert [p["pct"] for p in _of(events, "progress")] == [100.0]


def test_errors_during_decoding_propagate() -> None:
    def broken() -> Iterator[Any]:
        yield seg(0, 1, "a")
        raise RuntimeError("decoder quebrou")

    with pytest.raises(RuntimeError, match="decoder quebrou"):
        run_transcription(FakeModel(broken()), "/v", None, "j", lambda _: None)


def test_speed_clock_starts_before_model_call() -> None:
    # Decodificação, VAD e detecção de idioma acontecem dentro de model.transcribe().
    model = FakeModel([seg(0, 1, "a")], duration=1.0)
    observed: list[bool] = []

    def clock() -> float:
        observed.append(bool(model.calls))
        return float(len(observed))

    run_transcription(model, "/v", None, "j", lambda _: None, clock=clock)
    assert observed[0] is False
