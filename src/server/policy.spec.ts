import {
  canUse,
  decideRun,
  getGrant,
  Grant,
  mayPropose,
  mayPublish,
  mayRun,
  maySeeDefinitions,
  RunDecisionInput,
  usedAccounts,
} from './policy'
import { Principal } from './oauth'
import { Account, Entitlement } from './server-config'

const IDP = 'https://idp.corp'
const GITHUB = 'https://token.actions.githubusercontent.com'

const alice: Principal = { iss: IDP, sub: 'alice', groups: ['eng-web'], claims: {} }

const entitlements: Entitlement[] = [
  { subject: { iss: IDP, sub: 'alice' }, accounts: { 'op-payments-dev': 'use' }, repos: [], builds: 'run' },
  {
    group: { iss: IDP, name: 'eng-web' },
    accounts: { 'op-web-dev': 'use', 'op-payments-dev': 'request' },
    repos: ['github.com/corp/web'],
  },
  {
    claims: { iss: GITHUB, match: { repository: 'corp/payments', ref: 'refs/heads/main' } },
    accounts: { 'op-payments-ci': 'use' },
    repos: ['github.com/corp/payments'],
    builds: 'publish',
  },
]

describe('getGrant', () => {
  it('denies by default', () => {
    const grant = getGrant(entitlements, { iss: IDP, sub: 'bob', groups: [], claims: {} })
    expect(grant).toEqual({ accounts: {}, repos: [], builds: null, matched: [] })
    expect(getGrant([], alice).accounts).toEqual({})
  })

  it('adds up the accounts and repositories of a person and their groups, the higher level wins', () => {
    const grant = getGrant(entitlements, alice)
    expect(grant.accounts).toEqual({ 'op-payments-dev': 'use', 'op-web-dev': 'use' })
    expect(grant.repos).toEqual(['github.com/corp/web'])
    expect(grant.matched).toEqual([0, 1])
    expect(usedAccounts(grant)).toEqual(['op-payments-dev', 'op-web-dev'])
  })

  it('keeps use over request whichever entitlement comes first', () => {
    const order: Entitlement[] = [
      { group: { iss: IDP, name: 'eng-web' }, accounts: { prod: 'use' }, repos: [] },
      { subject: { iss: IDP, sub: 'alice' }, accounts: { prod: 'request' }, repos: [] },
    ]
    expect(getGrant(order, alice).accounts).toEqual({ prod: 'use' })
    expect(getGrant([...order].reverse(), alice).accounts).toEqual({ prod: 'use' })
    expect(canUse(getGrant(order, alice), 'prod')).toBe(true)
    expect(canUse(getGrant([order[1]], alice), 'prod')).toBe(false)
  })

  it('does not take an account of another issuer with the same subject', () => {
    expect(getGrant(entitlements, { ...alice, iss: 'https://evil.example' }).accounts).toEqual({})
  })

  it('matches a CI job by its claims', () => {
    const job: Principal = {
      iss: GITHUB,
      sub: 'repo:corp/payments:ref:refs/heads/main',
      groups: [],
      claims: { repository: 'corp/payments', ref: 'refs/heads/main', actor: 'x' },
    }
    expect(getGrant(entitlements, job)).toMatchObject({
      accounts: { 'op-payments-ci': 'use' },
      repos: ['github.com/corp/payments'],
      builds: 'publish',
      matched: [2],
    })
    expect(getGrant(entitlements, { ...job, claims: { ...job.claims, ref: 'refs/heads/feature' } }).accounts).toEqual(
      {}
    )
    expect(getGrant(entitlements, { ...job, claims: { repository: 'corp/payments' } }).accounts).toEqual({})
  })

  it('takes the highest builds level of the matching entitlements', () => {
    const levels: Entitlement[] = [
      { subject: { iss: IDP, sub: 'alice' }, accounts: {}, repos: [], builds: 'propose' },
      { group: { iss: IDP, name: 'eng-web' }, accounts: {}, repos: [], builds: 'run' },
    ]
    expect(getGrant(levels, alice).builds).toBe('propose')
    expect(getGrant([levels[1], levels[0]], alice).builds).toBe('propose')
  })
})

