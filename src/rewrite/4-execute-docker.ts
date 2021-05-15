import {basename, dirname, join, relative, sep} from 'path';
import {existsSync} from 'fs';
import {RunArg} from '../run-arg';
import {awaitStream} from '../docker/stream';
import {ContainerMount, TaskNode, TaskNodeCmd, TaskNodeSource} from './1-plan';
import Dockerode, {Container, Volume} from 'dockerode';
import consola from 'consola';

async function pull(docker: Dockerode, imageName: string): Promise<void> {
  let searchImageName = imageName;
  if (imageName.indexOf(':') === -1) {
    searchImageName += ':latest';
  }
  const images = await docker.listImages({});
  if (images.some((i) => i.RepoTags?.some((repoTag) => repoTag === searchImageName))) {
    return;
  }

  consola.debug(`pull image ${imageName}`);
  const image = await docker.pull(imageName);
  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(image, (err: any, res: any) => (err ? reject(err) : resolve(res)));
  });
}

export interface ContainerVolumeTask {
  path: string
  src: TaskNodeSource[]
  generates: string[]
  mounts: ContainerMount[]
}

export interface ContainerVolume {
  localPath: string,
  containerPath: string
}

export interface ContainerVolumeResult {
  volumes: ContainerVolume[],
  workingDirectory: string
}

export function getContainerVolumes(task: ContainerVolumeTask, checkSources: boolean): ContainerVolumeResult {
  const result: ContainerVolumeResult = {
    volumes: [],
    workingDirectory: '',
  };

  for (const source of task.src) {
    if (!checkSources || existsSync(source.absolutePath)) {
      result.volumes.push({
        localPath: source.absolutePath,
        containerPath: source.absolutePath,
      });
    } else {
      consola.warn(`source ${source.absolutePath} does not exists`);
    }
  }

  for (const generate of task.generates) {
    result.volumes.push({
      localPath: generate,
      containerPath: generate,
    });
  }

  for (const volume of task.mounts) {
    result.volumes.push(volume);
  }

  for (const volume of result.volumes) {
    consola.debug(
      `mount volume ${volume.localPath}:${volume.containerPath}`,
    );
  }

  let currentPath = task.path;

  while (currentPath !== dirname(currentPath)) {
    let parentPath = dirname(currentPath);

    let matches = true;
    for (const volume of result.volumes) {
      if (!volume.localPath.startsWith(parentPath)) {
        matches = false;
        break;
      }
    }

    if (matches) {
      const basePath = task.path.substr(parentPath.length)
      result.workingDirectory = join('/hammerkit', basePath);
      for (const volume of result.volumes) {
        if (volume.containerPath.startsWith(parentPath)) {
          volume.containerPath = join('/hammerkit', relative(parentPath, volume.containerPath));
        }
      }
      break;
    }

    currentPath = parentPath;
  }


  return result;
}

export async function runTaskDocker(image: string, task: TaskNode, arg: RunArg): Promise<void> {
  consola.debug(`execute ${task.name} as docker task`);
  const docker = new Dockerode();
  const volumes = getContainerVolumes(task, true);
  await pull(docker, image);

  consola.debug(`create container with image ${image} with ${task.shell || 'sh'}`);
  const container = await docker.createContainer({
    Image: image,
    Tty: true,
    Entrypoint: task.shell || 'sh',
    Env: Object.keys(task.envs).map((k) => `${k}=${task.envs[k]}`),
    WorkingDir: volumes.workingDirectory,
    Labels: {app: 'hammerkit'},
    HostConfig: {
      Binds: volumes.volumes.map((v) => `${v.localPath}:${v.containerPath}`),
    },
  });

  const user = `${process.getuid()}:${process.getgid()}`;

  try {
    await container.start();

    const setUserPermission = async (directory: string) => {
      arg.logger.debug('set permission on ', directory);
      const result = await execCommand(
        arg,
        docker,
        container,
        volumes.workingDirectory,
        ['chown', user, directory],
        `chown ${user} ${directory}`,
        undefined,
      );
      if (result.ExitCode !== 0) {
        arg.logger.warn(`unable to set permissions for ${directory}`);
      }
    };

    await setUserPermission(volumes.workingDirectory);
    for (const volume of volumes.volumes) {
      await setUserPermission(volume.containerPath);
    }

    for (const cmd of task.cmds) {
      consola.debug(`execute ${cmd.cmd} in container`);
      const result = await execCommand(
        arg,
        docker,
        container,
        join(volumes.workingDirectory, relative(task.path, cmd.path)),
        [task.shell || 'sh', '-c', cmd.cmd],
        cmd.cmd,
        user,
      );
      if (result.ExitCode !== 0) {
        throw new Error(`command ${cmd.cmd} failed with ${result.ExitCode}`);
      }
    }
  } finally {
    consola.debug(`remove container`);
    await container.remove({force: true});
  }
}

async function execCommand(
  arg: RunArg,
  docker: Dockerode,
  container: Container,
  cwd: string,
  cmd: string[],
  cmdName: string,
  user: string | undefined,
) {
  const exec = await container.exec({
    Cmd: cmd,
    WorkingDir: cwd,
    Tty: false,
    AttachStdout: true,
    AttachStderr: true,
    User: user,
  });

  const stream = await exec.start({stdin: true, Detach: false, Tty: false});
  await awaitStream(docker, stream, arg, cmdName);
  return exec.inspect();
}
