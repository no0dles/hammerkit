import { Executor } from './executor'
import { isContainerWorkNode, WorkNode } from '../planner/work-node'
import { ExecutionContext } from './execution-context'
import { executeDocker, generateId, getVolumeName, useDocker } from './execute-docker'
import { getLocalExecutor } from './get-local-executor'
import { replaceEnvVariables } from '../environment/replace-env-variables'
import { Defer } from '../utils/defer'
import { join } from 'path'
import { Environment } from './environment'

export function getDockerExecutor(): Executor {
  const localExec = getLocalExecutor()

  return {
    async restore(node: WorkNode, environment: Environment, path: string): Promise<void> {
      await useDocker(async (docker) => {
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

          try {
            const volume = await docker.getVolume(volumeName)
            await volume.inspect()
          } catch (e) {
            await docker.createVolume({
              Name: volumeName,
              Driver: 'local',
              Labels: { app: 'hammerkit' },
            })
          }

          node.status.console.write('internal', 'info', `import data into volume ${volumeName}`)
          const res = await docker.run(
            'ubuntu',
            ['bash', '-c', `cd /data && tar xvf /import/${id}.tar --strip 1`],
            [],
            {
              HostConfig: {
                Binds: [`${volumeName}:/data`, `${sourcePath}:/import/${id}.tar`],
                AutoRemove: true,
              },
            }
          )
          if (res[0].StatusCode !== 0) {
            throw new Error(res[0].Error)
          }
        }
      })
    },
    async store(node: WorkNode, environment: Environment, path: string): Promise<void> {
      await useDocker(async (docker) => {
        for (const generate of node.generates) {
          if (generate.inherited) {
            continue
          }

          const id = generateId(generate.path)
          const volumeName = getVolumeName(generate.path)

          try {
            const volume = await docker.getVolume(volumeName)
            await volume.inspect()
          } catch (e) {
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
      })
    },
    async clean(node: WorkNode, environment: Environment): Promise<void> {
      if (!isContainerWorkNode(node)) {
        return localExec.clean(node, environment)
      }

      await useDocker(async (docker) => {
        for (const generate of node.generates) {
          if (generate.inherited) {
            continue
          }

          const volumeName = getVolumeName(generate.path)
          try {
            const volume = await docker.getVolume(volumeName)
            await volume.inspect()
            node.status.console.write('internal', 'info', `remove volume ${volumeName}`)
            await volume.remove()
          } catch (e) {
            node.status.console.write('internal', 'info', `generate ${generate} has no volume ${volumeName}`)
          }
        }
      })
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
