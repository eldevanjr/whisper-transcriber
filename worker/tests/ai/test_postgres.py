from __future__ import annotations

from collections import deque
from collections.abc import Mapping
from datetime import UTC, datetime
from typing import Any

import pytest
from ai_core import (
    ConfigurationError,
    KnowledgeChunk,
    KnowledgeDocument,
    Source,
    SourceKind,
    WorkspaceMismatchError,
)

from transcriber_worker.ai.postgres import (
    _MIGRATIONS,
    SCHEMA_VERSION,
    HealthReport,
    PostgresConfig,
    PostgresKnowledgeRepository,
    PostgresUnavailableError,
    PostgresVectorStore,
    ReconnectingConnection,
    health_check,
    open_postgres,
    redact,
    run_migrations,
)


class FakeCursor:
    def __init__(self, connection: FakeConnection) -> None:
        self._connection = connection
        self._current: Any = None

    def execute(self, query: str, params: Any = None) -> None:
        self._connection.queries.append((query, tuple(params or ())))
        self._current = self._connection._next()

    def fetchone(self) -> Mapping[str, Any] | None:
        return self._current if isinstance(self._current, Mapping) else None

    def fetchall(self) -> list[Mapping[str, Any]]:
        return list(self._current) if isinstance(self._current, list) else []

    def __enter__(self) -> FakeCursor:
        return self

    def __exit__(self, *args: object) -> None:
        return None


class FakeConnection:
    def __init__(self, responses: list[Any] | None = None) -> None:
        self._responses = deque(responses or [])
        self.queries: list[tuple[str, tuple[Any, ...]]] = []
        self.commits = 0
        self.closed = False
        self.broken = False

    def _next(self) -> Any:
        return self._responses.popleft() if self._responses else None

    def cursor(self) -> FakeCursor:
        return FakeCursor(self)

    def commit(self) -> None:
        self.commits += 1

    def close(self) -> None:
        self.closed = True


def _source_row() -> dict[str, Any]:
    return {
        "id": "s1",
        "evidence_id": None,
        "type": "TRANSCRIPT",
        "location": "00:01",
        "title": "Reunião",
        "metadata": {"k": 1},
    }


def _document_row() -> dict[str, Any]:
    return {
        "id": "d1",
        "workspace_id": "ws",
        "source_id": "s1",
        "title": "Doc",
        "content": "conteudo",
        "metadata": {"transcription_id": "t1"},
        "created_at": datetime(2026, 9, 26, tzinfo=UTC),
    }


def _chunk_row() -> dict[str, Any]:
    return {
        "id": "c1",
        "document_id": "d1",
        "workspace_id": "ws",
        "content": "sincronização",
        "position": 0,
        "metadata": {"start_time": 0.0},
        "embedding_reference": None,
    }


def _source() -> Source:
    return Source(id="s1", type=SourceKind.TRANSCRIPT, title="Reunião")


def _document() -> KnowledgeDocument:
    return KnowledgeDocument(
        id="d1",
        workspace_id="ws",
        source_id="s1",
        title="Doc",
        content="conteudo",
        created_at=datetime(2026, 9, 26, tzinfo=UTC),
    )


def _chunk() -> KnowledgeChunk:
    return KnowledgeChunk(
        id="c1", document_id="d1", workspace_id="ws", content="sincronização", position=0
    )


def _config() -> PostgresConfig:
    return PostgresConfig(password="segredo")  # noqa: S106 - senha fictícia de teste


def test_open_postgres_builds_connection() -> None:
    calls: dict[str, Any] = {}
    dict_row_marker = object()

    class FakeRows:
        dict_row = dict_row_marker

    class FakePsycopg:
        def connect(self, **kwargs: Any) -> object:
            calls.update(kwargs)
            return object()

    modules = {"psycopg": FakePsycopg(), "psycopg.rows": FakeRows()}
    connection = open_postgres(_config(), importer=modules.__getitem__)
    assert connection is not None
    assert calls["host"] == "127.0.0.1"
    assert calls["dbname"] == "whisper"
    assert calls["row_factory"] is dict_row_marker
    assert calls["autocommit"] is True


def test_open_postgres_connection_failure_hides_password() -> None:
    class FakeRows:
        dict_row = object()

    class FakePsycopg:
        def connect(self, **kwargs: Any) -> object:
            raise RuntimeError(f"auth failed for password {kwargs['password']}")

    modules = {"psycopg": FakePsycopg(), "psycopg.rows": FakeRows()}
    with pytest.raises(PostgresUnavailableError) as caught:
        open_postgres(_config(), importer=modules.__getitem__)
    assert "segredo" not in str(caught.value)
    assert "***" in str(caught.value)


