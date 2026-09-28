"""Serviço de análise incremental: junta configuração, fila, estado e analyzer.

Os segmentos chegam enquanto a transcrição anda (:meth:`AnalysisService.append`);
cada janela que não pode mais mudar entra na fila na hora — a análise acompanha
a transcrição, sem esperar ela acabar. No fim (:meth:`AnalysisService.close`)
entram as janelas restantes e, com a fila da transcrição vazia, a análise final.

Fila e resultados parciais ficam no SQLite (:mod:`transcriber_worker.ai.state`):
fechar o app ou reconfigurar a IA não perde nada.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence

from ai_core import LLMProvider

from transcriber_worker.ai.analyzer import AnalysisError, IncrementalAnalyzer
from transcriber_worker.ai.config import AiConfig
from transcriber_worker.ai.consolidation import consolidate_results
from transcriber_worker.ai.entities import AnalysisResult
from transcriber_worker.ai.final import FinalAnalyzer
from transcriber_worker.ai.ollama import OllamaError, OllamaUnavailableError
from transcriber_worker.ai.queue import AnalysisItem, AnalysisQueue, AnalysisStatus
from transcriber_worker.ai.state import (
    AnalysisState,
    SQLiteQueueJournal,
    TranscriptionRecord,
)
from transcriber_worker.ai.store import SQLiteStore
from transcriber_worker.ai.windows import SegmentInput, SegmentWindow, build_windows

# Com duas faixas (ao vivo), um trecho de uma pode chegar depois de trechos da outra que
# começaram mais tarde: a janela só é fechada com esta folga.
LATE_SEGMENT_MARGIN_SECONDS = 15.0


class AnalysisService:
    """Orquestra a análise incremental (e final) de transcrições."""

    def __init__(
        self,
        *,
        config: AiConfig,
        provider: LLMProvider,
        store: SQLiteStore,
        analyzer: IncrementalAnalyzer | None = None,
    ) -> None:
        self._config = config
        self._provider = provider
        self._state = AnalysisState(store)
        self._queue = AnalysisQueue(journal=SQLiteQueueJournal(store, "analysis", AnalysisItem))
        self._analyzer = analyzer or IncrementalAnalyzer(
            provider, model=config.llm_model, prompt_version=config.prompt_version
        )

    @property
    def config(self) -> AiConfig:
        return self._config

    @property
    def queue(self) -> AnalysisQueue:
        return self._queue

    @property
    def state(self) -> AnalysisState:
        return self._state

    @property
    def _incremental(self) -> bool:
        return self._config.enabled and self._config.incremental_analysis_enabled

    def open(self, *, transcription_id: str, workspace_id: str, title: str) -> None:
        """Começa (ou refaz do zero) a análise de uma transcrição."""
        self._queue.remove_where(lambda item: item.transcription_id == transcription_id)
        self._state.open(
            TranscriptionRecord(
                transcription_id=transcription_id, workspace_id=workspace_id, title=title
            )
        )

    def append(self, transcription_id: str, segments: Sequence[SegmentInput]) -> list[AnalysisItem]:
        """Guarda os segmentos novos e enfileira as janelas que já não mudam."""
        self._state.append_segments(transcription_id, segments)
        record = self._state.get(transcription_id)
        if record is None or not record.segments:
            return []
        latest = max(segment.start for segment in record.segments)
        horizon = latest - LATE_SEGMENT_MARGIN_SECONDS
        return self._enqueue(
            record,
            lambda window: window.start + self._config.analysis_window_seconds <= horizon,
        )

    def close(
        self, transcription_id: str, segments: Sequence[SegmentInput] = ()
    ) -> list[AnalysisItem]:
        """Transcrição terminou: enfileira o que falta e libera a análise final."""
        self._state.append_segments(transcription_id, segments)
        record = self._state.get(transcription_id)
        if record is None:
            return []
        items = self._enqueue(record, lambda _window: True)
        self._state.close_transcription(transcription_id)
        return items

    def _enqueue(
        self, record: TranscriptionRecord, ready: Callable[[SegmentWindow], bool]
    ) -> list[AnalysisItem]:
        if not self._incremental or not record.segments:
            return []
        windows = build_windows(
            record.segments,
            transcription_id=record.transcription_id,
            window_seconds=self._config.analysis_window_seconds,
            overlap_seconds=self._config.analysis_overlap_seconds,
        )
        by_index = {segment.index: segment for segment in record.segments}
        fresh: list[SegmentWindow] = []
        for window in windows[record.windows :]:
            if not ready(window):
                break
            fresh.append(window)
        items = [
            AnalysisItem(
                transcription_id=record.transcription_id,
                workspace_id=record.workspace_id,
                start_time=window.start,
                end_time=window.end,
                text=window.text,
                model=self._config.llm_model,
                prompt_version=self._config.prompt_version,
                segments=[by_index[index] for index in window.segment_indices],
                window_index=window.index,
            )
            for window in fresh
        ]
        self._state.set_windows(record.transcription_id, record.windows + len(items))
        return self._queue.enqueue_many(items)

    def process_next(self) -> AnalysisItem | None:
        """Processa a próxima janela pendente. ``None`` se a fila estiver vazia.

        Ollama fora do ar devolve a janela à fila sem gastar tentativa (quem chama
        espera um pouco antes de tentar de novo); resposta inválida gasta tentativa.
        """
        item = self._queue.dequeue()
        if item is None:
            return None
        try:
            result = self._analyzer.analyze_item(item)
        except OllamaUnavailableError as exc:
            return self._queue.release(item.id, str(exc))
        except (AnalysisError, OllamaError) as exc:
            return self._queue.fail(item.id, str(exc))
        if self._queue.get(item.id) is not None:  # excluída/refeita enquanto analisava: descarta
            self._state.add_partial(item.transcription_id, item.id, item.start_time, result)
        return self._queue.complete(item.id)

    def ready_to_finalize(self) -> list[TranscriptionRecord]:
        """Transcrições encerradas sem janela pendente e ainda sem análise final."""
        return [
            record
            for record in self._state.awaiting_finalization()
            if not self._has_open_windows(record.transcription_id)
        ]

    def _has_open_windows(self, transcription_id: str) -> bool:
        return self._queue.has_open(lambda item: item.transcription_id == transcription_id)

    def finalize(self, transcription_id: str) -> AnalysisResult:
        """Passada final (se habilitada) reconciliada com as janelas.

        Ollama fora do ar propaga (a transcrição continua aguardando); outra falha
        da passada final cai para o consolidado das janelas.
        """
        record = self._state.get(transcription_id)
        if record is None:
            return AnalysisResult()
        partials = self._state.partials(transcription_id)
        analyzer = FinalAnalyzer(
            self._provider,
            model=self._config.llm_model,
            prompt_version=self._config.prompt_version,
            enabled=self._config.enabled and self._config.final_analysis_enabled,
        )
        try:
            result = analyzer.run(segments=record.segments, incremental=partials)
        except OllamaUnavailableError:
            raise
        except (AnalysisError, OllamaError):
            result = consolidate_results(partials)
        self._state.mark_finalized(transcription_id)
        return result

    def consolidated(self, transcription_id: str) -> AnalysisResult:
        return consolidate_results(self._state.partials(transcription_id))

    def retry_failed(self, transcription_id: str | None) -> int:
        """Janelas que falharam de vez voltam à fila (todas, se ``None``)."""
        return self._queue.retry_failed(
            lambda item: transcription_id is None or item.transcription_id == transcription_id
        )

    def forget(self, transcription_id: str) -> None:
        self._queue.remove_where(lambda item: item.transcription_id == transcription_id)
        self._state.delete(transcription_id)

    def status(self) -> dict[AnalysisStatus, int]:
        return {AnalysisStatus(status): count for status, count in self._queue.counts().items()}
