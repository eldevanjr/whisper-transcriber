import { z } from 'zod'
import type { WorkerCommandLine } from './worker/locate'

export interface DevOverrides {
  workerCommand?: WorkerCommandLine
  manifestPath?: string
}

const CommandSchema = z.object({ command: z.string().min(1), args: z.array(z.string()) })

function parseCommand(raw: string | undefined): WorkerCommandLine | undefined {
  if (raw === undefined) return undefined
  try {
    const parsed = CommandSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

/**
 * Ganchos dos testes E2E (motor falso, manifesto de downloads de teste). Só valem fora do
 * app empacotado: no instalado, variáveis de ambiente nunca trocam o motor nem os downloads.
 */
export function readDevOverrides(env: NodeJS.ProcessEnv, isPackaged: boolean): DevOverrides {
  if (isPackaged) return {}
  const workerCommand = parseCommand(env.WT_WORKER_COMMAND)
  const manifestPath = env.WT_DOWNLOADS_MANIFEST
  return {
    ...(workerCommand ? { workerCommand } : {}),
    ...(manifestPath ? { manifestPath } : {})
  }
}
