"""Fila de trabalho genérica, thread-safe, com retry limitado.

Usada pela análise incremental (:mod:`transcriber_worker.ai.queue`) e pela
indexação de conhecimento (:mod:`transcriber_worker.ai.indexing`). Com um
:class:`QueueJournal`, cada mudança é persistida: o que estava pendente (ou em
processamento quando o app fechou) volta à fila na próxima abertura.
"""

from __future__ import annotations

import threading
from collections.abc import Callable, Mapping, Sequence
from datetime import UTC, datetime
from typing import Any, Protocol, Self


def now_utc() -> datetime:
    return datetime.now(UTC)


class QueuedItem(Protocol):
    """Item de fila: identificável, com estado e contagem de tentativas."""

    @property
    def id(self) -> str: ...

    @property
    def status(self) -> str: ...

    @property
    def attempts(self) -> int: ...

    def model_copy(
        self, *, update: Mapping[str, Any] | None = None, deep: bool = False
    ) -> Self: ...


class QueueJournal[T](Protocol):
    """Persistência dos itens da fila (os concluídos/cancelados são esquecidos)."""

    def load(self) -> list[T]: ...

    def save(self, item: T) -> None: ...

    def remove(self, ids: Sequence[str]) -> None: ...


class WorkQueue[T: QueuedItem]:
    """Fila FIFO de itens com estados e retry limitado."""

    PENDING = "PENDING"
    PROCESSING = "PROCESSING"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"
    CANCELLED = "CANCELLED"

    _FINISHED = (COMPLETED, CANCELLED)
    _OPEN = (PENDING, PROCESSING)

    def __init__(self, *, max_attempts: int = 3, journal: QueueJournal[T] | None = None) -> None:
        if max_attempts < 1:
            raise ValueError("max_attempts deve ser >= 1")
        self._max_attempts = max_attempts
        self._items: dict[str, T] = {}
        self._order: list[str] = []
        self._lock = threading.Lock()
        self._journal = journal
        # Itens tirados da fila enquanto uma thread os processava: o resultado é descartado.
        self._detached: dict[str, T] = {}
        if journal is not None:
            self._restore(journal)

    def _restore(self, journal: QueueJournal[T]) -> None:
        """Itens que estavam em processamento quando o processo caiu voltam a pendentes."""
        for item in journal.load():
            self._items[item.id] = item
            self._order.append(item.id)
            if item.status == self.PROCESSING:
                self._modified(item, self.PENDING)

    @property
    def max_attempts(self) -> int:
        return self._max_attempts

    def enqueue(self, item: T) -> T:
        with self._lock:
            self._items[item.id] = item
            self._order.append(item.id)
            self._persist(item)
        return item

    def enqueue_many(self, items: list[T]) -> list[T]:
        return [self.enqueue(item) for item in items]

    def dequeue(self) -> T | None:
        """Marca o item PENDING mais antigo como PROCESSING e conta a tentativa."""
        with self._lock:
            for item_id in self._order:
                item = self._items[item_id]
                if item.status == self.PENDING:
                    return self._modified(item, self.PROCESSING, attempts=item.attempts + 1)
        return None

    def complete(self, item_id: str) -> T:
        with self._lock:
            return self._modified(
                self._require(item_id),
                self.COMPLETED,
                processed_at=now_utc(),
                error=None,
            )

    def fail(self, item_id: str, error: str) -> T:
        """Volta a PENDING enquanto houver tentativas; senão marca FAILED."""
        with self._lock:
            item = self._require(item_id)
            if item.attempts >= self._max_attempts:
                return self._modified(item, self.FAILED, processed_at=now_utc(), error=error)
            return self._modified(item, self.PENDING, error=error)

    def release(self, item_id: str, error: str) -> T:
        """Devolve o item sem gastar tentativa (ex.: Ollama fora do ar: não é culpa do item)."""
        with self._lock:
            item = self._require(item_id)
            return self._modified(
                item, self.PENDING, attempts=max(item.attempts - 1, 0), error=error
            )

    def cancel(self, item_id: str) -> T:
        with self._lock:
            return self._modified(self._require(item_id), self.CANCELLED, processed_at=now_utc())

    def remove_where(self, predicate: Callable[[T], bool]) -> int:
        """Tira da fila (e do journal) os itens que atendem ao filtro; devolve quantos."""
        with self._lock:
            ids = [item_id for item_id in self._order if predicate(self._items[item_id])]
            for item_id in ids:
                item = self._items.pop(item_id)
                if item.status == self.PROCESSING:
                    self._detached[item_id] = item
            self._order = [item_id for item_id in self._order if item_id in self._items]
            if ids and self._journal is not None:
                self._journal.remove(ids)
        return len(ids)

    def has_open(self, predicate: Callable[[T], bool]) -> bool:
        """Há item pendente ou em processamento que atende ao filtro?"""
        with self._lock:
            return any(
                item.status in self._OPEN and predicate(item) for item in self._items.values()
            )

    def retry_failed(self, predicate: Callable[[T], bool]) -> int:
        """Volta itens FAILED a PENDING com as tentativas zeradas; devolve quantos."""
        with self._lock:
            failed = [
                item
                for item in self._items.values()
                if item.status == self.FAILED and predicate(item)
            ]
            for item in failed:
                self._modified(item, self.PENDING, attempts=0, error=None, processed_at=None)
        return len(failed)

    def purge_finished(self) -> None:
        """Lote encerrado (nada aberto): esquece concluídos/cancelados (o progresso recomeça)."""
        with self._lock:
            if any(item.status in self._OPEN for item in self._items.values()):
                return
            for item_id in [i for i, item in self._items.items() if item.status in self._FINISHED]:
                del self._items[item_id]
            self._order = [item_id for item_id in self._order if item_id in self._items]

    def get(self, item_id: str) -> T | None:
        with self._lock:
            return self._items.get(item_id)

    def items(self) -> list[T]:
        with self._lock:
            return [self._items[item_id] for item_id in self._order]

    def counts(self) -> dict[str, int]:
        statuses = (self.PENDING, self.PROCESSING, self.COMPLETED, self.FAILED, self.CANCELLED)
        with self._lock:
            return {status: self._count(status) for status in statuses}

    def _count(self, status: str) -> int:
        return sum(1 for item in self._items.values() if item.status == status)

    def _require(self, item_id: str) -> T:
        item = self._items.get(item_id) or self._detached.get(item_id)
        if item is None:
            raise KeyError(item_id)
        return item

    def _modified(self, item: T, status: str, **changes: Any) -> T:
        """Aplica mudanças coagindo o status de volta ao enum concreto do item."""
        changes["status"] = type(item.status)(status)
        updated = item.model_copy(update=changes)
        if item.id in self._detached:
            del self._detached[item.id]
            return updated
        self._items[item.id] = updated
        self._persist(updated)
        return updated

    def _persist(self, item: T) -> None:
        if self._journal is None:
            return
        if item.status in self._FINISHED:
            self._journal.remove([item.id])
        else:
            self._journal.save(item)
