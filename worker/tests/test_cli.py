import io
import json
from pathlib import Path
from typing import Any

import pytest

from transcriber_worker.cli import SegmentCollector, format_time, run, write_outputs
from transcriber_worker.engine import Engine, named_model_factory
from transcriber_worker.errors import ErrorCode, WorkerError
from transcriber_worker.events import Emit
from transcriber_worker.transcription import TranscriptionResult


class Recorder:
    def __init__(self, error: BaseException | None = None) -> None:
        self.calls: list[tuple[str, str | None, str]] = []
        self.error = error

    def __call__(
        self,
        model: Any,
        input_path: str,
        language: str | None,
        job_id: str,
        emit: Emit,
        *,
        vad_filter: bool = True,
    ) -> TranscriptionResult:
        self.calls.append((input_path, language, job_id))
        if self.error is not None:
            raise self.error
        emit({"type": "segment", "start": 0.0, "end": 7.24, "text": "Bom dia"})
        emit({"type": "progress", "pct": 50.0, "processed_s": 7.24, "total_s": 14.5})
        emit({"type": "segment", "start": 7.24, "end": 3661.0, "text": "pessoal"})
        emit({"type": "phase", "phase": "transcribing"})
        return TranscriptionResult(3661.0, "pt", 2)


def _engine(loaded: list[tuple[str, ...]], transcribe: Recorder | None = None) -> Engine:
    def factory(model_dir: str, device: str, compute_type: str) -> Any:
        loaded.append((model_dir, device, compute_type))
        return object()

    def cpp_factory(model_dir: str, device: str) -> Any:
        loaded.append((model_dir, device))
        return object()

    recorder = transcribe or Recorder()
    return Engine(
        factory=factory,
        cpp_factory=cpp_factory,
        prepare=lambda _: None,
        transcribe=recorder,
        transcribe_cpp=recorder,
    )


@pytest.mark.parametrize(
    ("seconds", "expected"), [(0, "00:00"), (59.9, "00:59"), (61, "01:01"), (3661, "01:01:01")]
)
def test_format_time(seconds: float, expected: str) -> None:
    assert format_time(seconds) == expected


def test_run_missing_file_returns_1(tmp_path: Path) -> None:
    out = io.StringIO()
    assert run([str(tmp_path / "nada.mp4")], out=out) == 1
    assert "Arquivo não encontrado" in out.getvalue()


def test_run_writes_json_and_txt_like_old_main(tmp_path: Path) -> None:
    source = tmp_path / "aula 03.mp4"
    source.write_bytes(b"x")
    loaded: list[tuple[str, ...]] = []
    recorder, out = Recorder(), io.StringIO()
    code = run(
        [str(source), "--output-dir", str(tmp_path / "saida")],
        engine=_engine(loaded, recorder),
        out=out,
    )
    assert code == 0
    assert loaded == [("medium", "cpu", "int8")]
    assert recorder.calls == [(str(source), "pt", "aula 03")]
    data = json.loads((tmp_path / "saida" / "transcricao-aula 03.json").read_text("utf-8"))
    assert data == [
        {"inicio": 0.0, "fim": 7.24, "texto": "Bom dia"},
        {"inicio": 7.24, "fim": 3661.0, "texto": "pessoal"},
    ]
    txt = (tmp_path / "saida" / "transcricao-aula 03.txt").read_text("utf-8")
    assert txt == "[00:00 - 00:07] Bom dia\n[00:07 - 01:01:01] pessoal\n"
    assert " 50.00%  00:07 / 00:14" in out.getvalue()
    assert "Concluído!" in out.getvalue()


def test_run_language_auto_and_cuda(tmp_path: Path) -> None:
    source = tmp_path / "a.mp3"
    source.write_bytes(b"x")
    loaded: list[tuple[str, ...]] = []
    recorder = Recorder()
    run(
        [
            str(source),
            "--language",
            "auto",
            "--device",
            "cuda",
            "--model",
            "small",
            "--output-dir",
            str(tmp_path),
        ],
        engine=_engine(loaded, recorder),
        out=io.StringIO(),
    )
    assert loaded == [("small", "cuda", "float16")]
    assert recorder.calls[0][1] is None


def test_run_engine_error_returns_2(tmp_path: Path) -> None:
    source = tmp_path / "a.mp3"
    source.write_bytes(b"x")
    out = io.StringIO()
    code = run(
        [str(source), "--output-dir", str(tmp_path)],
        engine=_engine([], Recorder(WorkerError(ErrorCode.INVALID_MEDIA, "arquivo ilegível"))),
        out=out,
    )
    assert code == 2
    assert "arquivo ilegível" in out.getvalue()


def test_run_uses_named_factory_and_stdout(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    source = tmp_path / "a.mp3"
    source.write_bytes(b"x")
    factories: list[object] = []

    def engine_spy(factory: object) -> Engine:
        factories.append(factory)
        return _engine([])

    monkeypatch.setattr("transcriber_worker.cli.Engine", engine_spy)
    assert run([str(source), "--output-dir", str(tmp_path)]) == 0
    assert factories == [named_model_factory]
    assert "Concluído!" in capsys.readouterr().out


def test_collector_ignores_other_events() -> None:
    collector = SegmentCollector(io.StringIO())
    collector({"type": "heartbeat"})
    assert collector.segments == []


def test_write_outputs_creates_directory(tmp_path: Path) -> None:
    json_path, txt_path = write_outputs([], tmp_path / "novo", "x")
    assert json_path.read_text("utf-8") == "[]"
    assert txt_path.read_text("utf-8") == ""


def test_run_whisper_cpp_engine_on_gpu(tmp_path: Path) -> None:
    source = tmp_path / "a.mp3"
    source.write_bytes(b"x")
    loaded: list[tuple[str, ...]] = []
    code = run(
        [
            str(source),
            "--engine",
            "whisper-cpp",
            "--device",
            "gpu",
            "--model",
            "/m/ggml-small.bin",
            "--output-dir",
            str(tmp_path),
        ],
        engine=_engine(loaded),
        out=io.StringIO(),
    )
    assert code == 0
    assert loaded == [("/m/ggml-small.bin", "gpu")]


def test_run_rejects_gpu_with_faster_whisper(tmp_path: Path) -> None:
    source = tmp_path / "a.mp3"
    source.write_bytes(b"x")
    out = io.StringIO()
    assert run([str(source), "--device", "gpu"], engine=_engine([]), out=out) == 2
    assert "whisper-cpp" in out.getvalue()
