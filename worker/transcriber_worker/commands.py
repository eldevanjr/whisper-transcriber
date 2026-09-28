"""Executa cada comando recebido e responde com result/error (sempre com o id do comando)."""

import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

from transcriber_worker.ai.analysis_store import EntityKind
from transcriber_worker.ai.config import AiConfig
from transcriber_worker.ai.controller import AiController
from transcriber_worker.ai.storage import StorageConfig
from transcriber_worker.ai.windows import SegmentInput
from transcriber_worker.audio import OnProgress, extract_audio
from transcriber_worker.engine import Engine
from transcriber_worker.errors import ErrorCode, WorkerError, classify_exception
from transcriber_worker.events import (
    Emit,
    Event,
    done_event,
    error_event,
    phase_event,
    progress_event,
    result_event,
)
from transcriber_worker.live.finalize import finalize
from transcriber_worker.live.segmenter import VadFn
from transcriber_worker.live.session import LiveSession
from transcriber_worker.live.vad import StreamingVad
from transcriber_worker.protocol import (
    AiDiagnoseCommand,
    AiPullModelCommand,
    AiStatusCommand,
    AnalysisAppendCommand,
    AnalysisFinalizeCommand,
    AnalysisGetCommand,
    AnalysisProcessCommand,
    AnalysisRetryCommand,
    AnalysisSubmitCommand,
    Command,
    ConfigureAiCommand,
    KnowledgeAskCommand,
    KnowledgeBackupCommand,
    KnowledgeDeleteCommand,
    KnowledgeReindexCancelCommand,
    KnowledgeReindexCommand,
    KnowledgeRestoreCommand,
    KnowledgeSearchCommand,
    KnowledgeSearchEntitiesCommand,
    LiveAudioCommand,
    LiveFinalizeCommand,
    LivePauseCommand,
    LiveStartCommand,
    LiveStopCommand,
    LoadModelCommand,
    LoadModelParams,
    SelfTestCommand,
    TranscribeCommand,
    TranscribeParams,
)

SELF_TEST_AUDIO = Path(__file__).parent / "assets" / "self_test.wav"

Extract = Callable[[str, str, OnProgress], None]


def _discard(_event: Event) -> None:
    return None


def default_vad_factory() -> VadFn:
    return StreamingVad().feed


