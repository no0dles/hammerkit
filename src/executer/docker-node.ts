import { ContainerWorkNode } from '../planner/work-node'
import { Environment } from './environment'
import { isHostServiceDns, ServiceDns } from './service-dns'
import { Container } from 'dockerode'
import {
  convertToPosixPath,
  execCommand,
  getContainerMounts,
  getContainerVolumes,
  getDocker,
  startContainer,
} from './execute-docker'
import { AbortError, checkForAbort } from './abort'
import { pull } from '../docker/pull'
import { ensureVolumeExists } from './get-docker-executor'
import { replaceEnvVariables } from '../environment/replace-env-variables'
import { platform } from 'os'
import { setUserPermission } from './set-user-permission'
import { templateValue } from '../planner/utils/template-value'
import { writeWorkNodeCache } from '../optimizer/write-work-node-cache'
import { getErrorMessage } from '../log'
import { removeContainer } from '../docker/remove-container'
import { getDuration } from './states'
import { checkIfUpToDate } from './scheduler/enqueue-next'
import { State } from './state'
import { Process } from './process'

export function dockerNode(
  node: ContainerWorkNode,
  serviceContainers: { [key: string]: ServiceDns },
  state: State,
  environment: Environment
): Process {
  return async (abort, started) => {
    // TODO check how it behaves on noContainer override
    const isUpToDate = await checkIfUpToDate(node, state.current.cacheMethod, environment)
    if (isUpToDate) {
      state.patchNode({
        type: 'completed',
        node: node,
        cached: true,
        duration: getDuration(started),
      })
      return
    }

    const status = environment.status.task(node)

    let container: Container | null = null

    try {
      const docker = await getDocker(status)

      const volumes = await getContainerVolumes(node)
      const mounts = await getContainerMounts(node, environment)

      checkForAbort(abort)
      await pull(status, docker, node.image)

      checkForAbort(abort)
      for (const volume of volumes) {
        await ensureVolumeExists(docker, volume.name)
      }

      const links: string[] = []
      const hosts: string[] = []

      for (const need of node.needs) {
        const dns = serviceContainers[need.id]
        if (isHostServiceDns(dns)) {
          hosts.push(`${need.name}:${dns.host}`)
          status.write('debug', `extra host ${need.name}:${dns.host}`)
        } else {
          if (!dns.containerId) {
            throw new Error(`service ${need.name} is not running`)
          }

          links.push(`${dns.containerId}:${need.name}`)
          status.write('debug', `link container ${dns.containerId}:${need.name}`)
        }
      }

      const envs = replaceEnvVariables(node, status, environment.processEnvs)

      checkForAbort(abort)
      status.write('debug', `create container with image ${node.image} with ${node.shell}`)
      container = await docker.createContainer({
        Image: node.image,
        Tty: true,
        Entrypoint: node.shell,
        Cmd: ['-c', 'sleep 3600'],
        Env: Object.keys(envs).map((k) => `${k}=${envs[k]}`),
        WorkingDir: convertToPosixPath(node.cwd),
        Labels: { app: 'hammerkit', 'hammerkit-id': node.id, 'hammerkit-type': 'task' },
        HostConfig: {
          Binds: [
            ...mounts.map((v) => `${v.localPath}:${convertToPosixPath(v.containerPath)}`),
            ...volumes.map((v) => `${v.name}:${convertToPosixPath(v.containerPath)}`),
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
      })

      const user =
        platform() === 'linux' || platform() === 'freebsd' || platform() === 'openbsd' || platform() === 'sunos'
          ? `${process.getuid()}:${process.getgid()}`
          : undefined

      for (const mount of mounts) {
        status.write('debug', `bind mount ${mount.localPath}:${mount.containerPath}`)
      }
      for (const volume of volumes) {
        status.write('debug', `volume mount ${volume.name}:${volume.containerPath}`)
      }

      status.write('debug', `starting container with image ${node.image}`)
      await startContainer(status, container)

      if (user) {
        await setUserPermission(node.cwd, status, docker, container, user, abort)
        for (const volume of volumes) {
          await setUserPermission(volume.containerPath, status, docker, container, user, abort)
        }
        for (const mount of mounts) {
          await setUserPermission(mount.containerPath, status, docker, container, user, abort)
        }
      }

      for (const cmd of node.cmds) {
        checkForAbort(abort)

        const command = templateValue(cmd.cmd, node.envs)
        status.write('info', `execute cmd "${command}" in container`)

        const result = await execCommand(
          status,
          docker,
          container,
          convertToPosixPath(cmd.path),
          [node.shell, '-c', command],
          user,
          undefined,
          abort
        )

        if (result.type === 'timeout') {
          throw new Error(`command ${command} timed out`)
        }

        if (result.type === 'canceled') {
          throw new AbortError()
        }

        if (result.result.ExitCode !== 0) {
          state.patchNode({
            node,
            type: 'crash',
            //command,
            exitCode: result.result.ExitCode ?? 1,
          })
          return
        }
      }

      await writeWorkNodeCache(node, state.current.cacheMethod, environment)

      state.patchNode({
        node,
        type: 'completed',
        cached: false,
        duration: getDuration(started),
      })
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
    } finally {
      if (container) {
        try {
          await removeContainer(container)
        } catch (e) {
          status.write('error', `remove of container failed ${getErrorMessage(e)}`)
        }
      }
    }
  }
}
