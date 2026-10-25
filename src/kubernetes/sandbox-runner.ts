import { createHash } from 'crypto'
import { posix, relative, sep } from 'path'
import { StringDecoder } from 'string_decoder'
import { Writable } from 'stream'
import { finished } from 'stream/promises'
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
import { getSandboxAffinity, KubernetesPersistence, SANDBOX_LABEL } from './volumes'

/**
 * The runner of a sandbox: one pod that the commands of a run on the sandbox are exec'd
 * into, one after the other, in place of a Job each. A Job's pod takes seconds to be
 * scheduled and to start; an exec into a running pod a fraction of one.
 *
 * - Only a task shaped like an agent's shell gets it: a container task that mounts the
 *   sandbox and nothing else (no claims of its own or of its dependencies, so no
 *   `generates`), with no `needs` and no secrets. Any other task runs as a Job.
 * - The pod is the task's container as its Job would have it: its image, variables,
 *   resources, the sandbox's claim, the security context, the nodes of the pool and the
 *   node of the pod of the sandbox's files. It is named after all of that (getRunnerKey),
 *   so a change starts a new one and the one before goes. Its first process only waits.
 * - Every command runs in a wrapper that first and last kills every other process of the
 *   container and empties /tmp and /dev/shm (unless a mount of the task is in one): the
 *   container is reused, what a command started is not. A command cancelled, out of time or whose connection broke is killed
 *   the same way, or the pod is deleted. The first process and the wrapper run a static
 *   busybox from a read-only mount, so a command can not replace what cleans up after it.
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
// Pinned, static (it runs in any image), and copied into the runner by an init container.
// To bump it, take the index digest of the tag (`docker buildx imagetools inspect
// busybox:<version>-musl`).
export const RUNNER_TOOLS_IMAGE =
  'busybox:1.37.0-musl@sha256:5cec3fc171c87218698e85a52af7087de727372aae264a787b8112901a5b0092'
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
export function getCleanUp(directories: string[]): string {
  const patterns = directories.flatMap((directory) => [`${directory}/*`, `${directory}/.[!.]*`, `${directory}/..?*`])
  return [
    'i=0',
    'while kill -KILL -1 2>/dev/null && [ $i -lt 10 ]; do i=$((i+1)); done',
    ...(patterns.length > 0 ? [`${BUSYBOX} rm -rf ${patterns.join(' ')} 2>/dev/null`] : []),
  ].join('\n')
}

// Runs `"$@"` in the directory `$2`, alone in the container: what an earlier command left
// is cleaned up before, what this one left after. The directory of the run `$1` is a link
// to the sandbox's files first. Its exit code is the command's.
export function getWrapper(cleanUp: string): string {
  return [
    cleanUp,
    `${BUSYBOX} mkdir -p "$(${BUSYBOX} dirname "$1")" && ${BUSYBOX} ln -sfn ${RUNNER_SANDBOX_PATH} "$1" || exit 126`,
    'cd "$2" || exit 126',
    'shift 2',
    '"$@"',
    'code=$?',
    cleanUp,
    'exit $code',
  ].join('\n')
}

// the sandboxes whose runner a task of this process uses: one command at a time each, the
// other tasks of the run run as Jobs meanwhile
const inUse = new Set<string>()
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
    task.needs.length === 0 &&
    task.data.secrets.length === 0 &&
    task.data.generates.length === 0
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

/**
 * Runs the task's commands in the sandbox's runner, started when there is none (or one of
 * something else). `unavailable` when the task can not use it now (the runner is in use by
 * another task of the run, the pod of the sandbox's files went, or the runner did not
 * start): the task then runs as Jobs.
 */
