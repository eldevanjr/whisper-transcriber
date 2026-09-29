"""Estado persistente da análise: journal das filas e progresso de cada transcrição.

Tudo fica no SQLite local do app (mesma conexão do conhecimento), então fechar o
app, reconfigurar a IA ou o worker cair não descarta o que estava pendente.
"""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Sequence

from pydantic import BaseModel, Field

from transcriber_worker.ai.entities import AnalysisResult
from transcriber_worker.ai.store import SQLiteStore
from transcriber_worker.ai.windows import SegmentInput


class SQLiteQueueJournal[T: BaseModel]:
    """Journal de uma fila (``name``) na tabela ``queue_items``, na ordem de chegada."""

    def __init__(self, store: SQLiteStore, name: str, model: type[T]) -> None:
        self._store = store
        self._name = name
        self._model = model

    def load(self) -> list[T]:
        with self._store.locked() as conn:
            rows = conn.execute(
                "SELECT payload FROM queue_items WHERE queue = ? ORDER BY rowid", (self._name,)
            ).fetchall()
        return [self._model.model_validate_json(row["payload"]) for row in rows]

    def save(self, item: T) -> None:
        item_id = str(getattr(item, "id"))  # noqa: B009 - QueuedItem garante o id
        with self._store.locked() as conn:
            # UPSERT preserva o rowid (a ordem da fila); INSERT OR REPLACE o trocaria.
            conn.execute(
                "INSERT INTO queue_items (queue, id, payload) VALUES (?, ?, ?)"
                " ON CONFLICT (queue, id) DO UPDATE SET payload = excluded.payload",
                (self._name, item_id, item.model_dump_json()),
            )

    def remove(self, ids: Sequence[str]) -> None:
        with self._store.locked() as conn:
            conn.executemany(
                "DELETE FROM queue_items WHERE queue = ? AND id = ?",
                [(self._name, item_id) for item_id in ids],
            )


class TranscriptionRecord(BaseModel):
    """Uma transcrição acompanhada pela IA (segmentos recebidos e etapa da análise)."""

    transcription_id: str
    workspace_id: str
    title: str
    segments: list[SegmentInput] = Field(default_factory=list)
    windows: int = 0
    closed: bool = False
    finalized: bool = False


class AnalysisState:
    """Transcrições em análise e os resultados parciais (um por janela)."""

    def __init__(self, store: SQLiteStore) -> None:
        self._store = store

    def open(self, record: TranscriptionRecord) -> None:
        """Começa (ou recomeça do zero) o acompanhamento de uma transcrição."""
        with self._store.locked() as conn:
            conn.execute(
                "DELETE FROM analysis_partials WHERE transcription_id = ?",
                (record.transcription_id,),
            )
            conn.execute(
                "INSERT OR REPLACE INTO ai_transcriptions"
                " (transcription_id, workspace_id, title, segments, windows, closed, finalized)"
                " VALUES (?, ?, ?, ?, ?, ?, ?)",
                (
                    record.transcription_id,
                    record.workspace_id,
                    record.title,
                    _segments_json(record.segments),
                    record.windows,
                    int(record.closed),
                    int(record.finalized),
                ),
            )

    def get(self, transcription_id: str) -> TranscriptionRecord | None:
        with self._store.locked() as conn:
            row = conn.execute(
                "SELECT * FROM ai_transcriptions WHERE transcription_id = ?", (transcription_id,)
            ).fetchone()
        return None if row is None else _record(row)

    def append_segments(self, transcription_id: str, segments: Sequence[SegmentInput]) -> None:
        record = self.get(transcription_id)
        if record is None:
            return
        # Reenvio (lotes, ou a transcrição inteira no fim) não duplica trechos já recebidos.
        known = {segment.index for segment in record.segments}
        merged = [
            *record.segments,
            *(segment for segment in segments if segment.index not in known),
        ]
        with self._store.locked() as conn:
            conn.execute(
                "UPDATE ai_transcriptions SET segments = ? WHERE transcription_id = ?",
                (_segments_json(merged), transcription_id),
            )

    def set_windows(self, transcription_id: str, windows: int) -> None:
        self._update(transcription_id, "windows", windows)

    def close_transcription(self, transcription_id: str) -> None:
        """A transcrição terminou: nenhum segmento novo chega; a análise final pode rodar."""
        self._update(transcription_id, "closed", 1)

    def mark_finalized(self, transcription_id: str) -> None:
        self._update(transcription_id, "finalized", 1)

    def awaiting_finalization(self) -> list[TranscriptionRecord]:
        with self._store.locked() as conn:
            rows = conn.execute(
                "SELECT * FROM ai_transcriptions WHERE closed = 1 AND finalized = 0 ORDER BY rowid"
            ).fetchall()
        return [_record(row) for row in rows]

    def add_partial(
        self, transcription_id: str, item_id: str, start: float, result: AnalysisResult
    ) -> None:
        with self._store.locked() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO analysis_partials"
                " (transcription_id, item_id, start, payload) VALUES (?, ?, ?, ?)",
                (transcription_id, item_id, start, result.model_dump_json()),
            )

    def partials(self, transcription_id: str) -> list[AnalysisResult]:
        """Resultados das janelas, na ordem do tempo (não da conclusão)."""
        with self._store.locked() as conn:
            rows = conn.execute(
                "SELECT payload FROM analysis_partials WHERE transcription_id = ?"
                " ORDER BY start, item_id",
                (transcription_id,),
            ).fetchall()
        return [AnalysisResult.model_validate_json(row["payload"]) for row in rows]

    def delete(self, transcription_id: str) -> None:
        with self._store.locked() as conn:
            conn.execute(
                "DELETE FROM analysis_partials WHERE transcription_id = ?", (transcription_id,)
            )
            conn.execute(
                "DELETE FROM ai_transcriptions WHERE transcription_id = ?", (transcription_id,)
            )

    def _update(self, transcription_id: str, column: str, value: int) -> None:
        # ``column`` vem só das chamadas acima (nunca do usuário).
        with self._store.locked() as conn:
            conn.execute(
                f"UPDATE ai_transcriptions SET {column} = ? WHERE transcription_id = ?",  # noqa: S608
                (value, transcription_id),
            )


def _segments_json(segments: Sequence[SegmentInput]) -> str:
    return json.dumps([segment.model_dump() for segment in segments])


def _record(row: sqlite3.Row) -> TranscriptionRecord:
    return TranscriptionRecord(
        transcription_id=row["transcription_id"],
        workspace_id=row["workspace_id"],
        title=row["title"],
        segments=[SegmentInput.model_validate(item) for item in json.loads(row["segments"])],
        windows=int(row["windows"]),
        closed=bool(row["closed"]),
        finalized=bool(row["finalized"]),
    )
