from collections.abc import Iterable
from types import SimpleNamespace
from typing import Any


def seg(start: float, end: float, text: str) -> SimpleNamespace:
    return SimpleNamespace(start=start, end=end, text=text)


class FakeModel:
    def __init__(
        self, segments: Iterable[Any], duration: float = 10.0, language: str | None = "pt"
    ) -> None:
        self.segments = segments
        self.duration = duration
        self.language = language
        self.calls: list[tuple[Any, dict[str, Any]]] = []

    def transcribe(self, audio: Any, **kwargs: Any) -> tuple[Iterable[Any], Any]:
        self.calls.append((audio, kwargs))
        info = SimpleNamespace(duration=self.duration, language=self.language)
        return iter(self.segments), info


class FakeCppModel:
    """Dublê do adaptador do whisper.cpp: entrega trechos (início, fim, texto) pelo callback."""

    def __init__(
        self, segments: Iterable[tuple[float, float, str]], detected: str | None = "pt"
    ) -> None:
        self.segments = list(segments)
        self.detected = detected
        self.calls: list[tuple[int, str | None]] = []

    def transcribe(self, audio: Any, language: str | None, on_segment: Any) -> str | None:
        self.calls.append((len(audio), language))
        for start, end, text in self.segments:
            on_segment(start, end, text)
        return self.detected
