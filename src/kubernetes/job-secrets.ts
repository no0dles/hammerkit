import { V1Container, V1EnvVar, V1Secret, V1Volume, V1VolumeMount } from '@kubernetes/client-node'
import { Environment } from '../executer/environment'
import { WorkItem } from '../planner/work-item'
import { WorkKubernetesEnvironment, WorkKubernetesServer } from '../planner/work-environment'
import { describeSecretSource, getSecretName, WorkSecret, WorkSecretSource } from '../planner/work-secret'
import { ContainerWorkService } from '../planner/work-service'
import { ContainerWorkTask } from '../planner/work-task'
import { getProviderInvocation } from '../secrets/command-secret-provider'
import { escapeKubernetesText } from '../planner/utils/task-arguments'
import { getVersion } from '../version'
import { apply, KubernetesObjectHeader, statusCodeOf } from './apply'
import { KubernetesInstance } from './kubernetes-instance'
import { getItemLabels, getResourceName } from './resources'
import { getContainerSecurity } from './job-placement'
import { formatNetwork, getEffectiveNetwork, WorkNetwork } from '../planner/work-network'

// Where the values are in the pod (an in-memory volume), and where the init container
// of a secret finds the credential of its account
export const SECRET_VALUES_PATH = '/var/run/hammerkit/secrets'
export const ACCOUNT_PATH = '/var/run/hammerkit/account'
const VALUES_VOLUME = 'hammerkit-secret-values'
// a token is made for each Job right before it is created; it has to outlast the
// time its pod waits for a node
const TOKEN_SECONDS = 3600

type ProviderSource = Extract<WorkSecretSource, { type: 'provider' }>

// A secret read in the Job: its position in the values volume and where it comes from
export interface JobSecret {
  index: number
  secret: WorkSecret
  source: ProviderSource
}

/**
 * Which secrets of a task the Job reads itself. On a server's cluster the secrets of
 * a provider are read in the Job, by an init container per secret with only its
 * account's credential, so the server holds no secret manager credential and sees no
 * value. The others (`env:`, the server's own variables) are handed over in a Secret
 * of the task, as without a server.
 */
export function splitJobSecrets(
  secrets: WorkSecret[],
  server: WorkKubernetesServer | undefined
): { delivered: WorkSecret[]; inJob: JobSecret[] } {
  if (!server) {
    return { delivered: secrets, inJob: [] }
  }
  const delivered: WorkSecret[] = []
  const inJob: JobSecret[] = []
  for (const secret of secrets) {
    if (secret.source.type === 'provider') {
      inJob.push({ index: inJob.length, secret, source: secret.source })
    } else {
      delivered.push(secret)
    }
  }
  return { delivered, inJob }
}

/**
 * The init containers that read secrets share the pod, and so the NetworkPolicy, of
 * the task: under a limited network they reach the secret manager only through the
 * task's egress proxy, which lets them reach the endpoints the server names for the
 * provider (`backend.providers.<name>.allow`). A task that reads a secret of a provider
 * without them keeps an open network. Answers the endpoints the proxy lets through.
 */
export function getSecretHosts(
  task: WorkItem<ContainerWorkTask>,
  secrets: JobSecret[],
  server: WorkKubernetesServer | undefined,
  network: WorkNetwork = getEffectiveNetwork(task.data)
): string[] {
  if (!server || secrets.length === 0 || network.type === 'open') {
    return []
  }
  const unreachable = secrets.find((secret) => !server.providers[secret.source.provider]?.allow?.length)
  if (unreachable) {
    throw new Error(
      `task ${task.name}: secret ${getSecretName(unreachable.secret)} is read from ${describeSecretSource(
        unreachable.secret
      )} in the Job of the task, which network ${formatNetwork(network)} would cut off from it; ` +
        `on this cluster a task that reads secrets of ${unreachable.source.provider} keeps an open network, ` +
        `unless the server names its endpoints in backend.providers.${unreachable.source.provider}.allow`
    )
  }
  return [...new Set(secrets.flatMap((secret) => server.providers[secret.source.provider].allow ?? []))].sort()
}

