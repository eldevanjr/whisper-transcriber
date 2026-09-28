"""Provisionamento de PostgreSQL + pgvector local em container (Docker/Podman).

O container expõe o banco só em ``127.0.0.1``, numa porta livre (não assume 5432),
com usuário e banco dedicados e dados num volume persistente. A senha é gerada
pelo app (cofre do sistema) e passa ao runtime pelo ambiente do processo — nunca
pela linha de comando, que aparece em ``ps``/``docker inspect`` e em mensagens de
erro. Um container já de pé é reaproveitado.
"""

from __future__ import annotations

import os
import shutil
import socket
import subprocess
from collections.abc import Callable, Mapping, Sequence
from enum import StrEnum
from typing import Protocol

from transcriber_worker.ai.postgres import PostgresUnavailableError, redact

CONTAINER_NAME = "whisper-transcriber-postgres"
DATABASE_NAME = "whisper"
DATABASE_USER = "whisper"
_COMMAND_TIMEOUT_SECONDS = 300  # a primeira execução baixa a imagem


class ContainerRuntime(StrEnum):
    """Runtime de containers disponível na máquina."""

    DOCKER = "docker"
    PODMAN = "podman"
    NONE = "none"


Which = Callable[[str], str | None]


class CommandResult(Protocol):
    returncode: int
    stdout: str
    stderr: str


Runner = Callable[[Sequence[str], Mapping[str, str] | None], CommandResult]


def run_command(
    command: Sequence[str], env: Mapping[str, str] | None = None
) -> subprocess.CompletedProcess[str]:
    """Roda o comando; ``env`` é somado ao ambiente atual. Binário ausente vira falha."""
    try:
        return subprocess.run(  # noqa: S603 - comando montado aqui, sem shell
            list(command),
            capture_output=True,
            text=True,
            check=False,
            timeout=_COMMAND_TIMEOUT_SECONDS,
            env={**os.environ, **env} if env else None,
        )
    except OSError as exc:
        return subprocess.CompletedProcess(list(command), 127, "", str(exc))


def detect_container_runtime(*, which: Which = shutil.which) -> ContainerRuntime:
    """Prefere docker; usa podman como alternativa; ``NONE`` se nenhum existir."""
    if which("docker"):
        return ContainerRuntime.DOCKER
    if which("podman"):
        return ContainerRuntime.PODMAN
    return ContainerRuntime.NONE


def find_free_port(*, host: str = "127.0.0.1") -> int:
    """Retorna uma porta TCP livre no host informado (não assume 5432)."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind((host, 0))
        return int(sock.getsockname()[1])


def postgres_container_command(
    *,
    runtime: ContainerRuntime,
    port: int,
    volume: str,
    image: str,
    name: str = CONTAINER_NAME,
) -> list[str]:
    """Comando para subir PostgreSQL com pgvector, exposto apenas em localhost.

    ``-e POSTGRES_PASSWORD`` sem valor: o runtime lê a senha do próprio ambiente.
    """
    if runtime is ContainerRuntime.NONE:
        raise ValueError("Nenhum runtime de containers disponível.")
    return [
        runtime.value,
        "run",
        "--rm",
        "-d",
        "--name",
        name,
        "-p",
        f"127.0.0.1:{port}:5432",
        "-e",
        "POSTGRES_PASSWORD",
        "-e",
        f"POSTGRES_USER={DATABASE_USER}",
        "-e",
        f"POSTGRES_DB={DATABASE_NAME}",
        "-v",
        f"{volume}:/var/lib/postgresql/data",
        image,
    ]


def _parse_port(output: str) -> int | None:
    for line in output.splitlines():
        _host, separator, port = line.strip().rpartition(":")
        if separator and port.isdigit():
            return int(port)
    return None


class LocalPostgres:
    """O container do app: descobre se está de pé, sobe e para."""

    def __init__(
        self,
        runtime: ContainerRuntime,
        *,
        run: Runner = run_command,
        port_finder: Callable[[], int] = find_free_port,
        name: str = CONTAINER_NAME,
    ) -> None:
        self._runtime = runtime
        self._run = run
        self._port_finder = port_finder
        self._name = name

    def running_port(self) -> int | None:
        """Porta local do container em execução (``None`` se não estiver rodando)."""
        result = self._run([self._runtime.value, "port", self._name, "5432/tcp"], None)
        return _parse_port(result.stdout) if result.returncode == 0 else None

    def start(self, *, volume: str, password: str, image: str) -> int:
        """Reaproveita o container de pé ou sobe um novo; devolve a porta local."""
        port = self.running_port()
        if port is not None:
            return port
        # Resto de um container parado (sem --rm) impediria reutilizar o nome.
        self._run([self._runtime.value, "rm", "-f", self._name], None)
        port = self._port_finder()
        command = postgres_container_command(
            runtime=self._runtime, port=port, volume=volume, image=image, name=self._name
        )
        result = self._run(command, {"POSTGRES_PASSWORD": password})
        if result.returncode != 0:
            detail = redact((result.stderr or result.stdout).strip(), [password])
            raise PostgresUnavailableError(f"Não foi possível iniciar o PostgreSQL local: {detail}")
        return port

    def stop(self) -> None:
        self._run([self._runtime.value, "stop", self._name], None)
