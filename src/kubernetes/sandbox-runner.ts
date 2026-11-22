import { createHash, randomBytes } from 'crypto'
import { posix, relative, sep } from 'path'
import { Writable } from 'stream'
import { V1EnvVar, V1OwnerReference, V1Pod, V1Status, V1VolumeMount } from '@kubernetes/client-node'
import { WorkKubernetesEnvironment, WorkKubernetesWorkspace } from '../planner/work-environment'
import { WorkItem } from '../planner/work-item'
import { ContainerWorkTask } from '../planner/work-task'
import { getEffectiveNetwork } from '../planner/work-network'
import { getEnvironmentVariables } from '../environment/replace-env-variables'
import { getErrorMessage } from '../log'
import { sleep } from '../utils/sleep'
import { getVersion } from '../version'
import { KubernetesObjectHeader, statusCodeOf } from './apply'
import { getKubernetesResources } from './container-resources'
import { getContainerSecurity, getPodPlacement } from './job-placement'
import { KubernetesInstance } from './kubernetes-instance'
import {
  ensureKubernetesItemNetwork,
  getNetworkLabels,
  getNetworkPolicyName,
  KubernetesItemNetwork,
  removeSandboxProxies,
} from './network-policy'
import { ID_LABEL } from './resources'
import { HELPER_TOOLS_IMAGE } from './transfer-tools'
import { getSandboxAffinity, KubernetesPersistence, SANDBOX_LABEL } from './volumes'
import {
  CommandOutputs,
  CommandRecord,
  createRunnerCommands,
  RUNNER_COMMANDS_DIRECTORY,
  RunnerCommands,
} from '../executer/runner-commands'

/**
 * The runner of a sandbox: one pod that the commands of a run on the sandbox are exec'd
 * into, one after the other, in place of a Job each. A Job's pod takes seconds to be
 * scheduled and to start; an exec into a running pod a fraction of one.
 *
 * - Only a task shaped like an agent's shell gets it: a container task that mounts the
 *   whole sandbox (`mounts: [.]`) and nothing else (no claims of its own or of its
 *   dependencies, so no `generates`), with no `needs` and no secrets. Any other task runs
 *   as a Job.
 * - The pod is the task's container as its Job would have it: its image, variables,
 *   resources, the sandbox's claim, the security context, the nodes of the pool and the
 *   node of the pod of the sandbox's files. It is named after all of that (getRunnerKey),
 *   so a change starts a new one and the one before goes. Its first process only waits.
 * - Every command runs in a wrapper that first and last kills every other process of the
 *   container and empties /tmp and /dev/shm (unless a mount of the task is in one): the
 *   container is reused, what a command started is not. A command cancelled or out of time
 *   is killed the same way, or the pod is deleted. The first process and the wrapper run a
 *   static busybox from a read-only mount, so a command can not replace what cleans up
 *   after it.
 * - The wrapper runs detached from the exec that starts it, and writes the command's output
 *   and exit code to files of the sandbox (getCommandDirectory), which the process of the
 *   run follows: a connection that breaks, or a restart of the server, leaves the command
 *   running. A run that resumes takes it up again from where its log got (RunnerCommands),
 *   or reads how it ended, rather than running it again.
 * - Under a limited network it has a NetworkPolicy of its own and, under `allow`, the
 *   sandbox's egress proxy, both keyed like the pod. They carry no run, and go with the
 *   pod of the sandbox's files, which owns them and the runner: the runner stays while
 *   the sandbox has that pod, `backend.sandboxes.idle` after its last run or request.
 */

export const RUNNER_LABEL = 'hammerkit.dev/runner'
const RUNNER_CONTAINER = 'runner'
const TMP_VOLUME = 'hammerkit-runner-tmp'
const TOOLS_VOLUME = 'hammerkit-runner-tools'
const TOOLS_PATH = '/.hammerkit'
const BUSYBOX = `${TOOLS_PATH}/busybox`
// copied into the runner by an init container
export const RUNNER_TOOLS_IMAGE = HELPER_TOOLS_IMAGE
const RUNNER_START_MS = 5 * 60 * 1000
const RUNNER_POLL_MS = 250
const PULL_FAILURES = ['ErrImagePull', 'ImagePullBackOff', 'InvalidImageName']
const KILL_TIMEOUT_MS = 10000
// a command's output is kept to this, as the log of a Job
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024

// Waits without a process of its own to signal: a command's `kill -KILL -1` ends the
// sleep, not the loop (the first process of the container is spared), which reaps what
// the commands left
export const IDLE_COMMAND = [BUSYBOX, 'sh', '-c', `trap "exit 0" TERM; while :; do ${BUSYBOX} sleep 3600 & wait; done`]

const SCRATCH_DIRECTORIES = ['/tmp', '/dev/shm']
// Where the runner mounts the sandbox's files. A run has them in a directory of its own (the
// server's directory of the run), which every command links here first: the pod and its key
// stay the same from one run to the next.
export const RUNNER_SANDBOX_PATH = '/.hammerkit-sandbox'

// The mounts of the task, from the directory of the run to the runner's
export function getRunnerMounts(
  workspace: Pick<WorkKubernetesWorkspace, 'root'>,
  persistence: Pick<KubernetesPersistence, 'mounts'>
): V1VolumeMount[] {
  return persistence.mounts.map(({ mount }) => ({ ...mount, mountPath: toRunnerPath(workspace, mount.mountPath) }))
}

function toRunnerPath(workspace: Pick<WorkKubernetesWorkspace, 'root'>, path: string): string {
  const rel = relative(workspace.root, path)
  return rel === '' ? RUNNER_SANDBOX_PATH : posix.join(RUNNER_SANDBOX_PATH, ...rel.split(sep))
}

// The scratch directories the runner empties: not one that holds a mount of the task, or is
// in one, such as the sandbox's files when the server keeps its runs below /tmp
export function getScratchDirectories(mounts: Pick<V1VolumeMount, 'mountPath'>[]): string[] {
  const within = (path: string, directory: string) => path === directory || path.startsWith(`${directory}/`)
  return SCRATCH_DIRECTORIES.filter((directory) =>
    mounts.every((mount) => !within(mount.mountPath, directory) && !within(directory, mount.mountPath))
  )
}

