import { requiresKubernetes } from '../requires-kubernetes'
import { createTestCase } from '../test-case'
import { AppsV1Api, CoreV1Api, KubeConfig } from '@kubernetes/client-node'
import { request } from 'http'

// Exercises src/executer/kubernetes-service.ts end-to-end: hammerkit's
// `kubernetes-service` type opens a local TCP server (one per published port)
// that tunnels via the k8s API to a pod. We deploy nginx directly with the k8s
// client, then point a hammerkit kubernetes-service at it, drive the lifecycle
// (load kubeconfig -> resolve pod -> listen -> state `running`) and actually
// HTTP-GET the forwarded port to prove data flows through to the pod.

const RUN_ID = (process.env.HAMMERKIT_TEST_RUN_ID ?? 'local').slice(0, 30)
const NS = `hammerkit-k8s-svc-${RUN_ID}`
const CTX = process.env.CLUSTER_NAME || 'docker-desktop'
const HOST_PORT = 28080
const DEPLOY_NAME = 'nginx'

function makeClients(): { coreApi: CoreV1Api; appsApi: AppsV1Api } {
  const kc = new KubeConfig()
  kc.loadFromDefault()
  kc.setCurrentContext(CTX)
  return {
    coreApi: kc.makeApiClient(CoreV1Api),
    appsApi: kc.makeApiClient(AppsV1Api),
  }
}

async function ensureNamespace(coreApi: CoreV1Api): Promise<void> {
  try {
    await coreApi.readNamespace(NS)
    return
  } catch {
    /* missing */
  }
  try {
    await coreApi.createNamespace({ metadata: { name: NS } })
  } catch {
    /* racing creator */
  }
}

async function applyNginx(coreApi: CoreV1Api, appsApi: AppsV1Api): Promise<void> {
  await appsApi.deleteNamespacedDeployment(DEPLOY_NAME, NS).catch(() => undefined)
  await appsApi.createNamespacedDeployment(NS, {
    metadata: { name: DEPLOY_NAME, labels: { app: DEPLOY_NAME } },
    spec: {
      replicas: 1,
      selector: { matchLabels: { app: DEPLOY_NAME } },
      template: {
        metadata: { labels: { app: DEPLOY_NAME } },
        spec: {
          containers: [{ name: DEPLOY_NAME, image: 'nginx:1.25-alpine', ports: [{ containerPort: 80 }] }],
        },
      },
    },
  } as never)

  const deadline = Date.now() + 90000
  while (Date.now() < deadline) {
    const pods = await coreApi.listNamespacedPod(NS, undefined, undefined, undefined, undefined, `app=${DEPLOY_NAME}`)
    const ready = pods.body.items.some(
      (p) => p.status?.conditions?.some((c) => c.type === 'Ready' && c.status === 'True')
    )
    if (ready) return
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error(`nginx pod in ${NS} did not become ready in time`)
}

async function waitFor(predicate: () => boolean, timeoutMs: number, intervalMs = 200): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  throw new Error('waitFor: predicate never became true')
}

function httpGet(host: string, port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host, port, path, method: 'GET', timeout: 5000 }, (res) => {
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', reject)
    req.on('timeout', () => {
      req.destroy()
      reject(new Error('http timeout'))
    })
    req.end()
  })
}

describe('kubernetes-service (port-forward)', () => {
  const suite = createTestCase('k8s-service-forward', {
    '.hammerkit.yaml': {
      services: {
        nginx: {
          context: CTX,
          namespace: NS,
          selector: { type: 'deployment', name: DEPLOY_NAME },
          ports: [`${HOST_PORT}:80`],
        },
      },
      environments: {
        default: {
          kubernetes: { context: CTX, namespace: NS },
        },
      },
    },
  })

  beforeAll(
    requiresKubernetes(async () => {
      const { coreApi, appsApi } = makeClients()
      await ensureNamespace(coreApi)
      await applyNginx(coreApi, appsApi)
    }),
    120000
  )

  afterAll(async () => {
    try {
      const { coreApi } = makeClients()
      await coreApi.deleteNamespace(NS).catch(() => undefined)
    } catch {
      /* no cluster available */
    }
  })

  it(
    'forwards a kubernetes-service to a pod and tears down on abort',
    requiresKubernetes(async () => {
      await suite.cli({}, async (cli, env) => {
        const exec = cli.up({ logMode: 'live' })
        const done = exec.start()
        try {
          // state transitions to `running` only after the forward server's
          // listen() resolves — proves loadKubeConfig + resolvePodName + the
          // TCP listener setup all completed against a live cluster.
          await waitFor(() => exec.state.current.services['nginx']?.state.current.type === 'running', 30000)
          // and an actual byte round-trip through the forward confirms the
          // per-connection portForward path (createServer callback) works too.
          const res = await httpGet('127.0.0.1', HOST_PORT, '/')
          expect(res.status).toBe(200)
          expect(res.body).toMatch(/nginx/i)
        } finally {
          env.abortCtrl.abort()
          await done
        }
        // abort triggers the finally block in kubernetesService: forwards close,
        // state advances to `end`.
        expect(exec.state.current.services['nginx']?.state.current.type).toBe('end')
      })
    }),
    120000
  )
})
