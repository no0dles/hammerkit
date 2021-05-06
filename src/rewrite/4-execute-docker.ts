import { join, relative } from 'path'
import { existsSync } from 'fs'
import { RunArg } from '../run-arg'
import { awaitStream } from '../docker/stream'
import { ContainerMount, TaskNode } from './1-plan'
import Dockerode, { Container } from 'dockerode'

async function pull(docker: Dockerode, imageName: string, runArg: RunArg): Promise<void> {
  let searchImageName = imageName
  if (imageName.indexOf(':') === -1) {
    searchImageName += ':latest'
  }
  const images = await docker.listImages({})
  if (images.some((i) => i.RepoTags?.some((repoTag) => repoTag === searchImageName))) {
    return
  }

  runArg.logger.debug(`pull ${imageName}`)
  const image = await docker.pull(imageName)
  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(image, (err: any, res: any) => (err ? reject(err) : resolve(res)))
  })
}

export async function runTaskDocker(image: string, task: TaskNode, arg: RunArg): Promise<void> {
  const docker = new Dockerode()
  const containerWorkingDirectory = '/build/'
  const volumes: ContainerMount[] = []

  const addVolume = (volume: ContainerMount) => {
    if (!volumes.some((v) => v.localPath === volume.localPath || v.containerPath === volume.containerPath)) {
      volumes.push(volume)
    }
  }

  for (const source of task.src) {
    if (existsSync(source.absolutePath)) {
      addVolume({
        localPath: source.absolutePath,
        containerPath: join(containerWorkingDirectory, relative(task.path, source.absolutePath)),
      })
    } else {
      arg.logger.warn(`${source.absolutePath} does not exists`)
    }
  }

  for (const generate of task.generates) {
    addVolume({
      localPath: generate,
      containerPath: join(containerWorkingDirectory, relative(task.path, generate)),
    })
  }

  for (const volume of task.mounts) {
    addVolume(volume)
  }

  await pull(docker, image, arg)

  const container = await docker.createContainer({
    Image: image,
    Tty: true,
    Entrypoint: task.shell || 'sh',
    Env: Object.keys(task.envs).map((k) => `${k}=${task.envs[k]}`),
    WorkingDir: containerWorkingDirectory,
    Labels: { app: 'hammerkit' },
    HostConfig: {
      Binds: volumes.map((v) => `${v.localPath}:${v.containerPath}`),
    },
  })

  const user = `${process.getuid()}:${process.getgid()}`

  try {
    await container.start()

    const setUserPermission = async (directory: string) => {
      arg.logger.debug('set permission on ', directory)
      const result = await execCommand(
        arg,
        docker,
        container,
        containerWorkingDirectory,
        ['chown', user, directory],
        `chown ${user} ${directory}`,
        undefined
      )
      if (result.ExitCode !== 0) {
        arg.logger.warn(`unable to set permissions for ${directory}`)
      }
    }

    await setUserPermission(containerWorkingDirectory)
    for (const volume of volumes) {
      await setUserPermission(volume.containerPath)
    }

    for (const cmd of task.cmds) {
      const result = await execCommand(
        arg,
        docker,
        container,
        join(containerWorkingDirectory, relative(task.path, cmd.path)),
        [task.shell || 'sh', '-c', cmd.cmd],
        cmd.cmd,
        user
      )
      if (result.ExitCode !== 0) {
        throw new Error(`command ${cmd.cmd} failed with ${result.ExitCode}`)
      }
    }
  } finally {
    await container.remove({ force: true })
  }
}

async function execCommand(
  arg: RunArg,
  docker: Dockerode,
  container: Container,
  cwd: string,
  cmd: string[],
  cmdName: string,
  user: string | undefined
) {
  const exec = await container.exec({
    Cmd: cmd,
    WorkingDir: cwd,
    Tty: false,
    AttachStdout: true,
    AttachStderr: true,
    User: user,
  })

  const stream = await exec.start({ stdin: true, Detach: false, Tty: false })
  await awaitStream(docker, stream, arg, cmdName)
  return exec.inspect()
}
