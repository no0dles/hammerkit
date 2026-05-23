import type { Config } from '@jest/types'
import base from './jest.config'

const config: Config.InitialOptions = {
  ...base,
  testTimeout: 300000,
  testRegex: ['src/testing/integration/.*\\.spec\\.ts$', 'src/docker/package\\.spec\\.ts$'],
  collectCoverage: false,
  maxConcurrency: 1,
  reporters: ['github-actions', 'default'],
}

export default config
