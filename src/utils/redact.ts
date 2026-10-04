// Secret values hammerkit has read, masked in everything it logs, including the
// output it streams from a task or service. Logs are per line, so each line of
// a multi-line value (a key file) is masked on its own. Values shorter than
// MIN_LENGTH are left alone: masking them would mangle unrelated output.
const MIN_LENGTH = 4
const MASK = '***'

const values = new Set<string>()

export function registerSecretValue(value: string): void {
  for (const candidate of [value, ...value.split(/\r?\n/)]) {
    const trimmed = candidate.trim()
    if (trimmed.length >= MIN_LENGTH) {
      values.add(trimmed)
    }
  }
}

export function redact(message: string): string {
  if (values.size === 0) {
    return message
  }
  // longest first, so a value containing another is masked as a whole
  const sorted = [...values].sort((a, b) => b.length - a.length)
  return sorted.reduce((result, value) => result.split(value).join(MASK), message)
}
