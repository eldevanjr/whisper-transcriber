import threading
import time
from collections.abc import Callable
from typing import Any

import numpy as np
import pytest
from numpy.typing import NDArray

from transcriber_worker.errors import ErrorCode, WorkerError
from transcriber_worker.events import Event
from transcriber_worker.live.segmenter import PAD_WINDOWS, WINDOW
from transcriber_worker.live.session import BLOCK, LiveSession
from transcriber_worker.protocol import LiveStartParams

PAD = PAD_WINDOWS * WINDOW / 16000  # margem antes da fala (64 ms)


def params(**overrides: Any) -> LiveStartParams:
    base: dict[str, Any] = {
        "session_id": "s1",
        "tracks": ["voce", "outros"],
        "language": "pt",
        "pause_s": 0.5,
    }
    return LiveStartParams(**(base | overrides))


def speech_vad() -> Callable[[NDArray[np.float32]], list[float]]:
    """Fala onde o áudio tem sinal (amplitude > 0), silêncio onde é zero."""

    def vad(pcm: NDArray[np.float32]) -> list[float]:
        wins = pcm.reshape(-1, WINDOW)
        return [0.9 if float(np.abs(w).max()) > 0 else 0.1 for w in wins]

    return vad


class FakeEngine:
    def __init__(self, delay: float = 0.0, fail: list[Exception] | None = None) -> None:
        self.calls: list[int] = []
        self.delay = delay
        self.fail = list(fail or [])

    def transcribe_array(
        self, audio: NDArray[np.float32], language: str | None
    ) -> list[tuple[float, float, str]]:
        if self.fail:
            raise self.fail.pop(0)
        time.sleep(self.delay)
        self.calls.append(len(audio))
        return [(0.0, len(audio) / 16000, f"t{len(self.calls)}")]


def block(value: int) -> NDArray[np.int16]:
    return np.full(BLOCK, value, dtype=np.int16)


def feed(session: LiveSession, track: str, pattern: str, start_seq: int = 0) -> int:
    """'S' = 100 ms de fala, '_' = 100 ms de silêncio."""
    for offset, kind in enumerate(pattern):
        session.audio(track, start_seq + offset, block(3000 if kind == "S" else 0))
    return start_seq + len(pattern)


class Recorder:
    def __init__(self) -> None:
        self.events: list[Event] = []
        self.lock = threading.Lock()

    def __call__(self, event: Event) -> None:
        with self.lock:
            self.events.append(event)

    def of(self, kind: str) -> list[Event]:
        with self.lock:
            return [e for e in self.events if e["type"] == kind]


def make(
    engine: FakeEngine | None = None, **overrides: Any
) -> tuple[LiveSession, Recorder, FakeEngine]:
    rec, eng = Recorder(), engine or FakeEngine()
    return LiveSession(params(**overrides), eng, rec, vad_factory=speech_vad), rec, eng


def test_trechos_por_faixa_com_tempos_da_sessao() -> None:
    session, rec, _ = make()
    feed(session, "voce", "SSSSS" + "_" * 8)  # 0,5 s de fala e depois pausa
    feed(session, "outros", "_" * 10 + "SSS" + "_" * 8)  # fala de 1,0 s a 1,3 s
    session.stop()
    segments = rec.of("live_segment")
    assert [s["track"] for s in segments] == ["voce", "outros"]
    voce, outros = segments
    assert voce["start"] == pytest.approx(0.0, abs=0.07)
    assert outros["start"] == pytest.approx(1.0 - PAD, abs=0.04)  # linha do tempo da sessão
    assert outros["end"] > outros["start"]
    assert all(s["session_id"] == "s1" for s in segments)


def test_buraco_na_sequencia_avanca_a_linha_do_tempo() -> None:
    session, rec, _ = make()
    session.audio("voce", 0, block(0))
    session.audio("voce", 1, block(0))
    feed(session, "voce", "SSS" + "_" * 8, start_seq=3)  # o bloco 2 se perdeu
    session.stop()
    [segment] = rec.of("live_segment")
    assert segment["start"] == pytest.approx(0.3 - PAD, abs=0.04)  # 3 blocos, não 2


def test_bloco_repetido_ou_atrasado_e_ignorado() -> None:
    session, rec, _ = make()
    feed(session, "voce", "SSS" + "_" * 8)
    session.audio("voce", 2, block(3000))  # seq antiga: descartada
    session.stop()
    assert len(rec.of("live_segment")) == 1


def test_stop_espera_transcrever_todos_os_trechos() -> None:
    session, rec, eng = make(FakeEngine(delay=0.05))
    seq = 0
    for _ in range(3):
        seq = feed(session, "voce", "SS" + "_" * 7, start_seq=seq)
    assert session.stop() == 3
    assert len(rec.of("live_segment")) == 3
    assert len(eng.calls) == 3


