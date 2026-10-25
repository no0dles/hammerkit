import { EventEmitter } from 'events'
import { Writable } from 'stream'
import {
  buildRunnerPod,
  canUseRunner,
  executeInRunner,
  getExecExitCode,
  getRunnerKey,
  getRunnerName,
  removeSandboxRunners,
} from './sandbox-runner'
import { ensureKubernetesItemNetwork } from './network-policy'
import { KubernetesPersistence } from './volumes'
import { WorkKubernetesEnvironment } from '../planner/work-environment'

vi.mock('./network-policy', async (original) => ({
  ...(await original<typeof import('./network-policy')>()),
  ensureKubernetesItemNetwork: vi.fn(async () => ({
    env: [{ name: 'HTTP_PROXY', value: 'http://hammerkit-proxy:3128' }],
    secretEnv: [],
    hostAliases: [{ ip: '10.0.0.9', hostnames: ['hammerkit-proxy'] }],
    initContainers: [{ name: 'hammerkit-network', image: 'gate' }],
    close: vi.fn(),
  })),
  removeSandboxProxies: vi.fn(async () => undefined),
}))

const files = { name: 'hammerkit-sandbox-abc-files', uid: 'files-1' }

function environment(patch: object = {}): WorkKubernetesEnvironment {
  return {
    type: 'kubernetes',
    namespace: 'caller',
    httpRoutes: [],
    networkPolicyEnforced: true,
    server: {
      run: 'run_1',
      namespace: 'hammerkit',
      pools: [{ name: 'default', platform: { os: 'linux', arch: 'amd64' }, nodeSelector: {}, tolerations: [] }],
      providers: {},
      accounts: {},
      workspace: {
        root: '/runs/run_1',
        claim: 'hammerkit-sandbox-abc',
        subPath: 'files',
        label: 'abc',
        pod: files,
        runner: true,
      },
    },
    ...patch,
  } as WorkKubernetesEnvironment
}

function shell(patch: object = {}): any {
  const lines: [string, string][] = []
  return {
    name: 'shell',
    id: () => 'task-id-with-the-arguments',
    status: { console: (type: string, line: string) => lines.push([type, line]), write: vi.fn() },
    lines,
    needs: [],
    deps: [],
    requiredBy: [],
    data: {
      type: 'container-task',
      image: 'node:24-alpine',
      shell: 'sh',
      envs: { variables: { CI: 'true' }, replacements: [] },
      cmds: [{ cmd: 'npm test', cwd: '/build' }],
      secrets: [],
      generates: [],
      network: { type: 'allow', hosts: ['registry.npmjs.org'] },
      ...patch,
    },
  }
}

const persistence = (patch: Partial<KubernetesPersistence> = {}): KubernetesPersistence => ({
  volumes: [],
  sizes: {},
  kept: [],
  workspace: [{ name: 'hammerkit-sandbox', persistentVolumeClaim: { claimName: 'hammerkit-sandbox-abc' } }],
  mounts: [
    {
      mount: { name: 'hammerkit-sandbox', mountPath: '/build', subPath: 'files' },
      cwd: '/build',
      uploadPath: '',
      workspace: true,
    },
  ],
  sources: [],
  initCommands: [],
  ...patch,
})

