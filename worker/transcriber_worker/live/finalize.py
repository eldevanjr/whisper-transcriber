"""Fim da sessão ao vivo: cada faixa gravada (WAV 48 kHz) vira m4a, e as faixas são misturadas.

`voce.m4a` e `outros.m4a` servem para ouvir cada lado e para refazer a transcrição; `audio.m4a`
(a mistura) é o que o player toca em "Tudo". Os WAV só são apagados se tudo deu certo.
"""

import shutil
from collections.abc import Iterator
from itertools import chain
from pathlib import Path

import av
import numpy as np
from av.audio.frame import AudioFrame
from numpy.typing import NDArray

from transcriber_worker.audio import BIT_RATE, extract_audio
from transcriber_worker.errors import ErrorCode, WorkerError, classify_exception

MIX_RATE = 48000
MIX_GAIN = 0.7  # duas vozes somadas não estouram
WAV_HEADER = 44  # o cabeçalho que o app grava antes do primeiro bloco
BLOCK = MIX_RATE  # 1 s por vez: a mistura nunca carrega a sessão inteira na memória


def finalize(folder: Path, tracks: list[str]) -> dict[str, float]:
    recorded = [t for t in tracks if _has_audio(folder / f"live-{t}.wav")]
    if not recorded:
        return {}
    try:
        durations = {track: _convert(folder, track) for track in recorded}
        _mix(folder, recorded)
    except Exception as exc:
        raise classify_exception(exc) from exc
    for track in recorded:
        (folder / f"live-{track}.wav").unlink()
    return durations


def _has_audio(wav: Path) -> bool:
    """Encerrou antes do primeiro bloco: só o cabeçalho. Não há o que converter; sai do caminho."""
    if not wav.is_file():
        return False
    if wav.stat().st_size > WAV_HEADER:
        return True
    wav.unlink()
    return False


def _convert(folder: Path, track: str) -> float:
    wav = folder / f"live-{track}.wav"
    data_bytes = fix_wav_header(wav)
    extract_audio(str(wav), str(folder / f"{track}.m4a"))
    return data_bytes / (MIX_RATE * 2)


def fix_wav_header(path: Path) -> int:
    """O app grava o WAV aos poucos; se caiu antes de fechar, os tamanhos do cabeçalho ficam zero.

    Refaz o tamanho do RIFF e do bloco `data` a partir do tamanho real do arquivo; devolve os bytes
    de áudio.
    """
    size = path.stat().st_size
    with path.open("r+b") as wav:
        offset = _data_chunk(wav.read(4096))
        data_bytes = size - offset - 8
        wav.seek(4)
        wav.write((size - 8).to_bytes(4, "little"))
        wav.seek(offset + 4)
        wav.write(data_bytes.to_bytes(4, "little"))
    return data_bytes


def _data_chunk(head: bytes) -> int:
    """Posição do bloco `data` (os blocos do RIFF começam no byte 12)."""
    offset = 12
    while offset + 8 <= len(head):
        chunk, length = (
            head[offset : offset + 4],
            int.from_bytes(head[offset + 4 : offset + 8], "little"),
        )
        if chunk == b"data":
            return offset
        offset += 8 + length + (length & 1)
    raise WorkerError(ErrorCode.INVALID_MEDIA, "WAV sem bloco de áudio")


def _mix(folder: Path, tracks: list[str]) -> None:
    target = folder / "audio.m4a"
    if len(tracks) == 1:
        shutil.copyfile(folder / f"{tracks[0]}.m4a", target)
        return
    partial = target.with_name("audio.m4a.part")
    sources = [_blocks(folder / f"live-{t}.wav") for t in tracks]
    with av.open(str(partial), "w", format="mp4") as out:
        stream = out.add_stream("aac", rate=MIX_RATE, layout="mono")
        stream.bit_rate = BIT_RATE
        for block in _mixed(sources):
            frame = AudioFrame.from_ndarray(block.reshape(1, -1), format="fltp", layout="mono")
            frame.sample_rate = MIX_RATE
            for packet in stream.encode(frame):
                out.mux(packet)
        for packet in stream.encode(None):
            out.mux(packet)
    partial.replace(target)


def _mixed(sources: list[Iterator[NDArray[np.float32]]]) -> Iterator[NDArray[np.float32]]:
    active = list(sources)
    while active:
        blocks, alive = [], []
        for source in active:
            block = next(source, None)
            if block is not None:
                blocks.append(block)
                alive.append(source)
        active = alive
        if blocks:
            size = max(len(b) for b in blocks)
            total = np.zeros(size, dtype=np.float32)
            for block in blocks:
                total[: len(block)] += block
            yield np.clip(total * MIX_GAIN, -1.0, 1.0)


def _blocks(path: Path) -> Iterator[NDArray[np.float32]]:
    """PCM float32 mono a 48 kHz, em blocos de 1 s."""
    with av.open(str(path)) as source:
        resampler = av.AudioResampler(format="flt", layout="mono", rate=MIX_RATE)
        pending = np.empty(0, dtype=np.float32)
        frames = (f for d in source.decode(audio=0) for f in resampler.resample(d))
        # Sob demanda (a sessão pode ter horas); no fim, esvazia o reamostrador.
        for frame in chain(frames, resampler.resample(None)):
            pending = np.concatenate([pending, frame.to_ndarray().reshape(-1)])
            while len(pending) >= BLOCK:
                yield pending[:BLOCK]
                pending = pending[BLOCK:]
        if len(pending):
            yield pending