// Kills every process of the container but the first and the shell itself (`kill` is the
// shell's own), again while one forked meanwhile, then empties the scratch directories
export function getCleanUp(directories: string[], busybox: string = BUSYBOX): string {
  const patterns = directories.flatMap((directory) => [`${directory}/*`, `${directory}/.[!.]*`, `${directory}/..?*`])
  return [
    'i=0',
    'while kill -KILL -1 2>/dev/null && [ $i -lt 10 ]; do i=$((i+1)); done',
    ...(patterns.length > 0 ? [`${busybox} rm -rf ${patterns.join(' ')} 2>/dev/null`] : []),
  ].join('\n')
}

// The exit code of a command that did not run as a command before changed the runner: the
// wrapper marks it so in the command's directory (`changed`), the runner goes and the task fails
export const RUNNER_CHANGED_EXIT = 125

// Where the commands of runs keep their output and exit code: in the sandbox's files, which
// only its owner's runs and requests reach (RUNNER_COMMANDS_DIRECTORY). A directory per run,
// and in it one per command, both named by a hash (COMMAND_ID_PATTERN).
export const RUNNER_COMMANDS_PATH = `${RUNNER_SANDBOX_PATH}/${RUNNER_COMMANDS_DIRECTORY}`

const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 24)

// The directory of a command of a run: the same for the same command of the run in every
// process of it, so one that resumes after a restart finds what the one before started.
// `execution`: how often the task ran in the run before, in the runner.
export function getCommandDirectory(run: string, task: string, step: number, execution: number): string {
  return posix.join(getRunCommandsDirectory(run), hash(JSON.stringify([run, task, step, execution])))
}

export function getRunCommandsDirectory(run: string): string {
  return posix.join(RUNNER_COMMANDS_PATH, hash(run))
}

// What the scripts of the runner run with: its busybox and where it has the sandbox's files
export interface RunnerTools {
  busybox: string
  sandbox: string
}

const RUNNER_TOOLS: RunnerTools = { busybox: BUSYBOX, sandbox: RUNNER_SANDBOX_PATH }

export interface RunnerScripts {
  start: string
  status: string
  follow: string
  cancel: string
  find: string
  remove: string
}

// How long a command waits for one of its run that still runs before it starts (s)
const RUN_COMMAND_WAIT = 3600

/**
 * The scripts that start a command in the runner and follow, stop, find and remove the
 * commands of a run, each run as `sh -c <script> hammerkit <args>`. `cleanUp` is what kills
 * what a command left (getCleanUp), `mountPaths` the mounts the wrapper checks.
 */
export function getRunnerScripts(
  cleanUp: string,
  mountPaths: string[],
  tools: RunnerTools = RUNNER_TOOLS
): RunnerScripts {
  const b = tools.busybox
  // How a script finds a command in the directory `$1`: `cancelled`, `finished <code>` (and
  // ` changed` when a command before changed the runner), or `running` while its wrapper runs
  // in this pod, which the wrapper's arguments name; else (not started, or its pod went with
  // it) it fails. The pid is not taken alone: one of another process, a zombie, or one a
  // command wrote there does not count.
  const state = [
    `host=$(${b} hostname)`,
    [
      'alive() {',
      '[ -e "$1/pid" ] && read -r h p < "$1/pid" && [ "$h" = "$host" ] || return 1',
      `case "$p" in ''|*[!0-9]*) return 1 ;; esac`,
      `[ -r "/proc/$p/cmdline" ] && ${b} tr '\\0' '\\n' < "/proc/$p/cmdline" | ${b} grep -qxF -- "$1"`,
      '}',
    ].join('\n'),
    [
      'state() {',
      'if [ -e "$1/cancelled" ]; then echo cancelled',
      `elif [ -e "$1/exit" ]; then echo "finished $(${b} cat "$1/exit")$([ -e "$1/changed" ] && echo ' changed')"`,
      'elif alive "$1"; then echo running',
      'else return 1; fi',
      '}',
    ].join('\n'),
    // the process group of the command of the directory `$1`, when it runs in this pod
    'group() { alive "$1" && read -r h p < "$1/pid" && kill -KILL -"$p" 2>/dev/null; }',
  ].join('\n')
  const id = '[0-9a-f]'.repeat(24)
  const wrapper = getWrapper(cleanUp, mountPaths, tools)
  return {
    // Starts the wrapper for the command directory `$1` and says `started`. `$2` `fresh`: a
    // command the run has not started, whatever its directory holds goes first. `adopt`: one
    // the run started, which is not started again: it says what it is (`state`). With a nonce
    // `$3`, only the start that wrote that nonce is taken (a start again after its connection
    // broke). A command of the same run that still runs (a task before it that runs again as
    // the run resumed) ends first, for an hour at most; what anything else left is killed, and
    // the files of other runs go. The wrapper is a session of its own, its output goes to
    // files: the exec ends at once. One start of a command at a time, a cancel wins over it.
    start: [
      state,
      'd=$1; mode=$2; nonce=$3; shift 3',
      `run=$(${b} dirname "$d")`,
      `${b} mkdir -p "$run" && exec 9> "$d.lock" && ${b} flock 9 || exit 126`,
      '[ -e "$d/cancelled" ] && { echo cancelled; exit 0; }',
      `[ "$mode" = adopt ] && { [ -z "$nonce" ] || [ "$(${b} cat "$d/nonce" 2>/dev/null)" = "$nonce" ]; } && state "$d" && exit 0`,
      'w=0',
      `for o in "$run"/*; do [ "$o" != "$d" ] && [ -d "$o" ] || continue; while [ $w -lt ${RUN_COMMAND_WAIT} ] && [ ! -e "$o/exit" ] && alive "$o"; do ${b} sleep 1; w=$((w+1)); done; done`,
      cleanUp,
      `for o in "$(${b} dirname "$run")"/*; do case "\${o##*/}" in ${id}) [ "$o" = "$run" ] || ${b} rm -rf "$o" ;; esac; done`,
      `${b} rm -rf "$d" && ${b} mkdir -p "$d" && echo "$nonce" > "$d/nonce" || exit 126`,
      `${b} setsid ${b} sh -c ${shellQuote(wrapper)} hammerkit "$d" "$@" </dev/null >/dev/null 2>&1 9>&- &`,
      'echo "$host $!" > "$d/pid"',
      'echo started',
    ].join('\n'),
    // Says how the command of the directory `$1` is (`state`), `none` when it is not
    status: [state, 'state "$1" || echo none'].join('\n'),
    // Prints the output of the command of the directory `$1` from the byte `$2` of its stdout
    // and `$3` of its stderr on, as it comes, and exits 0 once it printed all of it. 3: the
    // command ended without an exit code, its pod went with it.
    follow: [
      state,
      'd=$1; o=$2; e=$3',
      `size() { ${b} stat -c %s "$1" 2>/dev/null || echo 0; }`,
      'while :; do',
      '  [ -e "$d/exit" ] || [ -e "$d/cancelled" ] && end=1 || end=0',
      `  n=$(size "$d/out"); [ "$n" -gt "$o" ] && ${b} tail -c +$((o+1)) "$d/out" | ${b} head -c $((n-o)) && o=$n`,
      `  n=$(size "$d/err"); [ "$n" -gt "$e" ] && ${b} tail -c +$((e+1)) "$d/err" | ${b} head -c $((n-e)) >&2 && e=$n`,
      '  [ $end = 1 ] && exit 0',
      '  alive "$d" || [ -e "$d/exit" ] || [ -e "$d/cancelled" ] || exit 3',
      `  ${b} sleep 0.2`,
      'done',
    ].join('\n'),
    // Stops the command of the directory `$1` for good: it is marked cancelled first, so it is
    // not taken for one whose pod went and a start that comes after does not start it, then its
    // process group and everything else is killed (a start under way too)
    cancel: [state, `${b} mkdir -p "$1" && : > "$1/cancelled"`, 'group "$1"', cleanUp, 'exit 0'].join('\n'),
    // Says `yes` when a command of the run's directory `$1` runs in this pod
    find: [
      state,
      'for o in "$1"/*; do [ -d "$o" ] && [ ! -e "$o/exit" ] && [ ! -e "$o/cancelled" ] && alive "$o" && { echo yes; exit 0; }; done',
      'echo no',
    ].join('\n'),
    // Kills the commands of the run's directory `$1` that run in this pod and removes it; with
    // `$2` `clean`, what they left is cleaned up too (the run holds the sandbox still)
    remove: [
      state,
      'for o in "$1"/*; do [ -d "$o" ] && group "$o"; done',
      'if [ "$2" = clean ]; then',
      cleanUp,
      'fi',
      `${b} rm -rf "$1"`,
    ].join('\n'),
  }
}

