"""Persistência das análises e entidades detectadas.

Guarda o resultado consolidado por (workspace, transcrição) e uma tabela plana de
entidades (tópicos, tarefas, decisões, problemas, perguntas, pessoas) para busca
pelos MCP. Embeds não entram aqui: o conhecimento textual já é indexado à parte.
"""

from __future__ import annotations

import json
from abc import ABC, abstractmethod
from datetime import datetime
from enum import StrEnum
from typing import Any

from ai_core import new_id
from pydantic import BaseModel, Field

from transcriber_worker.ai.entities import AnalysisResult
from transcriber_worker.ai.records import like_pattern, metadata_from
from transcriber_worker.ai.store import SQLiteStore
from transcriber_worker.ai.workqueue import now_utc


class EntityKind(StrEnum):
    TOPIC = "topic"
    TASK = "task"
    DECISION = "decision"
    PROBLEM = "problem"
    QUESTION = "question"
    PERSON = "person"


class AnalysisRecord(BaseModel):
    workspace_id: str
    transcription_id: str
    created_at: datetime
    result: AnalysisResult


class EntityRecord(BaseModel):
    id: str = Field(default_factory=new_id)
    workspace_id: str
    transcription_id: str
    kind: EntityKind
    label: str
    confidence: float
    payload: dict[str, Any]


class AnalysisStore(ABC):
    """Armazena análises consolidadas e permite buscar entidades."""

    @abstractmethod
    def save(
        self, *, workspace_id: str, transcription_id: str, result: AnalysisResult
    ) -> AnalysisRecord:
        raise NotImplementedError

    @abstractmethod
    def get(self, *, workspace_id: str, transcription_id: str) -> AnalysisRecord | None:
        raise NotImplementedError

    @abstractmethod
    def list_workspace(self, *, workspace_id: str) -> list[AnalysisRecord]:
        """Todas as análises de um workspace (usado no backup)."""
        raise NotImplementedError

    @abstractmethod
    def search(
        self, *, workspace_id: str, kind: EntityKind, query: str, limit: int
    ) -> list[EntityRecord]:
        raise NotImplementedError

    @abstractmethod
    def list_entities(
        self, *, workspace_id: str, kind: EntityKind, limit: int
    ) -> list[EntityRecord]:
        raise NotImplementedError

    @abstractmethod
    def delete(self, *, workspace_id: str, transcription_id: str) -> None:
        raise NotImplementedError


def flatten_entities(
    *, workspace_id: str, transcription_id: str, result: AnalysisResult
) -> list[EntityRecord]:
    """Converte o resultado consolidado na lista plana de entidades indexáveis."""
    records: list[EntityRecord] = []
    for topic in result.topics:
        records.append(
            _entity(
                workspace_id,
                transcription_id,
                EntityKind.TOPIC,
                topic.name,
                topic.confidence,
                topic,
            )
        )
    for task in result.tasks:
        records.append(
            _entity(
                workspace_id,
                transcription_id,
                EntityKind.TASK,
                task.description,
                task.confidence,
                task,
            )
        )
    for decision in result.decisions:
        records.append(
            _entity(
                workspace_id,
                transcription_id,
                EntityKind.DECISION,
                decision.description,
                decision.confidence,
                decision,
            )
        )
    for problem in result.problems:
        records.append(
            _entity(
                workspace_id,
                transcription_id,
                EntityKind.PROBLEM,
                problem.description,
                problem.confidence,
                problem,
            )
        )
    for question in result.questions:
        records.append(
            _entity(
                workspace_id,
                transcription_id,
                EntityKind.QUESTION,
                question.question,
                question.confidence,
                question,
            )
        )
    for person in result.people:
        records.append(
            _entity(
                workspace_id,
                transcription_id,
                EntityKind.PERSON,
                person.name,
                person.confidence,
                person,
            )
        )
    return records


def _entity(
    workspace_id: str,
    transcription_id: str,
    kind: EntityKind,
    label: str,
    confidence: float,
    model: BaseModel,
) -> EntityRecord:
    return EntityRecord(
        workspace_id=workspace_id,
        transcription_id=transcription_id,
        kind=kind,
        label=label,
        confidence=confidence,
        payload=model.model_dump(mode="json"),
    )


