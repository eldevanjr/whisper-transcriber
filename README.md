# Whisper Transcriber

App desktop (Windows, macOS e Linux) para transcrever vídeos e áudios **no seu computador**,
sem enviar nada para a internet, usando os modelos Whisper via [faster-whisper](https://github.com/SYSTRAN/faster-whisper)
e [whisper.cpp](https://github.com/ggml-org/whisper.cpp) (GPU por Vulkan ou Metal).

- Arraste vídeos ou áudios para a janela; a fila transcreve um por vez.
- Os trechos aparecem ao vivo, como num chat, sincronizados com o player.
- Resultado em **Texto** (parágrafos), **Com tempos** e **JSON**, com Copiar e Baixar.
- Histórico com o áudio salvo; GPU NVIDIA (CUDA), AMD/Intel (Vulkan) ou Apple Silicon (Metal).
- Interface em português, inglês e espanhol; temas claro, escuro ou do sistema.

## Veja funcionando

![Transcrição ao vivo: fila com vídeos e áudios, trechos aparecendo como num chat e o vídeo acompanhando](docs/screenshots/01-transcrevendo.png)

| | |
|---|---|
| ![Aba Trechos: cada trecho com o tempo; clicar pula o vídeo](docs/screenshots/02-trechos.png) | ![Aba Texto: a transcrição em parágrafos, pronta para copiar ou baixar](docs/screenshots/03-texto.png) |
| **Trechos** — cada fala com o tempo; clique para pular o vídeo | **Texto** — parágrafos prontos para copiar ou baixar |
| ![Tema escuro](docs/screenshots/05-tema-escuro.png) | ![Escolha do modelo na primeira abertura, com a GPU detectada](docs/screenshots/06-escolha-do-modelo.png) |
| **Tema escuro** (ou claro, ou o do sistema) | **Primeira abertura** — escolha do modelo e uso da GPU |

![Configurações de transcrição: modelos, idioma do áudio e processamento na CPU ou GPU](docs/screenshots/04-configuracoes.png)

<sub>Mídias das capturas, todas em domínio público: discurso de John F. Kennedy na Rice University
(1962) e vídeo da NASA sobre a tripulação da Artemis II, via Wikimedia Commons; contos
"Miss Dollar" e "O relógio de ouro", de Machado de Assis, na leitura do LibriVox.</sub>

## Instalação

Baixe o instalador do seu sistema na [última versão](https://github.com/eldevanjr/whisper-transcriber/releases/latest)
(confira pelo `SHA256SUMS.txt`):

| Sistema | Arquivo | Atualização |
|---|---|---|
| Windows 10/11 (x64) | `…-windows-x64.exe` (instala só para o seu usuário) | automática |
| Linux (x64) | `…-linux-x64.AppImage` | automática |
| Linux Debian/Ubuntu (x64) | `…-linux-x64.deb` | aviso com link para a nova versão |
| macOS 14+ (Apple Silicon) | `…-macos-arm64.dmg` | aviso com link para a nova versão |

**macOS:** o app ainda não é assinado pela Apple. Na primeira vez, abra o app, feche o aviso e vá
em Ajustes do Sistema → Privacidade e Segurança → **Abrir mesmo assim**.

**Linux:** no Ubuntu 24.04 o AppImage precisa do `libfuse2t64` (`sudo apt install libfuse2t64`).
Mínimo: glibc 2.35 (Ubuntu 22.04, Debian 12, Mint 21 ou mais novos).

## Versões

A versão sai automaticamente do histórico de commits ([Conventional Commits](https://www.conventionalcommits.org/pt-br/)):
`fix:` → correção (0.1.**1**), `feat:` → novidade (0.**2**.0), `!`/`BREAKING CHANGE` → versão maior.
O merge na `main` gera a tag, os instaladores dos 3 sistemas e o release; os PRs para a `main`
geram os instaladores como teste, sem publicar.

Se um dos instaladores falhar no release, a tag e o release rascunho já existem: use
**Re-run failed jobs** na mesma execução do Actions (o electron-builder regrava os arquivos e o
release é publicado no fim). Para desistir da versão, apague o rascunho e a tag antes do próximo
merge na `main`. Para publicar uma tag que já existe (ex.: refazer um release do zero), rode o
workflow **Release** manualmente com `version` preenchida e `dry_run` desmarcado.

## Estrutura

- `worker/` — motor de transcrição em Python (faster-whisper + PyAV), falando JSON Lines por stdin/stdout.
- `app/` — aplicativo Electron + React (main, preload e renderer), com Vitest e Playwright.

## Desenvolvimento

Requisitos: Node 24, pnpm 12, Python 3.12 e [uv](https://docs.astral.sh/uv/). Java 21 só para o detector de duplicação (PMD CPD).

```bash
cd worker && uv sync            # motor
cd app && pnpm install          # app
pnpm dev                        # abre o app com recarga automática
```

| Comando (em `app/`) | O que faz |
|---|---|
| `pnpm test` | testes unitários (main, preload, shared, renderer) com 100% de cobertura |
| `pnpm test:integration` | contrato real app ↔ motor (modelo `tiny`) |
| `pnpm e2e` | build + Playwright no app de verdade, com motor falso |
| `pnpm lint` / `pnpm typecheck` / `pnpm cpd` | lint estrito, tipos e duplicação |
| `pnpm gen:licenses` | atualiza `resources/third-party-licenses.json` (tela Licenças) |

No motor: `uv run pytest` (100% de cobertura), `uv run ruff check`, `uv run mypy`.

No Ubuntu 24, o `chrome-sandbox` do Electron em desenvolvimento precisa de SUID
(`sudo chown root:root node_modules/electron/dist/chrome-sandbox && sudo chmod 4755 …`)
ou rode com `--no-sandbox`. Nos instaladores isso é configurado automaticamente.

## Relatar problemas

Use o botão **Relatar problema** no aviso de erro do app: ele abre uma issue já preenchida com
o diagnóstico (sem caminhos pessoais) para você revisar e enviar.

---

Desenvolvido por **Eldevan Nery Junior** — [github.com/eldevanjr](https://github.com/eldevanjr).
Licenciado sob a [Apache License 2.0](LICENSE). Usa os modelos Whisper (OpenAI) via faster-whisper;
projeto independente, sem vínculo com a OpenAI.
