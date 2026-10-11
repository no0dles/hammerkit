// Repositories are named `host/path`, such as `github.com/corp/payments` or
// `gitlab.corp.com/platform/team/tool`, so one pattern can cover a GitHub
// organisation or a GitLab group with its subgroups. Names are compared in
// lower case: both hosts treat them that way.

const SEGMENT = /^[a-z0-9._-]+$/
const PATTERN_SEGMENT = /^[a-z0-9._*-]+$/

// `host/path` of what a caller or an operator wrote, or null when it is not a
// plain repository address: no credentials, port, query, option-like names or
// `..`. A scheme (`https://`) and a trailing `.git` are accepted and dropped.
export function normalizeRepo(input: string): string | null {
  let value = input.trim().toLowerCase()
  value = value.replace(/^https:\/\//, '')
  value = value.replace(/\.git$/, '').replace(/\/+$/, '')
  const parts = value.split('/')
  if (parts.length < 2 || parts.length > 12) {
    return null
  }
  const [host, ...path] = parts
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(host) || host.includes('..')) {
    return null
  }
  if (path.some((part) => !SEGMENT.test(part) || part === '.' || part === '..' || part.startsWith('-'))) {
    return null
  }
  return [host, ...path].join('/')
}

// A pattern is a repository where a segment may hold `*` (any characters but `/`),
// and the last one may be `**`: everything below, subgroups included.
export function isRepoPattern(input: string): boolean {
  const value = input
    .trim()
    .toLowerCase()
    .replace(/^https:\/\//, '')
    .replace(/\/+$/, '')
  const parts = value.split('/')
  if (parts.length < 2 || !/^[a-z0-9*]([a-z0-9.*-]*[a-z0-9*])?$/.test(parts[0])) {
    return false
  }
  return parts.slice(1).every((part, index, rest) => {
    if (part === '**') {
      return index === rest.length - 1
    }
    return PATTERN_SEGMENT.test(part) && part !== '.' && part !== '..' && !part.startsWith('-') && !part.includes('**')
  })
}

export function normalizeRepoPattern(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^https:\/\//, '')
    .replace(/\/+$/, '')
}

export function matchesRepo(pattern: string, repo: string): boolean {
  const parts = normalizeRepoPattern(pattern).split('/')
  const target = repo.split('/')
  const last = parts[parts.length - 1]
  if (last === '**') {
    const fixed = parts.slice(0, -1)
    return target.length > fixed.length && fixed.every((part, index) => segmentMatches(part, target[index]))
  }
  return parts.length === target.length && parts.every((part, index) => segmentMatches(part, target[index]))
}

function segmentMatches(pattern: string, segment: string): boolean {
  const regex = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]*')
  return new RegExp(`^${regex}$`).test(segment)
}

export function matchesAnyRepo(patterns: string[], repo: string): boolean {
  return patterns.some((pattern) => matchesRepo(pattern, repo))
}

// A ref is matched as written: `main`, `release/*` (one level) or `release/**`.
export function matchesRef(patterns: string[], ref: string): boolean {
  return patterns.some((pattern) => {
    const parts = pattern.split('/')
    const target = ref.split('/')
    if (parts[parts.length - 1] === '**') {
      const fixed = parts.slice(0, -1)
      return target.length > fixed.length && fixed.every((part, index) => segmentMatches(part, target[index]))
    }
    return parts.length === target.length && parts.every((part, index) => segmentMatches(part, target[index]))
  })
}
