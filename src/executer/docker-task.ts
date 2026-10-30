import { Environment } from './environment'
import { getRunLabels } from '../docker/run-labels'
import Dockerode, { Container, ContainerCreateOptions } from 'dockerode'
import { clearContainerDirectory, convertToPosixPath, execCommand } from './execute-docker'
import { AbortError, checkForAbort } from './abort'
import { getErrorMessage } from '../log'
import { prepareMounts, prepareVolume, pullImage, refuseHostLinks, setUserPermissions } from './execution-steps'
import { usingContainer } from '../docker/using-container'
import { printContainerOptions } from './print-container-options'
import { extract } from 'tar'
import { ContainerWorkTask, WorkTaskGenerate } from '../planner/work-task'
import { WorkItem } from '../planner/work-item'
import { TaskState } from './scheduler/task-state'
import { getEnvironmentVariables } from '../environment/replace-env-variables'
import { getContainerBinds } from './get-container-binds'
import { ExecuteOptions } from '../runtime/runtime'
import {
  ContainerNetworkOptions,
  DockerItemNetwork,
  getNetworkHostConfig,
  prepareItemNetwork,
} from '../docker/item-network'
import { getWorkInstanceId } from '../planner/work-instance-id'
import { getOutputsToReset } from '../planner/utils/get-outputs-to-reset'
import { ContainerSecrets, prepareContainerSecrets, removeContainerSecrets } from './container-secrets'
import { removeContainerTaskState, writeContainerTaskState } from './container-task-state'
import { DockerResources, resolveDockerResources } from './docker-resources'

export function buildCreateOptions(
  item: WorkItem<ContainerWorkTask>,
  stateKey: string,
  network: ContainerNetworkOptions,
  environment: Environment,
  secrets: ContainerSecrets,
  resources: DockerResources = {}
): ContainerCreateOptions {
  const binds = getContainerBinds(item)
  const envs = getEnvironmentVariables(item.data.envs)
  // Running as the host's uid (Linux), the user has no home in the image and
  // Docker sets HOME=/, which isn't writable: tools then fail to create their
  // caches. Set on the container only, so it's not part of the cache key.
  const home = item.data.user && !('HOME' in envs) ? { HOME: '/tmp' } : {}

  return {
    abortSignal: environment.abortCtrl.signal,
    Image: item.data.image,
    Tty: true,
    Entrypoint: [item.data.shell],
    Cmd: ['-c', 'sleep 3600'],
    Env: Object.entries({ ...envs, ...home, ...network.env, ...secrets.env }).map(([key, value]) => `${key}=${value}`),
    WorkingDir: convertToPosixPath(item.data.cwd),
    Labels: {
      app: 'hammerkit',
      'hammerkit-id': getWorkInstanceId(item),
      ...getRunLabels(),
      'hammerkit-type': 'task',
      'hammerkit-state': stateKey,
    },
    HostConfig: {
      Binds: [
        ...binds.map((b) => `${b.localPath}:${convertToPosixPath(b.containerPath)}${b.readOnly ? ':ro' : ''}`),
        ...secrets.binds,
      ],
      ...getNetworkHostConfig(network),
      AutoRemove: true,
      ...resources,
      ...getCapabilityHostConfig(item, environment),
    },
  }
}

/**
 * The capabilities a task adds (`capAdd`). On a server they are only granted in the
 * sandboxed runtime of `backend.capabilities`, never by the kernel of the docker host.
 */
export function getCapabilityHostConfig(
  item: Pick<WorkItem<ContainerWorkTask>, 'name' | 'data'>,
  environment: Pick<Environment, 'hosted'>
): { CapAdd?: string[]; Runtime?: string } {
  const capAdd = item.data.capAdd
  if (capAdd.length === 0) {
    return {}
  }
  if (!environment.hosted) {
    return { CapAdd: capAdd }
  }
  const runtime = environment.hosted.capabilityRuntime
  if (!runtime) {
    throw new Error(
      `${item.name}: adds the capabilities ${capAdd.join(', ')}, which this server grants in no sandboxed runtime`
    )
  }
  return { CapAdd: capAdd, Runtime: runtime }
}

