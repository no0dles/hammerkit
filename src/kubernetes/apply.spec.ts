import type { Mock } from 'vitest'
import { apply, statusCodeOf } from './apply'
import { KubernetesInstance } from './kubernetes-instance'

function makeInstance(objectApi: Partial<{ read: Mock; patch: Mock; create: Mock }>): KubernetesInstance {
  return { objectApi } as any
}

const spec = { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'demo', namespace: 'ns' } } as any

describe('apply', () => {
  it('patches when the object already exists and returns the patch response body', async () => {
    const read = vi.fn().mockResolvedValue({ body: { existing: true } })
    const patch = vi.fn().mockResolvedValue({ body: { patched: true } })
    const create = vi.fn()

    await expect(apply(makeInstance({ read, patch, create }), spec)).resolves.toEqual({ patched: true })
    expect(read).toHaveBeenCalledWith(spec)
    expect(patch).toHaveBeenCalledWith(spec)
    expect(create).not.toHaveBeenCalled()
  })

  it('creates when the object is missing and returns the create response body', async () => {
    const read = vi.fn().mockRejectedValue(new Error('not found'))
    const patch = vi.fn()
    const create = vi.fn().mockResolvedValue({ body: { created: true } })

    await expect(apply(makeInstance({ read, patch, create }), spec)).resolves.toEqual({ created: true })
    expect(create).toHaveBeenCalledWith(spec)
    expect(patch).not.toHaveBeenCalled()
  })

  it('reads the object back when create loses a 409 race', async () => {
    const read = vi
      .fn()
      .mockRejectedValueOnce(new Error('not found'))
      .mockResolvedValueOnce({ body: { raced: true } })
    const patch = vi.fn()
    const create = vi.fn().mockRejectedValue(Object.assign(new Error('conflict'), { statusCode: 409 }))

    await expect(apply(makeInstance({ read, patch, create }), spec)).resolves.toEqual({ raced: true })
    expect(read).toHaveBeenCalledTimes(2)
    expect(patch).not.toHaveBeenCalled()
  })

  it('rethrows create errors that are not a 409', async () => {
    const read = vi.fn().mockRejectedValue(new Error('not found'))
    const patch = vi.fn()
    const create = vi.fn().mockRejectedValue(Object.assign(new Error('boom'), { statusCode: 500 }))

    await expect(apply(makeInstance({ read, patch, create }), spec)).rejects.toThrow('boom')
    expect(patch).not.toHaveBeenCalled()
  })

  it('falls back to create when the patch fails', async () => {
    const read = vi.fn().mockResolvedValue({ body: {} })
    const patch = vi.fn().mockRejectedValue(new Error('patch failed'))
    const create = vi.fn().mockResolvedValue({ body: { created: true } })

    await expect(apply(makeInstance({ read, patch, create }), spec)).resolves.toEqual({ created: true })
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('throws when the patch and the fallback create both fail', async () => {
    const read = vi.fn().mockResolvedValue({ body: {} })
    const patch = vi.fn().mockRejectedValue(new Error('patch failed'))
    const create = vi.fn().mockRejectedValue(new Error('create failed'))

    await expect(apply(makeInstance({ read, patch, create }), spec)).rejects.toThrow('create failed')
    expect(create).toHaveBeenCalledTimes(1)
  })
})

describe('statusCodeOf', () => {
  it('prefers statusCode over response.statusCode over body.code', () => {
    expect(statusCodeOf(Object.assign(new Error('a'), { statusCode: 404 }))).toBe(404)
    expect(statusCodeOf({ response: { statusCode: 403 } })).toBe(403)
    expect(statusCodeOf({ body: { code: 409 } })).toBe(409)
  })

  it('gives precedence to the first defined value', () => {
    expect(statusCodeOf({ statusCode: 500, response: { statusCode: 403 }, body: { code: 409 } })).toBe(500)
    expect(statusCodeOf({ response: { statusCode: 403 }, body: { code: 409 } })).toBe(403)
  })

  it('returns undefined when no status code is present', () => {
    expect(statusCodeOf(new Error('no status'))).toBeUndefined()
    expect(statusCodeOf(undefined)).toBeUndefined()
  })
})
