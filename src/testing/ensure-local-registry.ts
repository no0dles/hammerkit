import Dockerode from 'dockerode'

const REGISTRY_NAME = 'hammerkit-test-registry'
const REGISTRY_IMAGE = 'registry:2'
// Small image with busybox wget, used to talk to the registry from the daemon's
// network (see why below). alpine is already pulled by the package suites.
const PROBE_IMAGE = 'alpine:3.19'
const MANAGED_PORT = Number(process.env.HAMMERKIT_TEST_REGISTRY_PORT) || 5000

export interface LocalRegistry {
  host: string
  hostPort: number
  /** stop and remove the container; safe to call even when reusing an external registry */
  cleanup(): Promise<void>
  /** true when the registry lists `tag` under `repository` (queried from the daemon's network) */
  listsTag(repository: string, tag: string): Promise<boolean>
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

async function ensureImage(docker: Dockerode, image: string): Promise<void> {
  try {
    await docker.getImage(image).inspect()
    return
  } catch {
    // not present locally — pull it below
  }
  await new Promise<void>((resolve, reject) => {
    docker.pull(image, (err: unknown, stream: NodeJS.ReadableStream | undefined) => {
      if (err || !stream) {
        reject(err ?? new Error('no pull stream'))
        return
      }
      docker.modem.followProgress(stream, (e: unknown) => (e ? reject(e) : resolve()))
    })
  })
}

// Run a throwaway container on the *host* network and return its exit code.
// The registry is reachable at 127.0.0.1:<port> from the daemon's network (see
// ensureLocalRegistry), but not necessarily from this (host) process — on Docker
// Desktop the daemon is in a VM — so registry HTTP is done from here instead.
async function runOnHostNet(docker: Dockerode, shellCmd: string): Promise<number> {
  await ensureImage(docker, PROBE_IMAGE)
  const container = await docker.createContainer({
    Image: PROBE_IMAGE,
    Cmd: ['sh', '-c', shellCmd],
    HostConfig: { NetworkMode: 'host', AutoRemove: false },
  })
  try {
    await container.start()
    const res = await container.wait()
    return res.StatusCode ?? 1
  } finally {
    await container.remove({ force: true }).catch(() => undefined)
  }
}

/**
 * Returns a docker registry suitable for `cli.package({ registry, push: true, ... })`.
 *
 * Resolution order:
 * 1. `REGISTRY=host:port` env var (used by CI; just probed for liveness, never managed).
 * 2. A managed `registry:2` container on the daemon's own network (host networking).
 *
 * Host networking matters: the daemon performs the push, and an HTTP push needs a
 * `127.0.0.1`/`localhost` address (the only registries docker treats as insecure
 * without daemon config). On Docker Desktop the daemon runs in a VM, so a
 * host-*published* port is not reachable from it via 127.0.0.1 (`docker push
 * 127.0.0.1:<published>` → connection refused). Putting the registry on the
 * daemon's network makes 127.0.0.1:<port> resolve to it. Because this process
 * (on the host) then can't see the registry, liveness and tag lookups run inside
 * a throwaway container on the same network — see `listsTag`.
 *
 * Callers must invoke `cleanup()`. For the env-var case it is a no-op.
 */
export async function ensureLocalRegistry(docker?: Dockerode): Promise<LocalRegistry> {
  const d = docker ?? new Dockerode()
  const fromEnv = registryAddressFromEnv()

  let host: string
  let hostPort: number
  let cleanup = async (): Promise<void> => undefined

  if (fromEnv) {
    host = fromEnv.host
    hostPort = fromEnv.hostPort
  } else {
    host = '127.0.0.1'
    hostPort = MANAGED_PORT
    await ensureImage(d, REGISTRY_IMAGE)
    const existing = await d.listContainers({ all: true, filters: { name: [REGISTRY_NAME] } })
    if (existing.length === 0) {
      const container = await d.createContainer({
        Image: REGISTRY_IMAGE,
        name: REGISTRY_NAME,
        Env: [`REGISTRY_HTTP_ADDR=0.0.0.0:${MANAGED_PORT}`],
        HostConfig: { AutoRemove: true, NetworkMode: 'host' },
      })
      await container.start()
    } else if (existing[0].State !== 'running') {
      await d.getContainer(existing[0].Id).start()
    }
    cleanup = async () => {
      const c = (await d.listContainers({ all: true, filters: { name: [REGISTRY_NAME] } }))[0]
      if (c) {
        await d
          .getContainer(c.Id)
          .remove({ force: true })
          .catch(() => undefined)
      }
    }
  }

  const base = `http://${host}:${hostPort}`
  const reachable = await runOnHostNet(
    d,
    `for i in $(seq 1 60); do wget -q -O /dev/null ${base}/v2/ && exit 0; sleep 1; done; exit 1`
  )
  if (reachable !== 0) {
    throw new Error(`docker registry at ${host}:${hostPort} did not become reachable in time`)
  }

  return {
    host,
    hostPort,
    cleanup,
    async listsTag(repository: string, tag: string): Promise<boolean> {
      const code = await runOnHostNet(d, `wget -qO- ${base}/v2/${repository}/tags/list | grep -q '"${tag}"'`)
      return code === 0
    },
  }
}
