from __future__ import annotations

import pytest
from ai_core import (
    InMemoryKnowledgeRepository,
    InMemoryVectorStore,
    PolicyViolationError,
    PrivacyMode,
    PrivacyPolicy,
    ProviderLocation,
)

from tests.ai.fakes import FakeEmbedder
from transcriber_worker.ai.indexing import Indexer
from transcriber_worker.ai.ollama import OllamaUnavailableError
from transcriber_worker.ai.rag import KnowledgeQuery
from transcriber_worker.ai.store import (
    SQLiteKnowledgeRepository,
    SQLiteVectorStore,
    create_sqlite_backend,
)
from transcriber_worker.ai.windows import SegmentInput


def _setup() -> tuple[SQLiteKnowledgeRepository, FakeEmbedder, SQLiteVectorStore]:
    repository, vector_store = create_sqlite_backend()
    embeddings = FakeEmbedder(dimension=3)
    indexer = Indexer(repository=repository, embeddings=embeddings, vector_store=vector_store)
    _ = indexer.index_transcription(
        workspace_id="ws",
        transcription_id="t1",
        title="Reunião 26/09",
        segments=[
            SegmentInput(
                index=0,
                start=0.0,
                end=10.0,
                text="falamos sobre sincronização offline de abastecimento",
            )
        ],
    )
    _ = indexer.drain()
    return repository, embeddings, vector_store


def test_search_returns_chunk_and_source() -> None:
    repository, embeddings, vector_store = _setup()
    query = KnowledgeQuery(repository=repository, embeddings=embeddings, vector_store=vector_store)
    results = query.search(workspace_id="ws", query="sincronização")
    assert len(results) == 1
    assert "sincronização" in results[0].chunk.content
    assert results[0].source is not None
    assert results[0].source.title == "Reunião 26/09"


def test_search_respects_workspace() -> None:
    repository, embeddings, vector_store = _setup()
    query = KnowledgeQuery(repository=repository, embeddings=embeddings, vector_store=vector_store)
    assert query.search(workspace_id="other", query="sincronização") == []


def test_search_limit() -> None:
    repository, embeddings, vector_store = _setup()
    query = KnowledgeQuery(repository=repository, embeddings=embeddings, vector_store=vector_store)
    assert len(query.search(workspace_id="ws", query="x", limit=1)) == 1


def test_search_with_local_only_privacy() -> None:
    repository, embeddings, vector_store = _setup()
    query = KnowledgeQuery(
        repository=repository,
        embeddings=embeddings,
        vector_store=vector_store,
        privacy=PrivacyPolicy(mode=PrivacyMode.LOCAL_ONLY),
    )
    assert query.search(workspace_id="ws", query="x")


def test_hybrid_search_adds_text_matches_after_vector_ones() -> None:
    repository, embeddings, vector_store = _setup()
    query = KnowledgeQuery(repository=repository, embeddings=embeddings, vector_store=vector_store)
    results = query.search(workspace_id="ws", query="abastecimento")
    assert len(results) == 1  # o mesmo trecho não se repete
    assert results[0].metadata.get("match") != "text"


def test_offline_embeddings_fall_back_to_text_search() -> None:
    repository, _embeddings, vector_store = _setup()
    offline = FakeEmbedder(error=OllamaUnavailableError("off"))
    query = KnowledgeQuery(repository=repository, embeddings=offline, vector_store=vector_store)
    results = query.search(workspace_id="ws", query="Como ficou a sincronização offline?")
    assert len(results) == 1
    assert results[0].metadata["match"] == "text"
    assert results[0].source is not None
    assert query.search(workspace_id="ws", query="assunto inexistente") == []


def test_reindex_required_falls_back_to_text_search() -> None:
    repository, _embeddings, vector_store = _setup()
    different = FakeEmbedder(dimension=5)
    query = KnowledgeQuery(repository=repository, embeddings=different, vector_store=vector_store)
    results = query.search(workspace_id="ws", query="sincronização")
    assert [result.metadata["match"] for result in results] == ["text"]


def test_text_search_respects_filters_and_short_words() -> None:
    repository, _embeddings, vector_store = _setup()
    offline = FakeEmbedder(error=OllamaUnavailableError("off"))
    query = KnowledgeQuery(repository=repository, embeddings=offline, vector_store=vector_store)
    assert query.search(workspace_id="ws", query="de a o") == []
    assert (
        query.search(
            workspace_id="ws", query="sincronização", filters={"transcription_id": "outra"}
        )
        == []
    )
    assert query.search(
        workspace_id="ws", query="sincronização", filters={"transcription_id": "t1"}
    )


def test_blocked_provider_is_refused_at_search_time() -> None:
    repository, embeddings, vector_store = _setup()
    embeddings.location = ProviderLocation.CLOUD
    query = KnowledgeQuery(
        repository=repository,
        embeddings=embeddings,
        vector_store=vector_store,
        privacy=PrivacyPolicy(mode=PrivacyMode.LOCAL_ONLY),
    )
    with pytest.raises(PolicyViolationError):
        query.search(workspace_id="ws", query="sincronização")


def test_repository_without_text_search_uses_only_vectors() -> None:
    repository = InMemoryKnowledgeRepository()
    offline = FakeEmbedder(error=OllamaUnavailableError("off"))
    query = KnowledgeQuery(
        repository=repository, embeddings=offline, vector_store=InMemoryVectorStore()
    )
    assert query.search(workspace_id="ws", query="sincronização") == []


def test_text_results_without_document_source() -> None:
    from ai_core import KnowledgeChunk, KnowledgeDocument

    repository, vector_store = create_sqlite_backend()
    document = repository.add_document(
        KnowledgeDocument(workspace_id="ws", title="Solto", content="orçamento anual")
    )
    repository.add_chunks(
        [
            KnowledgeChunk(
                document_id=document.id, workspace_id="ws", content="orçamento anual", position=0
            )
        ]
    )
    offline = FakeEmbedder(error=OllamaUnavailableError("off"))
    query = KnowledgeQuery(repository=repository, embeddings=offline, vector_store=vector_store)
    (result,) = query.search(workspace_id="ws", query="orçamento")
    assert result.source is None
