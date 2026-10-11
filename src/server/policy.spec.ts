import { getGrant, isAdmin, mayPublish, maySeeDefinitions } from './policy'
import { Principal } from './oauth'
import { Entitlement } from './server-config'

const IDP = 'https://idp.corp'
const GITHUB = 'https://token.actions.githubusercontent.com'

const alice: Principal = { iss: IDP, sub: 'alice', groups: ['eng-web'], claims: {} }

const entitlements: Entitlement[] = [
  { subject: { iss: IDP, sub: 'alice' }, accounts: ['op-payments-dev'], default: 'op-payments-dev' },
  { group: { iss: IDP, name: 'eng-web' }, accounts: ['op-web-dev', 'op-payments-dev'] },
  {
    claims: { iss: GITHUB, match: { repository: 'corp/payments', ref: 'refs/heads/main' } },
    accounts: ['op-payments-ci'],
    source: ['ref'],
  },
]

describe('getGrant', () => {
  it('denies by default', () => {
    const grant = getGrant(entitlements, { iss: IDP, sub: 'bob', groups: [], claims: {} })
    expect(grant).toEqual({
      accounts: [],
      request: [],
      publish: [],
      default: null,
      source: ['upload', 'ref'],
      matched: [],
    })
    expect(getGrant([], alice).accounts).toEqual([])
  })

  it('adds up the accounts of a person and their groups', () => {
    const grant = getGrant(entitlements, alice)
    expect(grant.accounts).toEqual(['op-payments-dev', 'op-web-dev'])
    expect(grant.default).toBe('op-payments-dev')
    expect(grant.matched).toEqual([0, 1])
  })

  it('does not take an account of another issuer with the same subject', () => {
    expect(getGrant(entitlements, { ...alice, iss: 'https://evil.example' }).accounts).toEqual([])
  })

  it('has no default when several accounts are possible and none is marked', () => {
    const grant = getGrant([entitlements[1]], alice)
    expect(grant.accounts).toEqual(['op-web-dev', 'op-payments-dev'])
    expect(grant.default).toBeNull()
  })

  it('uses the only account as the default', () => {
    expect(getGrant([{ subject: { iss: IDP, sub: 'alice' }, accounts: ['one'] }], alice).default).toBe('one')
  })

  it('matches a CI job by its claims and limits where the code may come from', () => {
    const job: Principal = {
      iss: GITHUB,
      sub: 'repo:corp/payments:ref:refs/heads/main',
      groups: [],
      claims: { repository: 'corp/payments', ref: 'refs/heads/main', actor: 'x' },
    }
    expect(getGrant(entitlements, job)).toMatchObject({ accounts: ['op-payments-ci'], source: ['ref'], matched: [2] })
    expect(getGrant(entitlements, { ...job, claims: { ...job.claims, ref: 'refs/heads/feature' } }).accounts).toEqual(
      []
    )
    expect(getGrant(entitlements, { ...job, claims: { repository: 'corp/payments' } }).accounts).toEqual([])
  })

  it('keeps only the source every matching entitlement allows', () => {
    const both: Entitlement[] = [
      { subject: { iss: IDP, sub: 'alice' }, accounts: ['a'], source: ['upload', 'ref'] },
      { group: { iss: IDP, name: 'eng-web' }, accounts: ['b'], source: ['ref'] },
    ]
    expect(getGrant(both, alice).source).toEqual(['ref'])
  })

  it('adds up what may be published, separately from the accounts', () => {
    const both: Entitlement[] = [
      { subject: { iss: IDP, sub: 'alice' }, accounts: [], publish: ['payments'] },
      { group: { iss: IDP, name: 'eng-web' }, accounts: ['b'], publish: ['web', 'payments'] },
    ]
    const grant = getGrant(both, alice)
    expect(grant.publish).toEqual(['payments', 'web'])
    expect(mayPublish(grant, 'web')).toBe(true)
    expect(mayPublish(grant, 'other')).toBe(false)
    const onlyAccounts = getGrant([{ subject: { iss: IDP, sub: 'alice' }, accounts: ['a'] }], alice)
    expect(onlyAccounts.publish).toEqual([])
    expect(mayPublish(onlyAccounts, 'payments')).toBe(false)
  })

  it('lets publish everything with a star', () => {
    const grant = getGrant([{ subject: { iss: IDP, sub: 'alice' }, accounts: [], publish: ['*'] }], alice)
    expect(mayPublish(grant, 'anything')).toBe(true)
  })

  it('shows the build files to who can run or publish, and to nobody else', () => {
    expect(maySeeDefinitions(getGrant([], alice))).toBe(false)
    expect(maySeeDefinitions(getGrant([{ subject: { iss: IDP, sub: 'alice' }, accounts: ['a'] }], alice))).toBe(true)
    expect(
      maySeeDefinitions(getGrant([{ subject: { iss: IDP, sub: 'alice' }, accounts: [], publish: ['x'] }], alice))
    ).toBe(true)
  })

  it('shows them to somebody who may only request runs', () => {
    expect(
      maySeeDefinitions(getGrant([{ subject: { iss: IDP, sub: 'alice' }, accounts: [], request: ['a'] }], alice))
    ).toBe(true)
  })
})

describe('request and admin', () => {
  const bob: Principal = { iss: IDP, sub: 'bob', groups: ['devs', 'ops'], claims: {} }
  const both: Entitlement[] = [
    { group: { iss: IDP, name: 'devs' }, accounts: [], request: ['prod', 'dev'], default: 'prod' },
    { group: { iss: IDP, name: 'ops' }, accounts: ['prod'] },
  ]

  it('keeps the two modes apart', () => {
    const grant = getGrant([both[0]], bob)
    expect(grant.accounts).toEqual([])
    expect(grant.request).toEqual(['prod', 'dev'])
    expect(grant.default).toBe('prod')
    expect(isAdmin(grant, 'prod')).toBe(false)
  })

  it('lets admin win where an account is given in both', () => {
    const grant = getGrant(both, bob)
    expect(grant.accounts).toEqual(['prod'])
    expect(grant.request).toEqual(['dev'])
    expect(isAdmin(grant, 'prod')).toBe(true)
    expect(isAdmin(grant, 'dev')).toBe(false)
    expect(isAdmin(grant, null)).toBe(false)
  })

  it('takes the only account as default whichever the mode', () => {
    expect(getGrant([{ subject: { iss: IDP, sub: 'bob' }, accounts: [], request: ['prod'] }], bob).default).toBe('prod')
  })
})