export async function dockerTask(
  docker: Dockerode,
  item: WorkItem<ContainerWorkTask>,
  environment: Environment,
  options: ExecuteOptions<TaskState>
): Promise<void> {
  item.status.write('info', `execute ${item.name} in container`)

  let network: DockerItemNetwork | null = null
  try {
    // A run that fails overwrites outputs, so the previous record goes first,
    // and only a run that succeeded writes a new one.
    await removeContainerTaskState(environment, item)
    const outputsToReset = getOutputsToReset(item.data)
    // outputs on the host: file outputs (bind mounts) and exported directories
    for (const generate of outputsToReset.filter((g) => g.isFile || g.export)) {
      await environment.file.remove(generate.path)
    }

    await prepareMounts(item, environment)
    checkForAbort(options.abort)

    await pullImage(item, docker, environment)
    checkForAbort(options.abort)

    await prepareVolume(item, docker, environment)
    checkForAbort(options.abort)

    network = await prepareItemNetwork(docker, item, environment, { daemon: false })
    checkForAbort(options.abort)

    const secrets = await prepareContainerSecrets(item.data.secrets, getWorkInstanceId(item), environment)
    const resources = await resolveDockerResources(docker, item.data.resources, item.status)
    const containerOptions = buildCreateOptions(
      item,
      options.stateKey,
      network.options,
      environment,
      secrets,
      resources
    )
    printContainerOptions(item.status, containerOptions)
    await refuseHostLinks(item, environment)

    const itemNetwork = network
    const succeeded = await usingContainer(docker, item, containerOptions, async (container) => {
      await itemNetwork.connect(container)
      await setUserPermissions(item, container, environment)

      for (const generate of outputsToReset.filter((g) => !g.isFile)) {
        await clearContainerDirectory(item.status, environment, container, generate.path)
      }

      for (const cmd of item.data.cmds) {
        checkForAbort(options.abort)

        item.status.write('info', `execute cmd "${cmd.cmd}" in container`)

        const result = await execCommand(
          item.status,
          environment,
          container,
          convertToPosixPath(cmd.cwd),
          [item.data.shell, '-c', cmd.cmd],
          item.data.user,
          undefined,
          options.abort
        )

        if (result.type === 'timeout') {
          throw new Error(`command ${cmd.cmd} timed out`)
        }

        if (result.type === 'canceled') {
          throw new AbortError()
        }

        if (result.result.ExitCode !== 0) {
          await refuseHostLinks(item, environment)
          await exportGenerates(
            environment,
            container,
            item.data.generates.filter((g) => g.exportAlways)
          )
          options.state.set({
            stateKey: options.stateKey,
            type: 'crash',
            exitCode: result.result.ExitCode ?? 1,
          })
          return false
        }
      }

      await refuseHostLinks(item, environment)
      await exportGenerates(
        environment,
        container,
        item.data.generates.filter((g) => g.export)
      )

      return true
    })
    if (succeeded) {
      await writeContainerTaskState(environment, item, options.stateKey)
    }
  } catch (e) {
    if (e instanceof AbortError) {
      options.state.set({
        stateKey: options.stateKey,
        type: 'canceled',
      })
    } else {
      options.state.set({
        stateKey: options.stateKey,
        type: 'error',
        errorMessage: getErrorMessage(e),
      })
    }
  } finally {
    await removeContainerSecrets(getWorkInstanceId(item))
    if (network) {
      await network.release().catch((e) => item.status.write('error', `remove of network failed ${getErrorMessage(e)}`))
    }
  }
}

// Copy exported directory outputs out of the container to the host. File
// outputs are bind mounts and inherited outputs belong to their task.
async function exportGenerates(
  environment: Environment,
  container: Container,
  generates: WorkTaskGenerate[]
): Promise<void> {
  for (const generate of generates) {
    if (generate.inherited || generate.isFile) {
      continue
    }

    const readable = await container.getArchive({
      path: generate.path,
    })
    await environment.file.createDirectory(generate.path)
    await new Promise<void>((resolve, reject) => {
      readable
        .pipe(
          extract({
            cwd: generate.path,
            newer: true,
            stripComponents: 1,
          })
        )
        .on('close', () => resolve())
        .on('error', (err) => reject(err))
    })
  }
}
