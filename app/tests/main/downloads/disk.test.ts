import { describe, expect, it } from 'vitest'
import { ensureFreeSpace } from '../../../src/main/downloads/disk'
import { AppError } from '../../../src/shared/errors'
import { makeTempDir } from '../../helpers/tmp'

describe('ensureFreeSpace', () => {
  const statfs = (free: number) => () => Promise.resolve({ bavail: free, bsize: 1 })

  it('aceita quando há espaço com margem de 10%', async () => {
    await expect(ensureFreeSpace('/x', 100, statfs(110))).resolves.toBeUndefined()
  })

  it('recusa quando falta espaço', async () => {
    await expect(ensureFreeSpace('/x', 100, statfs(109))).rejects.toSatisfy(
      (e: unknown) => e instanceof AppError && e.code === 'INSUFFICIENT_SPACE'
    )
  })

  it('usa o statfs real por padrão', async () => {
    await expect(ensureFreeSpace(await makeTempDir(), 1)).resolves.toBeUndefined()
  })
})
