"""Backend PostgreSQL + pgvector do conhecimento.

A conexão é abstraída por :class:`PgConnection`, então a lógica é testável sem
um banco real. O driver (``psycopg``) é importado em :func:`open_postgres`; sem
ele (ou sem banco), o modo fallback (SQLite) continua disponível.

A conexão roda em autocommit (um erro de SQL não deixa a sessão presa em
"transaction aborted") e :class:`ReconnectingConnection` reabre a conexão se o
servidor reiniciar.
"""

from __future__ import annotations

import importlib
import json
from collections.abc import Callable, Mapping, Sequence
from typing import Any, Protocol, Self, cast

from ai_core import (
    ConfigurationError,
    KnowledgeChunk,
    KnowledgeDocument,
    KnowledgeRepository,
    Source,
    VectorMatch,
    VectorStore,
    WorkspaceMismatchError,
)
from pydantic import BaseModel, ConfigDict, Field

from transcriber_worker.ai.records import (
    chunk_from,
    document_from,
    like_pattern,
    metadata_from,
    source_from,
)


class PostgresUnavailableError(Exception):
    """Driver PostgreSQL ausente ou conexão indisponível."""


class PgCursor(Protocol):
    def execute(self, query: str, params: Sequence[Any] | None = None) -> Any: ...

    def fetchone(self) -> Mapping[str, Any] | None: ...

    def fetchall(self) -> list[Mapping[str, Any]]: ...

    def __enter__(self) -> Self: ...

    def __exit__(self, *args: object) -> None: ...


class PgConnection(Protocol):
    def cursor(self) -> PgCursor: ...

    def commit(self) -> None: ...

    def close(self) -> None: ...


class ReconnectingConnection:
    """Conexão que se reabre quando a anterior caiu (servidor reiniciado, rede)."""

    def __init__(self, opener: Callable[[], PgConnection]) -> None:
        self._opener = opener
        self._connection = opener()

    def _live(self) -> PgConnection:
        if getattr(self._connection, "closed", False) or getattr(self._connection, "broken", False):
            self._connection = self._opener()
        return self._connection

    def cursor(self) -> PgCursor:
        return self._live().cursor()

    def commit(self) -> None:
        self._live().commit()

    def close(self) -> None:
        self._connection.close()