def test_stop_entrega_a_fala_em_andamento() -> None:
    session, rec, _ = make()
    feed(session, "voce", "SSSS")  # sem pausa no fim
    assert session.stop() == 1
    assert len(rec.of("live_segment")) == 1


def test_modelo_lento_informa_o_atraso() -> None:
    session, rec, _ = make(FakeEngine(delay=0.3))
    seq = 0
    for _ in range(6):
        seq = feed(session, "voce", "SSSSSSSS" + "_" * 6, start_seq=seq)
    session.stop()
    lags = [e["seconds"] for e in rec.of("live_lag")]
    assert lags
    assert max(lags) >= 1.0


def test_ouvindo_liga_e_desliga() -> None:
    session, rec, _ = make()
    feed(session, "voce", "SSS" + "_" * 8)
    session.stop()
    states = [(e["track"], e["active"]) for e in rec.of("live_listening")]
    assert states == [("voce", True), ("voce", False)]


def test_faixa_desconhecida_e_recusada() -> None:
    session, _, _ = make(tracks=["voce"])
    with pytest.raises(WorkerError) as info:
        session.audio("outros", 0, block(0))
    assert info.value.code is ErrorCode.INVALID_MESSAGE
    session.stop()


def test_texto_vazio_nao_vira_trecho() -> None:
    class Silent(FakeEngine):
        def transcribe_array(
            self, audio: Any, language: str | None
        ) -> list[tuple[float, float, str]]:
            return [(0.0, 0.5, "   ")]

    session, rec, _ = make(Silent())
    feed(session, "voce", "SSS" + "_" * 8)
    assert session.stop() == 0
    assert rec.of("live_segment") == []


def test_falha_da_gpu_espera_o_modelo_novo_e_tenta_de_novo() -> None:
    eng = FakeEngine(fail=[WorkerError(ErrorCode.GPU_FAILED, "vulkan: device lost")])
    session, rec, _ = make(eng)
    feed(session, "voce", "SSS" + "_" * 8)
    deadline = time.monotonic() + 2
    while not rec.of("live_error") and time.monotonic() < deadline:
        time.sleep(0.01)
    assert rec.of("live_error")[0]["code"] == "GPU_FAILED"
    session.model_changed()  # o main recarregou o modelo (na CPU)
    session.stop()
    assert len(rec.of("live_segment")) == 1  # o trecho não se perdeu


def test_falha_repetida_descarta_o_trecho_e_segue() -> None:
    eng = FakeEngine(fail=[RuntimeError("boom"), RuntimeError("boom")])
    session, rec, _ = make(eng)
    feed(session, "voce", "SSS" + "_" * 8)
    time.sleep(0.05)
    session.model_changed()
    feed(session, "voce", "SSS" + "_" * 8, start_seq=11)
    session.stop()
    assert [e["code"] for e in rec.of("live_error")] == ["INTERNAL", "INTERNAL"]
    assert len(rec.of("live_segment")) == 1  # o segundo trecho passou


def test_stop_libera_a_espera_por_modelo_novo() -> None:
    eng = FakeEngine(fail=[WorkerError(ErrorCode.GPU_FAILED, "vulkan: device lost")])
    session, _, _ = make(eng)
    feed(session, "voce", "SSS" + "_" * 8)
    assert session.stop() == 0  # não fica preso esperando um load_model que não vem


def test_falha_da_gpu_durante_a_parada_nao_trava() -> None:
    release = threading.Event()

    class FailsLate(FakeEngine):
        def transcribe_array(
            self, audio: Any, language: str | None
        ) -> list[tuple[float, float, str]]:
            release.wait(2)
            raise WorkerError(ErrorCode.GPU_FAILED, "vulkan: device lost")

    session, _, _ = make(FailsLate())
    feed(session, "voce", "SSS" + "_" * 8)
    result: list[int] = []
    stopper = threading.Thread(target=lambda: result.append(session.stop()))
    stopper.start()
    time.sleep(0.05)  # a parada já começou quando a GPU falha
    release.set()
    stopper.join(timeout=2)
    assert result == [0]


def test_pausa_fecha_e_transcreve_o_trecho_em_andamento() -> None:
    session, rec, _ = make()
    seq = feed(session, "voce", "SSSS")  # frase sem pausa no fim
    session.pause()
    deadline = time.monotonic() + 2
    while not rec.of("live_segment") and time.monotonic() < deadline:
        time.sleep(0.01)
    assert len(rec.of("live_segment")) == 1  # saiu sem esperar retomar
    assert [(e["track"], e["active"]) for e in rec.of("live_listening")] == [
        ("voce", True),
        ("voce", False),
    ]
    feed(session, "voce", "SSS" + "_" * 8, start_seq=seq)  # retoma na mesma linha do tempo
    session.stop()
    second = rec.of("live_segment")[1]
    assert second["start"] == pytest.approx(0.4 - PAD, abs=0.04)
