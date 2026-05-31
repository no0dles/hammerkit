// Each `isCI` arm is evaluated once at module load, so the only way to cover
// every branch of the OR chain is to load the module repeatedly under different
// process.env. vi.resetModules + a fresh dynamic import gives us that.

const KEYS = ['CI', 'CONTINUOUS_INTEGRATION', 'BUILD_NUMBER', 'RUN_ID'] as const

async function loadIsCI(set?: Record<string, string>): Promise<boolean> {
  for (const k of KEYS) delete process.env[k]
  if (set) Object.assign(process.env, set)
  vi.resetModules()
  return (await import('./ci')).isCI
}

describe('isCI', () => {
  const original = { ...process.env }
  afterEach(() => {
    for (const k of KEYS) delete process.env[k]
    for (const k of KEYS) if (k in original) process.env[k] = original[k] as string
  })

  it('is false when no CI env var is set', async () => {
    expect(await loadIsCI()).toBe(false)
  })

  it.each(KEYS)('is true when %s is set', async (key) => {
    expect(await loadIsCI({ [key]: '1' })).toBe(true)
  })
})
