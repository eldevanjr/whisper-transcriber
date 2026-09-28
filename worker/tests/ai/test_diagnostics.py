from __future__ import annotations

from typing import Any

from tests.ai.test_postgres import FakeConnection
from transcriber_worker.ai.config import AiConfig
from transcriber_worker.ai.diagnostics import DiagnosticCheck, run_diagnostics
from transcriber_worker.ai.ollama import OllamaClient, OllamaError
from transcriber_worker.ai.storage import sqlite_storage
from transcriber_worker.ai.store import SQLiteKnowledgeRepository, SQLiteStore


def _client(models: list[str] | None = None, error: bool = False) -> OllamaClient:
    def post(path: str, _payload: dict[str, Any] | None) -> dict[str, Any]:
        if error:
            raise OllamaError("sem conexão")
        assert path == "/api/tags"
        return {"models": [{"name": name} for name in models or []]}

    return OllamaClient("http://localhost:11434", post=post)


def _repository() -> SQLiteKnowledgeRepository:
    return SQLiteKnowledgeRepository(SQLiteStore())


def _run(**overrides: Any) -> list[DiagnosticCheck]:
    config = AiConfig(enabled=True, llm_model="qwen3:8b", embedding_model="nomic-embed-text")
    options: dict[str, Any] = {
        "config": config,
        "client": _client(["qwen3:8b", "nomic-embed-text"]),
        "repository": _repository(),
        "storage": sqlite_storage(SQLiteStore()),
    }
    options.update(overrides)
    return run_diagnostics(**options)


def _by_name(checks: list[DiagnosticCheck]) -> dict[str, DiagnosticCheck]:
    return {check.name: check for check in checks}


def test_all_ok_with_sqlite_fallback() -> None:
    checks = _run()
    by_name = _by_name(checks)
    assert [check.name for check in checks] == [
        "whisper",
        "ollama",
        "llm",
        "embeddings",
        "rag",
        "postgres",
        "pgvector",
    ]
    assert by_name["ollama"].ok is True
    assert by_name["ollama"].detail == "http://localhost:11434 · 2 modelos"
    assert by_name["llm"] == DiagnosticCheck("llm", True, "qwen3:8b")
    assert by_name["embeddings"].ok is True
    assert by_name["rag"] == DiagnosticCheck("rag", True, "repositório acessível")
    assert by_name["postgres"].ok is False
    assert by_name["postgres"].detail == "SQLite (fallback)"
    assert by_name["pgvector"].detail == "não conectado"


def test_whisper_nao_verificado_sem_probe() -> None:
    assert _by_name(_run())["whisper"] == DiagnosticCheck("whisper", False, "não verificado")


def test_whisper_sem_modelo_carregado() -> None:
    checks = _by_name(_run(whisper=lambda: None))
    assert checks["whisper"] == DiagnosticCheck("whisper", False, "nenhum modelo carregado")


def test_whisper_carregado_descreve_motor_e_dispositivo() -> None:
    checks = _by_name(_run(whisper=lambda: "faster-whisper · cuda"))
    assert checks["whisper"] == DiagnosticCheck("whisper", True, "faster-whisper · cuda")


def test_ollama_offline_derruba_llm_e_embeddings() -> None:
    checks = _by_name(_run(client=_client(error=True)))
    assert checks["ollama"].ok is False
    assert checks["ollama"].detail == "sem conexão"
    assert checks["llm"] == DiagnosticCheck("llm", False, "Ollama indisponível")
    assert checks["embeddings"].detail == "Ollama indisponível"


def test_modelo_ausente_avisa() -> None:
    checks = _by_name(_run(client=_client(["outro"])))
    assert checks["llm"].ok is False
    assert checks["llm"].detail == "modelo 'qwen3:8b' não instalado"


def test_rag_com_repositorio_fechado_falha() -> None:
    store = SQLiteStore()
    repository = SQLiteKnowledgeRepository(store)
    store.close()
    checks = _by_name(_run(repository=repository))
    assert checks["rag"].ok is False
    assert checks["rag"].detail is not None


def test_storage_postgres_usa_health_check() -> None:
    from transcriber_worker.ai.storage import postgres_storage

    connection = FakeConnection([{"version": "16.3"}, {"extversion": "0.7.4"}])
    checks = _by_name(_run(storage=postgres_storage(connection)))
    assert checks["postgres"] == DiagnosticCheck("postgres", True, "16.3")
    assert checks["pgvector"] == DiagnosticCheck("pgvector", True, "0.7.4")


def test_storage_postgres_sem_conexao() -> None:
    from transcriber_worker.ai.storage import postgres_storage

    backend = postgres_storage(FakeConnection())
    bare = backend.__class__(
        repository=backend.repository,
        vector_store=backend.vector_store,
        kind="postgres",
        fallback_reason="sem driver",
    )
    checks = _by_name(_run(storage=bare))
    assert checks["postgres"] == DiagnosticCheck("postgres", False, "sem driver")
    assert checks["pgvector"].detail == "não conectado"


def test_model_check_accepts_latest_tag() -> None:
    checks = _by_name(_run(client=_client(["qwen3:8b", "nomic-embed-text:latest"])))
    assert checks["embeddings"].ok is True
    assert checks["embeddings"].detail == "nomic-embed-text:latest"


def test_model_check_accepts_implicit_latest_in_config() -> None:
    config = AiConfig(enabled=True, llm_model="llama3:latest", embedding_model="bge-m3")
    checks = _by_name(_run(config=config, client=_client(["llama3", "bge-m3:latest"])))
    assert checks["llm"].ok is True
    assert checks["embeddings"].ok is True


def test_model_check_does_not_match_other_tags() -> None:
    checks = _by_name(_run(client=_client(["qwen3:14b", "nomic-embed-text"])))
    assert checks["llm"].ok is False