export async function executeInRunner(
  instance: KubernetesInstance,
  task: WorkItem<ContainerWorkTask>,
  kubernetes: WorkKubernetesEnvironment,
  persistence: KubernetesPersistence,
  abort: AbortSignal
): Promise<RunnerResult> {
  const workspace = kubernetes.server!.workspace!
  if (inUse.has(workspace.label)) {
    return { type: 'unavailable' }
  }
  inUse.add(workspace.label)
  try {
    const filesPod = await getFilesPod(instance, kubernetes.namespace, workspace)
    if (!filesPod) {
      return { type: 'unavailable' }
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
      const cleanUp = getCleanUp(getScratchDirectories(getRunnerMounts(workspace, persistence)))
      for (const cmd of task.data.cmds) {
        task.status.write('debug', `execute ${cmd.cmd} in the runner of the sandbox`)
        const exitCode = await execInRunner(
          instance,
          kubernetes.namespace,
          name,
          workspace.root,
          cmd.cwd,
          [task.data.shell, '-c', cmd.cmd],
          cleanUp,
          task,
          abort
        )
        if (abort.aborted) {
          return { type: 'canceled' }
        }
        if (exitCode !== 0) {
          return { type: 'crash', exitCode }
        }
      }
      return { type: 'done' }
    } finally {
      network.close()
    }
  } finally {
    inUse.delete(workspace.label)
  }
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
  const pods = await instance.coreApi.listNamespacedPod({
    namespace,
    labelSelector: `${SANDBOX_LABEL}=${sandbox},${RUNNER_LABEL}`,
  })
  for (const pod of pods.items) {
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

// Runs a command in the runner and answers its exit code. Its output goes to the task's,
// line by line as it comes. On abort (cancel, timeout) every process of the command is
// killed, or the runner goes when that fails.
async function execInRunner(
  instance: KubernetesInstance,
  namespace: string,
  pod: string,
  // the directory of the run's sandbox, and the command's in it
  root: string,
  cwd: string,
  command: string[],
  cleanUp: string,
  task: WorkItem<ContainerWorkTask>,
  abort: AbortSignal
): Promise<number> {
  const output = { bytes: 0, cut: false }
  const lines = (stream: 'stdout' | 'stderr') => {
    let rest = ''
    // a character split between two chunks stays whole
    const decoder = new StringDecoder('utf8')
    const writable = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        if (output.bytes < MAX_OUTPUT_BYTES) {
          output.bytes += chunk.length
          const parts = (rest + decoder.write(chunk)).split(/\r?\n/)
          rest = parts.pop() ?? ''
          for (const line of parts) {
            task.status.console(stream, line)
          }
        } else if (!output.cut) {
          output.cut = true
          task.status.write('warn', `the output of ${task.name} was cut at ${MAX_OUTPUT_BYTES} bytes`)
        }
        callback()
      },
      final(callback) {
        rest += decoder.end()
        if (rest.length > 0) {
          task.status.console(stream, rest)
        }
        callback()
      },
    })
    return writable
  }
  const stdout = lines('stdout')
  const stderr = lines('stderr')
  let status: V1Status | undefined
  const socket = await instance.exec.exec(
    namespace,
    pod,
    RUNNER_CONTAINER,
    [BUSYBOX, 'sh', '-c', getWrapper(cleanUp), 'hammerkit', root, cwd, ...command],
    stdout,
    stderr,
    null,
    false,
    (received) => {
      status = received
    }
  )
  const closed = new Promise<void>((resolve, reject) => {
    socket.on('close', () => resolve())
    socket.on('error', (e) => reject(e))
  })
  const kill = async () => {
    try {
      await killInRunner(instance, namespace, pod, cleanUp)
    } catch (e) {
      task.status.write('debug', `the command could not be stopped in the runner, it goes: ${getErrorMessage(e)}`)
      await deletePod(instance, namespace, pod).catch(() => undefined)
    }
    // what the command printed after it was killed is not waited for long
    await Promise.race([closed.catch(() => undefined), sleep(KILL_TIMEOUT_MS)])
    socket.close()
  }
  const aborted = () => {
    void kill()
  }
  if (abort.aborted) {
    aborted()
  } else {
    abort.addEventListener('abort', aborted, { once: true })
  }
  let broken: unknown
  try {
    await closed.catch((e) => {
      broken = e
    })
    if (!abort.aborted && getExecExitCode(status) === undefined) {
      // the connection broke while the command may still run: it ends here as on a cancel,
      // before the run lets go of the sandbox
      await kill()
    }
  } finally {
    abort.removeEventListener('abort', aborted)
    for (const stream of [stdout, stderr]) {
      if (!stream.writableEnded) {
        stream.end()
      }
    }
    await Promise.all([finished(stdout), finished(stderr)]).catch(() => undefined)
  }
  if (abort.aborted) {
    return 137
  }
  const exitCode = getExecExitCode(status)
  if (exitCode === undefined) {
    throw new Error(
      `the command in the runner of the sandbox ended without an exit code: ${
        status?.message ?? (broken ? getErrorMessage(broken) : 'the connection closed')
      }`
    )
  }
  return exitCode
}

async function killInRunner(
  instance: KubernetesInstance,
  namespace: string,
  pod: string,
  cleanUp: string
): Promise<void> {
  let status: V1Status | undefined
  const socket = await instance.exec.exec(
    namespace,
    pod,
    RUNNER_CONTAINER,
    [BUSYBOX, 'sh', '-c', cleanUp],
    null,
    null,
    null,
    false,
    (received) => {
      status = received
    }
  )
  await Promise.race([
    new Promise<void>((resolve, reject) => {
      socket.on('close', () => resolve())
      socket.on('error', reject)
    }),
    sleep(KILL_TIMEOUT_MS).then(() => Promise.reject(new Error('the kill did not answer'))),
  ])
  // what it answers does not matter, that it answered does
  if (getExecExitCode(status) === undefined) {
    throw new Error(status?.message ?? 'the kill did not end')
  }
}
