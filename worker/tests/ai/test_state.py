from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from transcriber_worker.ai import store as store_module
from transcriber_worker.ai.entities import AnalysisResult, Topic
from transcriber_worker.ai.queue import AnalysisItem, AnalysisQueue, AnalysisStatus
from transcriber_worker.ai.state import (
    AnalysisState,
    SQLiteQueueJournal,
    TranscriptionRecord,
)
from transcriber_worker.ai.store import SCHEMA_VERSION, SQLiteStore
from transcriber_worker.ai.windows import SegmentInput

SEGMENTS = [SegmentInput(index=0, start=0.0, end=5.0, text="oi")]


def _item(transcription_id: str = "t", start: float = 0.0) -> AnalysisItem:
    return AnalysisItem(
        transcription_id=transcription_id, start_time=start, end_time=start + 1.0, text="x"
    )


def test_schema_version_is_recorded(tmp_path: Path) -> None:
    path = str(tmp_path / "ai.sqlite")
    SQLiteStore(path).close()
    with sqlite3.connect(path) as conn:
        (version,) = conn.execute("SELECT version FROM schema_version").fetchone()
    assert version == SCHEMA_VERSION
    SQLiteStore(path).close()  # reabrir não repete migrações


def test_old_database_without_version_is_migrated(tmp_path: Path) -> None:
    path = str(tmp_path / "ai.sqlite")
    with sqlite3.connect(path) as conn:
        conn.execute(
            "CREATE TABLE vectors (workspace_id TEXT NOT NULL, chunk_id TEXT NOT NULL,"
            " vector TEXT NOT NULL, metadata TEXT NOT NULL DEFAULT '{}',"
            " PRIMARY KEY (workspace_id, chunk_id))"
        )
    store = SQLiteStore(path)
    with store.locked() as conn:
        columns = {row["name"] for row in conn.execute("PRAGMA table_info(vectors)")}
    store.close()
    assert {"embedding_model", "embedding_dimension"} <= columns


def test_journal_survives_reopen_in_order(tmp_path: Path) -> None:
    path = str(tmp_path / "ai.sqlite")
    store = SQLiteStore(path)
    queue = AnalysisQueue(journal=SQLiteQueueJournal(store, "analysis", AnalysisItem))
    first = queue.enqueue(_item(start=0.0))
    second = queue.enqueue(_item(start=1.0))
    queue.dequeue()  # o primeiro fica "em processamento" quando o app fecha
    store.close()

    reopened = SQLiteStore(path)
    restored = AnalysisQueue(journal=SQLiteQueueJournal(reopened, "analysis", AnalysisItem))
    items = restored.items()
    assert [item.id for item in items] == [first.id, second.id]
    assert {item.status for item in items} == {AnalysisStatus.PENDING}
    reopened.close()


def test_journal_isolated_by_queue_name() -> None:
    store = SQLiteStore()
    analysis = SQLiteQueueJournal(store, "analysis", AnalysisItem)
    other = SQLiteQueueJournal(store, "other", AnalysisItem)
    analysis.save(_item())
    assert other.load() == []
    analysis.remove([])  # nada a remover não falha


def test_transcription_record_roundtrip_and_replace() -> None:
    state = AnalysisState(SQLiteStore())
    assert state.get("t") is None
    state.open(TranscriptionRecord(transcription_id="t", workspace_id="ws", title="Reunião"))
    state.append_segments("t", SEGMENTS)
    state.set_windows("t", 2)
    state.close_transcription("t")
    record = state.get("t")
    assert record is not None
    assert record.segments == SEGMENTS
    assert record.windows == 2
    assert record.closed is True
    assert record.finalized is False

    state.open(TranscriptionRecord(transcription_id="t", workspace_id="ws2", title="Nova"))
    replaced = state.get("t")
    assert replaced is not None
    assert replaced.workspace_id == "ws2"
    assert replaced.segments == []
    assert replaced.closed is False


def test_partials_and_finalization() -> None:
    state = AnalysisState(SQLiteStore())
    state.open(TranscriptionRecord(transcription_id="t", workspace_id="ws", title="R"))
    state.add_partial("t", "b", 10.0, AnalysisResult(topics=[Topic(name="B")]))
    state.add_partial("t", "a", 0.0, AnalysisResult(topics=[Topic(name="A")]))
    assert [result.topics[0].name for result in state.partials("t")] == ["A", "B"]

    state.close_transcription("t")
    assert [record.transcription_id for record in state.awaiting_finalization()] == ["t"]
    state.mark_finalized("t")
    assert state.awaiting_finalization() == []

    state.delete("t")
    assert state.get("t") is None
    assert state.partials("t") == []


def test_open_clears_previous_partials() -> None:
    state = AnalysisState(SQLiteStore())
    state.open(TranscriptionRecord(transcription_id="t", workspace_id="ws", title="R"))
    state.add_partial("t", "a", 0.0, AnalysisResult())
    state.open(TranscriptionRecord(transcription_id="t", workspace_id="ws", title="R"))
    assert state.partials("t") == []


def test_unknown_transcription_updates_are_ignored() -> None:
    state = AnalysisState(SQLiteStore())
    state.append_segments("x", SEGMENTS)
    state.set_windows("x", 1)
    state.close_transcription("x")
    state.mark_finalized("x")
    assert state.get("x") is None


def test_migration_tolerates_existing_columns(tmp_path: Path) -> None:
    path = str(tmp_path / "ai.sqlite")
    with sqlite3.connect(path) as conn:  # base de uma versão de desenvolvimento sem controle
        conn.execute(
            "CREATE TABLE vectors (workspace_id TEXT NOT NULL, chunk_id TEXT NOT NULL,"
            " vector TEXT NOT NULL, metadata TEXT NOT NULL DEFAULT '{}', embedding_model TEXT,"
            " PRIMARY KEY (workspace_id, chunk_id))"
        )
    SQLiteStore(path).close()


def test_migration_errors_are_not_swallowed(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(store_module, "_MIGRATIONS", ("CREATE TABLE quebrada (",))
    with pytest.raises(sqlite3.OperationalError):
        SQLiteStore()
