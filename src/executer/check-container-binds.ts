import { Container } from 'dockerode'
import { isAbsolute } from 'path'
import { PassThrough } from 'stream'
import { WorkItem } from '../planner/work-item'
import { ContainerWorkTask, isContainerWorkTask } from '../planner/work-task'
import { ContainerWorkService } from '../planner/work-service'
import { Environment } from './environment'
import { convertToPosixPath } from './execute-docker'
import { hostedRoot, refuseHostLinks } from './execution-steps'
import { ContainerBind } from './container-bind'
import { statBeneath } from '../file/stat-beneath'
import {
  hideServerTools,
  isServerToolsPath,
  openGateArguments,
  ServerTools,
  withServerBusybox,
} from '../docker/server-tools'
import { getContainerBinds } from './get-container-binds'

/**
 * On a server, what a started container binds is what the run's files hold. The engine
 * resolves a bind's path as the container starts and says nothing about what it found, so
 * once it started, every folder and file the container sees at a bind is compared with the
 * one of the run's files by device and inode. The host side is read from the run's root
 * one name at a time without following a link (statBeneath); the container side by the
 * server's own busybox (server-tools.ts), which is also all that has run in the container
 * so far. A container that sees anything else is refused. Off a server nothing is checked:
 * the files are the user's own.
 */
export async function assertContainerBinds(
  item: WorkItem<ContainerWorkTask | ContainerWorkService>,
  environment: Environment,
  container: Container,
  binds: Pick<ContainerBind, 'localPath' | 'containerPath'>[],
  tools: ServerTools | undefined
): Promise<void> {
  const root = hostedRoot(environment)
  if (!root) {
    return
  }
  if (!tools) {
    throw new Error(`${item.name}: the server's tools are not in the container`)
  }
  await refuseHostLinks(item, environment)
  const checks = binds
    .filter((b) => isAbsolute(b.localPath))
    .map(async (bind) => {
      const expected = await statBeneath(root, bind.localPath).catch((e) => {
        throw new Error(`${item.name}: ${(e as Error).message}`)
      })
      const seen = await readIdentity(container, tools, convertToPosixPath(bind.containerPath))
      if (seen.error !== undefined) {
        throw new Error(`${item.name}: can not check what the container binds at ${bind.containerPath}: ${seen.error}`)
      }
      if (seen.identity !== `${expected.dev} ${expected.ino}`) {
        throw new Error(`${item.name}: the container does not bind the files of the run at ${bind.containerPath}`)
      }
    })
  const results = await Promise.allSettled(checks)
  const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
  if (failed) {
    throw failed.reason
  }
}

/**
 * On a server, no source, output, mount, volume or secret file of an item may be where the
 * server's tools are in a container (isServerToolsPath), where it would hide or replace them.
 */
export function refuseServerToolsPaths(
  item: WorkItem<ContainerWorkTask | ContainerWorkService>,
  environment: Environment
): void {
  if (!hostedRoot(environment)) {
    return
  }
  const data = item.data
  const paths = [
    ...(isContainerWorkTask(data)
      ? getContainerBinds(item as WorkItem<ContainerWorkTask>).map((b) => b.containerPath)
      : [
          ...data.src.map((s) => s.absolutePath),
          ...data.mounts.map((m) => m.containerPath),
          ...data.volumes.map((v) => v.containerPath),
        ]),
    ...data.secrets.flatMap((secret) => (secret.target.type === 'file' ? [secret.target.path] : [])),
  ]
  const over = paths.find((path) => isServerToolsPath(convertToPosixPath(path)))
  if (over !== undefined) {
    throw new Error(`${item.name}: ${over} is where the server keeps its tools in a container, nothing can be there`)
  }
}

/**
 * On a server's docker host, a task that adds capabilities runs in a sandboxed runtime
 * (`backend.capabilities.runtime`, such as gVisor) that reports its own device numbers, so
 * what such a container binds can not be compared with the run's files (assertContainerBinds).
 * Until it can, such a task may bind no files of the run: it is refused before its container
 * is created.
 */
export function refuseUncheckableBinds(item: WorkItem<ContainerWorkTask>, environment: Environment): void {
  if (!hostedRoot(environment) || item.data.capAdd.length === 0) {
    return
  }
  const bound = getContainerBinds(item).find((b) => isAbsolute(b.localPath))
  if (bound) {
    throw new Error(
      `${item.name}: adds capabilities and binds ${bound.containerPath}; on a server's docker host a task that adds capabilities can not bind files of the run`
    )
  }
}

// The device and inode of `path` inside the container, as the server's busybox reads them.
export async function readIdentity(
  container: Container,
  tools: ServerTools,
  path: string
): Promise<{ identity: string; error?: undefined } | { identity?: undefined; error: string }> {
  const result = await runServerCommand(container, tools, ['stat', '-c', '%d %i', '--', path])
  if (result.error !== undefined) {
    return { error: result.error }
  }
  const match = result.stdout.match(/^(\d+) (\d+)\s*$/)
  return match
    ? { identity: `${BigInt(match[1])} ${BigInt(match[2])}` }
    : { error: `unexpected answer ${result.stdout.trim()}` }
}

// Lets the command of a service's container run, once its binds are checked (see gatedCommand).
export async function openServiceGate(container: Container, tools: ServerTools): Promise<void> {
  const result = await runServerCommand(container, tools, openGateArguments(tools))
  if (result.error !== undefined) {
    throw new Error(`the service could not be started: ${result.error}`)
  }
}

// Runs a tool of the server's busybox in the container, as root.
// What it says is kept free of the name of the tools' folder.
async function runServerCommand(
  container: Container,
  tools: ServerTools,
  command: string[],
  timeoutMs = 10_000
): Promise<{ stdout: string; error?: undefined } | { stdout?: undefined; error: string }> {
  try {
    const exec = await container.exec({
      Cmd: withServerBusybox(tools, command),
      AttachStdout: true,
      AttachStderr: true,
      User: '0',
    })
    const stream = await exec.start({ hijack: true, stdin: false })
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const chunks: Buffer[] = []
    const errors: Buffer[] = []
    stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    stderr.on('data', (chunk: Buffer) => errors.push(chunk))
    container.modem.demuxStream(stream, stdout, stderr)
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
      return { error: `no answer within ${timeoutMs / 1000}s` }
    }
    const result = await exec.inspect()
    if (result.ExitCode !== 0) {
      const error = Buffer.concat(errors).toString('utf8').trim() || `exit code ${result.ExitCode}`
      return { error: hideServerTools(error, tools) }
    }
    return { stdout: Buffer.concat(chunks).toString('utf8') }
  } catch (e) {
    return { error: hideServerTools((e as Error).message, tools) }
  }
}
