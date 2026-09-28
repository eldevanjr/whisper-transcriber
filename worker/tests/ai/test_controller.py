from __future__ import annotations

import threading
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest

from tests.ai.test_postgres import FakeConnection
from transcriber_worker.ai.analysis_store import EntityKind
from transcriber_worker.ai.config import AiConfig
from transcriber_worker.ai.controller import AiController
from transcriber_worker.ai.ollama import OllamaUnavailableError
from transcriber_worker.ai.storage import (
    StorageBackend,
    StorageConfig,
    StorageMode,
    postgres_storage,
    sqlite_storage,
)
from transcriber_worker.ai.store import SQLiteStore
from transcriber_worker.ai.windows import SegmentInput
from transcriber_worker.errors import ErrorCode, WorkerError
from transcriber_worker.events import Event

SEGMENT = SegmentInput(index=0, start=0.0, end=10.0, text="sincronização offline")
TOPIC = '{"topics": [{"name": "Sinc", "source_segments": [0]}]}'


def _segments(count: int, first: int = 0) -> list[SegmentInput]:
    return [
        SegmentInput(index=i, start=i * 10.0, end=i * 10.0 + 10.0, text=f"fala {i}")
        for i in range(first, first + count)
    ]


def _post(path: str, payload: dict[str, Any] | None) -> dict[str, Any]:
    if path == "/api/embeddings":
        return {"embedding": [1.0, 0.0, 0.0]}
    if path == "/api/generate":
        return {"response": TOPIC}
    if path == "/api/tags":
        return {"models": [{"name": "qwen3:8b"}, {"name": "nomic-embed-text:latest"}]}
    raise AssertionError(path)


class Recorder:
    def __init__(self) -> None:
        self.events: list[Event] = []
        self._lock = threading.Lock()

    def __call__(self, event: Event) -> None:
        with self._lock:
            self.events.append(event)

    def types(self) -> list[str]:
        with self._lock:
            return [str(event["type"]) for event in self.events]

    def analyses(self) -> list[Event]:
        with self._lock:
            return [event for event in self.events if event["type"] == "ai_analysis"]


def _controller(
    config: AiConfig | None = None, *, post: Any = _post, **options: Any
) -> tuple[AiController, Recorder]:
    recorder = Recorder()
    options.setdefault("background", False)
    controller = AiController(recorder, post=post, **options)
    _ = controller.configure(config or AiConfig(enabled=True))
    return controller, recorder


def _submit(controller: AiController, segments: list[SegmentInput] | None = None) -> Any:
    return controller.submit(
        transcription_id="t", workspace_id="ws", title="Reunião", segments=segments or [SEGMENT]
    )


def _wait_until(condition: Callable[[], bool], timeout: float = 5.0) -> None:
    deadline = time.monotonic() + timeout
    while not condition():
        if time.monotonic() > deadline:
            raise AssertionError("condição não ocorreu a tempo")
        time.sleep(0.01)


def test_status_when_not_configured() -> None:
    controller = AiController(Recorder(), post=_post)
    assert controller.configured is False
    assert controller.status() == {
        "configured": False,
        "enabled": False,
        "analysis": {},
        "index": {},
    }


def test_commands_require_configuration_and_enabled_ai() -> None:
    controller = AiController(Recorder(), post=_post)
    with pytest.raises(WorkerError) as not_configured:
        _submit(controller)
    assert not_configured.value.code is ErrorCode.AI_NOT_CONFIGURED
    disabled, _ = _controller(AiConfig(enabled=False))
    with pytest.raises(WorkerError) as off:
        _submit(disabled)
    assert off.value.code is ErrorCode.AI_DISABLED


def test_blocked_remote_ollama_refuses_work_and_reports_why() -> None:
    controller, _ = _controller(AiConfig(enabled=True, ollama_url="https://ia.example.com"))
    assert "ia.example.com" in controller.status()["blocked"]
    with pytest.raises(WorkerError) as blocked:
        _submit(controller)
    assert blocked.value.code is ErrorCode.AI_BLOCKED


def test_submit_returns_immediately_and_process_finishes_everything() -> None:
    controller, recorder = _controller()
    assert _submit(controller) == {"analysis": 1, "chunks": 1}
    assert controller.process(max_items=10) == {"analysis": 2, "index": 1}
    final = recorder.analyses()[-1]
    assert final["final"] is True
    assert final["result"]["topics"][0]["source_segments"][0]["start"] == 0.0
    stored = controller.analysis_get(workspace_id="ws", transcription_id="t")
    assert stored is not None
    assert stored["result"]["topics"][0]["name"] == "Sinc"
    assert "ai_status" in recorder.types()


def test_partial_results_are_published_as_windows_finish() -> None:
    controller, recorder = _controller(AiConfig(enabled=True, final_analysis_enabled=False))
    controller.append(transcription_id="t", workspace_id="ws", title="R", segments=_segments(10))
    controller.process(max_items=1)
    partial = recorder.analyses()[0]
    assert partial["final"] is False
    assert controller.analysis_get(workspace_id="ws", transcription_id="t") is not None


