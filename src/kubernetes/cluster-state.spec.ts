import { ApiException, CoreV1Event, V1Pod } from '@kubernetes/client-node'
import { describeEvent, describePod, getPodFailure, getPodWaiting, readClusterState } from './cluster-state'
import { KubernetesInstance } from './kubernetes-instance'
import { WorkKubernetesEnvironment } from '../planner/work-environment'
import { WorkTree } from '../planner/work-tree'
import { getItemKey } from './resources'
import { NETWORK_GATE_CONTAINER } from './network-gate'

function pod(status: V1Pod['status'], name = 'web-1'): V1Pod {
  return { metadata: { name }, status }
}

describe('getPodFailure', () => {
  it('says why the network gate failed, from its termination message', () => {
    const failed = pod({
      initContainerStatuses: [
        {
          name: NETWORK_GATE_CONTAINER,
          image: 'gate',
          ready: false,
          restartCount: 1,
          imageID: '',
          lastState: { terminated: { exitCode: 1, message: 'the policy of web did not take hold in 30s' } },
          state: { waiting: { reason: 'CrashLoopBackOff' } },
        },
      ],
    })
    expect(getPodFailure(failed)).toEqual({
      text: 'the network policy did not take hold: the policy of web did not take hold in 30s',
      final: true,
    })
  })

  it('names another init container that failed, never its output', () => {
    const failed = pod({
      initContainerStatuses: [
        {
          name: 'secret-0',
          image: 'reader',
          ready: false,
          restartCount: 2,
          imageID: '',
          state: { waiting: { reason: 'CrashLoopBackOff' } },
          lastState: { terminated: { exitCode: 2, message: 'the value is s3cr3t' } },
        },
      ],
    })
    expect(getPodFailure(failed)).toEqual({ text: 'its init container secret-0 failed with exit code 2', final: true })
    // once may be a race, it gets another go
    const once = pod({
      initContainerStatuses: [
        {
          name: 'secret-0',
          image: 'reader',
          ready: false,
          restartCount: 1,
          imageID: '',
          state: { waiting: { reason: 'CrashLoopBackOff' } },
          lastState: { terminated: { exitCode: 2 } },
        },
      ],
    })
    expect(getPodFailure(once)).toBeNull()
  })

  it('says a container could not be created, with the message of the cluster', () => {
    const failed = pod({
      containerStatuses: [
        {
          name: 'web',
          image: 'web:1',
          ready: false,
          restartCount: 0,
          imageID: '',
          state: { waiting: { reason: 'CreateContainerConfigError', message: 'secret "db" not found' } },
        },
      ],
    })
    // the Secret may still come: it fails once it lasted
    expect(getPodFailure(failed)).toEqual({
      text: 'its container could not be started (CreateContainerConfigError): secret "db" not found',
      final: false,
    })
  })

  it('says a container ran out of memory', () => {
    const failed = pod({
      containerStatuses: [
        {
          name: 'web',
          image: 'web:1',
          ready: false,
          restartCount: 2,
          imageID: '',
          state: { waiting: { reason: 'CrashLoopBackOff' } },
          lastState: { terminated: { exitCode: 137, reason: 'OOMKilled' } },
        },
      ],
    })
    expect(getPodFailure(failed)).toEqual({
      text: 'it keeps crashing: it was killed for using more memory than its limit (OOMKilled), restarted 2 times',
      final: true,
    })
  })

  it('says a killed container may have failed its healthcheck', () => {
    const failed = pod({
      containerStatuses: [
        {
          name: 'web',
          image: 'web:1',
          ready: false,
          restartCount: 3,
          imageID: '',
          state: { waiting: { reason: 'CrashLoopBackOff' } },
          lastState: { terminated: { exitCode: 137, reason: 'Error' } },
        },
      ],
    })
    expect(getPodFailure(failed)?.text).toContain('killed as when its healthcheck kept failing')
  })

  it('fails a crash only once it happened twice in a row', () => {
    const crashed = (restartCount: number) =>
      pod({
        containerStatuses: [
          {
            name: 'web',
            image: 'web:1',
            ready: false,
            restartCount,
            imageID: '',
            state: { waiting: { reason: 'CrashLoopBackOff' } },
            lastState: { terminated: { exitCode: 1, reason: 'Error' } },
          },
        ],
      })
    expect(getPodFailure(crashed(1))).toBeNull()
    expect(getPodWaiting(crashed(1))).toBe('crashed and starts again: it exited with code 1 (Error), restarted 1 time')
    expect(getPodFailure(crashed(2))).toEqual({
      text: 'it keeps crashing: it exited with code 1 (Error), restarted 2 times',
      final: true,
    })
  })

  it('fails an image pull at once only when the image is not there to pull', () => {
    const pulling = (message: string) =>
      pod({
        containerStatuses: [
          {
            name: 'web',
            image: 'web:1',
            ready: false,
            restartCount: 0,
            imageID: '',
            state: { waiting: { reason: 'ImagePullBackOff', message } },
          },
        ],
      })
    expect(getPodFailure(pulling('rpc error: manifest unknown'))?.final).toBe(true)
    expect(getPodFailure(pulling('failed to resolve: 401 Unauthorized'))?.final).toBe(true)
    expect(getPodFailure(pulling('429 Too Many Requests'))).toEqual({
      text: 'its image web:1 could not be pulled (ImagePullBackOff): 429 Too Many Requests',
      final: false,
    })
    expect(getPodWaiting(pulling('429 Too Many Requests'))).toBe(
      'can not pull its image web:1 yet: 429 Too Many Requests'
    )
  })

  it('has nothing to say of a pod that is still starting', () => {
    expect(
      getPodFailure(
        pod({
          containerStatuses: [
            {
              name: 'web',
              image: 'web:1',
              ready: false,
              restartCount: 0,
              imageID: '',
              state: { waiting: { reason: 'ContainerCreating' } },
            },
          ],
        })
      )
    ).toBeNull()
  })
})

