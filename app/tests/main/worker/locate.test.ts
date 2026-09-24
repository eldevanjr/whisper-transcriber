import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { cudaLibraryDirs, resolveWorkerCommand, workerEnv } from '../../../src/main/worker/locate'
import { makeTempDir } from '../../helpers/tmp'

describe('resolveWorkerCommand', () => {
  it('app empacotado usa o executável em resources/worker', () => {
    expect(
      resolveWorkerCommand({
        isPackaged: true,
        resourcesPath: '/r',
        appPath: '/a',
        platform: 'linux'
      })
    ).toEqual({ command: join('/r', 'worker', 'transcriber-worker'), args: [] })
    expect(
      resolveWorkerCommand({
        isPackaged: true,
        resourcesPath: 'C:\\r',
        appPath: '',
        platform: 'win32'
      }).command
    ).toBe(join('C:\\r', 'worker', 'transcriber-worker.exe'))
  })

  it('desenvolvimento usa uv run no projeto worker/', () => {
    const worker = join('/repo/app', '..', 'worker')
    expect(
      resolveWorkerCommand({
        isPackaged: false,
        resourcesPath: '',
        appPath: '/repo/app',
        platform: 'linux'
      })
    ).toEqual({
      command: 'uv',
      args: ['run', '--project', worker, 'python', '-m', 'transcriber_worker'],
      cwd: worker
    })
  })
})

describe('cudaLibraryDirs', () => {
  it('lista nvidia/*/lib existentes, em ordem', async () => {
    const root = await makeTempDir()
    await mkdir(join(root, 'nvidia', 'cudnn', 'lib'), { recursive: true })
    await mkdir(join(root, 'nvidia', 'cublas', 'lib'), { recursive: true })
    await mkdir(join(root, 'nvidia', 'sem-lib'), { recursive: true })
    expect(cudaLibraryDirs(root)).toEqual([
      join(root, 'nvidia', 'cublas', 'lib'),
      join(root, 'nvidia', 'cudnn', 'lib')
    ])
  })

  it('sem CUDA instalado devolve vazio', async () => {
    expect(cudaLibraryDirs(join(await makeTempDir(), 'nada'))).toEqual([])
  })
})

describe('workerEnv', () => {
  it('sempre força UTF-8 e saída sem buffer', () => {
    const env = workerEnv({ PATH: '/bin' }, { platform: 'win32', device: 'cuda', cudaDir: '/c' })
    expect(env).toEqual({ PATH: '/bin', PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' })
  })

  it('Linux + CUDA prefixa LD_LIBRARY_PATH com as libs NVIDIA', async () => {
    const root = await makeTempDir()
    await mkdir(join(root, 'nvidia', 'cublas', 'lib'), { recursive: true })
    const lib = join(root, 'nvidia', 'cublas', 'lib')
    expect(
      workerEnv(
        { LD_LIBRARY_PATH: '/usr/lib' },
        { platform: 'linux', device: 'cuda', cudaDir: root }
      ).LD_LIBRARY_PATH
    ).toBe(`${lib}:/usr/lib`)
    expect(
      workerEnv({}, { platform: 'linux', device: 'cuda', cudaDir: root }).LD_LIBRARY_PATH
    ).toBe(lib)
  })

  it('Linux em CPU não mexe no LD_LIBRARY_PATH', () => {
    expect(
      workerEnv({}, { platform: 'linux', device: 'cpu', cudaDir: '/c' }).LD_LIBRARY_PATH
    ).toBeUndefined()
  })
})
