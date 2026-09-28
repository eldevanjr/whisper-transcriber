from __future__ import annotations

from typing import Any

import pytest

from tests.ai.test_postgres import FakeConnection
from transcriber_worker.ai.postgres import (
    SCHEMA_VERSION,
    PgConnection,
    PostgresConfig,
    PostgresUnavailableError,
    PostgresVectorStore,
)
from transcriber_worker.ai.provision import ContainerRuntime
from transcriber_worker.ai.storage import (
    StorageConfig,
    StorageMode,
    build_storage,
    postgres_storage,
    sqlite_storage,
)
from transcriber_worker.ai.store import SQLiteStore, SQLiteVectorStore

EXTERNAL = PostgresConfig(host="db.local", password="externa")  # noqa: S106


class FakeLocal:
    def __init__(self, *, port: int | None = None, error: Exception | None = None) -> None:
        self.port = port
        self.error = error
        self.started: list[dict[str, str]] = []
        self.stopped = 0

    def running_port(self) -> int | None:
        return self.port

    def start(self, *, volume: str, password: str, image: str) -> int:
        if self.error is not None:
            raise self.error
        self.started.append({"volume": volume, "password": password, "image": image})
        self.port = 40000
        return 40000

    def stop(self) -> None:
        self.stopped += 1


class Opener:
    """Abre conexões falsas; ``fail`` define quantas tentativas falham antes."""

    def __init__(self, fail: int = 0, migrated: bool = True) -> None:
        self.fail = fail
        self.migrated = migrated
        self.configs: list[PostgresConfig] = []

    def __call__(self, config: PostgresConfig) -> PgConnection:
        self.configs.append(config)
        if self.fail > 0:
            self.fail -= 1
            raise PostgresUnavailableError(f"recusada (senha {config.password})")
        version = {"version": SCHEMA_VERSION} if self.migrated else None
        return FakeConnection([None, version])


def _build(config: StorageConfig | None, **options: Any) -> Any:
    options.setdefault("sleep", lambda _seconds: None)
    return build_storage(config, store=SQLiteStore(), embedding_model="nomic", **options)


def test_fallback_mode_uses_the_given_sqlite_store() -> None:
    store = SQLiteStore()
    backend = build_storage(None, store=store, embedding_model="nomic")
    assert backend.kind == "sqlite"
    assert backend.fallback_reason is None
    assert isinstance(backend.vector_store, SQLiteVectorStore)
    backend.close()
    backend.shutdown()
    with store.locked() as conn:  # o store pertence ao runtime: continua aberto
        conn.execute("SELECT 1")


def test_external_connects_and_migrates() -> None:
    opener = Opener()
    backend = _build(StorageConfig(mode=StorageMode.EXTERNAL, postgres=EXTERNAL), opener=opener)
    assert backend.kind == "postgres"
    assert opener.configs == [EXTERNAL]
    assert isinstance(backend.vector_store, PostgresVectorStore)


def test_external_without_connection_data_falls_back() -> None:
    backend = _build(StorageConfig(mode=StorageMode.EXTERNAL), opener=Opener())
    assert backend.kind == "sqlite"
    assert "dados de conexão" in (backend.fallback_reason or "")


def test_external_failure_falls_back_without_password() -> None:
    backend = _build(
        StorageConfig(mode=StorageMode.EXTERNAL, postgres=EXTERNAL), opener=Opener(fail=10)
    )
    assert backend.kind == "sqlite"
    assert "externa" not in (backend.fallback_reason or "")


def test_migration_failure_falls_back_and_closes_connection() -> None:
    connections: list[FakeConnection] = []

    def opener(_config: PostgresConfig) -> PgConnection:
        class Broken(FakeConnection):
            def cursor(self) -> Any:
                raise RuntimeError("permission denied to create extension vector")

        connection = Broken()
        connections.append(connection)
        return connection

    backend = _build(StorageConfig(mode=StorageMode.EXTERNAL, postgres=EXTERNAL), opener=opener)
    assert backend.kind == "sqlite"
    assert "permission denied" in (backend.fallback_reason or "")
    assert connections[0].closed is True


def test_local_provisions_waits_until_ready_and_stops_on_shutdown() -> None:
    local = FakeLocal()
    opener = Opener(fail=2)
    config = StorageConfig(mode=StorageMode.LOCAL, volume="dados", password="s3nha")  # noqa: S106
    backend = _build(config, opener=opener, local=local)
    assert backend.kind == "postgres"
    assert local.started == [{"volume": "dados", "password": "s3nha", "image": config.image}]
    assert len(opener.configs) == 3
    assert opener.configs[-1].port == 40000
    assert opener.configs[-1].username == "whisper"
    backend.shutdown()
    assert local.stopped == 1


