from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from transcriber_worker.ai.controller import AiController
from transcriber_worker.ai.ollama import OllamaClient
from transcriber_worker.ai.storage import (
    StorageBackend,
    StorageConfig,
    StorageMode,
    sqlite_storage,
)
from transcriber_worker.ai.store import SQLiteStore
from transcriber_worker.commands import Dispatcher
from transcriber_worker.engine import Engine
from transcriber_worker.events import Event
from transcriber_worker.protocol import (
    AiDiagnoseCommand,
    AiPullModelCommand,
    AiPullModelParams,
    AiSegment,
    AiStatusCommand,
    AiStatusParams,
    AnalysisAppendCommand,
    AnalysisFinalizeCommand,
    AnalysisGetCommand,
    AnalysisGetParams,
    AnalysisProcessCommand,
    AnalysisRetryCommand,
    AnalysisSubmitCommand,
    ConfigureAiCommand,
    ConfigureAiParams,
    FinalizeAnalysisParams,
    KnowledgeAskCommand,
    KnowledgeAskParams,
    KnowledgeBackupCommand,
    KnowledgeBackupParams,
    KnowledgeDeleteCommand,
    KnowledgeDeleteParams,
    KnowledgeReindexCancelCommand,
    KnowledgeReindexCommand,
    KnowledgeReindexParams,
    KnowledgeRestoreCommand,
    KnowledgeRestoreParams,
    KnowledgeSearchCommand,
    KnowledgeSearchEntitiesCommand,
    KnowledgeSearchEntitiesParams,
    KnowledgeSearchParams,
    ProcessAnalysisParams,
    RetryAnalysisParams,
    ShutdownCommand,
    StorageParams,
    SubmitAnalysisParams,
)


def _post(path: str, payload: dict[str, Any] | None) -> dict[str, Any]:
    if path == "/api/embeddings":
        return {"embedding": [1.0, 0.0, 0.0]}
    if path == "/api/generate":
        return {"response": '{"topics": [{"name": "Sinc"}]}'}
    if path == "/api/tags":
        return {"models": [{"name": "qwen3:8b"}, {"name": "nomic-embed-text"}]}
    raise AssertionError(path)


def _dispatcher() -> tuple[Dispatcher, list[Event], AiController]:
    events: list[Event] = []
    controller = AiController(events.append, post=_post, background=False)
    return Dispatcher(Engine(), events.append, ai=controller), events, controller


def _submit() -> AnalysisSubmitCommand:
    return AnalysisSubmitCommand(
        id="2",
        cmd="analysis_submit",
        params=SubmitAnalysisParams(
            transcription_id="t",
            workspace_id="ws",
            title="Reunião",
            segments=[AiSegment(index=0, start=0.0, end=10.0, text="sincronização offline")],
        ),
    )


def test_ai_commands_flow() -> None:
    dispatcher, events, controller = _dispatcher()
    assert dispatcher.handle(
        ConfigureAiCommand(id="1", cmd="configure_ai", params=ConfigureAiParams(enabled=True))
    )
    assert dispatcher.handle(_submit())
    assert dispatcher.handle(
        AnalysisProcessCommand(id="3", cmd="analysis_process", params=ProcessAnalysisParams())
    )
    assert dispatcher.handle(
        KnowledgeSearchCommand(
            id="4",
            cmd="knowledge_search",
            params=KnowledgeSearchParams(workspace_id="ws", query="sincronização"),
        )
    )
    assert dispatcher.handle(
        KnowledgeReindexCommand(
            id="5", cmd="knowledge_reindex", params=KnowledgeReindexParams(workspace_id="ws")
        )
    )
    assert dispatcher.handle(
        AnalysisFinalizeCommand(
            id="6",
            cmd="analysis_finalize",
            params=FinalizeAnalysisParams(transcription_id="t", workspace_id="ws"),
        )
    )
    assert dispatcher.handle(AiStatusCommand(id="7", cmd="ai_status"))
    assert dispatcher.handle(
        KnowledgeDeleteCommand(
            id="8",
            cmd="knowledge_delete",
            params=KnowledgeDeleteParams(workspace_id="ws", transcription_id="t"),
        )
    )

    types = [str(event["type"]) for event in events]
    assert "ai_status" in types
    assert "ai_analysis" in types
    assert "ai_search" in types
    assert controller.configured


