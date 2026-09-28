from __future__ import annotations

from collections.abc import Sequence

from transcriber_worker.ai.queue import AnalysisItem, AnalysisQueue, AnalysisStatus


def _item(transcription_id: str = "t", start: float = 0.0) -> AnalysisItem:
    return AnalysisItem(
        transcription_id=transcription_id, start_time=start, end_time=start + 1.0, text="x"
    )


class MemoryJournal:
    """Journal em memória: guarda o último estado de cada item salvo."""

    def __init__(self, initial: Sequence[AnalysisItem] = ()) -> None:
        self.saved: dict[str, AnalysisItem] = {item.id: item for item in initial}

    def load(self) -> list[AnalysisItem]:
        return list(self.saved.values())

    def save(self, item: AnalysisItem) -> None:
        self.saved[item.id] = item

    def remove(self, ids: Sequence[str]) -> None:
        for item_id in ids:
            self.saved.pop(item_id, None)


def test_journal_receives_every_change_and_forgets_finished_items() -> None:
    journal = MemoryJournal()
    queue = AnalysisQueue(journal=journal)
    item = queue.enqueue(_item())
    assert journal.saved[item.id].status is AnalysisStatus.PENDING
    queue.dequeue()
    assert journal.saved[item.id].status is AnalysisStatus.PROCESSING
    queue.complete(item.id)
    assert item.id not in journal.saved


def test_failed_items_stay_in_the_journal() -> None:
    journal = MemoryJournal()
    queue = AnalysisQueue(max_attempts=1, journal=journal)
    item = queue.enqueue(_item())
    queue.dequeue()
    queue.fail(item.id, "json inválido")
    assert journal.saved[item.id].status is AnalysisStatus.FAILED


def test_restores_journal_and_requeues_interrupted_items() -> None:
    pending = _item(start=0.0)
    interrupted = _item(start=1.0).model_copy(
        update={"status": AnalysisStatus.PROCESSING, "attempts": 1}
    )
    journal = MemoryJournal([pending, interrupted])
    queue = AnalysisQueue(journal=journal)
    assert [item.status for item in queue.items()] == [AnalysisStatus.PENDING] * 2
    assert journal.saved[interrupted.id].status is AnalysisStatus.PENDING


def test_release_returns_item_without_spending_an_attempt() -> None:
    queue = AnalysisQueue(max_attempts=1)
    item = queue.enqueue(_item())
    queue.dequeue()
    released = queue.release(item.id, "Ollama offline")
    assert released.status is AnalysisStatus.PENDING
    assert released.attempts == 0
    assert released.error == "Ollama offline"


def test_remove_where_drops_items_from_queue_and_journal() -> None:
    journal = MemoryJournal()
    queue = AnalysisQueue(journal=journal)
    keep = queue.enqueue(_item("a"))
    queue.enqueue(_item("b"))
    removed = queue.remove_where(lambda item: item.transcription_id == "b")
    assert removed == 1
    assert [item.id for item in queue.items()] == [keep.id]
    assert list(journal.saved) == [keep.id]


def test_has_open_ignores_finished_items() -> None:
    queue = AnalysisQueue(max_attempts=1)
    item = queue.enqueue(_item("a"))
    assert queue.has_open(lambda entry: entry.transcription_id == "a") is True
    queue.dequeue()
    assert queue.has_open(lambda entry: entry.transcription_id == "a") is True
    queue.fail(item.id, "erro")
    assert queue.has_open(lambda entry: entry.transcription_id == "a") is False


def test_retry_failed_resets_attempts() -> None:
    queue = AnalysisQueue(max_attempts=1)
    item = queue.enqueue(_item("a"))
    queue.dequeue()
    queue.fail(item.id, "erro")
    assert queue.retry_failed(lambda entry: entry.transcription_id == "a") == 1
    retried = queue.get(item.id)
    assert retried is not None
    assert retried.status is AnalysisStatus.PENDING
    assert retried.attempts == 0
    assert retried.error is None


def test_purge_finished_only_when_nothing_is_open() -> None:
    queue = AnalysisQueue()
    first = queue.enqueue(_item(start=0.0))
    queue.enqueue(_item(start=1.0))
    queue.dequeue()
    queue.complete(first.id)
    queue.purge_finished()
    assert len(queue.items()) == 2  # ainda há pendente: o progresso do lote continua
    second = queue.dequeue()
    assert second is not None
    queue.cancel(second.id)
    queue.purge_finished()
    assert queue.items() == []


def test_item_removed_while_processing_can_still_be_settled() -> None:
    journal = MemoryJournal()
    queue = AnalysisQueue(journal=journal)
    item = queue.enqueue(_item("a"))
    queue.dequeue()
    queue.remove_where(lambda entry: entry.transcription_id == "a")
    done = queue.complete(item.id)  # a thread terminou depois da exclusão
    assert done.status is AnalysisStatus.COMPLETED
    assert queue.items() == []
    assert journal.saved == {}


def test_item_removed_while_processing_can_fail_or_be_released() -> None:
    queue = AnalysisQueue()
    first = queue.enqueue(_item("a", start=0.0))
    second = queue.enqueue(_item("a", start=1.0))
    queue.dequeue()
    queue.dequeue()
    queue.remove_where(lambda entry: entry.transcription_id == "a")
    queue.fail(first.id, "json inválido")
    queue.release(second.id, "offline")
    assert queue.items() == []
