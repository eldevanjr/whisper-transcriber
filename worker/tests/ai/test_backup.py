from __future__ import annotations

from pathlib import Path

from ai_core import (
    InMemoryKnowledgeRepository,
    KnowledgeChunk,
    KnowledgeDocument,
    Source,
    SourceKind,
)

from transcriber_worker.ai.analysis_store import SQLiteAnalysisStore
from transcriber_worker.ai.backup import (
    export_workspace,
    read_backup,
    restore_workspace,
    write_backup,
)
from transcriber_worker.ai.entities import AnalysisResult, Topic
from transcriber_worker.ai.store import SQLiteStore


def _analysis() -> SQLiteAnalysisStore:
    return SQLiteAnalysisStore(SQLiteStore())


def _result() -> AnalysisResult:
    return AnalysisResult(topics=[Topic(name="Sincronização", confidence=0.9)])


def _populate(repository: InMemoryKnowledgeRepository, workspace: str = "ws") -> None:
    _ = repository.add_source(Source(id="s1", type=SourceKind.TRANSCRIPT, title="r"))
    _ = repository.add_document(
        KnowledgeDocument(
            id="d1",
            workspace_id=workspace,
            source_id="s1",
            title="Doc",
            content="conteudo",
        )
    )
    repository.add_chunks(
        [KnowledgeChunk(id="c1", document_id="d1", workspace_id=workspace, content="sinc")]
    )


def test_export_and_restore_same_workspace() -> None:
    source = InMemoryKnowledgeRepository()
    _populate(source)
    backup = export_workspace(source, _analysis(), workspace_id="ws")
    assert backup.workspace_id == "ws"
    assert len(backup.documents) == 1
    assert backup.documents[0].source is not None
    assert len(backup.documents[0].chunks) == 1

    target = InMemoryKnowledgeRepository()
    report = restore_workspace(target, _analysis(), backup)
    assert (report.documents, report.chunks, report.sources) == (1, 1, 1)
    assert target.get_document("d1", workspace_id="ws") is not None
    assert len(target.get_chunks("d1", workspace_id="ws")) == 1


def test_restore_into_other_workspace_regenerates_ids() -> None:
    source = InMemoryKnowledgeRepository()
    _populate(source)
    backup = export_workspace(source, _analysis(), workspace_id="ws")

    target = InMemoryKnowledgeRepository()
    report = restore_workspace(target, _analysis(), backup, target_workspace_id="other")
    documents = target.list_documents("other")
    assert len(documents) == 1
    assert documents[0].id != "d1"
    assert documents[0].source_id is not None
    assert target.get_source(documents[0].source_id) is not None
    assert len(target.get_chunks(documents[0].id, workspace_id="other")) == 1
    assert report.chunks == 1


def test_document_without_source_or_chunks() -> None:
    source = InMemoryKnowledgeRepository()
    _ = source.add_document(KnowledgeDocument(id="d1", workspace_id="ws", title="Doc", content="c"))
    backup = export_workspace(source, _analysis(), workspace_id="ws")
    assert backup.documents[0].source is None

    target = InMemoryKnowledgeRepository()
    report = restore_workspace(target, _analysis(), backup)
    assert (report.documents, report.chunks, report.sources) == (1, 0, 0)


def test_write_and_read_backup(tmp_path: Path) -> None:
    source = InMemoryKnowledgeRepository()
    _populate(source)
    backup = export_workspace(source, _analysis(), workspace_id="ws")
    path = tmp_path / "backup.json"
    write_backup(backup, path)
    assert read_backup(path) == backup


def test_export_empty_workspace() -> None:
    backup = export_workspace(InMemoryKnowledgeRepository(), _analysis(), workspace_id="ws")
    assert backup.documents == []
    assert backup.analyses == []


def test_analyses_are_exported_and_restored(tmp_path: Path) -> None:
    repository = InMemoryKnowledgeRepository()
    source_analysis = _analysis()
    _ = source_analysis.save(workspace_id="ws", transcription_id="t1", result=_result())
    backup = export_workspace(repository, source_analysis, workspace_id="ws")
    assert [record.transcription_id for record in backup.analyses] == ["t1"]

    target_analysis = _analysis()
    report = restore_workspace(repository, target_analysis, backup, target_workspace_id="other")
    assert report.analyses == 1
    restored = target_analysis.get(workspace_id="other", transcription_id="t1")
    assert restored is not None
    assert restored.result.topics[0].name == "Sincronização"

    path = tmp_path / "backup.json"
    write_backup(backup, path)
    assert read_backup(path).analyses[0].transcription_id == "t1"
