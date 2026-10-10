import { CacheEntry } from './cache-backend'

export interface RetentionPolicy {
  // evict entries not used (or, without a last-use marker, created) within this many ms
  maxAge?: number
  // evict least recently used entries until the total size is at most this many bytes
  maxSize?: number
  // keep only the most recent N entries (state keys) per task
  keepPerTask?: number
}

export interface RetentionPlan {
  keep: CacheEntry[]
  evict: CacheEntry[]
  // policies that could not be (fully) applied, e.g. a backend without sizes
  unavailable: string[]
}

function recency(entry: CacheEntry): number | null {
  return entry.lastAccessedAt ?? entry.createdAt
}

// most recent first; entries without a timestamp count as the oldest
function byRecencyDesc(a: CacheEntry, b: CacheEntry): number {
  return (recency(b) ?? -Infinity) - (recency(a) ?? -Infinity)
}

const entries = (count: number) => `${count} ${count === 1 ? 'entry' : 'entries'}`

// Decide which cache entries a retention policy evicts. Pure: listing and
// removing is the caller's job. Applied in order keepPerTask → maxAge →
// maxSize, each on what the previous step kept. Evicting never causes a false
// hit, only a rebuild.
export function planRetention(all: CacheEntry[], policy: RetentionPolicy, now: number): RetentionPlan {
  const evict: CacheEntry[] = []
  const unavailable: string[] = []
  let keep = [...all]

  if (policy.keepPerTask !== undefined) {
    const byTask = new Map<string, CacheEntry[]>()
    for (const entry of keep) {
      byTask.set(entry.taskId, [...(byTask.get(entry.taskId) ?? []), entry])
    }
    keep = []
    for (const versions of byTask.values()) {
      versions.sort(byRecencyDesc)
      keep.push(...versions.slice(0, policy.keepPerTask))
      evict.push(...versions.slice(policy.keepPerTask))
    }
  }

  if (policy.maxAge !== undefined) {
    const maxAge = policy.maxAge
    const undated = keep.filter((entry) => recency(entry) === null)
    if (undated.length > 0) {
      unavailable.push(
        `max-age: ${entries(undated.length)} ${undated.length === 1 ? 'has' : 'have'} no timestamp and ${
          undated.length === 1 ? 'was' : 'were'
        } kept`
      )
    }
    evict.push(...keep.filter((entry) => recency(entry) !== null && now - (recency(entry) as number) > maxAge))
    keep = keep.filter((entry) => !evict.includes(entry))
  }

  if (policy.maxSize !== undefined) {
    const unsized = keep.filter((entry) => entry.size === null)
    if (unsized.length > 0) {
      unavailable.push(`max-size: the backend cannot report the size of ${entries(unsized.length)}`)
    } else {
      let total = keep.reduce((sum, entry) => sum + (entry.size as number), 0)
      for (const entry of [...keep].sort(byRecencyDesc).reverse()) {
        if (total <= policy.maxSize) {
          break
        }
        evict.push(entry)
        total -= entry.size as number
      }
      keep = keep.filter((entry) => !evict.includes(entry))
    }
  }

  return { keep, evict, unavailable }
}
