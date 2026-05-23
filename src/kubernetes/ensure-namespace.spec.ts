import { ensureNamespace } from './ensure-namespace'
import { KubernetesInstance } from './kubernetes-instance'

function httpError(statusCode: number): Error & { statusCode: number } {
  return Object.assign(new Error(`http ${statusCode}`), { statusCode })
}

function makeInstance(coreApi: Partial<{ readNamespace: jest.Mock; createNamespace: jest.Mock }>): KubernetesInstance {
  return { coreApi } as any
}

describe('ensureNamespace', () => {
  it('does nothing when the namespace already exists', async () => {
    const readNamespace = jest.fn().mockResolvedValue({ body: {} })
    const createNamespace = jest.fn()
    await ensureNamespace(makeInstance({ readNamespace, createNamespace }), 'demo')

    expect(readNamespace).toHaveBeenCalledWith('demo')
    expect(createNamespace).not.toHaveBeenCalled()
  })

  it('creates the namespace (labeled managed) when missing', async () => {
    const readNamespace = jest.fn().mockRejectedValue(httpError(404))
    const createNamespace = jest.fn().mockResolvedValue({ body: {} })
    await ensureNamespace(makeInstance({ readNamespace, createNamespace }), 'demo')

    expect(createNamespace).toHaveBeenCalledTimes(1)
    expect(createNamespace.mock.calls[0][0]).toMatchObject({
      metadata: { name: 'demo', labels: { 'hammerkit.dev/managed': 'true' } },
    })
  })

  it('swallows a 409 from a racing create', async () => {
    const readNamespace = jest.fn().mockRejectedValue(httpError(404))
    const createNamespace = jest.fn().mockRejectedValue(httpError(409))
    await expect(ensureNamespace(makeInstance({ readNamespace, createNamespace }), 'demo')).resolves.toBeUndefined()
  })

  it('rethrows unexpected read errors', async () => {
    const readNamespace = jest.fn().mockRejectedValue(httpError(500))
    const createNamespace = jest.fn()
    await expect(ensureNamespace(makeInstance({ readNamespace, createNamespace }), 'demo')).rejects.toThrow()
    expect(createNamespace).not.toHaveBeenCalled()
  })
})
