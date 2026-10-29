import { readFileSync } from 'fs'
import { join } from 'path'
import {
  CoreV1Api,
  KubeConfig,
  KubernetesObject,
  KubernetesObjectApi,
  NodeV1Api,
  RbacAuthorizationV1Api,
  V1Pod,
} from '@kubernetes/client-node'
import { parseAllDocuments } from 'yaml'
import { requiresKubernetes } from '../requires-kubernetes'
import { getErrorMessage } from '../../log'

// The admission policies of backend.mdx#capabilities, as the docs print them, on a real API
// server: the CEL compiles against the pod and namespace schemas, and refuses what Pod Security
// `baseline` refuses in a namespace that enforces `privileged`. Renamed for this test, and the
// pod policy limited to its namespace, so the other specs on the cluster don't meet it.

const context = process.env.CLUSTER_NAME || 'docker-desktop'
const suffix = Date.now().toString(36)
const prefix = `hk-cap-${suffix}-`
const namespace = `${prefix}0123456789abcdef`
const runtimeClass = `hk-gvisor-${suffix}`
const operator = `hk-cap-ops-${suffix}`
const TEST_LABEL = 'hammerkit.dev/test'

function cluster(config = new KubeConfig()) {
  if (config.contexts.length === 0) {
    config.loadFromDefault()
    config.setCurrentContext(context)
  }
  return {
    config,
    core: config.makeApiClient(CoreV1Api),
    node: config.makeApiClient(NodeV1Api),
    rbac: config.makeApiClient(RbacAuthorizationV1Api),
    objects: KubernetesObjectApi.makeApiClient(config),
  }
}

