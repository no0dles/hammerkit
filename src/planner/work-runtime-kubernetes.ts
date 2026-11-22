import { AbortError } from '../executer/abort'
import { ArchiveOptions, ArchiveWritten, ExecuteOptions, WorkRuntime } from '../runtime/runtime'
import { ContainerWorkService, KubernetesWorkService } from './work-service'
import { ServiceState } from '../executer/scheduler/service-state'
import { TaskState } from '../executer/scheduler/task-state'
import { ContainerWorkTask } from './work-task'
import { WorkCommand } from './work-command'
import { WorkItem } from './work-item'
import { State } from '../executer/state'
import { Environment } from '../executer/environment'
import { kubernetesService } from '../executer/kubernetes-service'
import { WorkKubernetesEnvironment } from './work-environment'
import { createKubernetesInstances, KubernetesInstance } from '../kubernetes/kubernetes-instance'
import { getEnvironmentVariables } from '../environment/replace-env-variables'
import { V1Container, V1Deployment, V1EnvVar, V1Job, V1Pod, V1PodSpec, V1VolumeMount } from '@kubernetes/client-node'
import { apply, KubernetesObjectHeader, statusCodeOf } from '../kubernetes/apply'
import { ensureKubernetesServiceExists } from '../kubernetes/ensure-kubernetes-service-exists'
import {
  DEFINITION_LABEL,
  ensureKubernetesDeploymentExists,
  getServiceContainerName,
} from '../kubernetes/ensure-kubernetes-deployment-exists'
import { followPodLogs } from '../kubernetes/follow-pod-logs'
import type { PodLogCursor, PodLogFollower } from '../kubernetes/follow-pod-logs'
import { recordExecution } from './work-item-executions'
import { getServiceDefinitionHash } from './service-definition'
import { getLegacyServiceItem } from './work-service-id'
import { ensureNamespace } from '../kubernetes/ensure-namespace'
import {
  ensurePersistentData,
  getStateDirsInUse,
  QUOTA_TIMEOUT,
  restoreLiveFiles,
} from '../kubernetes/ensure-persistent-data'
import { NETWORK_GATE_CONTAINER } from '../kubernetes/network-gate'
import { awaitJobCompletion, deleteJob, deleteJobAndWait, stopJob } from '../kubernetes/await-running-state'
import {
  getKubernetesPersistence,
  getStateFilesDir,
  getVolumeName,
  getWorkspacePodSpec,
  isLiveService,
} from '../kubernetes/volumes'
import { serviceRollouts } from '../kubernetes/service-rollouts'
import { getItemLabels, getItemSelector, getResourceName } from '../kubernetes/resources'
import { ensureHttpRoute, HTTP_ROUTE_API_VERSION, HTTP_ROUTE_KIND } from '../kubernetes/ensure-http-route'
import findProcess from 'find-process'
import { getErrorMessage } from '../log'
import { getVersion } from '../version'
import { getKubernetesCommandText } from './utils/task-arguments'
import { restoreKubernetesData } from '../kubernetes/restore-kubernetes-data'
import { storeKubernetesData } from '../kubernetes/store-kubernetes-data'
import { removePersistentData } from '../kubernetes/remove-persistent-data'
import {
  forgetClaimState,
  isClaimWrittenBy,
  isKeptClaim,
  markClaimWriter,
  recordClaimState,
  rememberedClaimState,
  useClaimState,
} from '../kubernetes/kept-claims'
import { getKubernetesResources } from '../kubernetes/container-resources'
import { ensureKubernetesSecret, getKubernetesSecretRefs, removeKubernetesSecret } from '../kubernetes/secrets'
import {
  assertJobAccounts,
  getSecretHosts,
  ensureJobCredentials,
  getJobSecretSpec,
  JobSecret,
  JobSecretSpec,
  removeJobCredentials,
  splitJobSecrets,
} from '../kubernetes/job-secrets'
import {
  getContainerSecurity,
  getPodPlacement,
  getPodRuntimeClass,
  getRunLabelValue,
} from '../kubernetes/job-placement'
import {
  ensureKubernetesItemNetwork,
  getNetworkLabels,
  KubernetesItemNetwork,
  KubernetesNetworkScope,
  releaseKubernetesItemNetwork,
  removeAllKubernetesItemNetworks,
  RUN_LABEL,
} from '../kubernetes/network-policy'
import { getRunId } from '../utils/run-id'
import { getEffectiveNetwork, isLimitedNetwork } from './work-network'
import { canUseRunner, executeInRunner } from '../kubernetes/sandbox-runner'
import { describeSecretSource, getSecretName } from './work-secret'

async function listJobNames(
  instance: ReturnType<typeof createKubernetesInstances>,
  kubernetes: WorkKubernetesEnvironment,
  task: WorkItem<ContainerWorkTask>
): Promise<string[]> {
  const jobs = await instance.batchApi.listNamespacedJob({
    namespace: kubernetes.namespace,
    labelSelector: getItemSelector(task, kubernetes),
  })
  return jobs.items.flatMap((job) => (job.metadata?.name ? [job.metadata.name] : []))
}

// The command of the task a Job runs (from 1), by the name of its container
function getJobCommand(job: V1Job): number | undefined {
  const match = /^cmd-(\d+)$/.exec(job.spec?.template.spec?.containers[0]?.name ?? '')
  return match ? Number(match[1]) : undefined
}

// what the container of a command of a task is made of, compared when a Job is taken over:
// its image, command and arguments, and the variables of the wrapper of a task that reads
// secrets in its Job, which hold the command itself (see getJobSecretSpec)
type JobCommand = Pick<V1Container, 'image' | 'command' | 'args'> & { env: V1EnvVar[] }

