from __future__ import annotations

from ai_core import (
    InMemoryKnowledgeRepository,
    InMemoryVectorStore,
    KnowledgeChunk,
    SearchResult,
)

from tests.ai.fakes import FakeAnalyzerProvider, FakeEmbedder
from transcriber_worker.ai.analyzer import CONTEXT_TOKENS
from transcriber_worker.ai.answer import (
    ANSWER_CONTEXT_CHARS,
    ANSWER_MAX_TOKENS,
    GROUNDING_PROMPT,
    KnowledgeAnswer,
    context_of,
)
from transcriber_worker.ai.indexing import Indexer
from transcriber_worker.ai.rag import KnowledgeQuery
from transcriber_worker.ai.windows import SegmentInput


def _answer() -> tuple[KnowledgeAnswer, FakeAnalyzerProvider]:
    repository = InMemoryKnowledgeRepository()
    embeddings = FakeEmbedder(dimension=3)
    vector_store = InMemoryVectorStore()
    indexer = Indexer(repository=repository, embeddings=embeddings, vector_store=vector_store)
    _ = indexer.index_transcription(
        workspace_id="ws",
        transcription_id="t",
        title="Reunião",
        segments=[
            SegmentInput(
                index=0,
                start=0.0,
                end=10.0,
                text="falamos sobre sincronização offline",
            )
        ],
    )
    _ = indexer.drain()
    query = KnowledgeQuery(repository=repository, embeddings=embeddings, vector_store=vector_store)
    provider = FakeAnalyzerProvider(responder=lambda _request: "Foi discutida a sincronização.")
    return KnowledgeAnswer(query=query, provider=provider, model="m"), provider


def test_ask_returns_answer_with_sources() -> None:
    answer, provider = _answer()
    result = answer.ask(workspace_id="ws", question="o que foi discutido?", limit=5)
    assert result.answer == "Foi discutida a sincronização."
    assert result.sources
    assert result.model == "m"
    request = provider.requests[0]
    assert request.system_prompt == GROUNDING_PROMPT
    assert "sincronização" in request.context[0]
    assert request.context[0].startswith("[0.0s-10.0s]")


def test_ask_without_results_has_empty_context() -> None:
    query = KnowledgeQuery(
        repository=InMemoryKnowledgeRepository(),
        embeddings=FakeEmbedder(dimension=3),
        vector_store=InMemoryVectorStore(),
    )
    provider = FakeAnalyzerProvider(responder=lambda _request: "Não encontrei.")
    answer = KnowledgeAnswer(query=query, provider=provider, model="m")
    result = answer.ask(workspace_id="ws", question="x")
    assert result.answer == "Não encontrei."
    assert result.sources == []
    assert provider.requests[0].context == []


def test_context_of_handles_time_labels() -> None:
    with_time = KnowledgeChunk(
        document_id="d",
        workspace_id="w",
        content="a",
        metadata={"start_time": 1.0, "end_time": 2.5},
    )
    assert context_of(SearchResult(chunk=with_time, score=1.0)) == "[1.0s-2.5s] a"
    without_time = KnowledgeChunk(document_id="d", workspace_id="w", content="b")
    assert context_of(SearchResult(chunk=without_time, score=1.0)) == "b"


def test_answers_turn_thinking_off_and_cap_the_output() -> None:
    answer, provider = _answer()
    answer.ask(workspace_id="ws", question="o que foi discutido?")
    request = provider.requests[0]
    assert request.metadata["think"] is False
    assert request.max_tokens == ANSWER_MAX_TOKENS


def test_answer_context_is_capped_to_protect_weak_gpus() -> None:
    repository = InMemoryKnowledgeRepository()
    embeddings = FakeEmbedder(dimension=3)
    vector_store = InMemoryVectorStore()
    indexer = Indexer(repository=repository, embeddings=embeddings, vector_store=vector_store)
    long_text = "palavra " * 700  # cada trecho vira um chunk de ~600 palavras
    indexer.index_transcription(
        workspace_id="ws",
        transcription_id="t",
        title="Reunião longa",
        segments=[
            SegmentInput(index=i, start=i * 60.0, end=i * 60.0 + 60.0, text=long_text)
            for i in range(8)
        ],
    )
    indexer.drain()
    provider = FakeAnalyzerProvider(responder=lambda _request: "ok")
    query = KnowledgeQuery(repository=repository, embeddings=embeddings, vector_store=vector_store)
    answer = KnowledgeAnswer(query=query, provider=provider, model="m")
    result = answer.ask(workspace_id="ws", question="o que foi dito?", limit=5)
    request = provider.requests[0]
    assert sum(len(part) for part in request.context) <= ANSWER_CONTEXT_CHARS
    assert request.context  # ao menos um trecho entra, mesmo cortado
    assert request.metadata["num_ctx"] == CONTEXT_TOKENS
    assert len(result.sources) == len(request.context)  # fonte só do que foi usado