def test_shutdown_closes_ai() -> None:
    dispatcher, _, controller = _dispatcher()
    _ = dispatcher.handle(
        ConfigureAiCommand(id="1", cmd="configure_ai", params=ConfigureAiParams(enabled=True))
    )
    assert controller.configured is True
    assert dispatcher.handle(ShutdownCommand(id="9", cmd="shutdown")) is False
    assert controller.configured is False


def test_ai_disabled_emits_error() -> None:
    dispatcher, events, _ = _dispatcher()
    _ = dispatcher.handle(
        ConfigureAiCommand(id="1", cmd="configure_ai", params=ConfigureAiParams(enabled=False))
    )
    assert dispatcher.handle(_submit())
    errors = [event for event in events if event["type"] == "error"]
    assert errors
    assert errors[-1]["code"] == "AI_DISABLED"


def test_ai_diagnose_command() -> None:
    dispatcher, events, _ = _dispatcher()
    _ = dispatcher.handle(
        ConfigureAiCommand(id="1", cmd="configure_ai", params=ConfigureAiParams(enabled=True))
    )
    assert dispatcher.handle(AiDiagnoseCommand(id="2", cmd="ai_diagnose"))
    results = [event for event in events if event["type"] == "result"]
    names = [check["name"] for check in results[-1]["data"]["diagnostics"]["checks"]]
    assert names == ["whisper", "ollama", "llm", "embeddings", "rag", "postgres", "pgvector"]


def test_ai_pull_model_command(monkeypatch: pytest.MonkeyPatch) -> None:
    dispatcher, events, _ = _dispatcher()
    _ = dispatcher.handle(
        ConfigureAiCommand(id="1", cmd="configure_ai", params=ConfigureAiParams(enabled=True))
    )
    pulled: list[str] = []
    monkeypatch.setattr(OllamaClient, "pull", lambda self, model, **_kwargs: pulled.append(model))
    assert dispatcher.handle(
        AiPullModelCommand(id="2", cmd="ai_pull_model", params=AiPullModelParams(model="qwen3:8b"))
    )
    results = [event for event in events if event["type"] == "result"]
    assert results[-1]["data"] == {"model": "qwen3:8b"}
    assert pulled == ["qwen3:8b"]


def test_ai_status_without_configuration() -> None:
    dispatcher, events, _ = _dispatcher()
    assert dispatcher.handle(AiStatusCommand(id="1", cmd="ai_status"))
    results = [event for event in events if event["type"] == "result"]
    assert results[-1]["data"] == {
        "status": {"configured": False, "enabled": False, "analysis": {}, "index": {}}
    }


def test_backup_and_restore_commands(tmp_path: Path) -> None:
    dispatcher, events, _ = _dispatcher()
    _ = dispatcher.handle(
        ConfigureAiCommand(id="1", cmd="configure_ai", params=ConfigureAiParams(enabled=True))
    )
    _ = dispatcher.handle(_submit())
    _ = dispatcher.handle(
        AnalysisProcessCommand(id="2", cmd="analysis_process", params=ProcessAnalysisParams())
    )
    path = str(tmp_path / "backup.json")
    assert dispatcher.handle(
        KnowledgeBackupCommand(
            id="3",
            cmd="knowledge_backup",
            params=KnowledgeBackupParams(workspace_id="ws", path=path),
        )
    )
    assert dispatcher.handle(
        KnowledgeRestoreCommand(
            id="4",
            cmd="knowledge_restore",
            params=KnowledgeRestoreParams(path=path, workspace_id="ws"),
        )
    )
    results = [event for event in events if event["type"] == "result"]
    assert results[-1]["data"]["documents"] == 1
    assert results[-1]["data"]["analyses"] == 1


