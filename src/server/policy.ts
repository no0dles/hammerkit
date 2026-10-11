import { Entitlement, Who } from './server-config'
import { Principal } from './oauth'

export interface Grant {
  // admin: the accounts the caller runs on at once and approves runs for
  accounts: string[]
  // the accounts the caller may request runs on, which an admin of the account
  // has to approve; never one the caller is admin of
  request: string[]
  // the account used when a run names none: the first default of a matching
  // entitlement among the accounts the caller has, else the only account
  default: string | null
  // the build files the caller may publish: names, or `*` for any
  publish: string[]
  // where the code may come from; the intersection over the matching entitlements
  // that name one, both when none does
  source: ('upload' | 'ref')[]
  // the entitlements that matched, for the log
  matched: number[]
}

export function matches(entitlement: Who, principal: Principal): boolean {
  if (entitlement.subject) {
    return entitlement.subject.iss === principal.iss && entitlement.subject.sub === principal.sub
  }
  if (entitlement.group) {
    return entitlement.group.iss === principal.iss && principal.groups.includes(entitlement.group.name)
  }
  if (entitlement.claims) {
    return (
      entitlement.claims.iss === principal.iss &&
      Object.entries(entitlement.claims.match).every(([name, value]) => principal.claims[name] === value)
    )
  }
  return false
}

export function mayPublish(grant: Grant, name: string): boolean {
  return grant.publish.includes('*') || grant.publish.includes(name)
}

// A caller who can neither run nor publish anything sees nothing of the server's
// build files either. Admins see them, they have to know what they approve.
export function maySeeDefinitions(grant: Grant): boolean {
  return grant.accounts.length > 0 || grant.request.length > 0 || grant.publish.length > 0
}

// Admin of an account decides about the runs on it.
export function isAdmin(grant: Grant, account: string | null): boolean {
  return account !== null && grant.accounts.includes(account)
}

// Default deny: a caller without a matching entitlement gets no account.
export function getGrant(entitlements: Entitlement[], principal: Principal): Grant {
  const matched: number[] = []
  const accounts: string[] = []
  const requested: string[] = []
  const publish: string[] = []
  let defaultAccount: string | null = null
  let source: ('upload' | 'ref')[] | null = null

  entitlements.forEach((entitlement, index) => {
    if (!matches(entitlement, principal)) {
      return
    }
    matched.push(index)
    for (const account of entitlement.accounts) {
      if (!accounts.includes(account)) {
        accounts.push(account)
      }
    }
    for (const account of entitlement.request ?? []) {
      if (!requested.includes(account)) {
        requested.push(account)
      }
    }
    for (const name of entitlement.publish ?? []) {
      if (!publish.includes(name)) {
        publish.push(name)
      }
    }
    defaultAccount = defaultAccount ?? entitlement.default ?? null
    if (entitlement.source) {
      source = source ? source.filter((s) => entitlement.source?.includes(s)) : [...entitlement.source]
    }
  })

  // admin wins over request when two entitlements give both
  const request = requested.filter((account) => !accounts.includes(account))
  const usable = [...accounts, ...request]
  return {
    accounts,
    request,
    publish,
    default: defaultAccount ?? (usable.length === 1 ? usable[0] : null),
    source: source ?? ['upload', 'ref'],
    matched,
  }
}
