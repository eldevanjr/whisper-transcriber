"""Extrai o áudio de qualquer vídeo/áudio para um .m4a pequeno (usado pelo player do histórico)."""

import time
from collections.abc import Callable, Iterable
from pathlib import Path

import av
import numpy as np
from av.audio.frame import AudioFrame
from av.audio.stream import AudioStream
from av.container import InputContainer, OutputContainer
from numpy.typing import NDArray

from transcriber_worker.errors import ErrorCode, WorkerError, classify_exception

SAMPLE_RATE = 44100
BIT_RATE = 64000
PCM_RATE = 16000  # o whisper.cpp recebe PCM float32 mono a 16 kHz
PROGRESS_INTERVAL_S = 0.5

OnProgress = Callable[[float, float], None]  # (segundos extraídos, duração total)


class _Progress:
    """Repassa o avanço da extração no máximo a cada `interval` segundos (e sempre o fim)."""

    def __init__(self, on_progress: OnProgress | None, total: float, interval: float) -> None:
        self._on_progress = on_progress
        self._total = total
        self._interval = interval
        self._last = float("-inf")
        self.position = 0.0

    def frame(self, frame: AudioFrame) -> None:
        self.position = float(frame.time or 0.0) + frame.samples / (frame.sample_rate or 1)
        now = time.monotonic()
        if self._on_progress is not None and now - self._last >= self._interval:
            self._last = now
            self._on_progress(self.position, self._total)

    def finish(self) -> None:
        if self._on_progress is not None:
            self._on_progress(self.position, self._total or self.position)


def extract_audio(
    input_path: str,
    output_path: str,
    on_progress: OnProgress | None = None,
    *,
    interval: float = PROGRESS_INTERVAL_S,
) -> None:
    target = Path(output_path)
    # Grava ao lado e renomeia no fim: se o audio.m4a existe, está inteiro (cancelar mata o
    # worker no meio, e o áudio extraído é reaproveitado ao refazer).
    partial = target.with_name(f"{target.name}.part")
    try:
        progress = _extract(input_path, partial, on_progress, interval)
        partial.replace(target)
    except Exception as exc:
        partial.unlink(missing_ok=True)
        raise classify_exception(exc) from exc
    progress.finish()


def _extract(
    input_path: str, target: Path, on_progress: OnProgress | None, interval: float
) -> _Progress:
    with av.open(input_path) as source:
        if not source.streams.audio:
            raise WorkerError(ErrorCode.NO_AUDIO, "O arquivo não tem faixa de áudio")
        stream = source.streams.audio[0]
        progress = _Progress(on_progress, _duration(source, stream), interval)
        target.parent.mkdir(parents=True, exist_ok=True)
        with av.open(str(target), "w", format="mp4") as destination:
            _transcode(source, stream, destination, progress)
    # O PyAV só cria o arquivo de saída quando há pacotes: sem arquivo = sem áudio decodificável.
    if not target.exists():
        raise WorkerError(ErrorCode.INVALID_MEDIA, "O arquivo não contém áudio decodificável")
    return progress


def _duration(source: InputContainer, stream: AudioStream) -> float:
    if stream.duration is not None and stream.time_base is not None:
        return float(stream.duration * stream.time_base)
    return (source.duration or 0) / 1_000_000


def _transcode(
    source: InputContainer, stream: AudioStream, destination: OutputContainer, progress: _Progress
) -> None:
    output = destination.add_stream("aac", rate=SAMPLE_RATE, layout="mono")
    output.bit_rate = BIT_RATE
    resampler = av.AudioResampler(format="fltp", layout="mono", rate=SAMPLE_RATE)
    for frame in source.decode(stream):
        progress.frame(frame)
        _mux(destination, output, resampler.resample(frame))
    _mux(destination, output, resampler.resample(None))
    for packet in output.encode(None):
        destination.mux(packet)


def _mux(destination: OutputContainer, output: AudioStream, frames: Iterable[AudioFrame]) -> None:
    for frame in frames:
        for packet in output.encode(frame):
            destination.mux(packet)


def decode_pcm16k(input_path: str) -> NDArray[np.float32]:
    """Decodifica qualquer vídeo/áudio para PCM float32 mono a 16 kHz (entrada do whisper.cpp)."""
    try:
        return _decode(input_path)
    except Exception as exc:
        raise classify_exception(exc) from exc


def _decode(input_path: str) -> NDArray[np.float32]:
    with av.open(input_path) as source:
        if not source.streams.audio:
            raise WorkerError(ErrorCode.NO_AUDIO, "O arquivo não tem faixa de áudio")
        resampler = av.AudioResampler(format="flt", layout="mono", rate=PCM_RATE)
        chunks = [
            frame.to_ndarray().reshape(-1)
            for decoded in source.decode(source.streams.audio[0])
            for frame in resampler.resample(decoded)
        ]
        chunks += [frame.to_ndarray().reshape(-1) for frame in resampler.resample(None)]
    if not chunks:
        raise WorkerError(ErrorCode.INVALID_MEDIA, "O arquivo não contém áudio decodificável")
    return np.concatenate(chunks).astype(np.float32, copy=False)
