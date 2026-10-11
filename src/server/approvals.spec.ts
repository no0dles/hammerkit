import { approvesAnything, executedBy, isApprover, matchesPattern, rulesFor } from './approvals'
import { DefinitionGraph } from './definitions'
import { Principal } from './oauth'
import { ApprovalRule, serverConfigSchema } from './server-config'

const IDP = 'https://idp.corp'

const graph: DefinitionGraph = {
  build: { kind: 'task', labels: {}, depends: [] },
  test: { kind: 'task', labels: {}, depends: ['build'] },
  'deploy:prod': { kind: 'task', labels: { env: ['production'] }, depends: ['test', 'db'] },
  'deploy:dev': { kind: 'task', labels: { env: ['dev'] }, depends: ['test'] },
  release: { kind: 'task', labels: {}, depends: ['deploy:prod'] },
  db: { kind: 'service', labels: { tier: ['data'] }, depends: [] },
}

const rules: ApprovalRule[] = [
  { name: 'production', labels: { env: 'production' }, approvers: [{ group: { iss: IDP, name: 'release-managers' } }] },
  { name: 'deploys', tasks: ['deploy:*'], approvers: [{ subject: { iss: IDP, sub: 'bob' } }] },
  { name: 'data', labels: { tier: ['data', 'secret'] }, approvers: [{ subject: { iss: IDP, sub: 'dba' } }] },
]

const principal = (sub: string, groups: string[] = []): Principal => ({ iss: IDP, sub, groups, claims: {} })

describe('matchesPattern', () => {
  it('matches the name as written, and * for any characters', () => {
    expect(matchesPattern('deploy', 'deploy')).toBe(true)
    expect(matchesPattern('deploy', 'deploy:prod')).toBe(false)
    expect(matchesPattern('deploy:*', 'deploy:prod')).toBe(true)
    expect(matchesPattern('*:prod', 'api:deploy:prod')).toBe(true)
    expect(matchesPattern('*', 'anything')).toBe(true)
  })

  it('takes everything else literally', () => {
    expect(matchesPattern('a.b', 'axb')).toBe(false)
    expect(matchesPattern('a(b)', 'a(b)')).toBe(true)
    expect(matchesPattern('^deploy$', 'deploy')).toBe(false)
  })
})

describe('executedBy', () => {
  it('follows what a task needs first, once', () => {
    expect(executedBy(graph, ['release']).sort()).toEqual(['build', 'db', 'deploy:prod', 'release', 'test'])
    expect(executedBy(graph, ['build'])).toEqual(['build'])
  })

  it('stops at a cycle and at a name the build file does not know', () => {
    const cyclic: DefinitionGraph = {
      a: { kind: 'task', labels: {}, depends: ['b'] },
      b: { kind: 'task', labels: {}, depends: ['a', 'gone'] },
    }
    expect(executedBy(cyclic, ['a']).sort()).toEqual(['a', 'b', 'gone'])
  })

  it('takes every task for a run that names none', () => {
    expect(executedBy(graph, []).sort()).toEqual(Object.keys(graph).sort())
  })
})

