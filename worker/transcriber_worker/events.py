"""Construtores dos eventos emitidos pelo worker (stdout, um JSON por linha)."""

from collections.abc import Callable
from typing import Any, Literal

from transcriber_worker import PROTOCOL_VERSION
from transcriber_worker.errors import WorkerError

Event = dict[str, Any]
Emit = Callable[[Event], None]
Phase = Literal["loading_model", "extracting_audio", "transcribing"]


def ready_event(version: str) -> Event:
    return {"type": "ready", "protocol": PROTOCOL_VERSION, "version": version}


def heartbeat_event() -> Event:
    return {"type": "heartbeat"}


def result_event(command_id: str, data: dict[str, Any] | None = None) -> Event:
    return {"type": "result", "id": command_id, "data": data or {}}


def error_event(
    error: WorkerError, *, command_id: str | None = None, job_id: str | None = None
) -> Event:
    event: Event = {"type": "error", "code": str(error.code), "message": error.message}
    optional = {"id": command_id, "job_id": job_id, "detail": error.detail}
    event.update({key: value for key, value in optional.items() if value is not None})
    return event


def phase_event(phase: Phase, job_id: str | None = None) -> Event:
    return {"type": "phase", "phase": phase, "job_id": job_id}


def progress_event(job_id: str, processed_s: float, total_s: float, elapsed_s: float) -> Event:
    pct = 100.0 if total_s <= 0 else min(processed_s / total_s * 100, 100.0)
    speed = processed_s / elapsed_s if elapsed_s > 0 else 0.0
    return {
        "type": "progress",
        "job_id": job_id,
        "pct": round(pct, 2),
        "processed_s": round(processed_s, 3),
        "total_s": round(total_s, 3),
        "speed": round(speed, 2),
    }


def segment_event(job_id: str, index: int, start: float, end: float, text: str) -> Event:
    return {
        "type": "segment",
        "job_id": job_id,
        "index": index,
        "start": round(start, 3),
        "end": round(end, 3),
        "text": text,
    }


def done_event(job_id: str, duration: float, language_detected: str | None) -> Event:
    return {
        "type": "done",
        "job_id": job_id,
        "duration": round(duration, 3),
        "language_detected": language_detected,
    }
