# PyInstaller (onedir): o worker que o app distribui em resources/worker/.
# Gere com scripts/build-worker.sh (ou .ps1), que também instala o wheel do whisper.cpp com GPU.
# ruff: noqa
from PyInstaller.utils.hooks import collect_all, collect_data_files, collect_dynamic_libs

datas = collect_data_files("faster_whisper")  # VAD Silero (assets/silero_vad_v6.onnx)
datas += [("transcriber_worker/assets", "transcriber_worker/assets")]
binaries = collect_dynamic_libs("ctranslate2")
hiddenimports = ["_pywhispercpp"]
for package in ("av", "onnxruntime", "tokenizers", "pywhispercpp"):
    pkg_datas, pkg_binaries, pkg_hidden = collect_all(package)
    datas += pkg_datas
    binaries += pkg_binaries
    hiddenimports += pkg_hidden

a = Analysis(
    ["transcriber_worker/__main__.py"],
    pathex=[],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    excludes=["tkinter", "pytest", "mypy", "ruff"],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="transcriber-worker",
    console=True,  # stdin/stdout são o protocolo com o app
    upx=False,
)
coll = COLLECT(exe, a.binaries, a.datas, name="transcriber-worker", upx=False)
