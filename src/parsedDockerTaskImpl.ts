import { ParsedBuildFile } from './parsedBuildFile'
import { DockerBuildFileTask } from './config'
import { RunArg } from './run-arg'
import { join } from 'path'
import { existsSync } from 'fs'
import { ParsedTaskImpl } from './parsedTaskImpl'
import { Duplex, Writable } from 'stream'
import { getLogs } from './log'
import { Container } from 'dockerode'
import { splitBy } from './string'

export class ParsedDockerTaskImpl extends ParsedTaskImpl {
  constructor(buildFile: ParsedBuildFile, name: string, private dockerTask: DockerBuildFileTask) {
    super(buildFile, name, dockerTask)
  }

  async pull(imageName: string, runArg: RunArg) {
    const images = await runArg.docker.listImages({})
    if (images.some((i) => i.RepoTags?.some((repoTag) => repoTag === imageName))) {
      return
    }

    runArg.logger.withTag(this.getRelativeName()).debug(`pull ${imageName}`)
    const image = await runArg.docker.pull(imageName)
    await new Promise<void>((resolve, reject) => {
      runArg.docker.modem.followProgress(image, (err: any, res: any) => (err ? reject(err) : resolve(res)))
    })
  }

  async executeTask(arg: RunArg): Promise<void> {
    const envs = this.getEnvironmentVariables(arg)
    const workingDirectory = this.getWorkingDirectory()
    const imageName = envs.escape(this.dockerTask.image)
    const containerWorkingDirectory = '/build/'
    const volumes: { localPath: string; containerPath: string }[] = []

    for (const source of this.getSources()) {
      if (existsSync(source.absolutePath)) {
        volumes.push({
          localPath: source.absolutePath,
          containerPath: join(containerWorkingDirectory, source.relativePath),
        })
      } else {
        arg.logger.withTag(this.getRelativeName()).warn(`source ${source.absolutePath} does not exists`)
      }
    }

    const taskVolumes = [...(this.dockerTask.mounts || []), ...(this.dockerTask.generates || [])]
    for (const volume of taskVolumes) {
      if (volume.indexOf(':') >= 0) {
        const [localPath, containerPath] = splitBy(volume, ':')
        volumes.push({ localPath: join(workingDirectory, localPath), containerPath })
      } else {
        const filePath = join(workingDirectory, volume)
        volumes.push({ localPath: filePath, containerPath: join(containerWorkingDirectory, volume) })
      }
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

    try {
      await container.start()

      const setUserPermission = async (directory: string) => {
        const result = await this.execCommand(container, imageName, arg, ['chown', user, '-R', directory], undefined)
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
          const result = await this.execCommand(container, imageName, arg, splitCommand(cmd), user)
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

  async execCommand(container: Container, imageName: string, arg: RunArg, cmd: string[], user: string | undefined) {
    const exec = await container.exec({
      Cmd: cmd,
      Tty: false,
      AttachStdout: true,
      AttachStderr: true,
      User: user,
    })

    const stream = await exec.start({ stdin: true, Detach: false, Tty: false })
    await awaitStream(stream, arg, this.getRelativeName(), imageName)
    return await exec.inspect()
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

async function awaitStream(stream: Duplex, runArg: RunArg, task: string, image: string) {
  runArg.docker.modem.demuxStream(
    stream,
    new NoopStream((log) => {
      runArg.logger.withTag(task).withTag(image).info(log)
    }),
    new NoopStream((log) => {
      runArg.logger.withTag(task).withTag(image).error(log)
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
