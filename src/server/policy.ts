import { Account, AccountLevel, BuildsLevel, Entitlement, Who } from './server-config'
import { Principal } from './oauth'
import { matchesAnyRepo, matchesRef } from './repo'

export interface Grant {
  // the accounts the caller has and how; `use` wins over `request` when two
  // entitlements give both
  accounts: { [account: string]: AccountLevel }
  // the repositories (patterns) the caller may run from a git ref
  repos: string[]
  // what the caller may do with the build files, null for nothing
  builds: BuildsLevel | null
  // may keep sandboxes of `repos`
  sandboxes: boolean
  // the entitlements that matched, for the log
  matched: number[]
}

const BUILDS_ORDER: BuildsLevel[] = ['run', 'propose', 'publish']

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

function atLeast(grant: Grant, level: BuildsLevel): boolean {
  return grant.builds !== null && BUILDS_ORDER.indexOf(grant.builds) >= BUILDS_ORDER.indexOf(level)
}

export const mayRun = (grant: Grant): boolean => atLeast(grant, 'run')
export const mayPropose = (grant: Grant): boolean => atLeast(grant, 'propose')
export const mayPublish = (grant: Grant): boolean => atLeast(grant, 'publish')

// A caller who can neither run nor publish anything sees nothing of the server's
// build files either. Someone who uses an account sees them: they have to know what
// they approve.
export function maySeeDefinitions(grant: Grant): boolean {
  return grant.builds !== null || Object.keys(grant.accounts).length > 0
}

// `use` includes deciding about the runs others request on the account.
export function canUse(grant: Grant, account: string): boolean {
  return grant.accounts[account] === 'use'
}

// Pulling a version back is a safe thing to do, so it is open to who publishes the build
// file, and to who uses an account the version works with: they are the ones who
// answer for what runs as it.
export function mayYank(grant: Grant, version: { accounts?: string[] }): boolean {
  return mayPublish(grant) || (version.accounts ?? []).some((account) => canUse(grant, account))
}

export function usedAccounts(grant: Grant): string[] {
  return Object.keys(grant.accounts).filter((account) => grant.accounts[account] === 'use')
}

// Default deny: a caller without a matching entitlement gets nothing.
export function getGrant(entitlements: Entitlement[], principal: Principal): Grant {
  const matched: number[] = []
  const accounts: Grant['accounts'] = {}
  const repos: string[] = []
  let builds: BuildsLevel | null = null
  let sandboxes = false

  entitlements.forEach((entitlement, index) => {
    if (!matches(entitlement, principal)) {
      return
    }
    matched.push(index)
    for (const [account, level] of Object.entries(entitlement.accounts)) {
      if (accounts[account] !== 'use') {
        accounts[account] = level
      }
    }
    for (const repo of entitlement.repos) {
      if (!repos.includes(repo)) {
        repos.push(repo)
      }
    }
    if (
      entitlement.builds &&
      (builds === null || BUILDS_ORDER.indexOf(entitlement.builds) > BUILDS_ORDER.indexOf(builds))
    ) {
      builds = entitlement.builds
    }
    sandboxes = sandboxes || entitlement.sandboxes === true
  })
  return { accounts, repos, builds, sandboxes, matched }
}

export type SubmittedSource =
  | { type: 'ref'; repo: string; ref: string }
  | { type: 'upload' }
  // a sandbox of the caller's, of this repository
  | { type: 'sandbox'; repo: string }

// Whether the caller may create a sandbox of a repository: `sandboxes: true` and the
// repository in their `repos`, and the server able to read it. The answer is the
// reason when not.
export function decideSandbox(
  grant: Grant,
  repo: string,
  readable: (repo: string) => boolean
): { status: 400 | 403; error: string } | null {
  if (!grant.sandboxes) {
    return { status: 403, error: 'you are not entitled to keep sandboxes on this server' }
  }
  return checkRepo(grant, repo, readable, 'keep a sandbox of')
}

// the caller's own list first: what they may not name is not told whether the server can read it
function checkRepo(
  grant: Grant,
  repo: string,
  readable: (repo: string) => boolean,
  what: string
): { status: 400 | 403; error: string } | null {
  if (!matchesAnyRepo(grant.repos, repo)) {
    return {
      status: 403,
      error:
        grant.repos.length > 0
          ? `you may not ${what} ${repo}, your repositories are ${grant.repos.join(', ')}`
          : `you may not ${what} ${repo}, no entitlement of yours lists a repository`,
    }
  }
  if (!readable(repo)) {
    return { status: 400, error: `this server can not read ${repo}` }
  }
  return null
}

export interface RunDecisionInput {
  grant: Grant
  // the accounts the run uses, derived from the secrets of the tasks it executes
  accounts: string[]
  // the accounts of the server
  catalog: { [name: string]: Account }
  source: SubmittedSource
  // whether anyone could approve a request on the account
  approvable: (account: string) => boolean
  // whether the server can read a repository at all
  readable: (repo: string) => boolean
}

export type RunDecision =
  | { type: 'run' }
  // the accounts the caller may only request, which somebody who uses them approves
  | { type: 'approval'; accounts: string[] }
  | { type: 'refuse'; status: 400 | 403 | 409 | 501; error: string }

const COMMIT = /^[0-9a-f]{40}([0-9a-f]{24})?$/i

// The single place that decides what happens to a run that was submitted: it
// starts, waits for an approval, or is refused with the reason.
export function decideRun(input: RunDecisionInput): RunDecision {
  const { grant, accounts, catalog, source, approvable, readable } = input
  if (!mayRun(grant)) {
    return { type: 'refuse', status: 403, error: 'you are not entitled to run anything on this server' }
  }
  if (source.type === 'upload') {
    return {
      type: 'refuse',
      status: 501,
      error: 'runs from an upload are not supported by this server yet, use a git ref',
    }
  }
  if (source.type === 'sandbox' && !grant.sandboxes) {
    return { type: 'refuse', status: 403, error: 'you are not entitled to keep sandboxes on this server' }
  }
  const repoProblem = checkRepo(grant, source.repo, readable, 'run from')
  if (repoProblem) {
    return { type: 'refuse', ...repoProblem }
  }
  const request: string[] = []
  for (const account of accounts) {
    const level = grant.accounts[account]
    if (level === undefined) {
      return { type: 'refuse', status: 403, error: `you may not use the account ${account}, it needs use or request` }
    }
    const rules = catalog[account]
    // a sandbox holds changes nobody reviewed: an account takes its runs only when it says so
    const sources = rules?.source ?? ['ref', 'upload']
    if (!sources.includes(source.type)) {
      return { type: 'refuse', status: 403, error: `the account ${account} is not used by runs from ${source.type}` }
    }
    if (rules?.refs && source.type === 'ref') {
      if (COMMIT.test(source.ref) || !matchesRef(rules.refs, source.ref)) {
        return {
          type: 'refuse',
          status: 403,
          error: `the account ${account} is only used by runs from ${rules.refs.join(', ')}`,
        }
      }
    }
    if (level === 'request') {
      if (!approvable(account)) {
        return { type: 'refuse', status: 409, error: `nobody can approve ${account}, no entitlement uses it` }
      }
      request.push(account)
    }
  }
  return request.length > 0 ? { type: 'approval', accounts: request } : { type: 'run' }
}
