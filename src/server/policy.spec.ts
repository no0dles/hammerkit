import { getGrant } from './policy'
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
    expect(grant).toEqual({ accounts: [], default: null, source: ['upload', 'ref'], matched: [] })
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
})
