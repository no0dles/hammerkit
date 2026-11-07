import type { ListedRun, Overview } from '../server/overview'
import { describeOverview, describeWait } from './remote-status'

const base = {
  definition: 'sha256:' + 'a'.repeat(64),
  accounts: [],
  source: { type: 'ref' as const, repo: 'github.com/corp/x', ref: 'main', commit: 'c'.repeat(40) },
  createdAt: '2026-11-07T09:00:00.000Z',
}

const run = (id: string, extra: Partial<ListedRun>): ListedRun => ({
  ...base,
  id,
  tasks: ['build'],
  state: 'running',
  ...extra,
})

describe('remote status', () => {
  it('says what holds each queued run, naming a run only when it is given', () => {
    expect(describeWait({ type: 'own-limit', running: 2, limit: 2 }, true)).toBe(
      'your limit of running runs, 2 of 2 (runs.limits.running)'
    )
    expect(describeWait({ type: 'own-limit', running: 2, limit: 2 }, false)).toBe(
      'its owner’s limit of running runs, 2 of 2 (runs.limits.running)'
    )
    expect(describeWait({ type: 'place', used: 4, max: 4 }, false)).toBe(
      'no free place, 4 of 4 taken (runs.maxConcurrent)'
    )
    expect(describeWait({ type: 'sandbox', run: 'run_a' }, true)).toBe('its sandbox runs run_a')
    expect(describeWait({ type: 'sandbox' }, true)).toBe('another run works on its sandbox')
    expect(describeWait({ type: 'held', run: 'run_b' }, true)).toBe('run_b holds what it needs')
    expect(describeWait({ type: 'held' }, true)).toBe('another run holds what it needs')
    expect(describeWait({ type: 'starting' }, true)).toBe('starts now')
  })

  it('prints the places, the queue, the service runs and the limits, and what a task name hides', () => {
    const overview: Overview = {
      you: { iss: 'https://idp', sub: 'alice', observe: false },
      places: {
        max: 4,
        used: 4,
        runs: [run('run_mine', { tasks: ['test', 'lint'], startedAt: '2026-11-07T09:01:00.000Z' })],
        others: 2,
      },
      queue: [
        {
          position: 1,
          mine: true,
          run: run('run_next', { tasks: ['deploy\u001b[2J'], state: 'queued' }),
          waitsFor: { type: 'own-limit', running: 1, limit: 1 },
        },
        { position: 2, mine: false, waitsFor: { type: 'place', used: 4, max: 4 } },
      ],
      approvals: {
        waiting: 1,
        max: 100,
        runs: [
          run('run_ask', {
            state: 'awaiting-approval',
            owner: { iss: 'https://idp', sub: 'bob' },
            approvals: [{ account: 'prod', expiresAt: '2026-11-07T10:00:00.000Z' }],
          }),
        ],
      },
      services: {
        open: 3,
        max: 10,
        runs: [
          run('run_web', {
            tasks: [],
            state: 'up',
            expiresAt: '2026-11-07T17:00:00.000Z',
            sleepsAt: '2026-11-07T09:30:00.000Z',
            up: {
              name: 'pr-42',
              services: ['web'],
              ttl: 1,
              endpoints: [{ service: 'web', port: 80, host: 'pr-42-80-abc', url: 'https://pr-42-80-abc.example' }],
            },
          }),
        ],
      },
      limits: {
        waiting: { used: 0, limit: 10, runs: [] },
        queued: { used: 1, limit: 20, runs: ['run_next'] },
        running: { used: 1, limit: 1, runs: ['run_mine'] },
        services: { used: 1, limit: 3, runs: ['run_web'] },
      },
    }
    const lines = describeOverview('hk', overview, Date.parse('2026-11-07T09:05:00.000Z'))
    expect(lines.slice(0, 9)).toEqual([
      'hk: signed in as alice',
      'places: 4 of 4 taken (runs.maxConcurrent)',
      '  run_mine  test, lint  since 2026-11-07T09:01:00.000Z, 4m',
      '  2 runs of others',
      '  1 taken by no running run',
      'queue: 2',
      '  1. run_next  deploy?[2J  waits: your limit of running runs, 1 of 1 (runs.limits.running)',
      '  2. a run of somebody else  waits: no free place, 4 of 4 taken (runs.maxConcurrent)',
      'waiting for an approval: 1 of at most 100',
    ])
    expect(lines).toContain('  run_ask  build of bob  needs prod until 2026-11-07T10:00:00.000Z')
    expect(lines).toContain('service runs: 3 of 10 on the server')
    expect(lines).toContain(
      '  run_web  up  pr-42: up web  until 2026-11-07T17:00:00.000Z, sleeps at 2026-11-07T09:30:00.000Z'
    )
    expect(lines).toContain('    web:80  https://pr-42-80-abc.example')
    const running = lines.find((line) => line.startsWith('  running'))
    expect(running).toMatch(/^ {2}running {3}1 of 1 {4}run_mine/)
    expect(running).toContain('full')
    expect(lines.find((line) => line.startsWith('  queued'))).not.toContain('full')
  })
})
