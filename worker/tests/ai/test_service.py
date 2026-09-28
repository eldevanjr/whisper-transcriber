from __future__ import annotations

from pathlib import Path

from ai_core import LLMRequest

from tests.ai.fakes import FakeAnalyzerProvider
from transcriber_worker.ai.config import AiConfig
from transcriber_worker.ai.ollama import OllamaError, OllamaUnavailableError
from transcriber_worker.ai.queue import AnalysisStatus
from transcriber_worker.ai.service import AnalysisService
from transcriber_worker.ai.state import AnalysisState
from transcriber_worker.ai.store import SQLiteStore
from transcriber_worker.ai.windows import SegmentInput

TOPIC = '{"topics": [{"name": "Sincronização offline"}]}'


def _service(
    config: AiConfig | None = None,
    provider: FakeAnalyzerProvider | None = None,
    store: SQLiteStore | None = None,
) -> AnalysisService:
    return AnalysisService(
        config=config or AiConfig(enabled=True),
        provider=provider or FakeAnalyzerProvider(responder=lambda _request: TOPIC),
        store=store or SQLiteStore(),
    )


def _segments(count: int, *, step: float = 10.0, first: int = 0) -> list[SegmentInput]:
    return [
        SegmentInput(index=i, start=i * step, end=i * step + step, text=f"fala {i}")
        for i in range(first, first + count)
    ]


def _open(service: AnalysisService, transcription_id: str = "t") -> None:
    service.open(transcription_id=transcription_id, workspace_id="ws", title="Reunião")


def test_properties() -> None:
    service = _service(AiConfig())
    assert service.config.enabled is False
    assert service.queue.max_attempts == 3


def test_nothing_is_enqueued_when_disabled() -> None:
    service = _service(AiConfig(enabled=False))
    _open(service)
    assert service.append("t", _segments(10)) == []
    assert service.close("t") == []


def test_nothing_is_enqueued_when_incremental_disabled() -> None:
    service = _service(AiConfig(enabled=True, incremental_analysis_enabled=False))
    _open(service)
    assert service.close("t", _segments(10)) == []
    assert [record.transcription_id for record in service.ready_to_finalize()] == ["t"]


def test_append_only_enqueues_windows_that_can_no_longer_change() -> None:
    service = _service()
    _open(service)
    # janelas de 45 s com passo de 35 s; a margem espera trechos atrasados de outra faixa
    assert service.append("t", _segments(3)) == []
    items = service.append("t", _segments(7, first=3))  # último começa em 90 s
    assert [(item.start_time, item.end_time) for item in items] == [(0.0, 45.0)]
    assert [segment.index for segment in items[0].segments] == [0, 1, 2, 3, 4]
    assert items[0].workspace_id == "ws"


def test_close_enqueues_the_remaining_windows_once() -> None:
    service = _service()
    _open(service)
    service.append("t", _segments(10))
    items = service.close("t", _segments(2, first=10))
    starts = [item.start_time for item in service.queue.items()]
    assert starts == [0.0, 35.0, 70.0, 105.0]
    assert [item.window_index for item in items] == [1, 2, 3]


def test_close_with_all_segments_at_once() -> None:
    service = _service()
    _open(service)
    items = service.close("t", _segments(5))
    assert [(item.start_time, item.end_time) for item in items] == [(0.0, 45.0), (35.0, 50.0)]


def test_segments_of_unknown_transcription_are_ignored() -> None:
    service = _service()
    assert service.append("nada", _segments(20)) == []
    assert service.close("nada", _segments(2)) == []


def test_process_next_stores_partials_until_finalized() -> None:
    service = _service()
    _open(service)
    service.close("t", _segments(5))  # duas janelas: 0-45 s e 35-50 s
    assert service.ready_to_finalize() == []
    first = service.process_next()
    assert first is not None
    assert first.status is AnalysisStatus.COMPLETED
    assert service.ready_to_finalize() == []  # ainda há janela pendente
    service.process_next()
    assert [record.transcription_id for record in service.ready_to_finalize()] == ["t"]
    assert [topic.name for topic in service.consolidated("t").topics] == ["Sincronização offline"]


def test_process_next_on_empty_queue() -> None:
    assert _service().process_next() is None


def test_ollama_offline_releases_the_item_without_spending_attempts() -> None:
    provider = FakeAnalyzerProvider(error=OllamaUnavailableError("recusada"))
    service = _service(provider=provider)
    _open(service)
    service.close("t", _segments(1))
    for _ in range(5):
        item = service.process_next()
        assert item is not None
        assert item.status is AnalysisStatus.PENDING
        assert item.attempts == 0


