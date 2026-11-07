import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/drizzle/**',
      'data/**',
      'openspec/**',
      '.claude/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // Only the vault module may use cipher functions (credential-vault rule 9).
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: ['node:crypto', 'crypto'].map((name) => ({
            name,
            importNames: [
              'createCipheriv',
              'createDecipheriv',
              'createCipher',
              'createDecipher',
              'default',
            ],
            message: 'Cipher functions are restricted to packages/db/src/vault/.',
          })),
        },
      ],
    },
  },
  { files: ['packages/db/src/vault/**/*.ts'], rules: { 'no-restricted-imports': 'off' } },
  { files: ['apps/web/**/*.{ts,tsx}'], languageOptions: { globals: { ...globals.browser } } },
);