// Whether the container runs the command as the task would make it now
function runsCommand(container: V1Container | undefined, expected: JobCommand): boolean {
  if (!container) {
    return false
  }
  return (
    container.image === expected.image &&
    JSON.stringify(container.command ?? []) === JSON.stringify(expected.command ?? []) &&
    JSON.stringify(container.args ?? []) === JSON.stringify(expected.args ?? []) &&
    expected.env.every(
      (variable) =>
        container.env?.some((has) => has.name === variable.name && has.value === variable.value && !has.valueFrom)
    )
  )
}

// Whether the pod of a Job mounts the claim
function mountsClaim(job: V1Job, claim: string): boolean {
  return (job.spec?.template.spec?.volumes ?? []).some((volume) => volume.persistentVolumeClaim?.claimName === claim)
}

// Where the log of an item got to before a restart of the server, by instance of its container:
// an own entry of the record only, an item may be named as a property of any object
export function getResumedLogs(
  kubernetes: Pick<WorkKubernetesEnvironment, 'server'>,
  item: string
): PodLogCursor[] | undefined {
  const logs = kubernetes.server?.resumed?.logs
  const cursors = logs && Object.prototype.hasOwnProperty.call(logs, item) ? logs[item] : undefined
  return Array.isArray(cursors) ? cursors : undefined
}

function isJobFinished(job: V1Job): boolean {
  return (
    !!job.status?.succeeded ||
    !!job.status?.conditions?.some((c) => (c.type === 'Complete' || c.type === 'Failed') && c.status === 'True')
  )
}

// The Secrets the pod of a Job reads: the values the server handed over and the credentials
// of its init containers
function getJobSecretNames(job: V1Job): string[] {
  const pod = job.spec?.template.spec
  const names = new Set<string>()
  for (const volume of pod?.volumes ?? []) {
    if (volume.secret?.secretName) {
      names.add(volume.secret.secretName)
    }
  }
  for (const container of [...(pod?.initContainers ?? []), ...(pod?.containers ?? [])]) {
    for (const env of container.env ?? []) {
      if (env.valueFrom?.secretKeyRef?.name) {
        names.add(env.valueFrom.secretKeyRef.name)
      }
    }
    for (const from of container.envFrom ?? []) {
      if (from.secretRef?.name) {
        names.add(from.secretRef.name)
      }
    }
  }
  return [...names]
}

async function secretExists(instance: KubernetesInstance, namespace: string, name: string): Promise<boolean> {
  try {
    const secret = await instance.coreApi.readNamespacedSecret({ name, namespace })
    return !secret.metadata?.deletionTimestamp
  } catch (e) {
    if (statusCodeOf(e) === 404) {
      return false
    }
    throw e
  }
}

/**
 * The Job a run that resumes after a restart of the server left for the task at this state,
 * and the command it runs (from 1): the one of its deterministic name, labelled with the run
 * and the state, whose container is the one of that command (`expected`). A Job of another
 * run, state or command, or one that goes, is not the task's to take. Nor is one whose files
 * may not be what it wrote: a claim that another run wrote to since (`claim`, the marker the
 * Job's execution left on it), or the Secrets it reads that are gone while it may still need
 * them (it did not finish, or a command comes after it).
 */
async function findLeftJob(
  instance: KubernetesInstance,
  kubernetes: WorkKubernetesEnvironment,
  task: WorkItem<ContainerWorkTask>,
  options: {
    run: string
    stateKey: string
    expected: (cmd: WorkCommand) => JobCommand | undefined
    claim?: { name: string; writer: string }
  }
): Promise<{ job: V1Job; command: number } | undefined> {
  let job: V1Job
  try {
    job = await instance.batchApi.readNamespacedJob({
      name: getResourceName(task, kubernetes, '-job'),
      namespace: kubernetes.namespace,
    })
  } catch (e) {
    if (statusCodeOf(e) === 404) {
      return undefined
    }
    throw e
  }
  const labels = job.metadata?.labels ?? {}
  const command = getJobCommand(job)
  if (
    job.metadata?.deletionTimestamp ||
    labels[RUN_LABEL] !== options.run ||
    labels['hammerkit.dev/state'] !== options.stateKey ||
    command === undefined ||
    command < 1 ||
    command > task.data.cmds.length
  ) {
    return undefined
  }
  const expected = options.expected(task.data.cmds[command - 1])
  if (!expected || !runsCommand(job.spec?.template.spec?.containers[0], expected)) {
    return undefined
  }
  // a claim it does not mount holds nothing of it
  if (
    options.claim &&
    mountsClaim(job, options.claim.name) &&
    !(await isClaimWrittenBy(instance, kubernetes, options.claim.name, options.claim.writer))
  ) {
    return undefined
  }
  if (!isJobFinished(job) || command < task.data.cmds.length) {
    for (const name of getJobSecretNames(job)) {
      if (!(await secretExists(instance, kubernetes.namespace, name))) {
        return undefined
      }
    }
  }
  return { job, command }
}

// The Secret of the values the server hands over and the one of the credentials the
// pod reads its own secrets with
async function removeTaskSecrets(
  instance: KubernetesInstance,
  kubernetes: WorkKubernetesEnvironment,
  task: WorkItem<ContainerWorkTask>
): Promise<void> {
  await removeKubernetesSecret(instance, kubernetes, task)
  await removeJobCredentials(instance, kubernetes, task)
}

// The newest pod of a Job
async function getJobPod(
  instance: KubernetesInstance,
  kubernetes: WorkKubernetesEnvironment,
  job: string
): Promise<V1Pod | undefined> {
  const pods = await instance.coreApi.listNamespacedPod({
    namespace: kubernetes.namespace,
    labelSelector: `job-name=${job}`,
  })
  return pods.items
    .slice()
    .sort((a, b) =>
      (a.metadata?.creationTimestamp?.toISOString() ?? '').localeCompare(
        b.metadata?.creationTimestamp?.toISOString() ?? ''
      )
    )
    .pop()
}

