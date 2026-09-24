import subprocess
import sys
import tomllib
from pathlib import Path

from packaging.version import Version

import transcriber_worker


def test_version_matches_pyproject() -> None:
    pyproject = Path(__file__).parents[1] / "pyproject.toml"
    data = tomllib.loads(pyproject.read_text(encoding="utf-8"))
    # __version__ segue o app (SemVer, ex.: 0.0.0-dev); o pyproject usa PEP 440 (0.0.0.dev0).
    assert Version(transcriber_worker.__version__) == Version(data["project"]["version"])


def test_protocol_version_is_two() -> None:
    assert transcriber_worker.PROTOCOL_VERSION == 2


def test_package_is_installed_outside_project_dir(tmp_path: Path) -> None:
    # Garante que o pacote está instalado de verdade (o app chama o worker de fora de worker/).
    result = subprocess.run(
        [sys.executable, "-c", "import transcriber_worker"],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
