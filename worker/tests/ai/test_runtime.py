from __future__ import annotations

from pathlib import Path
from typing import Any

from ai_core import PrivacyMode

from tests.ai.test_postgres import FakeConnection
from transcriber_worker.ai.config import AiConfig
from transcriber_worker.ai.indexing import IndexStatus
from transcriber_worker.ai.runtime import AiRuntime
from transcriber_worker.ai.storage import StorageBackend, postgres_storage
from transcriber_worker.ai.store import SQLiteKnowledgeRepository, SQLiteStore, SQLiteVectorStore
from transcriber_worker.ai.windows import SegmentInput

SEGMENT = SegmentInput(index=0, start=0.0, end=10.0, text="sincronização offline")


def _post(path: str, payload: dict[str, Any] | None) -> dict[str, Any]:
    if path == "/api/embeddings":
        return {"embedding": [1.0, 0.0, 0.0]}
    if path == "/api/generate":
        return {"response": '{"topics": [{"name": "Sinc"}]}'}
    raise AssertionError(path)


def test_runtime_wires_all_components() -> None:
    config = AiConfig(enabled=True)
    runtime = AiRuntime(config, post=_post)
    assert runtime.config is config
    assert runtime.database is not None
    assert runtime.storage.kind == "sqlite"
    assert runtime.storage.fallback_reason is None
    assert runtime.repository is not None
    assert runtime.vector_store is not None
    assert runtime.llm.name == "ollama"
    assert runtime.embeddings.name == "ollama"
    assert runtime.service.config is config
    assert runtime.indexer is not None
    assert runtime.query is not None
    assert runtime.answer is not None
    assert runtime.analysis is not None
    assert runtime.client.base_url == "http://localhost:11434"
    assert runtime.blocked_reason is None
    runtime.close()


def test_vectors_track_the_configured_embedding_model() -> None:
    runtime = AiRuntime(AiConfig(enabled=True, embedding_model="bge-m3"), post=_post)
    runtime.indexer.index_transcription(
        workspace_id="ws", transcription_id="t1", title="Reunião", segments=[SEGMENT]
    )
    runtime.indexer.drain()
    vectors = runtime.vector_store
    assert isinstance(vectors, SQLiteVectorStore)
    assert vectors.indexed_models("ws") == ["bge-m3"]
    runtime.close()


def test_public_ollama_is_blocked_unless_allowed() -> None:
    blocked = AiRuntime(AiConfig(enabled=True, ollama_url="https://ollama.example.com"))
    assert blocked.blocked_reason is not None
    assert "ollama.example.com" in blocked.blocked_reason
    assert blocked.privacy.mode is PrivacyMode.LOCAL_ONLY
    blocked.close()
    allowed = AiRuntime(
        AiConfig(enabled=True, ollama_url="https://ollama.example.com", allow_remote_ollama=True)
    )
    assert allowed.blocked_reason is None
    assert allowed.privacy.mode is PrivacyMode.ALLOW_CLOUD
    allowed.close()


def test_runtime_uses_postgres_storage_and_migrates_fallback(tmp_path: Path) -> None:
    database_path = str(tmp_path / "ai.db")
    fallback = AiRuntime(AiConfig(enabled=True), database_path=database_path, post=_post)
    fallback.indexer.index_transcription(
        workspace_id="ws", transcription_id="t1", title="R", segments=[SEGMENT]
    )
    fallback.close()

    connection = FakeConnection()
    backends: list[StorageBackend] = []

    def factory(_database: SQLiteStore) -> StorageBackend:
        backend = postgres_storage(connection)
        backend.repository = SQLiteKnowledgeRepository(SQLiteStore())  # repositório de destino
        backends.append(backend)
        return backend

    runtime = AiRuntime(
        AiConfig(enabled=True), database_path=database_path, post=_post, storage_factory=factory
    )
    assert runtime.storage is backends[0]
    assert len(runtime.repository.list_documents("ws")) == 1
    assert runtime.indexer.queue.counts()[IndexStatus.PENDING] == 1
    runtime.shutdown()
    runtime.close()
    assert connection.closed is True


def test_runtime_end_to_end() -> None:
    runtime = AiRuntime(AiConfig(enabled=True), post=_post)
    outcome = runtime.indexer.index_transcription(
        workspace_id="ws", transcription_id="t1", title="Reunião", segments=[SEGMENT]
    )
    assert runtime.indexer.drain() == 1
    results = runtime.query.search(workspace_id="ws", query="sincronização")
    assert results
    assert results[0].chunk.document_id == outcome.document.id

    runtime.service.open(transcription_id="t1", workspace_id="ws", title="Reunião")
    runtime.service.close("t1", [SEGMENT])
    runtime.service.process_next()
    assert runtime.service.consolidated("t1").topics[0].name == "Sinc"
    runtime.close()


def test_runtime_persists_across_reopen(tmp_path: Path) -> None:
    database_path = str(tmp_path / "ai.db")
    config = AiConfig(enabled=True)
    first = AiRuntime(config, database_path=database_path, post=_post)
    _ = first.indexer.index_transcription(
        workspace_id="ws", transcription_id="t1", title="Reunião", segments=[SEGMENT]
    )
    first.close()  # fechou antes de gerar o embedding: a fila volta na reabertura

    second = AiRuntime(config, database_path=database_path, post=_post)
    assert second.indexer.drain() == 1
    assert second.query.search(workspace_id="ws", query="x")
    second.close()
