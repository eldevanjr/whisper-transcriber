import threading

from transcriber_worker.events import Event
from transcriber_worker.protocol import Command, ShutdownCommand
from transcriber_worker.worker import serve


class HandlerSpy:
    def __init__(self) -> None:
        self.commands: list[Command] = []

    def handle(self, command: Command) -> bool:
        self.commands.append(command)
        return not isinstance(command, ShutdownCommand)


def test_emits_ready_then_handles_until_shutdown() -> None:
    events: list[Event] = []
    handler = HandlerSpy()
    lines = [
        '{"id":"1","cmd":"self_test"}\n',
        '{"id":"2","cmd":"shutdown"}\n',
        '{"id":"3","cmd":"self_test"}\n',
    ]
    assert serve(lines, events.append, handler, version="9.9.9") == 0
    assert events[0] == {"type": "ready", "protocol": 4, "version": "9.9.9"}
    assert [c.id for c in handler.commands] == ["1", "2"]


def test_ignores_blank_lines() -> None:
    handler = HandlerSpy()
    serve(["\n", "   \n", '{"id":"1","cmd":"self_test"}\n'], lambda _: None, handler)
    assert len(handler.commands) == 1


def test_invalid_line_reports_error_and_keeps_serving() -> None:
    events: list[Event] = []
    handler = HandlerSpy()
    lines = ['{"id":"7","cmd":"rm_rf"}\n', "lixo\n", '{"id":"8","cmd":"self_test"}\n']
    serve(lines, events.append, handler)
    errors = [e for e in events if e["type"] == "error"]
    assert [(e["code"], e.get("id")) for e in errors] == [
        ("INVALID_MESSAGE", "7"),
        ("INVALID_MESSAGE", None),
    ]
    assert [c.id for c in handler.commands] == ["8"]


def test_end_of_input_without_shutdown_returns_zero() -> None:
    assert serve([], lambda _: None, HandlerSpy()) == 0


class SlowHandler:
    """``self_test`` 1 fica preso até o 2 terminar: só passa se rodarem em paralelo."""

    def __init__(self) -> None:
        self.second_done = threading.Event()
        self.order: list[str] = []

    def handle(self, command: Command) -> bool:
        if command.id == "1":
            assert self.second_done.wait(5.0)
        if command.id == "2":
            self.second_done.set()
        self.order.append(command.id)
        return not isinstance(command, ShutdownCommand)


def test_concurrent_serve_does_not_block_on_slow_commands() -> None:
    handler = SlowHandler()
    lines = ['{"id":"1","cmd":"self_test"}\n', '{"id":"2","cmd":"self_test"}\n']
    assert serve(lines, lambda _event: None, handler, concurrent=True) == 0
    assert handler.order == ["2", "1"]


def test_concurrent_serve_handles_shutdown_inline() -> None:
    handler = HandlerSpy()
    lines = ['{"id":"1","cmd":"shutdown"}\n', '{"id":"2","cmd":"self_test"}\n']
    serve(lines, lambda _event: None, handler, concurrent=True)
    assert [c.id for c in handler.commands] == ["1"]


def test_concurrent_serve_reports_invalid_lines() -> None:
    events: list[Event] = []
    serve(["lixo\n"], events.append, HandlerSpy(), concurrent=True)
    assert [event["type"] for event in events] == ["ready", "error"]


def test_concurrent_serve_ignores_blank_lines() -> None:
    handler = HandlerSpy()
    serve(["\n", '{"id":"1","cmd":"self_test"}\n'], lambda _event: None, handler, concurrent=True)
    assert [c.id for c in handler.commands] == ["1"]
