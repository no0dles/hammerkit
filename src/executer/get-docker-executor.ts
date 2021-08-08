import { Executor } from './executor'
import { isContainerWorkNode, WorkNode } from '../planner/work-node'
import { ExecutionContext } from './execution-context'
import { executeDocker, generateId, getDocker, getVolumeName } from './execute-docker'
import { getLocalExecutor } from './get-local-executor'
import { replaceEnvVariables } from '../environment/replace-env-variables'
import { Defer } from '../utils/defer'
import { join } from 'path'
import { Environment } from './environment'
import Dockerode, { VolumeInspectInfo } from 'dockerode'

export async function existsVolume(docker: Dockerode, volumeName: string): Promise<VolumeInspectInfo | false> {
  try {
    const volume = await docker.getVolume(volumeName)
    return await volume.inspect()
  } catch (e) {
    return false
  }
}

export async function ensureVolumeExists(docker: Dockerode, volumeName: string): Promise<void> {
  const volumeExists = await existsVolume(docker, volumeName)
  if (!volumeExists) {
    await docker.createVolume({
      Name: volumeName,
      Driver: 'local',
      Labels: { app: 'hammerkit' },
    })
  }
}

export function getDockerExecutor(): Executor {
  const localExec = getLocalExecutor()

  return {
    async restore(node: WorkNode, environment: Environment, path: string): Promise<void> {
      const docker = getDocker()
      for (const generate of node.generates) {
        if (generate.inherited) {
          continue
        }

        const id = generateId(generate.path)
        const volumeName = getVolumeName(generate.path)

        const sourcePath = join(path, 'generates', `${id}.tar`)
        if (!(await environment.file.exists(sourcePath))) {
          continue
        }

        await ensureVolumeExists(docker, volumeName)

        node.status.console.write('internal', 'info', `import data into volume ${volumeName}`)
        const res = await docker.run('ubuntu', ['bash', '-c', `cd /data && tar xvf /import/${id}.tar --strip 1`], [], {
          HostConfig: {
            Binds: [`${volumeName}:/data`, `${sourcePath}:/import/${id}.tar`],
            AutoRemove: true,
          },
        })
        if (res[0].StatusCode !== 0) {
          throw new Error(res[0].Error)
        }
      }
    },
    async store(node: WorkNode, environment: Environment, path: string): Promise<void> {
      const docker = getDocker()
      for (const generate of node.generates) {
        if (generate.inherited) {
          continue
        }

        const id = generateId(generate.path)
        const volumeName = getVolumeName(generate.path)

        const volumeExists = await existsVolume(docker, volumeName)
        if (!volumeExists) {
          node.status.console.write('internal', 'info', `generate ${generate} has no volume ${volumeName}`)
          continue
        }

        const targetPath = join(path, 'generates')
        await environment.file.createDirectory(targetPath)
        node.status.console.write('internal', 'info', `export data from volume ${volumeName}`)
        const res = await docker.run('ubuntu', ['tar', 'cvf', `/export/${id}.tar`, '/data'], [], {
          HostConfig: {
            Binds: [`${volumeName}:/data`, `${targetPath}:/export`],
            AutoRemove: true,
          },
        })
        if (res[0].StatusCode !== 0) {
          throw new Error(res[0].Error)
        }
      }
    },
    async clean(node: WorkNode, environment: Environment): Promise<void> {
      if (!isContainerWorkNode(node)) {
        return localExec.clean(node, environment)
      }

      const docker = getDocker()
      for (const generate of node.generates) {
        if (generate.inherited) {
          continue
        }

        const volumeName = getVolumeName(generate.path)
        const volumeExists = await existsVolume(docker, volumeName)
        if (volumeExists) {
          node.status.console.write('internal', 'info', `remove volume ${volumeName}`)
          const volume = await docker.getVolume(volumeName)
          await volume.remove()
        } else {
          node.status.console.write('internal', 'info', `generate ${generate} has no volume ${volumeName}`)
        }
      }
    },
    async exec(node: WorkNode, context: ExecutionContext, cancelDefer: Defer<void>): Promise<void> {
      if (!isContainerWorkNode(node)) {
        return localExec.exec(node, context, cancelDefer)
      }

      const envs = replaceEnvVariables(node, context.environment.processEnvs)
      await executeDocker(
        {
          ...node,
          envs,
        },
        context,
        cancelDefer
      )
    },
  }
}
