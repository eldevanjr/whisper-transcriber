# Compila o wheel do pywhispercpp com Vulkan no Windows (precisa do Vulkan SDK em $env:VULKAN_SDK).
# Estático: um único módulo nativo, fácil de empacotar com o PyInstaller.
# Uso: scripts/build-whispercpp.ps1 [-Out dist\whispercpp]
param([string]$Out = "$PSScriptRoot\..\dist\whispercpp")
$ErrorActionPreference = "Stop"
$Version = "1.5.1"
if (-not $env:VULKAN_SDK) { throw "Defina VULKAN_SDK (instale o Vulkan SDK da LunarG)" }
$env:PATH = "$env:VULKAN_SDK\Bin;$env:PATH"
$env:GGML_VULKAN = "1"
# Sem -march=native: o binário roda em qualquer x64 com AVX2 (não herda o AVX-512 do runner).
$env:CMAKE_ARGS = "-DGGML_VULKAN=ON -DBUILD_SHARED_LIBS=OFF -DCMAKE_POSITION_INDEPENDENT_CODE=ON " +
  "-DGGML_NATIVE=OFF -DGGML_AVX=ON -DGGML_AVX2=ON -DGGML_FMA=ON -DGGML_F16C=ON"
# Ninja em vez do MSBuild: o rastreador de arquivos do MSBuild estoura os 260 caracteres nos
# subprojetos do Vulkan. O Ninja precisa do ambiente do compilador (Developer Shell do VS).
if (-not (Get-Command cl.exe -ErrorAction SilentlyContinue)) {
  $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
  $vs = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
  if (-not $vs) { throw "Visual Studio com as ferramentas de C++ não encontrado" }
  Import-Module "$vs\Common7\Tools\Microsoft.VisualStudio.DevShell.dll"
  Enter-VsDevShell -VsInstallPath $vs -SkipAutomaticLocation -DevCmdArguments "-arch=x64 -host_arch=x64"
}
$env:CMAKE_GENERATOR = "Ninja"
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$Out = (Resolve-Path $Out).Path  # absoluto: o pip roda dentro de worker\
# O MSBuild não aceita caminhos com mais de 260 caracteres: compila o código-fonte numa pasta curta,
# com o TEMP também curto (o ambiente isolado do pip fica lá).
$Work = if ($env:WT_BUILD_DIR) { $env:WT_BUILD_DIR } else { "C:\wt" }
Remove-Item -Recurse -Force $Work -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path "$Work\tmp" | Out-Null
$env:TEMP = "$Work\tmp"
$env:TMP = "$Work\tmp"
Push-Location "$PSScriptRoot\..\worker"
try {
  uv run --with pip python -m pip download --no-deps --no-binary :all: "pywhispercpp==$Version" -d $Work
  if ($LASTEXITCODE -ne 0) { throw "falha ao baixar o código-fonte do pywhispercpp" }
  tar -xzf "$Work\pywhispercpp-$Version.tar.gz" -C $Work
  if ($LASTEXITCODE -ne 0) { throw "falha ao extrair o código-fonte do pywhispercpp" }
  uv run --with pip python -m pip wheel --no-deps "$Work\pywhispercpp-$Version" -w $Out
  if ($LASTEXITCODE -ne 0) { throw "falha ao compilar o pywhispercpp" }
} finally { Pop-Location }
Get-ChildItem $Out
