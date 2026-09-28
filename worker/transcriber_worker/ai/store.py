"""Persistência local (SQLite) do conhecimento — modo fallback.

Implementa as abstrações do ai-core sem serviço externo: repositório de
documentos/chunks/fontes, busca textual e um índice vetorial local com
similaridade de cosseno. O PostgreSQL + pgvector é o caminho de produção; o
SQLite garante histórico, transcrição, análise e conhecimento mesmo sem banco.
"""

from __future__ import annotations

import json
import math
import sqlite3
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

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

from transcriber_worker.ai.records import (
    chunk_from,
    document_from,
    like_pattern,
    metadata_from,
    source_from,
)

_SCHEMA_V1 = """
CREATE TABLE IF NOT EXISTS sources (
    id TEXT PRIMARY KEY,
    evidence_id TEXT,
    type TEXT NOT NULL,
    location TEXT,
    title TEXT,
    metadata TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    source_id TEXT,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_documents_workspace ON documents(workspace_id);
CREATE TABLE IF NOT EXISTS chunks (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    content TEXT NOT NULL,
    position INTEGER NOT NULL,
    metadata TEXT NOT NULL DEFAULT '{}',
    embedding_reference TEXT
);
CREATE INDEX IF NOT EXISTS idx_chunks_document ON chunks(document_id, workspace_id);
CREATE TABLE IF NOT EXISTS vectors (
    workspace_id TEXT NOT NULL,
    chunk_id TEXT NOT NULL,
    vector TEXT NOT NULL,
    metadata TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (workspace_id, chunk_id)
);
CREATE TABLE IF NOT EXISTS analysis (
    workspace_id TEXT NOT NULL,
    transcription_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    payload TEXT NOT NULL,
    PRIMARY KEY (workspace_id, transcription_id)
);
CREATE TABLE IF NOT EXISTS entities (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    transcription_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    label TEXT NOT NULL,
    confidence REAL NOT NULL,
    payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_entities_lookup ON entities(workspace_id, kind);
"""

# Filas e estado da análise: sobrevivem a fechar o app (retomam na próxima abertura).
_SCHEMA_V2 = """
CREATE TABLE IF NOT EXISTS queue_items (
    queue TEXT NOT NULL,
    id TEXT NOT NULL,
    payload TEXT NOT NULL,
    PRIMARY KEY (queue, id)
);
CREATE TABLE IF NOT EXISTS ai_transcriptions (
    transcription_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    title TEXT NOT NULL,
    segments TEXT NOT NULL DEFAULT '[]',
    windows INTEGER NOT NULL DEFAULT 0,
    closed INTEGER NOT NULL DEFAULT 0,
    finalized INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS analysis_partials (
    transcription_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    start REAL NOT NULL,
    payload TEXT NOT NULL,
    PRIMARY KEY (transcription_id, item_id)
);
"""

# Modelo/dimensão de cada vetor: troca de modelo de embedding exige reindexação (CA18).
_SCHEMA_V3 = """
ALTER TABLE vectors ADD COLUMN embedding_model TEXT;
ALTER TABLE vectors ADD COLUMN embedding_dimension INTEGER;
CREATE INDEX IF NOT EXISTS idx_vectors_workspace ON vectors(workspace_id);
"""

_MIGRATIONS: tuple[str, ...] = (_SCHEMA_V1, _SCHEMA_V2, _SCHEMA_V3)
SCHEMA_VERSION = len(_MIGRATIONS)


def _migrate(connection: sqlite3.Connection) -> None:
    """Aplica, em ordem, as migrações que faltam (a versão fica em ``schema_version``)."""
    connection.execute("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)")
    row = connection.execute("SELECT version FROM schema_version").fetchone()
    current = 0 if row is None else int(row[0])
    for version, script in enumerate(_MIGRATIONS[current:], start=current + 1):
        for statement in filter(None, (part.strip() for part in script.split(";"))):
            try:
                connection.execute(statement)
            except sqlite3.OperationalError as exc:
                # Base criada antes do controle de versão já pode ter a coluna.
                if "duplicate column" not in str(exc):
                    raise
        connection.execute("DELETE FROM schema_version")
        connection.execute("INSERT INTO schema_version (version) VALUES (?)", (version,))


class SQLiteStore:
    """Conexão SQLite única, com lock e schema aplicado na criação."""

    def __init__(self, path: str = ":memory:") -> None:
        self._connection = sqlite3.connect(path, check_same_thread=False)
        self._connection.row_factory = sqlite3.Row
        self._lock = threading.RLock()
        with self._connection:
            _migrate(self._connection)

    @contextmanager
    def locked(self) -> Iterator[sqlite3.Connection]:
        """Lock + transação (commit no fim, rollback em erro)."""
        with self._lock, self._connection:
            yield self._connection

    def close(self) -> None:
        self._connection.close()


def create_sqlite_backend(
    path: str = ":memory:",
) -> tuple[SQLiteKnowledgeRepository, SQLiteVectorStore]:
    """Cria repositório e vector store compartilhando a mesma conexão."""
    store = SQLiteStore(path)
    return SQLiteKnowledgeRepository(store), SQLiteVectorStore(store)


