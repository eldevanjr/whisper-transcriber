import type { AiKnowledgeBackup } from '../../shared/ipc'

/** Dependências do backup/restauração de conhecimento (tudo injetável para testes). */
export interface KnowledgeTransferDeps {
  /** Pede ao worker para escrever o backup no caminho. */
  backupTo(path: string): Promise<AiKnowledgeBackup>
  /** Pede ao worker para restaurar o backup do caminho. */
  restoreFrom(path: string): Promise<AiKnowledgeBackup>
  /** Diálogo de escolha do arquivo de backup; null se cancelar. */
  pickRestoreFile(): Promise<string | null>
  /** Diálogo de salvar; devolve false se cancelar. */
  saveFile(content: string): Promise<boolean>
  tempPath(): string
  read(path: string): Promise<string>
  write(path: string, content: string): Promise<void>
  remove(path: string): Promise<void>
}

/**
 * Ponte entre os diálogos nativos e o worker: o worker só grava/lê arquivos no
 * caminho pedido, então passamos por um arquivo temporário até o destino final.
 */
export class KnowledgeTransfer {
  constructor(private readonly deps: KnowledgeTransferDeps) {}

  async backup(): Promise<AiKnowledgeBackup | null> {
    const path = this.deps.tempPath()
    try {
      const result = await this.deps.backupTo(path)
      return (await this.deps.saveFile(await this.deps.read(path))) ? result : null
    } finally {
      await this.deps.remove(path)
    }
  }

  async restore(): Promise<AiKnowledgeBackup | null> {
    const source = await this.deps.pickRestoreFile()
    if (source === null) return null
    const path = this.deps.tempPath()
    try {
      await this.deps.write(path, await this.deps.read(source))
      return await this.deps.restoreFrom(path)
    } finally {
      await this.deps.remove(path)
    }
  }
}
