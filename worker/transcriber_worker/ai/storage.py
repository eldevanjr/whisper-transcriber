"""Seleção do backend de conhecimento (PostgreSQL/pgvector ou SQLite).

Modos (plano §9 a §12):

- ``fallback``: SQLite local, nunca depende de serviço externo;
- ``external``: PostgreSQL configurado pelo usuário;
- ``local``: PostgreSQL + pgvector num container do app (Docker/Podman);
- ``auto``: configurado → container existente → provisionar → fallback.

Qualquer falha (driver, conexão, permissão para criar a extensão, migração) cai
para o SQLite com o motivo em ``fallback_reason`` — sem senhas. Análise e
entidades ficam sempre no SQLite local (``SQLiteAnalysisStore``); este módulo
cobre o repositório de conhecimento e o índice vetorial.
"""

from __future__ import annotations

import shutil
import time
from collections.abc import Callable
from dataclasses import dataclass
from enum import StrEnum
from typing import Protocol

from ai_core import KnowledgeRepository, VectorStore
from pydantic import BaseModel, ConfigDict

from transcriber_worker.ai.postgres import (
    PgConnection,
    PostgresConfig,
    PostgresKnowledgeRepository,
    PostgresUnavailableError,
    PostgresVectorStore,
    ReconnectingConnection,
    open_postgres,
    redact,
    run_migrations,
)
from transcriber_worker.ai.provision import (
    DATABASE_NAME,
    DATABASE_USER,
    ContainerRuntime,
    LocalPostgres,
    Which,
    detect_container_runtime,
)
from transcriber_worker.ai.store import (
    SQLiteKnowledgeRepository,
    SQLiteStore,
    SQLiteVectorStore,
)

READY_ATTEMPTS = 30
READY_DELAY_SECONDS = 1.0


class StorageMode(StrEnum):
    """Como obter o banco de conhecimento."""

    FALLBACK = "fallback"
    EXTERNAL = "external"
    LOCAL = "local"
    AUTO = "auto"