// The accounts of the secrets, in the order they are first read
function accountsOf(secrets: JobSecret[]): string[] {
  return [...new Set(secrets.map((s) => s.source.account))]
}

export function getCredentialsName(
  item: WorkItem<ContainerWorkTask | ContainerWorkService>,
  kubernetes: Pick<WorkKubernetesEnvironment, 'server'>
): string {
  return getResourceName(item, kubernetes, '-credentials')
}

// The keys of the credentials Secret: `<account>.token` and `<account>.file.<key>`
function tokenKey(account: string): string {
  return `${account}.token`
}

function fileKey(account: string, key: string): string {
  return `${account}.file.${key}`
}

/**
 * The credentials the init containers need, in a Secret of the task that only they
 * mount: per account, a short-lived token of its ServiceAccount and the files of its
 * Secret, both from the server's namespace. Removed with the task's other Secret.
 */
export async function ensureJobCredentials(
  instance: KubernetesInstance,
  kubernetes: WorkKubernetesEnvironment,
  item: WorkItem<ContainerWorkTask | ContainerWorkService>,
  secrets: JobSecret[],
  admitted: string[] | undefined
): Promise<CredentialFiles> {
  const server = kubernetes.server
  const files: CredentialFiles = {}
  if (!server || secrets.length === 0) {
    return files
  }
  assertJobAccounts(secrets, server, admitted)
  const data: { [key: string]: string } = {}
  for (const account of accountsOf(secrets)) {
    const credentials = server.accounts[account]
    files[account] = []
    if (credentials.serviceAccount) {
      const response = await instance.coreApi.createNamespacedServiceAccountToken({
        name: credentials.serviceAccount,
        namespace: server.namespace,
        body: {
          spec: {
            audiences: credentials.audience ? [credentials.audience] : [],
            expirationSeconds: TOKEN_SECONDS,
          },
        },
      })
      const token = response.status?.token
      if (!token) {
        throw new Error(`no token was issued for the ServiceAccount ${credentials.serviceAccount} of ${account}`)
      }
      data[tokenKey(account)] = Buffer.from(token, 'utf8').toString('base64')
      files[account].push({ key: tokenKey(account), path: 'token' })
    }
    if (credentials.secret) {
      let content: { [key: string]: string }
      try {
        const secret = await instance.coreApi.readNamespacedSecret({
          name: credentials.secret,
          namespace: server.namespace,
        })
        content = secret.data ?? {}
      } catch (e) {
        if (statusCodeOf(e) === 404) {
          throw new Error(`the Secret ${credentials.secret} of ${account} is not in ${server.namespace}`)
        }
        throw e
      }
      for (const [key, value] of Object.entries(content)) {
        data[fileKey(account, key)] = value
        files[account].push({ key: fileKey(account, key), path: key })
      }
    }
  }
  const spec: V1Secret & KubernetesObjectHeader = {
    kind: 'Secret',
    apiVersion: 'v1',
    metadata: {
      namespace: kubernetes.namespace,
      name: getCredentialsName(item, kubernetes),
      annotations: { 'hammerkit.dev/version': getVersion() },
      labels: getItemLabels(item, kubernetes),
    },
    type: 'Opaque',
    data,
  }
  await apply(instance, spec)
  return files
}

/**
 * Refuses a secret of an account the run was not admitted for, or of one without a
 * credential on the cluster: its command would run as whatever the node or the image
 * of the provider is, which every account shares. Before anything is minted or copied.
 */
