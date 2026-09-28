"""Fila de análise incremental.

Ollama lento deve apenas aumentar a fila; o Whisper nunca espera. A fila guarda
janelas de análise com tentativas e estados próprios.
"""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from uuid import uuid4

from pydantic import BaseModel, Field

from transcriber_worker.ai.windows import SegmentInput
from transcriber_worker.ai.workqueue import WorkQueue, now_utc


class AnalysisStatus(StrEnum):
    PENDING = "PENDING"
    PROCESSING = "PROCESSING"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"
    CANCELLED = "CANCELLED"


class AnalysisItem(BaseModel):
    """Uma janela de análise na fila."""

    id: str = Field(default_factory=lambda: uuid4().hex)
    transcription_id: str
    workspace_id: str = "default"
    start_time: float
    end_time: float
    text: str
    status: AnalysisStatus = AnalysisStatus.PENDING
    attempts: int = 0
    created_at: datetime = Field(default_factory=now_utc)
    processed_at: datetime | None = None
    error: str | None = None
    model: str | None = None
    prompt_version: str | None = None
    # Segmentos da janela (índice e tempos): viram as fontes das entidades.
    segments: list[SegmentInput] = Field(default_factory=list)
    window_index: int = 0


class AnalysisQueue(WorkQueue[AnalysisItem]):
    """Fila FIFO de itens de análise com retry limitado."""