class SQLiteAnalysisStore(AnalysisStore):
    """Implementação em SQLite, compartilhando a conexão do conhecimento."""

    def __init__(self, store: SQLiteStore) -> None:
        self._store = store

    def save(
        self, *, workspace_id: str, transcription_id: str, result: AnalysisResult
    ) -> AnalysisRecord:
        created_at = now_utc()
        entities = flatten_entities(
            workspace_id=workspace_id, transcription_id=transcription_id, result=result
        )
        with self._store.locked() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO analysis"
                " (workspace_id, transcription_id, created_at, payload) VALUES (?, ?, ?, ?)",
                (workspace_id, transcription_id, created_at.isoformat(), result.model_dump_json()),
            )
            conn.execute(
                "DELETE FROM entities WHERE workspace_id = ? AND transcription_id = ?",
                (workspace_id, transcription_id),
            )
            for entity in entities:
                conn.execute(
                    "INSERT INTO entities"
                    " (id, workspace_id, transcription_id, kind, label, confidence, payload)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (
                        entity.id,
                        entity.workspace_id,
                        entity.transcription_id,
                        str(entity.kind),
                        entity.label,
                        entity.confidence,
                        json.dumps(entity.payload),
                    ),
                )
        return AnalysisRecord(
            workspace_id=workspace_id,
            transcription_id=transcription_id,
            created_at=created_at,
            result=result,
        )

    def get(self, *, workspace_id: str, transcription_id: str) -> AnalysisRecord | None:
        with self._store.locked() as conn:
            row = conn.execute(
                "SELECT created_at, payload FROM analysis"
                " WHERE workspace_id = ? AND transcription_id = ?",
                (workspace_id, transcription_id),
            ).fetchone()
        if row is None:
            return None
        return AnalysisRecord(
            workspace_id=workspace_id,
            transcription_id=transcription_id,
            created_at=datetime.fromisoformat(row["created_at"]),
            result=AnalysisResult.model_validate_json(row["payload"]),
        )

    def list_workspace(self, *, workspace_id: str) -> list[AnalysisRecord]:
        with self._store.locked() as conn:
            rows = conn.execute(
                "SELECT transcription_id, created_at, payload FROM analysis"
                " WHERE workspace_id = ? ORDER BY transcription_id",
                (workspace_id,),
            ).fetchall()
        return [
            AnalysisRecord(
                workspace_id=workspace_id,
                transcription_id=row["transcription_id"],
                created_at=datetime.fromisoformat(row["created_at"]),
                result=AnalysisResult.model_validate_json(row["payload"]),
            )
            for row in rows
        ]

    def search(
        self, *, workspace_id: str, kind: EntityKind, query: str, limit: int
    ) -> list[EntityRecord]:
        pattern = like_pattern(query.strip().lower())
        with self._store.locked() as conn:
            rows = conn.execute(
                "SELECT * FROM entities WHERE workspace_id = ? AND kind = ?"
                " AND lower(label) LIKE ? ESCAPE '\\' ORDER BY confidence DESC LIMIT ?",
                (workspace_id, str(kind), pattern, limit),
            ).fetchall()
        return [_entity_row(row) for row in rows]

    def list_entities(
        self, *, workspace_id: str, kind: EntityKind, limit: int
    ) -> list[EntityRecord]:
        with self._store.locked() as conn:
            rows = conn.execute(
                "SELECT * FROM entities WHERE workspace_id = ? AND kind = ?"
                " ORDER BY confidence DESC LIMIT ?",
                (workspace_id, str(kind), limit),
            ).fetchall()
        return [_entity_row(row) for row in rows]

    def delete(self, *, workspace_id: str, transcription_id: str) -> None:
        with self._store.locked() as conn:
            conn.execute(
                "DELETE FROM analysis WHERE workspace_id = ? AND transcription_id = ?",
                (workspace_id, transcription_id),
            )
            conn.execute(
                "DELETE FROM entities WHERE workspace_id = ? AND transcription_id = ?",
                (workspace_id, transcription_id),
            )


def _entity_row(row: Any) -> EntityRecord:
    return EntityRecord(
        id=row["id"],
        workspace_id=row["workspace_id"],
        transcription_id=row["transcription_id"],
        kind=EntityKind(row["kind"]),
        label=row["label"],
        confidence=float(row["confidence"]),
        payload=metadata_from(row["payload"]),
    )
