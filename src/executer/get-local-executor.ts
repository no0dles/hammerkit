import { Executor } from './executor'
import { isContainerWorkNode, WorkNode } from '../planner/work-node'
import { ExecutionContext } from './execution-context'
import { executeLocal } from './execute-local'
import { replaceEnvVariables } from '../environment/replace-env-variables'
import { Environment } from './environment'
import { moveFiles } from '../file/move-files'
import { join, relative } from 'path'

export function getLocalExecutor(): Executor {
  return {
    async restore(node: WorkNode, environment: Environment, path: string): Promise<void> {
      await moveFiles(node, environment, function* () {
        for (const targetPath of node.generates) {
          if (targetPath.inherited) {
            continue
          }

          const sourcePath = join(path, relative(node.buildFile.path, targetPath.path))
          yield { from: sourcePath, to: targetPath.path }
        }
      })
    },
    async store(node: WorkNode, environment: Environment, targetDirectory: string): Promise<void> {
      await moveFiles(node, environment, function* () {
        for (const sourcePath of node.generates) {
          if (sourcePath.inherited) {
            continue
          }
          const relativePath = relative(node.buildFile.path, sourcePath.path)
          const targetPath = join(targetDirectory, relativePath)
          yield { from: sourcePath.path, to: targetPath }
        }
      })
    },
    async clean(node: WorkNode, environment: Environment): Promise<void> {
      for (const generate of node.generates) {
        if (generate.inherited) {
          continue
        }
        node.status.console.write('internal', 'info', `remove local directory ${generate.path}`)
        await environment.file.remove(generate.path)
      }
    },
    async exec(node: WorkNode, context: ExecutionContext, cancelDefer: AbortController): Promise<void> {
      const envs = replaceEnvVariables(node, context.environment.processEnvs)
      if (isContainerWorkNode(node)) {
        node.status.console.write('internal', 'debug', `${node.name} is executed locally instead inside of a container`)
      }

      await executeLocal(
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
