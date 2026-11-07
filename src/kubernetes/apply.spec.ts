import type { Mock } from 'vitest'
import { ApiException } from '@kubernetes/client-node'
import { apply, replace, replaceDeployment, statusCodeOf } from './apply'
import { KubernetesInstance } from './kubernetes-instance'

function makeInstance(
  objectApi: Partial<{ read: Mock; patch: Mock; create: Mock; replace: Mock }>
): KubernetesInstance {
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

describe('replace', () => {
  const conflict = () => Object.assign(new Error('conflict'), { code: 409 })

  it('reads the object again when another replaced it since it was read', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce({ metadata: { resourceVersion: '1' } })
      .mockResolvedValueOnce({ metadata: { resourceVersion: '2' } })
    const replaced = vi.fn().mockRejectedValueOnce(conflict()).mockResolvedValueOnce({ replaced: true })
    await expect(replace(makeInstance({ read, replace: replaced }), spec)).resolves.toEqual({ replaced: true })
    expect(replaced.mock.calls.map(([object]) => object.metadata.resourceVersion)).toEqual(['1', '2'])
  })

  it('gives up after three conflicts and on any other error', async () => {
    const read = vi.fn().mockResolvedValue({ metadata: { resourceVersion: '1' } })
    const always = vi.fn().mockRejectedValue(conflict())
    await expect(replace(makeInstance({ read, replace: always }), spec)).rejects.toThrow('conflict')
    expect(always).toHaveBeenCalledTimes(3)
    const forbidden = vi.fn().mockRejectedValue(Object.assign(new Error('forbidden'), { code: 403 }))
    await expect(replace(makeInstance({ read, replace: forbidden }), spec)).rejects.toThrow('forbidden')
    expect(forbidden).toHaveBeenCalledTimes(1)
  })
})

describe('replaceDeployment', () => {
  const deployment = {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name: 'web', namespace: 'ns', labels: { a: '1' } },
    spec: { replicas: 1 },
  } as any
  const failing = (code: number) => Object.assign(new Error(`failed ${code}`), { code })

  it('patches all of it at the version it read, the runRole has no update on Deployments', async () => {
    const appsApi = {
      readNamespacedDeployment: vi.fn().mockResolvedValue({ metadata: { resourceVersion: '4' } }),
      patchNamespacedDeployment: vi.fn().mockResolvedValue({ patched: true }),
    }
    await expect(replaceDeployment({ appsApi } as any, deployment)).resolves.toEqual({ patched: true })
    expect(appsApi.patchNamespacedDeployment).toHaveBeenCalledWith({
      name: 'web',
      namespace: 'ns',
      body: [
        { op: 'test', path: '/metadata/resourceVersion', value: '4' },
        { op: 'add', path: '/metadata/labels', value: { a: '1' } },
        // what the new one does not have goes, as it would with a replace
        { op: 'add', path: '/metadata/annotations', value: {} },
        { op: 'add', path: '/spec', value: { replicas: 1 } },
      ],
    })
  })

  it('creates one that is not there', async () => {
    const appsApi = {
      readNamespacedDeployment: vi.fn().mockRejectedValue(failing(404)),
      createNamespacedDeployment: vi.fn().mockResolvedValue({ created: true }),
    }
    await expect(replaceDeployment({ appsApi } as any, deployment)).resolves.toEqual({ created: true })
    expect(appsApi.createNamespacedDeployment).toHaveBeenCalledWith({ namespace: 'ns', body: deployment })
  })

  it('reads it again when it changed since, and gives up after three times or on another error', async () => {
    const readNamespacedDeployment = vi
      .fn()
      .mockResolvedValueOnce({ metadata: { resourceVersion: '1' } })
      .mockResolvedValue({ metadata: { resourceVersion: '2' } })
    const patched = vi.fn().mockRejectedValueOnce(failing(422)).mockResolvedValueOnce({ patched: true })
    await expect(
      replaceDeployment(
        { appsApi: { readNamespacedDeployment, patchNamespacedDeployment: patched } } as any,
        deployment
      )
    ).resolves.toEqual({ patched: true })
    expect(patched.mock.calls.map(([{ body }]) => body[0].value)).toEqual(['1', '2'])

    const always = vi.fn().mockRejectedValue(failing(409))
    await expect(
      replaceDeployment({ appsApi: { readNamespacedDeployment, patchNamespacedDeployment: always } } as any, deployment)
    ).rejects.toThrow('failed 409')
    expect(always).toHaveBeenCalledTimes(3)
    const forbidden = vi.fn().mockRejectedValue(failing(403))
    await expect(
      replaceDeployment(
        { appsApi: { readNamespacedDeployment, patchNamespacedDeployment: forbidden } } as any,
        deployment
      )
    ).rejects.toThrow('failed 403')
    expect(forbidden).toHaveBeenCalledTimes(1)
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
