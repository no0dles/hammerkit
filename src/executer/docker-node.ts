import { ContainerWorkNode } from '../planner/work-node'
import { Environment } from './environment'
import { isHostServiceDns, ServiceDns } from './service-dns'
import { ContainerCreateOptions } from 'dockerode'
import { convertToPosixPath, execCommand } from './execute-docker'
import { AbortError, checkForAbort } from './abort'
import { replaceEnvVariables } from '../environment/replace-env-variables'
import { writeWorkNodeCache } from '../optimizer/write-work-node-cache'
import { getErrorMessage } from '../log'
import { getDuration } from './states'
import { State } from './state'
import { Process } from './process'
import { startNode } from './start-node'
import { prepareMounts, prepareVolume, pullImage, setUserPermissions } from './execution-steps'
import { usingContainer } from '../docker/using-container'
import { printContainerOptions } from './print-container-options'

function buildCreateOptions(
  node: ContainerWorkNode,
  serviceContainers: { [key: string]: ServiceDns },
  environment: Environment
): ContainerCreateOptions {
  const links: string[] = []
  const hosts: string[] = []

  for (const need of node.needs) {
    const dns = serviceContainers[need.id]
    if (isHostServiceDns(dns)) {
      hosts.push(`${need.name}:${dns.host}`)
    } else {
      if (!dns.containerId) {
        throw new Error(`service ${need.name} is not running`)
      }

      links.push(`${dns.containerId}:${need.name}`)
    }
  }

  const envs = replaceEnvVariables(node, environment.processEnvs)
  return {
    Image: node.image,
    Tty: true,
    Entrypoint: node.shell,
    Cmd: ['-c', 'sleep 3600'],
    Env: Object.keys(envs).map((k) => `${k}=${envs[k]}`),
    WorkingDir: convertToPosixPath(node.cwd),
    Labels: { app: 'hammerkit', 'hammerkit-id': node.id, 'hammerkit-type': 'task' },
    HostConfig: {
      Binds: [
        ...node.mounts.map((v) => `${v.localPath}:${convertToPosixPath(v.containerPath)}`),
        ...node.volumes.map((v) => `${v.name}:${convertToPosixPath(v.containerPath)}`),
      ],
      PortBindings: node.ports.reduce<{ [key: string]: { HostPort: string }[] }>((map, port) => {
        map[`${port.containerPort}/tcp`] = [{ HostPort: `${port.hostPort}` }]
        return map
      }, {}),
      ExtraHosts: hosts,
      Links: links,
      AutoRemove: true,
    },
    ExposedPorts: node.ports.reduce<{ [key: string]: Record<string, unknown> }>((map, port) => {
      map[`${port.containerPort}/tcp`] = {}
      return map
    }, {}),
  }
}

export function dockerNode(
  node: ContainerWorkNode,
  serviceContainers: { [key: string]: ServiceDns },
  state: State,
  environment: Environment
): Process {
  return async (abort, started) => {
    const status = environment.status.task(node)
    status.write('info', `execute ${node.name} in container`)

    await prepareMounts(node, environment)
    checkForAbort(abort.signal)

    await pullImage(node, environment)
    checkForAbort(abort.signal)

    await prepareVolume(node, environment)
    checkForAbort(abort.signal)

    if (await startNode(node, started, state, abort, environment)) {
      return
    }

    try {
      const containerOptions = buildCreateOptions(node, serviceContainers, environment)
      printContainerOptions(status, containerOptions)

      const success = await usingContainer(environment, node, containerOptions, async (container) => {
        await setUserPermissions(node, container, environment)

        for (const cmd of node.cmds) {
          checkForAbort(abort.signal)

          status.write('info', `execute cmd "${cmd.cmd}" in container`)

          const result = await execCommand(
            status,
            environment,
            container,
            convertToPosixPath(cmd.path),
            [node.shell, '-c', cmd.cmd],
            node.user,
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
            state.patchNode({
              node,
              type: 'crash',
              exitCode: result.result.ExitCode ?? 1,
            })
            return false
          }
        }

        return true
      })

      if (success) {
        await writeWorkNodeCache(node, environment)

        state.patchNode({
          node,
          type: 'completed',
          cached: false,
          duration: getDuration(started),
        })
      }
    } catch (e) {
      if (e instanceof AbortError) {
        state.patchNode({
          node,
          type: 'canceled',
        })
      } else {
        state.patchNode({
          node,
          type: 'error',
          errorMessage: getErrorMessage(e),
        })
      }
    }
  }
}