def test_append_then_submit_only_adds_new_segments() -> None:
    controller, _ = _controller()
    assert controller.append(
        transcription_id="t", workspace_id="ws", title="R", segments=_segments(10)
    ) == {"analysis": 1}
    result = controller.submit(
        transcription_id="t", workspace_id="ws", title="R", segments=_segments(12)
    )
    assert result["analysis"] == 3  # janelas que faltavam; a primeira já estava na fila
    runtime_status = controller.status()["analysis"]
    assert runtime_status["PENDING"] == 4


def test_submit_again_after_the_end_redoes_the_analysis() -> None:
    controller, _ = _controller()
    _submit(controller)
    controller.process(max_items=10)
    assert _submit(controller) == {"analysis": 1, "chunks": 1}
    assert controller.status()["analysis"]["PENDING"] == 1


def test_offline_ollama_keeps_items_pending() -> None:
    def offline(path: str, payload: dict[str, Any] | None) -> dict[str, Any]:
        raise OllamaUnavailableError("recusada")

    controller, recorder = _controller(post=offline)
    _submit(controller)
    assert controller.process(max_items=10) == {"analysis": 0, "index": 0}
    status = controller.status()
    assert status["analysis"]["PENDING"] == 1
    assert status["index"]["PENDING"] == 1
    assert recorder.analyses() == []


def test_final_pass_waits_while_ollama_is_offline() -> None:
    calls = {"generate": 0}

    def flaky(path: str, payload: dict[str, Any] | None) -> dict[str, Any]:
        if path == "/api/generate":
            calls["generate"] += 1
            if calls["generate"] == 2:
                raise OllamaUnavailableError("caiu")
        return _post(path, payload)

    controller, recorder = _controller(post=flaky)
    _submit(controller)
    controller.process(max_items=10)
    assert [event["final"] for event in recorder.analyses()] == [False]
    controller.process(max_items=10)
    assert [event["final"] for event in recorder.analyses()] == [False, True]


def test_retry_failed_windows() -> None:
    def invalid(path: str, payload: dict[str, Any] | None) -> dict[str, Any]:
        if path == "/api/generate":
            return {"response": "sem json"}
        return _post(path, payload)

    controller, _ = _controller(AiConfig(enabled=True, final_analysis_enabled=False), post=invalid)
    _submit(controller)
    for _ in range(3):
        controller.process(max_items=1)
    assert controller.status()["analysis"]["FAILED"] == 1
    assert controller.retry(transcription_id="t") == {"retried": 1}


def test_finalize_command_runs_now() -> None:
    controller, recorder = _controller()
    _submit(controller)
    payload = controller.finalize(transcription_id="t")
    assert payload["topics"][0]["name"] == "Sinc"
    assert recorder.analyses()[-1]["final"] is True


def test_search_reindex_cancel_and_delete() -> None:
    controller, recorder = _controller()
    _submit(controller)
    controller.process(max_items=10)
    results = controller.search(workspace_id="ws", query="sincronização", limit=5)
    assert results
    assert "ai_search" in recorder.types()
    assert controller.reindex(workspace_id="ws") == 1
    assert controller.cancel_reindex(workspace_id="ws") == {"canceled": 1}
    controller.delete(workspace_id="ws", transcription_id="t")
    assert controller.search(workspace_id="ws", query="sincronização", limit=5) == []
    assert controller.analysis_get(workspace_id="ws", transcription_id="t") is None
    assert controller.status()["analysis"].get("PENDING", 0) == 0


def test_entities_ask_and_status_details() -> None:
    controller, _ = _controller()
    _submit(controller)
    controller.process(max_items=10)
    everything = controller.search_entities(
        workspace_id="ws", kind=EntityKind.TOPIC, query=None, limit=10
    )
    assert everything[0]["label"] == "Sinc"
    found = controller.search_entities(
        workspace_id="ws", kind=EntityKind.TOPIC, query="sin", limit=10
    )
    assert len(found) == 1
    answer = controller.ask(workspace_id="ws", question="o que foi dito?", limit=3)
    assert answer["sources"]
    status = controller.status(workspace_id="ws")
    assert status["reindex_required"] is False
    assert status["storage"]["kind"] == "sqlite"


def test_status_flags_reindex_after_embedding_model_change(tmp_path: Path) -> None:
    path = str(tmp_path / "ai.sqlite")
    controller, _ = _controller(database_path=path)
    _submit(controller)
    controller.process(max_items=10)
    controller.configure(AiConfig(enabled=True, embedding_model="bge-m3"))
    assert controller.status(workspace_id="ws")["reindex_required"] is True
    assert controller.status()["reindex_required"] is False  # sem workspace, não verifica


