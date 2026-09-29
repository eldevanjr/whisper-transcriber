"""Configuração da camada de IA local (Ollama) do worker.

Nenhum modelo é fixo em código: os valores abaixo são apenas os padrões
sugeridos pelo plano e podem ser sobrescritos pelo app via comando.
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field, model_validator


class AiConfig(BaseModel):
    """Parâmetros de IA/análise incremental."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    enabled: bool = False
    ollama_url: str = "http://localhost:11434"
    llm_model: str = "qwen3:8b"
    embedding_model: str = "nomic-embed-text"
    incremental_analysis_enabled: bool = True
    final_analysis_enabled: bool = True
    analysis_window_seconds: float = Field(default=45.0, gt=0)
    analysis_overlap_seconds: float = Field(default=10.0, ge=0)
    max_concurrent_analysis: int = Field(default=1, ge=1, le=16)
    prompt_version: str = "1"
    # Tempo sem receber nada do Ollama (a geração é em streaming): numa GPU fraca, esperar a
    # passada final de outra transcrição leva minutos sem que nada esteja travado.
    request_timeout_seconds: float = Field(default=600.0, gt=0)
    # Ollama num host público só com opção explícita (plano §24: nada vai à nuvem sozinho).
    allow_remote_ollama: bool = False

    @model_validator(mode="after")
    def _validate_overlap(self) -> AiConfig:
        if self.analysis_overlap_seconds >= self.analysis_window_seconds:
            raise ValueError("analysis_overlap_seconds deve ser menor que analysis_window_seconds")
        return self
