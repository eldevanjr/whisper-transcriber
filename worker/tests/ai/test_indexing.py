from __future__ import annotations

import pytest
from ai_core import (
    InMemoryKnowledgeRepository,
    InMemoryVectorStore,
    KnowledgeChunk,
    KnowledgeDocument,
)

from tests.ai.fakes import FakeEmbedder
from transcriber_worker.ai.indexing import (
    Indexer,
    IndexItem,
    IndexQueue,
    IndexStatus,
    build_segment_chunks,
)
from transcriber_worker.ai.ollama import OllamaError, OllamaUnavailableError
from transcriber_worker.ai.windows import SegmentInput


def _seg(index: int, start: float, end: float, text: str) -> SegmentInput:
    return SegmentInput(index=index, start=start, end=end, text=text)


def _segments() -> list[SegmentInput]:
    return [_seg(0, 0.0, 10.0, "a b"), _seg(1, 10.0, 20.0, "c d"), _seg(2, 20.0, 30.0, "e f")]


def _indexer(
    *,
    embeddings: FakeEmbedder | None = None,
    queue: IndexQueue | None = None,
) -> Indexer:
    return Indexer(
        repository=InMemoryKnowledgeRepository(),
        embeddings=embeddings or FakeEmbedder(dimension=3),
        vector_store=InMemoryVectorStore(),
        queue=queue,
    )


def test_build_segment_chunks_empty() -> None:
    assert build_segment_chunks([]) == []


@pytest.mark.parametrize(
    ("max_tokens", "overlap_tokens"),
    [(0, 0), (5, 5)],
)
def test_build_segment_chunks_invalid(max_tokens: int, overlap_tokens: int) -> None:
    with pytest.raises(ValueError, match=r"max_tokens|overlap_tokens"):
        build_segment_chunks(_segments(), max_tokens=max_tokens, overlap_tokens=overlap_tokens)


def test_build_segment_chunks_groups_with_overlap() -> None:
    chunks = build_segment_chunks(_segments(), max_tokens=4, overlap_tokens=2)
    assert [chunk.content for chunk in chunks] == ["a b c d", "c d e f"]
    assert [chunk.segment_indices for chunk in chunks] == [[0, 1], [1, 2]]
    assert chunks[0].start == 0.0
    assert chunks[0].end == 20.0


def test_build_segment_chunks_single_large_segment() -> None:
    chunks = build_segment_chunks([_seg(0, 0.0, 5.0, "a b c d e")], max_tokens=3, overlap_tokens=1)
    assert [chunk.content for chunk in chunks] == ["a b c d e"]


def test_tail_overlap_keeps_whole_current_window() -> None:
    segments = [_seg(0, 0.0, 1.0, "a"), _seg(1, 1.0, 2.0, "b c d e f g h i j k")]
    chunks = build_segment_chunks(segments, max_tokens=10, overlap_tokens=9)
    assert [chunk.content for chunk in chunks] == ["a", "a b c d e f g h i j k"]


def test_index_transcription_persists_and_enqueues() -> None:
    indexer = _indexer()
    outcome = indexer.index_transcription(
        workspace_id="ws", transcription_id="t1", title="Reunião", segments=_segments()
    )
    assert outcome.document.workspace_id == "ws"
    assert outcome.document.source_id is not None
    assert len(outcome.items) == 1
    assert indexer.progress()["PENDING"] == 1
    assert indexer.queue.items()[0].document_id == outcome.document.id


def test_process_and_drain_indexes_vectors() -> None:
    indexer = _indexer()
    _ = indexer.index_transcription(
        workspace_id="ws", transcription_id="t1", title="Reunião", segments=_segments()
    )
    assert indexer.drain() == 1
    assert indexer.progress()["COMPLETED"] == 1
    item = indexer.queue.items()[0]
    chunk = indexer._repository.get_chunk(item.chunk_id, workspace_id="ws")
    assert chunk is not None
    assert chunk.embedding_reference == "fake-embed:3"


def test_reindex_rebuilds_vectors() -> None:
    indexer = _indexer()
    _ = indexer.index_transcription(
        workspace_id="ws", transcription_id="t1", title="Reunião", segments=_segments()
    )
    _ = indexer.drain()
    assert indexer.reindex(workspace_id="ws") == 1
    assert indexer.drain() == 1
    assert indexer.progress()["COMPLETED"] == 2
    assert indexer.reindex(workspace_id="unknown") == 0


def test_delete_transcription_removes_document_and_vectors() -> None:
    indexer = _indexer()
    outcome = indexer.index_transcription(
        workspace_id="ws", transcription_id="t1", title="Reunião", segments=_segments()
    )
    _ = indexer.drain()
    indexer.delete_transcription(workspace_id="ws", transcription_id="t1")
    assert indexer._repository.list_documents("ws") == []
    assert not indexer._vector_store.query(workspace_id="ws", vector=[0.5, 0.5, 0.5], limit=10)
    assert outcome.document.id


