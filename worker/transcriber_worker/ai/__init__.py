"""Camada de IA local do worker (análise incremental via Ollama).

Nada aqui depende de cloud. Com a IA desligada, nenhum comportamento de
transcrição é alterado.
"""

from __future__ import annotations

from transcriber_worker.ai.analyzer import (
    SYSTEM_PROMPT,
    AnalysisError,
    IncrementalAnalyzer,
    build_analysis_prompt,
    parse_analysis_result,
)
from transcriber_worker.ai.answer import GROUNDING_PROMPT, AnswerResult, KnowledgeAnswer
from transcriber_worker.ai.backup import (
    BackupDocument,
    KnowledgeBackup,
    RestoreReport,
    export_workspace,
    read_backup,
    restore_workspace,
    write_backup,
)
from transcriber_worker.ai.config import AiConfig
from transcriber_worker.ai.consolidation import consolidate_results
from transcriber_worker.ai.diagnostics import DiagnosticCheck, run_diagnostics
from transcriber_worker.ai.entities import (
    AnalysisResult,
    Decision,
    DetectedTask,
    Person,
    Problem,
    Question,
    SegmentRef,
    Topic,
)
from transcriber_worker.ai.final import FinalAnalyzer
from transcriber_worker.ai.indexing import (
    Indexer,
    IndexItem,
    IndexOutcome,
    IndexQueue,
    IndexStatus,
    SegmentChunk,
    build_segment_chunks,
)
from transcriber_worker.ai.ollama import (
    OllamaClient,
    OllamaEmbeddingProvider,
    OllamaError,
    OllamaLLMProvider,
)
from transcriber_worker.ai.postgres import (
    HealthReport,
    PostgresConfig,
    PostgresKnowledgeRepository,
    PostgresUnavailableError,
    PostgresVectorStore,
    health_check,
    open_postgres,
    run_migrations,
)
from transcriber_worker.ai.provision import (
    ContainerRuntime,
    detect_container_runtime,
    find_free_port,
    postgres_container_command,
)
from transcriber_worker.ai.queue import AnalysisItem, AnalysisQueue, AnalysisStatus
from transcriber_worker.ai.rag import KnowledgeQuery
from transcriber_worker.ai.runtime import AiRuntime
from transcriber_worker.ai.service import AnalysisService
from transcriber_worker.ai.storage import (
    StorageBackend,
    StorageConfig,
    StorageMode,
    build_storage,
    postgres_storage,
    sqlite_storage,
)
from transcriber_worker.ai.store import (
    SQLiteKnowledgeRepository,
    SQLiteStore,
    SQLiteVectorStore,
    create_sqlite_backend,
)
from transcriber_worker.ai.windows import SegmentInput, SegmentWindow, build_windows

__all__ = [
    "GROUNDING_PROMPT",
    "SYSTEM_PROMPT",
    "AiConfig",
    "AiRuntime",
    "AnalysisError",
    "AnalysisItem",
    "AnalysisQueue",
    "AnalysisResult",
    "AnalysisService",
    "AnalysisStatus",
    "AnswerResult",
    "BackupDocument",
    "ContainerRuntime",
    "Decision",
    "DetectedTask",
    "DiagnosticCheck",
    "FinalAnalyzer",
    "HealthReport",
    "IncrementalAnalyzer",
    "IndexItem",
    "IndexOutcome",
    "IndexQueue",
    "IndexStatus",
    "Indexer",
    "KnowledgeAnswer",
    "KnowledgeBackup",
    "KnowledgeQuery",
    "OllamaClient",
    "OllamaEmbeddingProvider",
    "OllamaError",
    "OllamaLLMProvider",
    "Person",
    "PostgresConfig",
    "PostgresKnowledgeRepository",
    "PostgresUnavailableError",
    "PostgresVectorStore",
    "Problem",
    "Question",
    "RestoreReport",
    "SQLiteKnowledgeRepository",
    "SQLiteStore",
    "SQLiteVectorStore",
    "SegmentChunk",
    "SegmentInput",
    "SegmentRef",
    "SegmentWindow",
    "StorageBackend",
    "StorageConfig",
    "StorageMode",
    "Topic",
    "build_analysis_prompt",
    "build_segment_chunks",
    "build_storage",
    "build_windows",
    "consolidate_results",
    "create_sqlite_backend",
    "detect_container_runtime",
    "export_workspace",
    "find_free_port",
    "health_check",
    "open_postgres",
    "parse_analysis_result",
    "postgres_container_command",
    "postgres_storage",
    "read_backup",
    "restore_workspace",
    "run_diagnostics",
    "run_migrations",
    "sqlite_storage",
    "write_backup",
]
