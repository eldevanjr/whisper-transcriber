from __future__ import annotations

from transcriber_worker.ai.analysis_store import (
    EntityKind,
    SQLiteAnalysisStore,
    flatten_entities,
)
from transcriber_worker.ai.entities import (
    AnalysisResult,
    Decision,
    DetectedTask,
    Person,
    Problem,
    Question,
    Topic,
)
from transcriber_worker.ai.store import SQLiteStore


def _result() -> AnalysisResult:
    return AnalysisResult(
        topics=[Topic(name="Sincronização")],
        tasks=[DetectedTask(description="Fazer deploy")],
        decisions=[Decision(description="Usar Postgres")],
        problems=[Problem(description="Fila travando")],
        questions=[Question(question="Quando?")],
        people=[Person(name="João")],
    )


def _store() -> SQLiteAnalysisStore:
    return SQLiteAnalysisStore(SQLiteStore())


def test_flatten_entities_covers_all_kinds() -> None:
    records = flatten_entities(workspace_id="ws", transcription_id="t", result=_result())
    assert [record.kind for record in records] == [
        EntityKind.TOPIC,
        EntityKind.TASK,
        EntityKind.DECISION,
        EntityKind.PROBLEM,
        EntityKind.QUESTION,
        EntityKind.PERSON,
    ]
    assert {record.label for record in records} == {
        "Sincronização",
        "Fazer deploy",
        "Usar Postgres",
        "Fila travando",
        "Quando?",
        "João",
    }


def test_save_and_get() -> None:
    store = _store()
    result = _result()
    record = store.save(workspace_id="ws", transcription_id="t", result=result)
    assert record.result == result
    fetched = store.get(workspace_id="ws", transcription_id="t")
    assert fetched is not None
    assert fetched.result == result
    assert store.get(workspace_id="ws", transcription_id="missing") is None
    assert store.get(workspace_id="other", transcription_id="t") is None


def test_save_replaces_previous_entities() -> None:
    store = _store()
    store.save(
        workspace_id="ws",
        transcription_id="t",
        result=AnalysisResult(topics=[Topic(name="Antigo")]),
    )
    store.save(
        workspace_id="ws",
        transcription_id="t",
        result=AnalysisResult(topics=[Topic(name="Novo")]),
    )
    topics = store.list_entities(workspace_id="ws", kind=EntityKind.TOPIC, limit=10)
    assert [topic.label for topic in topics] == ["Novo"]


def test_search_and_list_entities() -> None:
    store = _store()
    store.save(workspace_id="ws", transcription_id="t", result=_result())
    found = store.search(workspace_id="ws", kind=EntityKind.TOPIC, query="sincro", limit=10)
    assert [entity.label for entity in found] == ["Sincronização"]
    assert store.search(workspace_id="ws", kind=EntityKind.TOPIC, query="zzz", limit=10) == []
    assert len(store.list_entities(workspace_id="ws", kind=EntityKind.PERSON, limit=10)) == 1
    assert store.list_entities(workspace_id="other", kind=EntityKind.PERSON, limit=10) == []


def test_delete() -> None:
    store = _store()
    store.save(workspace_id="ws", transcription_id="t", result=_result())
    store.delete(workspace_id="ws", transcription_id="t")
    assert store.get(workspace_id="ws", transcription_id="t") is None
    assert store.list_entities(workspace_id="ws", kind=EntityKind.TOPIC, limit=10) == []


def test_search_treats_wildcards_literally() -> None:
    store = _store()
    store.save(
        workspace_id="ws",
        transcription_id="t",
        result=AnalysisResult(topics=[Topic(name="Meta de 50%"), Topic(name="Meta de 500")]),
    )
    found = store.search(workspace_id="ws", kind=EntityKind.TOPIC, query="50%", limit=10)
    assert [record.label for record in found] == ["Meta de 50%"]