describe('rulesFor', () => {
  it('finds nothing for a run that touches no rule', () => {
    expect(rulesFor(rules, graph, ['build'], null)).toEqual([])
    expect(rulesFor(rules, graph, ['deploy:dev'], null)).toEqual([1])
    expect(rulesFor([], graph, ['release'], null)).toEqual([])
  })

  it('matches tasks by name and by label', () => {
    expect(rulesFor(rules, graph, ['deploy:prod'], null)).toEqual([0, 1, 2])
    expect(rulesFor(rules, graph, ['db'], null)).toEqual([2])
  })

  it('counts what a task needs first, so a harmless name does not hide a rule', () => {
    expect(rulesFor(rules, graph, ['release'], null)).toEqual([0, 1, 2])
  })

  it('applies to every task when the run selects by labels', () => {
    expect(rulesFor(rules, graph, [], null)).toEqual([0, 1, 2])
  })

  it('holds every run of an account, whatever the build file says about its tasks', () => {
    const guarded: ApprovalRule[] = [
      ...rules,
      { name: 'prod key', accounts: ['op-prod-*'], approvers: [{ subject: { iss: IDP, sub: 'bob' } }] },
    ]
    expect(rulesFor(guarded, graph, ['build'], 'op-prod-deploy')).toEqual([3])
    expect(rulesFor(guarded, graph, ['build'], 'op-dev')).toEqual([])
    expect(rulesFor(guarded, graph, ['build'], null)).toEqual([])
    expect(rulesFor(guarded, graph, [], 'op-prod-deploy')).toEqual([0, 1, 2, 3])
  })

  it('does not hold a task a build file labels differently or renames: only an account is out of its reach', () => {
    const unlabelled = { ...graph, 'deploy:prod': { kind: 'task' as const, labels: {}, depends: ['test', 'db'] } }
    // dropping the label takes the label rule away from the task
    expect(rulesFor(rules, unlabelled, ['deploy:prod'], null)).toEqual([1, 2])
    // and so does a name the rules do not know
    const renamed = { ...graph, ship: { kind: 'task' as const, labels: {}, depends: ['test'] } }
    expect(rulesFor(rules, renamed, ['ship'], null)).toEqual([])
    // the account of the run is not in the build file
    const guarded: ApprovalRule[] = [
      { name: 'prod key', accounts: ['op-prod'], approvers: [{ subject: { iss: IDP, sub: 'bob' } }] },
    ]
    expect(rulesFor(guarded, renamed, ['ship'], 'op-prod')).toEqual([0])
    expect(rulesFor(guarded, unlabelled, ['deploy:prod'], 'op-prod')).toEqual([0])
  })
})

describe('approvers', () => {
  it('knows a person, a group and who is neither', () => {
    expect(isApprover(rules[0], principal('carol', ['release-managers']))).toBe(true)
    expect(isApprover(rules[0], principal('carol', ['eng']))).toBe(false)
    expect(isApprover(rules[1], principal('bob'))).toBe(true)
    expect(isApprover(rules[1], { ...principal('bob'), iss: 'https://evil.example' })).toBe(false)
    expect(approvesAnything(rules, principal('dba'))).toBe(true)
    expect(approvesAnything(rules, principal('mallory'))).toBe(false)
  })
})

describe('approval config', () => {
  const base = {
    issuers: [{ issuer: IDP, audience: 'hammerkit' }],
    approvals: { rules: [{ name: 'prod', tasks: ['deploy'], approvers: [{ subject: { iss: IDP, sub: 'bob' } }] }] },
  }
  const parse = (approvals: unknown) => serverConfigSchema.safeParse({ ...base, approvals })

  it('takes rules, a timeout and a limit, with defaults', () => {
    const result = serverConfigSchema.parse(base)
    expect(result.approvals).toMatchObject({ timeout: '1h', maxWaiting: 100 })
    expect(parse({ ...base.approvals, timeout: '30m', maxWaiting: 5 }).success).toBe(true)
    expect(serverConfigSchema.parse({ issuers: base.issuers }).approvals.rules).toEqual([])
  })

  it.each([
    [
      { rules: [{ name: 'a', approvers: [{ subject: { iss: IDP, sub: 'bob' } }] }] },
      'name the accounts, tasks or labels',
    ],
    [{ rules: [{ name: 'a', tasks: ['x'], approvers: [] }] }, 'approvers'],
    [{ rules: [{ name: 'a', tasks: ['x'], approvers: [{}] }] }, 'exactly one of subject, group or claims'],
    [
      { rules: [{ name: 'a', tasks: ['x'], approvers: [{ subject: { iss: 'https://other.corp', sub: 'bob' } }] }] },
      'is not one of the accepted issuers',
    ],
    [
      {
        rules: [
          { name: 'a', tasks: ['x'], approvers: [{ subject: { iss: IDP, sub: 'bob' } }] },
          { name: 'a', tasks: ['y'], approvers: [{ subject: { iss: IDP, sub: 'bob' } }] },
        ],
      },
      'used twice',
    ],
    [{ timeout: 'soon', rules: [] }, 'expected a duration'],
    [{ maxWaiting: 0, rules: [] }, 'greater than or equal to 1'],
  ])('refuses %j', (approvals, message) => {
    const result = parse(approvals)
    expect(result.success).toBe(false)
    expect(JSON.stringify((result as { error: unknown }).error)).toContain(message)
  })
})