class Dispatcher:
    def __init__(
        self,
        engine: Engine,
        emit: Emit,
        *,
        extract: Extract = extract_audio,
        self_test_audio: Path = SELF_TEST_AUDIO,
        ai: AiController | None = None,
    ) -> None:
        self._engine = engine
        self._emit = emit
        self._extract = extract
        self._self_test_audio = self_test_audio
        self._live: LiveSession | None = None
        self._ai = ai or AiController(emit, whisper=engine.describe)

    def handle(self, command: Command) -> bool:
        try:
            data = self._run(command)
        except Exception as exc:
            job_id = command.params.job_id if isinstance(command, TranscribeCommand) else None
            self._emit(error_event(classify_exception(exc), command_id=command.id, job_id=job_id))
        else:
            # Os blocos do ao vivo chegam 10 vezes por segundo por faixa: só erros respondem.
            if not isinstance(command, LiveAudioCommand):
                self._emit(result_event(command.id, data))
        if command.cmd == "shutdown":
            self.close()
        return command.cmd != "shutdown"

    def close(self) -> None:
        """Fim do processo: para a IA (e o PostgreSQL local que ela subiu)."""
        self._ai.shutdown()

    def _run(self, command: Command) -> dict[str, Any]:
        if isinstance(
            command, LiveAudioCommand | LiveStartCommand | LiveStopCommand | LivePauseCommand
        ):
            return self._run_live(command)
        if isinstance(command, LiveFinalizeCommand):
            return {"durations": finalize(Path(command.params.dir), list(command.params.tracks))}
        if isinstance(command, LoadModelCommand):
            return self._load_model(command.params)
        if isinstance(command, TranscribeCommand | SelfTestCommand):
            self._require_no_live()
            if isinstance(command, TranscribeCommand):
                return self._run_transcribe(command.params)
            return self._self_test()
        ai_result = self._run_ai(command)
        if ai_result is None:
            ai_result = self._run_knowledge(command)
        return ai_result if ai_result is not None else {}

    def _run_ai(self, command: Command) -> dict[str, Any] | None:
        if isinstance(command, ConfigureAiCommand):
            config = AiConfig(**command.params.model_dump(exclude={"database_path", "storage"}))
            storage = (
                StorageConfig(**command.params.storage.model_dump())
                if command.params.storage is not None
                else None
            )
            _ = self._ai.configure(
                config, database_path=command.params.database_path, storage=storage
            )
            return {"status": self._ai.status()}
        analysis = self._run_analysis(command)
        if analysis is not None:
            return analysis
        if isinstance(command, AnalysisProcessCommand):
            return self._ai.process(max_items=command.params.max_items)
        if isinstance(command, AnalysisFinalizeCommand):
            return {"result": self._ai.finalize(transcription_id=command.params.transcription_id)}
        if isinstance(command, AnalysisGetCommand):
            return {
                "analysis": self._ai.analysis_get(
                    workspace_id=command.params.workspace_id,
                    transcription_id=command.params.transcription_id,
                )
            }
        if isinstance(command, AiStatusCommand):
            workspace = command.params.workspace_id if command.params is not None else None
            return {"status": self._ai.status(workspace)}
        if isinstance(command, AiDiagnoseCommand):
            return {"diagnostics": self._ai.diagnose()}
        if isinstance(command, AiPullModelCommand):
            return self._ai.pull_model(model=command.params.model)
        return None

    def _run_analysis(self, command: Command) -> dict[str, Any] | None:
        if isinstance(command, AnalysisSubmitCommand | AnalysisAppendCommand):
            params = command.params
            segments = [
                SegmentInput(index=item.index, start=item.start, end=item.end, text=item.text)
                for item in params.segments
            ]
            action = (
                self._ai.submit if isinstance(command, AnalysisSubmitCommand) else self._ai.append
            )
            return action(
                transcription_id=params.transcription_id,
                workspace_id=params.workspace_id,
                title=params.title,
                segments=segments,
            )
        if isinstance(command, AnalysisRetryCommand):
            return self._ai.retry(transcription_id=command.params.transcription_id)
        return None

    def _run_knowledge(self, command: Command) -> dict[str, Any] | None:
        if isinstance(command, KnowledgeSearchCommand):
            return {
                "results": self._ai.search(
                    workspace_id=command.params.workspace_id,
                    query=command.params.query,
                    limit=command.params.limit,
                )
            }
        if isinstance(command, KnowledgeSearchEntitiesCommand):
            return {
                "entities": self._ai.search_entities(
                    workspace_id=command.params.workspace_id,
                    kind=EntityKind(command.params.kind),
                    query=command.params.query,
                    limit=command.params.limit,
                )
            }
        if isinstance(command, KnowledgeAskCommand):
            return self._ai.ask(
                workspace_id=command.params.workspace_id,
                question=command.params.question,
                limit=command.params.limit,
            )
        if isinstance(command, KnowledgeReindexCommand):
            return {"enqueued": self._ai.reindex(workspace_id=command.params.workspace_id)}
        if isinstance(command, KnowledgeReindexCancelCommand):
            return self._ai.cancel_reindex(workspace_id=command.params.workspace_id)
        if isinstance(command, KnowledgeDeleteCommand):
            self._ai.delete(
                workspace_id=command.params.workspace_id,
                transcription_id=command.params.transcription_id,
            )
            return {"deleted": command.params.transcription_id}
        if isinstance(command, KnowledgeBackupCommand):
            return self._ai.backup(
                workspace_id=command.params.workspace_id, path=command.params.path
            )
        if isinstance(command, KnowledgeRestoreCommand):
            return self._ai.restore(
                path=command.params.path, workspace_id=command.params.workspace_id
            )
        return None

    def _require_no_live(self) -> None:
        if self._live is not None:
            raise WorkerError(ErrorCode.LIVE_ACTIVE, "Há uma sessão ao vivo em andamento")

    def _session(self) -> LiveSession:
        if self._live is None:
            raise WorkerError(ErrorCode.LIVE_NOT_STARTED, "Nenhuma sessão ao vivo")
        return self._live

    def _run_live(
        self,
        command: LiveAudioCommand | LiveStartCommand | LiveStopCommand | LivePauseCommand,
    ) -> dict[str, Any]:
        if isinstance(command, LiveAudioCommand):
            params = command.params
            self._session().audio(params.track, params.seq, params.samples())
            return {}
        if isinstance(command, LiveStartCommand):
            self._require_no_live()
            _ = self._engine.model  # sem modelo carregado, nem começa
            self._live = LiveSession(
                command.params, self._engine, self._emit, vad_factory=default_vad_factory
            )
            return {"started": True}
        if isinstance(command, LivePauseCommand):
            self._session().pause()
            return {"paused": True}
        segments = self._session().stop()
        self._live = None
        return {"segments": segments}

    def _load_model(self, params: LoadModelParams) -> dict[str, Any]:
        self._emit(phase_event("loading_model"))
        loaded = self._engine.load(params)
        if self._live is not None:  # queda da GPU no ao vivo: o trecho que falhou é refeito
            self._live.model_changed()
        return {"loaded": loaded}

    def _run_transcribe(self, params: TranscribeParams) -> dict[str, Any]:
        _ = self._engine.model  # falha antes de extrair o áudio se não há modelo
        audio = Path(params.audio_out_path)
        if not audio.is_file():  # refeito depois de cancelar: o áudio já extraído é reaproveitado
            self._extract_with_progress(params)
        self._emit(phase_event("transcribing", params.job_id))
        # O áudio extraído (pequeno, só a faixa de áudio) decodifica mais rápido que o vídeo.
        result = self._engine.transcribe(
            params.audio_out_path, params.language, params.job_id, self._emit
        )
        self._emit(done_event(params.job_id, result.duration, result.language_detected))
        return {"segments": result.segment_count}

    def _extract_with_progress(self, params: TranscribeParams) -> None:
        self._emit(phase_event("extracting_audio", params.job_id))
        started = time.monotonic()

        def on_progress(processed: float, total: float) -> None:
            elapsed = time.monotonic() - started
            self._emit(progress_event(params.job_id, processed, total, elapsed))

        self._extract(params.input_path, params.audio_out_path, on_progress)

    def _self_test(self) -> dict[str, Any]:
        result = self._engine.transcribe(
            str(self._self_test_audio),
            "en",
            "self-test",
            _discard,
            vad_filter=False,
        )
        return {"ok": True, "duration": result.duration}
