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
  getRunnerScripts,
  removeRunCommands,
  removeSandboxRunners,
  RUNNER_TOOLS_IMAGE,
  getCommandDirectory,
  getRunCommandsDirectory,
} from './sandbox-runner'
import { CommandRecord, createRunnerCommands } from '../executer/runner-commands'
import { statusConsole } from '../planner/work-item-status'
import { getRunnerCommands, relayStatus } from '../server/run-worker'
import type { RunEventData } from '../server/runs'

const CLEAN_UP = getCleanUp(['/tmp', '/dev/shm'])
const WRAPPER = getWrapper(CLEAN_UP, ['/.hammerkit-sandbox/src'])
const SCRIPTS = getRunnerScripts(CLEAN_UP, ['/.hammerkit-sandbox/src'])
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
      capAdd: [],
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
  files: [],
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
    // capabilities hold in the sandboxed runtime of a Job's pod only
    expect(canUseRunner(shell({ capAdd: ['SYS_ADMIN'] }), env, persistence())).toBe(false)
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
      "[ \"$(/.hammerkit/busybox realpath '/.hammerkit-sandbox/src')\" = '/.hammerkit-sandbox/src' ] && /.hammerkit/busybox grep -q '^[^ ]* [^ ]* [^ ]* [^ ]* /\\.hammerkit-sandbox/src ' /proc/self/mountinfo || changed"
    )
    // a space as mountinfo writes it, a quote kept within the shell's quotes
    expect(wrapper).toContain("/\\.hammerkit-sandbox/it'\\''s\\\\040here ")
    expect(wrapper).toContain('case "$(pwd -P)" in')
    // a changed runner is marked in the command's directory, which a restart keeps
    expect(wrapper).toContain('changed() { : > "$d/changed"; end 125; }')
  })

  it('cleans up with the busybox of the tools only, before and after the command', () => {
    expect(CLEAN_UP).toContain('kill -KILL -1')
    expect(CLEAN_UP).toContain('/.hammerkit/busybox rm -rf /tmp/* /tmp/.[!.]* /tmp/..?* /dev/shm/*')
    // the shell's own kill and the busybox's rm, nothing a command could replace on the PATH
    expect(CLEAN_UP.split('\n').every((line) => !/(^|; )(rm|sleep|sh) /.test(line))).toBe(true)
    const kill = CLEAN_UP.split('\n')[1]
    // the start cleans up before it starts the wrapper, the wrapper after the command
    const start = SCRIPTS.start.split('\n')
    expect(start.indexOf(kill)).toBeGreaterThan(-1)
    expect(start.findIndex((line) => line.includes(' setsid '))).toBeGreaterThan(start.indexOf(kill))
    const lines = WRAPPER.split('\n')
    expect(lines.lastIndexOf(kill)).toBeGreaterThan(-1)
    expect(lines.indexOf('"$@"')).toBeGreaterThan(lines.lastIndexOf(kill))
    expect(lines[lines.indexOf('"$@"') + 1]).toBe('end $?')
  })

  it('starts a command detached, once, with its output and exit code in the sandbox', () => {
    const lines = SCRIPTS.start.split('\n')
    const kill = CLEAN_UP.split('\n')[1]
    // one start of a command at a time; a cancel before it wins
    expect(lines.findIndex((line) => line.includes('flock 9'))).toBeLessThan(lines.indexOf(kill))
    expect(lines.indexOf('[ -e "$d/cancelled" ] && { echo cancelled; exit 0; }')).toBeLessThan(lines.indexOf(kill))
    // only a command the run started is taken as it is, nor cleaned up after
    const adopt = lines.findIndex((line) => line.startsWith('[ "$mode" = adopt ]'))
    expect(adopt).toBeGreaterThan(-1)
    expect(adopt).toBeLessThan(lines.indexOf(kill))
    expect(SCRIPTS.start).toContain('rm -rf "$d" && /.hammerkit/busybox mkdir -p "$d" && echo "$nonce" > "$d/nonce"')
    // a session of its own, nothing of the exec's, not even the lock
    expect(SCRIPTS.start).toContain(`/.hammerkit/busybox setsid /.hammerkit/busybox sh -c '`)
    expect(SCRIPTS.start).toContain(`hammerkit "$d" "$@" </dev/null >/dev/null 2>&1 9>&- &`)
    // the command of the run that still runs ends first, for an hour at most
    expect(SCRIPTS.start).toContain('while [ $w -lt 3600 ] && [ ! -e "$o/exit" ] && alive "$o"; do')
    // of the other files only the directories of runs go
    expect(SCRIPTS.start).toContain(`case "\${o##*/}" in ${'[0-9a-f]'.repeat(24)}) [ "$o" = "$run" ] ||`)
    // a command runs while a process of this pod has its directory among its arguments
    expect(SCRIPTS.status).toContain(`case "$p" in ''|*[!0-9]*) return 1 ;; esac`)
    expect(SCRIPTS.status).toContain('grep -qxF -- "$1"')
    // the output goes to files of a limited size, the exit code once it is all there
    expect(WRAPPER).toContain(
      'cap() { /.hammerkit/busybox head -c 4194304 > "$1"; /.hammerkit/busybox cat > /dev/null; }'
    )
    expect(WRAPPER).toContain('cap "$d/out" < "$f-out" & co=$!')
    const end = WRAPPER.slice(WRAPPER.indexOf('end() {'))
    expect(end.indexOf('kill -0 "$co"')).toBeLessThan(end.indexOf('mv -f "$d/exit.tmp" "$d/exit"'))
    // a cancel kills the group of the command only when it runs in this pod
    expect(SCRIPTS.cancel).toContain(
      'group() { alive "$1" && read -r h p < "$1/pid" && kill -KILL -"$p" 2>/dev/null; }'
    )
    expect(SCRIPTS.cancel).toContain('mkdir -p "$1" && : > "$1/cancelled"')
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
    // A cluster with the pod of the files, where a created runner runs at once. Its runners
    // share one fake directory of the sandbox's files: a command started there is what
    // `answer` says for it, ended at once or running (`hang`) until it is told to end or is
    // killed, which the start of another command does as it cleans up.
    type Command = {
      pod: string
      nonce: string
      out: Buffer
      err: Buffer
      exit?: number
      changed?: boolean
      cancelled?: boolean
      alive: boolean
    }
    type Answer = { out?: string; err?: string; exitCode?: number; hang?: boolean; changed?: boolean }
    function cluster(
      answer: (command: string[]) => Answer,
      options: { cancel?: 'fails'; breakFirstStart?: boolean } = {}
    ) {
      const pods = new Map<string, any>([[files.name, { metadata: { ...files }, status: { phase: 'Running' } }]])
      const calls: string[] = []
      const notFound = () => Promise.reject(Object.assign(new Error('not found'), { code: 404 }))
      // the command directories of the sandbox's files, which every runner mounts
      const commands = new Map<string, Command>()
      // what follows a command, ended once the command did or was killed
      const following = new Set<{ directory: string; end: () => void; send: () => void }>()
      const endFollows = (directory?: string) =>
        [...following].filter((follow) => !directory || follow.directory === directory).forEach((f) => f.end())
      const sockets: EventEmitter[] = []
      let brokeStart = false
      const state = (directory: string, pod: string) => {
        const command = commands.get(directory)
        if (command?.cancelled) {
          return 'cancelled'
        }
        if (command?.exit !== undefined) {
          return `finished ${command.exit}${command.changed ? ' changed' : ''}`
        }
        return command?.alive && command.pod === pod ? 'running' : undefined
      }
      const killAll = (pod: string) => {
        for (const [directory, command] of commands) {
          if (command.pod === pod && command.alive) {
            command.alive = false
            endFollows(directory)
          }
        }
      }
      const instance = {
        coreApi: {
          readNamespacedPod: async ({ name }: any) => pods.get(name) ?? notFound(),
          deleteNamespacedPod: async ({ name }: any) => {
            calls.push(`delete ${name}`)
            pods.delete(name)
            killAll(name)
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
            expect(command.slice(0, 3)).toEqual(['/.hammerkit/busybox', 'sh', '-c'])
            expect(command[4]).toBe('hammerkit')
            const script = command[3]
            const args = command.slice(5)
            const directory = args[0]
            const socket = Object.assign(new EventEmitter(), { close: () => socket.emit('close') })
            sockets.push(socket)
            const code = (exitCode: number) =>
              exitCode === 0
                ? { status: 'Success' }
                : { status: 'Failure', details: { causes: [{ reason: 'ExitCode', message: String(exitCode) }] } }
            const end = (exitCode: number, out?: string) => {
              setImmediate(() => {
                if (out) {
                  stdout?.write(out)
                }
                done(code(exitCode))
                socket.emit('close')
              })
            }
            if (script.includes('echo started')) {
              const [, mode, nonce, , , ...cmd] = args
              calls.push(`start ${pod} ${container} ${mode} ${cmd.join(' ')}`)
              const found = commands.get(directory)
              const adopted = mode === 'adopt' && (nonce === '' || found?.nonce === nonce) && state(directory, pod)
              if (found?.cancelled) {
                end(0, 'cancelled\n')
              } else if (adopted) {
                end(0, `${adopted}\n`)
              } else {
                // what anything else left is killed
                killAll(pod)
                const answered = answer(cmd)
                commands.set(directory, {
                  pod,
                  nonce,
                  out: Buffer.from(answered.out ?? ''),
                  err: Buffer.from(answered.err ?? ''),
                  alive: !!answered.hang,
                  ...(answered.hang ? {} : { exit: answered.exitCode ?? 0, changed: !!answered.changed }),
                })
                if (options.breakFirstStart && !brokeStart) {
                  brokeStart = true
                  setImmediate(() => socket.emit('error', new Error('connection reset')))
                } else {
                  end(0, 'started\n')
                }
              }
            } else if (script.includes('size() {')) {
              calls.push(`follow ${pod} ${args.join(' ')}`)
              const [from, fromErr] = args.slice(1).map(Number)
              let sent = { out: from, err: fromErr }
              const send = () => {
                const found = commands.get(directory)!
                stdout?.write(found.out.subarray(sent.out))
                stderr?.write(found.err.subarray(sent.err))
                sent = { out: found.out.length, err: found.err.length }
              }
              setImmediate(() => {
                const found = commands.get(directory)
                if (!found || (!found.alive && found.exit === undefined && !found.cancelled)) {
                  done(code(3))
                  socket.emit('close')
                  return
                }
                send()
                if (!found.alive) {
                  done(code(0))
                  socket.emit('close')
                  return
                }
                const follow = {
                  directory,
                  send,
                  end: () => {
                    following.delete(follow)
                    // the end of the command kills what follows it
                    done(code(137))
                    socket.emit('close')
                  },
                }
                following.add(follow)
                socket.on('error', () => following.delete(follow))
              })
            } else if (script.endsWith('state "$1" || echo none')) {
              calls.push(`status ${pod}`)
              end(0, `${state(directory, pod) ?? 'none'}\n`)
            } else if (script.includes(': > "$1/cancelled"')) {
              calls.push(`cancel ${pod}`)
              if (options.cancel === 'fails') {
                setImmediate(() => {
                  done({ status: 'Failure', message: 'container not found' })
                  socket.emit('close')
                })
              } else {
                const found = commands.get(directory)
                if (found) {
                  found.cancelled = true
                } else {
                  commands.set(directory, {
                    pod,
                    nonce: '',
                    out: Buffer.alloc(0),
                    err: Buffer.alloc(0),
                    alive: false,
                    cancelled: true,
                  })
                }
                killAll(pod)
                end(0)
              }
            } else if (script.includes('echo yes')) {
              calls.push(`find ${pod}`)
              const running = [...commands.keys()].some(
                (path) => path.startsWith(`${directory}/`) && state(path, pod) === 'running'
              )
              end(0, running ? 'yes\n' : 'no\n')
            } else if (script.includes('group "$o"')) {
              calls.push(`remove ${pod} ${args.join(' ')}`)
              for (const path of [...commands.keys()].filter((path) => path.startsWith(`${directory}/`))) {
                if (commands.get(path)!.pod === pod) {
                  commands.get(path)!.alive = false
                  endFollows(path)
                }
                commands.delete(path)
              }
              if (args[1] === 'clean') {
                killAll(pod)
              }
              end(0)
            } else {
              throw new Error(`not a script of the runner: ${script}`)
            }
            return socket
          },
        },
      }
      // a command that runs says more, or ends
      const command = (directory?: string) => commands.get(directory ?? [...commands.keys()].pop()!)!
      const say = (text: string, stream: 'out' | 'err' = 'out', directory?: string) => {
        const found = command(directory)
        found[stream] = Buffer.concat([found[stream], Buffer.from(text)])
        following.forEach((follow) => follow.send())
      }
      const exit = (exitCode: number, directory?: string, changed = false) => {
        const found = command(directory)
        found.exit = exitCode
        found.changed = changed
        found.alive = false
        endFollows()
      }
      return { instance: instance as any, calls, pods, sockets, commands, say, exit }
    }

    // what a process of a run on a server knows of its commands, and the records the registry
    // keeps of them, the newest of each
    const runProcess = () => {
      const records: Record<string, CommandRecord> = {}
      const commands = createRunnerCommands({
        reached: (command, record) => {
          records[command] = record
        },
      })
      return { commands, records }
    }
    const resumedFrom = (records: Record<string, CommandRecord>) => {
      const after = runProcess()
      return { ...after, commands: createRunnerCommands({ resumed: { ...records }, reached: after.commands.reached }) }
    }
    const idOf = (directory: string) => directory.split('/').pop()!
    // with fake timers: the time `settled` takes goes by, in steps the fake cluster (which
    // answers on real immediates) keeps up with
    const passes = async <T>(settled: Promise<T>): Promise<T> => {
      let done = false
      void settled.finally(() => (done = true))
      for (let step = 0; step < 400 && !done; step++) {
        await vi.advanceTimersByTimeAsync(100)
        await new Promise((resolve) => setImmediate(resolve))
      }
      return settled
    }
    const run = (instance: any, task: any, commands = createRunnerCommands(), abort = new AbortController().signal) =>
      executeInRunner(instance, task, environment(), persistence(), abort, commands)

    it('starts the runner once and execs into it after', async () => {
      const { instance, calls, pods } = cluster(() => ({ out: 'ok\npartial' }))
      const env = environment()
      const task = shell()
      const key = getRunnerKey(task, env, persistence())
      const name = getRunnerName(key)
      const commands = createRunnerCommands()
      const abort = new AbortController().signal
      expect(await executeInRunner(instance, task, env, persistence(), abort, commands)).toEqual({ type: 'done' })
      expect(calls.filter((call) => !call.startsWith('follow') && !call.startsWith('status'))).toEqual([
        `create ${name}`,
        // the policy goes once the runner went too
        `patch hammerkit-network-${key} files-1,uid-${name} application/merge-patch+json`,
        `start ${name} runner fresh sh -c npm test`,
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
      expect(await executeInRunner(instance, task, env, persistence(), abort, commands)).toEqual({ type: 'done' })
      expect(calls.filter((call) => call.startsWith('start') || call.startsWith('create'))).toEqual([
        `start ${name} runner fresh sh -c npm test`,
      ])
      expect(vi.mocked(ensureKubernetesItemNetwork).mock.lastCall![3].owners).toEqual([
        { apiVersion: 'v1', kind: 'Pod', ...files },
        { apiVersion: 'v1', kind: 'Pod', name, uid: `uid-${name}` },
      ])

      // one of something else goes, with its limits
      calls.length = 0
      const other = shell({ image: 'node:22-alpine' })
      const otherName = getRunnerName(getRunnerKey(other, env, persistence()))
      expect(await executeInRunner(instance, other, env, persistence(), abort, commands)).toEqual({ type: 'done' })
      expect(calls.slice(0, 3)).toEqual([
        `delete ${name}`,
        `delete NetworkPolicy hammerkit-network-${key}`,
        `create ${otherName}`,
      ])
      expect(pods.has(name)).toBe(false)
    })

    it('answers the exit code of a command that failed, and runs no command after it', async () => {
      const { instance, calls } = cluster(() => ({ exitCode: 3 }))
      const task = shell({
        cmds: [
          { cmd: 'false', cwd: '/runs/run_1' },
          { cmd: 'echo never', cwd: '/runs/run_1' },
        ],
      })
      expect(await run(instance, task)).toEqual({ type: 'crash', exitCode: 3 })
      expect(calls.filter((call) => call.startsWith('start'))).toHaveLength(1)
      // it ended: nothing to kill
      expect(calls.some((call) => call.startsWith('cancel'))).toBe(false)
    })

    it('starts each command in a directory of its own, the same for the same command of the run', async () => {
      const { instance, commands } = cluster(() => ({}))
      const task = shell({
        cmds: [
          { cmd: 'npm ci', cwd: '/runs/run_1' },
          { cmd: 'npm test', cwd: '/runs/run_1' },
        ],
      })
      const { commands: processCommands, records } = runProcess()
      expect(await run(instance, task, processCommands)).toEqual({ type: 'done' })
      // the task again, in the same run: its commands run again
      expect(await run(instance, task, processCommands)).toEqual({ type: 'done' })
      const runDirectory = getRunCommandsDirectory('run_1')
      expect(runDirectory).toMatch(/^\/\.hammerkit-sandbox\/\.hammerkit\/commands\/[0-9a-f]{24}$/)
      const directories = [
        getCommandDirectory('run_1', 'shell', 0, 0),
        getCommandDirectory('run_1', 'shell', 1, 0),
        getCommandDirectory('run_1', 'shell', 0, 1),
        getCommandDirectory('run_1', 'shell', 1, 1),
      ]
      expect([...commands.keys()]).toEqual(directories)
      expect(directories.every((directory) => directory.startsWith(`${runDirectory}/`))).toBe(true)
      expect(getCommandDirectory('run_2', 'shell', 0, 0)).not.toContain(runDirectory)
      // the registry hears of each, which command of which task it is, and that it ended
      expect(records[idOf(directories[3])]).toEqual({
        task: 'shell',
        step: 1,
        execution: 1,
        stdout: 0,
        stderr: 0,
        done: true,
      })
    })

    it('keeps a command running when its connection breaks, and follows it again from where its log got', async () => {
      const { instance, calls, sockets, say, exit } = cluster(() => ({ hang: true }))
      const reached: [string, CommandRecord][] = []
      const task = shell()
      const running = run(
        instance,
        task,
        createRunnerCommands({ reached: (command, record) => reached.push([command, record]) })
      )
      await vi.waitFor(() => expect(calls.some((call) => call.startsWith('follow'))).toBe(true))
      // the registry knows of the command as soon as it started
      expect(reached[0]).toEqual([
        expect.stringMatching(/^[0-9a-f]{24}$/),
        { task: 'shell', step: 0, execution: 0, stdout: 0, stderr: 0 },
      ])
      say('one\ntw')
      sockets[sockets.length - 1].emit('error', new Error('connection reset'))
      await vi.waitFor(() => expect(calls.filter((call) => call.startsWith('follow'))).toHaveLength(2))
      // still running: nothing killed it, and it is followed from the end of the last whole line
      expect(calls.some((call) => call.startsWith('cancel'))).toBe(false)
      expect(calls.filter((call) => call.startsWith('follow')).pop()).toMatch(/ 4 0$/)
      say('o\nthree\n')
      say('oops\n', 'err')
      exit(0)
      expect(await running).toEqual({ type: 'done' })
      expect(task.lines).toEqual([
        ['stdout', 'one'],
        ['stdout', 'two'],
        ['stdout', 'three'],
        ['stderr', 'oops'],
      ])
      expect(reached.pop()?.[1]).toEqual({ task: 'shell', step: 0, execution: 0, stdout: 14, stderr: 5, done: true })
    })

    it('says once that the output of a command was cut, over a restart too', async () => {
      const { instance, calls, say, exit } = cluster(() => ({ hang: true }))
      const before = runProcess()
      const task = shell()
      const first = run(instance, task, before.commands)
      await vi.waitFor(() => expect(calls.some((call) => call.startsWith('follow'))).toBe(true))
      // the cap of the log reached exactly, then more
      say(`${'a'.repeat(4 * 1024 * 1024 - 1)}\n`)
      await vi.waitFor(() => expect(task.status.write).toHaveBeenCalledWith('warn', expect.stringContaining('was cut')))
      say('more\n')
      const id = idOf(getCommandDirectory('run_1', 'shell', 0, 0))
      await vi.waitFor(() => expect(before.records[id]).toMatchObject({ stdout: 4 * 1024 * 1024 + 5, cut: true }))
      const again = shell()
      const after = resumedFrom(before.records)
      const resumed = run(instance, again, after.commands)
      await vi.waitFor(() => expect(calls.filter((call) => call.startsWith('start'))).toHaveLength(2))
      say('even more\n')
      exit(0)
      expect(await resumed).toEqual({ type: 'done' })
      expect(await first).toEqual({ type: 'done' })
      const cut = (status: any) =>
        status.write.mock.calls.filter(([level, text]: string[]) => level === 'warn' && text.includes('was cut'))
      expect(cut(task.status)).toHaveLength(1)
      expect(cut(again.status)).toHaveLength(0)
      expect(task.lines.some(([, line]: string[]) => line === 'more')).toBe(false)
    })

    it('says the lines of a command to the run before the offsets that count them, through the real status', async () => {
      const { instance, calls, say, exit } = cluster(() => ({ hang: true }))
      // the process of a run: the status console, its relay and the commands' reports on one way
      const status = statusConsole(new Writable({ write: (_c, _e, done) => done() }))
      const events: RunEventData[] = []
      const emit = (event: RunEventData) => events.push(event)
      const listener = relayStatus(status, emit)
      const commands = getRunnerCommands({}, emit)
      const task = shell()
      task.status = status.context({ name: 'shell' } as any)
      const running = run(instance, task, commands)
      await vi.waitFor(() => expect(calls.some((call) => call.startsWith('follow'))).toBe(true))
      say('one\ntwo\n')
      say('three\n', 'err')
      say('four\n')
      exit(0)
      expect(await running).toEqual({ type: 'done' })
      listener.close()
      const said = { stdout: 0, stderr: 0 }
      let outputs = 0
      for (const event of events) {
        if (event.type === 'log') {
          said[event.stream] += event.text.length + 1
        } else if (event.type === 'output') {
          outputs++
          // never ahead of the lines it counts
          expect(event.stdout).toBeLessThanOrEqual(said.stdout)
          expect(event.stderr).toBeLessThanOrEqual(said.stderr)
        }
      }
      expect(said).toEqual({ stdout: 13, stderr: 6 })
      expect(outputs).toBeGreaterThan(2)
      expect(events[events.length - 1]).toMatchObject({ type: 'output', stdout: 13, stderr: 6, done: true })
    })

    it('fails the task and kills the command when it can not be followed again', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      try {
        const { instance, calls, sockets } = cluster(() => ({ hang: true }))
        const exec = instance.exec.exec
        let refusing = false
        instance.exec.exec = async (...args: any[]) => {
          if (refusing && args[3][3].includes('size() {')) {
            calls.push('follow refused')
            throw new Error('connection refused')
          }
          return exec(...args)
        }
        const settled = run(instance, shell()).then(
          () => undefined,
          (e: Error) => e
        )
        await vi.waitFor(() => expect(calls.some((call) => call.startsWith('follow'))).toBe(true))
        // the follow breaks, and the next ones are refused
        refusing = true
        sockets[sockets.length - 1].emit('error', new Error('connection reset'))
        expect((await passes(settled))?.message).toContain('could not be followed: connection refused')
        // tried again a few times, not for ever
        expect(calls.filter((call) => call === 'follow refused').length).toBe(5)
        // what can not be followed is not left running
        expect(calls).toContain(`cancel ${getRunnerName(getRunnerKey(shell(), environment(), persistence()))}`)
      } finally {
        vi.useRealTimers()
      }
    })

    it('follows a command of a run that resumed where it runs, from where the log of the run got', async () => {
      const { instance, calls, say, exit } = cluster(() => ({ hang: true }))
      const env = environment()
      const task = shell()
      const name = getRunnerName(getRunnerKey(task, env, persistence()))
      // the process before the restart started it, and its log got the first line
      const before = runProcess()
      const first = run(instance, task, before.commands)
      await vi.waitFor(() => expect(calls.some((call) => call.startsWith('follow'))).toBe(true))
      say('one\ntwo\n')
      const directory = getCommandDirectory('run_1', 'shell', 0, 0)
      const id = idOf(directory)
      expect(before.records[id]).toMatchObject({ stdout: 8 })

      // the process after it, whose log kept the first line only: the same command, which is
      // not started again
      calls.length = 0
      const after = resumedFrom({ [id]: { ...before.records[id], stdout: 4 } })
      const again = shell()
      const resumed = run(instance, again, after.commands)
      await vi.waitFor(() => expect(calls).toContain(`follow ${name} ${directory} 4 0`))
      expect(calls.filter((call) => call.startsWith('start'))).toEqual([`start ${name} runner adopt sh -c npm test`])
      say('three\n')
      exit(0)
      expect(await resumed).toEqual({ type: 'done' })
      expect(await first).toEqual({ type: 'done' })
      expect(again.lines).toEqual([
        ['stdout', 'two'],
        ['stdout', 'three'],
      ])
      expect(after.records[id]).toMatchObject({ stdout: 14, stderr: 0, done: true })
    })

    it('reads how a command of a run that resumed ended, and does not run it again', async () => {
      const answer = vi.fn(() => ({ out: 'built\ntested\n', err: 'warned\n', exitCode: 3 }))
      const { instance, calls } = cluster(answer)
      const before = runProcess()
      expect(await run(instance, shell(), before.commands)).toEqual({ type: 'crash', exitCode: 3 })
      expect(answer).toHaveBeenCalledTimes(1)

      calls.length = 0
      const id = idOf(getCommandDirectory('run_1', 'shell', 0, 0))
      const task = shell()
      // the log of the run kept its first line only
      const after = resumedFrom({ [id]: { ...before.records[id], stdout: 6, stderr: 0 } })
      expect(await run(instance, task, after.commands)).toEqual({ type: 'crash', exitCode: 3 })
      expect(answer).toHaveBeenCalledTimes(1)
      expect(task.lines).toEqual([
        ['stdout', 'tested'],
        ['stderr', 'warned'],
      ])
      expect(calls.some((call) => call.startsWith('cancel'))).toBe(false)
    })

    it('takes up the execution of a task the run was at, not one before it', async () => {
      let answers = 0
      const answer = vi.fn(() => (++answers === 1 ? { out: 'first\n', exitCode: 0 } : { hang: true }))
      const { instance, calls, say, exit } = cluster(answer)
      const before = runProcess()
      // the task ran once, and is running a second time when the server stops
      expect(await run(instance, shell(), before.commands)).toEqual({ type: 'done' })
      const second = run(instance, shell(), before.commands)
      await vi.waitFor(() => expect(calls.filter((call) => call.startsWith('follow'))).toHaveLength(2))
      say('second\n')
      expect(Object.values(before.records).map(({ execution, done }) => [execution, !!done])).toEqual([
        [0, true],
        [1, false],
      ])

      const after = resumedFrom(before.records)
      const task = shell()
      const resumed = run(instance, task, after.commands)
      await vi.waitFor(() =>
        expect(calls).toContainEqual(
          expect.stringMatching(new RegExp(`${getCommandDirectory('run_1', 'shell', 0, 1)} 7 0$`))
        )
      )
      exit(0)
      expect(await resumed).toEqual({ type: 'done' })
      expect(await second).toEqual({ type: 'done' })
      expect(answer).toHaveBeenCalledTimes(2)
      // from where the log got in the second's output, which holds it all
      expect(task.lines).toEqual([])
      // the next run of the task in the run is a third
      expect(after.commands.executions.get('shell')).toBe(2)
    })

    it('runs a command anew whose directory a command before filled, and adopts no state it did not start', async () => {
      const answer = vi.fn(() => ({ exitCode: 4 }))
      const { instance, commands } = cluster(answer)
      const name = getRunnerName(getRunnerKey(shell(), environment(), persistence()))
      // a command before wrote what would pass for the end of the next commands
      for (const execution of [0, 1]) {
        commands.set(getCommandDirectory('run_1', 'shell', 0, execution), {
          pod: name,
          nonce: '',
          out: Buffer.from('forged\n'),
          err: Buffer.alloc(0),
          exit: 0,
          alive: false,
        })
      }
      const task = shell()
      expect(await run(instance, task)).toEqual({ type: 'crash', exitCode: 4 })
      expect(answer).toHaveBeenCalledTimes(1)
      expect(task.lines).toEqual([])
      // a run that resumed takes up only what it started
      const after = resumedFrom({})
      expect(await run(instance, shell(), after.commands)).toEqual({ type: 'crash', exitCode: 4 })
      expect(answer).toHaveBeenCalledTimes(2)
    })

    it('takes the command it started when the connection of its start broke', async () => {
      const answer = vi.fn(() => ({ hang: true }))
      const { instance, calls, exit } = cluster(answer, { breakFirstStart: true })
      const { commands, records } = runProcess()
      const running = run(instance, shell(), commands)
      await vi.waitFor(() => expect(calls.some((call) => call.startsWith('follow'))).toBe(true))
      expect(calls.filter((call) => call.startsWith('start')).map((call) => call.split(' ')[3])).toEqual([
        'fresh',
        'adopt',
      ])
      // the registry hears of it all the same, so a restart takes it up
      expect(records[idOf(getCommandDirectory('run_1', 'shell', 0, 0))]).toEqual({
        task: 'shell',
        step: 0,
        execution: 0,
        stdout: 0,
        stderr: 0,
      })
      exit(0)
      expect(await running).toEqual({ type: 'done' })
      expect(answer).toHaveBeenCalledTimes(1)
    })

    it('follows a command of a run that resumed in the runner it runs in, of an older server say', async () => {
      const { instance, calls, pods, say, exit } = cluster(() => ({ hang: true }))
      const env = environment()
      const old = shell({ image: 'node:20-alpine' })
      const oldName = getRunnerName(getRunnerKey(old, env, persistence()))
      const before = runProcess()
      const first = run(instance, old, before.commands)
      await vi.waitFor(() => expect(calls.some((call) => call.startsWith('follow'))).toBe(true))
      say('one\n')

      // the new server keys its runners otherwise
      calls.length = 0
      const task = shell()
      expect(getRunnerName(getRunnerKey(task, env, persistence()))).not.toBe(oldName)
      const after = resumedFrom(before.records)
      const resumed = run(instance, task, after.commands)
      await vi.waitFor(() =>
        expect(calls).toContainEqual(expect.stringMatching(new RegExp(`^follow ${oldName} .* 4 0$`)))
      )
      exit(0)
      expect(await resumed).toEqual({ type: 'done' })
      expect(await first).toEqual({ type: 'done' })
      // the process before follows it too, until it ended
      expect(calls.filter((call) => !call.startsWith('status') && !call.startsWith('follow'))).toEqual([
        `find ${oldName}`,
        `start ${oldName} runner adopt sh -c npm test`,
      ])
      expect(pods.has(oldName)).toBe(true)
    })

    it('fails the task rather than replace a runner it can not ask for the commands of the run', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      try {
        const { instance, calls } = cluster(() => ({}))
        expect(await run(instance, shell())).toEqual({ type: 'done' })
        const exec = instance.exec.exec
        instance.exec.exec = async (...args: any[]) =>
          args[3][3].includes('echo yes') ? Promise.reject(new Error('connection refused')) : exec(...args)
        calls.length = 0
        const task = shell({ image: 'node:20-alpine' })
        const settled = run(instance, task, resumedFrom({}).commands).then(
          () => undefined,
          (e: Error) => e
        )
        expect((await passes(settled))?.message).toContain(
          'could not be asked for the commands of the run: connection refused'
        )
        expect(calls).toEqual([])
      } finally {
        vi.useRealTimers()
      }
    })

    it('kills what a cancelled command runs, and marks it cancelled', async () => {
      const { instance, calls, commands } = cluster(() => ({ hang: true }))
      const abort = new AbortController()
      const running = run(instance, shell(), createRunnerCommands(), abort.signal)
      await vi.waitFor(() => expect(calls.some((call) => call.startsWith('follow'))).toBe(true))
      abort.abort()
      expect(await running).toEqual({ type: 'canceled' })
      expect(calls.map((call) => call.split(' ')[0])).toEqual(['create', 'patch', 'start', 'follow', 'cancel'])
      expect(commands.get(getCommandDirectory('run_1', 'shell', 0, 0))).toMatchObject({ cancelled: true, alive: false })
    })

    it('starts nothing for a task stopped before its command', async () => {
      const { instance, calls } = cluster(() => ({}))
      const abort = new AbortController()
      abort.abort()
      expect(await run(instance, shell(), createRunnerCommands(), abort.signal)).toEqual({ type: 'canceled' })
      expect(calls.some((call) => call.startsWith('start') || call.startsWith('cancel'))).toBe(false)
    })

    it('does not start a command a cancel came before', async () => {
      const answer = vi.fn(() => ({}))
      const { instance, commands } = cluster(answer)
      const name = getRunnerName(getRunnerKey(shell(), environment(), persistence()))
      commands.set(getCommandDirectory('run_1', 'shell', 0, 0), {
        pod: name,
        nonce: '',
        out: Buffer.alloc(0),
        err: Buffer.alloc(0),
        cancelled: true,
        alive: false,
      })
      await expect(run(instance, shell())).rejects.toThrow('the command was cancelled in the runner of the sandbox')
      expect(answer).not.toHaveBeenCalled()
    })

    it('deletes the runner when what a cancelled command runs could not be killed', async () => {
      const { instance, calls, pods } = cluster(() => ({ hang: true }), { cancel: 'fails' })
      const env = environment()
      const name = getRunnerName(getRunnerKey(shell(), env, persistence()))
      const abort = new AbortController()
      const running = run(instance, shell(), createRunnerCommands(), abort.signal)
      await vi.waitFor(() => expect(calls.some((call) => call.startsWith('follow'))).toBe(true))
      abort.abort()
      expect(await running).toEqual({ type: 'canceled' })
      expect(calls).toContain(`delete ${name}`)
      expect(pods.has(name)).toBe(false)
    })

    it('fails the task when the runner of a command went with it', async () => {
      const { instance, calls, pods } = cluster(() => ({ hang: true }))
      const name = getRunnerName(getRunnerKey(shell(), environment(), persistence()))
      const running = run(instance, shell())
      await vi.waitFor(() => expect(calls.some((call) => call.startsWith('follow'))).toBe(true))
      await instance.coreApi.deleteNamespacedPod({ name, namespace: 'caller' })
      pods.set(name, { metadata: { name }, status: { phase: 'Running' } })
      await expect(running).rejects.toThrow('ended without an exit code: its runner went')
      // and whatever is left of it is stopped
      expect(calls).toContain(`cancel ${name}`)
    })

    it('kills what the commands of a run run in the runners of the sandbox, and removes them', async () => {
      const { instance, calls, commands } = cluster(() => ({ hang: true }))
      const name = getRunnerName(getRunnerKey(shell(), environment(), persistence()))
      const running = run(instance, shell()).catch((e: Error) => e)
      await vi.waitFor(() => expect(calls.some((call) => call.startsWith('follow'))).toBe(true))
      expect(commands.size).toBe(1)
      calls.length = 0
      await removeRunCommands(instance, 'caller', 'abc', 'run_1', { clean: false })
      expect(calls.filter((call) => call.startsWith('remove'))).toEqual([
        `remove ${name} ${getRunCommandsDirectory('run_1')} `,
      ])
      expect(commands.size).toBe(0)
      expect(((await running) as Error).message).toContain('its runner went')
      // a run that ended cleans up after them too
      await removeRunCommands(instance, 'caller', 'abc', 'run_1', { clean: true })
      expect(calls).toContain(`remove ${name} ${getRunCommandsDirectory('run_1')} clean`)
    })

    it('leaves a task to its Jobs when the runner is taken or the pod of the files went', async () => {
      const { instance, pods, exit } = cluster((command) => (command.includes('slow') ? { hang: true } : {}))
      const commands = createRunnerCommands()
      // another task of the run is in it
      const busy = run(instance, shell({ cmds: [{ cmd: 'slow', cwd: '/runs/run_1' }] }), commands)
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(await run(instance, shell(), commands)).toEqual({ type: 'unavailable' })
      exit(0)
      expect(await busy).toEqual({ type: 'done' })
      // the pod of the files made way for a pod of the run
      pods.delete(files.name)
      expect(await run(instance, shell(), commands)).toEqual({ type: 'unavailable' })
    })

    it('leaves a task to its Jobs when the runner does not start', async () => {
      const { instance, calls, pods } = cluster(() => ({}))
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
      expect(await run(instance, task)).toEqual({ type: 'unavailable' })
      expect(calls.some((call) => call.startsWith('start'))).toBe(false)
      expect(pods.size).toBe(1)
      // and is not tried again while the pod of the files stays
      const tried = calls.filter((call) => call.startsWith('create')).length
      expect(await run(instance, task)).toEqual({ type: 'unavailable' })
      expect(calls.filter((call) => call.startsWith('create'))).toHaveLength(tried)
    })

    it('removes a runner a command before changed, and fails the task rather than running it again', async () => {
      // what the wrapper marks when a mount is not what it was made as
      const { instance, calls, pods } = cluster(() => ({ exitCode: 125, changed: true }))
      const task = shell({ image: 'node:16-alpine' })
      const name = getRunnerName(getRunnerKey(task, environment(), persistence()))
      // a command can say what the wrapper says too, after it ran: no second run as a Job
      await expect(run(instance, task)).rejects.toThrow(
        'a command changed the runner of the sandbox, it was removed: run the task again'
      )
      expect(calls).toContain(`delete ${name}`)
      expect(pods.has(name)).toBe(false)
    })

    it('tells a changed runner of a command the run resumed', async () => {
      const { instance, calls, pods, exit } = cluster(() => ({ hang: true }))
      const task = shell({ image: 'node:16-alpine' })
      const name = getRunnerName(getRunnerKey(task, environment(), persistence()))
      const before = runProcess()
      const first = run(instance, task, before.commands).catch((e: Error) => e)
      await vi.waitFor(() => expect(calls.some((call) => call.startsWith('follow'))).toBe(true))
      // the server stops; the wrapper finds the runner changed
      exit(125, undefined, true)
      await first
      await expect(
        run(instance, shell({ image: 'node:16-alpine' }), resumedFrom(before.records).commands)
      ).rejects.toThrow('a command changed the runner of the sandbox')
      expect(pods.has(name)).toBe(false)
    })

    it('answers an exit code 125 of the command itself as its own', async () => {
      const { instance } = cluster(() => ({ err: 'not a runner that changed\n', exitCode: 125 }))
      expect(await run(instance, shell({ image: 'node:16-alpine' }))).toEqual({ type: 'crash', exitCode: 125 })
    })

    it('leaves the runner starting when its command stops meanwhile, for the next command', async () => {
      const { instance, calls, pods } = cluster(() => ({}))
      const create = instance.objectApi.create
      instance.objectApi.create = async (spec: any) => {
        const made = await create(spec)
        pods.get(spec.metadata.name).status = { phase: 'Pending' }
        return made
      }
      const task = shell({ image: 'node:18-alpine' })
      const name = getRunnerName(getRunnerKey(task, environment(), persistence()))
      const abort = new AbortController()
      const first = run(instance, task, createRunnerCommands(), abort.signal)
      await vi.waitFor(() => expect(calls).toContain(`create ${name}`))
      // a short timeout of the agent
      abort.abort()
      expect(await first).toEqual({ type: 'unavailable' })
      expect(calls).not.toContain(`delete ${name}`)
      // it runs by the next command, which takes it
      pods.get(name).status = { phase: 'Running', containerStatuses: [{ name: 'runner', state: { running: {} } }] }
      expect(await run(instance, task)).toEqual({ type: 'done' })
      expect(calls.filter((call) => call === `create ${name}`)).toHaveLength(1)
      expect(calls).toContainEqual(expect.stringContaining(`start ${name}`))
    })

    it('leaves a task to its Jobs at once when an image of the runner can not be pulled', async () => {
      const { instance, calls, pods } = cluster(() => ({}))
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
      expect(await run(instance, task)).toEqual({ type: 'unavailable' })
      expect(task.status.write).toHaveBeenCalledWith('debug', expect.stringContaining('ImagePullBackOff of busybox'))
      expect(pods.size).toBe(1)
    })

    it('leaves a task to its Jobs when the cluster refuses the runner, and tries again next time', async () => {
      const { instance, calls } = cluster(() => ({}))
      const create = instance.objectApi.create
      instance.objectApi.create = async () => {
        throw Object.assign(new Error('pods "x" is forbidden: exceeded quota'), { code: 403 })
      }
      const task = shell({ image: 'node:22-alpine' })
      expect(await run(instance, task)).toEqual({ type: 'unavailable' })
      expect(task.status.write).toHaveBeenCalledWith('debug', expect.stringContaining('exceeded quota'))
      instance.objectApi.create = create
      expect(await run(instance, task)).toEqual({ type: 'done' })
      expect(calls.some((call) => call.startsWith('start'))).toBe(true)
    })
  })

  it('cleans up after the commands of a run only the scratch directories of each runner', async () => {
    const scripts: Record<string, string> = {}
    const runner = (name: string, mounts: { name: string; mountPath: string }[]) => ({
      metadata: { name, labels: { 'hammerkit.dev/runner': name } },
      spec: { containers: [{ name: 'runner', volumeMounts: mounts }] },
      status: { phase: 'Running', containerStatuses: [{ name: 'runner', state: { running: {} } }] },
    })
    const instance = {
      coreApi: {
        listNamespacedPod: async () => ({
          items: [
            runner('hammerkit-runner-a', [
              { name: 'hammerkit-sandbox', mountPath: '/.hammerkit-sandbox' },
              { name: 'hammerkit-runner-tmp', mountPath: '/tmp' },
              { name: 'hammerkit-runner-tools', mountPath: '/.hammerkit' },
            ]),
            // one with a mount of its own below /tmp, which the clean up leaves
            runner('hammerkit-runner-b', [
              { name: 'hammerkit-sandbox', mountPath: '/tmp/data' },
              { name: 'hammerkit-runner-tmp', mountPath: '/tmp' },
            ]),
          ],
        }),
      },
      exec: {
        exec: async (_ns: string, pod: string, _c: string, command: string[], ...rest: any[]) => {
          scripts[pod] = command[3]
          const socket = Object.assign(new EventEmitter(), { close: () => undefined })
          setImmediate(() => {
            rest[rest.length - 1]({ status: 'Success' })
            socket.emit('close')
          })
          return socket
        },
      },
    }
    await removeRunCommands(instance as any, 'caller', 'abc', 'run_1', { clean: true })
    expect(scripts['hammerkit-runner-a']).toContain('rm -rf /tmp/* /tmp/.[!.]* /tmp/..?* /dev/shm/*')
    expect(scripts['hammerkit-runner-b']).toContain('rm -rf /dev/shm/*')
    expect(scripts['hammerkit-runner-b']).not.toContain('/tmp/*')
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
