from collections.abc import Callable

import numpy as np
import pytest

from transcriber_worker.live.segmenter import PAD_WINDOWS, WINDOW, LiveSegmenter

STEP = WINDOW / 16000  # 32 ms por janela
PAD = PAD_WINDOWS * STEP


def fake_vad(
    pattern: str,
) -> Callable[
    [np.ndarray], list[float]
]:  # "S" = fala, "_" = silêncio, uma letra por janela de 32 ms
    it = iter(pattern)

    def vad(pcm: np.ndarray) -> list[float]:
        return [0.9 if next(it, "_") == "S" else 0.1 for _ in range(len(pcm) // WINDOW)]

    return vad


def windows(n: int) -> np.ndarray:
    return np.zeros(n * WINDOW, dtype=np.float32)


def test_corta_na_pausa_configurada() -> None:
    # 1 s de fala (31 janelas) + 1 s de silêncio (32) → um trecho com margem nas duas pontas
    seg = LiveSegmenter("voce", pause_s=1.0, vad=fake_vad("S" * 31 + "_" * 32))
    chunks = seg.push(windows(63))
    assert len(chunks) == 1
    assert chunks[0].track == "voce"
    assert chunks[0].start == pytest.approx(0.0)
    assert chunks[0].end == pytest.approx(31 * STEP + PAD)
    assert len(chunks[0].audio) == round((chunks[0].end - chunks[0].start) * 16000)
    assert seg.listening is False


def test_pausa_curta_nao_corta() -> None:
    seg = LiveSegmenter("voce", pause_s=1.0, vad=fake_vad("S" * 20 + "_" * 15 + "S" * 20))
    assert seg.push(windows(55)) == []
    assert seg.listening is True


def test_silencio_nao_gera_trecho() -> None:
    seg = LiveSegmenter("outros", pause_s=0.5, vad=fake_vad("_" * 200))
    assert seg.push(windows(200)) == []
    assert seg.flush() == []


def test_teto_de_25s_corta_no_vale_de_energia() -> None:
    audio = np.full(800 * WINDOW, 0.5, dtype=np.float32)  # ~25,6 s de "fala" alta
    valley = int(23.0 * 16000)
    audio[valley : valley + WINDOW] = 0.0  # vale em ~23 s
    seg = LiveSegmenter("voce", pause_s=1.0, vad=fake_vad("S" * 800))
    chunks = seg.push(audio)
    assert len(chunks) == 1
    assert chunks[0].end == pytest.approx(23.0, abs=0.05)  # no vale, não em 25 s
    assert seg.listening is True  # o resto continua como novo trecho
    [rest] = seg.flush()
    assert rest.start == pytest.approx(chunks[0].end)


def test_flush_entrega_o_que_estava_em_andamento() -> None:
    seg = LiveSegmenter("voce", pause_s=1.0, vad=fake_vad("S" * 20))
    assert seg.push(windows(20)) == []
    [chunk] = seg.flush()
    assert chunk.end == pytest.approx(20 * STEP)  # sem margem além do que já foi ouvido
    assert seg.flush() == []


def test_blocos_de_tamanho_qualquer_mantem_a_linha_do_tempo() -> None:
    seg = LiveSegmenter("voce", pause_s=0.5, vad=fake_vad("_" * 10 + "S" * 10 + "_" * 20))
    got = []
    for size in (700, 300, 5000, 200, 30 * WINDOW):  # blocos que não são múltiplos de 512
        got += seg.push(np.zeros(size, dtype=np.float32))
    assert got[0].start == pytest.approx(10 * STEP - PAD)


def test_pausa_invalida_e_recusada() -> None:
    with pytest.raises(ValueError, match="pausa"):
        LiveSegmenter("voce", pause_s=0.1, vad=fake_vad(""))


def test_teto_com_a_fala_ja_acabando_nao_corta_no_silencio_final() -> None:
    # 24,6 s de fala e depois ruído baixo: o vale fica no silêncio, depois da última fala.
    # O corte vai até a fala + margem; nada de trecho "invertido" só de ruído.
    speech = int(24.6 * 16000 / WINDOW)
    total = int(27 * 16000 / WINDOW)
    audio = np.full(total * WINDOW, 0.3, dtype=np.float32)
    audio[speech * WINDOW :] = 0.001
    seg = LiveSegmenter("voce", pause_s=1.0, vad=fake_vad("S" * speech + "_" * total))
    chunks = seg.push(audio) + seg.flush()
    assert len(chunks) == 1
    assert chunks[0].start == pytest.approx(0.0)
    assert chunks[0].end == pytest.approx(speech * STEP + PAD)
    assert all(c.end > c.start for c in chunks)
