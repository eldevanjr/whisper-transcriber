"""Ponto de entrada: `transcriber-worker` (modo worker) ou `transcriber-worker cli ...`."""

import io
import os
import sys
from collections.abc import Sequence
from typing import TextIO

from transcriber_worker import cli
from transcriber_worker.commands import Dispatcher
from transcriber_worker.engine import Engine
from transcriber_worker.heartbeat import Heartbeat
from transcriber_worker.protocol import EventWriter
from transcriber_worker.worker import serve


def main(argv: Sequence[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if args[:1] == ["cli"]:
        return cli.run(args[1:])
    return run_worker(sys.stdin, sys.stdout)


def run_worker(stdin: TextIO, stdout: TextIO) -> int:
    _force_utf8(stdin)
    protocol = _protocol_stream(stdout)
    writer = EventWriter(protocol)
    previous_stdout, sys.stdout = sys.stdout, sys.stderr
    heartbeat = Heartbeat(writer.emit)
    heartbeat.start()
    try:
        return serve(stdin, writer.emit, Dispatcher(Engine(), writer.emit))
    finally:
        heartbeat.stop()
        sys.stdout = previous_stdout
        protocol.close()


def _force_utf8(stream: TextIO) -> None:
    """O app sempre envia UTF-8; no Windows o stdin padrão seria cp1252.

    Bytes inválidos viram U+FFFD: a linha é rejeitada como INVALID_MESSAGE e o worker segue.
    """
    if isinstance(stream, io.TextIOWrapper):
        stream.reconfigure(encoding="utf-8", errors="replace")


def _protocol_stream(stdout: TextIO) -> TextIO:
    """Reserva o stdout real para o protocolo e aponta o fd 1 para o stderr.

    Assim, qualquer escrita nativa (printf de bibliotecas C) ou print perdido vai para o log
    e nunca corrompe as linhas JSON que o app lê.
    """
    stdout.flush()
    protocol_fd = os.dup(stdout.fileno())
    os.dup2(sys.stderr.fileno(), stdout.fileno())
    return os.fdopen(protocol_fd, "w", encoding="utf-8", buffering=1)


if __name__ == "__main__":
    sys.exit(main())
