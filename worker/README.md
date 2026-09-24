# transcriber-worker

Motor de transcrição do Whisper Transcriber. Roda como processo filho do app Electron
(protocolo JSON Lines via stdin/stdout) ou sozinho pelo modo CLI.

```bash
uv sync
uv run pytest                           # testes unitários (100% de cobertura)
uv run pytest -m integration --no-cov   # integração com o modelo tiny real
uv run transcriber-worker cli video.mp4 --model medium --language pt
```
