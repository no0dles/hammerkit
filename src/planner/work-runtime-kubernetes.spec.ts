import { V1ContainerStatus } from '@kubernetes/client-node'
import { describeFailedJob, getTaskJobContainers, isRolledOut, recordJobExecution } from './work-runtime-kubernetes'
import { readExecutions } from './work-item-executions'
import { KubernetesInstance } from '../kubernetes/kubernetes-instance'
import { WorkKubernetesEnvironment, WorkKubernetesServer } from './work-environment'
import { WorkItem } from './work-item'
import { ContainerWorkTask } from './work-task'
import { JobSecret, JobSecretSpec } from '../kubernetes/job-secrets'
import { WorkSecret } from './work-secret'
import { NETWORK_GATE_CONTAINER } from '../kubernetes/network-gate'

describe('describeFailedJob', () => {
  const env: WorkKubernetesEnvironment = {
    type: 'kubernetes',
    namespace: 'demo',
    context: 'ctx',
    httpRoutes: [],
    networkPolicyEnforced: true,
  }
  const secret: JobSecret = {
    index: 0,
    secret: {
      source: { type: 'provider', provider: 'files', ref: 'missing', account: 'ci' },
      target: { type: 'env', name: 'API_KEY' },
    } as WorkSecret,
    source: { provider: 'files', ref: 'missing', account: 'ci' } as any,
  }

  function failed(name: string, exitCode: number, message?: string): V1ContainerStatus {
    return {
      name,
      image: 'alpine',
      imageID: '',
      ready: false,
      restartCount: 0,
      state: { terminated: { exitCode, reason: 'Error', message } },
    }
  }

  function job(statuses: V1ContainerStatus[], containerStatuses: V1ContainerStatus[] = []): KubernetesInstance {
    return {
      coreApi: {
        listNamespacedPod: async () => ({
          items: [
            { metadata: { name: 'build-job-x' }, status: { initContainerStatuses: statuses, containerStatuses } },
          ],
        }),
      },
    } as unknown as KubernetesInstance
  }

  it('says the network policy was not in force when the gate failed', async () => {
    const message = 'hammerkit: the network policy of this pod is not enforced, it still reaches 10.96.0.10'
    expect(
      await describeFailedJob(job([failed(NETWORK_GATE_CONTAINER, 1, message)]), env, 'build', 'build-job', 'cmd-1', [])
    ).toEqual({ type: 'error', message: `build: ${message}` })
  })

  it('names the secret an init container could not read, never its output', async () => {
    const instance = job([failed(NETWORK_GATE_CONTAINER, 0), failed('secret-0', 1)])
    expect(await describeFailedJob(instance, env, 'build', 'build-job', 'cmd-1', [secret])).toEqual({
      type: 'error',
      message: 'secret API_KEY (files:missing as ci) could not be read: Error 1',
    })
  })

  it('leaves the reason to the command when every init container succeeded', async () => {
    const instance = job([failed(NETWORK_GATE_CONTAINER, 0), failed('secret-0', 0)])
    expect(await describeFailedJob(instance, env, 'build', 'build-job', 'cmd-1', [secret])).toBeUndefined()
  })

  it('gives the exit code of the command, as a crash on a host', async () => {
    const instance = job([failed(NETWORK_GATE_CONTAINER, 0)], [failed('cmd-2', 0), failed('cmd-1', 3)])
    expect(await describeFailedJob(instance, env, 'build', 'build-job', 'cmd-1', [])).toEqual({
      type: 'crash',
      exitCode: 3,
    })
    expect(await describeFailedJob(instance, env, 'build', 'build-job', 'cmd-2', [])).toBeUndefined()
  })

  it('records when the command of the job ran, as its container says', async () => {
    const task = { name: 'build' } as ContainerWorkTask
    const ran = (name: string): V1ContainerStatus => ({
      ...failed(name, 0),
      state: {
        terminated: {
          exitCode: 0,
          startedAt: new Date('2026-11-14T10:00:20Z'),
          finishedAt: new Date('2026-11-14T10:01:00Z'),
        },
      },
    })
    await recordJobExecution(job([failed(NETWORK_GATE_CONTAINER, 0)], [ran('cmd-1')]), env, task, 'build-job', 'cmd-1')
    // a container that never started (the image did not pull) ran nothing
    await recordJobExecution(job([], [failed('cmd-2', 1)]), env, task, 'build-job', 'cmd-2')
    expect(readExecutions(task)).toEqual([
      { startedAt: new Date('2026-11-14T10:00:20Z'), finishedAt: new Date('2026-11-14T10:01:00Z') },
    ])
  })
})

