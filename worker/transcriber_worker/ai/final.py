"""Análise final: revisa o resultado incremental usando a transcrição completa.

A transcrição inteira é a fonte principal (plano §8). Para não estourar o contexto
do modelo, ela vai em seções que cabem em ``section_chars``; cada seção leva a
lista dos itens já vistos pelo incremental como contexto auxiliar. No fim, a
passada final manda e o incremental só confirma (:func:`reconcile`).

A transcrição original nunca é alterada.
"""

from __future__ import annotations

from collections.abc import Sequence

from ai_core import LLMProvider

from transcriber_worker.ai.analyzer import CONTEXT_TOKENS, SYSTEM_PROMPT, IncrementalAnalyzer
from transcriber_worker.ai.consolidation import consolidate_results, reconcile
from transcriber_worker.ai.entities import AnalysisResult
from transcriber_worker.ai.windows import SegmentInput

# O mesmo contexto das janelas (sem recarregar o modelo no Ollama).
FINAL_CONTEXT_TOKENS = CONTEXT_TOKENS
# Seção + itens auxiliares + sistema ficam dentro de PROMPT_BUDGET_CHARS (GPUs fracas).
DEFAULT_SECTION_CHARS = 6_000
# A passada final consolida uma seção inteira: resposta maior que a de uma janela.
FINAL_MAX_TOKENS = 2048
_CONTEXT_CHARS = 2_000


def _line(segment: SegmentInput) -> str:
    return f"[{segment.index} | {segment.start:.1f}s-{segment.end:.1f}s] {segment.text}"


def split_sections(
    segments: Sequence[SegmentInput], *, section_chars: int
) -> list[list[SegmentInput]]:
    """Agrupa segmentos consecutivos sem passar de ``section_chars`` por seção."""
    sections: list[list[SegmentInput]] = []
    current: list[SegmentInput] = []
    size = 0
    for segment in sorted(segments, key=lambda item: (item.start, item.index)):
        length = len(_line(segment)) + 1
        if current and size + length > section_chars:
            sections.append(current)
            current, size = [], 0
        current.append(segment)
        size += length
    if current:
        sections.append(current)
    return sections


def _incremental_context(incremental: AnalysisResult) -> str:
    lines = [
        *(f"- tópico: {item.name}" for item in incremental.topics),
        *(f"- tarefa: {item.description}" for item in incremental.tasks),
        *(f"- decisão: {item.description}" for item in incremental.decisions),
        *(f"- problema: {item.description}" for item in incremental.problems),
        *(f"- pergunta: {item.question}" for item in incremental.questions),
        *(f"- pessoa: {item.name}" for item in incremental.people),
    ]
    return "\n".join(lines)[:_CONTEXT_CHARS]


def build_final_prompt(section: Sequence[SegmentInput], incremental: AnalysisResult) -> str:
    context = _incremental_context(incremental)
    auxiliary = (
        "\n\nItens detectados antes, por trechos (contexto auxiliar; mantenha só o que a "
        f"transcrição confirma e corrija contradições):\n{context}"
        if context
        else ""
    )
    return (
        "Transcrição (fonte principal):\n"
        + "\n".join(_line(segment) for segment in section)
        + auxiliary
        + "\n\nConsolide o que existe nesta transcrição e devolva apenas o JSON."
    )


class FinalAnalyzer:
    """Executa a passada final (transcrição inteira) e reconcilia com o incremental."""

    def __init__(
        self,
        provider: LLMProvider,
        *,
        model: str,
        prompt_version: str = "1",
        enabled: bool = True,
        system_prompt: str = SYSTEM_PROMPT,
        section_chars: int = DEFAULT_SECTION_CHARS,
    ) -> None:
        self._enabled = enabled
        self._section_chars = section_chars
        self._analyzer = IncrementalAnalyzer(
            provider, model=model, prompt_version=prompt_version, system_prompt=system_prompt
        )

    def run(
        self, *, segments: Sequence[SegmentInput], incremental: Sequence[AnalysisResult]
    ) -> AnalysisResult:
        """Consolida o incremental e, se habilitado, revisa com a transcrição inteira."""
        consolidated = consolidate_results(incremental)
        if not self._enabled or not segments:
            return consolidated
        sections = [
            self._analyzer.analyze_window(
                start=section[0].start,
                end=max(segment.end for segment in section),
                text="",
                segments=section,
                prompt=build_final_prompt(section, consolidated),
                context_tokens=FINAL_CONTEXT_TOKENS,
                max_tokens=FINAL_MAX_TOKENS,
            )
            for section in split_sections(segments, section_chars=self._section_chars)
        ]
        return reconcile(consolidate_results(sections), consolidated)
