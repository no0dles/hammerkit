import type { Config } from '@jest/types'

const config: Config.InitialOptions = {
  preset: 'ts-jest',
  setupFilesAfterEnv: ['jest-extended/all'],
  moduleFileExtensions: ['ts', 'js'],
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: 'tsconfig.json',
      },
    ],
  },
  rootDir: '.',
  testTimeout: 45000,
  testRegex: ['src/.*\\.spec\\.ts$'],
  testPathIgnorePatterns: [
    '/node_modules/',
    '/\\.claude/',
    '<rootDir>/src/testing/integration/',
    '<rootDir>/src/docker/package\\.spec\\.ts$',
    '<rootDir>/src/program\\.spec\\.ts$',
  ],
  testEnvironment: 'node',
  collectCoverage: true,
  coverageDirectory: '<rootDir>/coverage',
  collectCoverageFrom: ['<rootDir>/src/**'],
  // Exclude test-related code from coverage: the integration test harness and
  // the spec/declaration files are not product code. src/index.ts is the bin
  // entry — just wires runProgram(process.argv) and isn't meaningfully unit
  // testable, so excluding it keeps it from inflating the denominator.
  coveragePathIgnorePatterns: [
    '/node_modules/',
    '<rootDir>/src/testing/',
    '<rootDir>/src/index\\.ts$',
    '\\.spec\\.ts$',
    '\\.d\\.ts$',
  ],
  coverageReporters: ['json', 'html', 'lcov'],
  reporters: ['github-actions', 'default', 'summary'],
}

export default config
