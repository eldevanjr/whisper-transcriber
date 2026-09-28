from __future__ import annotations

from transcriber_worker.ai.entities import (
    AnalysisResult,
    Decision,
    DetectedTask,
    Person,
    Problem,
    Question,
    SegmentRef,
    Topic,
)


def test_segment_ref() -> None:
    ref = SegmentRef(segment_index=3, start=1.5, end=2.5)
    assert ref.segment_index == 3
    assert ref.start == 1.5
    assert ref.end == 2.5


def test_entities_have_generated_ids_and_defaults() -> None:
    topic = Topic(name="Deploy")
    task = DetectedTask(description="Fazer deploy")
    decision = Decision(description="Usar Postgres")
    problem = Problem(description="Fila travando")
    question = Question(question="Quando?")
    person = Person(name="João")

    for entity in (topic, task, decision, problem, question, person):
        assert entity.id
        assert entity.confidence == 0.0
        assert entity.source_segments == []

    assert topic.description is None
    assert task.assignee is None
    assert task.deadline is None
    assert task.status is None
    assert problem.severity is None
    assert question.answered is False
    assert person.role is None


def test_confidence_bounds() -> None:
    import pytest
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        Topic(name="x", confidence=1.5)


def test_analysis_result_is_empty() -> None:
    assert AnalysisResult().is_empty() is True
    assert AnalysisResult(topics=[Topic(name="x")]).is_empty() is False
    assert AnalysisResult(tasks=[DetectedTask(description="x")]).is_empty() is False
    assert AnalysisResult(decisions=[Decision(description="x")]).is_empty() is False
    assert AnalysisResult(problems=[Problem(description="x")]).is_empty() is False
    assert AnalysisResult(questions=[Question(question="x")]).is_empty() is False
    assert AnalysisResult(people=[Person(name="x")]).is_empty() is False