// When the command of a Job ran, as its container says: what the task spent before it (the
// pod scheduled, the image pulled, the init containers) and after it is not the command's.
export async function recordJobExecution(
  instance: KubernetesInstance,
  kubernetes: WorkKubernetesEnvironment,
  task: ContainerWorkTask,
  job: string,
  container: string
): Promise<void> {
  const pod = await getJobPod(instance, kubernetes, job).catch(() => undefined)
  const status = pod?.status?.containerStatuses?.find((s) => s.name === container)
  const terminated = status?.state?.terminated ?? status?.lastState?.terminated
  if (terminated?.startedAt && terminated.finishedAt) {
    recordExecution(task, new Date(terminated.startedAt), new Date(terminated.finishedAt))
  }
}

export type JobFailure = { type: 'error'; message: string } | { type: 'crash'; exitCode: number }

// the command of a Job exited with this code, as a crash on docker or a host
class JobCrash extends Error {
  constructor(readonly exitCode: number) {
    super(`exit code ${exitCode}`)
  }
}

// Why a Job failed: the network gate, an init container that could not read a secret, which
// names the secret, never its output (which is the provider's and can hold the value), or the
// exit code of the command.
export async function describeFailedJob(
  instance: KubernetesInstance,
  kubernetes: WorkKubernetesEnvironment,
  task: string,
  job: string,
  container: string,
  secrets: JobSecret[]
): Promise<JobFailure | undefined> {
  const pod = await getJobPod(instance, kubernetes, job).catch(() => undefined)
  for (const status of pod?.status?.initContainerStatuses ?? []) {
    const terminated = status.state?.terminated ?? status.lastState?.terminated
    if (!terminated || terminated.exitCode === 0) {
      continue
    }
    if (status.name === NETWORK_GATE_CONTAINER) {
      // the gate says why in its termination message
      return {
        type: 'error',
        message: `${task}: ${terminated.message?.trim() || 'the network policy did not take hold'}`,
      }
    }
    const secret = secrets.find((s) => `secret-${s.index}` === status.name)
    if (secret) {
      return {
        type: 'error',
        message: `secret ${getSecretName(secret.secret)} (${describeSecretSource(secret.secret)}) could not be read: ${
          terminated.reason ?? 'exit code'
        } ${terminated.exitCode}`,
      }
    }
  }
  const command = pod?.status?.containerStatuses?.find((status) => status.name === container)
  const terminated = command?.state?.terminated ?? command?.lastState?.terminated
  if (terminated && terminated.exitCode !== 0) {
    return { type: 'crash', exitCode: terminated.exitCode }
  }
  return undefined
}

/**
 * The containers of the Job of a command: the network gate first, nothing runs before the
 * item's policy holds, then the init containers that read its secrets, then the command. The
 * proxy's token (`network.secretEnv`) reaches the init containers through `secretSpec` only:
 * the command's container gets the proxy variables of a limited network without it. A task that
 * adds capabilities gets them in the sandbox's RuntimeClass only.
 */
export function getTaskJobContainers(options: {
  task: WorkItem<ContainerWorkTask>
  cmd: WorkCommand
  container: string
  envs: { [key: string]: string }
  secrets: { env: V1EnvVar[]; mounts: V1VolumeMount[] }
  network: Pick<KubernetesItemNetwork, 'env' | 'initContainers'>
  secretSpec: JobSecretSpec
  mounts: V1VolumeMount[]
  kubernetes: WorkKubernetesEnvironment
}): Pick<V1PodSpec, 'initContainers' | 'containers' | 'runtimeClassName'> {
  const { task, cmd, envs, secrets, network, secretSpec, kubernetes } = options
  // the arguments after `--` keep their `$` as text, Kubernetes expands `$(NAME)`
  const command = secretSpec.command(task.data.shell, getKubernetesCommandText(cmd))
  const initContainers = [...network.initContainers, ...secretSpec.initContainers]
  return {
    ...(initContainers.length > 0 ? { initContainers } : {}),
    containers: [
      {
        image: task.data.image,
        // through the task's shell, as on Docker
        command: command.command,
        args: command.args,
        workingDir: cmd.cwd,
        env: [
          ...Object.entries(envs).map<V1EnvVar>(([key, value]) => ({ name: key, value })),
          ...secrets.env,
          ...network.env,
          ...command.env,
        ],
        name: options.container,
        volumeMounts: [...options.mounts, ...secrets.mounts, ...secretSpec.mounts],
        ...getKubernetesResources(task.data.resources),
        ...getContainerSecurity(kubernetes, task.data.capAdd),
      },
    ],
    ...getPodRuntimeClass({ name: task.name, capAdd: task.data.capAdd }, kubernetes),
  }
}

