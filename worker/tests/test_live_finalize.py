from pathlib import Path

import av
import numpy as np
import pytest

from tests.media import make_wav
from transcriber_worker.errors import WorkerError
from transcriber_worker.live.finalize import finalize


def duration(path: Path) -> float:
    with av.open(str(path)) as container:
        assert container.duration is not None
        return container.duration / 1_000_000


def live_wav(folder: Path, track: str, seconds: float, *, broken_header: bool = False) -> Path:
    path = make_wav(folder / f"live-{track}.wav", seconds=seconds, rate=48000)
    if broken_header:  # o app caiu: o cabeçalho ficou com tamanho zero
        data = bytearray(path.read_bytes())
        at = data.index(b"data")
        data[4:8] = (0).to_bytes(4, "little")
        data[at + 4 : at + 8] = (0).to_bytes(4, "little")
        path.write_bytes(bytes(data))
    return path


def header_only(folder: Path, track: str) -> Path:
    """O que o app grava ao abrir a faixa: 44 bytes de cabeçalho e nenhum bloco."""
    path = folder / f"live-{track}.wav"
    path.write_bytes(make_wav(folder / "base.wav", seconds=0.01, rate=48000).read_bytes()[:44])
    return path


def test_duas_faixas_viram_m4a_e_mistura_com_a_duracao_da_maior(tmp_path: Path) -> None:
    live_wav(tmp_path, "voce", 1.0)
    live_wav(tmp_path, "outros", 2.0)
    durations = finalize(tmp_path, ["voce", "outros"])
    assert durations == pytest.approx({"voce": 1.0, "outros": 2.0}, abs=0.1)
    assert duration(tmp_path / "voce.m4a") == pytest.approx(1.0, abs=0.1)
    assert duration(tmp_path / "audio.m4a") == pytest.approx(2.0, abs=0.1)
    assert not list(tmp_path.glob("live-*.wav"))  # WAV temporários apagados


def test_cabecalho_de_wav_interrompido_e_corrigido(tmp_path: Path) -> None:
    live_wav(tmp_path, "voce", 1.5, broken_header=True)
    durations = finalize(tmp_path, ["voce"])
    assert durations["voce"] == pytest.approx(1.5, abs=0.1)
    assert duration(tmp_path / "audio.m4a") == pytest.approx(1.5, abs=0.1)


def test_faixa_sem_gravacao_e_ignorada(tmp_path: Path) -> None:
    live_wav(tmp_path, "voce", 1.0)
    assert set(finalize(tmp_path, ["voce", "outros"])) == {"voce"}
    assert not (tmp_path / "outros.m4a").exists()


def test_falha_mantem_os_wav(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    live_wav(tmp_path, "voce", 1.0)

    def boom(*_: object, **__: object) -> None:
        raise OSError(28, "No space left on device")

    monkeypatch.setattr("transcriber_worker.live.finalize.extract_audio", boom)
    with pytest.raises(WorkerError):
        finalize(tmp_path, ["voce"])
    assert (tmp_path / "live-voce.wav").exists()


def test_mistura_soma_as_faixas_sem_estourar(tmp_path: Path) -> None:
    live_wav(tmp_path, "voce", 1.0)
    live_wav(tmp_path, "outros", 1.0)
    finalize(tmp_path, ["voce", "outros"])
    with av.open(str(tmp_path / "audio.m4a")) as container:
        samples = np.concatenate([f.to_ndarray().reshape(-1) for f in container.decode(audio=0)])
    assert float(np.abs(samples).max()) <= 1.0
    assert float(np.abs(samples).max()) > 0.1  # tem som (as duas faixas somadas)


def test_wav_sem_bloco_de_audio_e_invalido(tmp_path: Path) -> None:
    wav = tmp_path / "live-voce.wav"
    # maior que um cabeçalho, mas sem o bloco "data"
    wav.write_bytes(b"RIFF\x00\x00\x00\x00WAVEfmt \x10\x00\x00\x00" + b"\x00" * 36)
    with pytest.raises(WorkerError) as info:
        finalize(tmp_path, ["voce"])
    assert info.value.code.value == "INVALID_MEDIA"
    assert wav.exists()


def test_mistura_nao_perde_o_final_quebrado(tmp_path: Path) -> None:
    live_wav(tmp_path, "voce", 1.37)
    live_wav(tmp_path, "outros", 0.62)
    finalize(tmp_path, ["voce", "outros"])
    assert duration(tmp_path / "audio.m4a") == pytest.approx(1.37, abs=0.05)


def test_faixa_gravada_sem_nenhum_bloco_e_descartada(tmp_path: Path) -> None:
    # Encerrou (ou caiu) antes do primeiro bloco: só o cabeçalho de 44 bytes.
    live_wav(tmp_path, "voce", 1.0)
    empty = header_only(tmp_path, "outros")
    assert finalize(tmp_path, ["voce", "outros"]) == {"voce": pytest.approx(1.0, abs=0.01)}
    assert not empty.exists()
    assert (tmp_path / "audio.m4a").is_file()  # a mistura é só o microfone


def test_nenhuma_faixa_com_audio_nao_gera_arquivos(tmp_path: Path) -> None:
    empty = header_only(tmp_path, "voce")
    assert finalize(tmp_path, ["voce"]) == {}
    assert not empty.exists()
    assert not (tmp_path / "audio.m4a").exists()
