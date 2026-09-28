from __future__ import annotations

from transcriber_worker.ai.consolidation import consolidate_results, reconcile
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


def _indices(entity: Topic | DetectedTask | Decision | Problem | Question | Person) -> set[int]:
    return {ref.segment_index for ref in entity.source_segments}


def _ref(index: int, start: float) -> SegmentRef:
    return SegmentRef(segment_index=index, start=start, end=start + 1.0)


def test_consolidates_all_types_and_merges_sources() -> None:
    low = AnalysisResult(
        topics=[Topic(name="Deploy", confidence=0.4, source_segments=[_ref(1, 0.0)])],
        tasks=[
            DetectedTask(description="Subir API", confidence=0.5, source_segments=[_ref(2, 1.0)])
        ],
        decisions=[Decision(description="Usar fila", confidence=0.5)],
        problems=[Problem(description="Timeout", confidence=0.5)],
        questions=[Question(question="Quando?", confidence=0.5)],
        people=[Person(name="João", confidence=0.5)],
        model="m1",
    )
    high = AnalysisResult(
        topics=[Topic(name="  deploy ", confidence=0.9, source_segments=[_ref(3, 2.0)])],
        tasks=[
            DetectedTask(description="subir api", confidence=0.2, source_segments=[_ref(4, 3.0)])
        ],
        decisions=[Decision(description="USAR FILA", confidence=0.9)],
        problems=[Problem(description="Timeout", confidence=0.9)],
        questions=[Question(question="quando?", confidence=0.9)],
        people=[Person(name="JOÃO", confidence=0.9)],
        prompt_version="p2",
    )
    merged = consolidate_results([low, high])
    assert len(merged.topics) == 1
    assert merged.topics[0].confidence == 0.9
    assert _indices(merged.topics[0]) == {1, 3}
    # A tarefa de maior confiança continua a de baixo, mas as fontes são unidas.
    assert len(merged.tasks) == 1
    assert merged.tasks[0].confidence == 0.5
    assert _indices(merged.tasks[0]) == {2, 4}
    assert len(merged.decisions) == 1
    assert len(merged.problems) == 1
    assert len(merged.questions) == 1
    assert len(merged.people) == 1
    assert merged.model == "m1"
    assert merged.prompt_version == "p2"


def test_empty_keys_are_skipped() -> None:
    merged = consolidate_results(
        [AnalysisResult(topics=[Topic(name="   ")], people=[Person(name="")])]
    )
    assert merged.topics == []
    assert merged.people == []


def test_model_and_prompt_version_precedence() -> None:
    first = AnalysisResult(model=None, prompt_version="p1")
    second = AnalysisResult(model="m2", prompt_version=None)
    merged = consolidate_results([first, second])
    assert merged.model == "m2"
    assert merged.prompt_version == "p1"


def test_empty_input() -> None:
    merged = consolidate_results([])
    assert merged.is_empty() is True


def test_summary_keeps_the_first_non_empty() -> None:
    merged = consolidate_results(
        [
            AnalysisResult(summary="Resumo final"),
            AnalysisResult(summary="Resumo da janela"),
            AnalysisResult(summary=None),
        ]
    )
    assert merged.summary == "Resumo final"


def test_summary_only_when_present() -> None:
    assert consolidate_results([AnalysisResult()]).summary is None
    assert consolidate_results([AnalysisResult(summary="")]).summary is None
    assert consolidate_results([AnalysisResult(summary="ok")]).summary == "ok"


def test_first_sighting_is_detected_and_repeats_are_confirmed() -> None:
    merged = consolidate_results(
        [
            AnalysisResult(topics=[Topic(name="Deploy"), Topic(name="Orçamento")]),
            AnalysisResult(topics=[Topic(name="deploy")]),
        ]
    )
    states = {topic.name: topic.state for topic in merged.topics}
    assert states == {"Deploy": EntityState.CONFIRMED, "Orçamento": EntityState.DETECTED}


def test_near_duplicate_texts_are_the_same_entity() -> None:
    merged = consolidate_results(
        [
            AnalysisResult(decisions=[Decision(description="Usar SQLite no modo offline")]),
            AnalysisResult(decisions=[Decision(description="usar o SQLite no modo offline.")]),
        ]
    )
    assert len(merged.decisions) == 1


def test_different_texts_stay_separate() -> None:
    merged = consolidate_results(
        [AnalysisResult(topics=[Topic(name="Deploy"), Topic(name="Contratação")])]
    )
    assert len(merged.topics) == 2


def test_reassigned_task_is_updated_not_duplicated() -> None:
    merged = consolidate_results(
        [
            AnalysisResult(
                tasks=[DetectedTask(description="João fará o deploy", assignee="João")],
                people=[Person(name="João")],
            ),
            AnalysisResult(
                tasks=[DetectedTask(description="Maria fará o deploy", assignee="Maria")],
                people=[Person(name="Maria")],
            ),
        ]
    )
    assert len(merged.tasks) == 1
    task = merged.tasks[0]
    assert task.assignee == "Maria"
    assert task.state is EntityState.UPDATED


def test_new_deadline_updates_the_task() -> None:
    merged = consolidate_results(
        [
            AnalysisResult(tasks=[DetectedTask(description="Enviar relatório")]),
            AnalysisResult(tasks=[DetectedTask(description="enviar relatório", deadline="sexta")]),
        ]
    )
    assert merged.tasks[0].deadline == "sexta"
    assert merged.tasks[0].state is EntityState.UPDATED


def test_cancelled_task_is_marked_cancelled() -> None:
    merged = consolidate_results(
        [
            AnalysisResult(tasks=[DetectedTask(description="Migrar banco")]),
            AnalysisResult(tasks=[DetectedTask(description="migrar banco", status="cancelada")]),
        ]
    )
    assert merged.tasks[0].state is EntityState.CANCELLED


def test_reconcile_keeps_final_and_confirmed_incremental_items() -> None:
    final = AnalysisResult(
        summary="Resumo final",
        topics=[Topic(name="Deploy", source_segments=[_ref(1, 0.0)])],
    )
    incremental = AnalysisResult(
        summary="Resumo parcial",
        topics=[
            Topic(name="deploy", confidence=0.4, source_segments=[_ref(5, 9.0)]),
            Topic(name="Boato sem evidência", confidence=0.3),
            Topic(name="Orçamento", confidence=0.9),
        ],
    )
    merged = reconcile(final, incremental)
    names = {topic.name: topic for topic in merged.topics}
    assert set(names) == {"Deploy", "Orçamento"}
    assert names["Deploy"].state is EntityState.CONFIRMED
    assert _indices(names["Deploy"]) == {1, 5}
    assert merged.summary == "Resumo final"


def test_reconcile_without_final_summary_uses_incremental() -> None:
    merged = reconcile(AnalysisResult(), AnalysisResult(summary="parcial"))
    assert merged.summary == "parcial"


def test_reconcile_ignores_empty_items_and_keeps_later_states() -> None:
    final = AnalysisResult(
        tasks=[DetectedTask(description="Deploy", state=EntityState.UPDATED, assignee="Ana")]
    )
    incremental = AnalysisResult(
        topics=[Topic(name="  ", confidence=0.95)],
        tasks=[DetectedTask(description="deploy")],
    )
    merged = reconcile(final, incremental)
    assert merged.topics == []
    assert merged.tasks[0].state is EntityState.UPDATED
