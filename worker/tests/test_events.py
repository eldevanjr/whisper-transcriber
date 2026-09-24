from transcriber_worker import events
from transcriber_worker.errors import ErrorCode, WorkerError


def test_ready_event() -> None:
    assert events.ready_event("1.2.3") == {"type": "ready", "protocol": 3, "version": "1.2.3"}


def test_heartbeat_event() -> None:
    assert events.heartbeat_event() == {"type": "heartbeat"}


def test_result_event_defaults_to_empty_data() -> None:
    assert events.result_event("7") == {"type": "result", "id": "7", "data": {}}


def test_result_event_with_data() -> None:
    assert events.result_event("7", {"ok": True})["data"] == {"ok": True}


def test_error_event_minimal_omits_optional_fields() -> None:
    event = events.error_event(WorkerError(ErrorCode.INTERNAL, "falhou"))
    assert event == {"type": "error", "code": "INTERNAL", "message": "falhou"}


def test_error_event_full() -> None:
    error = WorkerError(ErrorCode.NO_AUDIO, "sem áudio", detail="det")
    event = events.error_event(error, command_id="3", job_id="job-1")
    assert event == {
        "type": "error",
        "code": "NO_AUDIO",
        "message": "sem áudio",
        "id": "3",
        "job_id": "job-1",
        "detail": "det",
    }


def test_phase_event() -> None:
    assert events.phase_event("transcribing", "job-1") == {
        "type": "phase",
        "phase": "transcribing",
        "job_id": "job-1",
    }
    assert events.phase_event("loading_model")["job_id"] is None


def test_progress_event_computes_pct_and_speed() -> None:
    event = events.progress_event("job-1", processed_s=30.0, total_s=60.0, elapsed_s=10.0)
    assert event == {
        "type": "progress",
        "job_id": "job-1",
        "pct": 50.0,
        "processed_s": 30.0,
        "total_s": 60.0,
        "speed": 3.0,
    }


def test_progress_event_clamps_pct_to_100() -> None:
    assert events.progress_event("j", 61.0, 60.0, 1.0)["pct"] == 100.0


def test_progress_event_handles_zero_total_and_zero_elapsed() -> None:
    event = events.progress_event("j", 0.0, 0.0, 0.0)
    assert event["pct"] == 100.0
    assert event["speed"] == 0.0


def test_segment_event_rounds_times() -> None:
    assert events.segment_event("j", 0, 1.23456, 2.0, "olá") == {
        "type": "segment",
        "job_id": "j",
        "index": 0,
        "start": 1.235,
        "end": 2.0,
        "text": "olá",
    }


def test_done_event() -> None:
    assert events.done_event("j", 12.3456, "pt") == {
        "type": "done",
        "job_id": "j",
        "duration": 12.346,
        "language_detected": "pt",
    }


def test_live_events() -> None:
    assert events.live_segment_event("s", "voce", 1.0, 2.5, "oi") == {
        "type": "live_segment",
        "session_id": "s",
        "track": "voce",
        "start": 1.0,
        "end": 2.5,
        "text": "oi",
    }
    assert events.live_listening_event("s", "outros", True) == {
        "type": "live_listening",
        "session_id": "s",
        "track": "outros",
        "active": True,
    }
    assert events.live_lag_event("s", 3.25) == {
        "type": "live_lag",
        "session_id": "s",
        "seconds": 3.2,
    }
    assert events.live_error_event("s", "GPU_FAILED") == {
        "type": "live_error",
        "session_id": "s",
        "code": "GPU_FAILED",
    }
