import js from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';
import pluginReactHooks from 'eslint-plugin-react-hooks';
import pluginReact from 'eslint-plugin-react';
import globals from 'globals';
import pluginNext from '@next/eslint-plugin-next';

/**
 * Standalone flat ESLint config for the sales-agent app.
 * Inlined from the former @repo/eslint-config/next-js (turbo + only-warn
 * plugins dropped — those were monorepo-only).
 *
 * @type {import("eslint").Linter.Config[]}
 */
export default [
  js.configs.recommended,
  eslintConfigPrettier,
  ...tseslint.configs.recommended,
  {
    ...pluginReact.configs.flat.recommended,
    languageOptions: {
      ...pluginReact.configs.flat.recommended.languageOptions,
      globals: {
        ...globals.browser,
        ...globals.serviceworker,
      },
    },
  },
  {
    plugins: {
      '@next/next': pluginNext,
    },
    rules: {
      ...pluginNext.configs.recommended.rules,
      ...pluginNext.configs['core-web-vitals'].rules,
    },
  },
  {
    plugins: {
      'react-hooks': pluginReactHooks,
    },
    settings: { react: { version: 'detect' } },
    rules: {
      ...pluginReactHooks.configs.recommended.rules,
      'react/react-in-jsx-scope': 'off',
    },
  },
  {
    rules: {
      'no-console': ['error', { allow: ['warn', 'error'] }],
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-unused-vars': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      'react/prop-types': 'off',
      'react/display-name': 'off',
    },
  },
  {
    // Build/config files run in Node (CommonJS or ESM) — allow node globals
    // (module, process, require) so they don't trip no-undef.
    files: ['*.config.{js,cjs,mjs,ts}', 'next.config.js', '**/*.cjs'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  {
    // CLI scripts are Node programs whose entire job is to talk to the
    // operator, so stdout is the output medium rather than a debugging leak.
    files: ['scripts/**/*.{js,mjs}'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-console': 'off',
    },
  },
  {
    ignores: ['.next/**', 'node_modules/**', 'dist/**', 'next-env.d.ts'],
  },
];
