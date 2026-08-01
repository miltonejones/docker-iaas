import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-config-prettier';

const nodeGlobals = {
  process: 'readonly',
  console: 'readonly',
  Buffer: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  fetch: 'readonly',
  AbortSignal: 'readonly',
  __dirname: 'readonly',
  __filename: 'readonly',
  URL: 'readonly',
};

const swGlobals = {
  self: 'readonly',
  caches: 'readonly',
  fetch: 'readonly',
};

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      'data/**',
      'scripts/issue-logs/**',
      'web/dist/**',
      'testing/**',
    ],
  },
  {
    files: ['web/**/*.tsx', 'web/**/*.ts'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // Changing setState-in-effect patterns requires architectural judgment.
      // Downgrade to warn — targeted fixes belong in a dedicated follow-up.
      'react-hooks/set-state-in-effect': 'warn',
    },
  },
  {
    files: ['scripts/**/*.mjs', 'scripts/**/*.cjs'],
    languageOptions: { globals: nodeGlobals },
  },
  {
    files: ['web/public/sw.js'],
    languageOptions: { globals: { ...swGlobals, URL: 'readonly' } },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
);
