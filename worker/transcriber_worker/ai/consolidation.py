"""Consolidação dos resultados incrementais (e da análise final).

O mesmo assunto não deve virar várias entidades (plano §7). A identidade lógica é
o texto principal normalizado, com tolerância a pequenas variações (similaridade)
e, nas tarefas, sem os nomes de pessoas — "João fará o deploy" e depois "Maria
fará o deploy" são a mesma tarefa, que passa a ser da Maria.

Estados: ``DETECTED`` na primeira aparição, ``CONFIRMED`` quando reaparece igual,
``UPDATED`` quando responsável/prazo/status mudam e ``CANCELLED`` quando o status
indica cancelamento.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Callable, Iterable, Mapping, Sequence
from difflib import SequenceMatcher
from typing import Any, Protocol, Self

from transcriber_worker.ai.entities import (
    AnalysisResult,
    Decision,
    DetectedTask,
    EntityState,
    Person,
    Problem,
    Question,
    SegmentRef,
    Topic,
)

# Acima disso, dois textos normalizados são o mesmo assunto.
SIMILARITY_THRESHOLD = 0.88
# Na reconciliação com a análise final, item só do incremental precisa desta confiança.
KEEP_UNCONFIRMED_CONFIDENCE = 0.8
_CANCELLED = re.compile(r"cancel|descart|abandon", re.IGNORECASE)
_PUNCTUATION = re.compile(r"[^\w\s]")
_STOPWORDS = frozenset({"o", "a", "os", "as", "de", "do", "da", "the"})


class _Consolidatable(Protocol):
    confidence: float
    state: EntityState
    source_segments: list[SegmentRef]

    def model_copy(
        self, *, update: Mapping[str, Any] | None = None, deep: bool = False
    ) -> Self: ...


def _key(value: str) -> str:
    """Minúsculas, sem acentos, pontuação e artigos: a forma comparável do texto."""
    decomposed = unicodedata.normalize("NFKD", value.lower())
    plain = "".join(char for char in decomposed if not unicodedata.combining(char))
    words = _PUNCTUATION.sub(" ", plain).split()
    return " ".join(word for word in words if word not in _STOPWORDS)


def _similar(left: str, right: str) -> bool:
    return left == right or SequenceMatcher(None, left, right).ratio() >= SIMILARITY_THRESHOLD


def _without_names(text: str, names: Sequence[str]) -> str:
    words = text.split()
    return " ".join(word for word in words if word not in names)


def _merge_sources(current: _Consolidatable, item: _Consolidatable) -> list[SegmentRef]:
    known = {ref.segment_index for ref in current.source_segments}
    return current.source_segments + [
        ref for ref in item.source_segments if ref.segment_index not in known
    ]


class _Bucket[T: _Consolidatable]:
    """Entidades de um tipo, casadas por similaridade do texto principal."""

    def __init__(self, text_of: Callable[[T], str], names: Sequence[str] = ()) -> None:
        self._text_of = text_of
        self._names = names
        self._entries: list[tuple[str, T]] = []

    def _identity(self, item: T) -> str:
        key = _key(self._text_of(item))
        return _without_names(key, self._names) if self._names else key

    def find(self, item: T) -> int | None:
        identity = self._identity(item)
        for position, (key, _current) in enumerate(self._entries):
            if _similar(key, identity):
                return position
        return None

    def add(self, item: T) -> None:
        identity = self._identity(item)
        if not identity:
            return
        position = self.find(item)
        if position is None:
            self._entries.append((identity, item))
            return
        key, current = self._entries[position]
        self._entries[position] = (key, _combine(current, item))

    def values(self) -> list[T]:
        return [item for _key_, item in self._entries]


def _combine[T: _Consolidatable](current: T, item: T) -> T:
    """Mantém o texto de maior confiança, une as fontes e aplica as atualizações."""
    sources = _merge_sources(current, item)
    base = item if item.confidence > current.confidence else current
    updated = base.model_copy(update={"source_segments": sources})
    state = EntityState.CONFIRMED
    if isinstance(updated, DetectedTask) and isinstance(item, DetectedTask):
        changes = {
            field: getattr(item, field)
            for field in ("assignee", "deadline", "status")
            if getattr(item, field) and getattr(item, field) != getattr(current, field)
        }
        for field, value in changes.items():
            setattr(updated, field, value)
        if changes:
            state = EntityState.UPDATED
        if updated.status and _CANCELLED.search(updated.status):
            state = EntityState.CANCELLED
    updated.state = state
    return updated


def _people_names(results: Sequence[AnalysisResult]) -> list[str]:
    names = {
        _key(name)
        for result in results
        for name in [
            *(person.name for person in result.people),
            *(task.assignee for task in result.tasks if task.assignee),
        ]
    }
    return sorted(word for name in names for word in name.split() if word)


def _initial_state[T: _Consolidatable](item: T) -> T:
    copy = item.model_copy()
    if isinstance(copy, DetectedTask) and copy.status and _CANCELLED.search(copy.status):
        copy.state = EntityState.CANCELLED
    return copy


def consolidate_results(results: Iterable[AnalysisResult]) -> AnalysisResult:
    """Une resultados (na ordem do tempo) em um único, sem duplicar assuntos."""
    ordered = list(results)
    topics: _Bucket[Topic] = _Bucket(lambda topic: topic.name)
    tasks: _Bucket[DetectedTask] = _Bucket(
        lambda task: task.description, names=_people_names(ordered)
    )
    decisions: _Bucket[Decision] = _Bucket(lambda decision: decision.description)
    problems: _Bucket[Problem] = _Bucket(lambda problem: problem.description)
    questions: _Bucket[Question] = _Bucket(lambda question: question.question)
    people: _Bucket[Person] = _Bucket(lambda person: person.name)
    model: str | None = None
    prompt_version: str | None = None
    summary: str | None = None
    for result in ordered:
        model = result.model or model
        prompt_version = result.prompt_version or prompt_version
        if summary is None and result.summary:
            summary = result.summary
        for topic in result.topics:
            topics.add(_initial_state(topic))
        for task in result.tasks:
            tasks.add(_initial_state(task))
        for decision in result.decisions:
            decisions.add(_initial_state(decision))
        for problem in result.problems:
            problems.add(_initial_state(problem))
        for question in result.questions:
            questions.add(_initial_state(question))
        for person in result.people:
            people.add(_initial_state(person))
    return AnalysisResult(
        summary=summary,
        topics=topics.values(),
        tasks=tasks.values(),
        decisions=decisions.values(),
        problems=problems.values(),
        questions=questions.values(),
        people=people.values(),
        model=model,
        prompt_version=prompt_version,
    )


def _reconcile_list[T: _Consolidatable](
    final: list[T], incremental: list[T], text_of: Callable[[T], str]
) -> list[T]:
    bucket: _Bucket[T] = _Bucket(text_of)
    for item in final:
        bucket.add(item)
    kept = bucket.values()
    for item in incremental:
        if not _key(text_of(item)):
            continue
        position = bucket.find(item)
        if position is None:
            if item.confidence >= KEEP_UNCONFIRMED_CONFIDENCE:
                kept.append(item)
            continue
        target = kept[position]
        target.source_segments = _merge_sources(target, item)
        target.confidence = max(target.confidence, item.confidence)
        if target.state is EntityState.DETECTED:
            target.state = EntityState.CONFIRMED
    return kept


def reconcile(final: AnalysisResult, incremental: AnalysisResult) -> AnalysisResult:
    """A análise final manda; o incremental só confirma (e une fontes).

    Item que só o incremental viu, com baixa confiança, é descartado: a passada
    sobre a transcrição inteira não encontrou evidência dele.
    """
    return AnalysisResult(
        summary=final.summary or incremental.summary,
        topics=_reconcile_list(final.topics, incremental.topics, lambda item: item.name),
        tasks=_reconcile_list(final.tasks, incremental.tasks, lambda item: item.description),
        decisions=_reconcile_list(
            final.decisions, incremental.decisions, lambda item: item.description
        ),
        problems=_reconcile_list(
            final.problems, incremental.problems, lambda item: item.description
        ),
        questions=_reconcile_list(
            final.questions, incremental.questions, lambda item: item.question
        ),
        people=_reconcile_list(final.people, incremental.people, lambda item: item.name),
        model=final.model or incremental.model,
        prompt_version=final.prompt_version or incremental.prompt_version,
    )
