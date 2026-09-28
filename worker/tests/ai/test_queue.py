from __future__ import annotations

import pytest

from transcriber_worker.ai.queue import AnalysisItem, AnalysisQueue, AnalysisStatus


def _item(start: float = 0.0) -> AnalysisItem:
    return AnalysisItem(transcription_id="t", start_time=start, end_time=start + 1.0, text="x")


def test_max_attempts_must_be_positive() -> None:
    with pytest.raises(ValueError, match="max_attempts"):
        AnalysisQueue(max_attempts=0)


def test_empty_queue() -> None:
    queue = AnalysisQueue()
    assert queue.max_attempts == 3
    assert queue.dequeue() is None
    assert queue.items() == []
    assert queue.counts()[AnalysisStatus.PENDING] == 0


def test_enqueue_dequeue_complete() -> None:
    queue = AnalysisQueue()
    item = _item()
    queue.enqueue(item)
    assert queue.get(item.id) is item
    assert queue.items() == [item]
    assert queue.counts()[AnalysisStatus.PENDING] == 1

    claimed = queue.dequeue()
    assert claimed is not None
    assert claimed.status is AnalysisStatus.PROCESSING
    assert claimed.attempts == 1
    assert queue.dequeue() is None

    done = queue.complete(item.id)
    assert done.status is AnalysisStatus.COMPLETED
    assert done.processed_at is not None
    assert queue.counts()[AnalysisStatus.COMPLETED] == 1


def test_enqueue_many_preserves_order() -> None:
    queue = AnalysisQueue()
    items = queue.enqueue_many([_item(0.0), _item(1.0)])
    assert [i.start_time for i in queue.items()] == [0.0, 1.0]
    first = queue.dequeue()
    assert first is not None
    assert first.id == items[0].id


def test_fail_retries_then_fails() -> None:
    queue = AnalysisQueue(max_attempts=2)
    item = queue.enqueue(_item())
    queue.dequeue()
    retry = queue.fail(item.id, "tentativa 1")
    assert retry.status is AnalysisStatus.PENDING
    assert retry.error == "tentativa 1"
    second = queue.dequeue()
    assert second is not None
    assert second.attempts == 2
    failed = queue.fail(item.id, "tentativa 2")
    assert failed.status is AnalysisStatus.FAILED
    assert failed.processed_at is not None
    assert queue.dequeue() is None


def test_cancel() -> None:
    queue = AnalysisQueue()
    item = queue.enqueue(_item())
    cancelled = queue.cancel(item.id)
    assert cancelled.status is AnalysisStatus.CANCELLED
    assert cancelled.processed_at is not None


def test_unknown_id_raises() -> None:
    queue = AnalysisQueue()
    for action in (queue.complete, queue.cancel):
        with pytest.raises(KeyError):
            action("missing")
    with pytest.raises(KeyError):
        queue.fail("missing", "erro")


def test_counts_all_statuses() -> None:
    queue = AnalysisQueue()
    ids = [queue.enqueue(_item(float(i))).id for i in range(5)]
    _ = queue.dequeue()  # ids[0] -> PROCESSING
    queue.cancel(ids[1])  # CANCELLED
    _ = queue.dequeue()  # ids[2] -> PROCESSING
    queue.complete(ids[2])  # COMPLETED
    for _ in range(3):  # ids[3] -> FAILED após esgotar as tentativas
        _ = queue.dequeue()
        queue.fail(ids[3], "erro")
    counts = queue.counts()
    assert counts[AnalysisStatus.PENDING] == 1  # ids[4]
    assert counts[AnalysisStatus.PROCESSING] == 1  # ids[0]
    assert counts[AnalysisStatus.COMPLETED] == 1
    assert counts[AnalysisStatus.FAILED] == 1
    assert counts[AnalysisStatus.CANCELLED] == 1
