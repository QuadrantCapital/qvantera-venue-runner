import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  { ignores: ['**/dist/**', '**/node_modules/**', '**/.yarn/**'] },
  {
    files: ['**/*.{ts,mjs}'],
    languageOptions: {
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // Configuration is read once, by `src/config.ts`, against its schema; anywhere else, call
      // `config()` or take the value as a parameter.
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'env',
          message: 'Read configuration through config() (src/config.ts), not process.env.',
        },
      ],
    },
  },
  {
    files: ['**/src/config.ts', '**/*.test.ts'],
    rules: { 'no-restricted-properties': 'off' },
  },
)
