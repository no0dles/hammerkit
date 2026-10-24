import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { CoreV1Api, KubeConfig, RbacAuthorizationV1Api, V1PolicyRule } from '@kubernetes/client-node'

// The rights of a server with a Kubernetes backend and sandboxes, as backend.mdx gives
// them ("What the server may do"): across the cluster namespaces (listed to find the claims
// of sandboxes when it starts) and binding `runRole`; everything else in the namespaces of
// callers, by `runRole`.
export function getServerRules(runRole: string): V1PolicyRule[] {
  return [
    { apiGroups: [''], resources: ['namespaces'], verbs: ['get', 'list', 'create'] },
    { apiGroups: ['rbac.authorization.k8s.io'], resources: ['rolebindings'], verbs: ['get', 'create', 'update'] },
    {
      apiGroups: ['rbac.authorization.k8s.io'],
      resources: ['clusterroles'],
      verbs: ['bind'],
      resourceNames: [runRole],
    },
  ]
}

const MANAGE = ['get', 'list', 'create', 'patch', 'delete', 'deletecollection']
export const RUN_RULES: V1PolicyRule[] = [
  { apiGroups: [''], resources: ['resourcequotas', 'limitranges'], verbs: ['get', 'create', 'update', 'delete'] },
  {
    apiGroups: [''],
    resources: ['pods', 'pods/exec', 'pods/log', 'persistentvolumeclaims', 'secrets', 'services'],
    verbs: MANAGE,
  },
  { apiGroups: ['batch'], resources: ['jobs', 'jobs/status'], verbs: MANAGE },
  { apiGroups: ['apps'], resources: ['deployments'], verbs: MANAGE },
  {
    apiGroups: ['networking.k8s.io'],
    resources: ['networkpolicies'],
    verbs: ['get', 'list', 'create', 'update', 'patch', 'delete'],
  },
]

export interface ServerAccount {
  // a kubeconfig with the token of the server's ServiceAccount, context `hammerkit`
  kubeconfig: string
  remove(): Promise<void>
}

/**
 * Makes the server's ServiceAccount in `namespace`, with the roles of the docs bound to it,
 * and a kubeconfig that is that account.
 */
export async function createServerAccount(
  config: KubeConfig,
  namespace: string,
  roles: { server: string; runs: string }
): Promise<ServerAccount> {
  const core = config.makeApiClient(CoreV1Api)
  const rbac = config.makeApiClient(RbacAuthorizationV1Api)
  await core.createNamespacedServiceAccount({ namespace, body: { metadata: { name: 'hammerkit' } } })
  await rbac.createClusterRole({ body: { metadata: { name: roles.server }, rules: getServerRules(roles.runs) } })
  await rbac.createClusterRole({ body: { metadata: { name: roles.runs }, rules: RUN_RULES } })
  await rbac.createClusterRoleBinding({
    body: {
      metadata: { name: roles.server },
      roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: roles.server },
      subjects: [{ kind: 'ServiceAccount', name: 'hammerkit', namespace }],
    },
  })
  const token = await core.createNamespacedServiceAccountToken({
    name: 'hammerkit',
    namespace,
    body: { spec: { expirationSeconds: 7200 } },
  })
  const server = config.getCurrentCluster()
  const kubeconfig = join(mkdtempSync(join(tmpdir(), 'hammerkit-kubeconfig-')), 'config')
  writeFileSync(
    kubeconfig,
    JSON.stringify({
      apiVersion: 'v1',
      kind: 'Config',
      clusters: [
        {
          name: 'cluster',
          cluster: {
            server: server?.server,
            ...(server?.caData ? { 'certificate-authority-data': server.caData } : {}),
            ...(server?.caFile ? { 'certificate-authority': server.caFile } : {}),
            ...(server?.skipTLSVerify ? { 'insecure-skip-tls-verify': true } : {}),
          },
        },
      ],
      users: [{ name: 'hammerkit', user: { token: token.status?.token } }],
      contexts: [{ name: 'hammerkit', context: { cluster: 'cluster', user: 'hammerkit' } }],
      'current-context': 'hammerkit',
    })
  )
  return {
    kubeconfig,
    remove: async () => {
      await rbac.deleteClusterRoleBinding({ name: roles.server }).catch(() => undefined)
      for (const name of [roles.server, roles.runs]) {
        await rbac.deleteClusterRole({ name }).catch(() => undefined)
      }
      rmSync(dirname(kubeconfig), { recursive: true, force: true })
    },
  }
}
