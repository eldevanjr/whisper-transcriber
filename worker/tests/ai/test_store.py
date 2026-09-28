from __future__ import annotations

from pathlib import Path

import pytest
from ai_core import (
    ConfigurationError,
    KnowledgeChunk,
    KnowledgeDocument,
    Source,
    SourceKind,
    WorkspaceMismatchError,
)

from transcriber_worker.ai.store import (
    SQLiteKnowledgeRepository,
    SQLiteStore,
    SQLiteVectorStore,
    create_sqlite_backend,
)


def _source(source_id: str = "s1") -> Source:
    return Source(
        id=source_id,
        type=SourceKind.TRANSCRIPT,
        title="Reunião",
        location="00:01",
        metadata={"k": 1},
    )


def _document(doc_id: str = "d1", workspace: str = "ws") -> KnowledgeDocument:
    return KnowledgeDocument(
        id=doc_id,
        workspace_id=workspace,
        source_id="s1",
        title="Doc",
        content="conteudo",
        metadata={"transcription_id": "t1"},
    )


def _chunk(
    chunk_id: str = "c1", doc_id: str = "d1", workspace: str = "ws", position: int = 0
) -> KnowledgeChunk:
    return KnowledgeChunk(
        id=chunk_id,
        document_id=doc_id,
        workspace_id=workspace,
        content="sincronização offline",
        position=position,
        metadata={"start_time": 0.0},
    )


def _backend() -> tuple[SQLiteKnowledgeRepository, SQLiteVectorStore]:
    return create_sqlite_backend()


def test_source_roundtrip() -> None:
    repository, _ = _backend()
    source = repository.add_source(_source())
    assert repository.get_source(source.id) == source
    assert repository.get_source("missing") is None


def test_document_roundtrip_and_workspace_scope() -> None:
    repository, _ = _backend()
    document = repository.add_document(_document())
    assert repository.get_document("d1", workspace_id="ws") == document
    assert repository.get_document("d1", workspace_id="other") is None
    assert repository.list_documents("ws") == [document]
    assert repository.list_documents("other") == []


def test_document_workspace_mismatch() -> None:
    repository, _ = _backend()
    repository.add_document(_document())
    with pytest.raises(WorkspaceMismatchError):
        repository.add_document(_document(workspace="other"))


def test_delete_document_removes_chunks() -> None:
    repository, _ = _backend()
    repository.add_document(_document())
    repository.add_chunks([_chunk()])
    repository.delete_document("d1", workspace_id="ws")
    assert repository.get_document("d1", workspace_id="ws") is None
    assert repository.get_chunks("d1", workspace_id="ws") == []
    repository.delete_document("missing", workspace_id="ws")


def test_chunks_are_ordered_by_position() -> None:
    repository, _ = _backend()
    repository.add_document(_document())
    repository.add_chunks([_chunk(chunk_id="b", position=1), _chunk(chunk_id="a", position=0)])
    assert [chunk.id for chunk in repository.get_chunks("d1", workspace_id="ws")] == ["a", "b"]
    assert repository.get_chunk("a", workspace_id="ws") is not None
    assert repository.get_chunk("a", workspace_id="other") is None
    assert repository.get_chunk("missing", workspace_id="ws") is None


def test_chunk_workspace_mismatch() -> None:
    repository, _ = _backend()
    repository.add_document(_document())
    with pytest.raises(WorkspaceMismatchError):
        repository.add_chunks([_chunk(workspace="other")])


def test_search_text() -> None:
    repository, _ = _backend()
    repository.add_document(_document())
    repository.add_chunks([_chunk(chunk_id="c1"), _chunk(chunk_id="c2", position=1)])
    results = repository.search_text(workspace_id="ws", query="SINCRONIZAÇÃO")
    assert [chunk.id for chunk in results] == ["c1", "c2"]
    assert repository.search_text(workspace_id="other", query="sincronização") == []
    with pytest.raises(ConfigurationError):
        repository.search_text(workspace_id="ws", query="x", limit=0)


def test_vector_upsert_query_filters_and_limit() -> None:
    _, vectors = _backend()
    vectors.upsert(chunk_id="a", workspace_id="ws", vector=[1.0, 0.0], metadata={"type": "topic"})
    vectors.upsert(chunk_id="b", workspace_id="ws", vector=[0.0, 1.0], metadata={"type": "task"})
    matches = vectors.query(workspace_id="ws", vector=[1.0, 0.0], limit=10)
    assert [match.chunk_id for match in matches] == ["a", "b"]
    assert matches[0].score == pytest.approx(1.0)
    assert len(vectors.query(workspace_id="ws", vector=[1.0, 0.0], limit=1)) == 1
    filtered = vectors.query(
        workspace_id="ws", vector=[1.0, 0.0], limit=10, filters={"type": "task"}
    )
    assert [match.chunk_id for match in filtered] == ["b"]
    assert vectors.query(workspace_id="other", vector=[1.0, 0.0], limit=10) == []


def test_vector_configuration_errors() -> None:
    _, vectors = _backend()
    with pytest.raises(ConfigurationError):
        vectors.upsert(chunk_id="a", workspace_id="ws", vector=[])
    vectors.upsert(chunk_id="a", workspace_id="ws", vector=[1.0, 0.0])
    with pytest.raises(ConfigurationError):
        vectors.upsert(chunk_id="b", workspace_id="ws", vector=[1.0, 0.0, 0.0])
    with pytest.raises(ConfigurationError):
        vectors.query(workspace_id="ws", vector=[1.0, 0.0, 0.0], limit=10)
    with pytest.raises(ConfigurationError):
        vectors.query(workspace_id="ws", vector=[1.0, 0.0], limit=0)


