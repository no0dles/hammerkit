const DURATION_UNITS: { [unit: string]: number } = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
}

// Parse a duration such as `500ms`, `30s`, `5m`, `1h30m` or `30d` into
// milliseconds. Every component needs a unit, and the total must be positive.
export function parseDuration(value: string): number {
  const pattern = /(\d+(?:\.\d+)?)(ms|s|m|h|d)/y
  let total = 0
  let offset = 0
  while (offset < value.length) {
    pattern.lastIndex = offset
    const match = pattern.exec(value)
    if (!match) {
      throw new Error(`invalid duration "${value}", expected e.g. 30s, 5m, 1h30m or 30d`)
    }
    total += parseFloat(match[1]) * DURATION_UNITS[match[2]]
    offset = pattern.lastIndex
  }
  if (total <= 0) {
    throw new Error(`invalid duration "${value}", expected e.g. 30s, 5m, 1h30m or 30d`)
  }
  return Math.round(total)
}

export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`
  }
  let remaining = Math.round(ms / 1000)
  const parts: string[] = []
  for (const [unit, seconds] of [
    ['d', 86_400],
    ['h', 3_600],
    ['m', 60],
    ['s', 1],
  ] as const) {
    if (remaining >= seconds) {
      parts.push(`${Math.floor(remaining / seconds)}${unit}`)
      remaining %= seconds
    }
  }
  return parts.join('')
}

const SIZE_UNITS: { [unit: string]: number } = {
  '': 1,
  K: 1000,
  M: 1000 ** 2,
  G: 1000 ** 3,
  T: 1000 ** 4,
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
  Ti: 1024 ** 4,
}

// Parse a size such as `500Mi`, `5Gi` or `2G` (Kubernetes-style suffixes;
// binary `Ki/Mi/Gi/Ti`, decimal `K/M/G/T`, none for bytes) into bytes.
export function parseSize(value: string): number {
  const match = /^(\d+(?:\.\d+)?)(Ki|Mi|Gi|Ti|K|M|G|T)?$/.exec(value)
  if (!match) {
    throw new Error(`invalid size "${value}", expected e.g. 500Mi, 5Gi or 2G`)
  }
  return Math.round(parseFloat(match[1]) * SIZE_UNITS[match[2] ?? ''])
}

export function formatSize(bytes: number): string {
  for (const [unit, factor] of [
    ['Ti', 1024 ** 4],
    ['Gi', 1024 ** 3],
    ['Mi', 1024 ** 2],
    ['Ki', 1024],
  ] as const) {
    if (bytes >= factor) {
      return `${(bytes / factor).toFixed(1).replace(/\.0$/, '')}${unit}`
    }
  }
  return `${bytes}B`
}

// Parse a CPU quantity in Kubernetes notation, `2`, `0.5` or `500m`
// (millicores), into cores. Kubernetes' precision is a millicore, so anything
// finer, and zero, is rejected.
export function parseCpus(value: string | number): number {
  const text = `${value}`
  const match = /^(\d+(?:\.\d+)?)(m)?$/.exec(text)
  const millicores = match ? parseFloat(match[1]) * (match[2] ? 1 : 1000) : NaN
  if (!Number.isInteger(millicores) || millicores <= 0) {
    throw new Error(`invalid cpus "${text}", expected cores or millicores, e.g. 2, 0.5 or 500m`)
  }
  return millicores / 1000
}

const QUANTITY_UNITS: Record<string, number> = {
  n: 1e-9,
  u: 1e-6,
  m: 1e-3,
  '': 1,
  k: 1e3,
  K: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
  P: 1e15,
  E: 1e18,
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
  Ti: 1024 ** 4,
  Pi: 1024 ** 5,
  Ei: 1024 ** 6,
}

// A quantity of Kubernetes (`250m`, `1.5`, `512Mi`, `12345678n`, `1e3`), as a number.
export function parseQuantity(value: string | number | undefined): number | undefined {
  if (value === undefined) {
    return undefined
  }
  if (typeof value === 'number') {
    return value
  }
  const match = /^([+-]?[0-9.]+(?:[eE][+-]?\d+)?)([a-zA-Z]*)$/.exec(value.trim())
  if (!match || !(match[2] in QUANTITY_UNITS)) {
    return undefined
  }
  const number = Number(match[1])
  return Number.isFinite(number) ? number * QUANTITY_UNITS[match[2]] : undefined
}
