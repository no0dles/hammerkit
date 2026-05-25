import Dockerode from 'dockerode'
import { request } from 'http'

const REGISTRY_NAME = 'hammerkit-test-registry'
const REGISTRY_IMAGE = 'registry:2'

export interface LocalRegistry {
  host: string
  hostPort: number
  /** stop and remove the container; safe to call even when reusing an external registry */
  cleanup(): Promise<void>
}

function registryAddressFromEnv(): { host: string; hostPort: number } | null {
  const fromEnv = process.env.REGISTRY
  if (!fromEnv) {
    return null
  }
  const match = /^([^:]+):(\d+)$/.exec(fromEnv)
  if (!match) {
    throw new Error(`REGISTRY must be of the form host:port (got "${fromEnv}")`)
  }
  return { host: match[1], hostPort: parseInt(match[2], 10) }
}

async function isReachable(host: string, hostPort: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = request({ host, port: hostPort, path: '/v2/', method: 'GET', timeout: 2000 }, (res) => {
      res.resume()
      const ok = !!res.statusCode && (res.statusCode < 400 || res.statusCode === 401)
      resolve(ok)
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
    req.end()
  })
}

// Read the host port docker actually bound to the registry's 5000/tcp. With an
// ephemeral binding this is assigned at start, so it must be read back from the
// running container rather than assumed.
async function discoverHostPort(container: Dockerode.Container): Promise<number | null> {
  const info = await container.inspect()
  const hostPort = info.NetworkSettings?.Ports?.['5000/tcp']?.[0]?.HostPort
  return hostPort ? parseInt(hostPort, 10) : null
}

/**
 * Returns a docker registry suitable for `cli.package({ registry, push: true, ... })`.
 *
 * Resolution order:
 * 1. `REGISTRY=host:port` env var (used by CI; just probed for liveness, never managed).
 * 2. A managed `registry:2` container on 127.0.0.1. Its host port is ephemeral by
 *    default (discovered after start) so it never collides with a fixed port the
 *    host already owns — notably macOS ControlCenter/AirPlay, which listens on
 *    5000. Set HAMMERKIT_TEST_REGISTRY_PORT to pin a specific port.
 *
 * Callers must invoke `cleanup()`. For the env-var case it is a no-op.
 */
export async function ensureLocalRegistry(docker?: Dockerode): Promise<LocalRegistry> {
  const fromEnv = registryAddressFromEnv()
  if (fromEnv) {
    if (!(await isReachable(fromEnv.host, fromEnv.hostPort))) {
      throw new Error(`REGISTRY=${fromEnv.host}:${fromEnv.hostPort} is not reachable`)
    }
    return { ...fromEnv, cleanup: async () => undefined }
  }

  const d = docker ?? new Dockerode()
  const existing = await d.listContainers({ all: true, filters: { name: [REGISTRY_NAME] } })
  let container: Dockerode.Container
  if (existing.length === 0) {
    try {
      await new Promise<void>((resolve, reject) => {
        d.pull(REGISTRY_IMAGE, (err: unknown, stream: NodeJS.ReadableStream | undefined) => {
          if (err || !stream) {
            reject(err ?? new Error('no pull stream'))
            return
          }
          d.modem.followProgress(stream, (e: unknown) => (e ? reject(e) : resolve()))
        })
      })
    } catch {
      // image may already exist locally
    }
    // '' lets docker pick a free host port (ephemeral); pin via env if needed.
    const requestedPort = process.env.HAMMERKIT_TEST_REGISTRY_PORT ?? ''
    container = await d.createContainer({
      Image: REGISTRY_IMAGE,
      name: REGISTRY_NAME,
      HostConfig: {
        AutoRemove: true,
        PortBindings: { '5000/tcp': [{ HostPort: requestedPort }] },
      },
      ExposedPorts: { '5000/tcp': {} },
    })
    await container.start()
  } else {
    container = d.getContainer(existing[0].Id)
    if (existing[0].State !== 'running') {
      await container.start()
    }
  }

  const hostPort = await discoverHostPort(container)
  if (!hostPort) {
    throw new Error('could not determine the host port of the local docker registry')
  }

  const cleanup = async () => {
    const c = (await d.listContainers({ all: true, filters: { name: [REGISTRY_NAME] } }))[0]
    if (c) {
      try {
        await d.getContainer(c.Id).remove({ force: true })
      } catch {
        /* ignore */
      }
    }
  }

  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (await isReachable('127.0.0.1', hostPort)) {
      return { host: '127.0.0.1', hostPort, cleanup }
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`local docker registry on port ${hostPort} did not become reachable in time`)
}
