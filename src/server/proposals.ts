import { Annotations, Bundle } from '../remote/bundle'
import { DefinitionVersion, TaskPlan } from './definitions'
import { Principal } from './oauth'
import { formatDuration } from '../utils/units'

type Identity = { iss: string; sub: string }

export type ProposalState = 'waiting' | 'approved' | 'rejected' | 'expired'

// A new version of a build file that somebody without the `publish` permission
// proposed. It can not run before someone who may publish approves it. Whoever
// decides reads it whole, its plan and its files: it is named by its hash only, so
// there is no earlier version it could be read against.
export interface Proposal {
  hash: string
  entry: string
  tasks: string[]
  services: string[]
  // every account the version uses
  accounts: string[]
  // the ones the proposer does not use: whoever approves has to use all of them,
  // besides being allowed to publish
  missing: string[]
  plan: Record<string, TaskPlan>
  // where the proposer says it comes from, kept when it is published
  annotations?: Annotations
  proposedBy: Identity
  createdAt: string
  // the proposal expires if it still waits then
  expiresAt: string
  state: ProposalState
  decidedBy?: Identity
  decidedAt?: string
  reason?: string
}

export type ProposalDecision =
  | { status: 'ok'; proposal: Proposal }
  // not one the caller may see or decide
  | { status: 'not-found' }
  | { status: 'own-proposal' }
  | { status: 'not-waiting'; state: ProposalState }

export class ProposalError extends Error {
  // what the caller is told
  status: number = 503
}

// The caller proposes too soon after a rejection
export class CooldownError extends ProposalError {
  status = 429
}

interface Entry {
  proposal: Proposal
  // dropped once decided, the published version keeps it
  bundle?: Bundle
  timer?: NodeJS.Timeout
}

export interface ProposalOptions {
  // proposals that wait at the same time, more are refused
  maxWaiting?: number
  // how long one waits (ms)
  timeout?: number
  // decided proposals that are kept to be looked at
  keep?: number
  // after a rejection, the same caller can not propose anything, nor anybody the same
  // version, for this long (ms), so the people who decide are not asked again and again
  cooldown?: number
  now?: () => number
}

// The proposals of the server, in memory: a restart forgets what waits, and
// whoever proposed it proposes it again. Nothing in here is runnable.
export class ProposalRegistry {
  private readonly entries = new Map<string, Entry>()
  private readonly maxWaiting: number
  private readonly timeout: number
  private readonly keep: number
  private readonly cooldown: number
  private readonly now: () => number
  private closed = false

  constructor(options: ProposalOptions = {}) {
    this.maxWaiting = options.maxWaiting ?? 100
    this.timeout = options.timeout ?? 60 * 60 * 1000
    this.keep = options.keep ?? 100
    this.cooldown = options.cooldown ?? 0
    this.now = options.now ?? Date.now
  }

  // Proposing what already waits is not an error and changes nothing.
  propose(
    version: DefinitionVersion,
    bundle: Bundle,
    proposer: Pick<Principal, 'iss' | 'sub'>,
    missing: string[] = []
  ): { proposal: Proposal; created: boolean } {
    if (this.closed) {
      throw new ProposalError('the server is shutting down')
    }
    const key = version.hash
    const existing = this.entries.get(key)
    if (existing && existing.proposal.state === 'waiting') {
      return { proposal: { ...existing.proposal }, created: false }
    }
    this.checkCooldown(version, proposer)
    if (this.waiting().length >= this.maxWaiting) {
      throw new ProposalError('too many build file versions are waiting for an approval')
    }
    const proposal: Proposal = {
      hash: version.hash,
      entry: version.entry,
      tasks: version.tasks,
      services: version.services,
      accounts: version.accounts ?? [],
      missing,
      plan: version.plan ?? {},
      ...(version.annotations ? { annotations: { ...version.annotations } } : {}),
      proposedBy: { iss: proposer.iss, sub: proposer.sub },
      createdAt: new Date(this.now()).toISOString(),
      expiresAt: new Date(this.now() + this.timeout).toISOString(),
      state: 'waiting',
    }
    const entry: Entry = { proposal, bundle }
    entry.timer = setTimeout(() => this.settle(entry, 'expired'), this.timeout)
    entry.timer.unref()
    this.entries.delete(key)
    this.entries.set(key, entry)
    this.evict()
    return { proposal: { ...proposal }, created: true }
  }

