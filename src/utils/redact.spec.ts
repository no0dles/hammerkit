import { describe, expect, it } from 'vitest'
import { createSecretRegistry } from './redact'

function registry(...values: string[]) {
  const secrets = createSecretRegistry()
  values.forEach((value) => secrets.register(value))
  return secrets
}

describe('redact', () => {
  it('masks a registered value wherever it appears', () => {
    const secrets = registry('s3cr3t-token')
    expect(secrets.redact('auth with s3cr3t-token and s3cr3t-token')).toEqual('auth with *** and ***')
  })

  it('leaves messages alone without registered values', () => {
    expect(createSecretRegistry().redact('nothing to hide')).toEqual('nothing to hide')
  })

  it('masks each line of a multi-line value', () => {
    const secrets = registry('{\n  "private_key": "abcdefgh"\n}')
    expect(secrets.redact('"private_key": "abcdefgh"')).toEqual('***')
  })

  it('masks a value read with a trailing newline', () => {
    expect(registry('s3cr3t-token\n').redact('token s3cr3t-token')).toEqual('token ***')
  })

  it('leaves values too short to mask safely', () => {
    const secrets = registry('ab', 'abc')
    expect(secrets.redact('tab label abc')).toEqual('tab label abc')
  })

  it('masks the longer value when one contains another', () => {
    const secrets = registry('token-1234', 'token-1234-extra')
    expect(secrets.redact('x token-1234-extra y')).toEqual('x *** y')
  })

  it('keeps the values of one run out of another', () => {
    const first = registry('first-secret')
    const second = registry('second-secret')
    expect(first.redact('first-secret second-secret')).toEqual('*** second-secret')
    expect(second.redact('first-secret second-secret')).toEqual('first-secret ***')
  })

  describe('encodings', () => {
    const value = 'pa55/w0rd+value?'

    it('masks base64 and its url-safe form', () => {
      const secrets = registry(value)
      const base64 = Buffer.from(value).toString('base64')
      expect(secrets.redact(`Authorization: Basic ${base64}`)).toEqual('Authorization: Basic ***')
      expect(secrets.redact(base64.replace(/\+/g, '-').replace(/\//g, '_'))).toEqual('***')
    })

    it('masks base64 of the value inside a longer base64 string, at any alignment', () => {
      const secrets = registry(value)
      for (const prefix of ['', 'a', 'ab', 'abc', 'abcd']) {
        for (const suffix of ['', 'x', 'xy', 'xyz']) {
          const encoded = Buffer.from(`${prefix}${value}${suffix}`).toString('base64')
          expect(secrets.redact(encoded), `${prefix}|${suffix}`).toContain('***')
        }
      }
    })

    it('masks hex in both cases', () => {
      const secrets = registry(value)
      const hex = Buffer.from(value).toString('hex')
      expect(secrets.redact(`a ${hex} b`)).toEqual('a *** b')
      expect(secrets.redact(`a ${hex.toUpperCase()} b`)).toEqual('a *** b')
    })

    it('masks the url-encoded and json-escaped form', () => {
      const secrets = registry('pa55 w0rd&"quoted"')
      expect(secrets.redact('q=pa55%20w0rd%26%22quoted%22')).toEqual('q=***')
      expect(secrets.redact('{"v":"pa55 w0rd&\\"quoted\\""}')).toEqual('{"v":"***"}')
    })

    it('does not mask short values by their encodings', () => {
      const secrets = registry('abcd')
      // base64 of abcd is YWJjZA: shorter than the encoded minimum
      expect(secrets.redact('YWJjZA')).toEqual('YWJjZA')
    })
  })
})
