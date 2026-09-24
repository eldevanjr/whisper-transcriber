import { statfs as nodeStatfs } from 'node:fs/promises'
import { AppError } from '../../shared/errors'

export type StatFs = (path: string) => Promise<{ bavail: number; bsize: number }>

export const SPACE_MARGIN = 1.1

export async function ensureFreeSpace(
  dir: string,
  bytesNeeded: number,
  statfs: StatFs = nodeStatfs
): Promise<void> {
  const stats = await statfs(dir)
  const free = stats.bavail * stats.bsize
  if (free < Math.round(bytesNeeded * SPACE_MARGIN)) {
    throw new AppError(
      'INSUFFICIENT_SPACE',
      'Espaço em disco insuficiente',
      `necessário ${bytesNeeded} bytes (+10%), livre ${free}`
    )
  }
}
