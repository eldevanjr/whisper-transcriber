import jsxA11y from 'eslint-plugin-jsx-a11y'
import reactHooks from 'eslint-plugin-react-hooks'
import prettier from 'eslint-config-prettier'
import sonarjs from 'eslint-plugin-sonarjs'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      'out/**',
      'dist/**',
      'release/**',
      'coverage/**',
      'node_modules/**',
      'scripts/**',
      '*.config.*',
      'eslint.config.mjs'
    ]
  },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [...tseslint.configs.strictTypeChecked, ...tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.web.json'],
        tsconfigRootDir: import.meta.dirname
      }
    },
    plugins: { sonarjs },
    rules: {
      complexity: ['error', 9],
      'sonarjs/cognitive-complexity': ['error', 9],
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }]
    }
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}', 'tests/renderer/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended, jsxA11y.flatConfigs.strict],
    rules: {
      // O WAI-ARIA recomenda o painel de abas focável (tabIndex 0).
      'jsx-a11y/no-noninteractive-tabindex': ['error', { roles: ['tabpanel'] }]
    }
  },
  {
    files: ['tests/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/require-await': 'off',
      // A ponte do Electron rejeita com objetos simples; os dublês de teste imitam isso.
      '@typescript-eslint/prefer-promise-reject-errors': 'off'
    }
  },
  prettier
)