  waiting(): Proposal[] {
    return [...this.entries.values()].filter((e) => e.proposal.state === 'waiting').map((e) => ({ ...e.proposal }))
  }

  // Everything kept, newest first.
  all(): Proposal[] {
    return [...this.entries.values()].map((e) => ({ ...e.proposal })).reverse()
  }

  get(hash: string): Proposal | undefined {
    const entry = this.entries.get(hash)
    return entry ? { ...entry.proposal } : undefined
  }

  // The files of one that still waits, for whoever decides on it.
  bundle(hash: string): Bundle | undefined {
    return this.entries.get(hash)?.bundle
  }

  // An approval publishes the files first (`publish`), and only then is the
  // proposal approved, so it never claims a version that is not there. Nobody
  // decides on their own proposal.
  async decide(
    decider: Pick<Principal, 'iss' | 'sub'>,
    hash: string,
    outcome: 'approved' | 'rejected',
    mayDecide: (proposal: Proposal) => boolean,
    publish: (bundle: Bundle) => Promise<void>,
    reason?: string
  ): Promise<ProposalDecision> {
    const entry = this.entries.get(hash)
    if (!entry || !mayDecide(entry.proposal)) {
      return { status: 'not-found' }
    }
    if (entry.proposal.proposedBy.iss === decider.iss && entry.proposal.proposedBy.sub === decider.sub) {
      return { status: 'own-proposal' }
    }
    if (entry.proposal.state !== 'waiting' || !entry.bundle) {
      return { status: 'not-waiting', state: entry.proposal.state }
    }
    if (outcome === 'approved') {
      await publish(entry.bundle)
      if (entry.proposal.state !== 'waiting') {
        return { status: 'not-waiting', state: entry.proposal.state }
      }
    }
    this.settle(entry, outcome, { iss: decider.iss, sub: decider.sub }, reason)
    return { status: 'ok', proposal: { ...entry.proposal } }
  }

  close(): void {
    this.closed = true
    for (const entry of this.entries.values()) {
      if (entry.timer) {
        clearTimeout(entry.timer)
        entry.timer = undefined
      }
    }
  }

  private settle(entry: Entry, state: Exclude<ProposalState, 'waiting'>, by?: Identity, reason?: string): void {
    if (entry.proposal.state !== 'waiting') {
      return
    }
    if (entry.timer) {
      clearTimeout(entry.timer)
      entry.timer = undefined
    }
    entry.proposal.state = state
    entry.proposal.decidedAt = new Date(this.now()).toISOString()
    if (by) {
      entry.proposal.decidedBy = by
    }
    if (reason) {
      entry.proposal.reason = reason
    }
    entry.bundle = undefined
  }

  // A rejection is a no; a proposal that only ran out of time is not.
  private checkCooldown(version: DefinitionVersion, proposer: Pick<Principal, 'iss' | 'sub'>): void {
    if (this.cooldown <= 0) {
      return
    }
    for (const { proposal } of this.entries.values()) {
      if (proposal.state !== 'rejected') {
        continue
      }
      const left = Date.parse(proposal.decidedAt ?? '') + this.cooldown - this.now()
      const sameVersion = proposal.hash === version.hash
      const sameProposer = proposal.proposedBy.iss === proposer.iss && proposal.proposedBy.sub === proposer.sub
      if (left > 0 && (sameVersion || sameProposer)) {
        throw new CooldownError(
          `${sameVersion ? 'this version was' : 'a version you proposed was'} rejected, ` +
            `propose again in ${formatDuration(Math.ceil(left / 1000) * 1000)}`
        )
      }
    }
  }

  private evict(): void {
    const decided = [...this.entries.entries()].filter(([, e]) => e.proposal.state !== 'waiting')
    for (const [key] of decided.slice(0, Math.max(0, decided.length - this.keep))) {
      this.entries.delete(key)
    }
  }
}
