import { describe, expect, it } from 'vitest'
import { redact, registerSecretValue } from './redact'

describe('redact', () => {
  it('masks a registered value wherever it appears', () => {
    registerSecretValue('s3cr3t-token')
    expect(redact('auth with s3cr3t-token and s3cr3t-token')).toEqual('auth with *** and ***')
  })

  it('masks each line of a multi-line value', () => {
    registerSecretValue('{\n  "private_key": "abcdefgh"\n}')
    expect(redact('"private_key": "abcdefgh"')).toEqual('***')
  })

  it('leaves values too short to mask safely', () => {
    registerSecretValue('ab')
    expect(redact('tab label')).toEqual('tab label')
  })
})
