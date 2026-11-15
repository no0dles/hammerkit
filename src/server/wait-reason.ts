import type { WaitReason } from './runs'

// Why a queued run waits, as a caller may see it: the run that holds what it waits for is
// named only when the caller may see that run. Apart from overview.ts, so the command line
// says it without the server's modules.
export type VisibleWaitReason =
  | Exclude<WaitReason, { type: 'sandbox' | 'held' }>
  | { type: 'sandbox' | 'held'; run?: string }

// What keeps a queued run from starting, in words: `mine` says whose limit it is, `keys`
// names the setting of the server that sets it.
export function describeWait(reason: VisibleWaitReason, mine: boolean, keys = true): string {
  switch (reason.type) {
    case 'own-limit':
      return `${mine ? 'your' : 'its owner’s'} limit of running runs, ${reason.running} of ${reason.limit}${
        keys ? ' (runs.limits.running)' : ''
      }`
    case 'sandbox':
      return reason.run ? `its sandbox runs ${reason.run}` : 'another run works on its sandbox'
    case 'held':
      return reason.run ? `${reason.run} holds what it needs` : 'another run holds what it needs'
    case 'place':
      return `no free place, ${reason.used} of ${reason.max} taken${keys ? ' (runs.maxConcurrent)' : ''}`
    case 'starting':
      return 'starts now'
  }
}
