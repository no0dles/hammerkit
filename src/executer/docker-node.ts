import { Environment } from './environment'
import { isHostServiceDns, ServiceDns } from './service-dns'
import { ContainerCreateOptions } from 'dockerode'
import { convertToPosixPath, execCommand } from './execute-docker'
import { AbortError, checkForAbort } from './abort'
import { writeWorkNodeCache } from '../optimizer/write-work-node-cache'
import { getErrorMessage } from '../log'
import { getDuration } from './states'
import { State } from './state'
import { Process } from './process'
import { prepareMounts, prepareVolume, pullImage, setUserPermissions } from './execution-steps'
import { usingContainer } from '../docker/using-container'
import { printContainerOptions } from './print-container-options'
import { extract } from 'tar'
import { ContainerWorkNode } from '../planner/work-node'
import { WorkItem, WorkItemNeed } from '../planner/work-item'

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
  item: WorkItem<ContainerWorkNode>,
  stateKey: string,
  serviceContainers: { [key: string]: ServiceDns }
): ContainerCreateOptions {
  const network = getNeedsNetwork(serviceContainers, item.needs)
  const binds = getContainerBinds(item)

  return {
    Image: item.data.image,
    Tty: true,
    Entrypoint: item.data.shell,
    Cmd: ['-c', 'sleep 3600'],
    Env: Object.keys(item.data.envs).map((k) => `${k}=${item.data.envs[k]}`),
    WorkingDir: convertToPosixPath(item.data.cwd),
    Labels: {
      app: 'hammerkit',
      'hammerkit-id': item.id,
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

interface ContainerBind {
  localPath: string
  containerPath: string
}
function getContainerBinds(item: WorkItem<ContainerWorkNode>): ContainerBind[] {
  const items: ContainerBind[] = [
    ...item.data.mounts,
    ...item.data.volumes.map((v) => ({ localPath: v.name, containerPath: v.containerPath })),
    ...item.data.src.map((s) => ({ localPath: s.absolutePath, containerPath: s.absolutePath })),
    ...item.data.generates.filter((g) => !g.isFile).map((v) => ({ localPath: v.volumeName, containerPath: v.path })),
  ]
  return items.reduce<ContainerBind[]>((array, item) => {
    if (array.findIndex((i) => i.containerPath === item.containerPath) === -1) {
      array.push(item)
    }
    return array
  }, [])
}

export function dockerNode(
  item: WorkItem<ContainerWorkNode>,
  stateKey: string,
  serviceContainers: { [key: string]: ServiceDns },
  state: State,
  environment: Environment
): Process {
  return async (abort, started) => {
    item.status.write('info', `execute ${item.name} in container`)

    try {
      await prepareMounts(item, environment)
      checkForAbort(abort.signal)

      await pullImage(item, environment)
      checkForAbort(abort.signal)

      await prepareVolume(item, environment)
      checkForAbort(abort.signal)

      const containerOptions = buildCreateOptions(item, stateKey, serviceContainers)
      printContainerOptions(item.status, containerOptions)

      const success = await usingContainer(environment, item, containerOptions, async (container) => {
        await setUserPermissions(item, container, environment)

        for (const cmd of item.data.cmds) {
          checkForAbort(abort.signal)

          item.status.write('info', `execute cmd "${cmd.cmd}" in container`)

          const result = await execCommand(
            item.status,
            environment,
            container,
            convertToPosixPath(cmd.cwd),
            [item.data.shell, '-c', cmd.cmd],
            item.data.user,
            undefined,
            abort.signal
          )

          if (result.type === 'timeout') {
            throw new Error(`command ${cmd.cmd} timed out`)
          }

          if (result.type === 'canceled') {
            throw new AbortError()
          }

          if (result.result.ExitCode !== 0) {
            state.patchNode(
              {
                node: item,
                stateKey,
                type: 'crash',
                exitCode: result.result.ExitCode ?? 1,
                itemId: item.id,
              },
              stateKey
            )
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

      if (success) {
        await writeWorkNodeCache(item, environment)

        state.patchNode(
          {
            node: item,
            stateKey,
            type: 'completed',
            cached: false,
            duration: getDuration(started),
            itemId: item.id,
          },
          stateKey
        )
      }
    } catch (e) {
      if (e instanceof AbortError) {
        state.patchNode(
          {
            node: item,
            stateKey,
            type: 'canceled',
            itemId: item.id,
          },
          stateKey
        )
      } else {
        state.patchNode(
          {
            node: item,
            stateKey,
            type: 'error',
            errorMessage: getErrorMessage(e),
            itemId: item.id,
          },
          stateKey
        )
      }
    }
  }
}