def test_diagnose_and_pull_model() -> None:
    def pulling(path: str, payload: dict[str, Any] | None) -> dict[str, Any]:
        return _post(path, payload)

    controller, recorder = _controller(post=pulling)
    checks = {check["name"]: check for check in controller.diagnose()["checks"]}
    assert checks["ollama"]["ok"] is True
    assert checks["embeddings"]["ok"] is True
    runtime_client = controller._require().client
    runtime_client._stream = lambda _path, _payload: iter(
        [{"status": "pulling"}, {"status": "success"}]
    )
    assert controller.pull_model(model="qwen3:8b") == {"model": "qwen3:8b"}
    assert "ai_pull" in recorder.types()


def test_backup_and_restore(tmp_path: Path) -> None:
    controller, _ = _controller()
    _submit(controller)
    controller.process(max_items=10)
    target = tmp_path / "backup.json"
    summary = controller.backup(workspace_id="ws", path=str(target))
    assert summary["documents"] == 1
    other, _ = _controller()
    restored = other.restore(path=str(target), workspace_id="novo")
    assert restored["documents"] == 1
    assert restored["enqueued"] == 1


def test_storage_factory_receives_mode_and_embedding_model() -> None:
    received: list[tuple[StorageConfig | None, str | None]] = []

    def factory(
        config: StorageConfig | None, *, store: SQLiteStore, embedding_model: str | None
    ) -> StorageBackend:
        received.append((config, embedding_model))
        return sqlite_storage(store, fallback_reason="sem banco")

    controller, _ = _controller(storage_factory=factory)
    storage = StorageConfig(mode=StorageMode.AUTO)
    controller.configure(AiConfig(enabled=True), storage=storage)
    assert received[-1] == (storage, "nomic-embed-text")
    assert controller.status()["storage"] == {
        "kind": "sqlite",
        "fallback": True,
        "reason": "sem banco",
    }


def test_shutdown_stops_local_postgres() -> None:
    stopped: list[bool] = []

    def factory(
        config: StorageConfig | None, *, store: SQLiteStore, embedding_model: str | None
    ) -> StorageBackend:
        backend = postgres_storage(FakeConnection(), shutdown=lambda: stopped.append(True))
        backend.repository = sqlite_storage(store).repository
        return backend

    controller, _ = _controller(storage_factory=factory)
    controller.shutdown()
    assert stopped == [True]
    assert controller.configured is False
    controller.shutdown()  # sem runtime: nada a fazer


def test_background_pump_processes_without_blocking_commands() -> None:
    release = threading.Event()

    def slow(path: str, payload: dict[str, Any] | None) -> dict[str, Any]:
        if path == "/api/generate":
            release.wait(10)  # Ollama lento: segura a análise, não os comandos
        return _post(path, payload)

    controller, recorder = _controller(post=slow, background=True)
    started = time.monotonic()
    _submit(controller)
    assert controller.status()["configured"] is True
    assert time.monotonic() - started < 2.0
    _wait_until(lambda: controller.status()["index"].get("PENDING", 1) == 0)
    release.set()
    _wait_until(lambda: any(event["final"] for event in recorder.analyses()))
    controller.close()


def test_background_pump_uses_the_configured_concurrency() -> None:
    controller, _ = _controller(AiConfig(enabled=True, max_concurrent_analysis=3), background=True)
    assert controller.lanes == ["analysis-1", "analysis-2", "analysis-3", "index"]
    controller.configure(AiConfig(enabled=False))
    assert controller.lanes == []
    controller.close()


def test_steps_without_runtime_are_idle(capsys: pytest.CaptureFixture[str]) -> None:
    from transcriber_worker.ai.controller import _log
    from transcriber_worker.ai.pump import Step

    controller = AiController(Recorder(), post=_post)
    assert controller._analysis_step() is Step.IDLE
    assert controller._index_step() is Step.IDLE
    _log("[ia] teste")
    assert "[ia] teste" in capsys.readouterr().err


def test_append_twice_keeps_the_same_analysis() -> None:
    controller, _ = _controller()
    controller.append(transcription_id="t", workspace_id="ws", title="R", segments=_segments(3))
    result = controller.append(
        transcription_id="t", workspace_id="ws", title="R", segments=_segments(7, first=3)
    )
    assert result == {"analysis": 1}


def test_disabled_ai_never_provisions_postgres() -> None:
    received: list[StorageConfig | None] = []

    def factory(
        config: StorageConfig | None, *, store: SQLiteStore, embedding_model: str | None
    ) -> StorageBackend:
        received.append(config)
        return sqlite_storage(store)

    controller, _ = _controller(AiConfig(enabled=False), storage_factory=factory)
    controller.configure(AiConfig(enabled=False), storage=StorageConfig(mode=StorageMode.LOCAL))
    assert received[-1] is None  # só leitura do que já existe: nada de container
    controller.configure(AiConfig(enabled=True), storage=StorageConfig(mode=StorageMode.LOCAL))
    assert received[-1] == StorageConfig(mode=StorageMode.LOCAL)