def test_analysis_get_and_entity_search_commands() -> None:
    dispatcher, events, _ = _dispatcher()
    _ = dispatcher.handle(
        ConfigureAiCommand(id="1", cmd="configure_ai", params=ConfigureAiParams(enabled=True))
    )
    _ = dispatcher.handle(_submit())
    _ = dispatcher.handle(
        AnalysisProcessCommand(id="2", cmd="analysis_process", params=ProcessAnalysisParams())
    )
    assert dispatcher.handle(
        AnalysisGetCommand(
            id="3",
            cmd="analysis_get",
            params=AnalysisGetParams(workspace_id="ws", transcription_id="t"),
        )
    )
    assert dispatcher.handle(
        KnowledgeSearchEntitiesCommand(
            id="4",
            cmd="knowledge_search_entities",
            params=KnowledgeSearchEntitiesParams(workspace_id="ws", kind="topic", query="sinc"),
        )
    )
    results = [event for event in events if event["type"] == "result"]
    assert results[-2]["data"]["analysis"]["result"]["topics"][0]["name"] == "Sinc"
    assert results[-1]["data"]["entities"][0]["label"] == "Sinc"


def test_knowledge_ask_command() -> None:
    dispatcher, events, _ = _dispatcher()
    _ = dispatcher.handle(
        ConfigureAiCommand(id="1", cmd="configure_ai", params=ConfigureAiParams(enabled=True))
    )
    _ = dispatcher.handle(_submit())
    _ = dispatcher.handle(
        AnalysisProcessCommand(id="2", cmd="analysis_process", params=ProcessAnalysisParams())
    )
    assert dispatcher.handle(
        KnowledgeAskCommand(
            id="3",
            cmd="knowledge_ask",
            params=KnowledgeAskParams(workspace_id="ws", question="o que foi discutido?"),
        )
    )
    results = [event for event in events if event["type"] == "result"]
    assert results[-1]["data"]["answer"]
    assert results[-1]["data"]["sources"]


def test_configure_ai_with_storage_uses_factory() -> None:
    events: list[Event] = []
    captured: list[StorageConfig] = []
    backend = sqlite_storage(SQLiteStore(), fallback_reason="sem docker", manage_store=True)

    def factory(
        config: StorageConfig, *, store: SQLiteStore, embedding_model: str | None
    ) -> StorageBackend:
        captured.append(config)
        assert embedding_model == "nomic-embed-text"
        return backend

    controller = AiController(events.append, post=_post, storage_factory=factory, background=False)
    dispatcher = Dispatcher(Engine(), events.append, ai=controller)
    params = ConfigureAiParams(
        enabled=True,
        storage=StorageParams(mode="local", volume="/tmp/pg", password="x"),  # noqa: S106
    )
    assert dispatcher.handle(ConfigureAiCommand(id="1", cmd="configure_ai", params=params))
    assert captured
    assert captured[0].mode is StorageMode.LOCAL
    results = [event for event in events if event["type"] == "result"]
    assert results[-1]["data"]["status"]["storage"] == {
        "kind": "sqlite",
        "fallback": True,
        "reason": "sem docker",
    }
    controller.close()


def _results(events: list[Event]) -> list[Event]:
    return [event for event in events if event["type"] == "result"]


def test_append_retry_cancel_and_status_commands() -> None:
    dispatcher, events, _ = _dispatcher()
    _ = dispatcher.handle(
        ConfigureAiCommand(id="1", cmd="configure_ai", params=ConfigureAiParams(enabled=True))
    )
    append = _submit().model_copy(update={"cmd": "analysis_append"})
    assert dispatcher.handle(AnalysisAppendCommand.model_validate(append.model_dump()))
    assert _results(events)[-1]["data"] == {"analysis": 0}
    assert dispatcher.handle(
        AnalysisRetryCommand(id="3", cmd="analysis_retry", params=RetryAnalysisParams())
    )
    assert _results(events)[-1]["data"] == {"retried": 0}
    _ = dispatcher.handle(_submit())
    assert dispatcher.handle(
        KnowledgeReindexCancelCommand(
            id="4",
            cmd="knowledge_reindex_cancel",
            params=KnowledgeReindexParams(workspace_id="ws"),
        )
    )
    assert _results(events)[-1]["data"] == {"canceled": 1}
    assert dispatcher.handle(
        AiStatusCommand(id="5", cmd="ai_status", params=AiStatusParams(workspace_id="ws"))
    )
    assert _results(events)[-1]["data"]["status"]["reindex_required"] is False
