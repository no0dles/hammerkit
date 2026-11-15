import { Container } from 'dockerode'
import { stat } from 'fs/promises'
import { isAbsolute } from 'path'
import { PassThrough } from 'stream'
import { WorkItem } from '../planner/work-item'
import { ContainerWorkTask } from '../planner/work-task'
import { ContainerWorkService } from '../planner/work-service'
import { Environment } from './environment'
import { convertToPosixPath } from './execute-docker'
import { hostedRoot, refuseHostLinks } from './execution-steps'
import { ContainerBind } from './container-bind'

/**
 * On a server, what a started container binds is what the run's files hold. The engine
 * resolves a bind's path as the container starts, and says nothing about what it found,
 * so the paths are checked once more on the host (no link on the way) and every folder or
 * file the container sees at a bind is compared with the one of the host, by inode, read
 * inside the container with `ls`. A container that sees anything else is refused. Off a
 * server nothing is checked: the files are the user's own.
 */
export async function assertContainerBinds(
  item: WorkItem<ContainerWorkTask | ContainerWorkService>,
  environment: Environment,
  container: Container,
  binds: Pick<ContainerBind, 'localPath' | 'containerPath'>[]
): Promise<void> {
  if (!hostedRoot(environment)) {
    return
  }
  await refuseHostLinks(item, environment)
  for (const bind of binds.filter((b) => isAbsolute(b.localPath))) {
    const expected = (await stat(bind.localPath, { bigint: true })).ino.toString()
    const seen = await readInode(container, convertToPosixPath(bind.containerPath))
    if (seen === null) {
      throw new Error(
        `${item.name}: can not check what the container binds at ${bind.containerPath}: a server needs ls in the image of a container that binds files of the run`
      )
    }
    if (seen !== expected) {
      throw new Error(`${item.name}: the container does not bind the files of the run at ${bind.containerPath}`)
    }
  }
}

// The inode of `path` inside the container, as `ls -di` prints it, or null when that
// can not be read (no ls, a container that is not running).
export async function readInode(container: Container, path: string, timeoutMs = 10_000): Promise<string | null> {
  try {
    const exec = await container.exec({
      Cmd: ['ls', '-di', '--', path],
      AttachStdout: true,
      AttachStderr: true,
      User: '0',
    })
    const stream = await exec.start({ hijack: true, stdin: false })
    const stdout = new PassThrough()
    const chunks: Buffer[] = []
    stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    container.modem.demuxStream(stream, stdout, new PassThrough())
    let timer: NodeJS.Timeout | undefined
    const finished = await Promise.race([
      new Promise<boolean>((resolve) => {
        stream.on('end', () => resolve(true))
        stream.on('error', () => resolve(false))
      }),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs)
      }),
    ])
    clearTimeout(timer)
    if (!finished) {
      stream.destroy()
      return null
    }
    const result = await exec.inspect()
    if (result.ExitCode !== 0) {
      return null
    }
    const match = Buffer.concat(chunks)
      .toString('utf8')
      .match(/^\s*(\d+)\s/)
    return match ? BigInt(match[1]).toString() : null
  } catch {
    return null
  }
}
