"""Entidades detectadas pela análise incremental.

Nomes neutros e próprios do domínio de reuniões (o Task Engine do AI Work
Analyzer é outra coisa e vive no ai-core). ``confidence`` é apenas indicação do
modelo, não probabilidade estatística (conforme o plano).
"""

from __future__ import annotations

from enum import StrEnum
from uuid import uuid4

from pydantic import BaseModel, Field


def _new_id() -> str:
    return uuid4().hex


class EntityState(StrEnum):
    """Ciclo de vida de uma entidade ao longo da reunião (plano §7)."""

    DETECTED = "DETECTED"
    UPDATED = "UPDATED"
    CONFIRMED = "CONFIRMED"
    CANCELLED = "CANCELLED"


class SegmentRef(BaseModel):
    """Referência a um trecho da transcrição (índice e timestamps)."""

    segment_index: int
    start: float
    end: float


class Topic(BaseModel):
    id: str = Field(default_factory=_new_id)
    name: str
    description: str | None = None
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    state: EntityState = EntityState.DETECTED
    source_segments: list[SegmentRef] = Field(default_factory=list)


class DetectedTask(BaseModel):
    id: str = Field(default_factory=_new_id)
    description: str
    assignee: str | None = None
    deadline: str | None = None
    status: str | None = None
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    state: EntityState = EntityState.DETECTED
    source_segments: list[SegmentRef] = Field(default_factory=list)


class Decision(BaseModel):
    id: str = Field(default_factory=_new_id)
    description: str
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    state: EntityState = EntityState.DETECTED
    source_segments: list[SegmentRef] = Field(default_factory=list)


class Problem(BaseModel):
    id: str = Field(default_factory=_new_id)
    description: str
    severity: str | None = None
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    state: EntityState = EntityState.DETECTED
    source_segments: list[SegmentRef] = Field(default_factory=list)


class Question(BaseModel):
    id: str = Field(default_factory=_new_id)
    question: str
    answered: bool = False
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    state: EntityState = EntityState.DETECTED
    source_segments: list[SegmentRef] = Field(default_factory=list)


class Person(BaseModel):
    id: str = Field(default_factory=_new_id)
    name: str
    role: str | None = None
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    state: EntityState = EntityState.DETECTED
    source_segments: list[SegmentRef] = Field(default_factory=list)


class AnalysisResult(BaseModel):
    """Resultado de uma janela de análise, tolerante a campos extras do modelo."""

    summary: str | None = None
    topics: list[Topic] = Field(default_factory=list)
    tasks: list[DetectedTask] = Field(default_factory=list)
    decisions: list[Decision] = Field(default_factory=list)
    problems: list[Problem] = Field(default_factory=list)
    questions: list[Question] = Field(default_factory=list)
    people: list[Person] = Field(default_factory=list)
    model: str | None = None
    prompt_version: str | None = None

    def is_empty(self) -> bool:
        return not any(
            (self.topics, self.tasks, self.decisions, self.problems, self.questions, self.people)
        )
