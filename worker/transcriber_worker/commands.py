"""Executa cada comando recebido e responde com result/error (sempre com o id do comando)."""

import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

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
    Command,
    LiveAudioCommand,
    LiveFinalizeCommand,
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
    ) -> None:
        self._engine = engine
        self._emit = emit
        self._extract = extract
        self._self_test_audio = self_test_audio
        self._live: LiveSession | None = None

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
        return command.cmd != "shutdown"

    def _run(self, command: Command) -> dict[str, Any]:
        if isinstance(command, LiveAudioCommand | LiveStartCommand | LiveStopCommand):
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
        return {}

    def _require_no_live(self) -> None:
        if self._live is not None:
            raise WorkerError(ErrorCode.LIVE_ACTIVE, "Há uma sessão ao vivo em andamento")

    def _session(self) -> LiveSession:
        if self._live is None:
            raise WorkerError(ErrorCode.LIVE_NOT_STARTED, "Nenhuma sessão ao vivo")
        return self._live

    def _run_live(
        self, command: LiveAudioCommand | LiveStartCommand | LiveStopCommand
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
