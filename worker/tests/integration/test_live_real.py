"""Ao vivo de ponta a ponta: Silero real + modelo tiny, com fala de verdade em blocos de 100 ms.

A fala é um trecho de "O relógio de ouro", de Machado de Assis, na leitura do LibriVox (domínio
público).
"""

from pathlib import Path

import av
import numpy as np
import pytest

from transcriber_worker.commands import Dispatcher
from transcriber_worker.engine import Engine
from transcriber_worker.events import Event
from transcriber_worker.live.session import BLOCK
from transcriber_worker.protocol import LoadModelCommand, LoadModelParams, parse_command

pytestmark = [pytest.mark.integration, pytest.mark.timeout(600)]
FALA = Path(__file__).parents[1] / "fixtures" / "fala-curta.wav"


def _pcm16(path: Path) -> np.ndarray:
    with av.open(str(path)) as source:
        return np.concatenate([f.to_ndarray().reshape(-1) for f in source.decode(audio=0)])


def test_ao_vivo_transcreve_fala_real(tmp_path: Path) -> None:
    import base64
    import json

    from huggingface_hub import snapshot_download

    events: list[Event] = []
    dispatcher = Dispatcher(Engine(), events.append)
    model = str(snapshot_download("Systran/faster-whisper-tiny"))
    params = LoadModelParams(model_dir=model, device="cpu", compute_type="int8")
    dispatcher.handle(LoadModelCommand(id="load", cmd="load_model", params=params))

    def send(cmd: str, **p: object) -> None:
        dispatcher.handle(parse_command(json.dumps({"id": cmd, "cmd": cmd, "params": p})))

    send("live_start", session_id="s", tracks=["voce"], language="pt", pause_s=0.5)
    pcm = _pcm16(FALA)
    silence = np.zeros(BLOCK * 10, np.int16)  # 1 s de silêncio no fim fecha o último trecho
    audio = np.concatenate([pcm, silence])
    for seq, start in enumerate(range(0, len(audio), BLOCK)):
        block = audio[start : start + BLOCK].astype("<i2").tobytes()
        send(
            "live_audio",
            session_id="s",
            track="voce",
            seq=seq,
            pcm16_b64=base64.b64encode(block).decode(),
        )
    send("live_stop", session_id="s")

    segments = [e for e in events if e["type"] == "live_segment"]
    assert segments, [e for e in events if e["type"] in ("error", "live_error")]
    assert all(s["text"] for s in segments)
    starts = [s["start"] for s in segments]
    assert starts == sorted(starts)
    assert segments[-1]["end"] <= len(audio) / 16000 + 0.1
