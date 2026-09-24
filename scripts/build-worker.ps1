# Empacota o worker com PyInstaller (onedir) e copia para app\resources\worker\.
# $env:WHISPERCPP_WHEEL troca o pywhispercpp do PyPI pelo compilado com Vulkan (build-whispercpp).
$ErrorActionPreference = "Stop"
$Root = Resolve-Path "$PSScriptRoot\.."
# Absoluto: o uv roda dentro de worker\.
$Wheel = if ($env:WHISPERCPP_WHEEL) { (Resolve-Path $env:WHISPERCPP_WHEEL).Path } else { $null }
Push-Location "$Root\worker"
try {
  # --frozen: o CI grava a versão do release no pyproject; o lock (dependências) segue o mesmo.
  uv sync --frozen --group build
  if ($LASTEXITCODE -ne 0) { throw "uv sync falhou" }
  if ($Wheel) {
    uv pip install --reinstall-package pywhispercpp $Wheel
    if ($LASTEXITCODE -ne 0) { throw "falha ao instalar o wheel do whisper.cpp" }
  }
  uv run --no-sync pyinstaller --noconfirm --clean transcriber_worker.spec --distpath build\dist --workpath build\work
  if ($LASTEXITCODE -ne 0) { throw "PyInstaller falhou" }
} finally { Pop-Location }
$Target = "$Root\app\resources\worker"
if (Test-Path $Target) { Remove-Item -Recurse -Force $Target }
Copy-Item -Recurse "$Root\worker\build\dist\transcriber-worker" $Target
Write-Output "worker empacotado em app\resources\worker"
