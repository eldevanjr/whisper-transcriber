from __future__ import annotations

import urllib.error
import urllib.request
from collections.abc import Iterator
from typing import Any

import pytest
from ai_core import LLMRequest, ProviderLocation

from transcriber_worker.ai.ollama import (
    OllamaClient,
    OllamaEmbeddingProvider,
    OllamaError,
    OllamaLLMProvider,
    OllamaUnavailableError,
    is_loopback_url,
)


class _Recorder:
    def __init__(self, responses: dict[str, dict[str, Any]]) -> None:
        self.responses = responses
        self.calls: list[tuple[str, Any]] = []

    def __call__(self, path: str, payload: dict[str, Any] | None) -> dict[str, Any]:
        self.calls.append((path, payload))
        return self.responses[path]


class _FakeResponse:
    def __init__(self, payload: str) -> None:
        self._body = payload.encode("utf-8")

    def read(self) -> bytes:
        return self._body

    def __enter__(self) -> _FakeResponse:
        return self

    def __exit__(self, *args: object) -> None:
        return None


def _client(recorder: _Recorder, url: str = "http://localhost:11434") -> OllamaClient:
    return OllamaClient(url, post=recorder)


def test_http_transport_success(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        urllib.request, "urlopen", lambda request, timeout: _FakeResponse('{"models": []}')
    )
    client = OllamaClient("http://localhost:11434")
    assert client.list_models() == []
    assert client.base_url == "http://localhost:11434"


def test_http_transport_url_error(monkeypatch: pytest.MonkeyPatch) -> None:
    def boom(request: object, timeout: float) -> object:
        raise urllib.error.URLError("offline")

    monkeypatch.setattr(urllib.request, "urlopen", boom)
    with pytest.raises(OllamaError):
        OllamaClient("http://localhost:11434").list_models()


