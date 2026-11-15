import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

// The rules of hooks (which type-check fine and fail at run time) and the TypeScript basics.
export default tseslint.config(
  { ignores: ['node_modules'] },
  {
    files: ['src/**/*.{ts,tsx}', 'vite.config.ts'],
    extends: [tseslint.configs.recommended, reactHooks.configs.flat['recommended-latest']],
    rules: {
      'react-hooks/exhaustive-deps': 'error',
    },
  }
)