// Runs `"$@"` in the directory `$3` with its output in the command directory `$1`, as
// `out` and `err` of at most MAX_OUTPUT_BYTES each, and its exit code in `exit` once
// all of it is there. The directory of the run `$2` is a link to the sandbox's files
// first. Before the command runs, each of `mountPaths` must still be the mount it was made
// as (the kernel's mountinfo, which no command writes): a command before could have moved
// a folder a mount is in and put files of its own in its place. When not, it marks the
// directory `changed` and ends with RUNNER_CHANGED_EXIT. Else its exit code is the command's.
// What the command left is cleaned up after it (the start cleans up before).
export function getWrapper(cleanUp: string, mountPaths: string[], tools: RunnerTools = RUNNER_TOOLS): string {
  const b = tools.busybox
  const sandbox = shellQuote(tools.sandbox)
  return [
    'd=$1; shift',
    // the output is all in the files before the exit code is; what the command left and
    // still writes there is not waited for long
    [
      'end() {',
      'exec >/dev/null 2>&1',
      `j=0; while { kill -0 "$co" || kill -0 "$ce"; } 2>/dev/null && [ $j -lt 20 ]; do ${b} sleep 0.05; j=$((j+1)); done`,
      cleanUp,
      `echo "$1" > "$d/exit.tmp" && ${b} mv -f "$d/exit.tmp" "$d/exit"`,
      'exit "$1"',
      '}',
    ].join('\n'),
    // past the limit the output is read and dropped, the command goes on
    `cap() { ${b} head -c ${MAX_OUTPUT_BYTES} > "$1"; ${b} cat > /dev/null; }`,
    'f=/tmp/.hammerkit-output-$$',
    `${b} mkfifo "$f-out" "$f-err" || end 126`,
    'cap "$d/out" < "$f-out" & co=$!',
    'cap "$d/err" < "$f-err" & ce=$!',
    'exec > "$f-out" 2> "$f-err"',
    `${b} rm -f "$f-out" "$f-err"`,
    `changed() { : > "$d/changed"; end ${RUNNER_CHANGED_EXIT}; }`,
    `${b} mkdir -p "$(${b} dirname "$1")" && ${b} ln -sfn ${sandbox} "$1" || changed`,
    ...mountPaths.map((path) => {
      const quoted = shellQuote(path)
      const field = shellQuote(`^[^ ]* [^ ]* [^ ]* [^ ]* ${toMountInfoPattern(path)} `)
      return `[ "$(${b} realpath ${quoted})" = ${quoted} ] && ${b} grep -q ${field} /proc/self/mountinfo || changed`
    }),
    'cd "$2" || end 126',
    `case "$(pwd -P)" in ${sandbox}|${sandbox}/*) ;; *) changed ;; esac`,
    'shift 2',
    '"$@"',
    'end $?',
  ].join('\n')
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

// A mount point as /proc/self/mountinfo writes it (space, tab, newline and backslash as
// octal escapes), as a basic regular expression
function toMountInfoPattern(path: string): string {
  const escaped = path.replace(/[\\ \t\n]/g, (c) => `\\${c.charCodeAt(0).toString(8).padStart(3, '0')}`)
  return escaped.replace(/[.[\]*^$\\]/g, (c) => `\\${c}`)
}

// per sandbox, the runners whose container ended as it started (an image without `sh`, or
// one that can not be pulled): their tasks run as Jobs while that pod of the files stays
const failed = new Map<string, { pod: string; keys: Set<string> }>()

// Whether the task's commands may run in the sandbox's runner
export function canUseRunner(
  task: WorkItem<ContainerWorkTask>,
  kubernetes: WorkKubernetesEnvironment,
  persistence: KubernetesPersistence
): boolean {
  const workspace = kubernetes.server?.workspace
  return (
    !!workspace?.runner &&
    !!workspace.pod &&
    persistence.workspace.length > 0 &&
    persistence.volumes.length === 0 &&
    persistence.mounts.every((mount) => mount.workspace) &&
    // the whole of the files at the root, so the runner has no writable directory of its own
    // around the mounts that a command could leave files in for the next runs
    persistence.mounts.some((mount) => relative(workspace.root, mount.mount.mountPath) === '') &&
    task.needs.length === 0 &&
    task.data.secrets.length === 0 &&
    task.data.generates.length === 0 &&
    // its pod would need the sandboxed runtime of a Job
    task.data.capAdd.length === 0
  )
}

// What the runner is made of: the same key for the same pod
export function getRunnerKey(
  task: WorkItem<ContainerWorkTask>,
  kubernetes: WorkKubernetesEnvironment,
  persistence: KubernetesPersistence
): string {
  const server = kubernetes.server!
  const workspace = server.workspace!
  return createHash('sha256')
    .update(
      JSON.stringify({
        sandbox: workspace.label,
        pod: workspace.pod?.uid ?? null,
        image: task.data.image,
        envs: getEnvironmentVariables(task.data.envs),
        resources: getKubernetesResources(task.data.resources),
        network: getEffectiveNetwork(task.data),
        mounts: getRunnerMounts(workspace, persistence),
        placement: getPodPlacement(server, task.data.pool),
        security: getContainerSecurity(kubernetes),
        version: getVersion(),
      })
    )
    .digest('hex')
    .slice(0, 40)
}

export function getRunnerName(key: string): string {
  return `hammerkit-runner-${key.slice(0, 20)}`
}

export function buildRunnerPod(options: {
  task: WorkItem<ContainerWorkTask>
  kubernetes: WorkKubernetesEnvironment
  persistence: KubernetesPersistence
  key: string
  network: Pick<KubernetesItemNetwork, 'env' | 'hostAliases' | 'initContainers'>
  owner: V1OwnerReference
}): V1Pod & KubernetesObjectHeader {
  const { task, kubernetes, persistence, key, network, owner } = options
  const server = kubernetes.server!
  const workspace = server.workspace!
  const placement = getPodPlacement(server, task.data.pool)
  const envs = getEnvironmentVariables(task.data.envs)
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      namespace: kubernetes.namespace,
      name: getRunnerName(key),
      annotations: { 'hammerkit.dev/version': getVersion() },
      labels: {
        // what its policy and proxy select it by
        [ID_LABEL]: key,
        [RUNNER_LABEL]: key.slice(0, 20),
        [SANDBOX_LABEL]: workspace.label,
        ...getNetworkLabels(kubernetes, task),
      },
      ownerReferences: [owner],
    },
    spec: {
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      restartPolicy: 'Never',
      terminationGracePeriodSeconds: 0,
      nodeSelector: placement.nodeSelector,
      ...(placement.tolerations.length > 0 ? { tolerations: placement.tolerations } : {}),
      affinity: getSandboxAffinity(workspace.label),
      hostAliases: network.hostAliases,
      initContainers: [
        ...network.initContainers,
        {
          name: 'hammerkit-runner-tools',
          image: RUNNER_TOOLS_IMAGE,
          command: ['/bin/busybox', 'cp', '/bin/busybox', BUSYBOX],
          volumeMounts: [{ name: TOOLS_VOLUME, mountPath: TOOLS_PATH }],
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 65534,
            allowPrivilegeEscalation: false,
            readOnlyRootFilesystem: true,
            capabilities: { drop: ['ALL'] },
          },
          resources: { limits: { memory: '16Mi' } },
        },
      ],
      containers: [
        {
          name: RUNNER_CONTAINER,
          image: task.data.image,
          command: IDLE_COMMAND,
          workingDir: RUNNER_SANDBOX_PATH,
          env: [...Object.entries(envs).map<V1EnvVar>(([name, value]) => ({ name, value })), ...network.env],
          volumeMounts: [
            ...getRunnerMounts(workspace, persistence),
            { name: TMP_VOLUME, mountPath: '/tmp' },
            // not even root in the container writes it: it has no capability to remount
            { name: TOOLS_VOLUME, mountPath: TOOLS_PATH, readOnly: true },
          ],
          ...getKubernetesResources(task.data.resources),
          ...getContainerSecurity(kubernetes),
        },
      ],
      volumes: [...persistence.workspace, { name: TMP_VOLUME, emptyDir: {} }, { name: TOOLS_VOLUME, emptyDir: {} }],
    },
  }
}

