"""Modo CLI: transcreve um arquivo e grava .json/.txt no mesmo formato do main.py antigo.

Diferente do modo worker, aqui --model aceita o nome do modelo (ex.: "medium"), e o
faster-whisper baixa o modelo na primeira execução, como o script original fazia.
"""

import argparse
import json
import sys
from collections.abc import Sequence
from pathlib import Path
from typing import Any, TextIO

from transcriber_worker.engine import Engine, named_model_factory
from transcriber_worker.errors import ErrorCode, WorkerError
from transcriber_worker.events import Event
from transcriber_worker.protocol import LoadModelParams
from transcriber_worker.runtime import compute_type_for


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="transcriber-worker cli",
        description="Transcreve um vídeo ou áudio (compatível com o main.py antigo).",
    )
    parser.add_argument("arquivo")
    parser.add_argument("--model", default="medium")
    parser.add_argument(
        "--engine", choices=["faster-whisper", "whisper-cpp"], default="faster-whisper"
    )
    parser.add_argument("--device", choices=["cpu", "cuda", "gpu"], default="cpu")
    parser.add_argument("--language", default="pt", help='código do idioma ou "auto"')
    parser.add_argument("--output-dir", default="output")
    return parser


def format_time(seconds: float) -> str:
    h, m, s = int(seconds // 3600), int(seconds % 3600 // 60), int(seconds % 60)
    return f"{h:02}:{m:02}:{s:02}" if h else f"{m:02}:{s:02}"


class SegmentCollector:
    def __init__(self, out: TextIO) -> None:
        self.segments: list[dict[str, Any]] = []
        self._out = out

    def __call__(self, event: Event) -> None:
        if event["type"] == "segment":
            self.segments.append(
                {
                    "inicio": round(event["start"], 3),
                    "fim": round(event["end"], 3),
                    "texto": event["text"],
                }
            )
        elif event["type"] == "progress":
            processed, total = format_time(event["processed_s"]), format_time(event["total_s"])
            print(f"{event['pct']:6.2f}%  {processed} / {total}", file=self._out, flush=True)


def write_outputs(segments: list[dict[str, Any]], output_dir: Path, stem: str) -> tuple[Path, Path]:
    output_dir.mkdir(parents=True, exist_ok=True)
    json_path = output_dir / f"transcricao-{stem}.json"
    txt_path = output_dir / f"transcricao-{stem}.txt"
    json_path.write_text(json.dumps(segments, ensure_ascii=False, indent=4), encoding="utf-8")
    lines = [
        f"[{format_time(s['inicio'])} - {format_time(s['fim'])}] {s['texto']}\n" for s in segments
    ]
    txt_path.write_text("".join(lines), encoding="utf-8")
    return json_path, txt_path


def load_params(args: argparse.Namespace) -> LoadModelParams:
    if args.engine == "whisper-cpp":
        return LoadModelParams(model_dir=args.model, device=args.device, engine="whisper-cpp")
    if args.device == "gpu":
        raise WorkerError(ErrorCode.INVALID_MESSAGE, "--device gpu exige --engine whisper-cpp")
    return LoadModelParams(
        model_dir=args.model, device=args.device, compute_type=compute_type_for(args.device)
    )


def run(
    argv: Sequence[str],
    *,
    engine: Engine | None = None,
    out: TextIO | None = None,
) -> int:
    out = out or sys.stdout
    args = build_parser().parse_args(argv)
    source = Path(args.arquivo)
    if not source.is_file():
        print(f"Arquivo não encontrado: {source}", file=out)
        return 1
    engine = engine or Engine(factory=named_model_factory)
    collector = SegmentCollector(out)
    language = None if args.language == "auto" else args.language
    try:
        engine.load(load_params(args))
        engine.transcribe(str(source), language, source.stem, collector)
    except WorkerError as error:
        print(f"Erro ({error.code}): {error.message}", file=out)
        return 2
    json_path, _ = write_outputs(collector.segments, Path(args.output_dir), source.stem)
    print(f"Concluído! {json_path}", file=out)
    return 0
