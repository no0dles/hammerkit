import { ContainerWorkNode } from '../planner/work-node'
import { Environment } from './environment'
import { Process } from './emitter'
import { HammerkitEvent, NodeCanceledEvent, NodeCompletedEvent, NodeCrashEvent, NodeErrorEvent } from './events'
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

export function dockerNode(
  node: ContainerWorkNode,
  serviceContainers: { [key: string]: string },
  environment: Environment
): Process<NodeCanceledEvent | NodeErrorEvent | NodeCrashEvent | NodeCompletedEvent, HammerkitEvent> {
  return async (abort) => {
    let container: Container | null = null

    try {
      const docker = await getDocker(node)

      const volumes = await getContainerVolumes(node)
      const mounts = await getContainerMounts(node, environment)

      checkForAbort(abort)
      await pull(node, docker, node.image)

      checkForAbort(abort)
      for (const volume of volumes) {
        await ensureVolumeExists(docker, volume.name)
      }

      const links: string[] = []
      for (const need of node.needs) {
        const container = serviceContainers[need.id]
        if (!container) {
          throw new Error(`service ${need.name} is not running`)
        }
        links.push(`${container}:${need.name}`)
      }

      const envs = replaceEnvVariables(node, environment.processEnvs)

      checkForAbort(abort)
      node.status.write('debug', `create container with image ${node.image} with ${node.shell}`)
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
        node.status.write('debug', `bind mount ${mount.localPath}:${mount.containerPath}`)
      }
      for (const volume of volumes) {
        node.status.write('debug', `volume mount ${volume.name}:${volume.containerPath}`)
      }

      node.status.write('debug', `starting container with image ${node.image}`)
      await startContainer(node, container)

      if (user) {
        await setUserPermission(node.cwd, node, docker, container, user, abort)
        for (const volume of volumes) {
          await setUserPermission(volume.containerPath, node, docker, container, user, abort)
        }
        for (const mount of mounts) {
          await setUserPermission(mount.containerPath, node, docker, container, user, abort)
        }
      }

      for (const cmd of node.cmds) {
        checkForAbort(abort)

        const command = templateValue(cmd.cmd, node.envs)
        node.status.write('info', `execute cmd ${command} in container`)

        const result = await execCommand(
          node,
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
          return {
            type: 'node-canceled',
            node,
          }
        }

        if (result.result.ExitCode !== 0) {
          return {
            type: 'node-crash',
            node: node,
            command,
            exitCode: result.result.ExitCode ?? 1,
          }
        }
      }

      await writeWorkNodeCache(node, environment)

      return {
        type: 'node-completed',
        node,
      }
    } catch (e) {
      if (e instanceof AbortError) {
        return {
          type: 'node-canceled',
          node,
        }
      } else {
        return {
          type: 'node-error',
          node,
          errorMessage: getErrorMessage(e),
        }
      }
    } finally {
      if (container) {
        try {
          await removeContainer(container)
        } catch (e) {
          node.status.write('error', `remove of container failed ${getErrorMessage(e)}`)
        }
      }
    }
  }
}
