import {TaskNode} from './1-plan';
import {exec} from 'child_process';
import {getLogs} from '../log';
import {RunArg} from '../run-arg';

function getProcessEnvs(task: TaskNode, arg: RunArg) {
  const envs = { ...task.envs }
  for (const key of Object.keys(arg.processEnvs)) {
    const value = arg.processEnvs[key]
    if (!envs[key] && value) {
      envs[key] = value
    }
  }
  return envs
}

export async function runLocally(task: TaskNode, arg: RunArg): Promise<void> {
  const envs = getProcessEnvs(task, arg)
  for (const cmd of task.cmds) {
    await new Promise<void>((resolve, reject) => {
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
        if (code !== 0) {
          const message = `failed with code ${code}`
          arg.logger.withTag(cmd.cmd).error(message)
          reject(new Error(message))
        } else {
          arg.logger.success(cmd.cmd)
          resolve()
        }
      })
    })
  }
}