// The exit code of an exec, from the status the API server ends it with
export function getExecExitCode(status: V1Status | undefined): number | undefined {
  if (status?.status === 'Success') {
    return 0
  }
  const code = status?.details?.causes?.find((cause) => cause.reason === 'ExitCode')?.message
  return code !== undefined && /^\d+$/.test(code) ? Number(code) : undefined
}

export type RunnerResult =
  | { type: 'unavailable' }
  | { type: 'done' }
  | { type: 'crash'; exitCode: number }
  | { type: 'canceled' }

// what a process that is not the one of a run on a server knows of its commands: nothing
const processCommands = createRunnerCommands()

/**
 * Runs the task's commands in the sandbox's runner, started when there is none (or one of
 * something else). `unavailable` when the task can not use it now (the runner is in use by
 * another task of the run, the pod of the sandbox's files went, or the runner did not
 * start): the task then runs as Jobs. In a run that resumed, a command that runs on is
 * followed where it runs, one that ended is not run again (RunnerCommands).
 */
export async function executeInRunner(
  instance: KubernetesInstance,
  task: WorkItem<ContainerWorkTask>,
  kubernetes: WorkKubernetesEnvironment,
  persistence: KubernetesPersistence,
  abort: AbortSignal,
  commands: RunnerCommands = processCommands
): Promise<RunnerResult> {
  const workspace = kubernetes.server!.workspace!
  const inUse = commands.inUse
  if (inUse.has(workspace.label)) {
    return { type: 'unavailable' }
  }
  inUse.add(workspace.label)
  try {
    const filesPod = await getFilesPod(instance, kubernetes.namespace, workspace)
    if (!filesPod) {
      return { type: 'unavailable' }
    }
    const run = kubernetes.server!.run
    const execute = (name: string) => executeCommands(instance, task, kubernetes, persistence, abort, commands, name)
    if (commands.resumed) {
      // a command of the run that still runs keeps its runner, of an older server say, until
      // it ended: a runner of the task's key would replace it, and a command of it run first
      // kill it
      const holding = await findRunnerOfRun(instance, kubernetes.namespace, workspace.label, filesPod.uid, run, abort)
      if (holding) {
        task.status.write('debug', `a command of the run runs on in the runner ${holding} of the sandbox`)
        return await execute(holding)
      }
    }
    const key = getRunnerKey(task, kubernetes, persistence)
    const name = getRunnerName(key)
    const failedOf = failed.get(workspace.label)
    if (failedOf?.pod === filesPod.uid && failedOf.keys.has(key)) {
      return { type: 'unavailable' }
    }
    // its policy and proxy select it by the key, and stay for the next runs
    const item: WorkItem<ContainerWorkTask> = { ...task, id: () => key }
    const found = await getRunner(instance, kubernetes.namespace, name, filesPod.uid)
    let runner = found?.ready ? found.pod : undefined
    const sandbox = { label: workspace.label, pod: workspace.pod }
    const owners = (pod?: V1Pod) => [filesPod, ...(pod ? [ownerOf(pod)] : [])]
    const network = await ensureKubernetesItemNetwork(instance, kubernetes, item, {
      followLog: true,
      run: null,
      sandbox,
      owners: owners(runner),
    })
    try {
      if (!runner) {
        let started: Awaited<ReturnType<typeof startRunner>>
        if (found) {
          // one a task before started, which stopped while it did: it goes on starting
          started = await waitForRunner(instance, kubernetes.namespace, found.pod, abort)
        } else {
          // one of something else goes, with its limits
          await removeSandboxRunners(
            instance,
            kubernetes.namespace,
            workspace.label,
            (pod) => pod.metadata?.name === name
          )
          started = await startRunner(
            instance,
            buildRunnerPod({ task, kubernetes, persistence, key, network, owner: filesPod }),
            abort
          )
        }
        if (!('pod' in started)) {
          if (started.reason === 'ended') {
            if (failedOf?.pod !== filesPod.uid) {
              failed.set(workspace.label, { pod: filesPod.uid, keys: new Set() })
            }
            failed.get(workspace.label)!.keys.add(key)
          }
          task.status.write(
            'debug',
            `the runner of the sandbox did not start (${started.message}), the task runs as a Job`
          )
          return { type: 'unavailable' }
        }
        runner = started.pod
        if (Object.keys(getNetworkLabels(kubernetes, task)).length > 0) {
          // the policy stays until the runner ended too
          await setPolicyOwners(
            instance,
            kubernetes.namespace,
            getNetworkPolicyName(item, { run: null }),
            owners(runner)
          )
        }
      } else {
        task.status.write('debug', `runs in the runner ${name} of the sandbox`)
      }
      return await execute(name)
    } finally {
      network.close()
    }
  } finally {
    inUse.delete(workspace.label)
  }
}

