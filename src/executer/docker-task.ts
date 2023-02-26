import { Environment } from './environment'
import { isHostServiceDns, ServiceDns } from './service-dns'
import { ContainerCreateOptions } from 'dockerode'
import { convertToPosixPath, execCommand } from './execute-docker'
import { AbortError, checkForAbort } from './abort'
import { getErrorMessage } from '../log'
import { prepareMounts, prepareVolume, pullImage, setUserPermissions } from './execution-steps'
import { usingContainer } from '../docker/using-container'
import { printContainerOptions } from './print-container-options'
import { extract } from 'tar'
import { ContainerWorkTask } from '../planner/work-task'
import { WorkItem, WorkItemNeed, WorkItemState } from '../planner/work-item'
import { TaskState } from './scheduler/task-state'
import { getEnvironmentVariables } from '../environment/replace-env-variables'
import { getContainerBinds } from './get-container-binds'

export function getNeedsNetwork(serviceContainers: { [key: string]: ServiceDns }, needs: WorkItemNeed[]) {
  const links: string[] = []
  const hosts: string[] = []

  for (const need of needs) {
    const dns = serviceContainers[need.name]
    if (isHostServiceDns(dns)) {
      hosts.push(`${need.name}:${dns.host}`)
    } else {
      if (!dns.containerId) {
        throw new Error(`service ${need.name} is not running`)
      }

      links.push(`${dns.containerId}:${need.name}`)
    }
  }
  return { links, hosts }
}

function buildCreateOptions(
  item: WorkItem<ContainerWorkTask>,
  stateKey: string,
  serviceContainers: { [key: string]: ServiceDns }
): ContainerCreateOptions {
  const network = getNeedsNetwork(serviceContainers, item.needs)
  const binds = getContainerBinds(item)
  const envs = getEnvironmentVariables(item.data.envs)

  return {
    Image: item.data.image,
    Tty: true,
    Entrypoint: item.data.shell,
    Cmd: ['-c', 'sleep 3600'],
    Env: Object.entries(envs).map(([key, value]) => `${key}=${value}`),
    WorkingDir: convertToPosixPath(item.data.cwd),
    Labels: {
      app: 'hammerkit',
      'hammerkit-id': item.cacheId(),
      'hammerkit-pid': process.pid.toString(),
      'hammerkit-type': 'task',
      'hammerkit-state': stateKey,
    },
    HostConfig: {
      Binds: binds.map((b) => `${b.localPath}:${convertToPosixPath(b.containerPath)}`),
      ExtraHosts: network.hosts,
      Links: network.links,
      AutoRemove: true,
    },
  }
}

export async function dockerTask(
  item: WorkItemState<ContainerWorkTask, TaskState>,
  stateKey: string,
  serviceContainers: { [key: string]: ServiceDns },
  environment: Environment,
  abort: AbortSignal
): Promise<void> {
  item.status.write('info', `execute ${item.name} in container`)

  try {
    await prepareMounts(item, environment)
    checkForAbort(abort)

    await pullImage(item, environment)
    checkForAbort(abort)

    await prepareVolume(item, environment)
    checkForAbort(abort)

    const containerOptions = buildCreateOptions(item, stateKey, serviceContainers)
    printContainerOptions(item.status, containerOptions)

    await usingContainer(environment, item, containerOptions, async (container) => {
      await setUserPermissions(item, container, environment)

      for (const cmd of item.data.cmds) {
        checkForAbort(abort)

        item.status.write('info', `execute cmd "${cmd.cmd}" in container`)

        const result = await execCommand(
          item.status,
          environment,
          container,
          convertToPosixPath(cmd.cwd),
          [item.data.shell, '-c', cmd.cmd],
          item.data.user,
          undefined,
          abort
        )

        if (result.type === 'timeout') {
          throw new Error(`command ${cmd.cmd} timed out`)
        }

        if (result.type === 'canceled') {
          throw new AbortError()
        }

        if (result.result.ExitCode !== 0) {
          item.state.set({
            stateKey,
            type: 'crash',
            exitCode: result.result.ExitCode ?? 1,
          })
          return false
        }
      }

      for (const generate of item.data.generates) {
        if (!generate.export || generate.inherited || generate.isFile) {
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

      return true
    })
  } catch (e) {
    if (e instanceof AbortError) {
      item.state.set({
        stateKey,
        type: 'canceled',
      })
    } else {
      item.state.set({
        stateKey,
        type: 'error',
        errorMessage: getErrorMessage(e),
      })
    }
  }
}
