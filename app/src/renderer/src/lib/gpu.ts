import type { Accelerator } from '../../../shared/events'

/** Nome da API gráfica para o usuário: "Metal" (Apple) ou "Vulkan". */
export function apiLabel(accelerator: Accelerator): string {
  return accelerator.api === 'metal' ? 'Metal' : 'Vulkan'
}
