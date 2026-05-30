import { getVersion } from './version'
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pkg = require('../package.json')

describe('getVersion', () => {
  it('returns the version from package.json', () => {
    expect(getVersion()).toBe(pkg.version)
    expect(getVersion()).toMatch(/^\d+\.\d+\.\d+/)
  })
})
