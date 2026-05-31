import { environmentMock } from './environment-mock'

describe('environmentMock', () => {
  it('returns an Environment with the given cwd and silent streams', () => {
    const env = environmentMock('/tmp/x')
    expect(env.cwd).toBe('/tmp/x')
    expect(env.file).toBeDefined()
    expect(env.console).toBeDefined()
    expect(env.status).toBeDefined()
    expect(env.stdout).toBeDefined()
    expect(env.stderr).toBeDefined()
    expect(env.abortCtrl).toBeInstanceOf(AbortController)
    expect(env.processEnvs).toEqual({})
    expect(env.stdoutColumns).toBe(80)
    // writing to silent streams must not throw
    env.stdout.write('hello\n')
    env.stderr.write('world\n')
    env.console.info('info')
  })
})