def test_vector_zero_norm_scores_zero() -> None:
    _, vectors = _backend()
    vectors.upsert(chunk_id="zero", workspace_id="ws", vector=[0.0, 0.0])
    (match,) = vectors.query(workspace_id="ws", vector=[1.0, 0.0], limit=10)
    assert match.score == 0.0


def test_vector_zero_query_scores_zero() -> None:
    _, vectors = _backend()
    vectors.upsert(chunk_id="c1", workspace_id="ws", vector=[1.0, 0.0])
    (match,) = vectors.query(workspace_id="ws", vector=[0.0, 0.0], limit=10)
    assert match.score == 0.0


def test_vector_reupsert_same_chunk_ignores_own_dimension() -> None:
    _, vectors = _backend()
    vectors.upsert(chunk_id="c1", workspace_id="ws", vector=[1.0, 0.0])
    vectors.upsert(chunk_id="c1", workspace_id="ws", vector=[1.0, 0.0, 0.0])
    (match,) = vectors.query(workspace_id="ws", vector=[1.0, 0.0, 0.0], limit=10)
    assert match.chunk_id == "c1"


def test_vector_delete() -> None:
    _, vectors = _backend()
    vectors.upsert(chunk_id="a", workspace_id="ws", vector=[1.0])
    vectors.delete(workspace_id="ws", chunk_id="a")
    assert vectors.query(workspace_id="ws", vector=[1.0], limit=10) == []
    vectors.upsert(chunk_id="b", workspace_id="ws", vector=[1.0])
    vectors.delete_workspace("ws")
    assert vectors.query(workspace_id="ws", vector=[1.0], limit=10) == []


def test_persistence_across_reopen(tmp_path: Path) -> None:
    path = str(tmp_path / "knowledge.db")
    database = SQLiteStore(path)
    repository = SQLiteKnowledgeRepository(database)
    vectors = SQLiteVectorStore(database)
    repository.add_source(_source())
    repository.add_document(_document())
    repository.add_chunks([_chunk()])
    vectors.upsert(chunk_id="c1", workspace_id="ws", vector=[1.0, 0.0], metadata={"x": 1})
    database.close()

    reopened = SQLiteStore(path)
    repository2 = SQLiteKnowledgeRepository(reopened)
    vectors2 = SQLiteVectorStore(reopened)
    chunk = repository2.get_chunk("c1", workspace_id="ws")
    assert chunk is not None
    assert chunk.content == "sincronização offline"
    matches = vectors2.query(workspace_id="ws", vector=[1.0, 0.0], limit=5)
    assert [match.chunk_id for match in matches] == ["c1"]
    reopened.close()


def test_store_schema_is_idempotent() -> None:
    database = SQLiteStore()
    with database.locked() as conn:
        assert conn.execute("SELECT COUNT(*) AS total FROM documents").fetchone()["total"] == 0
    database.close()


def test_vectors_remember_the_embedding_model() -> None:
    database = SQLiteStore()
    SQLiteVectorStore(database, embedding_model="m1").upsert(
        chunk_id="a", workspace_id="ws", vector=[1.0, 0.0]
    )
    other_model = SQLiteVectorStore(database, embedding_model="m2")
    assert other_model.indexed_models("ws") == ["m1"]
    with pytest.raises(ConfigurationError, match="Reindexe"):
        other_model.upsert(chunk_id="b", workspace_id="ws", vector=[1.0, 0.0])
    with pytest.raises(ConfigurationError, match="Reindexe"):
        other_model.query(workspace_id="ws", vector=[1.0, 0.0], limit=5)
    other_model.delete_workspace("ws")
    other_model.upsert(chunk_id="b", workspace_id="ws", vector=[1.0, 0.0])
    assert other_model.indexed_models("ws") == ["m2"]


def test_vectors_without_model_do_not_conflict() -> None:
    database = SQLiteStore()
    SQLiteVectorStore(database).upsert(chunk_id="a", workspace_id="ws", vector=[1.0])
    tracked = SQLiteVectorStore(database, embedding_model="m1")
    tracked.upsert(chunk_id="b", workspace_id="ws", vector=[1.0])
    assert len(tracked.query(workspace_id="ws", vector=[1.0], limit=5)) == 2
    assert tracked.indexed_models("ws") == ["m1"]


def test_dimension_check_reads_legacy_rows_without_dimension() -> None:
    database = SQLiteStore()
    with database.locked() as conn:
        conn.execute(
            "INSERT INTO vectors (workspace_id, chunk_id, vector, metadata) VALUES (?, ?, ?, ?)",
            ("ws", "old", "[1.0, 0.0]", "{}"),
        )
    with pytest.raises(ConfigurationError):
        SQLiteVectorStore(database).upsert(chunk_id="new", workspace_id="ws", vector=[1.0])


def test_search_text_treats_wildcards_literally() -> None:
    repository, _ = _backend()
    repository.add_document(_document())
    literal = _chunk(chunk_id="c1").model_copy(update={"content": "desconto de 50% no plano"})
    other = _chunk(chunk_id="c2", position=1).model_copy(update={"content": "5 0 de nada"})
    repository.add_chunks([literal, other])
    assert [chunk.id for chunk in repository.search_text(workspace_id="ws", query="50%")] == ["c1"]
    assert repository.search_text(workspace_id="ws", query="%") == [literal]
    assert repository.search_text(workspace_id="ws", query="_") == []