// Runs the task's commands one after the other in the runner `name`, until one fails
async function executeCommands(
  instance: KubernetesInstance,
  task: WorkItem<ContainerWorkTask>,
  kubernetes: WorkKubernetesEnvironment,
  persistence: KubernetesPersistence,
  abort: AbortSignal,
  commands: RunnerCommands,
  name: string
): Promise<RunnerResult> {
  const workspace = kubernetes.server!.workspace!
  const mounts = getRunnerMounts(workspace, persistence)
  const scripts = getRunnerScripts(
    getCleanUp(getScratchDirectories(mounts)),
    mounts.map((mount) => mount.mountPath)
  )
  const execution = commands.executions.get(task.name) ?? 0
  commands.executions.set(task.name, execution + 1)
  for (const [step, cmd] of task.data.cmds.entries()) {
    task.status.write('debug', `execute ${cmd.cmd} in the runner of the sandbox`)
    const exitCode = await execInRunner(
      instance,
      kubernetes.namespace,
      name,
      workspace.root,
      cmd.cwd,
      [task.data.shell, '-c', cmd.cmd],
      scripts,
      {
        directory: getCommandDirectory(kubernetes.server!.run, task.name, step, execution),
        record: { task: task.name, step, execution },
        commands,
      },
      task,
      abort
    )
    if (abort.aborted) {
      return { type: 'canceled' }
    }
    if (exitCode === 'changed') {
      // a fresh pod for the next task; this one fails rather than running again as a Job,
      // since a command can say so itself after it ran
      await removeSandboxRunners(instance, kubernetes.namespace, workspace.label, (pod) => pod.metadata?.name !== name)
      throw new Error('a command changed the runner of the sandbox, it was removed: run the task again')
    }
    if (exitCode !== 0) {
      return { type: 'crash', exitCode }
    }
  }
  return { type: 'done' }
}

// The runners of a sandbox, those that run of the pod of its files `owner` when it is named
async function listRunnerPods(
  instance: KubernetesInstance,
  namespace: string,
  sandbox: string,
  owner?: string
): Promise<V1Pod[]> {
  const pods = await instance.coreApi.listNamespacedPod({
    namespace,
    labelSelector: `${SANDBOX_LABEL}=${sandbox},${RUNNER_LABEL}`,
  })
  return owner === undefined
    ? pods.items
    : pods.items.filter(
        (pod) =>
          !!pod.metadata?.name &&
          !pod.metadata.deletionTimestamp &&
          isRunning(pod) &&
          (pod.metadata.ownerReferences ?? []).some((reference) => reference.uid === owner)
      )
}

// The runner of the sandbox, of the pod of its files, in which a command of the run runs. One
// that can not be asked fails the task: a new runner would replace the pod the command runs in.
// A runner that does not run (it ended, or is going) holds no command that runs.
async function findRunnerOfRun(
  instance: KubernetesInstance,
  namespace: string,
  sandbox: string,
  owner: string,
  run: string,
  abort: AbortSignal
): Promise<string | undefined> {
  const scripts = getRunnerScripts('', [])
  for (const pod of await listRunnerPods(instance, namespace, sandbox, owner)) {
    const name = pod.metadata!.name!
    const found = await reconnecting(abort, () =>
      runScript(instance, namespace, name, scripts.find, [getRunCommandsDirectory(run)], { timeout: KILL_TIMEOUT_MS })
    )
    if (found.exitCode === undefined) {
      throw new Error(
        `the runner ${name} of the sandbox could not be asked for the commands of the run: ${found.message}`
      )
    }
    if (found.out.trim() === 'yes') {
      return name
    }
  }
  return undefined
}

/**
 * Kills what the commands of the run `run` run in the runners of the sandbox and removes their
 * directory (getRunCommandsDirectory). `clean`: the run still holds the sandbox, what the
 * commands left is cleaned up too. Without a runner that runs it all went with the runners,
 * and the next command on the sandbox removes the files of other runs.
 */
export async function removeRunCommands(
  instance: KubernetesInstance,
  namespace: string,
  sandbox: string,
  run: string,
  options: { clean: boolean }
): Promise<void> {
  const failures: string[] = []
  for (const pod of await listRunnerPods(instance, namespace, sandbox)) {
    const name = pod.metadata?.name
    if (!name || pod.metadata?.deletionTimestamp || !isRunning(pod)) {
      continue
    }
    // the scratch directories of this pod, as its commands clean them up: none a mount is in
    const scripts = getRunnerScripts(getCleanUp(getScratchDirectories(getScratchMounts(pod))), [])
    const removed = await runScript(
      instance,
      namespace,
      name,
      scripts.remove,
      [getRunCommandsDirectory(run), options.clean ? 'clean' : ''],
      { timeout: KILL_TIMEOUT_MS }
    )
    if (removed.exitCode === undefined) {
      failures.push(`${name}: ${removed.message}`)
    }
  }
  if (failures.length > 0) {
    throw new Error(`the commands of the run could not be removed in ${failures.join(', ')}`)
  }
}

