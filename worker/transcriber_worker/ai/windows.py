"""Agrupamento de segmentos de transcrição em janelas com overlap.

Base da análise incremental: em vez de mandar a transcrição inteira ao modelo,
processa-se uma janela deslizante de tempo sobre os segmentos.
"""

from __future__ import annotations

from collections.abc import Sequence
from uuid import uuid4

from pydantic import BaseModel, Field


class SegmentInput(BaseModel):
    """Segmento de transcrição (índice, timestamps em segundos e texto)."""

    index: int
    start: float
    end: float
    text: str


class SegmentWindow(BaseModel):
    """Janela de análise sobre um conjunto de segmentos."""

    id: str = Field(default_factory=lambda: uuid4().hex)
    transcription_id: str
    index: int
    start: float
    end: float
    text: str
    segment_indices: list[int] = Field(default_factory=list)


def build_windows(
    segments: Sequence[SegmentInput],
    *,
    transcription_id: str,
    window_seconds: float,
    overlap_seconds: float,
) -> list[SegmentWindow]:
    """Constrói janelas de ``window_seconds`` avançando ``window_seconds - overlap``.

    Um segmento entra em toda janela cujo intervalo de tempo ele intersecta, o
    que dá o overlap de contexto desejado.
    """
    step = window_seconds - overlap_seconds
    if step <= 0:
        raise ValueError("overlap_seconds deve ser menor que window_seconds")
    if not segments:
        return []
    ordered = sorted(segments, key=lambda segment: (segment.start, segment.index))
    last_end = max(segment.end for segment in ordered)
    windows: list[SegmentWindow] = []
    start = ordered[0].start
    index = 0
    while start < last_end:
        end = min(start + window_seconds, last_end)
        members = [seg for seg in ordered if seg.start < end and seg.end > start]
        if members:
            windows.append(
                SegmentWindow(
                    transcription_id=transcription_id,
                    index=index,
                    start=start,
                    end=end,
                    text=" ".join(seg.text for seg in members).strip(),
                    segment_indices=[seg.index for seg in members],
                )
            )
            index += 1
        start += step
    return windows