def test_redact_ignores_empty_secrets() -> None:
    assert redact("senha abc", [None, "", "abc"]) == "senha ***"


def test_reconnecting_connection_reopens_closed_or_broken() -> None:
    opened: list[FakeConnection] = []

    def opener() -> FakeConnection:
        connection = FakeConnection()
        opened.append(connection)
        return connection

    connection = ReconnectingConnection(opener)
    connection.cursor()
    assert len(opened) == 1
    opened[0].closed = True
    connection.cursor()
    assert len(opened) == 2
    opened[1].broken = True
    connection.commit()
    assert len(opened) == 3
    assert opened[2].commits == 1
    connection.close()
    assert opened[2].closed is True


def test_open_postgres_without_driver() -> None:
    def importer(name: str) -> object:
        raise ImportError(name)

    with pytest.raises(PostgresUnavailableError):
        open_postgres(_config(), importer=importer)


def test_run_migrations_from_scratch() -> None:
    connection = FakeConnection()
    run_migrations(connection)
    statements = sum(len(migration) for migration in _MIGRATIONS)
    # tabela de versão + consulta + (DELETE/INSERT da versão a cada migração)
    assert len(connection.queries) == 2 + statements + 2 * len(_MIGRATIONS)
    assert connection.queries[-1][1] == (SCHEMA_VERSION,)
    assert connection.commits == 1


def test_run_migrations_skips_applied_versions() -> None:
    connection = FakeConnection([None, {"version": SCHEMA_VERSION}])
    run_migrations(connection)
    assert len(connection.queries) == 2


def test_run_migrations_applies_only_missing_ones() -> None:
    connection = FakeConnection([None, {"version": 1}])
    run_migrations(connection)
    assert len(connection.queries) == 2 + len(_MIGRATIONS[1]) + 2


def test_health_check_ok() -> None:
    connection = FakeConnection([{"version": "PostgreSQL 16"}, {"extversion": "0.7"}])
    report = health_check(connection)
    assert isinstance(report, HealthReport)
    assert report.ok is True
    assert report.checks[1].detail == "0.7"


def test_health_check_missing_pgvector() -> None:
    connection = FakeConnection([{"version": "PostgreSQL 16"}, None])
    report = health_check(connection)
    assert report.ok is False
    assert report.checks[1].detail is None


def test_health_check_without_postgres() -> None:
    connection = FakeConnection([None, None])
    assert health_check(connection).ok is False


def test_repository_source_roundtrip() -> None:
    connection = FakeConnection()
    repository = PostgresKnowledgeRepository(connection)
    assert repository.add_source(_source()) == _source()

    found = FakeConnection([_source_row()])
    assert PostgresKnowledgeRepository(found).get_source("s1") is not None

    missing = FakeConnection([None])
    assert PostgresKnowledgeRepository(missing).get_source("x") is None


def test_repository_document_roundtrip_and_mismatch() -> None:
    connection = FakeConnection([None])
    repository = PostgresKnowledgeRepository(connection)
    assert repository.add_document(_document()) == _document()

    mismatch = FakeConnection([{"workspace_id": "other"}])
    with pytest.raises(WorkspaceMismatchError):
        PostgresKnowledgeRepository(mismatch).add_document(_document())

    found = FakeConnection([_document_row()])
    document = PostgresKnowledgeRepository(found).get_document("d1", workspace_id="ws")
    assert document is not None
    assert document.created_at.year == 2026

    missing = FakeConnection([None])
    assert PostgresKnowledgeRepository(missing).get_document("d1", workspace_id="ws") is None


def test_repository_list_and_delete_document() -> None:
    listed = FakeConnection([[_document_row()]])
    assert len(PostgresKnowledgeRepository(listed).list_documents("ws")) == 1

    deleted = FakeConnection()
    PostgresKnowledgeRepository(deleted).delete_document("d1", workspace_id="ws")
    assert deleted.commits == 1
    assert len(deleted.queries) == 2


def test_repository_chunks_roundtrip_and_mismatch() -> None:
    connection = FakeConnection([None])
    repository = PostgresKnowledgeRepository(connection)
    repository.add_chunks([_chunk()])

    mismatch = FakeConnection([{"workspace_id": "other"}])
    with pytest.raises(WorkspaceMismatchError):
        PostgresKnowledgeRepository(mismatch).add_chunks([_chunk()])

    listed = FakeConnection([[_chunk_row()]])
    assert len(PostgresKnowledgeRepository(listed).get_chunks("d1", workspace_id="ws")) == 1

    found = FakeConnection([_chunk_row()])
    assert PostgresKnowledgeRepository(found).get_chunk("c1", workspace_id="ws") is not None

    missing = FakeConnection([None])
    assert PostgresKnowledgeRepository(missing).get_chunk("c1", workspace_id="ws") is None