// The mounts of the runner's container that its scratch directories have to keep clear of:
// all but its own /tmp, which is one of them
function getScratchMounts(pod: V1Pod): V1VolumeMount[] {
  const container = pod.spec?.containers?.find((candidate) => candidate.name === RUNNER_CONTAINER)
  return (container?.volumeMounts ?? []).filter((mount) => mount.name !== TMP_VOLUME)
}

// The pod of the sandbox's files the run holds, as long as it is still that pod
async function getFilesPod(
  instance: KubernetesInstance,
  namespace: string,
  workspace: WorkKubernetesWorkspace
): Promise<V1OwnerReference | undefined> {
  if (!workspace.pod) {
    return undefined
  }
  const pod = await instance.coreApi
    .readNamespacedPod({ name: workspace.pod.name, namespace })
    .catch((e) => (statusCodeOf(e) === 404 ? undefined : Promise.reject(e)))
  if (!pod || pod.metadata?.uid !== workspace.pod.uid || pod.metadata?.deletionTimestamp) {
    return undefined
  }
  return ownerOf(pod)
}

function ownerOf(pod: V1Pod): V1OwnerReference {
  return { apiVersion: 'v1', kind: 'Pod', name: pod.metadata!.name!, uid: pod.metadata!.uid! }
}

// The runner of that name, when it belongs to the pod of the files and runs, or still
// starts (`ready` false); one that ended or is going is deleted
async function getRunner(
  instance: KubernetesInstance,
  namespace: string,
  name: string,
  owner: string
): Promise<{ pod: V1Pod; ready: boolean } | undefined> {
  const pod = await instance.coreApi
    .readNamespacedPod({ name, namespace })
    .catch((e) => (statusCodeOf(e) === 404 ? undefined : Promise.reject(e)))
  if (!pod) {
    return undefined
  }
  const ours =
    !pod.metadata?.deletionTimestamp &&
    (pod.metadata?.ownerReferences ?? []).some((reference) => reference.uid === owner)
  if (ours && isRunning(pod)) {
    return { pod, ready: true }
  }
  if (ours && pod.status?.phase === 'Pending' && !getStartFailure(pod)) {
    return { pod, ready: false }
  }
  await deletePod(instance, namespace, name)
  return undefined
}

function isRunning(pod: V1Pod): boolean {
  const status = pod.status?.containerStatuses?.find((s) => s.name === RUNNER_CONTAINER)
  return pod.status?.phase === 'Running' && !!status?.state?.running
}

// Why the runner will not run: its container ended, or an image can not be pulled, which
// waits forever and is as good as ended
function getStartFailure(pod: V1Pod): string | undefined {
  const status = pod.status?.containerStatuses?.find((s) => s.name === RUNNER_CONTAINER)
  const unpulled = [...(pod.status?.initContainerStatuses ?? []), ...(pod.status?.containerStatuses ?? [])].find((s) =>
    PULL_FAILURES.includes(s.state?.waiting?.reason ?? '')
  )
  if (unpulled) {
    return `${unpulled.state?.waiting?.reason} of ${unpulled.image}`
  }
  if (pod.status?.phase === 'Failed' || pod.status?.phase === 'Succeeded' || status?.state?.terminated) {
    return `its container ended with ${status?.state?.terminated?.exitCode ?? 'no code'}`
  }
  return undefined
}

// Waits until no pod of that name is left: a new one of the same name is refused before
async function deletePod(instance: KubernetesInstance, namespace: string, name: string): Promise<void> {
  try {
    await instance.coreApi.deleteNamespacedPod({ name, namespace, gracePeriodSeconds: 0 })
  } catch (e) {
    if (statusCodeOf(e) === 404) {
      return
    }
    throw e
  }
  const deadline = Date.now() + RUNNER_START_MS
  while (Date.now() < deadline) {
    const left = await instance.coreApi
      .readNamespacedPod({ name, namespace })
      .catch((e) => (statusCodeOf(e) === 404 ? undefined : Promise.reject(e)))
    if (!left) {
      return
    }
    await sleep(RUNNER_POLL_MS)
  }
  throw new Error(`the runner ${name} is still there`)
}

// Starts the runner and answers it once it runs, or why it does not: the cluster refused
// it (a full quota, say, which a Job waits for), its container ended, or it took too long
async function startRunner(
  instance: KubernetesInstance,
  spec: V1Pod & KubernetesObjectHeader,
  abort: AbortSignal
): Promise<{ pod: V1Pod } | { reason: 'refused' | 'ended' | 'stopped'; message: string }> {
  try {
    await instance.objectApi.create(spec)
  } catch (e) {
    return { reason: 'refused', message: getErrorMessage(e) }
  }
  return await waitForRunner(instance, spec.metadata.namespace, spec, abort)
}

// Waits until the runner runs. A task stopped meanwhile (cancelled, out of time) leaves it
// starting, for the next command, which would time out the same way if each started anew;
// one that ends, or does not run within RUNNER_START_MS of being made, goes.
async function waitForRunner(
  instance: KubernetesInstance,
  namespace: string,
  runner: V1Pod,
  abort: AbortSignal
): Promise<{ pod: V1Pod } | { reason: 'ended' | 'stopped'; message: string }> {
  const name = runner.metadata!.name!
  const created = runner.metadata?.creationTimestamp ? new Date(runner.metadata.creationTimestamp).getTime() : NaN
  const deadline = (Number.isNaN(created) ? Date.now() : Math.min(created, Date.now())) + RUNNER_START_MS
  for (;;) {
    const pod = await instance.coreApi.readNamespacedPod({ name, namespace })
    if (isRunning(pod)) {
      return { pod }
    }
    const failure = getStartFailure(pod)
    if (failure || Date.now() > deadline) {
      await deletePod(instance, namespace, name).catch(() => undefined)
      return failure ? { reason: 'ended', message: failure } : { reason: 'stopped', message: 'it took too long' }
    }
    if (abort.aborted) {
      return { reason: 'stopped', message: 'the task was stopped' }
    }
    await sleep(RUNNER_POLL_MS)
  }
}

