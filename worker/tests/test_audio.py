import errno
from pathlib import Path
from typing import Any

import av
import numpy as np
import pytest
from pytest_mock import MockerFixture

from tests.media import make_empty_wav, make_video_without_audio, make_wav
from transcriber_worker.audio import decode_pcm16k, extract_audio
from transcriber_worker.errors import ErrorCode, WorkerError


def _probe(path: Path) -> tuple[str, float]:
    with av.open(str(path)) as container:
        stream = container.streams.audio[0]
        assert container.duration is not None
        return stream.codec_context.name, container.duration / 1_000_000


def test_extracts_aac_m4a(tmp_path: Path) -> None:
    source = make_wav(tmp_path / "entrada.wav", seconds=1.0)
    target = tmp_path / "audio.m4a"
    extract_audio(str(source), str(target))
    codec, duration = _probe(target)
    assert codec == "aac"
    assert duration == pytest.approx(1.0, abs=0.1)


def test_extraction_reports_progress_until_the_end(tmp_path: Path) -> None:
    source = make_wav(tmp_path / "entrada.wav", seconds=3.0)
    calls: list[tuple[float, float]] = []
    extract_audio(
        str(source), str(tmp_path / "audio.m4a"), lambda p, t: calls.append((p, t)), interval=0
    )
    assert len(calls) > 2
    assert [p for p, _ in calls] == sorted(p for p, _ in calls)  # só avança
    assert calls[-1][0] == pytest.approx(3.0, abs=0.1)  # termina no fim do arquivo
    assert all(t == pytest.approx(3.0, abs=0.1) for _, t in calls)


def test_extraction_progress_is_throttled_but_always_reports_the_end(tmp_path: Path) -> None:
    source = make_wav(tmp_path / "entrada.wav", seconds=3.0)
    calls: list[tuple[float, float]] = []
    extract_audio(
        str(source), str(tmp_path / "audio.m4a"), lambda p, t: calls.append((p, t)), interval=60
    )
    assert len(calls) == 2  # o primeiro quadro e o fim
    assert calls[-1][0] == pytest.approx(3.0, abs=0.1)


def test_creates_missing_output_directory(tmp_path: Path) -> None:
    source = make_wav(tmp_path / "entrada.wav")
    target = tmp_path / "history" / "job-1" / "audio.m4a"
    extract_audio(str(source), str(target))
    assert target.is_file()


def test_accented_paths_work(tmp_path: Path) -> None:
    folder = tmp_path / "Área de Trabalho"
    folder.mkdir()
    source = make_wav(folder / "áudio de reunião.wav")
    target = folder / "saída ção.m4a"
    extract_audio(str(source), str(target))
    assert target.is_file()


def test_video_without_audio_raises_no_audio(tmp_path: Path) -> None:
    source = make_video_without_audio(tmp_path / "mudo.mp4")
    target = tmp_path / "audio.m4a"
    with pytest.raises(WorkerError) as info:
        extract_audio(str(source), str(target))
    assert info.value.code is ErrorCode.NO_AUDIO
    assert not target.exists()


def test_invalid_file_raises_invalid_media(tmp_path: Path) -> None:
    source = tmp_path / "corrompido.mp4"
    source.write_bytes(b"lixo" * 100)
    with pytest.raises(WorkerError) as info:
        extract_audio(str(source), str(tmp_path / "audio.m4a"))
    assert info.value.code is ErrorCode.INVALID_MEDIA


def test_missing_file_raises_file_not_found(tmp_path: Path) -> None:
    with pytest.raises(WorkerError) as info:
        extract_audio(str(tmp_path / "sumiu.mp4"), str(tmp_path / "audio.m4a"))
    assert info.value.code is ErrorCode.FILE_NOT_FOUND


def test_failure_midway_removes_partial_file(tmp_path: Path, mocker: MockerFixture) -> None:
    source = make_wav(tmp_path / "entrada.wav")
    target = tmp_path / "audio.m4a"
    mocker.patch(
        "transcriber_worker.audio._transcode",
        side_effect=OSError(errno.ENOSPC, "No space left on device"),
    )
    with pytest.raises(WorkerError) as info:
        extract_audio(str(source), str(target))
    assert info.value.code is ErrorCode.DISK_FULL
    assert not target.exists()


def test_audio_file_only_appears_complete(tmp_path: Path) -> None:
    # Cancelar mata o worker no meio: o audio.m4a só pode existir inteiro (é reaproveitado).
    source = make_wav(tmp_path / "entrada.wav", seconds=3.0)
    target = tmp_path / "audio.m4a"
    during: list[bool] = []
    extract_audio(str(source), str(target), lambda *_: during.append(target.exists()), interval=0)
    assert len(during) > 1
    assert not any(during[:-1])  # enquanto extrai, ainda não existe
    assert target.is_file()
    assert [p.name for p in tmp_path.iterdir() if p.name.startswith("audio")] == ["audio.m4a"]


def test_zero_length_audio_raises_invalid_media(tmp_path: Path) -> None:
    source = make_empty_wav(tmp_path / "vazio.wav")
    target = tmp_path / "audio.m4a"
    with pytest.raises(WorkerError) as info:
        extract_audio(str(source), str(target))
    assert info.value.code is ErrorCode.INVALID_MEDIA
    assert not target.exists()


def test_decode_pcm16k_returns_mono_float32_at_16khz(tmp_path: Path) -> None:
    source = make_wav(tmp_path / "áudio 44k.wav", seconds=1.5, rate=44100)
    audio = decode_pcm16k(str(source))
    assert audio.dtype == np.float32
    assert audio.ndim == 1
    assert abs(audio.size - 24000) <= 400  # 1,5 s a 16 kHz (tolerância do reamostrador)
    assert 0.0 < float(np.abs(audio).max()) <= 1.0


@pytest.mark.parametrize(
    ("make", "code"),
    [
        (lambda p: make_video_without_audio(p / "mudo.mp4"), ErrorCode.NO_AUDIO),
        (lambda p: make_empty_wav(p / "vazio.wav"), ErrorCode.INVALID_MEDIA),
    ],
)
def test_decode_pcm16k_errors(tmp_path: Path, make: Any, code: ErrorCode) -> None:
    with pytest.raises(WorkerError) as info:
        decode_pcm16k(str(make(tmp_path)))
    assert info.value.code is code


def test_decode_pcm16k_invalid_and_missing_files(tmp_path: Path) -> None:
    broken = tmp_path / "x.mp3"
    broken.write_bytes(b"isto nao e audio")
    with pytest.raises(WorkerError) as info:
        decode_pcm16k(str(broken))
    assert info.value.code is ErrorCode.INVALID_MEDIA
    with pytest.raises(WorkerError) as info:
        decode_pcm16k(str(tmp_path / "sumiu.mp3"))
    assert info.value.code is ErrorCode.FILE_NOT_FOUND
