import {ParsedBuildFile} from './parsedBuildFile';
import {BuildFileTask} from './config';
import {RunArg} from './run-arg';
import {ParsedTaskImpl} from './parsedTaskImpl';
import {exec} from 'child_process';
import {getLogs} from './log';

export class ParsedLocalTaskImpl extends ParsedTaskImpl {
  constructor(buildFile: ParsedBuildFile, name: string, task: BuildFileTask) {
    super(buildFile, name, task);
  }

  async executeTask(arg: RunArg): Promise<void> {
    const taskEnv = this.getEnvironmentVariables(arg);
    const workingDir = this.getWorkingDirectory();
    const name = this.getRelativeName();

    for (const cmd of this.getCommands(arg)) {
      if (typeof cmd === 'string') {
        await new Promise<void>((resolve, reject) => {
          const ps = exec(cmd, {
            env: taskEnv.processEnv(),
            cwd: workingDir,
          });
          ps.stdout?.on('data', data => {
            for(const log of getLogs(data)) {
              arg.logger.withTag(name).withTag(cmd).debug(log);
            }
          });
          ps.stderr?.on('data', data => {
            for(const log of getLogs(data)) {
              arg.logger.withTag(name).withTag(cmd).error(log);
            }
          });
          ps.on('error', err => {
            arg.logger.withTag(name).withTag(cmd).error(err);
          });
          ps.on('close', code => {
            if (code !== 0) {
              const message = `failed with code ${code}`;
              arg.logger.withTag(name).withTag(cmd).error(message);
              reject(new Error(message));
            } else {
              arg.logger.withTag(name).success(cmd);
              resolve();
            }
          });
        });
      } else {
        await cmd.run.execute(arg);
      }
    }
  }

}