class PostgresConfig(BaseModel):
    """Parâmetros de conexão do PostgreSQL configurado pelo usuário."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    host: str = "127.0.0.1"
    port: int = Field(default=5432, gt=0, le=65535)
    database: str = "whisper"
    username: str = "whisper"
    password: str
    ssl_mode: str = "prefer"
    connect_timeout: int = Field(default=10, gt=0)


_MIGRATION_V1: tuple[str, ...] = (
    "CREATE EXTENSION IF NOT EXISTS vector",
    """CREATE TABLE IF NOT EXISTS sources (
        id TEXT PRIMARY KEY,
        evidence_id TEXT,
        type TEXT NOT NULL,
        location TEXT,
        title TEXT,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb
    )""",
    """CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        source_id TEXT,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL
    )""",
    "CREATE INDEX IF NOT EXISTS idx_documents_workspace ON documents(workspace_id)",
    """CREATE TABLE IF NOT EXISTS chunks (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        content TEXT NOT NULL,
        position INTEGER NOT NULL,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        embedding_reference TEXT
    )""",
    "CREATE INDEX IF NOT EXISTS idx_chunks_document ON chunks(document_id, workspace_id)",
    """CREATE TABLE IF NOT EXISTS vectors (
        workspace_id TEXT NOT NULL,
        chunk_id TEXT NOT NULL,
        embedding vector NOT NULL,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        PRIMARY KEY (workspace_id, chunk_id)
    )""",
)

# Modelo e dimensão de cada vetor (plano §13): a troca de modelo exige reindexação e a
# dimensão permite um índice HNSW por dimensão (a coluna não tem dimensão fixa).
_MIGRATION_V2: tuple[str, ...] = (
    "ALTER TABLE vectors ADD COLUMN IF NOT EXISTS embedding_model TEXT",
    "ALTER TABLE vectors ADD COLUMN IF NOT EXISTS embedding_dimension INTEGER",
    "UPDATE vectors SET embedding_dimension = vector_dims(embedding)"
    " WHERE embedding_dimension IS NULL",
    "CREATE INDEX IF NOT EXISTS idx_vectors_dimension"
    " ON vectors(workspace_id, embedding_dimension)",
)

_MIGRATIONS: tuple[tuple[str, ...], ...] = (_MIGRATION_V1, _MIGRATION_V2)
SCHEMA_VERSION = len(_MIGRATIONS)


def redact(text: str, secrets: Sequence[str | None]) -> str:
    """Tira senhas de mensagens de erro (vão para log e interface)."""
    for secret in secrets:
        if secret:
            text = text.replace(secret, "***")
    return text


def open_postgres(
    config: PostgresConfig, *, importer: Callable[[str], Any] = importlib.import_module
) -> PgConnection:
    """Abre uma conexão (autocommit) via psycopg; falha vira :class:`PostgresUnavailableError`."""
    try:
        psycopg = importer("psycopg")
        rows = importer("psycopg.rows")
    except ImportError as exc:
        raise PostgresUnavailableError(
            "psycopg não está instalado; use o modo fallback (SQLite) ou instale psycopg."
        ) from exc
    try:
        connection = psycopg.connect(
            host=config.host,
            port=config.port,
            dbname=config.database,
            user=config.username,
            password=config.password,
            sslmode=config.ssl_mode,
            connect_timeout=config.connect_timeout,
            row_factory=rows.dict_row,
            autocommit=True,
        )
    except Exception as exc:
        message = redact(str(exc), [config.password])
        raise PostgresUnavailableError(
            f"Não foi possível conectar ao PostgreSQL em {config.host}:{config.port}: {message}"
        ) from None
    return cast(PgConnection, connection)


def run_migrations(connection: PgConnection) -> None:
    """Aplica as migrações que faltam (idempotente); a versão fica em ``whisper_schema_version``."""
    with connection.cursor() as cursor:
        cursor.execute(
            "CREATE TABLE IF NOT EXISTS whisper_schema_version (version INTEGER NOT NULL)"
        )
        cursor.execute("SELECT version FROM whisper_schema_version")
        row = cursor.fetchone()
        current = 0 if row is None else int(row["version"])
        for version, statements in enumerate(_MIGRATIONS[current:], start=current + 1):
            for statement in statements:
                cursor.execute(statement)
            cursor.execute("DELETE FROM whisper_schema_version")
            cursor.execute("INSERT INTO whisper_schema_version (version) VALUES (%s)", (version,))
    connection.commit()


class HealthCheck(BaseModel):
    name: str
    ok: bool
    detail: str | None = None


class HealthReport(BaseModel):
    checks: list[HealthCheck] = Field(default_factory=list)

    @property
    def ok(self) -> bool:
        return all(check.ok for check in self.checks)


def health_check(connection: PgConnection) -> HealthReport:
    """Valida conexão com o PostgreSQL e a presença da extensão pgvector."""
    checks: list[HealthCheck] = []
    with connection.cursor() as cursor:
        cursor.execute("SELECT version() AS version")
        row = cursor.fetchone()
        checks.append(
            HealthCheck(name="postgres", ok=row is not None, detail=_detail(row, "version"))
        )
    with connection.cursor() as cursor:
        cursor.execute("SELECT extversion FROM pg_extension WHERE extname = 'vector'")
        row = cursor.fetchone()
        checks.append(
            HealthCheck(name="pgvector", ok=row is not None, detail=_detail(row, "extversion"))
        )
    return HealthReport(checks=checks)


def _detail(row: Mapping[str, Any] | None, key: str) -> str | None:
    if row is None:
        return None
    value = row.get(key)
    return str(value) if value is not None else None


class PostgresKnowledgeRepository(KnowledgeRepository):
    """Repositório de conhecimento em PostgreSQL."""

    def __init__(self, connection: PgConnection) -> None:
        self._connection = connection

    def add_source(self, source: Source) -> Source:
        with self._connection.cursor() as cursor:
            cursor.execute(
                "INSERT INTO sources (id, evidence_id, type, location, title, metadata)"
                " VALUES (%s, %s, %s, %s, %s, %s::jsonb)"
                " ON CONFLICT (id) DO UPDATE SET evidence_id = EXCLUDED.evidence_id,"
                " type = EXCLUDED.type, location = EXCLUDED.location, title = EXCLUDED.title,"
                " metadata = EXCLUDED.metadata",
                (
                    source.id,
                    source.evidence_id,
                    str(source.type),
                    source.location,
                    source.title,
                    json.dumps(source.metadata),
                ),
            )
        self._connection.commit()
        return source

    def get_source(self, source_id: str) -> Source | None:
        with self._connection.cursor() as cursor:
            cursor.execute("SELECT * FROM sources WHERE id = %s", (source_id,))
            row = cursor.fetchone()
        return source_from(row) if row is not None else None

    def add_document(self, document: KnowledgeDocument) -> KnowledgeDocument:
        with self._connection.cursor() as cursor:
            cursor.execute("SELECT workspace_id FROM documents WHERE id = %s", (document.id,))
            existing = cursor.fetchone()
            if existing is not None and existing["workspace_id"] != document.workspace_id:
                raise WorkspaceMismatchError(
                    f"Documento '{document.id}' pertence a outro workspace."
                )
            cursor.execute(
                "INSERT INTO documents"
                " (id, workspace_id, source_id, title, content, metadata, created_at)"
                " VALUES (%s, %s, %s, %s, %s, %s::jsonb, %s)"
                " ON CONFLICT (id) DO UPDATE SET workspace_id = EXCLUDED.workspace_id,"
                " source_id = EXCLUDED.source_id, title = EXCLUDED.title,"
                " content = EXCLUDED.content, metadata = EXCLUDED.metadata,"
                " created_at = EXCLUDED.created_at",
                (
                    document.id,
                    document.workspace_id,
                    document.source_id,
                    document.title,
                    document.content,
                    json.dumps(document.metadata),
                    document.created_at,
                ),
            )
        self._connection.commit()
        return document

    def get_document(self, document_id: str, *, workspace_id: str) -> KnowledgeDocument | None:
        with self._connection.cursor() as cursor:
            cursor.execute(
                "SELECT * FROM documents WHERE id = %s AND workspace_id = %s",
                (document_id, workspace_id),
            )
            row = cursor.fetchone()
        return document_from(row) if row is not None else None

    def list_documents(self, workspace_id: str) -> list[KnowledgeDocument]:
        with self._connection.cursor() as cursor:
            cursor.execute("SELECT * FROM documents WHERE workspace_id = %s", (workspace_id,))
            rows = cursor.fetchall()
        return [document_from(row) for row in rows]

    def delete_document(self, document_id: str, *, workspace_id: str) -> None:
        with self._connection.cursor() as cursor:
            cursor.execute(
                "DELETE FROM chunks WHERE document_id = %s AND workspace_id = %s",
                (document_id, workspace_id),
            )
            cursor.execute(
                "DELETE FROM documents WHERE id = %s AND workspace_id = %s",
                (document_id, workspace_id),
            )
        self._connection.commit()

    def add_chunks(self, chunks: list[KnowledgeChunk]) -> None:
        with self._connection.cursor() as cursor:
            for chunk in chunks:
                cursor.execute(
                    "SELECT workspace_id FROM documents WHERE id = %s", (chunk.document_id,)
                )
                row = cursor.fetchone()
                if row is not None and row["workspace_id"] != chunk.workspace_id:
                    raise WorkspaceMismatchError(
                        f"Chunk '{chunk.id}' e documento '{chunk.document_id}' em workspaces"
                        " diferentes."
                    )
            for chunk in chunks:
                cursor.execute(
                    "INSERT INTO chunks"
                    " (id, document_id, workspace_id, content, position, metadata,"
                    " embedding_reference) VALUES (%s, %s, %s, %s, %s, %s::jsonb, %s)"
                    " ON CONFLICT (id) DO UPDATE SET document_id = EXCLUDED.document_id,"
                    " workspace_id = EXCLUDED.workspace_id, content = EXCLUDED.content,"
                    " position = EXCLUDED.position, metadata = EXCLUDED.metadata,"
                    " embedding_reference = EXCLUDED.embedding_reference",
                    (
                        chunk.id,
                        chunk.document_id,
                        chunk.workspace_id,
                        chunk.content,
                        chunk.position,
                        json.dumps(chunk.metadata),
                        chunk.embedding_reference,
                    ),
                )
        self._connection.commit()

    def get_chunks(self, document_id: str, *, workspace_id: str) -> list[KnowledgeChunk]:
        with self._connection.cursor() as cursor:
            cursor.execute(
                "SELECT * FROM chunks WHERE document_id = %s AND workspace_id = %s"
                " ORDER BY position",
                (document_id, workspace_id),
            )
            rows = cursor.fetchall()
        return [chunk_from(row) for row in rows]

    def get_chunk(self, chunk_id: str, *, workspace_id: str) -> KnowledgeChunk | None:
        with self._connection.cursor() as cursor:
            cursor.execute(
                "SELECT * FROM chunks WHERE id = %s AND workspace_id = %s",
                (chunk_id, workspace_id),
            )
            row = cursor.fetchone()
        return chunk_from(row) if row is not None else None

    def search_text(
        self, *, workspace_id: str, query: str, limit: int = 10
    ) -> list[KnowledgeChunk]:
        if limit <= 0:
            raise ConfigurationError("limit deve ser maior que zero.")
        with self._connection.cursor() as cursor:
            cursor.execute(
                "SELECT * FROM chunks WHERE workspace_id = %s AND content ILIKE %s ESCAPE '\\'"
                " ORDER BY position LIMIT %s",
                (workspace_id, like_pattern(query.strip()), limit),
            )
            rows = cursor.fetchall()
        return [chunk_from(row) for row in rows]


class PostgresVectorStore(VectorStore):
    """Índice vetorial em pgvector (cosseno via ``<=>``, HNSW por dimensão).

    A coluna ``embedding`` não tem dimensão fixa (o modelo é configurável); cada
    dimensão usada ganha um índice HNSW parcial sobre ``embedding::vector(n)``, e as
    consultas usam a mesma expressão para aproveitá-lo.
    """

    def __init__(self, connection: PgConnection, *, embedding_model: str | None = None) -> None:
        self._connection = connection
        self._model = embedding_model
        self._indexed_dimensions: set[int] = set()

    def upsert(
        self,
        *,
        chunk_id: str,
        workspace_id: str,
        vector: list[float],
        metadata: dict[str, Any] | None = None,
    ) -> None:
        self._assert_model(workspace_id)
        self._assert_dimension(workspace_id, vector, ignore=chunk_id)
        with self._connection.cursor() as cursor:
            cursor.execute(
                "INSERT INTO vectors (workspace_id, chunk_id, embedding, metadata,"
                " embedding_model, embedding_dimension)"
                " VALUES (%s, %s, %s::vector, %s::jsonb, %s, %s)"
                " ON CONFLICT (workspace_id, chunk_id) DO UPDATE SET"
                " embedding = EXCLUDED.embedding, metadata = EXCLUDED.metadata,"
                " embedding_model = EXCLUDED.embedding_model,"
                " embedding_dimension = EXCLUDED.embedding_dimension",
                (
                    workspace_id,
                    chunk_id,
                    _vector_literal(vector),
                    json.dumps(metadata or {}),
                    self._model,
                    len(vector),
                ),
            )
        self._connection.commit()
        self._ensure_index(len(vector))

    def query(
        self,
        *,
        workspace_id: str,
        vector: list[float],
        limit: int,
        filters: dict[str, Any] | None = None,
    ) -> list[VectorMatch]:
        if limit <= 0:
            raise ConfigurationError("limit deve ser maior que zero.")
        self._assert_model(workspace_id)
        self._assert_dimension(workspace_id, vector)
        filters = filters or {}
        dimension = len(vector)
        literal = _vector_literal(vector)
        # ``dimension`` é um int (não vem do usuário como texto): seguro no SQL.
        distance = f"embedding::vector({dimension}) <=> %s::vector({dimension})"
        query = (
            f"SELECT chunk_id, metadata, 1 - ({distance}) AS score"  # noqa: S608
            " FROM vectors WHERE workspace_id = %s AND embedding_dimension = %s"
        )
        params: list[Any] = [literal, workspace_id, dimension]
        if filters:
            query += " AND metadata @> %s::jsonb"
            params.append(json.dumps(filters))
        query += f" ORDER BY {distance} LIMIT %s"
        params.extend([literal, limit])
        with self._connection.cursor() as cursor:
            cursor.execute(query, tuple(params))
            rows = cursor.fetchall()
        return [
            VectorMatch(
                chunk_id=row["chunk_id"],
                workspace_id=workspace_id,
                score=float(row["score"]),
                metadata=metadata_from(row["metadata"]),
            )
            for row in rows
        ]

    def delete(self, *, workspace_id: str, chunk_id: str) -> None:
        with self._connection.cursor() as cursor:
            cursor.execute(
                "DELETE FROM vectors WHERE workspace_id = %s AND chunk_id = %s",
                (workspace_id, chunk_id),
            )
        self._connection.commit()

    def delete_workspace(self, workspace_id: str) -> None:
        with self._connection.cursor() as cursor:
            cursor.execute("DELETE FROM vectors WHERE workspace_id = %s", (workspace_id,))
        self._connection.commit()

    def indexed_models(self, workspace_id: str) -> list[str]:
        """Modelos de embedding presentes no índice do workspace."""
        with self._connection.cursor() as cursor:
            cursor.execute(
                "SELECT DISTINCT embedding_model FROM vectors"
                " WHERE workspace_id = %s AND embedding_model IS NOT NULL ORDER BY 1",
                (workspace_id,),
            )
            rows = cursor.fetchall()
        return [str(row["embedding_model"]) for row in rows]

    def _ensure_index(self, dimension: int) -> None:
        if dimension in self._indexed_dimensions:
            return
        # HNSW só indexa até 2000 dimensões; acima disso a busca segue sequencial.
        if dimension <= 2000:
            with self._connection.cursor() as cursor:
                cursor.execute(
                    f"CREATE INDEX IF NOT EXISTS idx_vectors_hnsw_{dimension} ON vectors"
                    f" USING hnsw ((embedding::vector({dimension})) vector_cosine_ops)"
                    f" WHERE embedding_dimension = {dimension}"
                )
            self._connection.commit()
        self._indexed_dimensions.add(dimension)

    def _assert_model(self, workspace_id: str) -> None:
        if self._model is None:
            return
        with self._connection.cursor() as cursor:
            cursor.execute(
                "SELECT embedding_model FROM vectors WHERE workspace_id = %s"
                " AND embedding_model IS NOT NULL AND embedding_model <> %s LIMIT 1",
                (workspace_id, self._model),
            )
            row = cursor.fetchone()
        if row is not None:
            raise ConfigurationError(
                f"O índice do workspace '{workspace_id}' foi gerado com o modelo "
                f"'{row['embedding_model']}', não '{self._model}'. Reindexe o conhecimento."
            )

    def _assert_dimension(
        self, workspace_id: str, vector: list[float], *, ignore: str | None = None
    ) -> None:
        if not vector:
            raise ConfigurationError("Vetor vazio não pode ser indexado nem consultado.")
        with self._connection.cursor() as cursor:
            cursor.execute(
                "SELECT embedding_dimension AS dimension FROM vectors"
                " WHERE workspace_id = %s AND chunk_id <> %s LIMIT 1",
                (workspace_id, ignore or ""),
            )
            row = cursor.fetchone()
        if row is not None and int(row["dimension"]) != len(vector):
            raise ConfigurationError(
                f"Dimensão {len(vector)} difere da dimensão indexada "
                f"({row['dimension']}) no workspace '{workspace_id}'. Reindexe."
            )


def _vector_literal(vector: list[float]) -> str:
    return "[" + ",".join(repr(float(value)) for value in vector) + "]"
