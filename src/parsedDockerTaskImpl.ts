import { ParsedBuildFile } from './parsedBuildFile'
import { DockerBuildFileTask } from './config'
import { RunArg } from './run-arg'
import { homedir } from 'os'
import { join } from 'path'
import { existsSync } from 'fs'
import { ParsedTaskImpl } from './parsedTaskImpl'
import { Duplex, Writable } from 'stream'
import { getLogs } from './log'
import { Container, ExecInspectInfo } from 'dockerode'
import { splitBy } from './string'
import { Generation } from './parsedBuildFileTask'

interface Volume {
  localPath: string
  containerPath: string
}

export class ParsedDockerTaskImpl extends ParsedTaskImpl {
  constructor(buildFile: ParsedBuildFile, name: string, private dockerTask: DockerBuildFileTask) {
    super(buildFile, name, dockerTask)
  }

  async pull(imageName: string, runArg: RunArg): Promise<void> {
    let searchImageName = imageName
    if (imageName.indexOf(':') === -1) {
      searchImageName += ':latest'
    }
    const images = await runArg.docker.listImages({})
    if (images.some((i) => i.RepoTags?.some((repoTag) => repoTag === searchImageName))) {
      return
    }

    runArg.logger.withTag(this.getAbsoluteName()).debug(`pull ${imageName}`)
    const image = await runArg.docker.pull(imageName)
    await new Promise<void>((resolve, reject) => {
      runArg.docker.modem.followProgress(image, (err: any, res: any) => (err ? reject(err) : resolve(res)))
    })
  }

  async executeTask(arg: RunArg, generation: Generation[]): Promise<void> {
    const envs = this.getEnvironmentVariables(arg)
    const workingDirectory = this.getWorkingDirectory()
    const imageName = envs.escape(this.dockerTask.image)
    const containerWorkingDirectory = '/build/'
    const volumes: Volume[] = []

    const addVolume = (volume: Volume) => {
      if (!volumes.some((v) => v.containerPath === volume.containerPath)) {
        volumes.push(volume)
      }
    }

    for (const source of this.getSources()) {
      if (existsSync(source.absolutePath)) {
        addVolume({
          localPath: source.absolutePath,
          containerPath: join(containerWorkingDirectory, source.relativePath),
        })
      } else {
        arg.logger.withTag(this.getAbsoluteName()).warn(`source ${source.absolutePath} does not exists`)
      }
    }

    const taskVolumes = this.dockerTask.mounts || []
    for (const volume of taskVolumes) {
      const [localPath, containerPath] = splitBy(volume, ':')
      if (localPath && containerPath) {
        if (localPath.startsWith('/')) {
          addVolume({ localPath, containerPath })
        } else if (localPath.startsWith('$PWD')) {
          addVolume({ localPath: join(homedir(), localPath.substr('$PWD'.length)), containerPath })
        } else {
          addVolume({ localPath: join(workingDirectory, localPath), containerPath })
        }
      } else {
        const filePath = join(workingDirectory, volume)
        addVolume({ localPath: filePath, containerPath: join(containerWorkingDirectory, volume) })
      }
    }

    for (const generate of generation) {
      addVolume({
        localPath: generate.absolutePath,
        containerPath: join(containerWorkingDirectory, generate.relativePath),
      })
    }

    await this.pull(imageName, arg)

    const container = await arg.docker.createContainer({
      Image: imageName,
      Tty: true,
      Entrypoint: this.dockerTask.shell || 'sh',
      Env: envs.asArray(),
      WorkingDir: containerWorkingDirectory,
      Labels: { app: 'hammerkit' },
      HostConfig: {
        Binds: volumes.map((v) => `${v.localPath}:${v.containerPath}`),
      },
    })

    const user = `${process.getuid()}:${process.getgid()}`
    const name = this.getAbsoluteName()

    try {
      await container.start()

      const setUserPermission = async (directory: string) => {
        arg.logger.withTag(name).debug('set permission on ', directory)
        const result = await this.execCommand(container, arg, ['chown', user, directory], undefined)
        if (result.ExitCode !== 0) {
          arg.logger.warn(`unable to set permissions for ${directory}`)
        }
      }

      await setUserPermission(containerWorkingDirectory)
      for (const volume of volumes) {
        await setUserPermission(volume.containerPath)
      }

      for (const cmd of this.getCommands(arg)) {
        if (typeof cmd === 'string') {
          arg.logger.withTag(name).info(cmd)
          const result = await this.execCommand(container, arg, splitCommand(cmd), user)
          if (result.ExitCode !== 0) {
            throw new Error(`command ${cmd} failed with ${result.ExitCode}`)
          }
        } else {
          await cmd.run.execute(arg)
        }
      }
    } finally {
      await container.remove({ force: true })
    }
  }

  async execCommand(
    container: Container,
    arg: RunArg,
    cmd: string[],
    user: string | undefined
  ): Promise<ExecInspectInfo> {
    const exec = await container.exec({
      Cmd: cmd,
      Tty: false,
      AttachStdout: true,
      AttachStderr: true,
      User: user,
    })

    const stream = await exec.start({ stdin: true, Detach: false, Tty: false })
    await awaitStream(stream, arg, this.getAbsoluteName())
    return await exec.inspect()
  }

  get taskConfigKeys(): string[] {
    return ['description', 'cmds', 'deps', 'src', 'generates', 'envs', 'image', 'shell', 'mounts']
  }

  get taskCacheValues(): any[] {
    return [
      this.dockerTask.image,
      this.dockerTask.cmds,
      this.dockerTask.deps,
      this.dockerTask.src,
      this.dockerTask.generates,
      this.dockerTask.envs,
      this.dockerTask.shell,
      this.dockerTask.mounts,
    ]
  }
}

function splitCommand(cmd: string): string[] {
  const matches = cmd.match(/(?:[^\s"]+|"[^"]*")+/g)
  if (!matches) {
    return []
  }
  return matches
}

class NoopStream extends Writable {
  constructor(private fn: (log: string) => void) {
    super()
  }

  _write(chunk: any, encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    for (const log of getLogs(chunk)) {
      this.fn(log.endsWith('\n') ? log.substr(0, log.length - 1) : log)
    }
    setImmediate(callback)
  }
}

async function awaitStream(stream: Duplex, runArg: RunArg, task: string) {
  runArg.docker.modem.demuxStream(
    stream,
    new NoopStream((log) => {
      runArg.logger.withTag(task).info(log)
    }),
    new NoopStream((log) => {
      runArg.logger.withTag(task).info(log)
    })
  )
  await new Promise<void>((resolve, reject) => {
    stream.on('error', (err) => {
      reject(err)
    })
    stream.on('end', () => {
      resolve()
    })
    stream.on('close', () => {
      resolve()
    })
  })
}