// the policies and bindings of the docs, with this test's names
function documentedPolicies(server: string): KubernetesObject[] {
  const docs = readFileSync(join(__dirname, '../../../website/content/docs/remote-compute/backend.mdx'), 'utf8')
  const section = docs.slice(docs.indexOf('## Capabilities'))
  const yaml = /```yaml title="admission.yaml"\n([\s\S]*?)```/.exec(section)?.[1]
  if (!yaml) {
    throw new Error('backend.mdx#capabilities has no admission.yaml')
  }
  const text = yaml
    .replace(/hammerkit-capabilities/g, `hammerkit-capabilities-${suffix}`)
    .replace(/hammerkit-namespaces/g, `hammerkit-namespaces-${suffix}`)
    .replace(/'gvisor'/g, `'${runtimeClass}'`)
    .replace(/system:serviceaccount:hammerkit:hammerkit/g, server)
    .replace(/\^hammerkit-\[0-9a-f\]\{16\}\$/g, `^${prefix}[0-9a-f]{16}$`)
  return parseAllDocuments(text).map((doc) => {
    const object = doc.toJS()
    if (object.kind === 'ValidatingAdmissionPolicy' && object.spec.matchConstraints.namespaceSelector) {
      object.spec.matchConstraints.namespaceSelector.matchLabels[TEST_LABEL] = suffix
    }
    return object
  })
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// 'admitted', or why not
async function admitted(request: Promise<unknown>): Promise<string> {
  try {
    await request
    return 'admitted'
  } catch (e) {
    return getErrorMessage(e)
  }
}

describe('capabilities admission policy (kubernetes)', () => {
  let policies: KubernetesObject[] = []

  afterAll(
    requiresKubernetes(async () => {
      const { core, node, rbac, objects } = cluster()
      for (const object of [...policies].reverse()) {
        await objects.delete(object).catch(() => undefined)
      }
      await core.deleteNamespace({ name: namespace }).catch(() => undefined)
      await core.deleteNamespace({ name: operator }).catch(() => undefined)
      await rbac.deleteClusterRoleBinding({ name: operator }).catch(() => undefined)
      await rbac.deleteClusterRole({ name: operator }).catch(() => undefined)
      await node.deleteRuntimeClass({ name: runtimeClass }).catch(() => undefined)
    })
  )

  it(
    'refuses what baseline refuses, and capabilities outside the sandbox, and confines the namespaces the server makes',
    requiresKubernetes(async () => {
      const { config, core, node, rbac, objects } = cluster()
      // the server: a ServiceAccount that may make namespaces, as the docs' ClusterRole lets it
      await core.createNamespace({ body: { metadata: { name: operator } } })
      await core.createNamespacedServiceAccount({ namespace: operator, body: { metadata: { name: 'hammerkit' } } })
      await rbac.createClusterRole({
        body: {
          metadata: { name: operator },
          rules: [{ apiGroups: [''], resources: ['namespaces'], verbs: ['get', 'create'] }],
        },
      })
      await rbac.createClusterRoleBinding({
        body: {
          metadata: { name: operator },
          roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: operator },
          subjects: [{ kind: 'ServiceAccount', name: 'hammerkit', namespace: operator }],
        },
      })
      // a RuntimeClass the pods name; no node runs it, the pods are dry runs
      await node.createRuntimeClass({ body: { metadata: { name: runtimeClass }, handler: 'runsc' } })
      await core.createNamespace({
        body: {
          metadata: {
            name: namespace,
            labels: {
              'hammerkit.dev/managed': 'true',
              [TEST_LABEL]: suffix,
              'pod-security.kubernetes.io/enforce': 'privileged',
              'pod-security.kubernetes.io/audit': 'baseline',
            },
          },
        },
      })
      policies = documentedPolicies(`system:serviceaccount:${operator}:hammerkit`)
      for (const object of policies) {
        await objects.create(object)
      }

      const pod = (name: string, spec: Partial<V1Pod['spec']>, annotations?: Record<string, string>) =>
        admitted(
          core.createNamespacedPod({
            namespace,
            dryRun: 'All',
            body: {
              metadata: { name, ...(annotations ? { annotations } : {}) },
              spec: { containers: [{ name: 'c', image: 'busybox:1.36' }], ...spec },
            },
          })
        )
      const sysAdmin = { securityContext: { capabilities: { add: ['SYS_ADMIN'] } } }
      // a policy holds once the API server has it
      const until = Date.now() + 120_000
      while ((await pod('wait', { containers: [{ name: 'c', image: 'busybox:1.36', ...sysAdmin }] })) === 'admitted') {
        if (Date.now() > until) {
          throw new Error('the capabilities policy never took effect')
        }
        await sleep(1000)
      }

      const refusedBy = (message: string) => expect.stringContaining(message)
      expect(await pod('plain', {})).toBe('admitted')
      expect(
        await pod('sandboxed', {
          runtimeClassName: runtimeClass,
          containers: [{ name: 'c', image: 'busybox:1.36', ...sysAdmin }],
        })
      ).toBe('admitted')
      expect(await pod('runc', { containers: [{ name: 'c', image: 'busybox:1.36', ...sysAdmin }] })).toEqual(
        refusedBy('capabilities beyond baseline are added in the RuntimeClass')
      )
      expect(await pod('init', { initContainers: [{ name: 'i', image: 'busybox:1.36', ...sysAdmin }] })).toEqual(
        refusedBy('capabilities beyond baseline')
      )
      expect(
        await pod('privileged', {
          runtimeClassName: runtimeClass,
          containers: [{ name: 'c', image: 'busybox:1.36', securityContext: { privileged: true } }],
        })
      ).toEqual(refusedBy('no privileged containers'))
      expect(await pod('host-network', { hostNetwork: true })).toEqual(refusedBy('no host namespaces'))
      expect(await pod('host-path', { volumes: [{ name: 'h', hostPath: { path: '/' } }] })).toEqual(
        refusedBy('no hostPath volumes')
      )
      expect(
        await pod('host-port', {
          containers: [{ name: 'c', image: 'busybox:1.36', ports: [{ containerPort: 80, hostPort: 80 }] }],
        })
      ).toEqual(refusedBy('no host ports'))
      expect(await pod('seccomp', { securityContext: { seccompProfile: { type: 'Unconfined' } } })).toEqual(
        refusedBy('no unconfined seccomp')
      )
      expect(await pod('apparmor', {}, { 'container.apparmor.security.beta.kubernetes.io/c': 'unconfined' })).toEqual(
        refusedBy('no unconfined AppArmor')
      )
      expect(
        await pod('apparmor-default', {}, { 'container.apparmor.security.beta.kubernetes.io/c': 'runtime/default' })
      ).toBe('admitted')
      expect(await pod('selinux', { securityContext: { seLinuxOptions: { type: 'spc_t' } } })).toEqual(
        refusedBy('no SELinux options')
      )
      expect(
        await pod('sysctl', { securityContext: { sysctls: [{ name: 'kernel.msgmax', value: '65536' }] } })
      ).toEqual(refusedBy('only the safe sysctls'))
      expect(
        await pod('safe-sysctl', { securityContext: { sysctls: [{ name: 'net.ipv4.tcp_syncookies', value: '1' }] } })
      ).toBe('admitted')

      // an ephemeral container goes through its own subresource
      await core.createNamespacedPod({
        namespace,
        body: {
          metadata: { name: 'debugged' },
          spec: { containers: [{ name: 'c', image: 'busybox:1.36', command: ['sleep', '600'] }] },
        },
      })
      const debugged = await core.readNamespacedPod({ name: 'debugged', namespace })
      expect(
        await admitted(
          core.replaceNamespacedPodEphemeralcontainers({
            name: 'debugged',
            namespace,
            dryRun: 'All',
            body: {
              ...debugged,
              spec: {
                ...debugged.spec!,
                ephemeralContainers: [{ name: 'debug', image: 'busybox:1.36', securityContext: { privileged: true } }],
              },
            },
          })
        )
      ).toEqual(refusedBy('no privileged containers'))

      // the server makes the namespaces of its callers only
      const token = await core.createNamespacedServiceAccountToken({
        name: 'hammerkit',
        namespace: operator,
        body: { spec: { expirationSeconds: 600 } },
      })
      const current = config.getCurrentCluster()!
      const asServer = new KubeConfig()
      asServer.loadFromOptions({
        clusters: [current],
        users: [{ name: 'server', token: token.status?.token }],
        contexts: [{ name: 'server', cluster: current.name, user: 'server' }],
        currentContext: 'server',
      })
      const server = cluster(asServer).core
      const makes = (name: string, labels: Record<string, string>) =>
        admitted(server.createNamespace({ dryRun: 'All', body: { metadata: { name, labels } } }))
      const levels = { 'pod-security.kubernetes.io/enforce': 'privileged' }
      expect(await makes(`${prefix}fedcba9876543210`, { 'hammerkit.dev/managed': 'true', ...levels })).toBe('admitted')
      expect(await makes(`hk-other-${suffix}`, { 'hammerkit.dev/managed': 'true', ...levels })).toEqual(
        refusedBy('the server makes the namespaces of its callers only')
      )
      expect(await makes(`${prefix}fedcba9876543211`, levels)).toEqual(
        refusedBy('the namespaces of callers are labelled hammerkit.dev/managed')
      )
      expect(await makes(`${prefix}fedcba9876543212`, { 'hammerkit.dev/managed': 'true' })).toEqual(
        refusedBy('the namespaces of callers enforce Pod Security baseline')
      )
    }),
    300_000
  )
})
