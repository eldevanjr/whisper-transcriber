from __future__ import annotations

import pytest
from pydantic import ValidationError

from transcriber_worker.ai.config import AiConfig


def test_defaults() -> None:
    config = AiConfig()
    assert config.enabled is False
    assert config.ollama_url == "http://localhost:11434"
    assert config.llm_model == "qwen3:8b"
    assert config.embedding_model == "nomic-embed-text"
    assert config.incremental_analysis_enabled is True
    assert config.final_analysis_enabled is True
    assert config.analysis_window_seconds == 45.0
    assert config.analysis_overlap_seconds == 10.0
    assert config.max_concurrent_analysis == 1
    assert config.prompt_version == "1"


def test_overlap_must_be_smaller_than_window() -> None:
    with pytest.raises(ValidationError):
        AiConfig(analysis_window_seconds=10.0, analysis_overlap_seconds=10.0)


@pytest.mark.parametrize(
    "overrides",
    [
        {"analysis_window_seconds": 0.0},
        {"analysis_overlap_seconds": -1.0},
        {"max_concurrent_analysis": 0},
        {"request_timeout_seconds": 0.0},
    ],
)
def test_bounds(overrides: dict[str, float]) -> None:
    with pytest.raises(ValidationError):
        AiConfig(**overrides)


def test_extra_forbidden() -> None:
    with pytest.raises(ValidationError):
        AiConfig.model_validate({"unknown": 1})


def test_default_timeout_tolerates_slow_gpus() -> None:
    # Em streaming o limite é de inatividade: 10 min cobre esperar a passada final na GPU.
    assert AiConfig().request_timeout_seconds == 600.0
