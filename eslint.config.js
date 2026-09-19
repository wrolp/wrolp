import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import globals from 'globals'

export default tseslint.config(
  {
    ignores: [
      'dist/',
      'coverage/',
      'dist-check/',
      'src-tauri/target/',
      'src-tauri/gen/',
      // Vendored/minified third-party bundles are not our code to lint.
      '**/*.min.js',
      '3d-topology-demo/',
      'wrolp-logo-design/',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    // A stale `eslint-disable` should not fail the gate — report it, don't block.
    linterOptions: { reportUnusedDisableDirectives: 'warn' },
    rules: {
      // A terminal app matches \x1b / \x07 in regexes by design (ANSI, OSC, BEL),
      // so this recommended rule is a permanent false positive here.
      'no-control-regex': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' },
      ],
      'no-useless-assignment': 'warn',
      'no-empty': ['warn', { allowEmptyCatch: true }],
      // Monarch tokenizer regexes in src/editor/ are tuned by hand; flag, don't block.
      'no-useless-escape': 'warn',
      // `declare module 'monaco-editor'` augmentation requires a namespace.
      '@typescript-eslint/no-namespace': 'off',
    },
  },

  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      // invoke() results cross an untyped runtime boundary.
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },

  {
    files: ['**/*.mjs', 'e2e/**/*.ts', '*.config.ts'],
    languageOptions: { globals: globals.node },
  },
)