def test_repository_search_text() -> None:
    connection = FakeConnection([[_chunk_row()]])
    repository = PostgresKnowledgeRepository(connection)
    assert len(repository.search_text(workspace_id="ws", query="50%_x")) == 1
    query, params = connection.queries[0]
    assert "ESCAPE" in query
    assert params[1] == "%50\\%\\_x%"
    with pytest.raises(ConfigurationError):
        repository.search_text(workspace_id="ws", query="x", limit=0)


def _vector_connection(responses: list[Any]) -> FakeConnection:
    return FakeConnection(responses)


def test_vector_upsert_records_model_dimension_and_hnsw_index() -> None:
    connection = _vector_connection([None, None, None, None])
    vectors = PostgresVectorStore(connection, embedding_model="nomic")
    vectors.upsert(chunk_id="c1", workspace_id="ws", vector=[1.0, 0.0], metadata={"a": 1})
    model_check, dimension_check, insert, index = connection.queries
    assert "embedding_model <>" in model_check[0]
    assert "LIMIT 1" in dimension_check[0]
    assert insert[1][-2:] == ("nomic", 2)
    assert "USING hnsw ((embedding::vector(2))" in index[0]
    assert "WHERE embedding_dimension = 2" in index[0]
    vectors.upsert(chunk_id="c2", workspace_id="ws", vector=[0.0, 1.0])
    assert len(connection.queries) == 7  # o índice da dimensão já existe


def test_vector_upsert_skips_hnsw_above_its_limit() -> None:
    connection = _vector_connection([None, None])
    PostgresVectorStore(connection).upsert(chunk_id="c1", workspace_id="ws", vector=[0.1] * 3000)
    assert not any("hnsw" in query for query, _params in connection.queries)


def test_vector_query_uses_the_dimension_index() -> None:
    querying = _vector_connection([None, [{"chunk_id": "c1", "metadata": {"a": 1}, "score": 0.9}]])
    matches = PostgresVectorStore(querying).query(
        workspace_id="ws", vector=[1.0, 0.0], limit=5, filters={"a": 1}
    )
    assert matches[0].chunk_id == "c1"
    assert matches[0].score == pytest.approx(0.9)
    query, params = querying.queries[-1]
    assert "embedding::vector(2) <=> %s::vector(2)" in query
    assert "embedding_dimension = %s" in query
    assert params[1:3] == ("ws", 2)

    plain = _vector_connection([None, []])
    assert PostgresVectorStore(plain).query(workspace_id="ws", vector=[1.0], limit=5) == []


def test_vector_model_change_requires_reindex() -> None:
    changed = PostgresVectorStore(
        FakeConnection([{"embedding_model": "antigo"}]), embedding_model="novo"
    )
    with pytest.raises(ConfigurationError, match="Reindexe"):
        changed.query(workspace_id="ws", vector=[1.0], limit=5)


def test_vector_indexed_models() -> None:
    connection = FakeConnection([[{"embedding_model": "nomic"}]])
    assert PostgresVectorStore(connection).indexed_models("ws") == ["nomic"]


def test_vector_configuration_errors() -> None:
    vectors = PostgresVectorStore(FakeConnection())
    with pytest.raises(ConfigurationError):
        vectors.upsert(chunk_id="c1", workspace_id="ws", vector=[])
    mismatch = PostgresVectorStore(FakeConnection([{"dimension": 4}]))
    with pytest.raises(ConfigurationError):
        mismatch.upsert(chunk_id="c1", workspace_id="ws", vector=[1.0, 0.0, 0.0])
    with pytest.raises(ConfigurationError):
        PostgresVectorStore(FakeConnection()).query(workspace_id="ws", vector=[1.0], limit=0)


def test_vector_delete() -> None:
    connection = FakeConnection()
    vectors = PostgresVectorStore(connection)
    vectors.delete(workspace_id="ws", chunk_id="c1")
    vectors.delete_workspace("ws")
    assert connection.commits == 2


def test_vector_literal() -> None:
    from transcriber_worker.ai.postgres import _vector_literal

    assert _vector_literal([1.0, 0.5]) == "[1.0,0.5]"