class StorageConfig(BaseModel):
    """Escolha do backend e os dados necessários para conectar/provisionar."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    mode: StorageMode = StorageMode.FALLBACK
    postgres: PostgresConfig | None = None
    volume: str | None = None
    password: str | None = None
    image: str = "pgvector/pgvector:pg16"


class LocalServer(Protocol):
    """O que o storage usa do container local (:class:`LocalPostgres`)."""

    def running_port(self) -> int | None: ...

    def start(self, *, volume: str, password: str, image: str) -> int: ...

    def stop(self) -> None: ...


Opener = Callable[[PostgresConfig], PgConnection]


def _noop() -> None:
    return None


@dataclass(slots=True)
class StorageBackend:
    """Repositório + índice vetorial ativos, com o motivo do fallback (se houve)."""

    repository: KnowledgeRepository
    vector_store: VectorStore
    kind: str
    fallback_reason: str | None = None
    connection: PgConnection | None = None
    _close: Callable[[], None] = _noop
    _shutdown: Callable[[], None] = _noop

    def close(self) -> None:
        """Fecha a conexão (reconfigurar a IA não derruba o container)."""
        self._close()

    def shutdown(self) -> None:
        """App fechando: para o container do app, se este backend o subiu/usou."""
        self._shutdown()


def sqlite_storage(
    store: SQLiteStore,
    *,
    fallback_reason: str | None = None,
    manage_store: bool = False,
    embedding_model: str | None = None,
) -> StorageBackend:
    """Backend SQLite sobre uma conexão já aberta."""
    return StorageBackend(
        repository=SQLiteKnowledgeRepository(store),
        vector_store=SQLiteVectorStore(store, embedding_model=embedding_model),
        kind="sqlite",
        fallback_reason=fallback_reason,
        _close=store.close if manage_store else _noop,
    )


def postgres_storage(
    connection: PgConnection,
    *,
    embedding_model: str | None = None,
    shutdown: Callable[[], None] = _noop,
) -> StorageBackend:
    """Backend PostgreSQL já migrado; fecha a conexão no ``close``."""
    return StorageBackend(
        repository=PostgresKnowledgeRepository(connection),
        vector_store=PostgresVectorStore(connection, embedding_model=embedding_model),
        kind="postgres",
        connection=connection,
        _close=connection.close,
        _shutdown=shutdown,
    )


class _Unavailable(Exception):
    """Candidato descartado; a mensagem entra no motivo do fallback."""


class _Resolver:
    """Tenta os candidatos do modo, na ordem, até um conectar."""

    def __init__(
        self,
        config: StorageConfig,
        *,
        opener: Opener,
        local: LocalServer | None,
        sleep: Callable[[float], object],
        ready_attempts: int,
    ) -> None:
        self._config = config
        self._opener = opener
        self._local = local
        self._sleep = sleep
        self._ready_attempts = ready_attempts
        self.reasons: list[str] = []
        self.shutdown: Callable[[], None] = _noop

    def _secrets(self) -> list[str | None]:
        postgres = self._config.postgres
        return [self._config.password, postgres.password if postgres else None]

    def resolve(self) -> PgConnection | None:
        mode = self._config.mode
        attempts: list[Callable[[], PgConnection]] = []
        if mode in (StorageMode.EXTERNAL, StorageMode.AUTO):
            attempts.append(self._external)
        if mode is StorageMode.AUTO:
            attempts.append(self._existing_container)
        if mode in (StorageMode.LOCAL, StorageMode.AUTO):
            attempts.append(self._provisioned_container)
        for attempt in attempts:
            try:
                return attempt()
            except _Unavailable as exc:
                reason = redact(str(exc), self._secrets())
                if reason not in self.reasons:
                    self.reasons.append(reason)
        return None

    def _connect(self, config: PostgresConfig, *, attempts: int = 1) -> PgConnection:
        last: Exception | None = None
        for attempt in range(attempts):
            if attempt:
                self._sleep(READY_DELAY_SECONDS)
            try:
                connection = ReconnectingConnection(lambda: self._opener(config))
            except PostgresUnavailableError as exc:
                last = exc
                continue
            return self._migrated(connection)
        raise _Unavailable(f"PostgreSQL em {config.host}:{config.port}: {last}")

    def _migrated(self, connection: PgConnection) -> PgConnection:
        try:
            run_migrations(connection)
        except Exception as exc:
            connection.close()
            raise _Unavailable(f"Falha ao preparar o banco (pgvector/migrações): {exc}") from None
        return connection

    def _external(self) -> PgConnection:
        postgres = self._config.postgres
        if postgres is None or (self._config.mode is StorageMode.AUTO and not postgres.password):
            raise _Unavailable("PostgreSQL externo: faltam os dados de conexão.")
        return self._connect(postgres)

    def _require_local(self) -> LocalServer:
        if self._local is None:
            raise _Unavailable("PostgreSQL local: nenhum runtime de containers (docker ou podman).")
        return self._local

    def _container_config(self, port: int) -> PostgresConfig:
        return PostgresConfig(
            host="127.0.0.1",
            port=port,
            database=DATABASE_NAME,
            username=DATABASE_USER,
            password=self._config.password or "",
            ssl_mode="disable",
        )

    def _existing_container(self) -> PgConnection:
        local = self._require_local()
        port = local.running_port()
        if port is None or not self._config.password:
            raise _Unavailable("PostgreSQL local: nenhum container do app em execução.")
        connection = self._connect(self._container_config(port))
        self.shutdown = local.stop
        return connection

    def _provisioned_container(self) -> PgConnection:
        local = self._require_local()
        if not self._config.volume or not self._config.password:
            raise _Unavailable("PostgreSQL local: o modo exige volume e senha do container.")
        try:
            port = local.start(
                volume=self._config.volume,
                password=self._config.password,
                image=self._config.image,
            )
        except PostgresUnavailableError as exc:
            raise _Unavailable(str(exc)) from None
        self.shutdown = local.stop
        return self._connect(self._container_config(port), attempts=self._ready_attempts)


def build_storage(
    config: StorageConfig | None,
    *,
    store: SQLiteStore,
    embedding_model: str | None = None,
    opener: Opener = open_postgres,
    which: Which = shutil.which,
    local: LocalServer | None = None,
    sleep: Callable[[float], object] = time.sleep,
    ready_attempts: int = READY_ATTEMPTS,
) -> StorageBackend:
    """Resolve o backend pedido; em qualquer indisponibilidade, usa o SQLite do runtime."""
    if config is None or config.mode is StorageMode.FALLBACK:
        return sqlite_storage(store, embedding_model=embedding_model)
    if local is None:
        runtime = detect_container_runtime(which=which)
        local = None if runtime is ContainerRuntime.NONE else LocalPostgres(runtime)
    resolver = _Resolver(
        config, opener=opener, local=local, sleep=sleep, ready_attempts=ready_attempts
    )
    connection = resolver.resolve()
    if connection is None:
        return sqlite_storage(
            store, fallback_reason=" | ".join(resolver.reasons), embedding_model=embedding_model
        )
    return postgres_storage(connection, embedding_model=embedding_model, shutdown=resolver.shutdown)
