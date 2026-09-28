from __future__ import annotations

import pytest
from ai_core import LLMProvider, LLMResponse, ProviderLocation

from tests.ai.fakes import FakeAnalyzerProvider
from transcriber_worker.ai.analyzer import (
    SYSTEM_PROMPT,
    AnalysisError,
    IncrementalAnalyzer,
    build_analysis_prompt,
    parse_analysis_result,
)
from transcriber_worker.ai.queue import AnalysisItem
from transcriber_worker.ai.windows import SegmentInput


class _NoModelProvider(LLMProvider):
    name = "no-model"
    location = ProviderLocation.LOCAL

    def generate(self, request: object) -> LLMResponse:
        return LLMResponse(text='{"topics": [{"name": "sync"}]}')


def test_build_analysis_prompt_includes_range_and_text() -> None:
    prompt = build_analysis_prompt(start=10.0, end=20.0, text="conversa")
    assert "10.0s - 20.0s" in prompt
    assert "conversa" in prompt


def test_parse_plain_json() -> None:
    result = parse_analysis_result(
        '{"topics": [{"name": "Deploy"}]}', model="m", prompt_version="p"
    )
    assert result.topics[0].name == "Deploy"
    assert result.model == "m"
    assert result.prompt_version == "p"


def test_parse_fenced_json_with_language() -> None:
    raw = '```json\n{"tasks": [{"description": "subir"}]}\n```'
    assert parse_analysis_result(raw).tasks[0].description == "subir"


def test_parse_fenced_json_without_language() -> None:
    raw = '```\n{"people": [{"name": "João"}]}\n```'
    assert parse_analysis_result(raw).people[0].name == "João"


def test_parse_fenced_json_inline() -> None:
    raw = '```{"people": [{"name": "Maria"}]}```'
    assert parse_analysis_result(raw).people[0].name == "Maria"


def test_parse_without_json_raises() -> None:
    with pytest.raises(AnalysisError):
        parse_analysis_result("desculpe, não consegui analisar")


def test_parse_invalid_json_raises() -> None:
    with pytest.raises(AnalysisError):
        parse_analysis_result("{ isso não é json }")


def test_parse_schema_violation_raises() -> None:
    with pytest.raises(AnalysisError):
        parse_analysis_result('{"topics": [{"name": "x", "confidence": 5}]}')


def test_analyze_window_uses_provider() -> None:
    provider = FakeAnalyzerProvider()
    analyzer = IncrementalAnalyzer(provider, model="qwen3:8b", prompt_version="2")
    result = analyzer.analyze_window(start=0.0, end=45.0, text="reunião")
    assert result.model == "qwen3:8b"
    assert result.prompt_version == "2"
    request = provider.requests[0]
    assert request.system_prompt == SYSTEM_PROMPT
    assert request.model == "qwen3:8b"
    assert "reunião" in request.user_prompt


def test_analyze_window_falls_back_to_configured_model() -> None:
    analyzer = IncrementalAnalyzer(_NoModelProvider(), model="qwen3:8b")
    result = analyzer.analyze_window(start=0.0, end=1.0, text="x")
    assert result.model == "qwen3:8b"
    assert result.topics[0].name == "sync"


def test_analyze_item() -> None:
    provider = FakeAnalyzerProvider()
    analyzer = IncrementalAnalyzer(provider, model="m")
    item = AnalysisItem(transcription_id="t", start_time=0.0, end_time=5.0, text="olá")
    result = analyzer.analyze_item(item)
    assert result.model == "m"


WINDOW = [
    SegmentInput(index=3, start=12.0, end=15.5, text="João fará o deploy"),
    SegmentInput(index=4, start=15.5, end=20.0, text="até sexta"),
]


def test_prompt_numbers_segments_with_their_times() -> None:
    prompt = build_analysis_prompt(start=12.0, end=20.0, text="", segments=WINDOW)
    assert "[3 | 12.0s-15.5s] João fará o deploy" in prompt
    assert "[4 | 15.5s-20.0s] até sexta" in prompt


def test_system_prompt_describes_schema_and_sources() -> None:
    for field in ("source_segments", "assignee", "deadline", "severity", "answered", "role"):
        assert field in SYSTEM_PROMPT


def test_requests_json_output_from_provider() -> None:
    provider = FakeAnalyzerProvider()
    IncrementalAnalyzer(provider, model="m").analyze_window(start=0.0, end=1.0, text="x")
    assert provider.requests[0].metadata["format"] == "json"


def test_parse_ignores_thinking_block_with_braces() -> None:
    raw = '<think>talvez {"topics": []} ou não</think>\n{"topics": [{"name": "Deploy"}]}'
    assert parse_analysis_result(raw).topics[0].name == "Deploy"


def test_source_segment_indices_become_timestamps() -> None:
    provider = FakeAnalyzerProvider(
        responder=lambda _request: (
            '{"tasks": [{"description": "deploy", "source_segments": [4, 99]}]}'
        )
    )
    analyzer = IncrementalAnalyzer(provider, model="m")
    result = analyzer.analyze_window(start=12.0, end=20.0, text="", segments=WINDOW)
    refs = result.tasks[0].source_segments
    assert [(ref.segment_index, ref.start, ref.end) for ref in refs] == [(4, 15.5, 20.0)]


def test_source_segment_objects_are_resolved_by_index() -> None:
    provider = FakeAnalyzerProvider(
        responder=lambda _request: (
            '{"topics": [{"name": "deploy", "source_segments": [{"segment_index": 3}]}]}'
        )
    )
    analyzer = IncrementalAnalyzer(provider, model="m")
    result = analyzer.analyze_window(start=12.0, end=20.0, text="", segments=WINDOW)
    refs = result.topics[0].source_segments
    assert [(ref.start, ref.end) for ref in refs] == [(12.0, 15.5)]


def test_entities_without_sources_point_to_the_window() -> None:
    provider = FakeAnalyzerProvider(
        responder=lambda _request: '{"decisions": [{"description": "usar sqlite"}]}'
    )
    analyzer = IncrementalAnalyzer(provider, model="m")
    result = analyzer.analyze_window(start=12.0, end=20.0, text="", segments=WINDOW)
    refs = result.decisions[0].source_segments
    assert [(ref.segment_index, ref.start, ref.end) for ref in refs] == [(3, 12.0, 20.0)]


def test_invalid_sources_are_dropped_before_validation() -> None:
    provider = FakeAnalyzerProvider(
        responder=lambda _request: '{"people": [{"name": "Ana", "source_segments": "3"}]}'
    )
    analyzer = IncrementalAnalyzer(provider, model="m")
    result = analyzer.analyze_window(start=12.0, end=20.0, text="", segments=WINDOW)
    assert result.people[0].source_segments[0].segment_index == 3


def test_analyze_item_uses_item_segments() -> None:
    provider = FakeAnalyzerProvider()
    analyzer = IncrementalAnalyzer(provider, model="m")
    item = AnalysisItem(
        transcription_id="t", start_time=12.0, end_time=20.0, text="x", segments=WINDOW
    )
    analyzer.analyze_item(item)
    assert "[3 | 12.0s-15.5s]" in provider.requests[0].user_prompt


def test_non_object_entities_are_rejected() -> None:
    provider = FakeAnalyzerProvider(responder=lambda _request: '{"topics": ["solto"]}')
    analyzer = IncrementalAnalyzer(provider, model="m")
    with pytest.raises(AnalysisError):
        analyzer.analyze_window(start=12.0, end=20.0, text="", segments=WINDOW)
