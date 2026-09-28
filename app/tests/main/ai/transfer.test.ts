import { describe, expect, it, vi } from 'vitest'
import { KnowledgeTransfer, type KnowledgeTransferDeps } from '../../../src/main/ai/transfer'

function deps(overrides: Partial<KnowledgeTransferDeps> = {}): KnowledgeTransferDeps {
  return {
    backupTo: vi.fn(() => Promise.resolve({ documents: 2, chunks: 5, analyses: 1 })),
    restoreFrom: vi.fn(() => Promise.resolve({ documents: 2, chunks: 5, analyses: 1 })),
    pickRestoreFile: vi.fn(() => Promise.resolve('/origem.json')),
    saveFile: vi.fn(() => Promise.resolve(true)),
    tempPath: vi.fn(() => '/tmp/tmp.json'),
    read: vi.fn(() => Promise.resolve('conteudo')),
    write: vi.fn(() => Promise.resolve()),
    remove: vi.fn(() => Promise.resolve()),
    ...overrides
  }
}

describe('KnowledgeTransfer', () => {
  it('backup grava no temporário, salva no destino e remove o temporário', async () => {
    const depsObj = deps()
    const result = await new KnowledgeTransfer(depsObj).backup()
    expect(result).toEqual({ documents: 2, chunks: 5, analyses: 1 })
    expect(depsObj.backupTo).toHaveBeenCalledWith('/tmp/tmp.json')
    expect(depsObj.saveFile).toHaveBeenCalledWith('conteudo')
    expect(depsObj.remove).toHaveBeenCalledWith('/tmp/tmp.json')
  })

  it('backup cancelado devolve null e ainda remove o temporário', async () => {
    const depsObj = deps({ saveFile: vi.fn(() => Promise.resolve(false)) })
    expect(await new KnowledgeTransfer(depsObj).backup()).toBeNull()
    expect(depsObj.remove).toHaveBeenCalledWith('/tmp/tmp.json')
  })

  it('restore copia o arquivo escolhido e restaura no workspace', async () => {
    const depsObj = deps()
    expect(await new KnowledgeTransfer(depsObj).restore()).toEqual({
      documents: 2,
      chunks: 5,
      analyses: 1
    })
    expect(depsObj.read).toHaveBeenCalledWith('/origem.json')
    expect(depsObj.write).toHaveBeenCalledWith('/tmp/tmp.json', 'conteudo')
    expect(depsObj.restoreFrom).toHaveBeenCalledWith('/tmp/tmp.json')
    expect(depsObj.remove).toHaveBeenCalledWith('/tmp/tmp.json')
  })

  it('restore cancelado não copia nem restaura', async () => {
    const depsObj = deps({ pickRestoreFile: vi.fn(() => Promise.resolve(null)) })
    expect(await new KnowledgeTransfer(depsObj).restore()).toBeNull()
    expect(depsObj.write).not.toHaveBeenCalled()
    expect(depsObj.remove).not.toHaveBeenCalled()
  })
})
