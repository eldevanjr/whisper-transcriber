import io
import json
import threading

import pytest

from transcriber_worker.errors import ErrorCode, WorkerError
from transcriber_worker.protocol import (
    MAX_LINE_LENGTH,
    EventWriter,
    LiveAudioCommand,
    LiveFinalizeCommand,
    LivePauseCommand,
    LiveStartCommand,
    LiveStopCommand,
    LoadModelCommand,
    SelfTestCommand,
    ShutdownCommand,
    TranscribeCommand,
    parse_command,
    peek_command_id,
)


def _line(payload: object) -> str:
    return json.dumps(payload, ensure_ascii=False)


def test_parse_load_model() -> None:
    command = parse_command(
        _line(
            {
                "id": "1",
                "cmd": "load_model",
                "params": {
                    "model_dir": "/m/medium",
                    "device": "cuda",
                    "compute_type": "float16",
                    "cuda_lib_dir": "/c",
                },
            }
        )
    )
    assert isinstance(command, LoadModelCommand)
    assert command.params.device == "cuda"
    assert command.params.cuda_lib_dir == "/c"


def test_parse_transcribe_keeps_accented_paths() -> None:
    path = "C:\\Usuários\\joão\\Área de Trabalho\\vídeo final.mp4"
    command = parse_command(
        _line(
            {
                "id": "2",
                "cmd": "transcribe",
                "params": {"job_id": "j1", "input_path": path, "audio_out_path": "/h/j1/audio.m4a"},
            }
        )
    )
    assert isinstance(command, TranscribeCommand)
    assert command.params.input_path == path
    assert command.params.language is None


def test_parse_transcribe_accepts_language_code() -> None:
    command = parse_command(
        _line(
            {
                "id": "2",
                "cmd": "transcribe",
                "params": {
                    "job_id": "j",
                    "input_path": "a",
                    "audio_out_path": "b",
                    "language": "pt",
                },
            }
        )
    )
    assert isinstance(command, TranscribeCommand)
    assert command.params.language == "pt"


def test_parse_self_test_and_shutdown() -> None:
    assert isinstance(parse_command('{"id":"3","cmd":"self_test"}'), SelfTestCommand)
    assert isinstance(parse_command('{"id":"4","cmd":"shutdown"}'), ShutdownCommand)


@pytest.mark.parametrize(
    "line",
    [
        "isto não é json",
        '{"id":"1","cmd":"rm_rf"}',
        '{"id":"1","cmd":"shutdown","extra":true}',
        '{"cmd":"shutdown"}',
        '{"id":"","cmd":"shutdown"}',
        '{"id":"1","cmd":"load_model","params":{"model_dir":"m","device":"tpu","compute_type":"int8"}}',
        '{"id":"1","cmd":"transcribe","params":{"job_id":"j","input_path":"a",'
        '"audio_out_path":"b","language":"portuguese"}}',
        "[]",
    ],
)
def test_parse_rejects_invalid_messages(line: str) -> None:
    with pytest.raises(WorkerError) as info:
        parse_command(line)
    assert info.value.code is ErrorCode.INVALID_MESSAGE


def test_parse_rejects_oversized_line() -> None:
    with pytest.raises(WorkerError) as info:
        parse_command('{"id":"1","cmd":"shutdown"}' + " " * MAX_LINE_LENGTH)
    assert info.value.code is ErrorCode.INVALID_MESSAGE


@pytest.mark.parametrize(
    ("line", "expected"),
    [
        ('{"id":"9","cmd":"nope"}', "9"),
        ("não é json", None),
        ('["id"]', None),
        ('{"id": 9}', None),
    ],
)
def test_peek_command_id(line: str, expected: str | None) -> None:
    assert peek_command_id(line) == expected


def test_event_writer_writes_compact_ascii_line_and_flushes() -> None:
    class Spy(io.StringIO):
        flushed = 0

        def flush(self) -> None:
            self.flushed += 1
            super().flush()

    stream = Spy()
    EventWriter(stream).emit({"type": "segment", "text": "ação"})
    assert stream.getvalue() == '{"type":"segment","text":"a\\u00e7\\u00e3o"}\n'
    assert stream.flushed == 1


