from __future__ import annotations

import subprocess
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field

import pytest

from transcriber_worker.ai.postgres import PostgresUnavailableError
from transcriber_worker.ai.provision import (
    CONTAINER_NAME,
    DATABASE_NAME,
    DATABASE_USER,
    ContainerRuntime,
    LocalPostgres,
    detect_container_runtime,
    find_free_port,
    postgres_container_command,
    run_command,
)


def _which(available: set[str]) -> object:
    return lambda name: f"/usr/bin/{name}" if name in available else None


def test_detect_container_runtime_prefers_docker() -> None:
    assert detect_container_runtime(which=_which({"docker", "podman"})) is ContainerRuntime.DOCKER  # type: ignore[arg-type]


def test_detect_container_runtime_falls_back_to_podman() -> None:
    assert detect_container_runtime(which=_which({"podman"})) is ContainerRuntime.PODMAN  # type: ignore[arg-type]


def test_detect_container_runtime_none() -> None:
    assert detect_container_runtime(which=_which(set())) is ContainerRuntime.NONE  # type: ignore[arg-type]


def test_find_free_port() -> None:
    port = find_free_port()
    assert 0 < port < 65536


def test_container_command_keeps_password_out_of_argv() -> None:
    command = postgres_container_command(
        runtime=ContainerRuntime.DOCKER, port=15432, volume="dados", image="pgvector/pgvector:pg16"
    )
    assert command[:4] == ["docker", "run", "--rm", "-d"]
    assert "127.0.0.1:15432:5432" in command
    assert "POSTGRES_PASSWORD" in command  # só o nome: o valor vem do ambiente
    assert not any(part.startswith("POSTGRES_PASSWORD=") for part in command)
    assert f"POSTGRES_USER={DATABASE_USER}" in command
    assert f"POSTGRES_DB={DATABASE_NAME}" in command
    assert "dados:/var/lib/postgresql/data" in command
    assert command[-1] == "pgvector/pgvector:pg16"


def test_container_command_without_runtime() -> None:
    with pytest.raises(ValueError, match="runtime"):
        postgres_container_command(runtime=ContainerRuntime.NONE, port=1, volume="v", image="i")


@dataclass
class Result:
    returncode: int = 0
    stdout: str = ""
    stderr: str = ""


@dataclass
class FakeRunner:
    """Responde por subcomando (``port``, ``rm``, ``run``, ``stop``)."""

    responses: dict[str, Result] = field(default_factory=dict)
    calls: list[tuple[list[str], dict[str, str] | None]] = field(default_factory=list)

    def __call__(self, command: Sequence[str], env: Mapping[str, str] | None = None) -> Result:
        self.calls.append((list(command), dict(env) if env is not None else None))
        return self.responses.get(command[1], Result())

    def subcommands(self) -> list[str]:
        return [command[1] for command, _env in self.calls]


def _local(runner: FakeRunner) -> LocalPostgres:
    return LocalPostgres(ContainerRuntime.DOCKER, run=runner, port_finder=lambda: 15432)


def test_reuses_running_container() -> None:
    runner = FakeRunner({"port": Result(stdout="127.0.0.1:40001\n[::1]:40001\n")})
    assert _local(runner).running_port() == 40001
    port = _local(runner).start(volume="v", password="s", image="i")  # noqa: S106
    assert port == 40001
    assert "run" not in runner.subcommands()


def test_starts_a_new_container_with_password_in_environment() -> None:
    runner = FakeRunner({"port": Result(returncode=1, stderr="No such container")})
    port = _local(runner).start(volume="v", password="segredo", image="img")  # noqa: S106
    assert port == 15432
    assert runner.subcommands() == ["port", "rm", "run"]
    run_command_, env = runner.calls[-1]
    assert env == {"POSTGRES_PASSWORD": "segredo"}
    assert "segredo" not in " ".join(run_command_)
    assert CONTAINER_NAME in run_command_


def test_port_output_without_mapping_counts_as_stopped() -> None:
    runner = FakeRunner({"port": Result(stdout="nada\n")})
    assert _local(runner).running_port() is None


def test_start_failure_hides_password() -> None:
    runner = FakeRunner(
        {
            "port": Result(returncode=1),
            "run": Result(returncode=125, stderr="erro com segredo no texto"),
        }
    )
    with pytest.raises(PostgresUnavailableError) as caught:
        _local(runner).start(volume="v", password="segredo", image="i")  # noqa: S106
    assert "segredo" not in str(caught.value)


def test_stop_container() -> None:
    runner = FakeRunner()
    _local(runner).stop()
    assert runner.calls[0][0] == ["docker", "stop", CONTAINER_NAME]


def test_run_command_merges_environment() -> None:
    result = run_command(["env"], {"WT_TEST_VAR": "1"})
    assert isinstance(result, subprocess.CompletedProcess)
    assert "WT_TEST_VAR=1" in result.stdout
    assert run_command(["true"]).returncode == 0


def test_run_command_missing_binary_is_a_failed_result() -> None:
    result = run_command(["programa-que-nao-existe-wt"])
    assert result.returncode != 0
