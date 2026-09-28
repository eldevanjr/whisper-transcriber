"""Diagnóstico da pilha de IA local (Ollama, LLM, embeddings, RAG e banco).

Cada verificação é independente: uma falha vira ``ok=False`` com o motivo, sem
interromper as demais. Nada aqui envia conteúdo para a nuvem.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from ai_core import KnowledgeRepository

from transcriber_worker.ai.config import AiConfig
from transcriber_worker.ai.ollama import OllamaClient, OllamaError
from transcriber_worker.ai.postgres import health_check
from transcriber_worker.ai.storage import StorageBackend

WhisperProbe = Callable[[], "str | None"]


@dataclass(frozen=True, slots=True)
class DiagnosticCheck:
    """Resultado de uma verificação, com o motivo em ``detail`` quando falha."""

    name: str
    ok: bool
    detail: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return {"name": self.name, "ok": self.ok, "detail": self.detail}


def _ollama_check(client: OllamaClient, url: str) -> tuple[DiagnosticCheck, list[str]]:
    try:
        models = client.list_models()
    except OllamaError as exc:
        return DiagnosticCheck("ollama", False, str(exc)), []
    return DiagnosticCheck("ollama", True, f"{url} · {len(models)} modelos"), models


def _canonical(model: str) -> str:
    """O Ollama lista ``nome:latest`` para quem baixou só ``nome`` (e vice-versa)."""
    return model if ":" in model else f"{model}:latest"


def _model_check(name: str, model: str, models: list[str], *, ollama_ok: bool) -> DiagnosticCheck:
    if not ollama_ok:
        return DiagnosticCheck(name, False, "Ollama indisponível")
    wanted = _canonical(model)
    for installed in models:
        if _canonical(installed) == wanted:
            return DiagnosticCheck(name, True, installed)
    return DiagnosticCheck(name, False, f"modelo '{model}' não instalado")


def _rag_check(repository: KnowledgeRepository) -> DiagnosticCheck:
    try:
        repository.get_chunk("__diagnostic__", workspace_id="__diagnostic__")
    except Exception as exc:
        return DiagnosticCheck("rag", False, str(exc))
    return DiagnosticCheck("rag", True, "repositório acessível")


def _whisper_check(probe: WhisperProbe | None) -> DiagnosticCheck:
    if probe is None:
        return DiagnosticCheck("whisper", False, "não verificado")
    detail = probe()
    if detail is None:
        return DiagnosticCheck("whisper", False, "nenhum modelo carregado")
    return DiagnosticCheck("whisper", True, detail)


def _storage_checks(storage: StorageBackend) -> list[DiagnosticCheck]:
    if storage.kind != "postgres" or storage.connection is None:
        detail = storage.fallback_reason or "SQLite (fallback)"
        return [
            DiagnosticCheck("postgres", False, detail),
            DiagnosticCheck("pgvector", False, "não conectado"),
        ]
    return [
        DiagnosticCheck(check.name, check.ok, check.detail)
        for check in health_check(storage.connection).checks
    ]


def run_diagnostics(
    *,
    config: AiConfig,
    client: OllamaClient,
    repository: KnowledgeRepository,
    storage: StorageBackend,
    whisper: WhisperProbe | None = None,
) -> list[DiagnosticCheck]:
    """Roda todas as verificações e devolve os resultados na ordem de exibição."""
    ollama, models = _ollama_check(client, config.ollama_url)
    return [
        _whisper_check(whisper),
        ollama,
        _model_check("llm", config.llm_model, models, ollama_ok=ollama.ok),
        _model_check("embeddings", config.embedding_model, models, ollama_ok=ollama.ok),
        _rag_check(repository),
        *_storage_checks(storage),
    ]
