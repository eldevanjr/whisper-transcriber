"""Carrega e mantém o modelo faster-whisper em memória entre os jobs da fila."""

from collections.abc import Callable
from pathlib import Path

from transcriber_worker.errors import ErrorCode, WorkerError, classify_exception
from transcriber_worker.events import Emit
from transcriber_worker.protocol import Device, LoadModelParams
from transcriber_worker.runtime import prepare_cuda
from transcriber_worker.transcription import (
    TranscribeFn,
    TranscriptionResult,
    WhisperLike,
    run_transcription,
)
from transcriber_worker.whispercpp import (
    CppTranscribeFn,
    WhisperCppLike,
    local_cpp_factory,
    run_whispercpp,
)

ModelFactory = Callable[[str, str, str], WhisperLike]


def named_model_factory(model_dir: str, device: str, compute_type: str) -> WhisperLike:
    """Aceita nome ("medium") ou pasta; baixa pelo Hugging Face se preciso. Só para o modo CLI."""
    # Import tardio: o ctranslate2 só pode ser carregado depois do prepare_cuda.
    from faster_whisper import WhisperModel

    model: WhisperLike = WhisperModel(model_dir, device=device, compute_type=compute_type)
    return model


def local_model_factory(model_dir: str, device: str, compute_type: str) -> WhisperLike:
    """Modo worker: só carrega de uma pasta local já baixada pelo app; nunca acessa a rede."""
    if not Path(model_dir).is_dir():
        raise WorkerError(ErrorCode.MODEL_LOAD_FAILED, f"Modelo não encontrado: {model_dir}")
    from faster_whisper import WhisperModel

    model: WhisperLike = WhisperModel(
        model_dir, device=device, compute_type=compute_type, local_files_only=True
    )
    return model


CppFactory = Callable[[str, Device], WhisperCppLike]

_LOAD_FAILURES: dict[str, ErrorCode] = {"cuda": ErrorCode.CUDA_FAILED, "gpu": ErrorCode.GPU_FAILED}


class Engine:
    """Guarda o modelo carregado (faster-whisper ou whisper.cpp) e transcreve com ele."""

    def __init__(
        self,
        factory: ModelFactory = local_model_factory,
        prepare: Callable[[str | None], object] = prepare_cuda,
        *,
        cpp_factory: CppFactory = local_cpp_factory,
        transcribe: TranscribeFn = run_transcription,
        transcribe_cpp: CppTranscribeFn = run_whispercpp,
    ) -> None:
        self._factory = factory
        self._cpp_factory = cpp_factory
        self._prepare = prepare
        self._transcribe = transcribe
        self._transcribe_cpp = transcribe_cpp
        self._model: WhisperLike | None = None
        self._cpp: WhisperCppLike | None = None
        self._key: tuple[str, str, str, str | None] | None = None

    def load(self, params: LoadModelParams) -> bool:
        key = (params.engine, params.model_dir, params.device, params.compute_type)
        if key == self._key:
            return False
        self._model, self._cpp, self._key = None, None, None
        if params.device == "cuda":
            self._prepare(params.cuda_lib_dir)
        try:
            self._create(params)
        except Exception as exc:
            fallback = _LOAD_FAILURES.get(params.device, ErrorCode.MODEL_LOAD_FAILED)
            raise classify_exception(exc, fallback, gpu=params.device == "gpu") from exc
        self._key = key
        return True

    def _create(self, params: LoadModelParams) -> None:
        if params.engine == "whisper-cpp":
            self._cpp = self._cpp_factory(params.model_dir, params.device)
            return
        # O protocolo garante compute_type no faster-whisper.
        compute_type = params.compute_type or "int8"
        self._model = self._factory(params.model_dir, params.device, compute_type)

    def _on_gpu(self) -> bool:
        return self._key is not None and self._key[2] == "gpu"

    @property
    def model(self) -> WhisperLike | WhisperCppLike:
        loaded = self._model or self._cpp
        if loaded is None:
            raise WorkerError(ErrorCode.MODEL_NOT_LOADED, "Nenhum modelo carregado")
        return loaded

    def transcribe(
        self,
        input_path: str,
        language: str | None,
        job_id: str,
        emit: Emit,
        *,
        vad_filter: bool = True,
    ) -> TranscriptionResult:
        if self._cpp is not None:
            try:
                return self._transcribe_cpp(
                    self._cpp, input_path, language, job_id, emit, vad_filter=vad_filter
                )
            except Exception as exc:
                raise classify_exception(exc, gpu=self._on_gpu()) from exc
        if self._model is None:
            raise WorkerError(ErrorCode.MODEL_NOT_LOADED, "Nenhum modelo carregado")
        return self._transcribe(
            self._model, input_path, language, job_id, emit, vad_filter=vad_filter
        )
