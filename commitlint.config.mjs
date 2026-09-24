// Conventional Commits de una sola línea: sin cuerpo ni pie (sin trailers como Co-Authored-By).
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'body-empty': [2, 'always'],
    'footer-empty': [2, 'always'],
  },
}