def test_process_failure_retries_with_ollama_error() -> None:
    indexer = _indexer(embeddings=FakeEmbedder(error=OllamaError("offline")))
    _ = indexer.index_transcription(
        workspace_id="ws", transcription_id="t1", title="Reunião", segments=_segments()
    )
    first = indexer.process_next()
    assert first is not None
    assert first.status == "PENDING"
    assert first.error == "offline"
    for _ in range(2):
        _ = indexer.process_next()
    assert indexer.progress()["FAILED"] == 1


def test_process_failure_with_dimension_mismatch() -> None:
    indexer = Indexer(
        repository=InMemoryKnowledgeRepository(),
        embeddings=FakeEmbedder(variable=True),
        vector_store=InMemoryVectorStore(),
        max_tokens=1,
        overlap_tokens=0,
    )
    segments = [_seg(0, 0.0, 1.0, "ab"), _seg(1, 1.0, 2.0, "abcd")]
    _ = indexer.index_transcription(
        workspace_id="ws", transcription_id="t1", title="Reunião", segments=segments
    )
    _ = indexer.process_next()  # primeiro: dim 2
    for _ in range(3):  # segundo: dim 4, conflita e esgota as tentativas
        _ = indexer.process_next()
    assert indexer.progress()["FAILED"] == 1
    assert indexer.progress()["COMPLETED"] == 1


def test_process_completes_when_chunk_is_gone() -> None:
    indexer = _indexer()
    outcome = indexer.index_transcription(
        workspace_id="ws", transcription_id="t1", title="Reunião", segments=_segments()
    )
    indexer._repository.delete_document(outcome.document.id, workspace_id="ws")
    item = indexer.process_next()
    assert item is not None
    assert item.status == "COMPLETED"
    assert indexer.progress()["COMPLETED"] == 1


def test_reindex_includes_documents_without_transcription_metadata() -> None:
    indexer = _indexer()
    document = indexer._repository.add_document(
        KnowledgeDocument(workspace_id="ws", title="Avulso", content="conteúdo")
    )
    indexer._repository.add_chunks(
        [KnowledgeChunk(document_id=document.id, workspace_id="ws", content="conteúdo", position=0)]
    )
    assert indexer.reindex(workspace_id="ws") == 1
    assert indexer.queue.items()[0].transcription_id == ""


def test_delete_transcription_keeps_other_transcriptions() -> None:
    indexer = _indexer()
    _ = indexer.index_transcription(
        workspace_id="ws", transcription_id="t1", title="Reunião 1", segments=_segments()
    )
    _ = indexer.index_transcription(
        workspace_id="ws", transcription_id="t2", title="Reunião 2", segments=_segments()
    )
    indexer.delete_transcription(workspace_id="ws", transcription_id="t1")
    remaining = indexer._repository.list_documents("ws")
    assert [document.metadata.get("transcription_id") for document in remaining] == ["t2"]


def test_index_queue_status_defaults() -> None:
    item = IndexItem(
        workspace_id="ws",
        transcription_id="t",
        document_id="d",
        chunk_id="c",
        content="x",
    )
    queue = IndexQueue()
    _ = queue.enqueue(item)
    assert item.created_at.tzinfo is not None
    assert item.processed_at is None
    dequeued = queue.dequeue()
    assert dequeued is not None
    assert dequeued.status == "PROCESSING"


def test_indexing_again_replaces_previous_knowledge() -> None:
    indexer = _indexer()
    first = indexer.index_transcription(
        workspace_id="ws", transcription_id="t", title="R", segments=_segments()
    )
    indexer.drain()
    second = indexer.index_transcription(
        workspace_id="ws", transcription_id="t", title="R", segments=_segments()
    )
    repository = indexer.repository
    documents = repository.list_documents("ws")
    assert [document.id for document in documents] == [second.document.id]
    assert repository.get_chunks(first.document.id, workspace_id="ws") == []
    assert [item.document_id for item in indexer.queue.items()] == [second.document.id]


def test_offline_embeddings_release_the_item() -> None:
    indexer = _indexer(embeddings=FakeEmbedder(error=OllamaUnavailableError("off")))
    indexer.index_transcription(
        workspace_id="ws", transcription_id="t", title="R", segments=_segments()
    )
    for _ in range(4):
        item = indexer.process_next()
        assert item is not None
        assert item.status is IndexStatus.PENDING
        assert item.attempts == 0
    assert indexer.drain() == 0  # não fica girando com o Ollama fora do ar


def test_cancel_pending_only_touches_the_workspace() -> None:
    indexer = _indexer()
    indexer.index_transcription(
        workspace_id="ws", transcription_id="t", title="R", segments=_segments()
    )
    indexer.index_transcription(
        workspace_id="other", transcription_id="u", title="R", segments=_segments()
    )
    assert indexer.cancel_pending("ws") == 1
    assert [item.workspace_id for item in indexer.queue.items()] == ["other"]


def test_forget_drops_queued_items_and_knowledge() -> None:
    indexer = _indexer()
    indexer.index_transcription(
        workspace_id="ws", transcription_id="t", title="R", segments=_segments()
    )
    indexer.delete_transcription(workspace_id="ws", transcription_id="t")
    assert indexer.queue.items() == []
    assert indexer.repository.list_documents("ws") == []