describe('the runner of a sandbox', () => {
  it('takes a shell of the sandbox only', () => {
    const env = environment()
    expect(canUseRunner(shell(), env, persistence())).toBe(true)
    // something besides the sandbox's files: outputs, its own claims, needs, secrets
    expect(canUseRunner(shell({ generates: [{ path: '/build/dist' }] }), env, persistence())).toBe(false)
    expect(canUseRunner(shell(), env, persistence({ volumes: [{ name: 'hammerkit-x' }] }))).toBe(false)
    expect(canUseRunner({ ...shell(), needs: [{ name: 'db' }] }, env, persistence())).toBe(false)
    expect(canUseRunner(shell({ secrets: [{ env: 'TOKEN' }] }), env, persistence())).toBe(false)
    // not on the sandbox's files, a server without runners, a run that holds no pod of the files
    expect(canUseRunner(shell(), env, persistence({ workspace: [] }))).toBe(false)
    const off = environment()
    delete off.server!.workspace!.runner
    expect(canUseRunner(shell(), off, persistence())).toBe(false)
    const without = environment()
    delete off.server!.workspace!.pod
    delete without.server!.workspace!.pod
    expect(canUseRunner(shell(), without, persistence())).toBe(false)
  })

  it('is named after what its pod is made of, not after the command', () => {
    const env = environment()
    const key = getRunnerKey(shell(), env, persistence())
    expect(key).toMatch(/^[0-9a-f]{40}$/)
    expect(getRunnerName(key)).toBe(`hammerkit-runner-${key.slice(0, 20)}`)
    // another command, or its arguments, keep it
    expect(
      getRunnerKey(
        { ...shell({ cmds: [{ cmd: 'npm run lint', cwd: '/build/app' }] }), id: () => 'other' },
        env,
        persistence()
      )
    ).toBe(key)
    // what the pod is made of changes it
    expect(getRunnerKey(shell({ image: 'node:22-alpine' }), env, persistence())).not.toBe(key)
    expect(
      getRunnerKey(shell({ envs: { variables: { CI: 'false' }, replacements: [] } }), env, persistence())
    ).not.toBe(key)
    expect(getRunnerKey(shell({ network: { type: 'none' } }), env, persistence())).not.toBe(key)
    const otherPod = environment()
    otherPod.server!.workspace!.pod = { ...files, uid: 'files-2' }
    expect(getRunnerKey(shell(), otherPod, persistence())).not.toBe(key)
  })

  it('is the pod of the task as its Job would have it, owned by the pod of the files', () => {
    const env = environment()
    const key = getRunnerKey(shell(), env, persistence())
    const pod = buildRunnerPod({
      task: shell(),
      kubernetes: env,
      persistence: persistence(),
      key,
      network: {
        env: [{ name: 'HTTP_PROXY', value: 'http://hammerkit-proxy:3128' }],
        hostAliases: [{ ip: '10.0.0.9', hostnames: ['hammerkit-proxy'] }],
        initContainers: [{ name: 'hammerkit-network', image: 'gate' }],
      },
      owner: { apiVersion: 'v1', kind: 'Pod', ...files },
    })
    expect(pod.metadata.labels).toEqual({
      'hammerkit.dev/id': key,
      'hammerkit.dev/runner': key.slice(0, 20),
      'hammerkit.dev/sandbox': 'abc',
      'hammerkit.dev/network': 'limited',
    })
    // nothing of a run: it outlives them
    expect(pod.metadata.labels).not.toHaveProperty('hammerkit.dev/run')
    expect(pod.metadata.ownerReferences).toEqual([{ apiVersion: 'v1', kind: 'Pod', ...files }])
    expect(pod.spec).toMatchObject({
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      restartPolicy: 'Never',
      nodeSelector: { 'kubernetes.io/os': 'linux', 'kubernetes.io/arch': 'amd64' },
      hostAliases: [{ ip: '10.0.0.9', hostnames: ['hammerkit-proxy'] }],
      initContainers: [{ name: 'hammerkit-network', image: 'gate' }],
      affinity: { podAffinity: expect.anything() },
    })
    const [container] = pod.spec!.containers
    expect(container).toMatchObject({
      image: 'node:24-alpine',
      workingDir: '/build',
      env: [
        { name: 'CI', value: 'true' },
        { name: 'HTTP_PROXY', value: 'http://hammerkit-proxy:3128' },
      ],
      securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ['NET_RAW'] } },
    })
    expect(container.volumeMounts).toEqual([
      { name: 'hammerkit-sandbox', mountPath: '/build', subPath: 'files' },
      { name: 'hammerkit-runner-tmp', mountPath: '/tmp' },
    ])
    expect(pod.spec!.volumes).toEqual([
      { name: 'hammerkit-sandbox', persistentVolumeClaim: { claimName: 'hammerkit-sandbox-abc' } },
      { name: 'hammerkit-runner-tmp', emptyDir: {} },
    ])
  })

  it('reads the exit code of a command from the status of its exec', () => {
    expect(getExecExitCode({ status: 'Success' })).toBe(0)
    expect(
      getExecExitCode({
        status: 'Failure',
        reason: 'NonZeroExitCode',
        details: { causes: [{ reason: 'ExitCode', message: '7' }] },
      })
    ).toBe(7)
    expect(getExecExitCode({ status: 'Failure', message: 'container not found' })).toBeUndefined()
    expect(getExecExitCode(undefined)).toBeUndefined()
  })

  describe('a command', () => {
    // A cluster with the pod of the files, where a created runner runs at once and an exec
    // answers what `answer` says for its command
    function cluster(answer: (command: string[]) => { out?: string; status: any; hang?: boolean }) {
      const pods = new Map<string, any>([[files.name, { metadata: { ...files }, status: { phase: 'Running' } }]])
      const calls: string[] = []
      const notFound = () => Promise.reject(Object.assign(new Error('not found'), { code: 404 }))
      const sockets: EventEmitter[] = []
      // what still runs ends once it is killed, or its pod goes
      const hanging = new Set<EventEmitter>()
      const endHanging = () => {
        for (const socket of hanging) {
          socket.emit('close')
        }
        hanging.clear()
      }
      const instance = {
        coreApi: {
          readNamespacedPod: async ({ name }: any) => pods.get(name) ?? notFound(),
          deleteNamespacedPod: async ({ name }: any) => {
            calls.push(`delete ${name}`)
            pods.delete(name)
            endHanging()
          },
          listNamespacedPod: async () => ({
            items: [...pods.values()].filter((pod) => pod.metadata.labels?.['hammerkit.dev/runner']),
          }),
        },
        objectApi: {
          create: async (spec: any) => {
            calls.push(`create ${spec.metadata.name}`)
            pods.set(spec.metadata.name, {
              ...spec,
              metadata: { ...spec.metadata, uid: `uid-${spec.metadata.name}` },
              status: { phase: 'Running', containerStatuses: [{ name: 'runner', state: { running: {} } }] },
            })
            return spec
          },
          patch: async (spec: any, ...rest: any[]) => {
            calls.push(`patch ${spec.metadata.name} ${spec.metadata.ownerReferences.map((o: any) => o.uid)} ${rest[4]}`)
            return spec
          },
          delete: async (spec: any) => calls.push(`delete ${spec.kind} ${spec.metadata.name}`),
        },
        exec: {
          exec: async (
            _ns: string,
            pod: string,
            container: string,
            command: string[],
            stdout: Writable | null,
            _stderr: Writable | null,
            _stdin: unknown,
            _tty: boolean,
            done: (status: any) => void
          ) => {
            calls.push(`exec ${pod} ${container} ${command.slice(-3).join(' ')}`)
            const socket = Object.assign(new EventEmitter(), { close: () => socket.emit('close') })
            sockets.push(socket)
            const result = answer(command)
            setImmediate(() => {
              if (result.out) {
                stdout?.write(result.out)
              }
              if (result.hang) {
                hanging.add(socket)
                return
              }
              done(result.status)
              stdout?.end()
              socket.emit('close')
              if (command.join(' ') === 'sh -c kill -KILL -1' && result.status?.status === 'Success') {
                endHanging()
              }
            })
            return socket
          },
        },
      }
      return { instance: instance as any, calls, pods, sockets }
    }

    it('starts the runner once and execs into it after', async () => {
      const { instance, calls, pods } = cluster(() => ({ out: 'ok\npartial', status: { status: 'Success' } }))
      const env = environment()
      const task = shell()
      const key = getRunnerKey(task, env, persistence())
      const name = getRunnerName(key)
      const abort = new AbortController().signal
      expect(await executeInRunner(instance, task, env, persistence(), abort)).toEqual({ type: 'done' })
      expect(calls).toEqual([
        `create ${name}`,
        // the policy goes once the runner went too
        `patch hammerkit-network-${key} files-1,uid-${name} application/merge-patch+json`,
        `exec ${name} runner sh -c npm test`,
      ])
      // its policy and proxy are the runner's: keyed like it, with no run
      expect(ensureKubernetesItemNetwork).toHaveBeenLastCalledWith(
        instance,
        env,
        expect.objectContaining({ name: 'shell' }),
        expect.objectContaining({ run: null, owners: [{ apiVersion: 'v1', kind: 'Pod', ...files }] })
      )
      const item = vi.mocked(ensureKubernetesItemNetwork).mock.lastCall![2]
      expect(item.id()).toBe(key)
      expect(task.lines).toEqual([
        ['stdout', 'ok'],
        ['stdout', 'partial'],
      ])

      calls.length = 0
      expect(await executeInRunner(instance, task, env, persistence(), abort)).toEqual({ type: 'done' })
      expect(calls).toEqual([`exec ${name} runner sh -c npm test`])
      expect(vi.mocked(ensureKubernetesItemNetwork).mock.lastCall![3].owners).toEqual([
        { apiVersion: 'v1', kind: 'Pod', ...files },
        { apiVersion: 'v1', kind: 'Pod', name, uid: `uid-${name}` },
      ])

      // one of something else goes, with its limits
      calls.length = 0
      const other = shell({ image: 'node:22-alpine' })
      const otherName = getRunnerName(getRunnerKey(other, env, persistence()))
      expect(await executeInRunner(instance, other, env, persistence(), abort)).toEqual({ type: 'done' })
      expect(calls.slice(0, 3)).toEqual([
        `delete ${name}`,
        `delete NetworkPolicy hammerkit-network-${key}`,
        `create ${otherName}`,
      ])
      expect(pods.has(name)).toBe(false)
    })

    it('answers the exit code of a command that failed, and runs no command after it', async () => {
      const { instance, calls } = cluster(() => ({
        status: { status: 'Failure', details: { causes: [{ reason: 'ExitCode', message: '3' }] } },
      }))
      const task = shell({
        cmds: [
          { cmd: 'false', cwd: '/build' },
          { cmd: 'echo never', cwd: '/build' },
        ],
      })
      expect(await executeInRunner(instance, task, environment(), persistence(), new AbortController().signal)).toEqual(
        {
          type: 'crash',
          exitCode: 3,
        }
      )
      expect(calls.filter((call) => call.startsWith('exec'))).toHaveLength(1)
    })

    it('kills what a cancelled command runs', async () => {
      const { instance, calls } = cluster((command) =>
        command.includes('kill -KILL -1') && command.length === 3
          ? { status: { status: 'Success' } }
          : { status: undefined, hang: true }
      )
      const abort = new AbortController()
      const running = executeInRunner(instance, shell(), environment(), persistence(), abort.signal)
      await vi.waitFor(() => expect(calls.some((call) => call.includes('npm test'))).toBe(true))
      abort.abort()
      expect(await running).toEqual({ type: 'canceled' })
      expect(calls.filter((call) => call.startsWith('exec'))).toEqual([
        expect.stringContaining('npm test'),
        expect.stringContaining('kill -KILL -1'),
      ])
    }, 20000)

    it('deletes the runner when what a cancelled command runs could not be killed', async () => {
      const { instance, calls, pods } = cluster((command) =>
        command.length === 3
          ? { status: { status: 'Failure', message: 'container not found' } }
          : { status: undefined, hang: true }
      )
      const env = environment()
      const name = getRunnerName(getRunnerKey(shell(), env, persistence()))
      const abort = new AbortController()
      const running = executeInRunner(instance, shell(), env, persistence(), abort.signal)
      await vi.waitFor(() => expect(calls.some((call) => call.includes('npm test'))).toBe(true))
      abort.abort()
      expect(await running).toEqual({ type: 'canceled' })
      expect(calls).toContain(`delete ${name}`)
      expect(pods.has(name)).toBe(false)
    }, 20000)

    it('leaves a task to its Jobs when the runner is taken or the pod of the files went', async () => {
      const { instance, pods } = cluster((command) =>
        command.includes('slow') ? { status: undefined, hang: true } : { status: { status: 'Success' } }
      )
      const env = environment()
      const abort = new AbortController()
      // another task of the run is in it
      const busy = executeInRunner(
        instance,
        shell({ cmds: [{ cmd: 'slow', cwd: '/build' }] }),
        env,
        persistence(),
        abort.signal
      )
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(await executeInRunner(instance, shell(), env, persistence(), new AbortController().signal)).toEqual({
        type: 'unavailable',
      })
      abort.abort()
      await busy
      // the pod of the files made way for a pod of the run
      pods.delete(files.name)
      expect(await executeInRunner(instance, shell(), env, persistence(), new AbortController().signal)).toEqual({
        type: 'unavailable',
      })
    }, 20000)

    it('leaves a task to its Jobs when the runner does not start', async () => {
      const { instance, calls, pods } = cluster(() => ({ status: { status: 'Success' } }))
      instance.objectApi.create = async (spec: any) => {
        calls.push(`create ${spec.metadata.name}`)
        pods.set(spec.metadata.name, {
          metadata: spec.metadata,
          status: {
            phase: 'Failed',
            containerStatuses: [{ name: 'runner', state: { terminated: { exitCode: 127 } } }],
          },
        })
        return spec
      }
      expect(
        await executeInRunner(instance, shell(), environment(), persistence(), new AbortController().signal)
      ).toEqual({
        type: 'unavailable',
      })
      expect(calls.some((call) => call.startsWith('exec'))).toBe(false)
      expect(pods.size).toBe(1)
    })
  })

  it('removes the runners of a sandbox with their limits, but those kept', async () => {
    const calls: string[] = []
    const instance = {
      coreApi: {
        listNamespacedPod: async (request: any) => {
          calls.push(`list ${request.labelSelector}`)
          return {
            items: [
              { metadata: { name: 'hammerkit-runner-a', labels: { 'hammerkit.dev/id': 'a'.repeat(40) } } },
              { metadata: { name: 'hammerkit-runner-b', labels: { 'hammerkit.dev/id': 'b'.repeat(40) } } },
            ],
          }
        },
        deleteNamespacedPod: async ({ name }: any) => calls.push(`delete ${name}`),
        readNamespacedPod: async () => Promise.reject(Object.assign(new Error('gone'), { code: 404 })),
      },
      objectApi: { delete: async (spec: any) => calls.push(`delete ${spec.kind} ${spec.metadata.name}`) },
    }
    await removeSandboxRunners(instance as any, 'caller', 'abc', (pod) => pod.metadata?.name === 'hammerkit-runner-b')
    expect(calls).toEqual([
      'list hammerkit.dev/sandbox=abc,hammerkit.dev/runner',
      'delete hammerkit-runner-a',
      `delete NetworkPolicy hammerkit-network-${'a'.repeat(40)}`,
    ])
  })
})
