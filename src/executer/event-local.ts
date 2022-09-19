import { EventBus } from './event-bus'
import { NodePruneStateEvent, NodeRestoreStateEvent, NodeStoreStateEvent, SchedulerStartLocalNodeEvent } from './events'
import { getProcessEnvs } from '../environment/get-process-env'
import { templateValue } from '../planner/utils/template-value'
import { exec } from 'child_process'
import { platform } from 'os'
import { getErrorMessage, getLogs } from '../log'
import { listenOnAbort } from '../utils/abort-event'
import { AbortError, checkForAbort } from './abort'
import { Environment } from './environment'
import { moveFiles } from '../file/move-files'
import { join, relative } from 'path'
import { WorkNode } from '../planner/work-node'
import { replaceEnvVariables } from '../environment/replace-env-variables'

export function attachLocalExecutor(eventBus: EventBus, environment: Environment): void {
  eventBus.on<NodePruneStateEvent>('node-prune-state', async (evt) => {
    for (const generate of evt.node.generates) {
      if (generate.inherited) {
        continue
      }
      evt.node.status.write('info', `remove local directory ${generate.path}`)
      await environment.file.remove(generate.path)
    }
  })
  eventBus.on<NodeStoreStateEvent>('node-store-state', async (evt) => {
    await moveFiles(evt.node, environment, function* () {
      for (const sourcePath of evt.node.generates) {
        if (sourcePath.inherited) {
          continue
        }
        const relativePath = relative(evt.node.buildFile.path, sourcePath.path)
        const targetPath = join(evt.path, relativePath)
        yield { from: sourcePath.path, to: targetPath }
      }
    })
  })
  eventBus.on<NodeRestoreStateEvent>('node-restore-state', async (evt) => {
    await moveFiles(evt.node, environment, function* () {
      for (const targetPath of evt.node.generates) {
        if (targetPath.inherited) {
          continue
        }

        const sourcePath = join(evt.path, relative(evt.node.buildFile.path, targetPath.path))
        yield { from: sourcePath, to: targetPath.path }
      }
    })
  })
  eventBus.on<SchedulerStartLocalNodeEvent>('scheduler-start-local-node', async (evt) => {
    evt.node.status.write('info', `execute ${evt.node.name} locally`)

    try {
      const envs = getProcessEnvs(replaceEnvVariables(evt.node, environment.processEnvs), environment)
      for (const cmd of evt.node.cmds) {
        checkForAbort(evt.abortSignal)

        const command = templateValue(cmd.cmd, envs)
        evt.node.status.write('info', `execute cmd ${command} locally`)

        const exitCode = await executeCommand(evt.node, eventBus, evt.abortSignal, cmd.path, command, envs)
        if (exitCode !== 0) {
          await eventBus.emit({
            type: 'node-crash',
            node: evt.node,
            exitCode,
            command,
          })
          return
        }
      }
      await eventBus.emit({
        type: 'node-completed',
        node: evt.node,
      })
    } catch (e) {
      if (e instanceof AbortError) {
        await eventBus.emit({
          type: 'node-canceled',
          node: evt.node,
        })
      } else {
        await eventBus.emit({
          type: 'node-error',
          node: evt.node,
          errorMessage: getErrorMessage(e),
        })
      }
    }
  })
}

async function executeCommand(
  node: WorkNode,
  eventBus: EventBus,
  abortSignal: AbortSignal,
  cwd: string,
  command: string,
  envs: { [key: string]: string }
): Promise<number> {
  await eventBus.emit({
    type: 'node-start',
    node: node,
  })

  return new Promise<number>((resolve, reject) => {
    const ps = exec(command, {
      env: envs,
      cwd,
      shell: platform() === 'win32' ? 'powershell.exe' : undefined,
    })
    ps.stdout?.on('data', async (data) => {
      for (const log of getLogs(data)) {
        node.console.write('stdout', log)
      }
    })
    ps.stderr?.on('data', async (data) => {
      for (const log of getLogs(data)) {
        node.console.write('stderr', log)
      }
    })
    ps.on('error', (err) => {
      reject(err)
    })
    ps.on('close', (code) => {
      if (abortSignal.aborted) {
        reject(new AbortError())
        return
      }

      resolve(code ?? 0)
    })

    listenOnAbort(abortSignal, () => {
      ps.kill()
    })
  })
}
