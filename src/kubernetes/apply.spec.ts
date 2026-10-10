import type { Mock } from 'vitest'
import { ApiException } from '@kubernetes/client-node'
import { apply, statusCodeOf } from './apply'
import { KubernetesInstance } from './kubernetes-instance'

function makeInstance(objectApi: Partial<{ read: Mock; patch: Mock; create: Mock }>): KubernetesInstance {
  return { objectApi } as any
}

const spec = { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'demo', namespace: 'ns' } } as any

describe('apply', () => {
  it('patches when the object already exists and returns the patched object', async () => {
    const read = vi.fn().mockResolvedValue({ existing: true })
    const patch = vi.fn().mockResolvedValue({ patched: true })
    const create = vi.fn()

    await expect(apply(makeInstance({ read, patch, create }), spec)).resolves.toEqual({ patched: true })
    expect(read).toHaveBeenCalledWith(spec)
    expect(patch).toHaveBeenCalledWith(spec)
    expect(create).not.toHaveBeenCalled()
  })

  it('creates when the object is missing and returns the created object', async () => {
    const read = vi.fn().mockRejectedValue(new Error('not found'))
    const patch = vi.fn()
    const create = vi.fn().mockResolvedValue({ created: true })

    await expect(apply(makeInstance({ read, patch, create }), spec)).resolves.toEqual({ created: true })
    expect(create).toHaveBeenCalledWith(spec)
    expect(patch).not.toHaveBeenCalled()
  })

  it('reads the object back when create loses a 409 race', async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error('not found')).mockResolvedValueOnce({ raced: true })
    const patch = vi.fn()
    const create = vi.fn().mockRejectedValue(new ApiException(409, 'conflict', undefined, {}))

    await expect(apply(makeInstance({ read, patch, create }), spec)).resolves.toEqual({ raced: true })
    expect(read).toHaveBeenCalledTimes(2)
    expect(patch).not.toHaveBeenCalled()
  })

  it('rethrows create errors that are not a 409', async () => {
    const read = vi.fn().mockRejectedValue(new Error('not found'))
    const patch = vi.fn()
    const create = vi.fn().mockRejectedValue(new ApiException(500, 'boom', undefined, {}))

    await expect(apply(makeInstance({ read, patch, create }), spec)).rejects.toThrow('boom')
    expect(patch).not.toHaveBeenCalled()
  })

  it('falls back to create when the patch fails', async () => {
    const read = vi.fn().mockResolvedValue({})
    const patch = vi.fn().mockRejectedValue(new Error('patch failed'))
    const create = vi.fn().mockResolvedValue({ created: true })

    await expect(apply(makeInstance({ read, patch, create }), spec)).resolves.toEqual({ created: true })
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('throws when the patch and the fallback create both fail', async () => {
    const read = vi.fn().mockResolvedValue({})
    const patch = vi.fn().mockRejectedValue(new Error('patch failed'))
    const create = vi.fn().mockRejectedValue(new Error('create failed'))

    await expect(apply(makeInstance({ read, patch, create }), spec)).rejects.toThrow('create failed')
    expect(create).toHaveBeenCalledTimes(1)
  })
})

describe('statusCodeOf', () => {
  it('reads the http status of an ApiException', () => {
    expect(statusCodeOf(new ApiException(404, 'not found', undefined, {}))).toBe(404)
  })

  it('reads the statusCode a watch error carries', () => {
    expect(statusCodeOf(Object.assign(new Error('a'), { statusCode: 403 }))).toBe(403)
  })

  it('prefers a numeric code over statusCode and ignores a non-numeric code', () => {
    expect(statusCodeOf({ code: 409, statusCode: 500 })).toBe(409)
    expect(statusCodeOf({ code: 'ECONNREFUSED', statusCode: 500 })).toBe(500)
  })

  it('returns undefined when no status code is present', () => {
    expect(statusCodeOf(new Error('no status'))).toBeUndefined()
    expect(statusCodeOf(undefined)).toBeUndefined()
  })
})
