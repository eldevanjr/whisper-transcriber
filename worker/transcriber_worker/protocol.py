"""Comandos recebidos pelo stdin (validados) e escrita thread-safe de eventos no stdout."""

import base64
import binascii
import json
import threading
from typing import Annotated, Literal, TextIO

import numpy as np
from numpy.typing import NDArray
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    TypeAdapter,
    ValidationError,
    field_validator,
    model_validator,
)

from transcriber_worker.errors import ErrorCode, WorkerError
from transcriber_worker.events import Event

Device = Literal["cpu", "cuda", "gpu"]
EngineName = Literal["faster-whisper", "whisper-cpp"]
ComputeType = Literal["int8", "float16"]
Track = Literal["voce", "outros"]
MAX_LINE_LENGTH = 64 * 1024


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class LoadModelParams(_Strict):
    model_dir: str = Field(min_length=1)
    device: Device
    engine: EngineName = "faster-whisper"
    compute_type: ComputeType | None = None
    cuda_lib_dir: str | None = None

    @model_validator(mode="after")
    def _check_engine(self) -> "LoadModelParams":
        # cuda = faster-whisper (CTranslate2); gpu = whisper.cpp (Vulkan/Metal).
        if self.engine == "faster-whisper":
            if self.device == "gpu" or self.compute_type is None:
                raise ValueError("faster-whisper exige compute_type e não usa device=gpu")
        elif self.device == "cuda" or self.cuda_lib_dir is not None:
            raise ValueError("whisper-cpp usa device cpu ou gpu, sem bibliotecas CUDA")
        return self


class TranscribeParams(_Strict):
    job_id: str = Field(min_length=1)
    input_path: str = Field(min_length=1)
    language: str | None = Field(default=None, pattern=r"^[a-z]{2,3}$")
    audio_out_path: str = Field(min_length=1)


class LiveStartParams(_Strict):
    session_id: str = Field(min_length=1)
    tracks: list[Track] = Field(min_length=1, max_length=2)
    language: str | None = Field(default=None, pattern=r"^[a-z]{2,3}$")
    pause_s: float = Field(ge=0.5, le=3.0)
    test: bool = False

    @field_validator("tracks")
    @classmethod
    def _unique(cls, tracks: list[Track]) -> list[Track]:
        if len(set(tracks)) != len(tracks):
            raise ValueError("faixas repetidas")
        return tracks


class LiveAudioParams(_Strict):
    session_id: str = Field(min_length=1)
    track: Track
    seq: int = Field(ge=0)
    pcm16_b64: str

    @field_validator("pcm16_b64")
    @classmethod
    def _pcm(cls, value: str) -> str:
        try:
            raw = base64.b64decode(value, validate=True)
        except (binascii.Error, ValueError) as exc:  # formato inválido ou fora do ASCII
            raise ValueError("pcm16_b64 inválido") from exc
        if len(raw) % 2:
            raise ValueError("pcm16 com número ímpar de bytes")
        return value

    def samples(self) -> NDArray[np.int16]:
        return np.frombuffer(base64.b64decode(self.pcm16_b64), dtype="<i2").astype(np.int16)


class LiveStopParams(_Strict):
    session_id: str = Field(min_length=1)


class LiveFinalizeParams(_Strict):
    dir: str = Field(min_length=1)
    tracks: list[Track] = Field(min_length=1, max_length=2)


class LoadModelCommand(_Strict):
    id: str = Field(min_length=1)
    cmd: Literal["load_model"]
    params: LoadModelParams


class TranscribeCommand(_Strict):
    id: str = Field(min_length=1)
    cmd: Literal["transcribe"]
    params: TranscribeParams


class SelfTestCommand(_Strict):
    id: str = Field(min_length=1)
    cmd: Literal["self_test"]


class ShutdownCommand(_Strict):
    id: str = Field(min_length=1)
    cmd: Literal["shutdown"]


class LiveStartCommand(_Strict):
    id: str = Field(min_length=1)
    cmd: Literal["live_start"]
    params: LiveStartParams


class LiveAudioCommand(_Strict):
    id: str = Field(min_length=1)
    cmd: Literal["live_audio"]
    params: LiveAudioParams


class LiveStopCommand(_Strict):
    id: str = Field(min_length=1)
    cmd: Literal["live_stop"]
    params: LiveStopParams


class LiveFinalizeCommand(_Strict):
    id: str = Field(min_length=1)
    cmd: Literal["live_finalize"]
    params: LiveFinalizeParams


Command = Annotated[
    LoadModelCommand
    | TranscribeCommand
    | SelfTestCommand
    | ShutdownCommand
    | LiveStartCommand
    | LiveAudioCommand
    | LiveStopCommand
    | LiveFinalizeCommand,
    Field(discriminator="cmd"),
]
_COMMAND_ADAPTER: TypeAdapter[Command] = TypeAdapter(Command)


def parse_command(line: str) -> Command:
    if len(line) > MAX_LINE_LENGTH:
        raise WorkerError(ErrorCode.INVALID_MESSAGE, "Mensagem excede o tamanho máximo")
    try:
        return _COMMAND_ADAPTER.validate_json(line)
    except ValidationError as exc:
        raise WorkerError(ErrorCode.INVALID_MESSAGE, "Mensagem inválida", detail=str(exc)) from exc


def peek_command_id(line: str) -> str | None:
    """Tenta extrair o id de uma linha inválida, para o app correlacionar o erro."""
    try:
        data = json.loads(line)
    except (ValueError, RecursionError):
        return None
    value = data.get("id") if isinstance(data, dict) else None
    return value if isinstance(value, str) else None


class EventWriter:
    def __init__(self, stream: TextIO) -> None:
        self._stream = stream
        self._lock = threading.Lock()

    def emit(self, event: Event) -> None:
        line = json.dumps(event, ensure_ascii=True, separators=(",", ":"))
        with self._lock:
            self._stream.write(line + "\n")
            self._stream.flush()
