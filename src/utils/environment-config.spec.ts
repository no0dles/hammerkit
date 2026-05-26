import { getEnvironmentConfig } from './environment-config'

const VAR = 'HAMMERKIT_TEST_ENV_CONFIG'

describe('getEnvironmentConfig', () => {
  afterEach(() => {
    delete process.env[VAR]
  })

  it('returns the default when the variable is unset', () => {
    delete process.env[VAR]
    expect(getEnvironmentConfig(VAR, 7)).toBe(7)
  })

  it('parses an integer env value', () => {
    process.env[VAR] = '42'
    expect(getEnvironmentConfig(VAR, 7)).toBe(42)
  })

  it('falls back to the default when the env value is not a number', () => {
    process.env[VAR] = 'not-a-number'
    expect(getEnvironmentConfig(VAR, 7)).toBe(7)
  })

  it('treats an empty string env value as not-a-number and uses the default', () => {
    process.env[VAR] = ''
    expect(getEnvironmentConfig(VAR, 5)).toBe(5)
  })
})
