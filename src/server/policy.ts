import { Account, AccountLevel, BuildsLevel, Entitlement, SandboxBranchType, SandboxGrant, Who } from './server-config'
import { Principal } from './oauth'
import { matchesAnyRepo, matchesRef, matchesRepo } from './repo'

export interface Grant {
  // the accounts the caller has and how; `use` wins over `request` when two
  // entitlements give both
  accounts: { [account: string]: AccountLevel }
  // the repositories (patterns) the caller may run from a git ref
  repos: string[]
  // what the caller may do with the build files, null for nothing
  builds: BuildsLevel | null
  // the repositories (patterns) the caller may keep sandboxes of, with a type per branch
  // pattern: the entries of the `sandboxes` of their entitlements, one per repository
  // pattern with the higher type of a branch pattern two of them name; none for no sandboxes
  sandboxes: SandboxGrant[]
  // whether an entitlement gives `checks: read` (a builds level includes it)
  checks: boolean
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

// Who may run from a repository's refs may see what passed for its files, and so may who
// is entitled to just that (a CI job that only verifies).
export function mayReadChecks(grant: Grant, repo: string): boolean {
  return (grant.checks || grant.builds !== null) && matchesAnyRepo(grant.repos, repo)
}
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
  const sandboxes: SandboxGrant[] = []
  let builds: BuildsLevel | null = null
  let checks = false

  entitlements.forEach((entitlement, index) => {
    if (!matches(entitlement, principal)) {
      return
    }
    matched.push(index)
    checks = checks || entitlement.checks === 'read'
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
    for (const sandbox of entitlement.sandboxes ?? []) {
      let known = sandboxes.find((entry) => entry.repo === sandbox.repo)
      if (!known) {
        known = { repo: sandbox.repo, branches: {} }
        sandboxes.push(known)
      }
      for (const [pattern, type] of Object.entries(sandbox.branches)) {
        known.branches[pattern] = higherType(known.branches[pattern], type)
      }
    }
  })
  return { accounts, repos, builds, sandboxes, checks, matched }
}

export type SubmittedSource =
  | { type: 'ref'; repo: string; ref: string }
  | { type: 'upload' }
  // a sandbox of the caller's, of this repository, checked out from this branch
  | { type: 'sandbox'; repo: string; branch: string }

const BRANCH_TYPES: SandboxBranchType[] = ['pull', 'push']

function higherType(a: SandboxBranchType | undefined, b: SandboxBranchType): SandboxBranchType {
  return a !== undefined && BRANCH_TYPES.indexOf(a) > BRANCH_TYPES.indexOf(b) ? a : b
}

// What the caller may do with a branch of a repository in a sandbox: the higher type of the
// branch patterns that match it, in the entries whose `repo` covers the repository. The
// branches of an entry never count for another repository. Null for nothing.
export function sandboxBranchType(grant: Grant, repo: string, branch: string): SandboxBranchType | null {
  let found: SandboxBranchType | null = null
  for (const sandbox of grant.sandboxes) {
    if (!matchesRepo(sandbox.repo, repo)) {
      continue
    }
    for (const [pattern, type] of Object.entries(sandbox.branches)) {
      if (matchesRef([pattern], branch)) {
        found = higherType(found ?? undefined, type)
      }
    }
  }
  return found
}

// The branch patterns the caller may push to from a sandbox of a repository: those of type
// `push` in the entries of their `sandboxes` that cover the repository. A pattern of one
// repository never applies to another.
export function sandboxPushBranches(grant: Grant, repo: string): string[] {
  const branches = grant.sandboxes
    .filter((sandbox) => matchesRepo(sandbox.repo, repo))
    .flatMap((sandbox) => Object.entries(sandbox.branches))
    .filter(([, type]) => type === 'push')
    .map(([pattern]) => pattern)
  return [...new Set(branches)]
}

// Whether the caller may start a sandbox of a repository from a branch, or fetch a branch
// into one: a `pull` or `push` type for the branch in an entry of their `sandboxes` that
// covers the repository, and the server able to read it. The answer is the reason when not.
export function decideSandbox(
  grant: Grant,
  repo: string,
  branch: string,
  readable: (repo: string) => boolean
): { status: 400 | 403; error: string } | null {
  if (grant.sandboxes.length === 0) {
    return { status: 403, error: 'you are not entitled to keep sandboxes on this server' }
  }
  return checkSandbox(grant, repo, branch, readable, 'keep a sandbox of')
}

function checkSandbox(
  grant: Grant,
  repo: string,
  branch: string,
  readable: (repo: string) => boolean,
  what: string
): { status: 400 | 403; error: string } | null {
  const repoProblem = checkRepo(sandboxRepos(grant), repo, readable, what)
  if (repoProblem) {
    return repoProblem
  }
  if (sandboxBranchType(grant, repo, branch) === null) {
    const branches = grant.sandboxes
      .filter((sandbox) => matchesRepo(sandbox.repo, repo))
      .flatMap((sandbox) => Object.keys(sandbox.branches))
    return {
      status: 403,
      error: `you may not ${what} ${repo} from ${branch}, your branches of it are ${[...new Set(branches)].join(', ')}`,
    }
  }
  return null
}

export function sandboxRepos(grant: Grant): string[] {
  return grant.sandboxes.map((sandbox) => sandbox.repo)
}

// the caller's own list first: what they may not name is not told whether the server can read it
function checkRepo(
  repos: string[],
  repo: string,
  readable: (repo: string) => boolean,
  what: string
): { status: 400 | 403; error: string } | null {
  if (!matchesAnyRepo(repos, repo)) {
    return {
      status: 403,
      error:
        repos.length > 0
          ? `you may not ${what} ${repo}, your repositories are ${repos.join(', ')}`
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
  if (source.type === 'sandbox' && grant.sandboxes.length === 0) {
    return { type: 'refuse', status: 403, error: 'you are not entitled to keep sandboxes on this server' }
  }
  // runs on a sandbox: the repositories and branches in the `sandboxes` of the entitlements
  const repoProblem =
    source.type === 'sandbox'
      ? checkSandbox(grant, source.repo, source.branch, readable, 'run on a sandbox of')
      : checkRepo(grant.repos, source.repo, readable, 'run from')
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
