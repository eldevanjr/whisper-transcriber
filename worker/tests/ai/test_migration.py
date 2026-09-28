from __future__ import annotations

from ai_core import InMemoryKnowledgeRepository, InMemoryVectorStore

from tests.ai.fakes import FakeEmbedder
from transcriber_worker.ai.indexing import Indexer
from transcriber_worker.ai.migration import migrate_fallback
from transcriber_worker.ai.store import SQLiteKnowledgeRepository, SQLiteStore, SQLiteVectorStore
from transcriber_worker.ai.windows import SegmentInput


def test_fallback_knowledge_moves_to_postgres_and_is_reindexed() -> None:
    store = SQLiteStore()
    fallback = Indexer(
        repository=SQLiteKnowledgeRepository(store),
        embeddings=FakeEmbedder(),
        vector_store=SQLiteVectorStore(store),
    )
    outcome = fallback.index_transcription(
        workspace_id="ws",
        transcription_id="t",
        title="Reunião",
        segments=[SegmentInput(index=0, start=0.0, end=5.0, text="sincronização offline")],
    )
    fallback.drain()

    target = InMemoryKnowledgeRepository()
    indexer = Indexer(
        repository=target, embeddings=FakeEmbedder(), vector_store=InMemoryVectorStore()
    )
    assert migrate_fallback(source=store, indexer=indexer) == 1

    document = target.get_document(outcome.document.id, workspace_id="ws")
    assert document is not None
    assert document.source_id is not None
    assert target.get_source(document.source_id) is not None
    assert len(target.get_chunks(document.id, workspace_id="ws")) == 1
    assert indexer.drain() == 1
    # o SQLite fica limpo: uma nova queda do PostgreSQL não duplica nada
    assert SQLiteKnowledgeRepository(store).list_documents("ws") == []
    assert migrate_fallback(source=store, indexer=indexer) == 0


def test_nothing_to_migrate() -> None:
    indexer = Indexer(
        repository=InMemoryKnowledgeRepository(),
        embeddings=FakeEmbedder(),
        vector_store=InMemoryVectorStore(),
    )
    assert migrate_fallback(source=SQLiteStore(), indexer=indexer) == 0


def test_documents_without_source_are_migrated() -> None:
    from ai_core import KnowledgeDocument

    store = SQLiteStore()
    repository = SQLiteKnowledgeRepository(store)
    repository.add_document(KnowledgeDocument(workspace_id="ws", title="Sem fonte", content="x"))
    repository.add_document(
        KnowledgeDocument(workspace_id="ws", source_id="sumiu", title="Fonte perdida", content="y")
    )
    target = InMemoryKnowledgeRepository()
    indexer = Indexer(
        repository=target, embeddings=FakeEmbedder(), vector_store=InMemoryVectorStore()
    )
    assert migrate_fallback(source=store, indexer=indexer) == 2
    assert len(target.list_documents("ws")) == 2
