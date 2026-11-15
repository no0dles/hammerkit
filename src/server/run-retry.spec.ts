import { Run } from './runs'
import { getRetryRequest } from './run-retry'

const run: Run = {
  id: 'run_aaaaaaaaaaaaaaaa',
  owner: { iss: 'https://idp.corp', sub: 'alice' },
  state: 'failed',
  createdAt: '2026-11-14T10:00:00.000Z',
  definition: 'sha256:' + 'a'.repeat(64),
  tasks: ['test'],
  accounts: ['ci'],
  source: { type: 'ref', repo: 'github.com/corp/payments', ref: 'main', commit: 'c'.repeat(40) },
  options: { args: ['--grep', 'flaky'], cache: 'none' },
}

describe('getRetryRequest', () => {
  it('asks for what the run asked for, at the commit it ran, and never for its accounts', () => {
    expect(getRetryRequest(run, false)).toEqual({
      request: {
        definition: run.definition,
        tasks: ['test'],
        source: { type: 'ref', repo: 'github.com/corp/payments', ref: 'main', commit: 'c'.repeat(40) },
        options: { args: ['--grep', 'flaky'], cache: 'none' },
        services: [],
        endpoints: [],
      },
    })
  })

  it('starts a service run again with its services, name, endpoints and how long they stay', () => {
    const service: Run = {
      ...run,
      tasks: [],
      options: {},
      state: 'cancelled',
      up: {
        services: ['web', 'db'],
        ttl: 2 * 60 * 60 * 1000,
        sleepTtl: 15 * 60 * 1000,
        name: 'pr-7',
        endpoints: [{ service: 'web', port: 8080, host: 'pr-7-web-alice', url: 'https://pr-7-web-alice.example' }],
      },
    }
    expect(getRetryRequest(service, true)).toEqual({
      request: {
        definition: run.definition,
        tasks: [],
        source: run.source,
        options: {},
        services: ['web', 'db'],
        ttl: '7200000ms',
        sleepTtl: '900000ms',
        name: 'pr-7',
        // the hosts are those of who retries it, never the ones of the run
        endpoints: [{ service: 'web', port: 8080 }],
      },
    })
  })

  it('retries a run on a sandbox, a check as a check, for its owner only', () => {
    const sandbox: Run = {
      ...run,
      options: {},
      source: {
        type: 'sandbox',
        id: 'sbx_aaaaaaaaaaaaaaaa',
        repo: 'github.com/corp/payments',
        commit: 'c'.repeat(40),
        tree: 't'.repeat(40),
        check: true,
      },
    }
    expect(getRetryRequest(sandbox, true)).toMatchObject({
      request: { source: { type: 'sandbox', id: 'sbx_aaaaaaaaaaaaaaaa', check: true } },
    })
    expect(getRetryRequest(sandbox, false)).toEqual({
      error: 'run_aaaaaaaaaaaaaaaa ran from a sandbox of its owner, only they may retry it',
    })
  })

  it('refuses a run that is not over, and one of uploaded files', () => {
    for (const state of ['awaiting-approval', 'queued', 'running', 'up', 'asleep'] as const) {
      expect(getRetryRequest({ ...run, state }, true)).toEqual({
        error: `run_aaaaaaaaaaaaaaaa is ${state}, a run is retried once it is over`,
      })
    }
    expect(getRetryRequest({ ...run, source: { type: 'upload', snapshot: 'sha256:' + 'b'.repeat(64) } }, true)).toEqual(
      {
        error: 'run_aaaaaaaaaaaaaaaa ran from uploaded files, which a run is not retried from',
      }
    )
  })
})
