import { randomBytes } from 'crypto'

const runId = randomBytes(4).toString('hex')

// Tells this process's run apart from a concurrent one of the same items, on
// this machine or another one using the same daemon or cluster.
export function getRunId(): string {
  return runId
}