export function assertJobAccounts(
  secrets: JobSecret[],
  server: WorkKubernetesServer,
  admitted: string[] | undefined
): void {
  for (const { secret, source } of secrets) {
    const label = `secret ${getSecretName(secret)} (${describeSecretSource(secret)})`
    if (admitted && !admitted.includes(source.account)) {
      throw new Error(`${label}: the run was not admitted for the account ${source.account}`)
    }
    if (!server.accounts[source.account]) {
      throw new Error(
        `${label}: the account ${source.account} has no credential on this cluster (accounts.${source.account}.kubernetes)`
      )
    }
  }
}

// Per account, the keys of the credentials Secret and the file each is in the
// account's directory
export type CredentialFiles = { [account: string]: { key: string; path: string }[] }

export async function removeJobCredentials(
  instance: KubernetesInstance,
  kubernetes: WorkKubernetesEnvironment,
  item: WorkItem<ContainerWorkTask | ContainerWorkService>
): Promise<void> {
  if (!kubernetes.server) {
    return
  }
  try {
    await instance.coreApi.deleteNamespacedSecret({
      name: getCredentialsName(item, kubernetes),
      namespace: kubernetes.namespace,
    })
  } catch (e) {
    if (statusCodeOf(e) !== 404) {
      throw e
    }
  }
}

export interface JobSecretSpec {
  initContainers: V1Container[]
  volumes: V1Volume[]
  // of the container of the task
  mounts: V1VolumeMount[]
  // the command of the container of the task: its own, or a wrapper that exports
  // the values and masks them in its output
  command(shell: string, cmd: string): { command: string[]; args: string[]; env: V1EnvVar[] }
}

// A string as one word of a POSIX shell
function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * What the pod of a task needs to read its secrets itself. Each secret gets an init
 * container in the image of its provider, which runs the provider's command (no
 * shell between the reference and the command) with the provider's and its
 * account's variables and the account's credential under /var/run/hammerkit/account,
 * and writes the value verbatim into a volume in memory. The task's container mounts
 * that volume only: a `path` secret is the file itself, an `env` secret is exported
 * from it, and the task's output is masked before it leaves the pod, since the
 * server, which masks everything else, never sees these values.
 */
