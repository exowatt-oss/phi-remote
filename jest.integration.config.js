/**
 * Opt-in integration tests against tools/mock-hub, in plain Node (real fetch + WebSocket,
 * without the React Native globals that the jest-expo preset installs).
 * See src/lib/__tests__/mock-hub.integration.test.ts for how to run.
 */
const path = require('node:path');

// babel-preset-expo ships inside the expo package.
const babelPresetExpo = require.resolve('babel-preset-expo', { paths: [path.dirname(require.resolve('expo/package.json'))] });

module.exports = {
  testEnvironment: 'node',
  rootDir: __dirname,
  testMatch: ['<rootDir>/src/**/*.integration.test.ts'],
  transform: { '^.+\\.[jt]sx?$': ['babel-jest', { presets: [babelPresetExpo] }] },
  transformIgnorePatterns: ['/node_modules/(?!(marked|zustand))'],
};
