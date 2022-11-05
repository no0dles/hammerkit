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
  testEnvironment: 'node',
  maxConcurrency: 1,
  collectCoverage: true,
  coverageDirectory: '<rootDir>/coverage',
  collectCoverageFrom: ['<rootDir>/src/**'],
  coverageReporters: ['json', 'html', 'lcov'],
}

export default config