export function getJobSecretSpec(
  item: WorkItem<ContainerWorkTask | ContainerWorkService>,
  secrets: JobSecret[],
  server: WorkKubernetesServer | undefined,
  credentials: CredentialFiles,
  environment: Environment,
  // under a limited network, what sends their requests through the egress proxy
  proxyEnv: V1EnvVar[] = []
): JobSecretSpec {
  if (!server || secrets.length === 0) {
    return {
      initContainers: [],
      volumes: [],
      mounts: [],
      command: (shell, cmd) => ({ command: [shell, '-c'], args: [cmd], env: [] }),
    }
  }

  const volumes: V1Volume[] = [{ name: VALUES_VOLUME, emptyDir: { medium: 'Memory' } }]
  // a volume per account with only its keys, mounted by the init containers of its secrets
  const accountVolume = new Map<string, string>()
  accountsOf(secrets).forEach((account, index) => {
    const items = credentials[account] ?? []
    if (items.length === 0) {
      return
    }
    const name = `hammerkit-account-${index}`
    accountVolume.set(account, name)
    volumes.push({ name, secret: { secretName: getCredentialsName(item, { server }), items, defaultMode: 0o444 } })
  })

  const initContainers = secrets.map(({ index, secret, source }): V1Container => {
    const label = `secret ${getSecretName(secret)} (${describeSecretSource(secret)})`
    // what the run was admitted for, as when the server reads a secret itself
    const allowed = environment.hosted?.accounts
    if (allowed && !allowed.includes(source.account)) {
      throw new Error(`${label}: the run was not admitted for the account ${source.account}`)
    }
    const image = server.providers[source.provider]?.image
    if (!image) {
      throw new Error(`${label}: this server names no image for the provider ${source.provider}`)
    }
    const { command, args, env } = getProviderInvocation(source.binding, source.ref, environment)
    const volume = accountVolume.get(source.account)
    return {
      name: `secret-${index}`,
      image,
      // the value as the command prints it, written once it is complete
      command: [
        'sh',
        '-c',
        'umask 022 && "$@" > "$HAMMERKIT_VALUE.part" && mv "$HAMMERKIT_VALUE.part" "$HAMMERKIT_VALUE"',
      ],
      // Kubernetes would expand a `$(NAME)` of the container's env in them, the proxy's token
      // among them: the reference is text, as on any other backend
      args: ['sh', command, ...args].map(escapeKubernetesText),
      env: [
        ...proxyEnv,
        ...Object.entries(env).map(([name, value]) => ({ name, value })),
        { name: 'HAMMERKIT_VALUE', value: `${SECRET_VALUES_PATH}/secret-${index}` },
      ],
      volumeMounts: [
        { name: VALUES_VOLUME, mountPath: SECRET_VALUES_PATH },
        ...(volume ? [{ name: volume, mountPath: ACCOUNT_PATH, readOnly: true }] : []),
      ],
      ...getContainerSecurity({ server }),
    }
  })
  const mounts: V1VolumeMount[] = [{ name: VALUES_VOLUME, mountPath: SECRET_VALUES_PATH }]
  const exportLines: string[] = []
  for (const { index, secret } of secrets) {
    if (secret.target.type === 'file') {
      mounts.push({ name: VALUES_VOLUME, mountPath: secret.target.path, subPath: `secret-${index}`, readOnly: true })
    } else {
      // verbatim: the x keeps the trailing newlines command substitution would drop
      const name = secret.target.name
      exportLines.push(
        `${name}="$(cat "$HAMMERKIT_SECRETS/secret-${index}"; printf x)" && ${name}="\${${name}%x}" && export ${name}`
      )
    }
  }
  const script = [
    ...exportLines,
    `command -v awk >/dev/null 2>&1 || { echo 'hammerkit: the image has no awk, which masks the secrets of this task in its output' >&2; exit 127; }`,
    `{ "$HAMMERKIT_SHELL" -c "$HAMMERKIT_CMD"; echo $? > "$HAMMERKIT_SECRETS/.status"; } 2>&1 | awk -v dir="$HAMMERKIT_SECRETS" -v count=${
      secrets.length
    } ${quote(MASK_PROGRAM)}`,
    `exit "$(cat "$HAMMERKIT_SECRETS/.status" 2>/dev/null || echo 1)"`,
  ].join('\n')

  return {
    initContainers,
    volumes,
    mounts,
    command: (shell, cmd) => ({
      command: [shell, '-c'],
      args: [script],
      env: [
        { name: 'HAMMERKIT_SECRETS', value: SECRET_VALUES_PATH },
        { name: 'HAMMERKIT_SHELL', value: shell },
        { name: 'HAMMERKIT_CMD', value: cmd },
      ],
    }),
  }
}

// Every line of every value (trimmed, 4 characters or more, like the server's own
// masking) is replaced by *** in each line of output. index() and not a regular
// expression, so a value is matched as written.
const MASK_PROGRAM = `
function mask(s, v,   out, i) {
  out = ""
  while ((i = index(s, v)) > 0) { out = out substr(s, 1, i - 1) "***"; s = substr(s, i + length(v)) }
  return out s
}
BEGIN {
  n = 0
  for (k = 0; k < count; k++) {
    f = dir "/secret-" k
    while ((getline line < f) > 0) {
      gsub(/^[ \\t\\r]+|[ \\t\\r]+$/, "", line)
      if (length(line) >= 4) values[n++] = line
    }
    close(f)
  }
  # longest first, so a value that holds another is masked as a whole
  for (a = 0; a < n; a++) for (b = a + 1; b < n; b++) if (length(values[b]) > length(values[a])) { t = values[a]; values[a] = values[b]; values[b] = t }
}
{
  out = $0
  for (k = 0; k < n; k++) out = mask(out, values[k])
  print out
  fflush()
}`