// Removes the runners of a sandbox but those `keep` takes, and once each is gone its policy
// and proxy, which the pod of the sandbox's files would keep while it runs
export async function removeSandboxRunners(
  instance: KubernetesInstance,
  namespace: string,
  sandbox: string,
  keep?: (pod: V1Pod) => boolean
): Promise<void> {
  if (!keep) {
    // all of the sandbox's runners go: so does what was remembered of them
    failed.delete(sandbox)
  }
  for (const pod of await listRunnerPods(instance, namespace, sandbox)) {
    const name = pod.metadata?.name
    const key = pod.metadata?.labels?.[ID_LABEL]
    if (!name || keep?.(pod)) {
      continue
    }
    await deletePod(instance, namespace, name)
    if (key) {
      const item = { id: () => key } as WorkItem<ContainerWorkTask>
      await instance.objectApi
        .delete({
          apiVersion: 'networking.k8s.io/v1',
          kind: 'NetworkPolicy',
          metadata: { name: getNetworkPolicyName(item, { run: null }), namespace },
        })
        .catch((e) => (statusCodeOf(e) === 404 ? undefined : Promise.reject(e)))
      await removeSandboxProxies(instance, namespace, { sandbox, item })
    }
  }
}

async function setPolicyOwners(
  instance: KubernetesInstance,
  namespace: string,
  name: string,
  owners: V1OwnerReference[]
): Promise<void> {
  await instance.objectApi.patch(
    {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: { name, namespace, ownerReferences: owners },
    },
    undefined,
    undefined,
    undefined,
    undefined,
    'application/merge-patch+json'
  )
}

// a connection to the runner that broke, or a follow that failed, is tried again this often in a
// row without getting further, then the task fails
const RECONNECTS = 5

// What a command's directory says of it (the `state` of getRunnerScripts), from the last line
// a script printed
type CommandState =
  | { type: 'started' | 'running' | 'cancelled' | 'none' }
  | { type: 'finished'; exitCode: number; changed: boolean }

function parseCommandState(out: string): CommandState | undefined {
  const line = out.trim().split('\n').pop() ?? ''
  const finished = /^finished (\d+)( changed)?$/.exec(line)
  if (finished) {
    return { type: 'finished', exitCode: Number(finished[1]), changed: !!finished[2] }
  }
  return line === 'started' || line === 'running' || line === 'cancelled' || line === 'none'
    ? { type: line }
    : undefined
}

// Runs a command in the runner and answers its exit code. The command runs detached from
// the exec that starts it, and its output goes to the task's as it comes, line by line, read
// from its files: a connection that breaks is opened again and goes on from the byte the
// log got to, which RunnerCommands.reached is told of. A command the run started before (the
// process of the run before a restart) is not started again: one that runs is followed from
// where the log of the run got (RunnerCommands.resumed), one that ended says the rest. Any
// other command starts anew, whatever its directory holds. On abort (cancel, timeout) every
// process of the command is killed, or the runner goes when that fails; a command that can not
// be followed to its end is killed too.
async function execInRunner(
  instance: KubernetesInstance,
  namespace: string,
  pod: string,
  // the directory of the run's sandbox, and the command's in it
  root: string,
  cwd: string,
  command: string[],
  scripts: RunnerScripts,
  where: { directory: string; record: Pick<CommandRecord, 'task' | 'step' | 'execution'>; commands: RunnerCommands },
  task: WorkItem<ContainerWorkTask>,
  abort: AbortSignal
): Promise<number | 'changed'> {
  if (abort.aborted) {
    return 137
  }
  const { directory, record, commands } = where
  const id = posix.basename(directory)
  const resumed = commands.resumed?.[id]
  // the log said that the output was cut, once also over a restart (CommandRecord.cut)
  let cutSaid = !!resumed?.cut
  const report = (outputs: CommandOutputs, done = false) =>
    commands.reached?.(id, {
      ...record,
      ...outputs,
      ...(done ? { done: true as const } : {}),
      ...(cutSaid ? { cut: true as const } : {}),
    })
  let current: { close(): void } | undefined
  const opened = (socket: { close(): void }) => {
    current = socket
  }
  const cancel = () => runScript(instance, namespace, pod, scripts.cancel, [directory], { timeout: KILL_TIMEOUT_MS })
  const kill = async () => {
    const killed = await cancel()
    if (killed.exitCode === undefined) {
      task.status.write(
        'debug',
        `the command could not be stopped in the runner, it goes: ${killed.message ?? 'the kill did not end'}`
      )
      await deletePod(instance, namespace, pod).catch(() => undefined)
    }
    current?.close()
  }
  let killing: Promise<void> | undefined
  const aborted = () => {
    killing ??= kill()
  }
  const stopped = async () => {
    aborted()
    await killing
    return 137
  }
  abort.addEventListener('abort', aborted, { once: true })
  try {
    // a start again after its connection broke takes the command it started, by its nonce
    const nonce = randomBytes(12).toString('hex')
    const start = (mode: 'fresh' | 'adopt') =>
      runScript(
        instance,
        namespace,
        pod,
        scripts.start,
        [directory, mode, resumed ? '' : nonce, root, cwd, ...command],
        { opened }
      )
    let started = await start(resumed ? 'adopt' : 'fresh')
    for (let attempt = 0; started.exitCode === undefined && attempt < RECONNECTS && !abort.aborted; attempt++) {
      await sleep(RUNNER_POLL_MS * 2 ** attempt)
      started = await start('adopt')
    }
    if (abort.aborted) {
      return await stopped()
    }
    const state = parseCommandState(started.out)
    if (!state || state.type === 'none') {
      throw new Error(
        `the command could not be started in the runner of the sandbox: ${
          started.message ?? `exit code ${started.exitCode}`
        }`
      )
    }
    if (state.type === 'cancelled') {
      throw new Error('the command was cancelled in the runner of the sandbox')
    }
    // a command started now has all its output to say; one that was there already what the
    // log of the run does not hold yet
    const offsets: CommandOutputs =
      state.type === 'started'
        ? { stdout: 0, stderr: 0 }
        : { stdout: resumed?.stdout ?? 0, stderr: resumed?.stderr ?? 0 }
    if (!resumed) {
      // the run started it (or a start of it again took it, after its connection broke): a run
      // that resumes takes it up again
      report(offsets)
    }
    if (state.type !== 'started') {
      task.status.write(
        'debug',
        `the command was started before, it is ${state.type === 'running' ? 'followed' : 'over'}`
      )
    }
    const output = { bytes: offsets.stdout + offsets.stderr }
    const cut = (what: string) => {
      if (!cutSaid) {
        cutSaid = true
        task.status.write('warn', `${what} of ${task.name} was cut at ${MAX_OUTPUT_BYTES} bytes`)
      }
    }
    const say = (stream: 'stdout' | 'stderr', bytes: Buffer) => {
      offsets[stream] += bytes.length
      if (output.bytes < MAX_OUTPUT_BYTES) {
        output.bytes += bytes.length
        for (const line of bytes
          .toString('utf8')
          .replace(/\r?\n$/, '')
          .split(/\r?\n/)) {
          task.status.console(stream, line)
        }
      }
      if (output.bytes >= MAX_OUTPUT_BYTES) {
        cut('the output')
      } else if (offsets[stream] >= MAX_OUTPUT_BYTES) {
        // the file of the stream holds no more, what the command says after is dropped
        cut(`the ${stream}`)
      }
      report(offsets)
    }
    // whole lines as they come; what is left of a line when the exec ends is read again by
    // the next, or said once the command ended
    const lines = (stream: 'stdout' | 'stderr') => {
      let pending = Buffer.alloc(0)
      const writable = new Writable({
        write(chunk: Buffer, _encoding, callback) {
          pending = Buffer.concat([pending, chunk])
          const end = pending.lastIndexOf(0x0a)
          if (end >= 0) {
            say(stream, pending.subarray(0, end + 1))
            pending = pending.subarray(end + 1)
          }
          callback()
        },
      })
      return {
        writable,
        rest: () => {
          if (pending.length > 0) {
            say(stream, pending)
          }
        },
      }
    }
    for (let failures = 0; ; ) {
      const before = offsets.stdout + offsets.stderr
      const stdout = lines('stdout')
      const stderr = lines('stderr')
      const followed = await runScript(
        instance,
        namespace,
        pod,
        scripts.follow,
        [directory, String(offsets.stdout), String(offsets.stderr)],
        { stdout: stdout.writable, stderr: stderr.writable, opened }
      )
      if (abort.aborted) {
        return await stopped()
      }
      if (followed.exitCode === 3) {
        throw new Error('the command in the runner of the sandbox ended without an exit code: its runner went')
      }
      // 0: all of it was said. Else what followed it ended before: the end of the command killed
      // it (137), its connection broke, it failed. It is followed again, a few times in a row
      // without getting further at most: a command that keeps killing what follows it too
      if (followed.exitCode !== 0) {
        failures = offsets.stdout + offsets.stderr > before ? 1 : failures + 1
        if (failures > RECONNECTS) {
          throw new Error(
            `the command in the runner of the sandbox could not be followed: ${
              followed.message ?? `exit code ${followed.exitCode}`
            }`
          )
        }
      }
      const status = await reconnecting(abort, () =>
        runScript(instance, namespace, pod, scripts.status, [directory], { timeout: KILL_TIMEOUT_MS })
      )
      if (abort.aborted) {
        return await stopped()
      }
      const now = parseCommandState(status.out)
      if (!now) {
        throw new Error(
          `the command in the runner of the sandbox ended without an exit code: ${
            status.message ?? followed.message ?? 'the connection closed'
          }`
        )
      }
      if (now.type === 'none') {
        throw new Error('the command in the runner of the sandbox ended without an exit code: its runner went')
      }
      if (followed.exitCode === 0) {
        if (now.type === 'cancelled') {
          throw new Error('the command was cancelled in the runner of the sandbox')
        }
        if (now.type === 'finished') {
          stdout.rest()
          stderr.rest()
          report(offsets, true)
          return now.exitCode === RUNNER_CHANGED_EXIT && now.changed ? 'changed' : now.exitCode
        }
      }
      await sleep(RUNNER_POLL_MS)
    }
  } catch (e) {
    if (!abort.aborted) {
      // what can not be followed to its end does not run on unseen
      const killed = await cancel()
      if (killed.exitCode === undefined) {
        task.status.write('debug', `the command could not be stopped in the runner: ${killed.message}`)
      }
    }
    throw e
  } finally {
    abort.removeEventListener('abort', aborted)
  }
}

