import { Bundle } from '../remote/bundle'
import { DefinitionVersion } from './definitions'
import { Principal } from './oauth'

type Identity = { iss: string; sub: string }

export type ProposalState = 'waiting' | 'approved' | 'rejected' | 'expired'

// A new version of a build file that somebody without the `publish` permission
// proposed. It can not run before someone who may publish that name approves it.
export interface Proposal {
  name: string
  hash: string
  entry: string
  tasks: string[]
  services: string[]
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

export class ProposalError extends Error {}

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
  now?: () => number
}

// The proposals of the server, in memory: a restart forgets what waits, and
// whoever proposed it proposes it again. Nothing in here is runnable.
export class ProposalRegistry {
  private readonly entries = new Map<string, Entry>()
  private readonly maxWaiting: number
  private readonly timeout: number
  private readonly keep: number
  private readonly now: () => number
  private closed = false

  constructor(options: ProposalOptions = {}) {
    this.maxWaiting = options.maxWaiting ?? 100
    this.timeout = options.timeout ?? 60 * 60 * 1000
    this.keep = options.keep ?? 100
    this.now = options.now ?? Date.now
  }

  // Proposing what already waits is not an error and changes nothing.
  propose(
    version: DefinitionVersion,
    bundle: Bundle,
    proposer: Pick<Principal, 'iss' | 'sub'>
  ): { proposal: Proposal; created: boolean } {
    if (this.closed) {
      throw new ProposalError('the server is shutting down')
    }
    const key = this.key(version.name, version.hash)
    const existing = this.entries.get(key)
    if (existing && existing.proposal.state === 'waiting') {
      return { proposal: { ...existing.proposal }, created: false }
    }
    if (this.waiting().length >= this.maxWaiting) {
      throw new ProposalError('too many build file versions are waiting for an approval')
    }
    const proposal: Proposal = {
      name: version.name,
      hash: version.hash,
      entry: version.entry,
      tasks: version.tasks,
      services: version.services,
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

  get(name: string, hash: string): Proposal | undefined {
    const entry = this.entries.get(this.key(name, hash))
    return entry ? { ...entry.proposal } : undefined
  }

  // The files of one that still waits, for whoever decides on it.
  bundle(name: string, hash: string): Bundle | undefined {
    return this.entries.get(this.key(name, hash))?.bundle
  }

  // An approval publishes the files first (`publish`), and only then is the
  // proposal approved, so it never claims a version that is not there. Nobody
  // decides on their own proposal.
  async decide(
    decider: Pick<Principal, 'iss' | 'sub'>,
    name: string,
    hash: string,
    outcome: 'approved' | 'rejected',
    mayDecide: (name: string) => boolean,
    publish: (bundle: Bundle) => Promise<void>,
    reason?: string
  ): Promise<ProposalDecision> {
    const entry = this.entries.get(this.key(name, hash))
    if (!entry || !mayDecide(name)) {
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

  private evict(): void {
    const decided = [...this.entries.entries()].filter(([, e]) => e.proposal.state !== 'waiting')
    for (const [key] of decided.slice(0, Math.max(0, decided.length - this.keep))) {
      this.entries.delete(key)
    }
  }

  private key(name: string, hash: string): string {
    return `${name}@${hash}`
  }
}