export function kubernetesTaskRuntime(
  task: WorkItem<ContainerWorkTask>,
  kubernetes: WorkKubernetesEnvironment
): WorkRuntime<TaskState> {
  const instance = createKubernetesInstances(kubernetes)
  // on a server that keeps them, the task's claim stays after the run with the state of its
  // outputs, and the next run of the same source mounts them as they are (see kept-claims)
  const kept = isKeptClaim(task, kubernetes)
  // on a service run, the claim names the last state whose folder is whole (see
  // rememberedClaimState): a wake or a move at that state mounts it without an upload
  const remembers = kept || !!kubernetes.server?.serviceRun
  const claim = getVolumeName(task, kubernetes)
  return {
    initialize(): Promise<void> {
      return Promise.resolve()
    },
    async restore(environment: Environment, path: string, stateKey?: string): Promise<void> {
      // a cache hit of a service run at the state that services of the run mount (a move whose
      // dep did not change): its outputs are there, and stay as they are while pods read them
      if (
        kubernetes.server?.serviceRun &&
        stateKey &&
        (await getStateDirsInUse(instance, kubernetes.namespace, claim)).has(getStateFilesDir(stateKey))
      ) {
        task.status.write('info', `${task.name}: services of the run use its outputs of this state, they stay`)
        await recordClaimState(instance, kubernetes, claim, stateKey)
        return
      }
      if (remembers && !kept) {
        // the folder of the state is written now: until it is whole, the claim names no state
        // (a restore without a state key says none, and the next run uploads again)
        await forgetClaimState(instance, kubernetes, claim)
        await restoreKubernetesData(task, kubernetes, instance, environment, path, {
          stateKey,
          // the folders of other states no pod of the run mounts go, as before a Job
          ...(stateKey ? { otherStates: await getStateDirsInUse(instance, kubernetes.namespace, claim) } : {}),
        })
        if (stateKey) {
          await recordClaimState(instance, kubernetes, claim, stateKey)
        }
        return
      }
      if (!kept) {
        await restoreKubernetesData(task, kubernetes, instance, environment, path, { stateKey })
        return
      }
      const reset = await forgetClaimState(instance, kubernetes, claim)
      await restoreKubernetesData(task, kubernetes, instance, environment, path, { reset, stateKey })
      if (stateKey) {
        await recordClaimState(instance, kubernetes, claim, stateKey)
      }
    },
    async archive(environment: Environment, path: string, options: ArchiveOptions = {}): Promise<ArchiveWritten[]> {
      return storeKubernetesData(task, kubernetes, instance, environment, path, options.stateKey, options.only)
    },
    async execute(environment: Environment, options: ExecuteOptions<TaskState>): Promise<void> {
      const envs = getEnvironmentVariables(task.data.envs)

      const persistence = await getKubernetesPersistence(task, kubernetes, options.stateKey)
      const workspace = getWorkspacePodSpec(kubernetes, persistence, { name: task.name, pool: task.data.pool })

      // a shell of a sandbox: its commands go into the sandbox's runner, when it has one now
      if (canUseRunner(task, kubernetes, persistence)) {
        try {
          const result = await executeInRunner(instance, task, kubernetes, persistence, options.abort)
          if (result.type === 'crash') {
            options.state.set({ stateKey: options.stateKey, type: 'crash', exitCode: result.exitCode })
            return
          }
          // stopped while the runner started: no Job for it either
          if (result.type === 'canceled' || options.abort.aborted) {
            options.state.set({ stateKey: options.stateKey, type: 'canceled' })
            return
          }
          if (result.type === 'done') {
            return
          }
        } catch (e) {
          options.state.set({ stateKey: options.stateKey, type: 'error', errorMessage: getErrorMessage(e) })
          return
        }
      }

      const server = kubernetes.server
      // the run label of its pods: on a server, the server's run; on a sandbox, its proxy
      // stays with the sandbox for the next runs
      const run = server ? getRunLabelValue(server.run) : getRunId()
      const { delivered, inJob } = splitJobSecrets(task.data.secrets, server)
      // the Job of a run and state writes to a claim other runs mount too (see WRITER_ANNOTATION)
      const writer = `${run}/${options.stateKey}`
      // a run that resumes after a restart of the server: the Job the task left goes on, from
      // the command it ran, and its files are the ones it works on
      let adopted: { job: V1Job; command: number } | undefined
      if (server?.resumed) {
        try {
          adopted = await findLeftJob(instance, kubernetes, task, {
            run,
            stateKey: options.stateKey,
            expected: (cmd) => {
              try {
                // the wrapper of the command depends on the secrets it reads, not on the
                // credentials minted for them nor the proxy (those go to init containers)
                const command = getJobSecretSpec(task, inJob, server, {}, environment).command(
                  task.data.shell,
                  getKubernetesCommandText(cmd)
                )
                // the image of the container of a Job (getTaskJobContainers)
                return { image: task.data.image, command: command.command, args: command.args, env: command.env }
              } catch (e) {
                // a Job of the task can't be made now (the Job it starts says why): none is taken over
                task.status.write('debug', `${task.name}: its job is not taken over: ${getErrorMessage(e)}`)
                return undefined
              }
            },
            ...(remembers ? { claim: { name: claim, writer } } : {}),
          })
        } catch (e) {
          options.state.set({ stateKey: options.stateKey, type: 'error', errorMessage: getErrorMessage(e) })
          return
        }
      }

      await ensureNamespace(instance, kubernetes.namespace)
      // a service run writes the outputs of each state into a folder of their own (see
      // getStateFilesDir), which pods of its services may mount: of the commit before during
      // a move, or of this state after a move that went back
      const files = kubernetes.server?.serviceRun ? { dir: getStateFilesDir(options.stateKey) } : undefined
      try {
        if (adopted) {
          task.status.write('info', `${task.name}: takes over its job from before the restart of the server`)
        } else if (files && (await getStateDirsInUse(instance, kubernetes.namespace, claim)).has(files.dir)) {
          task.status.write('info', `${task.name}: services of the run use its outputs of this state, they stay`)
          await recordClaimState(instance, kubernetes, claim, options.stateKey)
          return
        } else {
          // The last job of a run stays: its state label is what currentStateKey reads. Jobs
          // from an earlier run of this task go before this one starts, and before its files
          // change: one left is never taken over over files written since.
          for (const name of await listJobNames(instance, kubernetes, task)) {
            await deleteJobAndWait(instance, kubernetes, name, options.abort)
          }
          // the task writes to it now: what it holds stops being the outputs of a state, and
          // goes, as a new claim would hold nothing (on a service run, the folders of other
          // states that no pod mounts go)
          const forgotten = remembers && (await forgetClaimState(instance, kubernetes, claim))
          const reset = kept && forgotten
          await ensurePersistentData(instance, kubernetes, environment, task, persistence, { reset, files })
          if (remembers) {
            // the claim is there now, also on the first run of a source: the Job of this run
            // and state is the one that writes to it
            await markClaimWriter(instance, kubernetes, claim, writer)
          }
        }
      } catch (e) {
        if (e instanceof AbortError) {
          throw e
        }
        options.state.set({ stateKey: options.stateKey, type: 'error', errorMessage: getErrorMessage(e) })
        return
      }
      const secrets = getKubernetesSecretRefs(task, kubernetes, delivered)
      const admitted = environment.hosted?.accounts
      let secretHosts: string[]
      try {
        secretHosts = getSecretHosts(task, inJob, server)
        if (server) {
          assertJobAccounts(inJob, server, admitted)
        }
        // the values a Job it took over reads are in the Secret it was started with
        if (!adopted) {
          await ensureKubernetesSecret(instance, kubernetes, task, delivered, environment)
        }
      } catch (e) {
        await removeTaskSecrets(instance, kubernetes, task).catch(() => undefined)
        options.state.set({ stateKey: options.stateKey, type: 'error', errorMessage: getErrorMessage(e) })
        return
      }
      // the run its pods and limits belong to: on a server, the server's run; on a
      // sandbox, its proxy stays with the sandbox for the next runs
      const scope: KubernetesNetworkScope & { run: string } = {
        run,
        ...(server?.workspace
          ? {
              sandbox: {
                label: server.workspace.label,
                ...(server.workspace.pod ? { pod: server.workspace.pod } : {}),
              },
            }
          : {}),
      }
      const labels = {
        ...getItemLabels(task, kubernetes),
        'hammerkit.dev/state': options.stateKey,
        ...workspace.labels,
        [RUN_LABEL]: scope.run,
        ...getNetworkLabels(kubernetes, task),
      }
      const placement = server ? getPodPlacement(server, task.data.pool) : null

      // the services the task needs by the names it lists them under, and the
      // NetworkPolicy and proxy of a limited network, both of this run
      let network: KubernetesItemNetwork
      try {
        network = await ensureKubernetesItemNetwork(instance, kubernetes, task, {
          followLog: true,
          secretHosts,
          ...scope,
        })
      } catch (e) {
        await removeTaskSecrets(instance, kubernetes, task).catch(() => undefined)
        options.state.set({ stateKey: options.stateKey, type: 'error', errorMessage: getErrorMessage(e) })
        return
      }
      try {
        const podName = getResourceName(task, kubernetes, '-job')
        let i = 0
        for (const cmd of task.data.cmds) {
          const container = `cmd-${++i}`
          // the commands before the one of a Job it took over ran before the restart
          if (adopted && i < adopted.command) {
            continue
          }
          // a Job it took over keeps the pod and the credentials it was started with
          const left = adopted?.command === i ? adopted.job : undefined
          let secretSpec: JobSecretSpec | undefined
          if (!left) {
            try {
              // made for each Job right before it, so a later command's token is as fresh
              const credentials = await ensureJobCredentials(instance, kubernetes, task, inJob, admitted)
              secretSpec = getJobSecretSpec(task, inJob, server, credentials, environment, network.secretEnv)
            } catch (e) {
              await removeTaskSecrets(instance, kubernetes, task).catch(() => undefined)
              options.state.set({ stateKey: options.stateKey, type: 'error', errorMessage: getErrorMessage(e) })
              return
            }
          }
          const spec: (V1Job & KubernetesObjectHeader) | undefined = secretSpec && {
            kind: 'Job',
            apiVersion: 'batch/v1',
            metadata: {
              namespace: kubernetes.namespace,
              name: podName,
              annotations: {
                'hammerkit.dev/version': getVersion(),
              },
              labels,
            },
            spec: {
              template: {
                metadata: {
                  annotations: {
                    'hammerkit.dev/version': getVersion(),
                  },
                  labels,
                },
                spec: {
                  ...getTaskJobContainers({
                    task,
                    cmd,
                    container,
                    envs,
                    secrets,
                    network,
                    secretSpec,
                    mounts: persistence.mounts.map((m) => m.mount),
                    kubernetes,
                  }),
                  volumes: [
                    ...persistence.volumes,
                    ...persistence.workspace,
                    ...secrets.volumes,
                    ...secretSpec.volumes,
                  ],
                  ...(workspace.affinity ? { affinity: workspace.affinity } : {}),
                  hostAliases: network.hostAliases,
                  restartPolicy: 'Never',
                  // on a server the pod is the build's: no token of the namespace, and the
                  // nodes of its pool
                  ...(placement
                    ? {
                        automountServiceAccountToken: false,
                        nodeSelector: placement.nodeSelector,
                        tolerations: placement.tolerations,
                      }
                    : {}),
                },
              },
              backoffLimit: server ? 0 : 1,
              parallelism: 1,
            },
          }
          try {
            const pod = left ?? (await apply(instance, spec as V1Job & KubernetesObjectHeader))
            // what the command prints, while it prints it; the last lines once the pod ended.
            // Of a Job it took over, from where the run's log got to.
            const from = left ? getResumedLogs(kubernetes, task.name) : undefined
            const logs = followPodLogs(
              instance,
              kubernetes.namespace,
              `job-name=${podName}`,
              container,
              (line, cursor) => task.status.console('stdout', line, cursor),
              { onError: (text) => task.status.write('debug', text), ...(from ? { from } : {}) }
            )
            try {
              if (!pod.status?.succeeded) {
                try {
                  await awaitJobCompletion(instance, kubernetes, podName, options.abort, 1000, {
                    onWaiting: (text) => task.status.write('warn', `${task.name} ${text}`),
                    timeout: QUOTA_TIMEOUT,
                    onRefused: options.onQuotaRefused,
                  })
                } catch (e) {
                  if (!(e instanceof AbortError)) {
                    await logs.settle()
                    await recordJobExecution(instance, kubernetes, task.data, podName, container)
                    const failure = await describeFailedJob(instance, kubernetes, task.name, podName, container, inJob)
                    if (failure?.type === 'crash') {
                      throw new JobCrash(failure.exitCode)
                    }
                    throw new Error(failure?.message ?? getErrorMessage(e))
                  }
                  throw e
                }
              }
              await logs.settle()
            } finally {
              logs.stop()
            }
            task.status.write('debug', 'pod completed')
            await recordJobExecution(instance, kubernetes, task.data, podName, container)
            // its init containers are done with the credentials
            await removeJobCredentials(instance, kubernetes, task)
            if (i < task.data.cmds.length) {
              await deleteJobAndWait(instance, kubernetes, podName, options.abort)
            }
          } catch (e) {
            if (e instanceof AbortError) {
              // at once, so its policy can go (in finally) once the pod ended
              await stopJob(instance, kubernetes, podName).catch((e) =>
                task.status.write('error', `the job could not be stopped: ${getErrorMessage(e)}`)
              )
              await removeTaskSecrets(instance, kubernetes, task).catch(() => undefined)
              options.state.set({ stateKey: options.stateKey, type: 'canceled' })
              return
            }
            await deleteJob(instance, kubernetes, podName).catch(() => undefined)
            options.state.set(
              e instanceof JobCrash
                ? { stateKey: options.stateKey, type: 'crash', exitCode: e.exitCode }
                : { stateKey: options.stateKey, type: 'error', errorMessage: getErrorMessage(e) }
            )
            await removeTaskSecrets(instance, kubernetes, task).catch(() => undefined)
            return
          }
        }
        // the finished job stays for its state, the values it read need not
        await removeTaskSecrets(instance, kubernetes, task)
        if (remembers) {
          await recordClaimState(instance, kubernetes, claim, options.stateKey)
        }
      } finally {
        network.close()
        // once the run's pods ended: a cancelled job's pod is still terminating
        if (isLimitedNetwork(getEffectiveNetwork(task.data))) {
          await releaseKubernetesItemNetwork(instance, kubernetes, task, scope).catch((e) =>
            task.status.write('error', `remove of network policy failed ${getErrorMessage(e)}`)
          )
        }
      }
    },
    async stop(): Promise<void> {
      const jobs = await instance.batchApi.listNamespacedJob({
        namespace: kubernetes.namespace,
        labelSelector: getItemSelector(task, kubernetes),
      })
      for (const job of jobs.items) {
        if (job.metadata?.name) {
          await stopJob(instance, kubernetes, job.metadata.name)
        }
      }

      const deployments = await instance.appsApi.listNamespacedDeployment({
        namespace: kubernetes.namespace,
        labelSelector: getItemSelector(task, kubernetes),
      })
      for (const deploy of deployments.items) {
        if (deploy.metadata?.name) {
          await instance.appsApi.deleteNamespacedDeployment({
            name: deploy.metadata.name,
            namespace: kubernetes.namespace,
          })
        }
      }

      const pods = await instance.coreApi.listNamespacedPod({
        namespace: kubernetes.namespace,
        labelSelector: getItemSelector(task, kubernetes),
      })
      for (const pod of pods.items) {
        if (pod.metadata?.name) {
          await instance.coreApi.deleteNamespacedPod({ name: pod.metadata.name, namespace: kubernetes.namespace })
        }
      }
      // the limits go last, once no pod of the task runs
      await removeAllKubernetesItemNetworks(instance, kubernetes, task)
    },
    async remove(): Promise<void> {
      await this.stop()

      await removePersistentData(instance, kubernetes, task)
      await removeTaskSecrets(instance, kubernetes, task)
    },
    async currentStateKey(): Promise<string | null> {
      if (kept) {
        // the server removes the Jobs of a run at its end, the claim says
        return useClaimState(instance, kubernetes, claim)
      }
      if (remembers) {
        // a service run that sleeps loses its Jobs but keeps its claims, the claim says. One
        // that names no state is being written (or was, and that failed): the folder of the
        // state of an earlier Job may be gone. Only a task without a claim goes by its Jobs.
        const remembered = await rememberedClaimState(instance, kubernetes, claim)
        if (remembered !== undefined) {
          return remembered
        }
      }
      const jobs = await instance.batchApi.listNamespacedJob({
        namespace: kubernetes.namespace,
        labelSelector: getItemSelector(task, kubernetes),
      })
      // the Job of an earlier command that succeeded (a server stopped before it went) is not
      // the task's. A Job whose container names no command still counts: one of an older
      // version, whose state a run before the update recorded so.
      const completedStates = jobs.items
        .filter((j) => {
          const command = getJobCommand(j)
          return command === undefined || command >= task.data.cmds.length
        })
        .filter((j) => j.status?.succeeded && j.metadata?.labels?.['hammerkit.dev/state'])
        .map((j) => j.metadata!.labels!['hammerkit.dev/state'])
      const stateKey = completedStates[completedStates.length - 1] ?? null
      if (stateKey === null || !task.data.generates.some((g) => !g.inherited)) {
        return stateKey
      }
      // outputs live in the task's claim; without it the finished job left
      // nothing to reuse
      try {
        const found = await instance.coreApi.readNamespacedPersistentVolumeClaim({
          name: claim,
          namespace: kubernetes.namespace,
        })
        return found.metadata?.deletionTimestamp ? null : stateKey
      } catch (e) {
        if (statusCodeOf(e) === 404) {
          return null
        }
        throw e
      }
    },
  }
}

