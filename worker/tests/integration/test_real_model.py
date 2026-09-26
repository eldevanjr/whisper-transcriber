"""Motor real de ponta a ponta com o modelo tiny (~75 MB, em cache após a 1ª execução)."""

import shutil
from pathlib import Path

import pytest

from tests.media import make_wav
from transcriber_worker.commands import Dispatcher
from transcriber_worker.engine import Engine
from transcriber_worker.events import Event
from transcriber_worker.protocol import (
    LoadModelCommand,
    LoadModelParams,
    SelfTestCommand,
    TranscribeCommand,
    TranscribeParams,
)

FALA = Path(__file__).parents[1] / "fixtures" / "fala-curta.wav"

pytestmark = [pytest.mark.integration, pytest.mark.timeout(600)]


@pytest.fixture(scope="module")
def tiny_model_dir() -> str:
    from huggingface_hub import snapshot_download

    return str(snapshot_download("Systran/faster-whisper-tiny"))


@pytest.fixture
def loaded(tiny_model_dir: str) -> tuple[Dispatcher, list[Event]]:
    events: list[Event] = []
    dispatcher = Dispatcher(Engine(), events.append)
    params = LoadModelParams(model_dir=tiny_model_dir, device="cpu", compute_type="int8")
    dispatcher.handle(LoadModelCommand(id="load", cmd="load_model", params=params))
    assert events[-1] == {"type": "result", "id": "load", "data": {"loaded": True}}
    return dispatcher, events


def test_self_test_passes(loaded: tuple[Dispatcher, list[Event]]) -> None:
    dispatcher, events = loaded
    dispatcher.handle(SelfTestCommand(id="st", cmd="self_test"))
    assert events[-1]["type"] == "result"
    assert events[-1]["data"]["ok"] is True


def test_transcribe_real_file(loaded: tuple[Dispatcher, list[Event]], tmp_path: Path) -> None:
    dispatcher, events = loaded
    source = make_wav(tmp_path / "três segundos.wav", seconds=3.0)
    audio_out = tmp_path / "history" / "job" / "audio.m4a"
    params = TranscribeParams(
        job_id="job", input_path=str(source), language="pt", audio_out_path=str(audio_out)
    )
    dispatcher.handle(TranscribeCommand(id="t", cmd="transcribe", params=params))
    kinds = [e["type"] for e in events]
    assert "done" in kinds
    assert events[-1]["type"] == "result"
    assert [e for e in events if e["type"] == "progress"][-1]["pct"] == 100.0
    assert audio_out.is_file()


def test_loads_model_from_accented_user_folder(tiny_model_dir: str, tmp_path: Path) -> None:
    # A pasta de dados do app fica em C:\Users\João\... para muitos usuários brasileiros.
    model_dir = tmp_path / "Usuários" / "João" / "Área de Trabalho" / "modelos" / "tiny"
    shutil.copytree(tiny_model_dir, model_dir)
    events: list[Event] = []
    dispatcher = Dispatcher(Engine(), events.append)
    params = LoadModelParams(model_dir=str(model_dir), device="cpu", compute_type="int8")
    dispatcher.handle(LoadModelCommand(id="load", cmd="load_model", params=params))
    dispatcher.handle(SelfTestCommand(id="st", cmd="self_test"))
    assert [e["type"] for e in events if e["type"] in ("result", "error")] == ["result", "result"]


@pytest.fixture(scope="module")
def tiny_ggml_dir(tmp_path_factory: pytest.TempPathFactory) -> str:
    from huggingface_hub import hf_hub_download

    cached = Path(hf_hub_download("ggerganov/whisper.cpp", "ggml-tiny.bin"))
    # Pasta com acento, como a de dados do app em C:\Users\João\...
    folder = tmp_path_factory.mktemp("modelos") / "João" / "tiny"
    folder.mkdir(parents=True)
    shutil.copy(cached, folder / "ggml-tiny.bin")
    return str(folder)


def test_whisper_cpp_self_test_and_transcription(tiny_ggml_dir: str, tmp_path: Path) -> None:
    events: list[Event] = []
    dispatcher = Dispatcher(Engine(), events.append)
    params = LoadModelParams(model_dir=tiny_ggml_dir, device="cpu", engine="whisper-cpp")
    dispatcher.handle(LoadModelCommand(id="load", cmd="load_model", params=params))
    dispatcher.handle(SelfTestCommand(id="st", cmd="self_test"))
    assert [e["type"] for e in events if e["type"] in ("result", "error")] == ["result", "result"]
    # Fala de verdade: o VAD deixa passar e o modelo detecta o idioma.
    transcribe = TranscribeParams(
        job_id="cpp",
        input_path=str(FALA),
        language=None,
        audio_out_path=str(tmp_path / "h" / "audio.m4a"),
    )
    dispatcher.handle(TranscribeCommand(id="t", cmd="transcribe", params=transcribe))
    done = next(e for e in events if e["type"] == "done")
    assert done["duration"] == pytest.approx(7.0, abs=0.05)
    assert isinstance(done["language_detected"], str)
    assert [e for e in events if e["type"] == "segment"]
    assert [e for e in events if e["type"] == "progress"][-1]["pct"] == 100.0


def test_whisper_cpp_skips_audio_without_speech(tiny_ggml_dir: str, tmp_path: Path) -> None:
    # Tom sem fala (como a faixa muda de "Você" numa reunião): nada de texto inventado.
    events: list[Event] = []
    dispatcher = Dispatcher(Engine(), events.append)
    params = LoadModelParams(model_dir=tiny_ggml_dir, device="cpu", engine="whisper-cpp")
    dispatcher.handle(LoadModelCommand(id="load", cmd="load_model", params=params))
    source = make_wav(tmp_path / "três segundos.wav", seconds=3.0)
    transcribe = TranscribeParams(
        job_id="cpp",
        input_path=str(source),
        language=None,
        audio_out_path=str(tmp_path / "h" / "audio.m4a"),
    )
    dispatcher.handle(TranscribeCommand(id="t", cmd="transcribe", params=transcribe))
    done = next(e for e in events if e["type"] == "done")
    assert done["duration"] == pytest.approx(3.0, abs=0.05)
    assert done["language_detected"] is None
    assert [e for e in events if e["type"] == "segment"] == []
    assert [e for e in events if e["type"] == "progress"][-1]["pct"] == 100.0