def test_local_gives_up_after_the_ready_timeout() -> None:
    config = StorageConfig(mode=StorageMode.LOCAL, volume="v", password="s3gr3do")  # noqa: S106
    backend = _build(config, opener=Opener(fail=1000), local=FakeLocal(), ready_attempts=3)
    assert backend.kind == "sqlite"
    assert "recusada" in (backend.fallback_reason or "")
    assert "s3gr3do" not in (backend.fallback_reason or "")


def test_local_requires_volume_and_password() -> None:
    backend = _build(StorageConfig(mode=StorageMode.LOCAL), local=FakeLocal())
    assert backend.kind == "sqlite"
    assert "volume e senha" in (backend.fallback_reason or "")


def test_local_without_container_runtime_falls_back() -> None:
    config = StorageConfig(mode=StorageMode.LOCAL, volume="v", password="s")  # noqa: S106
    backend = _build(config, which=lambda _name: None)
    assert backend.kind == "sqlite"
    assert "docker ou podman" in (backend.fallback_reason or "")


def test_local_container_start_failure_falls_back() -> None:
    config = StorageConfig(mode=StorageMode.LOCAL, volume="v", password="s")  # noqa: S106
    local = FakeLocal(error=PostgresUnavailableError("imagem não encontrada"))
    backend = _build(config, opener=Opener(), local=local)
    assert backend.kind == "sqlite"
    assert "imagem não encontrada" in (backend.fallback_reason or "")


def test_auto_prefers_configured_postgres() -> None:
    opener = Opener()
    config = StorageConfig(
        mode=StorageMode.AUTO,
        postgres=EXTERNAL,
        volume="v",
        password="s",  # noqa: S106
    )
    local = FakeLocal(port=41000)
    backend = _build(config, opener=opener, local=local)
    assert backend.kind == "postgres"
    assert opener.configs == [EXTERNAL]
    assert local.started == []


def test_auto_uses_existing_container_before_provisioning() -> None:
    opener = Opener()
    config = StorageConfig(mode=StorageMode.AUTO, volume="v", password="s")  # noqa: S106
    local = FakeLocal(port=41000)
    backend = _build(config, opener=opener, local=local)
    assert backend.kind == "postgres"
    assert opener.configs[0].port == 41000
    assert local.started == []


def test_auto_provisions_when_nothing_exists() -> None:
    config = StorageConfig(mode=StorageMode.AUTO, volume="v", password="s")  # noqa: S106
    local = FakeLocal()
    backend = _build(config, opener=Opener(), local=local)
    assert backend.kind == "postgres"
    assert len(local.started) == 1


def test_auto_falls_back_with_every_reason() -> None:
    config = StorageConfig(mode=StorageMode.AUTO, postgres=EXTERNAL)
    backend = _build(config, opener=Opener(fail=10), which=lambda _name: None)
    reason = backend.fallback_reason or ""
    assert "db.local" in reason
    assert "docker ou podman" in reason


def test_auto_with_runtime_but_without_container_secret() -> None:
    backend = _build(
        StorageConfig(mode=StorageMode.AUTO),
        local=FakeLocal(),
    )
    assert backend.kind == "sqlite"
    assert "volume e senha" in (backend.fallback_reason or "")


def test_default_local_uses_detected_runtime(monkeypatch: pytest.MonkeyPatch) -> None:
    created: list[ContainerRuntime] = []

    class Recording(FakeLocal):
        def __init__(self, runtime: ContainerRuntime) -> None:
            super().__init__(port=42000)
            created.append(runtime)

    monkeypatch.setattr("transcriber_worker.ai.storage.LocalPostgres", Recording)
    config = StorageConfig(mode=StorageMode.LOCAL, volume="v", password="s")  # noqa: S106
    backend = _build(config, opener=Opener(), which=lambda name: f"/bin/{name}")
    assert backend.kind == "postgres"
    assert created == [ContainerRuntime.DOCKER]


def test_sqlite_and_postgres_storage_close() -> None:
    store = SQLiteStore()
    managed = sqlite_storage(store, manage_store=True)
    managed.close()
    connection = FakeConnection()
    backend = postgres_storage(connection, embedding_model="m")
    backend.close()
    assert connection.closed is True
