"""Executa o faster-whisper e converte o resultado em eventos de segmento e progresso."""

import time
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from typing import Any, Protocol

from transcriber_worker.events import Emit, progress_event, segment_event

PROGRESS_INTERVAL_S = 0.25


class WhisperLike(Protocol):
    def transcribe(self, audio: str, **kwargs: Any) -> tuple[Iterable[Any], Any]: ...


@dataclass(frozen=True)
class TranscriptionResult:
    duration: float
    language_detected: str | None
    segment_count: int


class TranscribeFn(Protocol):
    def __call__(
        self,
        model: WhisperLike,
        input_path: str,
        language: str | None,
        job_id: str,
        emit: Emit,
        *,
        vad_filter: bool = True,
    ) -> TranscriptionResult: ...


def run_transcription(
    model: WhisperLike,
    input_path: str,
    language: str | None,
    job_id: str,
    emit: Emit,
    *,
    vad_filter: bool = True,
    clock: Callable[[], float] = time.monotonic,
    interval: float = PROGRESS_INTERVAL_S,
) -> TranscriptionResult:
    # O relógio começa antes: decodificação, VAD e detecção de idioma rodam dentro do transcribe.
    started = clock()
    segments, info = model.transcribe(
        input_path, language=language, beam_size=5, vad_filter=vad_filter
    )
    duration = float(info.duration)
    last_progress = float("-inf")
    index = 0
    for segment in segments:
        text = segment.text.strip()
        if not text:
            continue
        emit(segment_event(job_id, index, segment.start, segment.end, text))
        index += 1
        now = clock()
        if now - last_progress >= interval:
            emit(progress_event(job_id, float(segment.end), duration, now - started))
            last_progress = now
    emit(progress_event(job_id, duration, duration, clock() - started))
    return TranscriptionResult(duration, info.language, index)
