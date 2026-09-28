"""Controlador da camada de IA do worker.

Ponte entre o protocolo (comandos/eventos) e os serviços de análise, indexação e
busca. Os comandos só enfileiram e respondem na hora; o :class:`AiPump` processa
as filas em segundo plano (``max_concurrent_analysis`` threads de análise e uma
de indexação) e publica os resultados como eventos. Ollama lento só aumenta a
fila: nenhum comando — nem a transcrição, que roda em outro processo — espera.
"""

from __future__ import annotations

import sys
import threading
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Any

from transcriber_worker.ai.analysis_store import EntityKind
from transcriber_worker.ai.backup import (
    export_workspace,
    read_backup,
    restore_workspace,
    write_backup,
)
from transcriber_worker.ai.config import AiConfig
from transcriber_worker.ai.diagnostics import WhisperProbe, run_diagnostics
from transcriber_worker.ai.entities import AnalysisResult
from transcriber_worker.ai.indexing import IndexStatus
from transcriber_worker.ai.ollama import OllamaUnavailableError, Post
from transcriber_worker.ai.pump import AiPump, Lane, Step
from transcriber_worker.ai.queue import AnalysisStatus
from transcriber_worker.ai.runtime import AiRuntime
from transcriber_worker.ai.storage import StorageBackend, StorageConfig, build_storage
from transcriber_worker.ai.store import SQLiteStore
from transcriber_worker.ai.windows import SegmentInput
from transcriber_worker.errors import ErrorCode, WorkerError
from transcriber_worker.events import (
    Emit,
    ai_analysis_event,
    ai_pull_event,
    ai_search_event,
    ai_status_event,
)

StorageFactory = Callable[..., StorageBackend]


def _log(message: str) -> None:
    # stderr vira log do app; nunca inclui conteúdo da transcrição.
    print(message, file=sys.stderr, flush=True)


