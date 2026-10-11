// Secret values a run has read, masked in everything it logs, including the
// output it streams from a task or service. The registry belongs to one run
// (its Environment): a process that serves several runs must not mask one
// run's values in another's output, and must not keep them after the run.
//
// Logs are per line, so each line of a multi-line value (a key file) is masked
// on its own. Values shorter than MIN_LENGTH are left alone: masking them would
// mangle unrelated output. The usual encodings of a value (base64, hex, URL,
// JSON) are masked too, since a task or tool often prints those instead; an
// encoding must be MIN_ENCODED_LENGTH long to be matched, for the same reason.
const MIN_LENGTH = 4
const MIN_ENCODED_LENGTH = 8
const MASK = '***'

export interface SecretRegistry {
  register(value: string): void
  redact(message: string): string
}

export function createSecretRegistry(): SecretRegistry {
  const values = new Set<string>()
  // longest first, so a value containing another is masked as a whole
  let sorted: string[] | null = null

  function add(candidate: string, minLength: number): void {
    if (candidate.length >= minLength && !values.has(candidate)) {
      values.add(candidate)
      sorted = null
    }
  }

  return {
    register(value: string): void {
      // the whole value, then each line of it; encodings are taken of each as it was written
      for (const base of new Set([value, ...value.split(/\r?\n/)])) {
        if (base.trim().length < MIN_LENGTH) {
          continue
        }
        add(base.trim(), MIN_LENGTH)
        for (const form of getEncodedForms(base)) {
          add(form.value, form.minLength)
        }
      }
    },
    redact(message: string): string {
      if (values.size === 0) {
        return message
      }
      sorted = sorted ?? [...values].sort((a, b) => b.length - a.length)
      return sorted.reduce((result, value) => result.split(value).join(MASK), message)
    },
  }
}

// The encodings of a value that are likely to show up in output. Base64 is
// matched wherever it starts inside a longer base64 string: the value begins
// at byte offset 0, 1 or 2 of a 3-byte group, and the characters that mix in
// bytes before or after it are dropped, since they depend on unknown data.
export function getEncodedForms(value: string): { value: string; minLength: number }[] {
  const bytes = Buffer.from(value, 'utf8')
  const forms: { value: string; minLength: number }[] = []

  // the value on its own, as a task or tool usually prints it
  const whole = bytes.toString('base64')
  forms.push({ value: whole, minLength: MIN_ENCODED_LENGTH })
  forms.push({ value: whole.replace(/\+/g, '-').replace(/\//g, '_'), minLength: MIN_ENCODED_LENGTH })
  for (let offset = 0; offset < 3; offset++) {
    const encoded = Buffer.concat([Buffer.alloc(offset), bytes])
      .toString('base64')
      .replace(/=+$/, '')
    const leading = [0, 2, 3][offset]
    const trailing = (bytes.length + offset) % 3 === 0 ? 0 : 1
    const form = encoded.substring(leading, encoded.length - trailing)
    forms.push({ value: form, minLength: MIN_ENCODED_LENGTH })
    forms.push({ value: form.replace(/\+/g, '-').replace(/\//g, '_'), minLength: MIN_ENCODED_LENGTH })
  }

  const hex = bytes.toString('hex')
  forms.push({ value: hex, minLength: MIN_ENCODED_LENGTH })
  forms.push({ value: hex.toUpperCase(), minLength: MIN_ENCODED_LENGTH })

  const url = encodeURIComponent(value)
  if (url !== value) {
    forms.push({ value: url, minLength: MIN_LENGTH })
  }
  const json = JSON.stringify(value).slice(1, -1)
  if (json !== value) {
    forms.push({ value: json, minLength: MIN_LENGTH })
  }
  return forms
}
