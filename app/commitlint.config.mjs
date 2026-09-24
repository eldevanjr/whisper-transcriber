// Conventional Commits: o semantic-release calcula a versão a partir deles (spec §10.4).
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // Mensagens em pt-BR com nomes próprios e siglas (CUDA, GPU): sem exigir minúsculas.
    'subject-case': [0],
    'body-max-line-length': [0],
    'footer-max-line-length': [0]
  }
}
