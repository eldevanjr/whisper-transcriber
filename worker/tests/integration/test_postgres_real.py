"""PostgreSQL + pgvector de verdade, num container próprio do teste (plano §28).

Precisa de Docker; sem ele o teste é pulado. Usa nome de container e volume
exclusivos e remove os dois no fim.
"""

from __future__ import annotations

import shutil
import subprocess
import sys
import uuid
from collections.abc import Iterator

import pytest
from ai_core import ConfigurationError

from tests.ai.fakes import FakeEmbedder
from transcriber_worker.ai.indexing import Indexer
from transcriber_worker.ai.postgres import PostgresVectorStore
from transcriber_worker.ai.provision import ContainerRuntime, LocalPostgres
from transcriber_worker.ai.storage import StorageBackend, StorageConfig, StorageMode, build_storage
from transcriber_worker.ai.store import SQLiteStore
from transcriber_worker.ai.windows import SegmentInput

pytestmark = [
    pytest.mark.integration,
    pytest.mark.timeout(900),
    pytest.mark.skipif(shutil.which("docker") is None, reason="Docker indisponível"),
    # Docker no Windows/macOS dos runners não roda a imagem Linux do pgvector.
    pytest.mark.skipif(sys.platform != "linux", reason="container pgvector só no Linux"),
]

PASSWORD = "senha-" + uuid.uuid4().hex


@pytest.fixture
def local() -> Iterator[tuple[LocalPostgres, StorageConfig]]:
    suffix = uuid.uuid4().hex[:8]
    name, volume = f"wt-test-pg-{suffix}", f"wt-test-pg-{suffix}"
    server = LocalPostgres(ContainerRuntime.DOCKER, name=name)
    config = StorageConfig(mode=StorageMode.LOCAL, volume=volume, password=PASSWORD)
    yield server, config
    subprocess.run(["docker", "rm", "-f", name], capture_output=True, check=False)  # noqa: S603, S607
    subprocess.run(["docker", "volume", "rm", volume], capture_output=True, check=False)  # noqa: S603, S607


def _build(server: LocalPostgres, config: StorageConfig, model: str) -> StorageBackend:
    return build_storage(
        config, store=SQLiteStore(), embedding_model=model, local=server, ready_attempts=90
    )


def test_local_postgres_indexes_and_searches(local: tuple[LocalPostgres, StorageConfig]) -> None:
    server, config = local
    backend = _build(server, config, "fake-embed")
    assert backend.kind == "postgres", backend.fallback_reason
    indexer = Indexer(
        repository=backend.repository,
        embeddings=FakeEmbedder(dimension=4),
        vector_store=backend.vector_store,
    )
    indexer.index_transcription(
        workspace_id="ws",
        transcription_id="t",
        title="Reunião",
        segments=[SegmentInput(index=0, start=0.0, end=5.0, text="sincronização offline")],
    )
    assert indexer.drain() == 1
    vectors = backend.vector_store
    assert isinstance(vectors, PostgresVectorStore)
    matches = vectors.query(workspace_id="ws", vector=[0.5] * 4, limit=3)
    assert len(matches) == 1
    assert matches[0].score == pytest.approx(1.0)
    assert vectors.indexed_models("ws") == ["fake-embed"]
    assert backend.repository.search_text(workspace_id="ws", query="offline")  # type: ignore[attr-defined]
    assert backend.connection is not None
    with backend.connection.cursor() as cursor:
        cursor.execute("SELECT indexname FROM pg_indexes WHERE tablename = 'vectors'")
        indexes = {row["indexname"] for row in cursor.fetchall()}
    assert "idx_vectors_hnsw_4" in indexes
    backend.close()

    # Reabrir reaproveita o container e as migrações não se repetem; outro modelo exige reindexar.
    again = _build(server, config, "outro-modelo")
    assert again.kind == "postgres", again.fallback_reason
    with pytest.raises(ConfigurationError, match="Reindexe"):
        again.vector_store.query(workspace_id="ws", vector=[0.5] * 4, limit=3)
    again.shutdown()
    assert server.running_port() is None
    again.close()


def test_wrong_password_falls_back_without_leaking_it(
    local: tuple[LocalPostgres, StorageConfig],
) -> None:
    server, config = local
    first = _build(server, config, "m")
    assert first.kind == "postgres", first.fallback_reason
    first.close()
    wrong = config.model_copy(update={"password": "outra-senha-errada"})
    backend = _build(server, wrong, "m")
    assert backend.kind == "sqlite"
    assert "outra-senha-errada" not in (backend.fallback_reason or "")
    first.shutdown()