def test_http_transport_non_object_json(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(urllib.request, "urlopen", lambda request, timeout: _FakeResponse("[1]"))
    with pytest.raises(OllamaError):
        OllamaClient("http://localhost:11434").list_models()


class _FakeStreamResponse:
    def __init__(self, lines: list[str]) -> None:
        self._lines = lines

    def __iter__(self) -> Iterator[bytes]:
        return iter([line.encode("utf-8") for line in self._lines])

    def __enter__(self) -> _FakeStreamResponse:
        return self

    def __exit__(self, *args: object) -> None:
        return None


class _StreamRecorder:
    def __init__(self, chunks: list[dict[str, Any]]) -> None:
        self.chunks = chunks
        self.calls: list[tuple[str, Any]] = []

    def __call__(self, path: str, payload: dict[str, Any]) -> Iterator[dict[str, Any]]:
        self.calls.append((path, payload))
        return iter(self.chunks)


def _stream_client(recorder: _StreamRecorder) -> OllamaClient:
    return OllamaClient("http://localhost:11434", stream=recorder)


def test_pull_streams_until_success() -> None:
    recorder = _StreamRecorder([{"status": "pulling"}, {"status": "success"}])
    _stream_client(recorder).pull("qwen3:8b")
    path, payload = recorder.calls[0]
    assert path == "/api/pull"
    assert payload == {"model": "qwen3:8b", "stream": True}


def test_pull_reports_progress() -> None:
    recorder = _StreamRecorder(
        [{"status": "downloading", "completed": 1, "total": 2}, {"status": "success"}]
    )
    seen: list[dict[str, Any]] = []
    _stream_client(recorder).pull("m", on_progress=seen.append)
    assert [chunk["status"] for chunk in seen] == ["downloading", "success"]


def test_pull_raises_on_error_chunk() -> None:
    recorder = _StreamRecorder([{"error": "sem rede"}])
    with pytest.raises(OllamaError, match="sem rede"):
        _stream_client(recorder).pull("m")


def test_pull_without_success_chunk_raises() -> None:
    recorder = _StreamRecorder([{"status": "pulling"}])
    with pytest.raises(OllamaError):
        _stream_client(recorder).pull("m")


def test_http_stream_transport_skips_blank_and_non_dict_lines(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    response = _FakeStreamResponse(['{"status": "pulling"}', "", "[1]", '{"status": "success"}'])
    monkeypatch.setattr(urllib.request, "urlopen", lambda request, timeout: response)
    OllamaClient("http://localhost:11434").pull("m")


def test_http_stream_transport_exhausts_without_success(monkeypatch: pytest.MonkeyPatch) -> None:
    response = _FakeStreamResponse(['{"status": "pulling"}'])
    monkeypatch.setattr(urllib.request, "urlopen", lambda request, timeout: response)
    with pytest.raises(OllamaError):
        OllamaClient("http://localhost:11434").pull("m")


def test_http_stream_transport_bad_json(monkeypatch: pytest.MonkeyPatch) -> None:
    response = _FakeStreamResponse(["não é json"])
    monkeypatch.setattr(urllib.request, "urlopen", lambda request, timeout: response)
    with pytest.raises(OllamaError):
        OllamaClient("http://localhost:11434").pull("m")


def test_http_stream_transport_url_error(monkeypatch: pytest.MonkeyPatch) -> None:
    def boom(request: object, timeout: float) -> object:
        raise urllib.error.URLError("offline")

    monkeypatch.setattr(urllib.request, "urlopen", boom)
    with pytest.raises(OllamaError):
        OllamaClient("http://localhost:11434").pull("m")


def test_generate_builds_payload_with_system_and_limit() -> None:
    recorder = _Recorder({"/api/generate": {"response": "texto"}})
    text = _client(recorder).generate(
        model="qwen3:8b", prompt="oi", system="seja breve", temperature=0.3, max_tokens=64
    )
    assert text == "texto"
    path, payload = recorder.calls[0]
    assert path == "/api/generate"
    assert payload["model"] == "qwen3:8b"
    assert payload["system"] == "seja breve"
    assert payload["stream"] is True
    assert payload["options"] == {"temperature": 0.3, "num_predict": 64}


def test_generate_without_system_or_limit() -> None:
    recorder = _Recorder({"/api/generate": {"response": "ok"}})
    _client(recorder).generate(model="m", prompt="p")
    payload = recorder.calls[0][1]
    assert "system" not in payload
    assert payload["options"] == {"temperature": 0.0}


def test_generate_invalid_response() -> None:
    with pytest.raises(OllamaError):
        _client(_Recorder({"/api/generate": {}})).generate(model="m", prompt="p")


def test_embed_success() -> None:
    recorder = _Recorder({"/api/embeddings": {"embedding": [1, 2.5]}})
    assert _client(recorder).embed(model="m", text="x") == [1.0, 2.5]


@pytest.mark.parametrize("embedding", ["x", [1, "a"]])
def test_embed_invalid(embedding: object) -> None:
    recorder = _Recorder({"/api/embeddings": {"embedding": embedding}})
    with pytest.raises(OllamaError):
        _client(recorder).embed(model="m", text="x")


def test_list_models_filters_non_objects() -> None:
    recorder = _Recorder({"/api/tags": {"models": [{"name": "a"}, "junk"]}})
    assert _client(recorder).list_models() == ["a"]


def test_list_models_invalid() -> None:
    with pytest.raises(OllamaError):
        _client(_Recorder({"/api/tags": {"models": "x"}})).list_models()


def test_health() -> None:
    healthy = _client(_Recorder({"/api/tags": {"models": []}}))
    assert healthy.health() is True
    assert _client(_Recorder({"/api/tags": {"models": "x"}})).health() is False


def test_llm_provider_uses_context_and_override() -> None:
    recorder = _Recorder({"/api/generate": {"response": "resposta"}})
    provider = OllamaLLMProvider(_client(recorder), default_model="default")
    response = provider.generate(
        LLMRequest(user_prompt="pergunta", context=["ctx-1", "ctx-2"], model="big")
    )
    assert provider.name == "ollama"
    assert provider.default_model == "default"
    assert response.text == "resposta"
    assert response.model == "big"
    payload = recorder.calls[0][1]
    assert payload["model"] == "big"
    assert "Contexto:" in payload["prompt"]
    assert "ctx-1" in payload["prompt"]


def test_llm_provider_uses_default_model_without_context() -> None:
    recorder = _Recorder({"/api/generate": {"response": "x"}})
    provider = OllamaLLMProvider(_client(recorder), default_model="default")
    response = provider.generate(LLMRequest(user_prompt="p"))
    assert response.model == "default"
    assert recorder.calls[0][1]["prompt"] == "p"


def test_embedding_provider_dimension() -> None:
    recorder = _Recorder({"/api/embeddings": {"embedding": [0.1, 0.2, 0.3]}})
    provider = OllamaEmbeddingProvider(_client(recorder), default_model="nomic-embed-text")
    with pytest.raises(OllamaError):
        _ = provider.dimension
    embedding = provider.embed("texto")
    assert provider.dimension == 3
    assert embedding.dimension == 3
    assert embedding.model == "nomic-embed-text"


def test_embedding_provider_explicit_dimension() -> None:
    recorder = _Recorder({"/api/embeddings": {"embedding": [1.0]}})
    provider = OllamaEmbeddingProvider(_client(recorder), default_model="m", dimension=768)
    assert provider.dimension == 768


def test_http_list_models_uses_get(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: list[str] = []

    def fake_urlopen(request: urllib.request.Request, timeout: float) -> _FakeResponse:
        seen.append(request.get_method())
        assert request.data is None
        return _FakeResponse('{"models": []}')

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    OllamaClient("http://localhost:11434").list_models()
    assert seen == ["GET"]


def test_list_models_sends_no_payload() -> None:
    recorder = _Recorder({"/api/tags": {"models": []}})
    _client(recorder).list_models()
    assert recorder.calls == [("/api/tags", None)]


def test_llm_provider_forwards_json_format_and_context_size() -> None:
    recorder = _Recorder({"/api/generate": {"response": "{}"}})
    provider = OllamaLLMProvider(_client(recorder), default_model="m")
    provider.generate(LLMRequest(user_prompt="p", metadata={"format": "json", "num_ctx": 8192}))
    payload = recorder.calls[0][1]
    assert payload["format"] == "json"
    assert payload["options"]["num_ctx"] == 8192


def test_llm_provider_omits_format_by_default() -> None:
    recorder = _Recorder({"/api/generate": {"response": "x"}})
    OllamaLLMProvider(_client(recorder), default_model="m").generate(LLMRequest(user_prompt="p"))
    payload = recorder.calls[0][1]
    assert "format" not in payload
    assert "num_ctx" not in payload["options"]


def test_connection_refused_is_unavailable(monkeypatch: pytest.MonkeyPatch) -> None:
    def refused(request: object, timeout: float) -> object:
        raise urllib.error.URLError(ConnectionRefusedError(111, "recusada"))

    monkeypatch.setattr(urllib.request, "urlopen", refused)
    with pytest.raises(OllamaUnavailableError):
        OllamaClient("http://localhost:11434").list_models()


def test_plain_connection_error_is_unavailable(monkeypatch: pytest.MonkeyPatch) -> None:
    def reset(request: object, timeout: float) -> object:
        raise ConnectionResetError("caiu")

    monkeypatch.setattr(urllib.request, "urlopen", reset)
    with pytest.raises(OllamaUnavailableError):
        OllamaClient("http://localhost:11434").list_models()


def test_stream_connection_refused_is_unavailable(monkeypatch: pytest.MonkeyPatch) -> None:
    def refused(request: object, timeout: float) -> object:
        raise urllib.error.URLError(ConnectionRefusedError(111, "recusada"))

    monkeypatch.setattr(urllib.request, "urlopen", refused)
    with pytest.raises(OllamaUnavailableError):
        OllamaClient("http://localhost:11434").pull("m")


def test_timeout_is_a_regular_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    def slow(request: object, timeout: float) -> object:
        raise TimeoutError("demorou")

    monkeypatch.setattr(urllib.request, "urlopen", slow)
    with pytest.raises(OllamaError) as caught:
        OllamaClient("http://localhost:11434").list_models()
    assert not isinstance(caught.value, OllamaUnavailableError)


@pytest.mark.parametrize(
    ("url", "location", "loopback"),
    [
        ("http://localhost:11434", ProviderLocation.LOCAL, True),
        ("http://127.0.0.1:11434", ProviderLocation.LOCAL, True),
        ("http://[::1]:11434", ProviderLocation.LOCAL, True),
        ("http://192.168.0.10:11434", ProviderLocation.LOCAL, False),
        ("http://gpu-box.local:11434", ProviderLocation.LOCAL, False),
        ("http://gpu-box:11434", ProviderLocation.LOCAL, False),
        ("https://ollama.example.com", ProviderLocation.CLOUD, False),
        ("http://8.8.8.8:11434", ProviderLocation.CLOUD, False),
        ("não é url", ProviderLocation.CLOUD, False),
    ],
)
def test_provider_location_follows_url(
    url: str, location: ProviderLocation, loopback: bool
) -> None:
    client = OllamaClient(url, post=_Recorder({}))
    assert OllamaLLMProvider(client, default_model="m").location is location
    assert OllamaEmbeddingProvider(client, default_model="m").location is location
    assert is_loopback_url(url) is loopback


class _Streamer:
    """Stream falso de /api/generate: devolve os pedaços e guarda os payloads."""

    def __init__(self, chunks: list[dict[str, Any]]) -> None:
        self.chunks = chunks
        self.payloads: list[dict[str, Any]] = []

    def __call__(self, path: str, payload: dict[str, Any]) -> Iterator[dict[str, Any]]:
        assert path == "/api/generate"
        self.payloads.append(payload)
        return iter(self.chunks)


def _show(capabilities: list[str] | None) -> _Recorder:
    body: dict[str, Any] = {} if capabilities is None else {"capabilities": capabilities}
    return _Recorder({"/api/show": body})


def test_generate_streams_and_joins_the_response() -> None:
    streamer = _Streamer([{"response": '{"a"'}, {"response": ": 1}"}, {"done": True}])
    client = OllamaClient("http://x", post=_show([]), stream=streamer)
    assert client.generate(model="m", prompt="p") == '{"a": 1}'
    assert streamer.payloads[0]["stream"] is True


def test_generate_turns_thinking_off_only_for_thinking_models() -> None:
    thinking = _Streamer([{"response": "ok"}])
    client = OllamaClient("http://x", post=_show(["completion", "thinking"]), stream=thinking)
    client.generate(model="qwen3:8b", prompt="p", think=False)
    client.generate(model="qwen3:8b", prompt="p", think=False)
    assert thinking.payloads[0]["think"] is False
    plain = _Streamer([{"response": "ok"}])
    other = OllamaClient("http://x", post=_show(["completion"]), stream=plain)
    other.generate(model="llama3", prompt="p", think=False)
    assert "think" not in plain.payloads[0]


def test_capability_probe_is_cached_per_model() -> None:
    recorder = _show(["thinking"])
    client = OllamaClient("http://x", post=recorder, stream=_Streamer([{"response": "ok"}]))
    client.generate(model="qwen3:8b", prompt="p", think=False)
    client.generate(model="qwen3:8b", prompt="p", think=False)
    assert [path for path, _payload in recorder.calls] == ["/api/show"]


def test_capability_probe_failure_leaves_thinking_untouched() -> None:
    def broken(path: str, payload: dict[str, Any] | None) -> dict[str, Any]:
        raise OllamaError("show indisponível")

    streamer = _Streamer([{"response": "ok"}])
    client = OllamaClient("http://x", post=broken, stream=streamer)
    client.generate(model="m", prompt="p", think=False)
    assert "think" not in streamer.payloads[0]
    old = _Streamer([{"response": "ok"}])
    OllamaClient("http://x", post=_show(None), stream=old).generate(
        model="m", prompt="p", think=False
    )
    assert "think" not in old.payloads[0]


def test_generate_reports_errors_sent_in_the_stream() -> None:
    client = OllamaClient("http://x", post=_show([]), stream=_Streamer([{"error": "sem memória"}]))
    with pytest.raises(OllamaError, match="sem memória"):
        client.generate(model="m", prompt="p")


def test_generate_without_text_is_invalid() -> None:
    client = OllamaClient("http://x", post=_show([]), stream=_Streamer([{"done": True}]))
    with pytest.raises(OllamaError, match="sem resposta"):
        client.generate(model="m", prompt="p")


def test_injected_post_also_serves_generate() -> None:
    recorder = _Recorder({"/api/generate": {"response": "texto"}})
    assert OllamaClient("http://x", post=recorder).generate(model="m", prompt="p") == "texto"


def test_llm_provider_forwards_thinking_preference() -> None:
    streamer = _Streamer([{"response": "{}"}])
    client = OllamaClient("http://x", post=_show(["thinking"]), stream=streamer)
    provider = OllamaLLMProvider(client, default_model="m")
    provider.generate(LLMRequest(user_prompt="p", metadata={"think": False}, max_tokens=512))
    assert streamer.payloads[0]["think"] is False
    assert streamer.payloads[0]["options"]["num_predict"] == 512


def test_empty_stream_explains_that_the_model_process_died() -> None:
    client = OllamaClient("http://x", post=_show([]), stream=_Streamer([]))
    with pytest.raises(OllamaError, match="caiu"):
        client.generate(model="m", prompt="p")
