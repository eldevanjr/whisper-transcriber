"""Loop principal: lê comandos (uma linha JSON cada) e delega ao dispatcher.

No processo de IA (``concurrent=True``) cada comando roda numa thread do pool:
uma pergunta ao RAG não espera o download de um modelo, e vice-versa. O
``shutdown`` é sempre tratado na própria thread do loop.
"""

from collections.abc import Iterable
from concurrent.futures import ThreadPoolExecutor
from typing import Protocol

from transcriber_worker import __version__
from transcriber_worker.errors import WorkerError
from transcriber_worker.events import Emit, error_event, ready_event
from transcriber_worker.protocol import Command, parse_command, peek_command_id

MAX_CONCURRENT_COMMANDS = 8


class CommandHandler(Protocol):
    def handle(self, command: Command) -> bool: ...


def serve(
    lines: Iterable[str],
    emit: Emit,
    handler: CommandHandler,
    version: str = __version__,
    *,
    concurrent: bool = False,
) -> int:
    emit(ready_event(version))
    if not concurrent:
        for line in lines:
            if line.strip() and not _process(line, emit, handler):
                break
        return 0
    with ThreadPoolExecutor(MAX_CONCURRENT_COMMANDS, thread_name_prefix="command") as pool:
        for line in lines:
            if not line.strip():
                continue
            command = _parse(line, emit)
            if command is None:
                continue
            if command.cmd == "shutdown":
                handler.handle(command)
                break
            pool.submit(handler.handle, command)
    return 0


def _parse(line: str, emit: Emit) -> Command | None:
    try:
        return parse_command(line)
    except WorkerError as error:
        emit(error_event(error, command_id=peek_command_id(line)))
        return None


def _process(line: str, emit: Emit, handler: CommandHandler) -> bool:
    command = _parse(line, emit)
    return True if command is None else handler.handle(command)
