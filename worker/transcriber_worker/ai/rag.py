"""Consulta RAG sobre o conhecimento indexado (respeitando o workspace).

Busca híbrida (plano §16): os trechos da busca vetorial vêm primeiro e a busca
textual completa com o que os embeddings não trouxeram. Sem embeddings (Ollama
fora do ar) ou com o índice pedindo reindexação, a busca textual responde sozinha
— o fallback do plano §12 mantém a busca funcionando.
"""

from __future__ import annotations

import re
from typing import Any, Protocol, runtime_checkable

from ai_core import (
    ConfigurationError,
    EmbeddingProvider,
    KnowledgeChunk,
    KnowledgeRepository,
    PrivacyPolicy,
    RepositoryKnowledgeSearch,
    SearchRequest,
    SearchResult,
    Source,
    VectorStore,
)

from transcriber_worker.ai.ollama import OllamaError

# Palavras curtas (artigos, preposições) não ajudam a achar trechos.
_MIN_KEYWORD = 4
_MAX_KEYWORDS = 8
_TEXT_SCORE = 0.5
_WORD = re.compile(r"\w+", re.UNICODE)


@runtime_checkable
class TextSearchable(Protocol):
    """Repositório com busca textual (SQLite e PostgreSQL do app têm)."""

    def search_text(
        self, *, workspace_id: str, query: str, limit: int = 10
    ) -> list[KnowledgeChunk]: ...


def keywords(query: str) -> list[str]:
    """Palavras relevantes da consulta, sem repetição, na ordem em que aparecem."""
    seen: dict[str, None] = {}
    for word in _WORD.findall(query.lower()):
        if len(word) >= _MIN_KEYWORD:
            seen.setdefault(word, None)
    return list(seen)[:_MAX_KEYWORDS]


class KnowledgeQuery:
    """Fachada de busca sobre o conhecimento de um workspace.

    A política de privacidade é conferida em cada busca: provider fora desta
    máquina/rede é recusado com ``LOCAL_ONLY``.
    """

    def __init__(
        self,
        *,
        repository: KnowledgeRepository,
        embeddings: EmbeddingProvider,
        vector_store: VectorStore,
        privacy: PrivacyPolicy | None = None,
    ) -> None:
        self._repository = repository
        self._embeddings = embeddings
        self._vector_store = vector_store
        self._privacy = privacy or PrivacyPolicy()

    def search(
        self,
        *,
        workspace_id: str,
        query: str,
        limit: int = 10,
        filters: dict[str, Any] | None = None,
    ) -> list[SearchResult]:
        self._privacy.assert_allowed(self._embeddings.location)
        request = SearchRequest(
            workspace_id=workspace_id, query=query, limit=limit, filters=filters or {}
        )
        try:
            vector = RepositoryKnowledgeSearch(
                repository=self._repository,
                embeddings=self._embeddings,
                vector_store=self._vector_store,
                privacy=self._privacy,
            ).search(request)
        except (OllamaError, ConfigurationError):
            vector = []
        seen = {result.chunk.id for result in vector}
        text = [result for result in self._text_search(request) if result.chunk.id not in seen]
        return [*vector, *text][:limit]

    def _text_search(self, request: SearchRequest) -> list[SearchResult]:
        repository = self._repository
        words = keywords(request.query)
        if not isinstance(repository, TextSearchable):
            return []
        hits: dict[str, tuple[KnowledgeChunk, int]] = {}
        for word in words:
            for chunk in repository.search_text(
                workspace_id=request.workspace_id, query=word, limit=request.limit * 4
            ):
                if not _matches(chunk, request.filters):
                    continue
                _chunk, count = hits.get(chunk.id, (chunk, 0))
                hits[chunk.id] = (chunk, count + 1)
        ranked = sorted(hits.values(), key=lambda entry: (-entry[1], entry[0].position))
        return [
            SearchResult(
                chunk=chunk,
                score=_TEXT_SCORE * count / len(words),
                source=self._source_of(chunk),
                metadata={**chunk.metadata, "match": "text"},
            )
            for chunk, count in ranked[: request.limit]
        ]

    def _source_of(self, chunk: KnowledgeChunk) -> Source | None:
        document = self._repository.get_document(chunk.document_id, workspace_id=chunk.workspace_id)
        if document is None or document.source_id is None:
            return None
        return self._repository.get_source(document.source_id)


def _matches(chunk: KnowledgeChunk, filters: dict[str, Any]) -> bool:
    return all(chunk.metadata.get(key) == value for key, value in filters.items())
