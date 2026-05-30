// Each `isCI` arm is evaluated once at module load, so the only way to cover
// every branch of the OR chain is to load the module repeatedly under different
// process.env. jest.resetModules + a fresh require gives us that.

const KEYS = ['CI', 'CONTINUOUS_INTEGRATION', 'BUILD_NUMBER', 'RUN_ID'] as const

function loadIsCI(set?: Record<string, string>): boolean {
  for (const k of KEYS) delete process.env[k]
  if (set) Object.assign(process.env, set)
  jest.resetModules()
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('./ci').isCI
}

describe('isCI', () => {
  const original = { ...process.env }
  afterEach(() => {
    for (const k of KEYS) delete process.env[k]
    for (const k of KEYS) if (k in original) process.env[k] = original[k] as string
  })

  it('is false when no CI env var is set', () => {
    expect(loadIsCI()).toBe(false)
  })

  it.each(KEYS)('is true when %s is set', (key) => {
    expect(loadIsCI({ [key]: '1' })).toBe(true)
  })
})
