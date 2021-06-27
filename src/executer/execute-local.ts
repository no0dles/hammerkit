import { RunArg } from '../run-arg'
import consola from 'consola'
import { getProcessEnvs } from '../envs/process-env'
import { exec } from 'child_process'
import { getLogs } from '../log'
import { WorkNode } from '../planner/work-node'

export async function executeLocal(task: WorkNode, arg: RunArg): Promise<void> {
  consola.info(`execute ${task.name} locally`)
  const envs = getProcessEnvs(task.envs, arg)
  for (const cmd of task.cmds) {
    if (arg.cancelPromise.isResolved) {
      return
    }

    await new Promise<void>((resolve, reject) => {
      consola.info(`execute cmd ${cmd.cmd} locally`)
      const ps = exec(cmd.cmd, {
        env: envs,
        cwd: cmd.path,
      })
      ps.stdout?.on('data', (data) => {
        for (const log of getLogs(data)) {
          arg.logger.withTag(cmd.cmd).info(log)
        }
      })
      ps.stderr?.on('data', (data) => {
        for (const log of getLogs(data)) {
          arg.logger.withTag(cmd.cmd).info(log)
        }
      })
      ps.on('error', (err) => {
        arg.logger.withTag(cmd.cmd).error(err)
      })
      ps.on('close', (code) => {
        if (arg.cancelPromise.isResolved) {
          reject(new Error('canceled'))
          return
        }

        if (code !== 0 && code !== null) {
          const message = `failed with code ${code}`
          arg.logger.withTag(cmd.cmd).error(message)
          reject(new Error(message))
        } else {
          arg.logger.success(cmd.cmd)
          resolve()
        }
      })
      arg.cancelPromise.promise.then(() => {
        ps.kill()
      })
    })
  }
}
