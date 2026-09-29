"""Providers de Ollama implementando as interfaces do ai-core.

A comunicação HTTP usa apenas a biblioteca padrão (urllib) e é injetável, para
os testes não dependerem de um Ollama real. O provider só é ``LOCAL`` quando a URL
aponta para esta máquina ou para a rede local; um host público é ``CLOUD`` e a
política ``LOCAL_ONLY`` do app o recusa.
"""

from __future__ import annotations

import ipaddress
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable, Iterator
from typing import Any

from ai_core import (
    Embedding,
    EmbeddingProvider,
    LLMProvider,
    LLMRequest,
    LLMResponse,
    ProviderLocation,
)

# ``payload=None`` é um GET (ex.: ``/api/tags`` só aceita GET/HEAD no Ollama).
Post = Callable[[str, dict[str, Any] | None], dict[str, Any]]
StreamPost = Callable[[str, dict[str, Any]], Iterator[dict[str, Any]]]


class OllamaError(Exception):
    """Falha de comunicação ou resposta inválida do Ollama."""


class OllamaUnavailableError(OllamaError):
    """O Ollama não está de pé (conexão recusada/derrubada): não é culpa do pedido."""


def _host_of(url: str) -> str:
    return (urllib.parse.urlsplit(url).hostname or "").lower()


def is_loopback_url(url: str) -> bool:
    """A URL aponta para esta máquina?"""
    host = _host_of(url)
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def location_for(url: str) -> ProviderLocation:
    """Esta máquina, IP privado ou nome de rede local (sem domínio ou ``.local``): LOCAL."""
    host = _host_of(url)
    if not host:
        return ProviderLocation.CLOUD
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        local_name = "." not in host or host.endswith((".local", ".lan", ".internal"))
        return ProviderLocation.LOCAL if local_name else ProviderLocation.CLOUD
    private = address.is_loopback or address.is_private or address.is_link_local
    return ProviderLocation.LOCAL if private else ProviderLocation.CLOUD


def _failure(base_url: str, exc: BaseException) -> OllamaError:
    reason = exc.reason if isinstance(exc, urllib.error.URLError) else exc
    kind = OllamaUnavailableError if isinstance(reason, ConnectionError) else OllamaError
    return kind(f"Falha ao chamar o Ollama em {base_url}: {exc}")


