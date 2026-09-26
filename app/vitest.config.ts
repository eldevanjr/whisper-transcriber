import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  test: {
    restoreMocks: true,
    // A suíte cresceu com o MCP: 5 s (padrão) estoura em testes de renderer sob cobertura num
    // runner carregado, causando flake. 20 s é folga sem esconder travamento de verdade.
    testTimeout: 20_000,
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: ['tests/**/*.test.ts'],
          exclude: ['tests/integration/**', 'tests/renderer/**']
        }
      },
      {
        extends: true,
        test: {
          name: 'renderer',
          environment: 'jsdom',
          include: ['tests/renderer/**/*.test.{ts,tsx}'],
          setupFiles: ['tests/renderer/setup.ts']
        }
      }
    ],
    coverage: {
      provider: 'v8',
      include: [
        'src/main/**/*.ts',
        'src/shared/**/*.ts',
        'src/preload/**/*.ts',
        'src/renderer/src/**/*.{ts,tsx}'
      ],
      // Bootstraps finos: só instanciam e ligam módulos testados; cobertos pelo E2E.
      exclude: [
        'src/main/index.ts',
        'src/renderer/src/main.tsx',
        // Só rodam no navegador de verdade (AudioWorklet, AudioContext); a lógica fica em chunker/capture.
        'src/renderer/src/live/pcm-worklet.ts',
        'src/renderer/src/live/browser.ts'
      ],
      thresholds: { lines: 100, branches: 100, functions: 100, statements: 100 },
      reporter: ['text', 'html']
    }
  }
})
