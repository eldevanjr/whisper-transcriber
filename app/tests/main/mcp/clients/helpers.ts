import { vi, type Mock } from 'vitest'
import type { Cli, CliRunResult } from '../../../../src/main/mcp/clients/cli'
import type { ConnectorDeps } from '../../../../src/main/mcp/clients/registry'

export const LAUNCHER = '/home/u/.config/Whisper Transcriber/mcp/whisper-transcriber-mcp'

export function makeDeps(overrides: Partial<ConnectorDeps> = {}): ConnectorDeps {
  return {
    platform: 'linux',
    home: '/home/u',
    env: {},
    launcherPath: LAUNCHER,
    cli: { find: async () => null, run: async () => ({ stdout: '', stderr: '' }) },
    ...overrides
  }
}

export interface RecordingCli extends Cli {
  find: Mock<(name: string) => Promise<string | null>>
  run: Mock<(file: string, args: readonly string[]) => Promise<CliRunResult>>
}

export function recordingCli(found: string | null = null): RecordingCli {
  return {
    find: vi.fn<(name: string) => Promise<string | null>>(async () => found),
    run: vi.fn<(file: string, args: readonly string[]) => Promise<CliRunResult>>(async () => ({
      stdout: '',
      stderr: ''
    }))
  }
}