describe('builds levels', () => {
  const grantOf = (builds: Entitlement['builds']): Grant =>
    getGrant([{ subject: { iss: IDP, sub: 'alice' }, accounts: {}, repos: [], builds }], alice)

  it('includes each level in the next', () => {
    expect([mayRun(grantOf('run')), mayPropose(grantOf('run')), mayPublish(grantOf('run'))]).toEqual([
      true,
      false,
      false,
    ])
    expect([mayRun(grantOf('propose')), mayPropose(grantOf('propose')), mayPublish(grantOf('propose'))]).toEqual([
      true,
      true,
      false,
    ])
    expect([mayRun(grantOf('publish')), mayPropose(grantOf('publish')), mayPublish(grantOf('publish'))]).toEqual([
      true,
      true,
      true,
    ])
  })

  it('does not let an account alone run anything', () => {
    const onlyAccounts = getGrant([{ subject: { iss: IDP, sub: 'alice' }, accounts: { a: 'use' }, repos: [] }], alice)
    expect(mayRun(onlyAccounts)).toBe(false)
    expect(mayPublish(onlyAccounts)).toBe(false)
  })

  it('shows the build files to who has a builds level or an account, and to nobody else', () => {
    expect(maySeeDefinitions(getGrant([], alice))).toBe(false)
    expect(maySeeDefinitions(grantOf('run'))).toBe(true)
    expect(
      maySeeDefinitions(
        getGrant([{ subject: { iss: IDP, sub: 'alice' }, accounts: { a: 'request' }, repos: [] }], alice)
      )
    ).toBe(true)
  })
})

describe('decideRun', () => {
  const catalog: { [name: string]: Account } = {
    ci: { providers: {} },
    dev: { providers: {} },
    prod: { providers: {}, source: ['ref'], refs: ['main', 'release/*'] },
  }
  const grantOf = (accounts: Grant['accounts'], builds: Grant['builds'] = 'run'): Grant => ({
    accounts,
    repos: [],
    builds,
    matched: [0],
  })
  const base = (over: Partial<RunDecisionInput>): RunDecisionInput => ({
    grant: grantOf({ ci: 'use', dev: 'use', prod: 'request' }),
    accounts: [],
    catalog,
    source: { type: 'ref', ref: 'main' },
    approvable: () => true,
    ...over,
  })
  const refuse = (status: number, error: RegExp) => ({ type: 'refuse', status, error: expect.stringMatching(error) })

  const table: [string, Partial<RunDecisionInput>, object][] = [
    ['a task without secrets needs no account', {}, { type: 'run' }],
    ['an account the caller uses runs at once', { accounts: ['dev'] }, { type: 'run' }],
    ['an account the caller can only request waits', { accounts: ['prod'] }, { type: 'approval', accounts: ['prod'] }],
    ['only the requested accounts wait', { accounts: ['dev', 'prod'] }, { type: 'approval', accounts: ['prod'] }],
    [
      'an account the caller has no level on is refused, by name',
      { accounts: ['other'] },
      refuse(403, /account other/),
    ],
    [
      'no builds level means nothing runs',
      { grant: grantOf({ dev: 'use' }, null), accounts: ['dev'] },
      refuse(403, /not entitled/),
    ],
    ['an upload is not supported yet', { source: { type: 'upload' } }, refuse(501, /upload/)],
    [
      'an account that takes only a ref refuses an upload',
      { accounts: ['prod'], source: { type: 'upload' } },
      refuse(501, /upload/),
    ],
    [
      'a branch the account allows',
      { accounts: ['prod'], source: { type: 'ref', ref: 'release/1.2' } },
      { type: 'approval', accounts: ['prod'] },
    ],
    [
      'a branch the account does not allow',
      { accounts: ['prod'], source: { type: 'ref', ref: 'feature' } },
      refuse(403, /only used by runs from main, release\/\*/),
    ],
    [
      'a commit names no branch, so an account with refs refuses it',
      { accounts: ['prod'], source: { type: 'ref', ref: 'a'.repeat(40) } },
      refuse(403, /only used by runs from/),
    ],
    [
      'a commit is fine for an account without refs',
      { accounts: ['dev'], source: { type: 'ref', ref: 'a'.repeat(40) } },
      { type: 'run' },
    ],
    [
      'a request nobody can approve is refused at once',
      { accounts: ['prod'], approvable: () => false },
      refuse(409, /nobody can approve prod/),
    ],
  ]

  it.each(table)('%s', (_name, input, expected) => {
    expect(decideRun(base(input))).toEqual(expected)
  })

  it('refuses an account that restricts its source', () => {
    const decision = decideRun(
      base({
        grant: grantOf({ prod: 'use' }),
        accounts: ['prod'],
        catalog: { prod: { providers: {}, source: ['upload'] } },
        source: { type: 'ref', ref: 'main' },
      })
    )
    expect(decision).toEqual(refuse(403, /not used by runs from ref/))
  })
})
