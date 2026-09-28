from __future__ import annotations

import pytest

from transcriber_worker.errors import WorkerError
from transcriber_worker.protocol import (
    AiDiagnoseCommand,
    AiPullModelCommand,
    AiStatusCommand,
    AnalysisAppendCommand,
    AnalysisFinalizeCommand,
    AnalysisGetCommand,
    AnalysisProcessCommand,
    AnalysisRetryCommand,
    AnalysisSubmitCommand,
    ConfigureAiCommand,
    KnowledgeAskCommand,
    KnowledgeBackupCommand,
    KnowledgeDeleteCommand,
    KnowledgeReindexCancelCommand,
    KnowledgeReindexCommand,
    KnowledgeRestoreCommand,
    KnowledgeSearchCommand,
    KnowledgeSearchEntitiesCommand,
    parse_command,
)


def test_parse_configure_ai_with_storage() -> None:
    command = parse_command(
        '{"id":"1","cmd":"configure_ai","params":{"enabled":true,'
        '"storage":{"mode":"external","postgres":{"password":"x"}}}}'
    )
    assert isinstance(command, ConfigureAiCommand)
    assert command.params.storage is not None
    assert command.params.storage.mode == "external"
    assert command.params.storage.postgres is not None
    assert command.params.storage.postgres.password == "x"  # noqa: S105


def test_parse_configure_ai() -> None:
    command = parse_command(
        '{"id":"1","cmd":"configure_ai","params":{"enabled":true,"llm_model":"m"}}'
    )
    assert isinstance(command, ConfigureAiCommand)
    assert command.params.enabled is True
    assert command.params.llm_model == "m"
    assert command.params.database_path == ":memory:"


def test_parse_analysis_submit() -> None:
    command = parse_command(
        '{"id":"2","cmd":"analysis_submit","params":{"transcription_id":"t","workspace_id":"ws",'
        '"title":"Reunião","segments":[{"index":0,"start":0,"end":1,"text":"oi"}]}}'
    )
    assert isinstance(command, AnalysisSubmitCommand)
    assert command.params.segments[0].text == "oi"


def test_parse_analysis_process_defaults() -> None:
    command = parse_command('{"id":"3","cmd":"analysis_process","params":{}}')
    assert isinstance(command, AnalysisProcessCommand)
    assert command.params.max_items == 100


def test_parse_analysis_finalize() -> None:
    command = parse_command(
        '{"id":"4","cmd":"analysis_finalize","params":{"transcription_id":"t","workspace_id":"ws"}}'
    )
    assert isinstance(command, AnalysisFinalizeCommand)


def test_parse_knowledge_search() -> None:
    command = parse_command(
        '{"id":"5","cmd":"knowledge_search","params":{"workspace_id":"ws","query":"q"}}'
    )
    assert isinstance(command, KnowledgeSearchCommand)
    assert command.params.limit == 10


def test_parse_knowledge_reindex() -> None:
    command = parse_command('{"id":"6","cmd":"knowledge_reindex","params":{"workspace_id":"ws"}}')
    assert isinstance(command, KnowledgeReindexCommand)


def test_parse_knowledge_delete() -> None:
    command = parse_command(
        '{"id":"7","cmd":"knowledge_delete","params":{"workspace_id":"ws","transcription_id":"t"}}'
    )
    assert isinstance(command, KnowledgeDeleteCommand)


def test_parse_knowledge_backup_and_restore() -> None:
    backup = parse_command(
        '{"id":"10","cmd":"knowledge_backup","params":{"workspace_id":"ws","path":"/tmp/b.json"}}'
    )
    assert isinstance(backup, KnowledgeBackupCommand)
    restore = parse_command('{"id":"11","cmd":"knowledge_restore","params":{"path":"/tmp/b.json"}}')
    assert isinstance(restore, KnowledgeRestoreCommand)
    assert restore.params.workspace_id is None


def test_parse_ai_status() -> None:
    assert isinstance(parse_command('{"id":"8","cmd":"ai_status"}'), AiStatusCommand)


def test_parse_ai_pull_model() -> None:
    command = parse_command('{"id":"15","cmd":"ai_pull_model","params":{"model":"qwen3:8b"}}')
    assert isinstance(command, AiPullModelCommand)
    assert command.params.model == "qwen3:8b"


def test_parse_analysis_get_and_search_entities() -> None:
    get = parse_command(
        '{"id":"12","cmd":"analysis_get","params":{"workspace_id":"ws","transcription_id":"t"}}'
    )
    assert isinstance(get, AnalysisGetCommand)
    search = parse_command(
        '{"id":"13","cmd":"knowledge_search_entities",'
        '"params":{"workspace_id":"ws","kind":"topic","query":"sync"}}'
    )
    assert isinstance(search, KnowledgeSearchEntitiesCommand)
    assert search.params.limit == 20


def test_parse_knowledge_ask() -> None:
    command = parse_command(
        '{"id":"14","cmd":"knowledge_ask","params":{"workspace_id":"ws","question":"o que?"}}'
    )
    assert isinstance(command, KnowledgeAskCommand)
    assert command.params.limit == 5


@pytest.mark.parametrize(
    "line",
    [
        '{"id":"9","cmd":"analysis_submit","params":{"transcription_id":"t","workspace_id":"ws",'
        '"title":"r","segments":[]}}',
        '{"id":"9","cmd":"knowledge_search","params":{"workspace_id":"ws","query":"q","limit":0}}',
    ],
)
def test_invalid_ai_commands_are_rejected(line: str) -> None:
    with pytest.raises(WorkerError):
        parse_command(line)


def test_parse_ai_diagnose() -> None:
    assert isinstance(parse_command('{"id":"12","cmd":"ai_diagnose"}'), AiDiagnoseCommand)


def test_parse_ai_status_with_workspace() -> None:
    command = parse_command('{"id":"9","cmd":"ai_status","params":{"workspace_id":"ws"}}')
    assert isinstance(command, AiStatusCommand)
    assert command.params is not None
    assert command.params.workspace_id == "ws"


def test_parse_analysis_append() -> None:
    command = parse_command(
        '{"id":"1","cmd":"analysis_append","params":{"transcription_id":"t",'
        '"workspace_id":"ws","title":"R","segments":[{"index":0,"start":0,"end":1,"text":"x"}]}}'
    )
    assert isinstance(command, AnalysisAppendCommand)


def test_parse_analysis_retry_all_or_one() -> None:
    every = parse_command('{"id":"1","cmd":"analysis_retry","params":{}}')
    assert isinstance(every, AnalysisRetryCommand)
    assert every.params.transcription_id is None
    one = parse_command('{"id":"1","cmd":"analysis_retry","params":{"transcription_id":"t"}}')
    assert isinstance(one, AnalysisRetryCommand)
    assert one.params.transcription_id == "t"


def test_parse_reindex_cancel() -> None:
    command = parse_command(
        '{"id":"1","cmd":"knowledge_reindex_cancel","params":{"workspace_id":"ws"}}'
    )
    assert isinstance(command, KnowledgeReindexCancelCommand)


def test_configure_accepts_auto_storage_and_remote_flag() -> None:
    command = parse_command(
        '{"id":"1","cmd":"configure_ai","params":{"allow_remote_ollama":true,'
        '"storage":{"mode":"auto"}}}'
    )
    assert isinstance(command, ConfigureAiCommand)
    assert command.params.allow_remote_ollama is True
    assert command.params.storage is not None
    assert command.params.storage.mode == "auto"
