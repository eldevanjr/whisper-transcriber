import numpy as np

from transcriber_worker.live.segmenter import WINDOW
from transcriber_worker.live.vad import StreamingVad


def test_estado_preservado_entre_blocos() -> None:
    # 1 s de uma vez ou em 10 blocos de tamanhos quaisquer: as mesmas probabilidades.
    rng = np.random.default_rng(0)
    audio = (rng.standard_normal(16000) * 0.05).astype(np.float32)
    whole = StreamingVad().feed(audio)
    parts = StreamingVad()
    split = [p for chunk in np.array_split(audio, 10) for p in parts.feed(chunk)]
    assert len(whole) == len(split) == 16000 // WINDOW
    assert np.allclose(whole, split, atol=1e-4)


def test_silencio_tem_probabilidade_baixa() -> None:
    probs = StreamingVad().feed(np.zeros(16000, np.float32))
    assert max(probs) < 0.2


def test_sobra_menor_que_uma_janela_fica_no_buffer() -> None:
    vad = StreamingVad()
    assert vad.feed(np.zeros(WINDOW - 1, np.float32)) == []
    assert len(vad.feed(np.zeros(1, np.float32))) == 1


class FakeSession:
    """Sessão ONNX falsa: devolve a energia da janela e registra o estado recebido."""

    def __init__(self) -> None:
        self.calls: list[tuple[int, float]] = []

    def run(self, _outputs: None, feeds: dict[str, np.ndarray]) -> tuple[np.ndarray, ...]:
        batch, h = feeds["input"], feeds["h"]
        self.calls.append((batch.shape[1], float(h.sum())))
        return np.array([[float(np.abs(batch).mean())]]), h + 1, feeds["c"]


def test_sessao_injetada_recebe_contexto_e_estado() -> None:
    session = FakeSession()
    vad = StreamingVad(session)
    vad.feed(np.ones(WINDOW * 2, np.float32))
    assert session.calls == [(WINDOW + 64, 0.0), (WINDOW + 64, 128.0)]  # h avançou entre janelas
