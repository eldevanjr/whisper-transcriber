"""Gera mídias minúsculas para os testes (rápido, sem arquivos binários no repositório)."""

import math
import wave
from pathlib import Path

import av
import numpy as np


def make_wav(path: Path, seconds: float = 1.0, rate: int = 16000) -> Path:
    samples = int(rate * seconds)
    t = np.arange(samples) / rate
    data = (np.sin(2 * math.pi * 440 * t) * 3000).astype(np.int16).reshape(1, -1)
    with av.open(str(path), "w", format="wav") as dst:
        stream = dst.add_stream("pcm_s16le", rate=rate, layout="mono")
        frame = av.AudioFrame.from_ndarray(data, format="s16", layout="mono")
        frame.sample_rate = rate
        for packet in stream.encode(frame):
            dst.mux(packet)
        for packet in stream.encode(None):
            dst.mux(packet)
    return path


def make_video_without_audio(path: Path) -> Path:
    with av.open(str(path), "w", format="mp4") as dst:
        stream = dst.add_stream("mpeg4", rate=10)
        stream.width, stream.height, stream.pix_fmt = 32, 32, "yuv420p"
        for _ in range(5):
            image = np.zeros((32, 32, 3), dtype=np.uint8)
            for packet in stream.encode(av.VideoFrame.from_ndarray(image, format="rgb24")):
                dst.mux(packet)
        for packet in stream.encode(None):
            dst.mux(packet)
    return path


def make_empty_wav(path: Path, rate: int = 16000) -> Path:
    """WAV válido, com faixa de áudio, mas sem nenhuma amostra (duração zero)."""
    with wave.open(str(path), "wb") as dst:
        dst.setnchannels(1)
        dst.setsampwidth(2)
        dst.setframerate(rate)
        dst.writeframes(b"")
    return path
