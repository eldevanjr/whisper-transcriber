"""Backend whisper.cpp (pywhispercpp): GPU por Vulkan (Windows/Linux) ou Metal (macOS).

Emite os mesmos eventos do faster-whisper. O callback de progresso do pywhispercpp não é
confiável; o progresso vem do fim de cada trecho, como no outro backend. O VAD também é o do
faster-whisper: sem ele, trechos longos de silêncio viram texto inventado (ex.: "E aí").
"""

import os
import sys
import tempfile
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any, Protocol

import numpy as np
from numpy.typing import NDArray

from transcriber_worker.audio import PCM_RATE, decode_pcm16k
from transcriber_worker.errors import ErrorCode, WorkerError
from transcriber_worker.events import Emit, progress_event, segment_event
from transcriber_worker.protocol import Device
from transcriber_worker.transcription import PROGRESS_INTERVAL_S, TranscriptionResult

OnSegment = Callable[[float, float, str], None]
Decode = Callable[[str], NDArray[np.float32]]
# Trechos com fala, em amostras a 16 kHz: [{"start": ..., "end": ...}, ...].
FindSpeech = Callable[[NDArray[np.float32]], list[dict[str, int]]]
MAX_THREADS = 8


class WhisperCppLike(Protocol):
    def transcribe(
        self, audio: NDArray[np.float32], language: str | None, on_segment: OnSegment
    ) -> str | None: ...


class CppTranscribeFn(Protocol):
    def __call__(
        self,
        model: WhisperCppLike,
        input_path: str,
        language: str | None,
        job_id: str,
        emit: Emit,
        *,
        vad_filter: bool = True,
    ) -> TranscriptionResult: ...


NO_GPU_LOG = "no GPU found"


def _import_model() -> Any:
    # Import tardio: a biblioteca nativa (com Vulkan/Metal) só carrega quando usada. Se ela
    # nem carrega (ex.: sem vulkan-1.dll/libvulkan.so.1), o motor inteiro está indisponível.
    try:
        from pywhispercpp.model import Model
    except ImportError as exc:
        raise WorkerError(
            ErrorCode.GPU_FAILED, f"Motor whisper.cpp indisponível: {exc}", "ImportError"
        ) from exc
    return Model


class PyWhisperCppModel:
    """Adaptador fino do pywhispercpp: tempos em segundos e idioma detectado."""

    def __init__(self, path: str, *, use_gpu: bool, threads: int) -> None:
        Model = _import_model()
        options: dict[str, Any] = {
            "context_params": {"use_gpu": use_gpu},
            "n_threads": threads,
            "print_progress": False,
            "print_realtime": False,
        }
        if not use_gpu:
            self._model: Any = Model(path, **options)
            return
        # Sem dispositivo Vulkan/Metal o whisper.cpp só loga "no GPU found" e segue na CPU,
        # em silêncio. O log nativo passa por um arquivo para ser conferido (e reemitido).
        with tempfile.TemporaryDirectory() as tmp:
            log_path = os.path.join(tmp, "whisper.log")
            self._model = Model(path, redirect_whispercpp_logs_to=log_path, **options)
            log = Path(log_path).read_text(encoding="utf-8", errors="replace")
        sys.stderr.write(log)
        if NO_GPU_LOG in log:
            raise WorkerError(ErrorCode.GPU_FAILED, "Nenhuma GPU utilizável pelo whisper.cpp")

    def transcribe(
        self, audio: NDArray[np.float32], language: str | None, on_segment: OnSegment
    ) -> str | None:
        import _pywhispercpp as pw

        # O whisper.cpp marca o tempo em centésimos de segundo.
        self._model.transcribe(
            audio,
            language=language or "auto",
            new_segment_callback=lambda s: on_segment(s.t0 / 100, s.t1 / 100, s.text),
        )
        detected: str | None = pw.whisper_lang_str(pw.whisper_full_lang_id(self._model._ctx))
        return detected


def find_ggml_model(model_dir: str) -> str:
    """O app baixa um único ggml-<modelo>.bin por pasta; aceita também o caminho do arquivo."""
    path = Path(model_dir)
    if path.is_file():
        return str(path)
    candidates = sorted(path.glob("ggml-*.bin")) if path.is_dir() else []
    if len(candidates) != 1:
        raise WorkerError(ErrorCode.MODEL_LOAD_FAILED, f"Modelo GGML não encontrado: {model_dir}")
    return str(candidates[0])


def local_cpp_factory(model_dir: str, device: Device) -> WhisperCppLike:
    threads = min(os.cpu_count() or 4, MAX_THREADS)
    return PyWhisperCppModel(find_ggml_model(model_dir), use_gpu=device == "gpu", threads=threads)


def find_speech_silero(audio: NDArray[np.float32]) -> list[dict[str, int]]:
    # Mesmo Silero VAD e mesmos parâmetros do vad_filter do faster-whisper.
    from faster_whisper.vad import get_speech_timestamps

    chunks: list[dict[str, int]] = get_speech_timestamps(audio)
    return chunks


def run_whispercpp(
    model: WhisperCppLike,
    input_path: str,
    language: str | None,
    job_id: str,
    emit: Emit,
    *,
    vad_filter: bool = True,
    decode: Decode = decode_pcm16k,
    find_speech: FindSpeech = find_speech_silero,
    clock: Callable[[], float] = time.monotonic,
    interval: float = PROGRESS_INTERVAL_S,
) -> TranscriptionResult:
    started = clock()
    audio = decode(input_path)
    duration = audio.size / PCM_RATE
    index = 0
    last_progress = float("-inf")
    speech_map = None
    if vad_filter:
        from faster_whisper.vad import SpeechTimestampsMap

        chunks = find_speech(audio)
        if not chunks:  # só silêncio: o modelo nem roda, senão inventa texto
            emit(progress_event(job_id, duration, duration, clock() - started))
            return TranscriptionResult(duration, language, 0)
        # O modelo recebe só a fala, emendada; os tempos voltam para o áudio original.
        audio = np.concatenate([audio[c["start"] : c["end"]] for c in chunks])
        speech_map = SpeechTimestampsMap(chunks, PCM_RATE)

    def on_segment(start: float, end: float, raw: str) -> None:
        nonlocal index, last_progress
        text = raw.strip()
        if not text:
            return
        if speech_map is not None:
            start = speech_map.get_original_time(start)
            end = speech_map.get_original_time(end, is_end=True)
        emit(segment_event(job_id, index, start, end, text))
        index += 1
        now = clock()
        if now - last_progress >= interval:
            emit(progress_event(job_id, end, duration, now - started))
            last_progress = now

    detected = model.transcribe(audio, language, on_segment)
    emit(progress_event(job_id, duration, duration, clock() - started))
    return TranscriptionResult(duration, language or detected, index)
