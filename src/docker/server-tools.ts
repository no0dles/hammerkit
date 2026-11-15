import Dockerode from 'dockerode'
import { chmod, mkdir, mkdtemp, rename, rm, stat } from 'fs/promises'
import { join } from 'path'
import { pipeline } from 'stream/promises'
import { extract } from 'tar'
import { createHash } from 'crypto'
import { getHammerkitDirectory } from '../optimizer/get-cache-directory'
import { HELPER_TOOLS_IMAGE, isTransferToolsPath, TRANSFER_TOOLS_PATH } from '../kubernetes/transfer-tools'
import { pull } from './pull'
import { StatusScopedConsole } from '../planner/work-item-status'
import { Environment } from '../executer/environment'
import { removeContainer } from './remove-container'

/**
 * On a server's docker host, what the server runs in a container before the container's
 * own commands (its first process, the check of what it binds, the gate of a service) is
 * the pinned static busybox of the cluster backend, bound read-only from a folder of the
 * server, never a tool of the image. Its folder in the container is the one the cluster
 * backend uses (`/.hammerkit`), which no source, output, mount or volume may be at or in.
 */
export const SERVER_BUSYBOX = `${TRANSFER_TOOLS_PATH}/busybox`
// a tmpfs of a service's container: the server writes `go` into it once the binds are checked
export const SERVICE_GATE_PATH = `${TRANSFER_TOOLS_PATH}/run`
const SERVICE_GATE_FILE = `${SERVICE_GATE_PATH}/go`

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

export function serverBusyboxBind(file: string): string {
  return `${file}:${SERVER_BUSYBOX}:ro`
}

// `command` run by the server's busybox in a container
export function withServerBusybox(command: string[]): string[] {
  return [SERVER_BUSYBOX, ...command]
}

// Runs `command` (the service's own, as docker would) once the server opened the gate.
export function gatedCommand(command: string[]): string[] {
  const wait = `until ${SERVER_BUSYBOX} test -e ${SERVICE_GATE_FILE}; do ${SERVER_BUSYBOX} sleep 0.1; done; exec "$@"`
  return [SERVER_BUSYBOX, 'sh', '-c', wait, 'hammerkit-gate', ...command]
}

// what the server's busybox runs to open the gate
export function openGateArguments(): string[] {
  return ['touch', SERVICE_GATE_FILE]
}

// A path of a container where an item's source, output, mount or volume would hide or
// replace the server's tools.
export function isServerToolsPath(containerPath: string): boolean {
  return isTransferToolsPath(containerPath)
}