def test_invalid_answers_fail_after_the_attempt_limit() -> None:
    provider = FakeAnalyzerProvider(responder=lambda _request: "sem json")
    service = _service(provider=provider)
    _open(service)
    service.close("t", _segments(1))
    statuses = [service.process_next() for _ in range(3)]
    assert [item.status for item in statuses if item is not None] == [
        AnalysisStatus.PENDING,
        AnalysisStatus.PENDING,
        AnalysisStatus.FAILED,
    ]
    # janela que falhou de vez não segura a análise final
    assert [record.transcription_id for record in service.ready_to_finalize()] == ["t"]


def test_ollama_error_counts_as_a_failed_attempt() -> None:
    service = _service(provider=FakeAnalyzerProvider(error=OllamaError("404 modelo")))
    _open(service)
    service.close("t", _segments(1))
    item = service.process_next()
    assert item is not None
    assert item.attempts == 1


def test_finalize_runs_final_pass_and_marks_the_transcription() -> None:
    requests: list[LLMRequest] = []

    def respond(request: LLMRequest) -> str:
        requests.append(request)
        return TOPIC

    service = _service(provider=FakeAnalyzerProvider(responder=respond))
    _open(service)
    service.close("t", _segments(2))
    service.process_next()
    result = service.finalize("t")
    assert [topic.name for topic in result.topics] == ["Sincronização offline"]
    assert "Transcrição (fonte principal)" in requests[-1].user_prompt
    assert service.ready_to_finalize() == []


def test_finalize_without_final_pass_consolidates_partials() -> None:
    provider = FakeAnalyzerProvider(responder=lambda _request: TOPIC)
    service = _service(AiConfig(enabled=True, final_analysis_enabled=False), provider)
    _open(service)
    service.close("t", _segments(2))
    service.process_next()
    calls = len(provider.requests)
    result = service.finalize("t")
    assert len(provider.requests) == calls
    assert len(result.topics) == 1


def test_finalize_falls_back_to_partials_when_final_pass_fails() -> None:
    answers = iter([TOPIC, "sem json"])
    service = _service(provider=FakeAnalyzerProvider(responder=lambda _request: next(answers)))
    _open(service)
    service.close("t", _segments(2))
    service.process_next()
    result = service.finalize("t")
    assert len(result.topics) == 1
    assert service.ready_to_finalize() == []


def test_finalize_keeps_waiting_while_ollama_is_offline() -> None:
    service = _service(provider=FakeAnalyzerProvider(error=OllamaUnavailableError("off")))
    _open(service)
    service.close("t", _segments(1))
    service.queue.remove_where(lambda _item: True)
    try:
        service.finalize("t")
    except OllamaUnavailableError:
        pass
    else:  # pragma: no cover - a falha é o esperado
        raise AssertionError("deveria propagar")
    assert [record.transcription_id for record in service.ready_to_finalize()] == ["t"]


def test_finalize_unknown_transcription_returns_empty() -> None:
    assert _service().finalize("nada").is_empty() is True


def test_reopen_discards_previous_windows_and_partials() -> None:
    service = _service()
    _open(service)
    service.close("t", _segments(5))
    service.process_next()
    _open(service)
    assert service.queue.items() == []
    assert service.consolidated("t").is_empty() is True


def test_retry_failed_requeues_windows() -> None:
    service = _service(provider=FakeAnalyzerProvider(responder=lambda _request: "sem json"))
    _open(service)
    service.close("t", _segments(1))
    for _ in range(3):
        service.process_next()
    assert service.retry_failed("t") == 1
    assert service.retry_failed(None) == 0
    assert service.status()[AnalysisStatus.PENDING] == 1


def test_forget_removes_windows_and_state() -> None:
    service = _service()
    _open(service)
    service.close("t", _segments(5))
    service.forget("t")
    assert service.queue.items() == []
    assert service.ready_to_finalize() == []


def test_pending_windows_survive_restart(tmp_path: Path) -> None:
    path = str(tmp_path / "ai.sqlite")
    store = SQLiteStore(path)
    service = _service(store=store)
    _open(service)
    service.close("t", _segments(5))
    service.process_next()
    store.close()

    reopened = SQLiteStore(path)
    restored = _service(store=reopened)
    assert restored.status()[AnalysisStatus.PENDING] == 1
    restored.process_next()
    assert [record.transcription_id for record in restored.ready_to_finalize()] == ["t"]
    assert len(restored.consolidated("t").topics) == 1
    reopened.close()


def test_state_is_exposed_for_other_components() -> None:
    store = SQLiteStore()
    service = _service(store=store)
    assert isinstance(service.state, AnalysisState)


def test_window_finished_after_forget_leaves_no_partial() -> None:
    holder: dict[str, AnalysisService] = {}

    def respond(_request: LLMRequest) -> str:
        holder["service"].forget("t")  # a transcrição foi excluída durante a análise
        return TOPIC

    service = _service(provider=FakeAnalyzerProvider(responder=respond))
    holder["service"] = service
    _open(service)
    service.close("t", _segments(1))
    item = service.process_next()
    assert item is not None
    assert service.state.partials("t") == []