class SQLiteKnowledgeRepository(KnowledgeRepository):
    """Repositório de conhecimento persistido em SQLite."""

    def __init__(self, store: SQLiteStore) -> None:
        self._store = store

    def add_source(self, source: Source) -> Source:
        with self._store.locked() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO sources (id, evidence_id, type, location, title, metadata)"
                " VALUES (?, ?, ?, ?, ?, ?)",
                (
                    source.id,
                    source.evidence_id,
                    str(source.type),
                    source.location,
                    source.title,
                    json.dumps(source.metadata),
                ),
            )
        return source

    def get_source(self, source_id: str) -> Source | None:
        with self._store.locked() as conn:
            row = conn.execute("SELECT * FROM sources WHERE id = ?", (source_id,)).fetchone()
        return source_from(dict(row)) if row is not None else None

    def add_document(self, document: KnowledgeDocument) -> KnowledgeDocument:
        with self._store.locked() as conn:
            existing = conn.execute(
                "SELECT workspace_id FROM documents WHERE id = ?", (document.id,)
            ).fetchone()
            if existing is not None and existing["workspace_id"] != document.workspace_id:
                raise WorkspaceMismatchError(
                    f"Documento '{document.id}' pertence a outro workspace."
                )
            conn.execute(
                "INSERT OR REPLACE INTO documents"
                " (id, workspace_id, source_id, title, content, metadata, created_at)"
                " VALUES (?, ?, ?, ?, ?, ?, ?)",
                (
                    document.id,
                    document.workspace_id,
                    document.source_id,
                    document.title,
                    document.content,
                    json.dumps(document.metadata),
                    document.created_at.isoformat(),
                ),
            )
        return document

    def get_document(self, document_id: str, *, workspace_id: str) -> KnowledgeDocument | None:
        with self._store.locked() as conn:
            row = conn.execute(
                "SELECT * FROM documents WHERE id = ? AND workspace_id = ?",
                (document_id, workspace_id),
            ).fetchone()
        return document_from(dict(row)) if row is not None else None

    def list_documents(self, workspace_id: str) -> list[KnowledgeDocument]:
        with self._store.locked() as conn:
            rows = conn.execute(
                "SELECT * FROM documents WHERE workspace_id = ?", (workspace_id,)
            ).fetchall()
        return [document_from(dict(row)) for row in rows]

    def delete_document(self, document_id: str, *, workspace_id: str) -> None:
        with self._store.locked() as conn:
            conn.execute(
                "DELETE FROM chunks WHERE document_id = ? AND workspace_id = ?",
                (document_id, workspace_id),
            )
            conn.execute(
                "DELETE FROM documents WHERE id = ? AND workspace_id = ?",
                (document_id, workspace_id),
            )

    def add_chunks(self, chunks: list[KnowledgeChunk]) -> None:
        with self._store.locked() as conn:
            for chunk in chunks:
                row = conn.execute(
                    "SELECT workspace_id FROM documents WHERE id = ?", (chunk.document_id,)
                ).fetchone()
                if row is not None and row["workspace_id"] != chunk.workspace_id:
                    raise WorkspaceMismatchError(
                        f"Chunk '{chunk.id}' e documento '{chunk.document_id}' em workspaces"
                        " diferentes."
                    )
            for chunk in chunks:
                conn.execute(
                    "INSERT OR REPLACE INTO chunks"
                    " (id, document_id, workspace_id, content, position, metadata,"
                    " embedding_reference) VALUES (?, ?, ?, ?, ?, ?, ?)",
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

    def get_chunks(self, document_id: str, *, workspace_id: str) -> list[KnowledgeChunk]:
        with self._store.locked() as conn:
            rows = conn.execute(
                "SELECT * FROM chunks WHERE document_id = ? AND workspace_id = ? ORDER BY position",
                (document_id, workspace_id),
            ).fetchall()
        return [chunk_from(dict(row)) for row in rows]

    def get_chunk(self, chunk_id: str, *, workspace_id: str) -> KnowledgeChunk | None:
        with self._store.locked() as conn:
            row = conn.execute(
                "SELECT * FROM chunks WHERE id = ? AND workspace_id = ?",
                (chunk_id, workspace_id),
            ).fetchone()
        return chunk_from(dict(row)) if row is not None else None

    def search_text(
        self, *, workspace_id: str, query: str, limit: int = 10
    ) -> list[KnowledgeChunk]:
        """Busca textual simples (LIKE) escopada ao workspace."""
        if limit <= 0:
            raise ConfigurationError("limit deve ser maior que zero.")
        pattern = like_pattern(query.strip().lower())
        with self._store.locked() as conn:
            rows = conn.execute(
                "SELECT * FROM chunks WHERE workspace_id = ? AND lower(content) LIKE ? ESCAPE '\\'"
                " ORDER BY position LIMIT ?",
                (workspace_id, pattern, limit),
            ).fetchall()
        return [chunk_from(dict(row)) for row in rows]


class SQLiteVectorStore(VectorStore):
    """Índice vetorial local persistido (vetores em JSON, cosseno em Python).

    Com ``embedding_model``, cada vetor guarda o modelo que o gerou: vetores de outro
    modelo no workspace exigem reindexação (não se comparam embeddings de modelos
    diferentes, mesmo com a mesma dimensão).
    """

    def __init__(self, store: SQLiteStore, *, embedding_model: str | None = None) -> None:
        self._store = store
        self._model = embedding_model

    def upsert(
        self,
        *,
        chunk_id: str,
        workspace_id: str,
        vector: list[float],
        metadata: dict[str, Any] | None = None,
    ) -> None:
        with self._store.locked() as conn:
            self._check_model(conn, workspace_id)
            self._check_dimension(conn, workspace_id, vector, ignore=chunk_id)
            conn.execute(
                "INSERT OR REPLACE INTO vectors"
                " (workspace_id, chunk_id, vector, metadata, embedding_model, embedding_dimension)"
                " VALUES (?, ?, ?, ?, ?, ?)",
                (
                    workspace_id,
                    chunk_id,
                    json.dumps(vector),
                    json.dumps(metadata or {}),
                    self._model,
                    len(vector),
                ),
            )

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
        filters = filters or {}
        with self._store.locked() as conn:
            self._check_model(conn, workspace_id)
            self._check_dimension(conn, workspace_id, vector)
            rows = conn.execute(
                "SELECT chunk_id, vector, metadata FROM vectors WHERE workspace_id = ?",
                (workspace_id,),
            ).fetchall()
        matches: list[VectorMatch] = []
        for row in rows:
            metadata = metadata_from(row["metadata"])
            if any(metadata.get(key) != value for key, value in filters.items()):
                continue
            stored = json.loads(row["vector"])
            matches.append(
                VectorMatch(
                    chunk_id=row["chunk_id"],
                    workspace_id=workspace_id,
                    score=_cosine(vector, stored),
                    metadata=metadata,
                )
            )
        matches.sort(key=lambda match: match.score, reverse=True)
        return matches[:limit]

    def delete(self, *, workspace_id: str, chunk_id: str) -> None:
        with self._store.locked() as conn:
            conn.execute(
                "DELETE FROM vectors WHERE workspace_id = ? AND chunk_id = ?",
                (workspace_id, chunk_id),
            )

    def delete_workspace(self, workspace_id: str) -> None:
        with self._store.locked() as conn:
            conn.execute("DELETE FROM vectors WHERE workspace_id = ?", (workspace_id,))

    def indexed_models(self, workspace_id: str) -> list[str]:
        """Modelos de embedding presentes no índice do workspace."""
        with self._store.locked() as conn:
            rows = conn.execute(
                "SELECT DISTINCT embedding_model FROM vectors"
                " WHERE workspace_id = ? AND embedding_model IS NOT NULL ORDER BY 1",
                (workspace_id,),
            ).fetchall()
        return [str(row[0]) for row in rows]

    def _check_model(self, conn: sqlite3.Connection, workspace_id: str) -> None:
        if self._model is None:
            return
        row = conn.execute(
            "SELECT embedding_model FROM vectors WHERE workspace_id = ?"
            " AND embedding_model IS NOT NULL AND embedding_model <> ? LIMIT 1",
            (workspace_id, self._model),
        ).fetchone()
        if row is not None:
            raise ConfigurationError(
                f"O índice do workspace '{workspace_id}' foi gerado com o modelo "
                f"'{row[0]}', não '{self._model}'. Reindexe o conhecimento."
            )

    @staticmethod
    def _check_dimension(
        conn: sqlite3.Connection,
        workspace_id: str,
        vector: list[float],
        *,
        ignore: str | None = None,
    ) -> None:
        """Compara com um vetor já indexado (uma linha basta: todos têm a mesma dimensão)."""
        if not vector:
            raise ConfigurationError("Vetor vazio não pode ser indexado nem consultado.")
        row = conn.execute(
            "SELECT embedding_dimension, vector FROM vectors"
            " WHERE workspace_id = ? AND chunk_id <> ? LIMIT 1",
            (workspace_id, ignore or ""),
        ).fetchone()
        if row is None:
            return
        indexed = row["embedding_dimension"] or len(json.loads(row["vector"]))
        if indexed != len(vector):
            raise ConfigurationError(
                f"Dimensão {len(vector)} difere da dimensão indexada ({indexed}) no "
                f"workspace '{workspace_id}'. O modelo de embedding mudou? Reindexe."
            )


def _cosine(left: list[float], right: list[float]) -> float:
    norm_left = math.sqrt(sum(a * a for a in left))
    norm_right = math.sqrt(sum(b * b for b in right))
    if norm_left == 0.0 or norm_right == 0.0:
        return 0.0
    return sum(a * b for a, b in zip(left, right, strict=True)) / (norm_left * norm_right)
