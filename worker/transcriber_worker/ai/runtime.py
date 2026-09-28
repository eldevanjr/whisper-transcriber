"""Montagem dos componentes de IA a partir da configuração.

Concentra a criação do cliente Ollama, dos providers, do armazenamento de
conhecimento (PostgreSQL/pgvector ou SQLite/fallback) e dos serviços de análise,
indexação e consulta. Filas e estado da análise ficam sempre no SQLite local.
"""

from __future__ import annotations

from collections.abc import Callable

from ai_core import (
    EmbeddingProvider,
    KnowledgeRepository,
    LLMProvider,
    PrivacyMode,
    PrivacyPolicy,
    VectorStore,
)

from transcriber_worker.ai.analysis_store import SQLiteAnalysisStore
from transcriber_worker.ai.answer import KnowledgeAnswer
from transcriber_worker.ai.config import AiConfig
from transcriber_worker.ai.indexing import Indexer, IndexItem, IndexQueue
from transcriber_worker.ai.migration import migrate_fallback
from transcriber_worker.ai.ollama import (
    OllamaClient,
    OllamaEmbeddingProvider,
    OllamaLLMProvider,
    Post,
)
from transcriber_worker.ai.rag import KnowledgeQuery
from transcriber_worker.ai.service import AnalysisService
from transcriber_worker.ai.state import SQLiteQueueJournal
from transcriber_worker.ai.storage import StorageBackend, sqlite_storage
from transcriber_worker.ai.store import SQLiteStore

StorageFactory = Callable[[SQLiteStore], StorageBackend]


class AiRuntime:
    """Agrega todos os componentes de IA de uma sessão do worker."""

    def __init__(
        self,
        config: AiConfig,
        *,
        database_path: str = ":memory:",
        post: Post | None = None,
        storage_factory: StorageFactory | None = None,
    ) -> None:
        self._config = config
        self._database = SQLiteStore(database_path)
        self._analysis = SQLiteAnalysisStore(self._database)
        self._storage = (
            storage_factory(self._database)
            if storage_factory is not None
            else sqlite_storage(self._database, embedding_model=config.embedding_model)
        )
        self._repository = self._storage.repository
        self._vector_store = self._storage.vector_store
        self._client = OllamaClient(
            config.ollama_url, timeout=config.request_timeout_seconds, post=post
        )
        self._llm: LLMProvider = OllamaLLMProvider(self._client, default_model=config.llm_model)
        self._embeddings: EmbeddingProvider = OllamaEmbeddingProvider(
            self._client, default_model=config.embedding_model
        )
        mode = PrivacyMode.ALLOW_CLOUD if config.allow_remote_ollama else PrivacyMode.LOCAL_ONLY
        self._privacy = PrivacyPolicy(mode=mode)
        self._service = AnalysisService(config=config, provider=self._llm, store=self._database)
        self._indexer = Indexer(
            repository=self._repository,
            embeddings=self._embeddings,
            vector_store=self._vector_store,
            queue=IndexQueue(journal=SQLiteQueueJournal(self._database, "index", IndexItem)),
        )
        self._query = KnowledgeQuery(
            repository=self._repository,
            embeddings=self._embeddings,
            vector_store=self._vector_store,
            privacy=self._privacy,
        )
        self._answer = KnowledgeAnswer(
            query=self._query, provider=self._llm, model=config.llm_model
        )
        if self._storage.kind == "postgres":
            # O que ficou no SQLite enquanto o PostgreSQL esteve fora vai para ele.
            migrate_fallback(source=self._database, indexer=self._indexer)

    @property
    def config(self) -> AiConfig:
        return self._config

    @property
    def blocked_reason(self) -> str | None:
        """Motivo de a IA não poder rodar (Ollama público sem permissão explícita)."""
        if self._privacy.allows(self._llm.location):
            return None
        return (
            f"O Ollama em {self._client.base_url} está fora desta máquina/rede local. "
            "Ative 'Permitir Ollama remoto' para enviar transcrições para ele."
        )

    @property
    def privacy(self) -> PrivacyPolicy:
        return self._privacy

    @property
    def storage(self) -> StorageBackend:
        return self._storage

    @property
    def database(self) -> SQLiteStore:
        return self._database

    @property
    def repository(self) -> KnowledgeRepository:
        return self._repository

    @property
    def vector_store(self) -> VectorStore:
        return self._vector_store

    @property
    def analysis(self) -> SQLiteAnalysisStore:
        return self._analysis

    @property
    def llm(self) -> LLMProvider:
        return self._llm

    @property
    def client(self) -> OllamaClient:
        return self._client

    @property
    def embeddings(self) -> EmbeddingProvider:
        return self._embeddings

    @property
    def service(self) -> AnalysisService:
        return self._service

    @property
    def indexer(self) -> Indexer:
        return self._indexer

    @property
    def query(self) -> KnowledgeQuery:
        return self._query

    @property
    def answer(self) -> KnowledgeAnswer:
        return self._answer

    def shutdown(self) -> None:
        """App fechando: para o PostgreSQL local, se foi o app que o usou."""
        self._storage.shutdown()

    def close(self) -> None:
        if self._storage.kind != "sqlite":
            self._storage.close()
        self._database.close()