describe('getTaskJobContainers', () => {
  const server: WorkKubernetesServer = {
    run: 'run_1',
    namespace: 'hammerkit',
    pools: [],
    providers: {},
    accounts: {},
    capabilities: { runtimeClass: 'gvisor' },
  }
  const kubernetes: WorkKubernetesEnvironment = {
    type: 'kubernetes',
    namespace: 'hammerkit-0123456789abcdef',
    httpRoutes: [],
    networkPolicyEnforced: true,
    server,
  }
  const secretSpec: JobSecretSpec = {
    initContainers: [],
    volumes: [],
    mounts: [],
    command: (shell, cmd) => ({ command: [shell, '-c'], args: [cmd], env: [] }),
  }
  const pod = (capAdd: string[], environment = kubernetes) => {
    const task = {
      name: 'image',
      data: { image: 'moby/buildkit:v0.25.1', shell: 'sh', cmds: [{ cmd: 'true', cwd: '/build' }], capAdd },
    } as unknown as WorkItem<ContainerWorkTask>
    return getTaskJobContainers({
      task,
      cmd: task.data.cmds[0],
      container: 'cmd-1',
      envs: {},
      secrets: { env: [], mounts: [] },
      network: { env: [], initContainers: [] },
      secretSpec,
      mounts: [],
      kubernetes: environment,
    })
  }

  it('adds the capabilities of a task in the RuntimeClass of the server only', () => {
    const sandboxed = pod(['SYS_ADMIN'])
    expect(sandboxed.runtimeClassName).toBe('gvisor')
    expect(sandboxed.containers[0].securityContext).toEqual({
      allowPrivilegeEscalation: false,
      capabilities: { drop: ['NET_RAW'], add: ['SYS_ADMIN'] },
      seccompProfile: { type: 'RuntimeDefault' },
    })
    // a task of the same run that adds none runs as before
    const plain = pod([])
    expect(plain.runtimeClassName).toBeUndefined()
    expect(plain.containers[0].securityContext?.capabilities).toEqual({ drop: ['NET_RAW'] })
  })

  it('refuses the capabilities where the namespace or the server can not admit them', () => {
    const unavailable = 'the namespace hammerkit-0123456789abcdef was made before backend.capabilities'
    expect(() =>
      pod(['SYS_ADMIN'], {
        ...kubernetes,
        server: { ...server, capabilities: { runtimeClass: 'gvisor', unavailable } },
      })
    ).toThrow(`image: adds the capabilities SYS_ADMIN, but ${unavailable}`)
    expect(() => pod(['SYS_ADMIN'], { ...kubernetes, server: { ...server, capabilities: undefined } })).toThrow(
      'which this server grants in no sandboxed runtime'
    )
  })
})

describe('isRolledOut', () => {
  const deployment = (labels: { [key: string]: string }, status: object, generation = 2) =>
    ({ metadata: { labels, generation }, status }) as any
  const done = { observedGeneration: 2, replicas: 1, updatedReplicas: 1, availableReplicas: 1 }
  const current = { 'hammerkit.dev/definition': 'def', 'hammerkit.dev/state': 'state' }

  it('leaves a service of a service run as it is when it is of the same definition and state, and up', () => {
    expect(isRolledOut(deployment(current, done), 'def', 'state')).toBe(true)
  })

  it('rolls one that changed, or one that is not all up at its spec', () => {
    expect(isRolledOut(deployment(current, done), 'def', 'other')).toBe(false)
    expect(isRolledOut(deployment(current, done), 'other', 'state')).toBe(false)
    expect(isRolledOut(deployment(current, { ...done, availableReplicas: 0 }), 'def', 'state')).toBe(false)
    expect(isRolledOut(deployment(current, { ...done, replicas: 2 }), 'def', 'state')).toBe(false)
    expect(isRolledOut(deployment(current, { ...done, observedGeneration: 1 }), 'def', 'state')).toBe(false)
  })
})
