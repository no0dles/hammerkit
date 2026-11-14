import { describe, expect, it } from 'vitest'
import { runEnvironment } from './run-environment'
import { serverConfigSchema } from './server-config'

const issuers = [{ issuer: 'https://idp.corp', audience: 'hammerkit' }]

describe('the environment of the runs of a server', () => {
  it('passes the listed variables of the server and the fixed ones', () => {
    const config = serverConfigSchema.parse({ issuers, runs: { env: { allow: ['PATH'], set: { CI: 'true' } } } })
    expect(runEnvironment(config, { PATH: '/bin', SECRET: 'x' })).toEqual({ PATH: '/bin', CI: 'true' })
  })

  it('refuses a variable of what a run is from, in any case: it is the run', () => {
    for (const env of [
      { set: { HAMMERKIT_RUN_SANDBOX: 'x' } },
      { set: { hammerkit_run_ref: 'x' } },
      { allow: ['HAMMERKIT_RUN_COMMIT'] },
    ]) {
      expect(() => serverConfigSchema.parse({ issuers, runs: { env } })).toThrow('is set by the server for each run')
    }
  })

  it('passes none of them however the config came to name them', () => {
    const config = serverConfigSchema.parse({ issuers, runs: { env: { allow: ['PATH'] } } })
    config.runs.env.allow.push('HAMMERKIT_RUN_REF')
    config.runs.env.set = { HAMMERKIT_RUN_SANDBOX: 'x' }
    expect(runEnvironment(config, { PATH: '/bin', HAMMERKIT_RUN_REF: 'main' })).toEqual({ PATH: '/bin' })
  })
})