async function stopKubernetesService(
  instance: KubernetesInstance,
  kubernetes: WorkKubernetesEnvironment,
  service: WorkItem<ContainerWorkService>
): Promise<void> {
  const deployments = await instance.appsApi.listNamespacedDeployment({
    namespace: kubernetes.namespace,
    labelSelector: getItemSelector(service, kubernetes),
  })
  for (const deployment of deployments.items) {
    if (deployment.metadata?.name) {
      await instance.appsApi.deleteNamespacedDeployment({
        name: deployment.metadata.name,
        namespace: kubernetes.namespace,
      })
    }
  }
  await removeKubernetesSecret(instance, kubernetes, service)
  // the limits go last, once the service's pods ended
  await removeAllKubernetesItemNetworks(instance, kubernetes, service)
}

export async function removeLegacyKubernetesService(
  instance: KubernetesInstance,
  kubernetes: WorkKubernetesEnvironment,
  service: WorkItem<ContainerWorkService>
): Promise<void> {
  const legacy = getLegacyServiceItem(service)
  const deployments = await instance.appsApi.listNamespacedDeployment({
    namespace: kubernetes.namespace,
    labelSelector: getItemSelector(legacy, kubernetes),
  })
  if (deployments.items.length > 0) {
    service.status.write('info', `${service.name} was started by an earlier version of hammerkit, recreating it`)
    await stopKubernetesService(instance, kubernetes, legacy)
  }
}

