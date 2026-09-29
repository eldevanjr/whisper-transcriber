"""Resposta RAG com fontes (grounding) sobre o conhecimento indexado.

Recupera contexto com :class:`~transcriber_worker.ai.rag.KnowledgeQuery` e pede
ao LLM uma resposta fundamentada apenas no contexto, citando timestamps e
admitindo quando não há evidência.
"""

from __future__ import annotations

from typing import Any

from ai_core import LLMProvider, LLMRequest, SearchResult
from pydantic import BaseModel, Field

from transcriber_worker.ai.analyzer import CONTEXT_TOKENS
from transcriber_worker.ai.rag import KnowledgeQuery

GROUNDING_PROMPT = (
    "Responda apenas com base no contexto recuperado. Se não houver evidência "
    "suficiente, diga que não encontrou. Cite os timestamps quando disponíveis e "
    "diferencie fato de inferência. Não invente informações."
)


# Resposta curta e sem raciocínio: a pergunta é interativa (alguém está esperando).
ANSWER_MAX_TOKENS = 1024
# Contexto recuperado que vai no prompt: acima disso GPUs integradas derrubam o Ollama
# (e o prompt longo levaria minutos só para ser lido).
ANSWER_CONTEXT_CHARS = 6_000


class AnswerResult(BaseModel):
    answer: str
    sources: list[SearchResult] = Field(default_factory=list)
    model: str | None = None


class KnowledgeAnswer:
    """Gera respostas fundamentadas no conhecimento indexado de um workspace."""

    def __init__(
        self,
        *,
        query: KnowledgeQuery,
        provider: LLMProvider,
        model: str,
        system_prompt: str = GROUNDING_PROMPT,
    ) -> None:
        self._query = query
        self._provider = provider
        self._model = model
        self._system_prompt = system_prompt

    def ask(self, *, workspace_id: str, question: str, limit: int = 5) -> AnswerResult:
        results = self._query.search(workspace_id=workspace_id, query=question, limit=limit)
        used, context = _fit_context(results, ANSWER_CONTEXT_CHARS)
        request = LLMRequest(
            model=self._model,
            system_prompt=self._system_prompt,
            user_prompt=question,
            context=context,
            temperature=0.0,
            max_tokens=ANSWER_MAX_TOKENS,
            metadata={"think": False, "num_ctx": CONTEXT_TOKENS},
        )
        response = self._provider.generate(request)
        return AnswerResult(
            answer=response.text,
            sources=used,
            model=response.model or self._model,
        )


def _fit_context(results: list[SearchResult], budget: int) -> tuple[list[SearchResult], list[str]]:
    """Trechos mais relevantes que cabem no orçamento; o primeiro entra mesmo cortado."""
    used: list[SearchResult] = []
    context: list[str] = []
    remaining = budget
    for result in results:
        text = context_of(result)
        if len(text) > remaining:
            if context:
                break
            text = text[:remaining]
        used.append(result)
        context.append(text)
        remaining -= len(text)
    return used, context


def context_of(result: SearchResult) -> str:
    """Trecho com o intervalo de tempo, quando conhecido."""
    chunk = result.chunk
    label = _time_label(chunk.metadata)
    return f"{label} {chunk.content}".strip()


def _time_label(metadata: dict[str, Any]) -> str:
    start = metadata.get("start_time")
    end = metadata.get("end_time")
    if isinstance(start, int | float) and isinstance(end, int | float):
        return f"[{float(start):.1f}s-{float(end):.1f}s]"
    return ""
