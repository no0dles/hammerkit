import { Entitlement } from './server-config'
import { Principal } from './oauth'

export interface Grant {
  accounts: string[]
  // the account used when a run names none: the first default of a matching
  // entitlement among the accounts the caller has, else the only account
  default: string | null
  // where the code may come from; the intersection over the matching entitlements
  // that name one, both when none does
  source: ('upload' | 'ref')[]
  // the entitlements that matched, for the log
  matched: number[]
}

function matches(entitlement: Entitlement, principal: Principal): boolean {
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

// Default deny: a caller without a matching entitlement gets no account.
export function getGrant(entitlements: Entitlement[], principal: Principal): Grant {
  const matched: number[] = []
  const accounts: string[] = []
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
    defaultAccount = defaultAccount ?? entitlement.default ?? null
    if (entitlement.source) {
      source = source ? source.filter((s) => entitlement.source?.includes(s)) : [...entitlement.source]
    }
  })

  return {
    accounts,
    default: defaultAccount ?? (accounts.length === 1 ? accounts[0] : null),
    source: source ?? ['upload', 'ref'],
    matched,
  }
}
