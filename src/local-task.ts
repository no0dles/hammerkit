import { RunArg } from './run-arg'
import { Task } from './task'
import { exec } from 'child_process'
import { getLogs } from './log'
import { TaskConfig } from './config/task-config'
import { BuildFile } from './build-file'
import { EnvMap } from './env'
import { join } from 'path'
import { isTaskCommandConfigCmd } from './task-command'
import { TaskGeneration } from './cache/task-generation'

export class LocalTask extends Task {
  constructor(buildFile: BuildFile, name: string, task: TaskConfig) {
    super(buildFile, name, task)
  }

  get taskConfigKeys(): string[] {
    return ['description', 'cmds', 'deps', 'src', 'generates', 'envs']
  }

  get taskCacheValues(): any[] {
    return [this.task.cmds, this.task.envs]
  }

  executeCommand(cmd: string, arg: RunArg, workingDir: string, taskEnv: EnvMap): Promise<void> {
    const name = this.getAbsoluteName()
    arg.logger.withTag(name).info(cmd)

    return new Promise<void>((resolve, reject) => {
      const ps = exec(cmd, {
        env: taskEnv.processEnv(),
        cwd: workingDir,
      })
      ps.stdout?.on('data', (data) => {
        for (const log of getLogs(data)) {
          arg.logger.withTag(name).withTag(cmd).info(log)
        }
      })
      ps.stderr?.on('data', (data) => {
        for (const log of getLogs(data)) {
          arg.logger.withTag(name).withTag(cmd).info(log)
        }
      })
      ps.on('error', (err) => {
        arg.logger.withTag(name).withTag(cmd).error(err)
      })
      ps.on('close', (code) => {
        if (code !== 0) {
          const message = `failed with code ${code}`
          arg.logger.withTag(name).withTag(cmd).error(message)
          reject(new Error(message))
        } else {
          arg.logger.withTag(name).success(cmd)
          resolve()
        }
      })
    })
  }

  async executeTask(arg: RunArg, generation: TaskGeneration[]): Promise<void> {
    const taskEnv = this.getEnvironmentVariables(arg)
    const workingDir = this.getWorkingDirectory()

    for (const cmd of this.getCommands(arg)) {
      if (typeof cmd === 'string') {
        await this.executeCommand(cmd, arg, workingDir, taskEnv)
      } else if (isTaskCommandConfigCmd(cmd)) {
        await this.executeCommand(cmd.cmd, arg, join(workingDir, cmd.path || ''), taskEnv)
      } else {
        await cmd.task.execute(arg, generation)
      }
    }
  }
}
