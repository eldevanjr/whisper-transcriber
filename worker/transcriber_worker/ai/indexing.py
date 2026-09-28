"""Indexação de conhecimento: segmentos → chunks → embeddings → vector store.

Independente da análise e da transcrição (nunca bloqueia nenhuma das duas).
Reutiliza as abstrações do ai-core (documento, chunk, fonte, repositório,
vector store, provider de embeddings).
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import datetime
from enum import StrEnum
from uuid import uuid4

from ai_core import (
    ConfigurationError,
    EmbeddingProvider,
    KnowledgeChunk,
    KnowledgeDocument,
    KnowledgeRepository,
    Source,
    SourceKind,
    VectorStore,
)
from pydantic import BaseModel, Field

from transcriber_worker.ai.ollama import OllamaError, OllamaUnavailableError
from transcriber_worker.ai.windows import SegmentInput
from transcriber_worker.ai.workqueue import WorkQueue, now_utc


class SegmentChunk(BaseModel):
    """Chunk derivado de segmentos, preservando o intervalo de tempo."""

    content: str
    start: float
    end: float
    segment_indices: list[int] = Field(default_factory=list)


def build_segment_chunks(
    segments: Sequence[SegmentInput],
    *,
    max_tokens: int = 600,
    overlap_tokens: int = 80,
) -> list[SegmentChunk]:
    """Agrupa segmentos em chunks por orçamento de tokens (palavras) com overlap."""
    if max_tokens < 1:
        raise ValueError("max_tokens deve ser >= 1")
    if overlap_tokens >= max_tokens:
        raise ValueError("overlap_tokens deve ser menor que max_tokens")
    if not segments:
        return []
    ordered = sorted(segments, key=lambda segment: (segment.start, segment.index))
    chunks: list[SegmentChunk] = []
    current: list[SegmentInput] = []
    current_tokens = 0
    for segment in ordered:
        segment_tokens = len(segment.text.split())
        if current and current_tokens + segment_tokens > max_tokens:
            chunks.append(_to_chunk(current))
            current = _tail_overlap(current, overlap_tokens)
            current_tokens = sum(len(item.text.split()) for item in current)
        current.append(segment)
        current_tokens += segment_tokens
    chunks.append(_to_chunk(current))
    return chunks


def _tail_overlap(segments: list[SegmentInput], overlap_tokens: int) -> list[SegmentInput]:
    overlap: list[SegmentInput] = []
    total = 0
    for segment in reversed(segments):
        tokens = len(segment.text.split())
        if total + tokens > overlap_tokens:
            break
        overlap.insert(0, segment)
        total += tokens
    return overlap


def _to_chunk(segments: list[SegmentInput]) -> SegmentChunk:
    return SegmentChunk(
        content=" ".join(segment.text for segment in segments).strip(),
        start=segments[0].start,
        end=segments[-1].end,
        segment_indices=[segment.index for segment in segments],
    )


class IndexStatus(StrEnum):
    PENDING = "PENDING"
    PROCESSING = "PROCESSING"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"
    CANCELLED = "CANCELLED"


class IndexItem(BaseModel):
    """Chunk aguardando geração de embedding e persistência vetorial."""

    id: str = Field(default_factory=lambda: uuid4().hex)
    workspace_id: str
    transcription_id: str
    document_id: str
    chunk_id: str
    content: str
    status: IndexStatus = IndexStatus.PENDING
    attempts: int = 0
    created_at: datetime = Field(default_factory=now_utc)
    processed_at: datetime | None = None
    error: str | None = None


class IndexQueue(WorkQueue[IndexItem]):
    """Fila FIFO de indexação com retry limitado."""


class IndexOutcome(BaseModel):
    document: KnowledgeDocument
    items: list[IndexItem]


class Indexer:
    """Orquestra a indexação de transcrições e a reindexação de conhecimento."""

    def __init__(
        self,
        *,
        repository: KnowledgeRepository,
        embeddings: EmbeddingProvider,
        vector_store: VectorStore,
        queue: IndexQueue | None = None,
        max_tokens: int = 600,
        overlap_tokens: int = 80,
    ) -> None:
        self._repository = repository
        self._embeddings = embeddings
        self._vector_store = vector_store
        self._queue = queue or IndexQueue()
        self._max_tokens = max_tokens
        self._overlap_tokens = overlap_tokens

    @property
    def queue(self) -> IndexQueue:
        return self._queue

    @property
    def repository(self) -> KnowledgeRepository:
        return self._repository

    def index_transcription(
        self,
        *,
        workspace_id: str,
        transcription_id: str,
        title: str,
        segments: Sequence[SegmentInput],
    ) -> IndexOutcome:
        """Persiste documento/chunks e enfileira a geração de embeddings.

        Refazer a mesma transcrição substitui o conhecimento anterior (sem duplicar).
        """
        self.delete_transcription(workspace_id=workspace_id, transcription_id=transcription_id)
        chunks = build_segment_chunks(
            segments, max_tokens=self._max_tokens, overlap_tokens=self._overlap_tokens
        )
        source = self._repository.add_source(
            Source(
                type=SourceKind.TRANSCRIPT,
                title=title,
                metadata={"transcription_id": transcription_id},
            )
        )
        document = self._repository.add_document(
            KnowledgeDocument(
                workspace_id=workspace_id,
                source_id=source.id,
                title=title,
                content=" ".join(segment.text for segment in segments).strip(),
                metadata={"transcription_id": transcription_id},
            )
        )
        knowledge_chunks = [
            KnowledgeChunk(
                document_id=document.id,
                workspace_id=workspace_id,
                content=chunk.content,
                position=position,
                metadata={
                    "transcription_id": transcription_id,
                    "start_time": chunk.start,
                    "end_time": chunk.end,
                },
            )
            for position, chunk in enumerate(chunks)
        ]
        self._repository.add_chunks(knowledge_chunks)
        items = self._queue.enqueue_many(
            [
                IndexItem(
                    workspace_id=workspace_id,
                    transcription_id=transcription_id,
                    document_id=document.id,
                    chunk_id=chunk.id,
                    content=chunk.content,
                )
                for chunk in knowledge_chunks
            ]
        )
        return IndexOutcome(document=document, items=items)

    def process_next(self) -> IndexItem | None:
        """Gera o embedding do próximo chunk pendente. ``None`` se a fila vaziar."""
        item = self._queue.dequeue()
        if item is None:
            return None
        try:
            embedding = self._embeddings.embed(item.content)
            self._vector_store.upsert(
                chunk_id=item.chunk_id,
                workspace_id=item.workspace_id,
                vector=embedding.vector,
                metadata={
                    "transcription_id": item.transcription_id,
                    "document_id": item.document_id,
                },
            )
        except OllamaUnavailableError as exc:
            return self._queue.release(item.id, str(exc))
        except (OllamaError, ConfigurationError) as exc:
            return self._queue.fail(item.id, str(exc))
        self._mark_indexed(item, reference=f"{embedding.model}:{embedding.dimension}")
        return self._queue.complete(item.id)

    def drain(self) -> int:
        """Processa até a fila esvaziar ou um item não concluir (ex.: Ollama fora do ar)."""
        processed = 0
        while (item := self.process_next()) is not None and item.status is IndexStatus.COMPLETED:
            processed += 1
        return processed

    def cancel_pending(self, workspace_id: str) -> int:
        """Cancela a indexação ainda não iniciada do workspace (ex.: reindexação)."""
        return self._queue.remove_where(
            lambda item: item.workspace_id == workspace_id and item.status is IndexStatus.PENDING
        )

    def reindex(self, *, workspace_id: str) -> int:
        """Recria o índice vetorial do workspace a partir dos chunks persistidos."""
        self._vector_store.delete_workspace(workspace_id)
        return sum(
            len(
                self.enqueue_document(
                    document, self._repository.get_chunks(document.id, workspace_id=workspace_id)
                )
            )
            for document in self._repository.list_documents(workspace_id)
        )

    def enqueue_document(
        self, document: KnowledgeDocument, chunks: Sequence[KnowledgeChunk]
    ) -> list[IndexItem]:
        """Enfileira embeddings para chunks já persistidos (reindexação/migração).

        Item já na fila para o mesmo chunk é substituído (não gera embedding duas vezes).
        """
        transcription_id = str(document.metadata.get("transcription_id", ""))
        chunk_ids = {chunk.id for chunk in chunks}
        waiting = (IndexStatus.PENDING, IndexStatus.FAILED)
        self._queue.remove_where(lambda item: item.chunk_id in chunk_ids and item.status in waiting)
        return self._queue.enqueue_many(
            [
                IndexItem(
                    workspace_id=document.workspace_id,
                    transcription_id=transcription_id,
                    document_id=document.id,
                    chunk_id=chunk.id,
                    content=chunk.content,
                )
                for chunk in chunks
            ]
        )

    def delete_transcription(self, *, workspace_id: str, transcription_id: str) -> None:
        """Remove o documento, seus chunks, os vetores e a indexação pendente da transcrição."""
        self._queue.remove_where(
            lambda item: (
                item.workspace_id == workspace_id and item.transcription_id == transcription_id
            )
        )
        for document in self._repository.list_documents(workspace_id):
            if document.metadata.get("transcription_id") != transcription_id:
                continue
            for chunk in self._repository.get_chunks(document.id, workspace_id=workspace_id):
                self._vector_store.delete(workspace_id=workspace_id, chunk_id=chunk.id)
            self._repository.delete_document(document.id, workspace_id=workspace_id)

    def progress(self) -> dict[str, int]:
        return self._queue.counts()

    def _mark_indexed(self, item: IndexItem, *, reference: str) -> None:
        chunk = self._repository.get_chunk(item.chunk_id, workspace_id=item.workspace_id)
        if chunk is not None:
            self._repository.add_chunks(
                [chunk.model_copy(update={"embedding_reference": reference})]
            )
