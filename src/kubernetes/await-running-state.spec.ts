import type { Mock } from 'vitest'
import { awaitDeployRunningState, awaitJobState, awaitRunningState } from './await-running-state'
import { KubernetesInstance } from './kubernetes-instance'
import { WorkKubernetesEnvironment } from '../planner/work-environment'

const env = { type: 'kubernetes', namespace: 'ns', context: 'ctx', ingresses: [] } as WorkKubernetesEnvironment

const abortMock = vi.fn()
let captured: { onEvent: Mock; onError: Mock } | null = null

function makeInstance(): KubernetesInstance {
  return {
    watch: {
      watch: vi.fn((_path: string, _opts: unknown, onEvent: Mock, onError: Mock) => {
        captured = { onEvent, onError }
        return Promise.resolve({ abort: abortMock })
      }),
    },
  } as any
}

function emitEvent(obj: unknown) {
  captured!.onEvent('ADDED', obj)
}

function emitError(err: unknown) {
  captured!.onError(err)
}

beforeEach(() => {
  captured = null
  abortMock.mockClear()
})

describe('awaitRunningState', () => {
  it('resolves and aborts when a matching pod event arrives', async () => {
    const promise = awaitRunningState(makeInstance(), env, 'my-pod', 'Running')

    emitEvent({ metadata: { name: 'my-pod', namespace: 'ns' }, status: { phase: 'Running' } })
    await expect(promise).resolves.toBeUndefined()
    expect(abortMock).toHaveBeenCalledTimes(1)
  })

  it('keeps waiting on non-matching events and resolves on a later matching one', async () => {
    const promise = awaitRunningState(makeInstance(), env, 'my-pod', 'Running')

    emitEvent({ metadata: { name: 'other', namespace: 'ns' }, status: { phase: 'Running' } })
    emitEvent({ metadata: { name: 'my-pod', namespace: 'other-ns' }, status: { phase: 'Running' } })
    emitEvent({ metadata: { name: 'my-pod', namespace: 'ns' }, status: { phase: 'Pending' } })
    emitEvent({ metadata: { name: 'my-pod', namespace: 'ns' }, status: { phase: 'Running' } })

    await expect(promise).resolves.toBeUndefined()
  })

  it('rejects when the watch reports an error', async () => {
    const promise = awaitRunningState(makeInstance(), env, 'my-pod', 'Running')

    emitError(new Error('watch blew up'))
    await expect(promise).rejects.toThrow('watch blew up')
  })
})

describe('awaitJobState', () => {
  it('resolves when the job reports succeeded', async () => {
    const promise = awaitJobState(makeInstance(), env, 'my-job')

    emitEvent({ metadata: { name: 'my-job', namespace: 'ns' }, status: { succeeded: 1 } })
    await expect(promise).resolves.toBeUndefined()
    expect(abortMock).toHaveBeenCalledTimes(1)
  })

  it('keeps waiting while the job has not succeeded', async () => {
    const promise = awaitJobState(makeInstance(), env, 'my-job')

    emitEvent({ metadata: { name: 'my-job', namespace: 'ns' }, status: { succeeded: 0 } })
    emitEvent({ metadata: { name: 'my-job', namespace: 'ns' }, status: { succeeded: 1 } })

    await expect(promise).resolves.toBeUndefined()
  })
})

describe('awaitDeployRunningState', () => {
  it('resolves when the deployment reports ready replicas', async () => {
    const promise = awaitDeployRunningState(makeInstance(), env, 'my-deploy')

    emitEvent({ metadata: { name: 'my-deploy', namespace: 'ns' }, status: { readyReplicas: 2 } })
    await expect(promise).resolves.toBeUndefined()
    expect(abortMock).toHaveBeenCalledTimes(1)
  })
})
