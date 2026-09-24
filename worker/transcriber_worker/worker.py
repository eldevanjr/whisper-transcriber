"""Loop principal: lê comandos (uma linha JSON cada) e delega ao dispatcher."""

from collections.abc import Iterable
from typing import Protocol

from transcriber_worker import __version__
from transcriber_worker.errors import WorkerError
from transcriber_worker.events import Emit, error_event, ready_event
from transcriber_worker.protocol import Command, parse_command, peek_command_id


class CommandHandler(Protocol):
    def handle(self, command: Command) -> bool: ...


def serve(
    lines: Iterable[str], emit: Emit, handler: CommandHandler, version: str = __version__
) -> int:
    emit(ready_event(version))
    for line in lines:
        if line.strip() and not _process(line, emit, handler):
            break
    return 0


def _process(line: str, emit: Emit, handler: CommandHandler) -> bool:
    try:
        command = parse_command(line)
    except WorkerError as error:
        emit(error_event(error, command_id=peek_command_id(line)))
        return True
    return handler.handle(command)
