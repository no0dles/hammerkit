import Dockerode from 'dockerode'
import { request } from 'http'

const REGISTRY_NAME = 'hammerkit-test-registry'
const REGISTRY_IMAGE = 'registry:2'
const DEFAULT_HOST_PORT = 5000

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

/**
 * Returns a docker registry suitable for `cli.package({ registry, push: true, ... })`.
 *
 * Resolution order:
 * 1. `REGISTRY=host:port` env var (used by CI; just probed for liveness, never managed).
 * 2. A managed `registry:2` container started on 127.0.0.1:5000 (used locally).
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
    const container = await d.createContainer({
      Image: REGISTRY_IMAGE,
      name: REGISTRY_NAME,
      HostConfig: {
        AutoRemove: true,
        PortBindings: { '5000/tcp': [{ HostPort: `${DEFAULT_HOST_PORT}` }] },
      },
      ExposedPorts: { '5000/tcp': {} },
    })
    await container.start()
  } else if (existing[0].State !== 'running') {
    await d.getContainer(existing[0].Id).start()
  }

  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (await isReachable('127.0.0.1', DEFAULT_HOST_PORT)) {
      return {
        host: '127.0.0.1',
        hostPort: DEFAULT_HOST_PORT,
        async cleanup() {
          const c = (await d.listContainers({ all: true, filters: { name: [REGISTRY_NAME] } }))[0]
          if (c) {
            try {
              await d.getContainer(c.Id).remove({ force: true })
            } catch {
              /* ignore */
            }
          }
        },
      }
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`local docker registry on port ${DEFAULT_HOST_PORT} did not become reachable in time`)
}