export function kubernetesServiceRuntime(
  service: WorkItem<ContainerWorkService>,
  kubernetes: WorkKubernetesEnvironment
): WorkRuntime<ServiceState> {
  const instance = createKubernetesInstances(kubernetes)
  return {
    // A Deployment left by an earlier `up` is the running service, so `down`
    // stops it and a run reuses it, as with a container on Docker. One whose
    // definition changed goes, with its limits, and is created anew.
    async initialize(state: State<ServiceState>): Promise<void> {
      if (kubernetes.server?.serviceRun) {
        // a service run starts every service: one that did not change stays as it is (execute)
        return
      }
      // one an earlier version started, under the id it had then (getLegacyServiceItem); on a
      // server a run finds only objects of its own
      if (!kubernetes.server) {
        await removeLegacyKubernetesService(instance, kubernetes, service)
      }
      const deployments = await instance.appsApi.listNamespacedDeployment({
        namespace: kubernetes.namespace,
        labelSelector: getItemSelector(service, kubernetes),
      })
      const deployment = deployments.items[0]
      if (!deployment?.metadata?.name) {
        return
      }
      if (deployment.metadata.labels?.[DEFINITION_LABEL] !== getServiceDefinitionHash(service)) {
        service.status.write('info', `${service.name} changed since it was started, recreating it`)
        await this.stop()
        return
      }
      state.set({
        type: 'running',
        dns: { containerId: deployment.metadata.name },
        stateKey: deployment.metadata.labels?.['hammerkit.dev/state'] ?? '',
        remote: null,
      })
    },
    async restore(environment: Environment, path: string): Promise<void> {
      await restoreKubernetesData(service, kubernetes, instance, environment, path)
    },
    async archive(environment: Environment, path: string): Promise<ArchiveWritten[]> {
      return storeKubernetesData(service, kubernetes, instance, environment, path)
    },
    async stop(): Promise<void> {
      await stopKubernetesService(instance, kubernetes, service)
    },
    async execute(environment: Environment, options: ExecuteOptions<ServiceState>): Promise<void> {
      const name = getResourceName(service, kubernetes)
      // its output, as on Docker: while it starts, and while it runs unless it runs on
      // without hammerkit (`up --daemon`)
      const followLogs = (from?: PodLogCursor[]) =>
        followPodLogs(
          instance,
          kubernetes.namespace,
          getItemSelector(service, kubernetes),
          getServiceContainerName(service),
          (line, cursor) => service.status.console('stdout', line, cursor),
          { onError: (text) => service.status.write('debug', text), ...(from ? { from } : {}) }
        )
      const followWhileUp = (logs: PodLogFollower) => {
        if (options.daemon || options.abort.aborted || environment.abortCtrl.signal.aborted) {
          logs.stop()
          return
        }
        // either ends it, and takes the other listener with it
        const listening = new AbortController()
        const stop = () => {
          logs.stop()
          listening.abort()
        }
        options.abort.addEventListener('abort', stop, { once: true, signal: listening.signal })
        environment.abortCtrl.signal.addEventListener('abort', stop, { once: true, signal: listening.signal })
      }
      // a service run that moves to another commit, or that resumes after a restart of the
      // server: a service of the same definition and state is left running, another one is
      // rolled from the Deployment it has now
      let previous: V1Deployment | undefined
      if (kubernetes.server?.serviceRun) {
        previous = await readDeployment(instance, kubernetes.namespace, name)
        const resumed = kubernetes.server.resumed
        // after a restart, only a Deployment the run started stays (a move's are the run's anyway)
        const ours = !resumed || previous?.metadata?.labels?.[RUN_LABEL] === getRunLabelValue(kubernetes.server.run)
        if (previous && ours && isRolledOut(previous, getServiceDefinitionHash(service), options.stateKey)) {
          service.status.write('info', `${service.name} did not change, it stays up`)
          if (resumed) {
            // the execution before the restart followed its log, a move leaves that to the
            // execution it takes the services over from
            followWhileUp(followLogs(getResumedLogs(kubernetes, service.name)))
          }
          options.state.set({ type: 'running', dns: { containerId: name }, stateKey: options.stateKey, remote: null })
          return
        }
      }
      const persistence = await getKubernetesPersistence(service, kubernetes, options.stateKey)
      // the files of a service run's service go into a folder of their state, so the pod that
      // runs keeps its own until the new one is up. One that watches its files (`continuous`)
      // gets them synced into the folder its pod mounts: the pod that runs sees the changes.
      const live = isLiveService(service, kubernetes)
      // the files of the state it runs at now, to put back when the move does not get up
      const before = live ? previous?.metadata?.labels?.['hammerkit.dev/state'] : undefined
      const files = kubernetes.server?.serviceRun
        ? {
            dir: getStateFilesDir(options.stateKey),
            live,
            keep: before ? [getStateFilesDir(before)] : [],
          }
        : undefined
      if (live && previous && before) {
        const from = getStateFilesDir(before)
        serviceRollouts.add(kubernetes.namespace, name, previous, () =>
          restoreLiveFiles(instance, kubernetes, service, persistence, from)
        )
      }
      await ensureNamespace(instance, kubernetes.namespace)
      await ensureKubernetesServiceExists(instance, kubernetes, service)
      await ensurePersistentData(instance, kubernetes, environment, service, persistence, { files })
      await ensureKubernetesSecret(instance, kubernetes, service, service.data.secrets, environment)
      // on a server, the run's: its runs share the namespace, and the service goes with the run
      const network = await ensureKubernetesItemNetwork(instance, kubernetes, service, {
        followLog: false,
        run: kubernetes.server ? getRunLabelValue(kubernetes.server.run) : null,
      })
      const logs = followLogs()
      try {
        await ensureKubernetesDeploymentExists(
          instance,
          kubernetes,
          service,
          persistence,
          getKubernetesSecretRefs(service, kubernetes, service.data.secrets),
          options.stateKey,
          network,
          { previous, signal: options.abort }
        )
      } catch (e) {
        // the last words of a container that crashed, before why it failed
        await logs.settle().catch(() => undefined)
        logs.stop()
        throw e
      }
      followWhileUp(logs)

      options.state.set({
        type: 'running',
        dns: { containerId: name },
        stateKey: options.stateKey,
        remote: null,
      })

      for (const route of kubernetes.httpRoutes.filter((r) => r.service === service.name)) {
        await ensureHttpRoute(instance, kubernetes, route, service)
      }
    },
    async remove(): Promise<void> {
      // HTTPRoutes are a CRD, so they are deleted by name through the generic
      // objectApi rather than listed (a list would error on clusters without the
      // Gateway API CRDs even when none are declared). Only the routes this
      // service declares are removed; a missing route (404) is fine.
      for (const route of kubernetes.httpRoutes.filter((r) => r.service === service.name)) {
        try {
          await instance.objectApi.delete({
            apiVersion: HTTP_ROUTE_API_VERSION,
            kind: HTTP_ROUTE_KIND,
            metadata: { name: route.host, namespace: kubernetes.namespace },
          })
        } catch (e) {
          if (statusCodeOf(e) !== 404) {
            throw e
          }
        }
      }

      const services = await instance.coreApi.listNamespacedService({
        namespace: kubernetes.namespace,
        labelSelector: getItemSelector(service, kubernetes),
      })
      for (const service of services.items) {
        if (service.metadata?.name) {
          await instance.coreApi.deleteNamespacedService({
            name: service.metadata.name,
            namespace: kubernetes.namespace,
          })
        }
      }

      await this.stop()

      await removePersistentData(instance, kubernetes, service)
    },
    async currentStateKey(): Promise<string | null> {
      const deployments = await instance.appsApi.listNamespacedDeployment({
        namespace: kubernetes.namespace,
        labelSelector: getItemSelector(service, kubernetes),
      })
      const deployment = deployments.items[0]
      return deployment?.metadata?.labels?.['hammerkit.dev/state'] ?? null
    },
  }
}

