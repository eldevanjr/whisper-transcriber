"""Gera transcriber_worker/assets/self_test.wav (2 s, 16 kHz, mono). Rode uma vez e versione."""

import math
from pathlib import Path

import av
import numpy as np

RATE = 16000
SECONDS = 2.0
TARGET = Path(__file__).parents[1] / "transcriber_worker" / "assets" / "self_test.wav"


def main() -> None:
    TARGET.parent.mkdir(parents=True, exist_ok=True)
    t = np.arange(int(RATE * SECONDS)) / RATE
    data = (np.sin(2 * math.pi * 440 * t) * 3000).astype(np.int16).reshape(1, -1)
    with av.open(str(TARGET), "w", format="wav") as dst:
        stream = dst.add_stream("pcm_s16le", rate=RATE, layout="mono")
        frame = av.AudioFrame.from_ndarray(data, format="s16", layout="mono")
        frame.sample_rate = RATE
        for packet in stream.encode(frame):
            dst.mux(packet)
        for packet in stream.encode(None):
            dst.mux(packet)


if __name__ == "__main__":
    main()