def test_event_writer_is_thread_safe() -> None:
    stream = io.StringIO()
    writer = EventWriter(stream)

    def worker(n: int) -> None:
        for i in range(200):
            writer.emit({"type": "x", "n": n, "i": i, "pad": "y" * 50})

    threads = [threading.Thread(target=worker, args=(n,)) for n in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    lines = stream.getvalue().splitlines()
    assert len(lines) == 1600
    assert all(json.loads(line)["type"] == "x" for line in lines)


def test_peek_command_id_survives_deeply_nested_json() -> None:
    assert peek_command_id("[" * 60000) is None


def test_protocol_version_is_3() -> None:
    from transcriber_worker import PROTOCOL_VERSION

    assert PROTOCOL_VERSION == 3


def test_load_model_defaults_to_faster_whisper() -> None:
    command = parse_command(
        '{"id":"1","cmd":"load_model","params":{"model_dir":"/m","device":"cpu","compute_type":"int8"}}'
    )
    assert isinstance(command, LoadModelCommand)
    assert command.params.engine == "faster-whisper"


@pytest.mark.parametrize("device", ["cpu", "gpu"])
def test_load_model_whisper_cpp_without_compute_type(device: str) -> None:
    line = (
        '{"id":"1","cmd":"load_model","params":{"model_dir":"/m/ggml",'
        f'"device":"{device}","engine":"whisper-cpp"}}}}'
    )
    command = parse_command(line)
    assert isinstance(command, LoadModelCommand)
    assert command.params.engine == "whisper-cpp"
    assert command.params.device == device


@pytest.mark.parametrize(
    "params",
    [
        '{"model_dir":"/m","device":"gpu","compute_type":"int8"}',  # gpu é só do whisper.cpp
        '{"model_dir":"/m","device":"cpu"}',  # faster-whisper exige compute_type
        '{"model_dir":"/m","device":"cuda","engine":"whisper-cpp"}',  # cuda é só do faster-whisper
        '{"model_dir":"/m","device":"cpu","engine":"whisper-cpp","cuda_lib_dir":"/c"}',
        '{"model_dir":"/m","device":"cpu","engine":"outro","compute_type":"int8"}',
    ],
)
def test_load_model_rejects_invalid_engine_combinations(params: str) -> None:
    with pytest.raises(WorkerError) as info:
        parse_command(f'{{"id":"1","cmd":"load_model","params":{params}}}')
    assert info.value.code is ErrorCode.INVALID_MESSAGE


def _live(cmd: str, **params: object) -> str:
    return _line({"id": "9", "cmd": cmd, "params": params})


def test_parse_live_commands() -> None:
    start = parse_command(
        _live("live_start", session_id="s1", tracks=["voce", "outros"], language=None, pause_s=1.0)
    )
    assert isinstance(start, LiveStartCommand)
    assert start.params.test is False
    audio = parse_command(
        _live("live_audio", session_id="s1", track="voce", seq=0, pcm16_b64="AAABAA==")
    )
    assert isinstance(audio, LiveAudioCommand)
    assert audio.params.samples().tolist() == [0, 1]
    assert isinstance(parse_command(_live("live_stop", session_id="s1")), LiveStopCommand)
    assert isinstance(parse_command(_live("live_pause", session_id="s1")), LivePauseCommand)
    fin = parse_command(_live("live_finalize", dir="/h/s1", tracks=["voce"]))
    assert isinstance(fin, LiveFinalizeCommand)


@pytest.mark.parametrize(
    "params",
    [
        {"session_id": "s", "tracks": ["voce"], "language": None, "pause_s": 0.4},
        {"session_id": "s", "tracks": ["voce"], "language": None, "pause_s": 3.1},
        {"session_id": "s", "tracks": [], "language": None, "pause_s": 1.0},
        {"session_id": "s", "tracks": ["voce", "voce"], "language": None, "pause_s": 1.0},
        {"session_id": "s", "tracks": ["alguem"], "language": None, "pause_s": 1.0},
    ],
)
def test_live_start_rejects_invalid_params(params: dict[str, object]) -> None:
    with pytest.raises(WorkerError) as info:
        parse_command(_live("live_start", **params))
    assert info.value.code is ErrorCode.INVALID_MESSAGE


@pytest.mark.parametrize(
    "pcm", ["não é base64!", "@@@@", "AA=="]
)  # inválido; número ímpar de bytes
def test_live_audio_rejects_invalid_pcm(pcm: str) -> None:
    with pytest.raises(WorkerError) as info:
        parse_command(_live("live_audio", session_id="s", track="voce", seq=0, pcm16_b64=pcm))
    assert info.value.code is ErrorCode.INVALID_MESSAGE
