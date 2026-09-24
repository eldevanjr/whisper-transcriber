import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  test: {
    restoreMocks: true,
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
      exclude: ['src/main/index.ts', 'src/renderer/src/main.tsx'],
      thresholds: { lines: 100, branches: 100, functions: 100, statements: 100 },
      reporter: ['text', 'html']
    }
  }
})
