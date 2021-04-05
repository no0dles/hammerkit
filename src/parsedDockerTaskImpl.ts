import {ParsedBuildFile} from './parsedBuildFile';
import {DockerBuildFileTask} from './config';
import {RunArg} from './run-arg';
import {join} from 'path';
import {existsSync} from 'fs';
import {ParsedTaskImpl} from './parsedTaskImpl';
import {Duplex, Writable} from 'stream';
import {getLogs} from './log';

export class ParsedDockerTaskImpl extends ParsedTaskImpl {
  constructor(buildFile: ParsedBuildFile, name: string, private dockerTask: DockerBuildFileTask) {
    super(buildFile, name, dockerTask);
  }

  async pull(imageName: string, runArg: RunArg) {
    const images = await runArg.docker.listImages({});
    if (images.some((i) => i.RepoTags?.some((repoTag) => repoTag === imageName))) {
      return;
    }

    runArg.logger.withTag(this.getRelativeName()).debug(`pull ${imageName}`);
    const image = await runArg.docker.pull(imageName);
    await new Promise<void>((resolve, reject) => {
      runArg.docker.modem.followProgress(image, (err: any, res: any) => (err ? reject(err) : resolve(res)));
    });
  }

  async executeTask(arg: RunArg): Promise<void> {
    const envs = this.getEnvironmentVariables(arg);
    const workingDirectory = this.getWorkingDirectory();
    const imageName = envs.escape(this.dockerTask.image);
    const workdir = '/build/';
    const volumes: { [key: string]: string } = {};

    for (const source of this.getSources()) {
      if (existsSync(source.absolutePath)) {
        volumes[source.relativePath] = `${source.absolutePath}:${join(workdir, source.relativePath)}`;
      } else {
        arg.logger.withTag(this.getRelativeName()).warn(`source ${source.absolutePath} does not exists`);
      }
    }
    for (const volume of this.dockerTask.mounts || []) {
      const filePath = join(workingDirectory, volume);
      volumes[volume] = `${filePath}:${join(workdir, volume)}`;
    }
    for (const volume of this.dockerTask.generates || []) {
      const filePath = join(workingDirectory, volume);
      volumes[volume] = `${filePath}:${join(workdir, volume)}`;
    }

    await this.pull(imageName, arg);

    const container = await arg.docker.createContainer({
      Image: imageName,
      Tty: true,
      Entrypoint: this.dockerTask.entrypoint || undefined,
      Env: envs.asArray(),
      WorkingDir: workdir,
      Labels: {'app': 'hammerkit'},
      HostConfig: {
        Binds: Object.keys(volumes).map(k => volumes[k]),
      },
    });

    try {
      await container.start();
      for (const cmd of this.getCommands(arg)) {
        if (typeof cmd === 'string') {
          const exec = await container.exec({
            Cmd: splitCommand(cmd),
            Tty: false,
            AttachStdout: true,
            AttachStderr: true,
          });

          const stream = await exec.start({stdin: true, Detach: false, Tty: false});
          await awaitStream(stream, arg, this.getRelativeName(), imageName);

          const result = await exec.inspect();
          if (result.ExitCode !== 0) {
            throw new Error(`command ${cmd} failed with ${result.ExitCode}`);
          }
        } else {
          await cmd.run.execute(arg);
        }
      }
    } finally {
      await container.remove({force: true});
    }
  }
}

function splitCommand(cmd: string): string[] {
  const matches = cmd.match(/(?:[^\s"]+|"[^"]*")+/g);
  if (!matches) {
    return [];
  }
  return matches;
}

class NoopStream extends Writable {
  constructor(private fn: (log: string) => void) {
    super();
  }

  _write(chunk: any, encoding: BufferEncoding, callback: (error?: (Error | null)) => void) {
    for (const log of getLogs(chunk)) {
      this.fn(log.endsWith('\n') ? log.substr(0, log.length - 1) : log);
    }
    setImmediate(callback);
  }
}

async function awaitStream(stream: Duplex, runArg: RunArg, task: string, image: string) {
  runArg.docker.modem.demuxStream(stream, new NoopStream(log => {
    runArg.logger
      .withTag(task)
      .withTag(image)
      .info(log);
  }), new NoopStream(log => {
    runArg.logger
      .withTag(task)
      .withTag(image)
      .error(log);
  }));
  await new Promise<void>((resolve, reject) => {
    stream.on('error', err => {
      reject(err);
    });
    stream.on('end', () => {
      resolve();
    });
    stream.on('close', () => {
      resolve();
    });
  });
}

