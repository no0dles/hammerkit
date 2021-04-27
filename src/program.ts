import commaner, {Command} from 'commander';
import {existsSync, writeFileSync} from 'fs';
import {dirname} from 'path';
import consola, {LogLevel} from 'consola';
import {RunArg} from './run-arg';
import {clean} from './rewrite/5-clean';
import {nodes} from './rewrite/1-plan';
import {parse} from './rewrite/0-parse';
import {store} from './rewrite/6-store';
import {restore} from './rewrite/7-restore';
import {validate} from './rewrite/8-validate';
import {executeTask} from './rewrite/4-execute';

export function getProgram(fileName: string): commaner.Command {
  const program = new Command();

  if (existsSync(fileName)) {
    const buildFile = parse(fileName);
    const reservedCommands = ['clean', 'store', 'restore', 'validate'];

    program
      .command('clean')
      .description('clear task cache')
      .action(async () => {
        try {
          const tree = nodes(buildFile);
          await clean(tree);
        } catch (e) {
          consola.error(e);
          process.exit(1);
        }
      });

    program
      .command('store <path>')
      .description('save task outputs into <path>')
      .action(async (path) => {
        try {
          const tree = nodes(buildFile);
          await store(tree, dirname(fileName), path);
        } catch (e) {
          consola.error(e);
          process.exit(1);
        }
      });

    program
      .command('restore <path>')
      .description('restore task outputs from <path>')
      .action(async (path) => {
        try {
          const tree = nodes(buildFile);
          await restore(tree, dirname(fileName), path);
        } catch (e) {
          consola.error(e);
          process.exit(1);
        }
      });

    program
      .command('validate')
      .description('validate build.yaml')
      .action(async () => {
        const tree = nodes(buildFile);
        let errors = 0;

        for (const validation of validate(tree)) {
          let logger = consola.withTag(validation.task.name);
          if (validation.type === 'error') {
            errors++;
            logger.error(validation.message);
          } else {
            logger.warn(validation.message);
          }
        }
        if (errors === 0) {
          process.exit(0);
        } else {
          process.exit(1);
        }
      });

    const tasks = nodes(buildFile);
    for (const key of Object.keys(tasks)) {
      const task = tasks[key];
      if (reservedCommands.indexOf(task.name) >= 0) {
        consola.warn(`${task.name} is reserved, please use another name`);
        continue;
      }

      program
        .command(task.name)
        .description(task.description || '')
        .option('-v, --verbose', 'log debugging information', false)
        .option('-w, --worker <number>', 'parallel worker count', parseInt, 4)
        .option('--no-cache', 'ignore task cache', false)
        .action(async (options) => {
          const runArg: RunArg = {
            logger: consola,
            workers: options.workers,
            processEnvs: process.env,
          };

          if (options.verbose) {
            runArg.logger.level = LogLevel.Debug;
          }

          try {
            const result = await executeTask(buildFile, task.name, options.cache, runArg);
            if (!result.success) {
              for (const key of Object.keys(result.tasks)) {
                const task = result.tasks[key];
                runArg.logger.withTag(task.status).info(`${task.task.name} ${task.errorMessage}`);
              }
            }
          } catch (e) {
            runArg.logger.error(e);
            process.exit(1);
          }
        });
    }
  } else {
    program
      .command('init')
      .description('creates default build.yaml')
      .action(async () => {
        const content = `envs: {}

tasks:
  example:
    image: alpine
    cmds:
      echo "it's Hammer Time!"
      `;
        writeFileSync(fileName, content);
        consola.success(`created ${fileName}`);
      });
  }

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  program.version(require('../package.json').version);
  program.name('hammerkit');

  return program;
}
