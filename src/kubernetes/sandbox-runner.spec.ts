import { EventEmitter } from 'events'
import { Writable } from 'stream'
import {
  buildRunnerPod,
  canUseRunner,
  getCleanUp,
  getRunnerMounts,
  getScratchDirectories,
  getWrapper,
  executeInRunner,
  getExecExitCode,
  getRunnerKey,
  getRunnerName,
  removeSandboxRunners,
  RUNNER_TOOLS_IMAGE,
} from './sandbox-runner'

const CLEAN_UP = getCleanUp(['/tmp', '/dev/shm'])
const WRAPPER = getWrapper(CLEAN_UP, ['/.hammerkit-sandbox/src'])
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
      cmds: [{ cmd: 'npm test', cwd: '/runs/run_1' }],
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
      mount: { name: 'hammerkit-sandbox', mountPath: '/runs/run_1', subPath: 'files' },
      cwd: '/runs/run_1',
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
    // a part of the files only (`src: [src]`): the folders around the mount would be the
    // runner's own, and what a command left there the next runs' files
    const part = persistence().mounts[0]
    const parts = [{ ...part, mount: { ...part.mount, mountPath: '/runs/run_1/src', subPath: 'files/src' } }]
    expect(canUseRunner(shell(), env, persistence({ mounts: parts }))).toBe(false)
    expect(canUseRunner(shell(), env, persistence({ mounts: [...parts, part] }))).toBe(true)
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
    // the next run has the sandbox in a directory of its own: the same runner
    const nextRun = environment()
    nextRun.server!.workspace!.root = '/runs/run_2'
    const nextMounts = persistence({
      mounts: [
        {
          mount: { name: 'hammerkit-sandbox', mountPath: '/runs/run_2', subPath: 'files' },
          cwd: '/runs/run_2',
          uploadPath: '',
          workspace: true,
        },
      ],
    })
    expect(getRunnerKey(shell({ cmds: [{ cmd: 'npm test', cwd: '/runs/run_2' }] }), nextRun, nextMounts)).toBe(key)
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
      initContainers: [
        { name: 'hammerkit-network', image: 'gate' },
        {
          name: 'hammerkit-runner-tools',
          image: RUNNER_TOOLS_IMAGE,
          command: ['/bin/busybox', 'cp', '/bin/busybox', '/.hammerkit/busybox'],
          securityContext: { runAsNonRoot: true, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } },
        },
      ],
      affinity: { podAffinity: expect.anything() },
    })
    const [container] = pod.spec!.containers
    expect(container).toMatchObject({
      image: 'node:24-alpine',
      // nothing of the image: a command may replace its sh and sleep
      command: ['/.hammerkit/busybox', 'sh', '-c', expect.stringContaining('/.hammerkit/busybox sleep')],
      // the run's directory links there
      workingDir: '/.hammerkit-sandbox',
      env: [
        { name: 'CI', value: 'true' },
        { name: 'HTTP_PROXY', value: 'http://hammerkit-proxy:3128' },
      ],
      securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ['NET_RAW'] } },
    })
    expect(container.volumeMounts).toEqual([
      { name: 'hammerkit-sandbox', mountPath: '/.hammerkit-sandbox', subPath: 'files' },
      { name: 'hammerkit-runner-tmp', mountPath: '/tmp' },
      { name: 'hammerkit-runner-tools', mountPath: '/.hammerkit', readOnly: true },
    ])
    expect(pod.spec!.volumes).toEqual([
      { name: 'hammerkit-sandbox', persistentVolumeClaim: { claimName: 'hammerkit-sandbox-abc' } },
      { name: 'hammerkit-runner-tmp', emptyDir: {} },
      { name: 'hammerkit-runner-tools', emptyDir: {} },
    ])
  })

  it('leaves a scratch directory alone that holds a mount of the task, or is in one', () => {
    const at = (mountPath: string) => ({ name: 'hammerkit-sandbox', mountPath })
    expect(getScratchDirectories([at('/build')])).toEqual(['/tmp', '/dev/shm'])
    expect(getScratchDirectories([at('/tmp/hammerkit-1/run/sandbox/src')])).toEqual(['/dev/shm'])
    expect(getScratchDirectories([at('/tmp')])).toEqual(['/dev/shm'])
    expect(getScratchDirectories([at('/dev')])).toEqual(['/tmp'])
    expect(getScratchDirectories([at('/tmpfiles')])).toEqual(['/tmp', '/dev/shm'])
    // the runner has the files at a path of its own, not where the server keeps its runs
    expect(
      getRunnerMounts(
        { root: '/tmp/hammerkit-1/run/sandbox' },
        { mounts: [{ mount: at('/tmp/hammerkit-1/run/sandbox/src'), cwd: '', uploadPath: '' }] }
      )
    ).toEqual([at('/.hammerkit-sandbox/src')])
    expect(getCleanUp([])).not.toContain('rm')
    expect(getCleanUp(['/dev/shm'])).not.toContain('/tmp')
  })

  it('checks that each mount is still the mount it was made as before the command', () => {
    const wrapper = getWrapper(CLEAN_UP, ['/.hammerkit-sandbox/src', "/.hammerkit-sandbox/it's here"])
    const lines = wrapper.split('\n')
    const command = lines.indexOf('"$@"')
    const check = lines.findIndex((line) => line.includes('/proc/self/mountinfo'))
    expect(check).toBeGreaterThan(-1)
    expect(check).toBeLessThan(command)
    expect(wrapper).toContain(
      "[ \"$(/.hammerkit/busybox realpath '/.hammerkit-sandbox/src')\" = '/.hammerkit-sandbox/src' ] && /.hammerkit/busybox grep -q '^[^ ]* [^ ]* [^ ]* [^ ]* /\\.hammerkit-sandbox/src ' /proc/self/mountinfo || changed \"$1\""
    )
    // a space as mountinfo writes it, a quote kept within the shell's quotes
    expect(wrapper).toContain("/\\.hammerkit-sandbox/it'\\''s\\\\040here ")
    expect(wrapper).toContain('case "$(pwd -P)" in')
  })

  it('cleans up with the busybox of the tools only, before and after the command', () => {
    expect(CLEAN_UP).toContain('kill -KILL -1')
    expect(CLEAN_UP).toContain('/.hammerkit/busybox rm -rf /tmp/* /tmp/.[!.]* /tmp/..?* /dev/shm/*')
    // the shell's own kill and the busybox's rm, nothing a command could replace on the PATH
    expect(CLEAN_UP.split('\n').every((line) => !/(^|; )(rm|sleep|sh) /.test(line))).toBe(true)
    const lines = WRAPPER.split('\n')
    expect(lines.indexOf('"$@"')).toBeGreaterThan(lines.indexOf(CLEAN_UP.split('\n')[2]))
    expect(lines.lastIndexOf(CLEAN_UP.split('\n')[2])).toBeGreaterThan(lines.indexOf('"$@"'))
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
    function cluster(answer: (command: string[]) => { out?: string; err?: string; status: any; hang?: boolean }) {
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
            stderr: Writable | null,
            _stdin: unknown,
            _tty: boolean,
            done: (status: any) => void
          ) => {
            calls.push(
              command[3] === CLEAN_UP
                ? `exec ${pod} ${container} clean up`
                : `exec ${pod} ${container} ${command.slice(-3).join(' ')}`
            )
            const socket = Object.assign(new EventEmitter(), { close: () => socket.emit('close') })
            sockets.push(socket)
            const result = answer(command)
            setImmediate(() => {
              if (result.out) {
                stdout?.write(result.out)
              }
              if (result.err) {
                stderr?.write(result.err)
              }
              if (result.hang) {
                hanging.add(socket)
                return
              }
              done(result.status)
              stdout?.end()
              socket.emit('close')
              if (command[3] === CLEAN_UP && result.status?.status === 'Success') {
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
          { cmd: 'false', cwd: '/runs/run_1' },
          { cmd: 'echo never', cwd: '/runs/run_1' },
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
        command[3] === CLEAN_UP ? { status: { status: 'Success' } } : { status: undefined, hang: true }
      )
      const abort = new AbortController()
      const running = executeInRunner(instance, shell(), environment(), persistence(), abort.signal)
      await vi.waitFor(() => expect(calls.some((call) => call.includes('npm test'))).toBe(true))
      abort.abort()
      expect(await running).toEqual({ type: 'canceled' })
      expect(calls.filter((call) => call.startsWith('exec'))).toEqual([
        expect.stringContaining('npm test'),
        expect.stringContaining('clean up'),
      ])
    })

    it('kills what a command runs when its connection breaks, before the run lets go of the sandbox', async () => {
      const { instance, calls, sockets } = cluster((command) =>
        command[3] === CLEAN_UP ? { status: { status: 'Success' } } : { status: undefined, hang: true }
      )
      const running = executeInRunner(instance, shell(), environment(), persistence(), new AbortController().signal)
      await vi.waitFor(() => expect(calls.some((call) => call.includes('npm test'))).toBe(true))
      sockets[0].emit('error', new Error('connection reset'))
      await expect(running).rejects.toThrow('connection reset')
      expect(calls.filter((call) => call.startsWith('exec'))).toEqual([
        expect.stringContaining('npm test'),
        expect.stringContaining('clean up'),
      ])
    })

    it('deletes the runner when what a cancelled command runs could not be killed', async () => {
      const { instance, calls, pods } = cluster((command) =>
        command[3] === CLEAN_UP
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
    })

    it('leaves a task to its Jobs when the runner is taken or the pod of the files went', async () => {
      const { instance, pods } = cluster((command) =>
        command.includes('slow') ? { status: undefined, hang: true } : { status: { status: 'Success' } }
      )
      const env = environment()
      const abort = new AbortController()
      // another task of the run is in it
      const busy = executeInRunner(
        instance,
        shell({ cmds: [{ cmd: 'slow', cwd: '/runs/run_1' }] }),
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
      // an image without sh, say
      const task = shell({ image: 'distroless' })
      expect(await executeInRunner(instance, task, environment(), persistence(), new AbortController().signal)).toEqual(
        { type: 'unavailable' }
      )
      expect(calls.some((call) => call.startsWith('exec'))).toBe(false)
      expect(pods.size).toBe(1)
      // and is not tried again while the pod of the files stays
      const tried = calls.filter((call) => call.startsWith('create')).length
      expect(await executeInRunner(instance, task, environment(), persistence(), new AbortController().signal)).toEqual(
        { type: 'unavailable' }
      )
      expect(calls.filter((call) => call.startsWith('create'))).toHaveLength(tried)
    })

    it('removes a runner a command before changed, and fails the task rather than running it again', async () => {
      const { instance, calls, pods } = cluster((command) =>
        command[3] === CLEAN_UP
          ? { status: { status: 'Success' } }
          : {
              // what the wrapper says when a mount is not what it was made as
              err: `${command[5]}\n`,
              status: { status: 'Failure', details: { causes: [{ reason: 'ExitCode', message: '125' }] } },
            }
      )
      const task = shell({ image: 'node:16-alpine' })
      const name = getRunnerName(getRunnerKey(task, environment(), persistence()))
      // a command can say what the wrapper says too, after it ran: no second run as a Job
      await expect(
        executeInRunner(instance, task, environment(), persistence(), new AbortController().signal)
      ).rejects.toThrow('a command changed the runner of the sandbox, it was removed: run the task again')
      expect(calls).toContain(`delete ${name}`)
      expect(pods.has(name)).toBe(false)
      // the line of the wrapper is not the command's output
      expect(task.lines).toEqual([])
    })

    it('answers an exit code 125 of the command itself as its own', async () => {
      const { instance } = cluster(() => ({
        err: 'hammerkit-runner-changed-0000\n',
        status: { status: 'Failure', details: { causes: [{ reason: 'ExitCode', message: '125' }] } },
      }))
      const task = shell({ image: 'node:16-alpine' })
      expect(await executeInRunner(instance, task, environment(), persistence(), new AbortController().signal)).toEqual(
        { type: 'crash', exitCode: 125 }
      )
    })

    it('leaves the runner starting when its command stops meanwhile, for the next command', async () => {
      const { instance, calls, pods } = cluster(() => ({ status: { status: 'Success' } }))
      const create = instance.objectApi.create
      instance.objectApi.create = async (spec: any) => {
        const made = await create(spec)
        pods.get(spec.metadata.name).status = { phase: 'Pending' }
        return made
      }
      const task = shell({ image: 'node:18-alpine' })
      const name = getRunnerName(getRunnerKey(task, environment(), persistence()))
      const abort = new AbortController()
      const first = executeInRunner(instance, task, environment(), persistence(), abort.signal)
      await vi.waitFor(() => expect(calls).toContain(`create ${name}`))
      // a short timeout of the agent
      abort.abort()
      expect(await first).toEqual({ type: 'unavailable' })
      expect(calls).not.toContain(`delete ${name}`)
      // it runs by the next command, which takes it
      pods.get(name).status = { phase: 'Running', containerStatuses: [{ name: 'runner', state: { running: {} } }] }
      expect(await executeInRunner(instance, task, environment(), persistence(), new AbortController().signal)).toEqual(
        { type: 'done' }
      )
      expect(calls.filter((call) => call === `create ${name}`)).toHaveLength(1)
      expect(calls).toContainEqual(expect.stringContaining(`exec ${name}`))
    })

    it('leaves a task to its Jobs at once when an image of the runner can not be pulled', async () => {
      const { instance, calls, pods } = cluster(() => ({ status: { status: 'Success' } }))
      instance.objectApi.create = async (spec: any) => {
        calls.push(`create ${spec.metadata.name}`)
        pods.set(spec.metadata.name, {
          metadata: spec.metadata,
          status: {
            phase: 'Pending',
            initContainerStatuses: [
              { name: 'hammerkit-runner-tools', image: 'busybox', state: { waiting: { reason: 'ImagePullBackOff' } } },
            ],
          },
        })
        return spec
      }
      const task = shell({ image: 'node:20-alpine' })
      expect(await executeInRunner(instance, task, environment(), persistence(), new AbortController().signal)).toEqual(
        { type: 'unavailable' }
      )
      expect(task.status.write).toHaveBeenCalledWith('debug', expect.stringContaining('ImagePullBackOff of busybox'))
      expect(pods.size).toBe(1)
    })

    it('leaves a task to its Jobs when the cluster refuses the runner, and tries again next time', async () => {
      const { instance, calls } = cluster(() => ({ status: { status: 'Success' } }))
      const create = instance.objectApi.create
      instance.objectApi.create = async () => {
        throw Object.assign(new Error('pods "x" is forbidden: exceeded quota'), { code: 403 })
      }
      const task = shell({ image: 'node:22-alpine' })
      expect(await executeInRunner(instance, task, environment(), persistence(), new AbortController().signal)).toEqual(
        { type: 'unavailable' }
      )
      expect(task.status.write).toHaveBeenCalledWith('debug', expect.stringContaining('exceeded quota'))
      instance.objectApi.create = create
      expect(await executeInRunner(instance, task, environment(), persistence(), new AbortController().signal)).toEqual(
        { type: 'done' }
      )
      expect(calls.some((call) => call.startsWith('exec'))).toBe(true)
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
