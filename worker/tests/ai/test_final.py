from __future__ import annotations

from tests.ai.fakes import FakeAnalyzerProvider
from transcriber_worker.ai.entities import AnalysisResult, Topic
from transcriber_worker.ai.final import FINAL_CONTEXT_TOKENS, FinalAnalyzer, split_sections
from transcriber_worker.ai.windows import SegmentInput

SEGMENTS = [SegmentInput(index=0, start=0.0, end=10.0, text="reunião")]


def test_disabled_only_consolidates_incremental() -> None:
    provider = FakeAnalyzerProvider(responder=lambda _request: '{"topics": [{"name": "final"}]}')
    analyzer = FinalAnalyzer(provider, model="m", enabled=False)
    incremental = [AnalysisResult(topics=[Topic(name="inc")])]
    result = analyzer.run(segments=SEGMENTS, incremental=incremental)
    assert provider.requests == []
    assert [topic.name for topic in result.topics] == ["inc"]


def test_enabled_runs_final_and_consolidates() -> None:
    provider = FakeAnalyzerProvider(responder=lambda _request: '{"topics": [{"name": "Sinc"}]}')
    analyzer = FinalAnalyzer(provider, model="m", enabled=True, prompt_version="2")
    incremental = [AnalysisResult(topics=[Topic(name=" sinc ")])]
    result = analyzer.run(segments=SEGMENTS, incremental=incremental)
    assert len(provider.requests) == 1
    assert provider.requests[0].model == "m"
    assert [topic.name for topic in result.topics] == ["Sinc"]
    assert result.prompt_version == "2"


def test_empty_segments_skips_final_pass() -> None:
    provider = FakeAnalyzerProvider()
    analyzer = FinalAnalyzer(provider, model="m", enabled=True)
    result = analyzer.run(segments=[], incremental=[AnalysisResult(topics=[Topic(name="inc")])])
    assert provider.requests == []
    assert [topic.name for topic in result.topics] == ["inc"]


def _numbered(count: int, words: int = 5) -> list[SegmentInput]:
    return [
        SegmentInput(
            index=index,
            start=index * 10.0,
            end=index * 10.0 + 10.0,
            text=" ".join(["fala"] * words),
        )
        for index in range(count)
    ]


def test_final_prompt_numbers_segments_and_lists_incremental_items() -> None:
    provider = FakeAnalyzerProvider(responder=lambda _request: '{"topics": []}')
    analyzer = FinalAnalyzer(provider, model="m", enabled=True)
    incremental = [AnalysisResult(topics=[Topic(name="Deploy")])]
    analyzer.run(segments=_numbered(2), incremental=incremental)
    request = provider.requests[0]
    assert "[1 | 10.0s-20.0s]" in request.user_prompt
    assert "Deploy" in request.user_prompt
    assert request.metadata["num_ctx"] == FINAL_CONTEXT_TOKENS


def test_long_transcripts_are_analyzed_in_sections_that_fit_the_context() -> None:
    provider = FakeAnalyzerProvider(responder=lambda _request: '{"topics": []}')
    analyzer = FinalAnalyzer(provider, model="m", enabled=True, section_chars=60)
    segments = _numbered(6)  # cada linha tem ~40 caracteres: 2 por seção não cabe, 1 cabe
    analyzer.run(segments=segments, incremental=[])
    assert len(provider.requests) == 6
    assert all(len(request.user_prompt) < 600 for request in provider.requests)


def test_final_sources_come_from_numbered_segments() -> None:
    provider = FakeAnalyzerProvider(
        responder=lambda _request: '{"tasks": [{"description": "deploy", "source_segments": [1]}]}'
    )
    analyzer = FinalAnalyzer(provider, model="m", enabled=True)
    result = analyzer.run(segments=_numbered(2), incremental=[])
    ref = result.tasks[0].source_segments[0]
    assert (ref.segment_index, ref.start, ref.end) == (1, 10.0, 20.0)


def test_final_drops_unconfirmed_low_confidence_incremental_items() -> None:
    provider = FakeAnalyzerProvider(responder=lambda _request: '{"topics": [{"name": "Deploy"}]}')
    analyzer = FinalAnalyzer(provider, model="m", enabled=True)
    incremental = [
        AnalysisResult(topics=[Topic(name="deploy"), Topic(name="ruído", confidence=0.2)])
    ]
    result = analyzer.run(segments=SEGMENTS, incremental=incremental)
    assert [topic.name for topic in result.topics] == ["Deploy"]


def test_split_sections_of_nothing() -> None:
    assert split_sections([], section_chars=100) == []