describe('getPodWaiting', () => {
  it('says a pod waits for a node, as the scheduler says why', () => {
    expect(
      getPodWaiting(
        pod({
          conditions: [
            { type: 'PodScheduled', status: 'False', reason: 'Unschedulable', message: '0/2 nodes: Insufficient cpu' },
          ],
        })
      )
    ).toBe('waits for a node: 0/2 nodes: Insufficient cpu')
  })

  it('says an image pull that may still succeed', () => {
    expect(
      getPodWaiting(
        pod({
          containerStatuses: [
            {
              name: 'web',
              image: 'web:1',
              ready: false,
              restartCount: 0,
              imageID: '',
              state: { waiting: { reason: 'ErrImagePull', message: 'not found' } },
            },
          ],
        })
      )
    ).toBe('can not pull its image web:1 yet: not found')
  })
})

describe('describePod', () => {
  it('leaves out a pod that runs and is ready', () => {
    expect(
      describePod(
        pod({
          phase: 'Running',
          containerStatuses: [
            { name: 'web', image: 'web', ready: true, restartCount: 0, imageID: '', state: { running: {} } },
          ],
        })
      )
    ).toBeNull()
  })

  it('says how a pod that is not ready is, and how its containers ended', () => {
    expect(
      describePod(
        pod({
          phase: 'Running',
          containerStatuses: [
            {
              name: 'web',
              image: 'web',
              ready: false,
              restartCount: 1,
              imageID: '',
              state: { running: {} },
              lastState: { terminated: { exitCode: 3, reason: 'Error' } },
            },
          ],
        })
      )
    ).toBe('pod web-1: Running, restarted: it exited with code 3 (Error), restarted 1 time')
  })
})

describe('describeEvent', () => {
  it('leaves out the output of a failed probe, which is the service’s', () => {
    const event = {
      involvedObject: { kind: 'Pod', name: 'web-1' },
      reason: 'Unhealthy',
      message: 'Readiness probe failed: curl: token=abc\nmore',
      count: 4,
    } as CoreV1Event
    expect(describeEvent(event)).toBe('Unhealthy pod/web-1: Readiness probe failed (4 times)')
  })

  it('keeps the message of the cluster', () => {
    const event = {
      involvedObject: { kind: 'Pod', name: 'web-1' },
      reason: 'FailedScheduling',
      message: '0/3 nodes are available: 3 Insufficient memory.',
    } as CoreV1Event
    expect(describeEvent(event)).toBe('FailedScheduling pod/web-1: 0/3 nodes are available: 3 Insufficient memory.')
  })
})

