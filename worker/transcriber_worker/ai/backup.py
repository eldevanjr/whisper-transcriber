"""Backup e restauração do conhecimento e das análises de um workspace.

Exporta fontes, documentos, chunks e análises em JSON (sem embeddings, que são
regeneráveis via reindexação) e restaura em outro banco/workspace. Nunca inclui
credenciais ou segredos.
"""

from __future__ import annotations

from datetime import datetime
from pathlib import Path

from ai_core import (
    KnowledgeChunk,
    KnowledgeDocument,
    KnowledgeRepository,
    Source,
    new_id,
)
from pydantic import BaseModel, Field

from transcriber_worker.ai.analysis_store import AnalysisRecord, AnalysisStore
from transcriber_worker.ai.workqueue import now_utc

BACKUP_VERSION = 1


class BackupDocument(BaseModel):
    document: KnowledgeDocument
    source: Source | None = None
    chunks: list[KnowledgeChunk] = Field(default_factory=list)


class KnowledgeBackup(BaseModel):
    version: int = BACKUP_VERSION
    workspace_id: str
    created_at: datetime = Field(default_factory=now_utc)
    documents: list[BackupDocument] = Field(default_factory=list)
    analyses: list[AnalysisRecord] = Field(default_factory=list)


class RestoreReport(BaseModel):
    documents: int = 0
    chunks: int = 0
    sources: int = 0
    analyses: int = 0


def export_workspace(
    repository: KnowledgeRepository,
    analysis: AnalysisStore,
    *,
    workspace_id: str,
) -> KnowledgeBackup:
    """Coleta todo o conhecimento e as análises persistidos de um workspace."""
    entries: list[BackupDocument] = []
    for document in repository.list_documents(workspace_id):
        source = repository.get_source(document.source_id) if document.source_id else None
        chunks = repository.get_chunks(document.id, workspace_id=workspace_id)
        entries.append(BackupDocument(document=document, source=source, chunks=chunks))
    return KnowledgeBackup(
        workspace_id=workspace_id,
        documents=entries,
        analyses=analysis.list_workspace(workspace_id=workspace_id),
    )


def write_backup(backup: KnowledgeBackup, path: Path) -> None:
    path.write_text(backup.model_dump_json(indent=2), encoding="utf-8")


def read_backup(path: Path) -> KnowledgeBackup:
    return KnowledgeBackup.model_validate_json(path.read_text(encoding="utf-8"))


def restore_workspace(
    repository: KnowledgeRepository,
    analysis: AnalysisStore,
    backup: KnowledgeBackup,
    *,
    target_workspace_id: str | None = None,
) -> RestoreReport:
    """Restaura em ``target_workspace_id`` (ou no mesmo workspace).

    Ao restaurar em outro workspace, ids de fontes/documentos/chunks são
    regenerados para evitar colisão com o workspace de origem.
    """
    workspace_id = target_workspace_id or backup.workspace_id
    remap = workspace_id != backup.workspace_id
    report = RestoreReport()
    for entry in backup.documents:
        document = entry.document
        source_id = document.source_id
        if entry.source is not None:
            source = entry.source
            if remap:
                source = source.model_copy(update={"id": new_id()})
            source_id = source.id
            repository.add_source(source)
            report.sources += 1
        document = document.model_copy(
            update={
                "id": new_id() if remap else document.id,
                "workspace_id": workspace_id,
                "source_id": source_id,
            }
        )
        repository.add_document(document)
        report.documents += 1
        if entry.chunks:
            chunks = [
                chunk.model_copy(
                    update={
                        "id": new_id() if remap else chunk.id,
                        "document_id": document.id,
                        "workspace_id": workspace_id,
                    }
                )
                for chunk in entry.chunks
            ]
            repository.add_chunks(chunks)
            report.chunks += len(chunks)
    for record in backup.analyses:
        analysis.save(
            workspace_id=workspace_id,
            transcription_id=record.transcription_id,
            result=record.result,
        )
        report.analyses += 1
    return report
