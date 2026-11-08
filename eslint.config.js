// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');
const globals = require('globals');

module.exports = defineConfig([
  expoConfig,
  {
    // tools/ and scripts/ios/ are owned by other packages/pipelines with their own conventions.
    ignores: ['dist/*', '.expo/*', 'tools/**', 'scripts/ios/**', 'coverage/**'],
  },
  {
    files: ['*.config.js', 'jest.*.js', 'scripts/**/*.{js,mjs}'],
    languageOptions: { globals: globals.node },
  },
]);
