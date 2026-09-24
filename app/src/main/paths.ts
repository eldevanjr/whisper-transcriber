import { join } from 'node:path'
import type { ModelFormat, ModelId } from '../shared/models'

export interface AppPaths {
  root: string
  settings: string
  settingsBackup: string
  models: string
  modelsGgml: string
  cuda: string
  history: string
  logs: string
}

export function appPaths(userData: string): AppPaths {
  return {
    root: userData,
    settings: join(userData, 'settings.json'),
    settingsBackup: join(userData, 'settings.bak.json'),
    models: join(userData, 'models'),
    modelsGgml: join(userData, 'models-ggml'),
    cuda: join(userData, 'cuda'),
    history: join(userData, 'history'),
    logs: join(userData, 'logs')
  }
}

export function modelDir(paths: AppPaths, id: ModelId, format: ModelFormat = 'ct2'): string {
  return join(format === 'ggml' ? paths.modelsGgml : paths.models, id)
}
