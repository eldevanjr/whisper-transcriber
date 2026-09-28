"""Conversão de linhas de banco (Mapping) para modelos do ai-core.

Compartilhado entre o backend SQLite (metadados/`created_at` em texto) e o
PostgreSQL (jsonb/datetime já decodificados pelo driver).
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from datetime import datetime
from typing import Any

from ai_core import KnowledgeChunk, KnowledgeDocument, Source, SourceKind


def metadata_from(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        data = json.loads(value)
        return data if isinstance(data, dict) else {}
    return {}


def _datetime_from(value: Any) -> datetime:
    if isinstance(value, datetime):
        return value
    return datetime.fromisoformat(value)


def source_from(data: Mapping[str, Any]) -> Source:
    return Source(
        id=data["id"],
        evidence_id=data["evidence_id"],
        type=SourceKind(data["type"]),
        location=data["location"],
        title=data["title"],
        metadata=metadata_from(data["metadata"]),
    )


def document_from(data: Mapping[str, Any]) -> KnowledgeDocument:
    return KnowledgeDocument(
        id=data["id"],
        workspace_id=data["workspace_id"],
        source_id=data["source_id"],
        title=data["title"],
        content=data["content"],
        metadata=metadata_from(data["metadata"]),
        created_at=_datetime_from(data["created_at"]),
    )


def chunk_from(data: Mapping[str, Any]) -> KnowledgeChunk:
    return KnowledgeChunk(
        id=data["id"],
        document_id=data["document_id"],
        workspace_id=data["workspace_id"],
        content=data["content"],
        position=data["position"],
        metadata=metadata_from(data["metadata"]),
        embedding_reference=data["embedding_reference"],
    )


def like_pattern(query: str) -> str:
    """``%texto%`` com ``%``, ``_`` e ``\\`` da consulta tratados como texto (``ESCAPE '\\'``)."""
    escaped = query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"
