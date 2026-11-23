// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');
const prettier = require('eslint-config-prettier');

module.exports = defineConfig([
  expoConfig,
  prettier,
  {
    ignores: ['dist/*', 'node_modules/*', '.expo/*', 'coverage/*'],
  },
  {
    // TODO(phase-3): these React Compiler rules flag existing screens
    // (KeyboardAwareView refs in render, Date.now() in CreateActivityScreen
    // render, a component defined inside DiscoverScreen's render, setState in
    // PodDetailScreen's effect). Fixing them changes runtime behaviour, so
    // they are warnings until the Phase 3 screen rebuild; then make them errors.
    rules: {
      'react-hooks/refs': 'warn',
      'react-hooks/purity': 'warn',
      'react-hooks/static-components': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
    },
  },
  {
    // Deno Edge Functions: npm: specifiers and the Deno global.
    files: ['supabase/functions/**/*.ts'],
    languageOptions: { globals: { Deno: 'readonly' } },
    rules: { 'import/no-unresolved': 'off' },
  },
]);