describe('readClusterState', () => {
  const env = {
    type: 'kubernetes',
    namespace: 'caller',
    httpRoutes: [],
    networkPolicyEnforced: false,
    server: { run: 'run_aaaaaaaaaaaaaaaa' },
  } as unknown as WorkKubernetesEnvironment
  const web = { id: () => 'f'.repeat(64), name: 'web' }
  const workTree = { tasks: {}, services: { web } } as unknown as WorkTree
  const key = getItemKey(web as never, env)

  const failing = pod(
    {
      phase: 'Pending',
      containerStatuses: [
        {
          name: 'web',
          image: 'web:1',
          ready: false,
          restartCount: 0,
          imageID: '',
          state: { waiting: { reason: 'ImagePullBackOff' } },
        },
      ],
    },
    `web-${key}-abc`
  )
  const otherRuns = pod({ phase: 'Pending' }, 'build-ffff-other')
  const events = {
    items: [
      {
        involvedObject: { kind: 'Pod', name: `web-${key}-abc` },
        reason: 'Failed',
        message: 'Failed to pull image "web:1": not found',
        lastTimestamp: new Date(2),
      },
      {
        involvedObject: { kind: 'Pod', name: 'build-ffff-other' },
        reason: 'Failed',
        message: 'of another run',
        lastTimestamp: new Date(1),
      },
    ],
  }

  it('says the pods and warnings of the run, in a namespace runs share', async () => {
    const listNamespacedPod = vi.fn().mockResolvedValue({ items: [failing, otherRuns] })
    const listNamespacedEvent = vi.fn().mockResolvedValue(events)
    const instance = { coreApi: { listNamespacedPod, listNamespacedEvent } } as unknown as KubernetesInstance

    const lines = await readClusterState(instance, env, workTree, false)

    expect(listNamespacedPod).toHaveBeenCalledWith({
      namespace: 'caller',
      labelSelector: expect.stringContaining('hammerkit.dev/run='),
    })
    expect(listNamespacedEvent).toHaveBeenCalledWith({ namespace: 'caller', fieldSelector: 'type=Warning' })
    expect(lines).toEqual([
      `pod web-${key}-abc: Pending, its image web:1 could not be pulled (ImagePullBackOff)`,
      `event Failed pod/web-${key}-abc: Failed to pull image "web:1": not found`,
    ])
  })

  it('takes everything in the namespace of a service run, oldest event first', async () => {
    const listNamespacedPod = vi.fn().mockResolvedValue({ items: [] })
    const listNamespacedEvent = vi.fn().mockResolvedValue(events)
    const instance = { coreApi: { listNamespacedPod, listNamespacedEvent } } as unknown as KubernetesInstance

    const lines = await readClusterState(instance, env, workTree, true)

    expect(listNamespacedPod).toHaveBeenCalledWith({ namespace: 'caller' })
    expect(lines).toEqual([
      'event Failed pod/build-ffff-other: of another run',
      `event Failed pod/web-${key}-abc: Failed to pull image "web:1": not found`,
    ])
  })

  it('leaves out what the result of a task says better, and says only the newest 20 events', async () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      involvedObject: { kind: 'Pod', name: `web-${key}-abc` },
      reason: 'BackOff',
      message: `event ${i}`,
      lastTimestamp: new Date(1000 + i),
    }))
    const backoff = {
      involvedObject: { kind: 'Job', name: `build-${key}` },
      reason: 'BackoffLimitExceeded',
      message: 'Job has reached the specified backoff limit',
      lastTimestamp: new Date(5000),
    }
    const listNamespacedPod = vi.fn().mockResolvedValue({ items: [] })
    const listNamespacedEvent = vi.fn().mockResolvedValue({ items: [backoff, ...many] })
    const instance = { coreApi: { listNamespacedPod, listNamespacedEvent } } as unknown as KubernetesInstance

    const lines = await readClusterState(instance, env, workTree, false)

    expect(lines).toHaveLength(20)
    expect(lines[0]).toBe(`event BackOff pod/web-${key}-abc: event 5`)
    expect(lines[19]).toBe(`event BackOff pod/web-${key}-abc: event 24`)
    expect(lines.join('\n')).not.toContain('BackoffLimitExceeded')
  })

  it('says which right is missing when the events can not be listed', async () => {
    const listNamespacedPod = vi.fn().mockResolvedValue({ items: [] })
    const listNamespacedEvent = vi.fn().mockRejectedValue(new ApiException(403, 'forbidden', undefined, {}))
    const instance = { coreApi: { listNamespacedPod, listNamespacedEvent } } as unknown as KubernetesInstance

    expect(await readClusterState(instance, env, workTree, true)).toEqual([
      'its events could not be read: the runRole of the server needs list on events (see the backend docs)',
    ])
  })
})
