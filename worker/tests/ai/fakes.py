"""Dublês para os testes da camada de IA."""

from __future__ import annotations

from collections.abc import Callable

from ai_core import (
    Embedding,
    EmbeddingProvider,
    LLMProvider,
    LLMRequest,
    LLMResponse,
    ProviderLocation,
)


class FakeAnalyzerProvider(LLMProvider):
    """LLMProvider controlável: devolve o texto do responder ou levanta um erro."""

    name = "fake"
    location = ProviderLocation.LOCAL

    def __init__(
        self,
        responder: Callable[[LLMRequest], str] | None = None,
        error: BaseException | None = None,
    ) -> None:
        self.requests: list[LLMRequest] = []
        self._responder = responder or (lambda _request: '{"topics": []}')
        self._error = error

    def generate(self, request: LLMRequest) -> LLMResponse:
        self.requests.append(request)
        if self._error is not None:
            raise self._error
        return LLMResponse(text=self._responder(request), provider=self.name, model=request.model)


class FakeEmbedder(EmbeddingProvider):
    """Provider de embeddings de teste, com dimensão fixa ou variável (por tamanho)."""

    name = "fake-embed"
    location = ProviderLocation.LOCAL

    def __init__(
        self,
        *,
        dimension: int = 3,
        variable: bool = False,
        error: BaseException | None = None,
    ) -> None:
        self._dimension = dimension
        self._variable = variable
        self._error = error

    @property
    def dimension(self) -> int:
        return self._dimension

    def embed(self, text: str) -> Embedding:
        if self._error is not None:
            raise self._error
        dim = len(text) if self._variable else self._dimension
        return Embedding(text=text, vector=[0.5] * dim, model=self.name, dimension=dim)
