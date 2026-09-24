import io
import json
import os
import sys
from pathlib import Path

import pytest
from pytest_mock import MockerFixture

from transcriber_worker import __main__ as entry


def test_main_routes_cli(mocker: MockerFixture) -> None:
    run = mocker.patch("transcriber_worker.cli.run", return_value=3)
    assert entry.main(["cli", "video.mp4"]) == 3
    run.assert_called_once_with(["video.mp4"])


def test_main_defaults_to_worker(mocker: MockerFixture) -> None:
    run_worker = mocker.patch.object(entry, "run_worker", return_value=0)
    assert entry.main([]) == 0
    run_worker.assert_called_once_with(sys.stdin, sys.stdout)


def test_main_reads_sys_argv_when_argv_is_none(
    mocker: MockerFixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    run = mocker.patch("transcriber_worker.cli.run", return_value=0)
    monkeypatch.setattr(sys, "argv", ["transcriber-worker", "cli", "a.mp3"])
    entry.main()
    run.assert_called_once_with(["a.mp3"])


def test_force_utf8_reconfigures_text_wrapper(tmp_path: Path) -> None:
    path = tmp_path / "stdin.txt"
    path.write_text('{"input_path":"C:\\\\Usuários\\\\vídeo.mp4"}\n', encoding="utf-8")
    with open(path, encoding="cp1252") as stream:  # simula o stdin padrão do Windows
        entry._force_utf8(stream)
        assert "Usuários" in stream.readline()


def test_force_utf8_ignores_non_wrapper_streams() -> None:
    stream = io.StringIO("x")
    entry._force_utf8(stream)
    assert stream.read() == "x"


def test_protocol_stream_isolates_native_writes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    out_path, err_path = tmp_path / "out", tmp_path / "err"
    with open(out_path, "w") as fake_stdout, open(err_path, "w") as fake_stderr:
        monkeypatch.setattr(sys, "stderr", fake_stderr)
        protocol = entry._protocol_stream(fake_stdout)
        os.write(fake_stdout.fileno(), b"print nativo\n")  # como um printf do ctranslate2
        protocol.write('{"type":"x"}\n')
        protocol.close()
    assert out_path.read_text() == '{"type":"x"}\n'
    assert "print nativo" in err_path.read_text()


def _run(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, stdin_text: str) -> tuple[int, str, str]:
    out_path, err_path = tmp_path / "out.jsonl", tmp_path / "err.log"
    with open(out_path, "w", encoding="utf-8") as out, open(err_path, "w", encoding="utf-8") as err:
        monkeypatch.setattr(sys, "stderr", err)
        code = entry.run_worker(io.StringIO(stdin_text), out)
    return code, out_path.read_text(encoding="utf-8"), err_path.read_text(encoding="utf-8")


def test_run_worker_end_to_end(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    code, out, _ = _run(tmp_path, monkeypatch, '{"id":"1","cmd":"shutdown"}\n')
    types = [json.loads(line)["type"] for line in out.splitlines()]
    assert code == 0
    assert [t for t in types if t != "heartbeat"] == ["ready", "result"]


def test_run_worker_sends_python_prints_to_stderr(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def noisy_serve(*_args: object, **_kwargs: object) -> int:
        print("progresso do tqdm")
        return 0

    original_stdout = sys.stdout
    monkeypatch.setattr(entry, "serve", noisy_serve)
    _, out, err = _run(tmp_path, monkeypatch, "")
    assert "tqdm" not in out
    assert "tqdm" in err
    assert sys.stdout is original_stdout


def test_run_worker_survives_invalid_utf8(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    raw = io.BytesIO(b'\xff\xfe lixo\n{"id":"1","cmd":"shutdown"}\n')
    stdin = io.TextIOWrapper(raw, encoding="cp1252")
    out_path, err_path = tmp_path / "out.jsonl", tmp_path / "err.log"
    with open(out_path, "w", encoding="utf-8") as out, open(err_path, "w", encoding="utf-8") as err:
        monkeypatch.setattr(sys, "stderr", err)
        assert entry.run_worker(stdin, out) == 0
    events = [json.loads(line) for line in out_path.read_text("utf-8").splitlines()]
    kinds = [(e["type"], e.get("code"), e.get("id")) for e in events if e["type"] != "heartbeat"]
    assert kinds == [
        ("ready", None, None),
        ("error", "INVALID_MESSAGE", None),
        ("result", None, "1"),
    ]
