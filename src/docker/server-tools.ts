import Dockerode from 'dockerode'
import { chmod, mkdir, mkdtemp, rename, rm, stat } from 'fs/promises'
import { join, posix } from 'path'
import { pipeline } from 'stream/promises'
import { extract } from 'tar'
import { createHash, randomBytes } from 'crypto'
import { getHammerkitDirectory } from '../optimizer/get-cache-directory'
import { HELPER_TOOLS_IMAGE } from '../kubernetes/transfer-tools'
import { pull } from './pull'
import { StatusScopedConsole } from '../planner/work-item-status'
import { Environment } from '../executer/environment'
import { removeContainer } from './remove-container'

/**
 * On a server's docker host, what the server runs in a container before the container's
 * own commands (its first process, the check of what it binds, the gate of a service) is
 * the pinned static busybox of the cluster backend, bound read-only from a folder of the
 * server, never a tool of the image. Its folder in the container is made up for each
 * container (`/.hammerkit-<random>`), so that nothing of the run or of the image, such as a
 * link, can name it, and it is kept out of the logs. No source, output, mount, volume or
 * secret may be at `/` or at or in a folder whose name starts with `.hammerkit`.
 */
export interface ServerTools {
  // the folder of the tools in the container
  folder: string
  // the busybox on the docker host
  hostBusybox: string
}

export function createServerTools(hostBusybox: string): ServerTools {
  return { folder: `/.hammerkit-${randomBytes(16).toString('hex')}`, hostBusybox }
}

let busybox: Promise<string> | undefined

// The busybox on the docker host, copied out of the pinned image once per process.
export function ensureServerBusybox(
  docker: Dockerode,
  status: StatusScopedConsole,
  environment: Environment
): Promise<string> {
  busybox ??= copyBusybox(docker, status, environment).catch((e) => {
    busybox = undefined
    throw e
  })
  return busybox
}

async function copyBusybox(docker: Dockerode, status: StatusScopedConsole, environment: Environment) {
  const name = createHash('sha256').update(HELPER_TOOLS_IMAGE).digest('hex').slice(0, 16)
  const folder = join(getHammerkitDirectory(), 'tools')
  const file = join(folder, `busybox-${name}`)
  if (await stat(file).catch(() => undefined)) {
    return file
  }
  await pull(status, docker, HELPER_TOOLS_IMAGE, environment)
  await mkdir(folder, { recursive: true, mode: 0o755 })
  const temporary = await mkdtemp(join(folder, '.busybox-'))
  const container = await docker.createContainer({ Image: HELPER_TOOLS_IMAGE, Cmd: ['true'] })
  try {
    const archive = await container.getArchive({ path: '/bin/busybox' })
    await pipeline(archive, extract({ cwd: temporary, filter: (path) => path === 'busybox' }))
    await chmod(join(temporary, 'busybox'), 0o755)
    await rename(join(temporary, 'busybox'), file)
  } finally {
    await removeContainer(container).catch(() => undefined)
    await rm(temporary, { recursive: true, force: true })
  }
  return file
}

// the busybox in the container
export function serverBusybox(tools: ServerTools): string {
  return `${tools.folder}/busybox`
}

export function serverToolsBinds(tools: ServerTools): string[] {
  return [`${tools.hostBusybox}:${serverBusybox(tools)}:ro`]
}

// a tmpfs of a service's container: the server writes `go` into it once the binds are checked
export function serviceGateTmpfs(tools: ServerTools): { [path: string]: string } {
  return { [`${tools.folder}/run`]: 'rw,size=64k,mode=755' }
}

function gateFile(tools: ServerTools): string {
  return `${tools.folder}/run/go`
}

// `command` run by the server's busybox in a container
export function withServerBusybox(tools: ServerTools, command: string[]): string[] {
  return [serverBusybox(tools), ...command]
}

// Runs `command` (the service's own, as docker would) once the server opened the gate.
export function gatedCommand(tools: ServerTools, command: string[]): string[] {
  const busybox = serverBusybox(tools)
  const wait = `until ${busybox} test -e ${gateFile(tools)}; do ${busybox} sleep 0.1; done; exec "$@"`
  return [busybox, 'sh', '-c', wait, 'hammerkit-gate', ...command]
}

// what the server's busybox runs to open the gate
export function openGateArguments(tools: ServerTools): string[] {
  return ['touch', gateFile(tools)]
}

// `text` (a log line, an error) without the name of the tools' folder
export function hideServerTools(text: string, tools: ServerTools | undefined): string {
  return tools ? text.split(tools.folder).join('/.hammerkit-…') : text
}

// A path of a container where an item's source, output, mount, volume or secret would
// hide or replace the server's tools: `/`, or at or in a folder `.hammerkit…` of `/`.
export function isServerToolsPath(containerPath: string): boolean {
  const normalized = posix.normalize(containerPath).replace(/\/+$/, '') || '/'
  return normalized === '/' || /^\/\.hammerkit($|[-/])/.test(normalized)
}