// Runs `fn` again while it answers no exit code (its connection broke), RECONNECTS times at most
async function reconnecting(abort: AbortSignal, fn: () => Promise<ScriptResult>): Promise<ScriptResult> {
  let result = await fn()
  for (let attempt = 0; result.exitCode === undefined && attempt < RECONNECTS && !abort.aborted; attempt++) {
    await sleep(RUNNER_POLL_MS * 2 ** attempt)
    result = await fn()
  }
  return result
}

interface ScriptResult {
  // what it printed, when not to `stdout`
  out: string
  // undefined: it ended without one, its connection broke
  exitCode?: number
  message?: string
}

// Runs a script of the runner's busybox with `args` as `$1`… in the runner
async function runScript(
  instance: KubernetesInstance,
  namespace: string,
  pod: string,
  script: string,
  args: string[],
  options: {
    stdout?: Writable
    stderr?: Writable
    // the exec is closed when it did not end by then (ms)
    timeout?: number
    opened?: (socket: { close(): void }) => void
  } = {}
): Promise<ScriptResult> {
  let out = ''
  const stdout =
    options.stdout ??
    new Writable({
      write(chunk: Buffer, _encoding, callback) {
        out += chunk.toString('utf8')
        callback()
      },
    })
  let status: V1Status | undefined
  let broken: unknown
  try {
    const socket = await instance.exec.exec(
      namespace,
      pod,
      RUNNER_CONTAINER,
      [BUSYBOX, 'sh', '-c', script, 'hammerkit', ...args],
      stdout,
      options.stderr ?? null,
      null,
      false,
      (received) => {
        status = received
      }
    )
    options.opened?.(socket)
    const closed = new Promise<void>((resolve) => {
      socket.on('close', () => resolve())
      socket.on('error', (e) => {
        broken = e
        resolve()
      })
    })
    if (options.timeout) {
      let timer: NodeJS.Timeout | undefined
      await Promise.race([
        closed,
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            broken ??= new Error('it did not answer')
            socket.close()
            resolve()
          }, options.timeout)
        }),
      ])
      clearTimeout(timer)
    } else {
      await closed
    }
  } catch (e) {
    broken = e
  }
  const exitCode = broken && !status ? undefined : getExecExitCode(status)
  return {
    out,
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(exitCode === undefined
      ? { message: status?.message ?? (broken ? getErrorMessage(broken) : 'the connection closed') }
      : {}),
  }
}