class OllamaClient:
    """Cliente HTTP mínimo para a API local do Ollama."""

    def __init__(
        self,
        base_url: str,
        *,
        timeout: float = 120.0,
        post: Post | None = None,
        stream: StreamPost | None = None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._timeout = timeout
        self._post = post or self._http_post
        # Só ``post`` injetado (testes/dublês): a geração usa a resposta dele como pedaço único.
        self._stream = stream or (self._single_chunk if post is not None else self._http_stream)
        self._thinking: dict[str, bool] = {}

    @property
    def base_url(self) -> str:
        return self._base_url

    def _http_post(self, path: str, payload: dict[str, Any] | None) -> dict[str, Any]:
        body = None if payload is None else json.dumps(payload).encode("utf-8")
        request = urllib.request.Request(  # noqa: S310 - URL local configurada pelo usuário
            f"{self._base_url}{path}",
            data=body,
            headers={"Content-Type": "application/json"},
            method="GET" if payload is None else "POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self._timeout) as response:  # noqa: S310
                decoded = json.loads(response.read().decode("utf-8"))
        except (urllib.error.URLError, OSError, ValueError) as exc:
            raise _failure(self._base_url, exc) from exc
        if not isinstance(decoded, dict):
            raise OllamaError("Resposta do Ollama não é um objeto JSON")
        return decoded

    def _single_chunk(self, path: str, payload: dict[str, Any]) -> Iterator[dict[str, Any]]:
        yield self._post(path, payload)

    def supports_thinking(self, model: str) -> bool:
        """O modelo tem modo de raciocínio (ex.: qwen3)? Consulta ``/api/show`` uma vez."""
        if model not in self._thinking:
            try:
                capabilities = self._post("/api/show", {"model": model}).get("capabilities")
            except Exception:  # sem a informação, não mexe no raciocínio
                capabilities = None
            self._thinking[model] = isinstance(capabilities, list) and "thinking" in capabilities
        return self._thinking[model]

    def _http_stream(self, path: str, payload: dict[str, Any]) -> Iterator[dict[str, Any]]:
        body = json.dumps(payload).encode("utf-8")
        request = urllib.request.Request(  # noqa: S310 - URL local configurada pelo usuário
            f"{self._base_url}{path}",
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            response = urllib.request.urlopen(request, timeout=self._timeout)  # noqa: S310
        except (urllib.error.URLError, OSError) as exc:
            raise _failure(self._base_url, exc) from exc
        with response:
            for raw in response:
                line = raw.decode("utf-8").strip()
                if not line:
                    continue
                try:
                    chunk = json.loads(line)
                except ValueError as exc:
                    raise OllamaError("Resposta do Ollama não é JSON por linha") from exc
                if isinstance(chunk, dict):
                    yield chunk

    def pull(
        self,
        model: str,
        *,
        on_progress: Callable[[dict[str, Any]], None] | None = None,
    ) -> None:
        """Baixa (ou atualiza) um modelo via ``/api/pull``, bloqueando até terminar."""
        for chunk in self._stream("/api/pull", {"model": model, "stream": True}):
            if on_progress is not None:
                on_progress(chunk)
            error = chunk.get("error")
            if isinstance(error, str):
                raise OllamaError(f"Falha ao baixar o modelo '{model}': {error}")
            if chunk.get("status") == "success":
                return
        raise OllamaError(f"O download do modelo '{model}' terminou sem confirmação")

    def generate(
        self,
        *,
        model: str,
        prompt: str,
        system: str | None = None,
        temperature: float = 0.0,
        max_tokens: int | None = None,
        response_format: str | None = None,
        context_tokens: int | None = None,
        think: bool | None = None,
    ) -> str:
        """Gera texto via ``/api/generate`` em streaming.

        Em streaming o tempo limite vale para a *falta* de resposta, não para a geração
        inteira: numa GPU fraca uma resposta longa leva minutos, mas os tokens chegam.
        ``think=False`` desliga o raciocínio de modelos que o têm (o qwen3 gastaria
        centenas de tokens "pensando" antes do JSON); modelos sem ele não recebem o campo.
        """
        options: dict[str, Any] = {"temperature": temperature}
        if max_tokens is not None:
            options["num_predict"] = max_tokens
        if context_tokens is not None:
            options["num_ctx"] = context_tokens
        payload: dict[str, Any] = {
            "model": model,
            "prompt": prompt,
            "stream": True,
            "options": options,
        }
        if system:
            payload["system"] = system
        if response_format:
            payload["format"] = response_format
        if think is not None and self.supports_thinking(model):
            payload["think"] = think
        return self._collect(self._stream("/api/generate", payload))

    @staticmethod
    def _collect(chunks: Iterator[dict[str, Any]]) -> str:
        """Junta os pedaços de texto do stream; erro no meio vira :class:`OllamaError`."""
        parts: list[str] = []
        for chunk in chunks:
            error = chunk.get("error")
            if isinstance(error, str):
                raise OllamaError(f"O Ollama recusou a geração: {error}")
            piece = chunk.get("response")
            if isinstance(piece, str):
                parts.append(piece)
        if not parts:
            # HTTP 200 sem nenhum pedaço: o processo do modelo caiu no meio (ex.: a GPU
            # integrada perdeu o dispositivo com um prompt longo). O log do Ollama tem o motivo.
            raise OllamaError(
                "O Ollama encerrou a geração sem resposta: o processo do modelo caiu "
                "(veja o log do Ollama; prompts longos derrubam algumas GPUs integradas)."
            )
        return "".join(parts)

    def embed(self, *, model: str, text: str) -> list[float]:
        """Gera embeddings via ``/api/embeddings``."""
        data = self._post("/api/embeddings", {"model": model, "prompt": text})
        vector = data.get("embedding")
        if not isinstance(vector, list) or not all(isinstance(v, int | float) for v in vector):
            raise OllamaError("Resposta inválida do Ollama: campo 'embedding' ausente")
        return [float(v) for v in vector]

    def list_models(self) -> list[str]:
        """Lista os modelos instalados via ``/api/tags``."""
        data = self._post("/api/tags", None)
        models = data.get("models")
        if not isinstance(models, list):
            raise OllamaError("Resposta inválida do Ollama: campo 'models' ausente")
        return [str(item.get("name", "")) for item in models if isinstance(item, dict)]

    def health(self) -> bool:
        """Indica se o Ollama respondeu à listagem de modelos."""
        try:
            self.list_models()
        except OllamaError:
            return False
        return True


class OllamaLLMProvider(LLMProvider):
    """LLMProvider servido pelo Ollama (local, salvo URL pública)."""

    name = "ollama"

    def __init__(self, client: OllamaClient, *, default_model: str) -> None:
        self._client = client
        self._default_model = default_model
        self.location = location_for(client.base_url)

    @property
    def default_model(self) -> str:
        return self._default_model

    def generate(self, request: LLMRequest) -> LLMResponse:
        model = request.model or self._default_model
        started = time.monotonic()
        response_format = request.metadata.get("format")
        context_tokens = request.metadata.get("num_ctx")
        think = request.metadata.get("think")
        text = self._client.generate(
            model=model,
            prompt=_compose_prompt(request),
            system=request.system_prompt,
            temperature=request.temperature,
            max_tokens=request.max_tokens,
            response_format=response_format if isinstance(response_format, str) else None,
            context_tokens=context_tokens if isinstance(context_tokens, int) else None,
            think=think if isinstance(think, bool) else None,
        )
        duration_ms = (time.monotonic() - started) * 1000.0
        return LLMResponse(text=text, model=model, provider=self.name, duration_ms=duration_ms)


class OllamaEmbeddingProvider(EmbeddingProvider):
    """EmbeddingProvider local servido pelo Ollama.

    A dimensão é descoberta na primeira chamada a :meth:`embed` (o core não
    assume dimensão fixa) e pode ser configurada explicitamente.
    """

    name = "ollama"

    def __init__(
        self, client: OllamaClient, *, default_model: str, dimension: int | None = None
    ) -> None:
        self._client = client
        self._default_model = default_model
        self._dimension = dimension
        self.location = location_for(client.base_url)

    @property
    def dimension(self) -> int:
        if self._dimension is None:
            raise OllamaError("Dimensão do embedding ainda não descoberta; chame embed()")
        return self._dimension

    def embed(self, text: str) -> Embedding:
        vector = self._client.embed(model=self._default_model, text=text)
        self._dimension = len(vector)
        return Embedding(text=text, vector=vector, model=self._default_model, dimension=len(vector))


def _compose_prompt(request: LLMRequest) -> str:
    if not request.context:
        return request.user_prompt
    context = "\n\n".join(request.context)
    return f"Contexto:\n{context}\n\n{request.user_prompt}"
