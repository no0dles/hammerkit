import type { Config } from '@jest/types'
import base from './jest.config'

const config: Config.InitialOptions = {
  ...base,
  testTimeout: 300000,
  testRegex: ['src/testing/integration/.*\\.spec\\.ts$', 'src/docker/package\\.spec\\.ts$'],
  testPathIgnorePatterns: ['/node_modules/', '/\\.claude/'],
  collectCoverage: false,
  // Suites are isolated: docker resources are labeled per work-item id, host
  // ports are ephemeral, and k8s objects land in per-suite namespaces. That
  // lets jest run spec files in parallel instead of one-at-a-time. Kept
  // conservative (2) because the self-hosted runner shares one docker daemon
  // and one k8s cluster across service-heavy suites; raise once validated.
  maxWorkers: 2,
  reporters: ['github-actions', 'default'],
}

export default config
