"""Migração fallback → PostgreSQL (plano §12).

Enquanto o PostgreSQL esteve indisponível, o conhecimento foi para o SQLite local.
Quando ele volta, documentos, chunks e fontes passam para o PostgreSQL, os
embeddings são regenerados pela fila de indexação e o SQLite fica limpo.
"""

from __future__ import annotations

from transcriber_worker.ai.indexing import Indexer
from transcriber_worker.ai.store import SQLiteKnowledgeRepository, SQLiteStore


def _workspaces(store: SQLiteStore) -> list[str]:
    with store.locked() as conn:
        rows = conn.execute("SELECT DISTINCT workspace_id FROM documents ORDER BY 1").fetchall()
    return [str(row[0]) for row in rows]


def migrate_fallback(*, source: SQLiteStore, indexer: Indexer) -> int:
    """Copia o conhecimento do SQLite para o repositório do indexer; devolve quantos documentos."""
    fallback = SQLiteKnowledgeRepository(source)
    target = indexer.repository
    migrated = 0
    for workspace_id in _workspaces(source):
        for document in fallback.list_documents(workspace_id):
            if document.source_id is not None:
                found = fallback.get_source(document.source_id)
                if found is not None:
                    target.add_source(found)
            target.add_document(document)
            chunks = fallback.get_chunks(document.id, workspace_id=workspace_id)
            target.add_chunks(chunks)
            indexer.enqueue_document(document, chunks)
            fallback.delete_document(document.id, workspace_id=workspace_id)
            migrated += 1
    with source.locked() as conn:
        conn.execute("DELETE FROM vectors")
        conn.execute("DELETE FROM sources")
    return migrated