class AiController:
    """Mantém o runtime de IA, o processamento em segundo plano e os comandos."""

    def __init__(
        self,
        emit: Emit,
        *,
        database_path: str = ":memory:",
        post: Post | None = None,
        storage_factory: StorageFactory = build_storage,
        whisper: WhisperProbe | None = None,
        background: bool = True,
    ) -> None:
        self._emit = emit
        self._database_path = database_path
        self._post = post
        self._storage_factory = storage_factory
        self._whisper = whisper
        self._background = background
        self._runtime: AiRuntime | None = None
        self._pump: AiPump | None = None
        self._lanes: list[str] = []
        self._lock = threading.RLock()
        self._finalizing: set[str] = set()

    @property
    def configured(self) -> bool:
        return self._runtime is not None

    @property
    def lanes(self) -> list[str]:
        return list(self._lanes)

    # ----- configuração e ciclo de vida -----

    def configure(
        self,
        config: AiConfig,
        *,
        database_path: str | None = None,
        storage: StorageConfig | None = None,
    ) -> AiConfig:
        with self._lock:
            self.close()
            path = database_path or self._database_path
            # IA desligada: só se lê o que já existe; nada de subir container ou conectar.
            wanted = storage if config.enabled else None

            def storage_for(store: SQLiteStore) -> StorageBackend:
                return self._storage_factory(
                    wanted, store=store, embedding_model=config.embedding_model
                )

            runtime = AiRuntime(
                config, database_path=path, post=self._post, storage_factory=storage_for
            )
            self._runtime = runtime
            if self._background and config.enabled and runtime.blocked_reason is None:
                self._start_pump(config)
        return config

    def _start_pump(self, config: AiConfig) -> None:
        lanes = [
            Lane(f"analysis-{number}", self._analysis_step, on_error=_log)
            for number in range(1, config.max_concurrent_analysis + 1)
        ]
        lanes.append(Lane("index", self._index_step, on_error=_log))
        self._pump = AiPump(lanes)
        self._lanes = [lane.name for lane in lanes]
        self._pump.start()

    def close(self) -> None:
        with self._lock:
            if self._pump is not None:
                self._pump.stop()
                self._pump = None
            self._lanes = []
            if self._runtime is not None:
                self._runtime.close()
                self._runtime = None

    def shutdown(self) -> None:
        """App fechando: para o processamento e o PostgreSQL local do app."""
        with self._lock:
            runtime = self._runtime
            if runtime is not None:
                runtime.shutdown()
            self.close()

    def _wake(self) -> None:
        if self._pump is not None:
            self._pump.wake()

    # ----- estado -----

    def status(self, workspace_id: str | None = None) -> dict[str, Any]:
        runtime = self._runtime
        if runtime is None:
            return {"configured": False, "enabled": False, "analysis": {}, "index": {}}
        return {
            "configured": True,
            "enabled": runtime.config.enabled,
            "blocked": runtime.blocked_reason,
            "analysis": {str(status): count for status, count in runtime.service.status().items()},
            "index": runtime.indexer.progress(),
            "storage": {
                "kind": runtime.storage.kind,
                "fallback": runtime.storage.fallback_reason is not None,
                "reason": runtime.storage.fallback_reason,
            },
            "reindex_required": self._reindex_required(runtime, workspace_id),
        }

    @staticmethod
    def _reindex_required(runtime: AiRuntime, workspace_id: str | None) -> bool:
        indexed_models = getattr(runtime.vector_store, "indexed_models", None)
        if workspace_id is None or indexed_models is None:
            return False
        models = indexed_models(workspace_id)
        return any(model != runtime.config.embedding_model for model in models)

    def _emit_status(self) -> None:
        self._emit(ai_status_event(self.status()))

    def diagnose(self) -> dict[str, Any]:
        runtime = self._require()
        checks = run_diagnostics(
            config=runtime.config,
            client=runtime.client,
            repository=runtime.repository,
            storage=runtime.storage,
            whisper=self._whisper,
        )
        return {"checks": [check.as_dict() for check in checks]}

    def pull_model(self, *, model: str) -> dict[str, Any]:
        runtime = self._require()
        runtime.client.pull(
            model, on_progress=lambda chunk: self._emit(ai_pull_event(model, chunk))
        )
        return {"model": model}

    # ----- análise -----

    def append(
        self,
        *,
        transcription_id: str,
        workspace_id: str,
        title: str,
        segments: Sequence[SegmentInput],
    ) -> dict[str, int]:
        """Segmentos novos de uma transcrição em andamento: a análise acompanha."""
        runtime = self._require_active()
        record = runtime.service.state.get(transcription_id)
        if record is None or record.closed or record.workspace_id != workspace_id:
            runtime.service.open(
                transcription_id=transcription_id, workspace_id=workspace_id, title=title
            )
        items = runtime.service.append(transcription_id, segments)
        self._wake()
        return {"analysis": len(items)}

    def submit(
        self,
        *,
        transcription_id: str,
        workspace_id: str,
        title: str,
        segments: Sequence[SegmentInput],
    ) -> dict[str, int]:
        """Transcrição concluída: fecha a análise e indexa (refazer substitui tudo)."""
        runtime = self._require_active()
        service = runtime.service
        record = service.state.get(transcription_id)
        fresh = list(segments)
        if record is None or record.closed or record.workspace_id != workspace_id:
            service.open(transcription_id=transcription_id, workspace_id=workspace_id, title=title)
        else:
            known = {segment.index for segment in record.segments}
            fresh = [segment for segment in segments if segment.index not in known]
        items = service.close(transcription_id, fresh)
        outcome = runtime.indexer.index_transcription(
            workspace_id=workspace_id,
            transcription_id=transcription_id,
            title=title,
            segments=segments,
        )
        self._wake()
        self._emit_status()
        return {"analysis": len(items), "chunks": len(outcome.items)}

    def retry(self, *, transcription_id: str | None) -> dict[str, int]:
        runtime = self._require_active()
        retried = runtime.service.retry_failed(transcription_id)
        self._wake()
        return {"retried": retried}

    def process(self, *, max_items: int) -> dict[str, int]:
        """Processa agora, na thread do comando (testes/diagnóstico)."""
        self._require_active()
        return {
            "analysis": self._run_steps(self._analysis_step, max_items),
            "index": self._run_steps(self._index_step, max_items),
        }

    @staticmethod
    def _run_steps(step: Callable[[], Step], max_items: int) -> int:
        done = 0
        while done < max_items and step() is Step.DONE:
            done += 1
        return done

    def _analysis_step(self) -> Step:
        runtime = self._runtime
        if runtime is None:
            return Step.IDLE
        item = runtime.service.process_next()
        if item is None:
            return self._finalize_step(runtime)
        if item.status is AnalysisStatus.COMPLETED:
            self._publish(
                runtime,
                item.transcription_id,
                item.workspace_id,
                runtime.service.consolidated(item.transcription_id),
                final=False,
            )
            return Step.DONE
        self._emit_status()
        return Step.BACKOFF

    def _finalize_step(self, runtime: AiRuntime) -> Step:
        with self._lock:
            ready = [
                record
                for record in runtime.service.ready_to_finalize()
                if record.transcription_id not in self._finalizing
            ]
            if not ready:
                return Step.IDLE
            record = ready[0]
            self._finalizing.add(record.transcription_id)
        try:
            result = runtime.service.finalize(record.transcription_id)
        except OllamaUnavailableError:
            return Step.BACKOFF
        finally:
            self._finalizing.discard(record.transcription_id)
        self._publish(runtime, record.transcription_id, record.workspace_id, result, final=True)
        return Step.DONE

    def _publish(
        self,
        runtime: AiRuntime,
        transcription_id: str,
        workspace_id: str,
        result: AnalysisResult,
        *,
        final: bool,
    ) -> None:
        runtime.analysis.save(
            workspace_id=workspace_id, transcription_id=transcription_id, result=result
        )
        payload = result.model_dump(mode="json")
        self._emit(ai_analysis_event(transcription_id, payload, final=final))
        self._emit_status()

    def _index_step(self) -> Step:
        runtime = self._runtime
        if runtime is None:
            return Step.IDLE
        item = runtime.indexer.process_next()
        if item is None:
            runtime.indexer.queue.purge_finished()
            runtime.service.queue.purge_finished()
            return Step.IDLE
        self._emit_status()
        return Step.DONE if item.status is IndexStatus.COMPLETED else Step.BACKOFF

    def finalize(self, *, transcription_id: str) -> dict[str, Any]:
        """Análise final imediata (sem esperar a fila)."""
        runtime = self._require_active()
        record = runtime.service.state.get(transcription_id)
        workspace_id = record.workspace_id if record is not None else "default"
        result = runtime.service.finalize(transcription_id)
        self._publish(runtime, transcription_id, workspace_id, result, final=True)
        return result.model_dump(mode="json")

    def analysis_get(self, *, workspace_id: str, transcription_id: str) -> dict[str, Any] | None:
        runtime = self._require()
        record = runtime.analysis.get(workspace_id=workspace_id, transcription_id=transcription_id)
        if record is None:
            return None
        return {
            "workspace_id": record.workspace_id,
            "transcription_id": record.transcription_id,
            "created_at": record.created_at.isoformat(),
            "result": record.result.model_dump(mode="json"),
        }

    def search_entities(
        self, *, workspace_id: str, kind: EntityKind, query: str | None, limit: int
    ) -> list[dict[str, Any]]:
        runtime = self._require()
        if query:
            records = runtime.analysis.search(
                workspace_id=workspace_id, kind=kind, query=query, limit=limit
            )
        else:
            records = runtime.analysis.list_entities(
                workspace_id=workspace_id, kind=kind, limit=limit
            )
        return [
            {
                "id": record.id,
                "transcription_id": record.transcription_id,
                "kind": str(record.kind),
                "label": record.label,
                "confidence": record.confidence,
                "entity": record.payload,
            }
            for record in records
        ]

    # ----- conhecimento -----

    def search(self, *, workspace_id: str, query: str, limit: int) -> list[dict[str, Any]]:
        runtime = self._require()
        results = [
            result.model_dump(mode="json")
            for result in runtime.query.search(workspace_id=workspace_id, query=query, limit=limit)
        ]
        self._emit(ai_search_event(results))
        return results

    def ask(self, *, workspace_id: str, question: str, limit: int) -> dict[str, Any]:
        runtime = self._require_active()
        result = runtime.answer.ask(workspace_id=workspace_id, question=question, limit=limit)
        return {
            "answer": result.answer,
            "model": result.model,
            "sources": [source.model_dump(mode="json") for source in result.sources],
        }

    def reindex(self, *, workspace_id: str) -> int:
        runtime = self._require()
        enqueued = runtime.indexer.reindex(workspace_id=workspace_id)
        self._wake()
        return enqueued

    def cancel_reindex(self, *, workspace_id: str) -> dict[str, int]:
        runtime = self._require()
        canceled = runtime.indexer.cancel_pending(workspace_id)
        self._emit_status()
        return {"canceled": canceled}

    def delete(self, *, workspace_id: str, transcription_id: str) -> None:
        """Exclusão remove todo o conhecimento derivado (CA17)."""
        runtime = self._require()
        runtime.service.forget(transcription_id)
        runtime.indexer.delete_transcription(
            workspace_id=workspace_id, transcription_id=transcription_id
        )
        runtime.analysis.delete(workspace_id=workspace_id, transcription_id=transcription_id)

    def backup(self, *, workspace_id: str, path: str) -> dict[str, int]:
        runtime = self._require()
        backup = export_workspace(runtime.repository, runtime.analysis, workspace_id=workspace_id)
        write_backup(backup, Path(path))
        return {
            "documents": len(backup.documents),
            "chunks": sum(len(entry.chunks) for entry in backup.documents),
            "analyses": len(backup.analyses),
        }

    def restore(self, *, path: str, workspace_id: str | None = None) -> dict[str, int]:
        runtime = self._require()
        backup = read_backup(Path(path))
        report = restore_workspace(
            runtime.repository, runtime.analysis, backup, target_workspace_id=workspace_id
        )
        enqueued = runtime.indexer.reindex(workspace_id=workspace_id or backup.workspace_id)
        self._wake()
        return {
            "documents": report.documents,
            "chunks": report.chunks,
            "sources": report.sources,
            "analyses": report.analyses,
            "enqueued": enqueued,
        }

    # ----- guardas -----

    def _require(self) -> AiRuntime:
        runtime = self._runtime
        if runtime is None:
            raise WorkerError(ErrorCode.AI_NOT_CONFIGURED, "IA não configurada")
        return runtime

    def _require_active(self) -> AiRuntime:
        runtime = self._require()
        if not runtime.config.enabled:
            raise WorkerError(ErrorCode.AI_DISABLED, "IA desligada")
        blocked = runtime.blocked_reason
        if blocked is not None:
            raise WorkerError(ErrorCode.AI_BLOCKED, blocked)
        return runtime