async function readDeployment(
  instance: KubernetesInstance,
  namespace: string,
  name: string
): Promise<V1Deployment | undefined> {
  try {
    return await instance.appsApi.readNamespacedDeployment({ name, namespace })
  } catch (e) {
    if (statusCodeOf(e) === 404) {
      return undefined
    }
    throw e
  }
}

// A Deployment of this definition and state whose pods are all of it and ready
export function isRolledOut(deployment: V1Deployment, definition: string, stateKey: string): boolean {
  const labels = deployment.metadata?.labels ?? {}
  const status = deployment.status
  return (
    !deployment.metadata?.deletionTimestamp &&
    labels[DEFINITION_LABEL] === definition &&
    labels['hammerkit.dev/state'] === stateKey &&
    (status?.observedGeneration ?? 0) >= (deployment.metadata?.generation ?? 0) &&
    (status?.updatedReplicas ?? 0) >= 1 &&
    (status?.availableReplicas ?? 0) >= 1 &&
    (status?.replicas ?? 0) === (status?.updatedReplicas ?? 0)
  )
}

export function kubernetesForwardRuntime(service: WorkItem<KubernetesWorkService>): WorkRuntime<ServiceState> {
  return {
    async initialize(item: State<ServiceState>): Promise<void> {
      for (const port of service.data.ports) {
        if (port.hostPort === null) {
          continue
        }

        const processes = await findProcess('port', port.hostPort)
        if (!processes || processes.length === 0) {
          continue
        }

        item.set({
          type: 'error',
          errorMessage: `Host port ${port.hostPort} already in use`,
          stateKey: null,
        })
      }
    },
    async restore(): Promise<void> {},
    async archive(): Promise<ArchiveWritten[]> {
      return []
    },
    async remove(): Promise<void> {},
    async execute(_environment: Environment, options: ExecuteOptions<ServiceState>): Promise<void> {
      await kubernetesService(service, options)
    },
    currentStateKey(): Promise<string | null> {
      return Promise.resolve(null)
    },
    async stop(): Promise<void> {},
  }
}
