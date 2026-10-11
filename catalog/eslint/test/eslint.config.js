module.exports = [
  {
    files: ['**/*.js'],
    languageOptions: { sourceType: 'commonjs', globals: { console: 'readonly' } },
    rules: { 'no-unused-vars': 'error' },
  },
]
