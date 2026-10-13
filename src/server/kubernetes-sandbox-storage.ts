import { createHash, randomBytes } from 'crypto'
import { mkdir, rm } from 'fs/promises'
import { join } from 'path'
import { PassThrough, Readable, Writable } from 'stream'
import { finished } from 'stream/promises'
import { V1NetworkPolicy, V1PersistentVolumeClaim, V1Pod, V1ResourceQuota, V1Status } from '@kubernetes/client-node'
import { create as createTar, extract as extractTar } from 'tar'
import { apply, KubernetesObjectHeader, statusCodeOf } from '../kubernetes/apply'
import { createKubernetesInstances, KubernetesInstance } from '../kubernetes/kubernetes-instance'
import { getSandboxAffinity, SANDBOX_LABEL } from '../kubernetes/volumes'
import { getErrorMessage } from '../log'
import { sleep } from '../utils/sleep'
import { formatSize, parseDuration, parseSize } from '../utils/units'
import { getVersion } from '../version'
import { git, isValidRef } from './git-checkout'
import { CallerNamespaces, getClusterAccess } from './kubernetes-backend'
import {
  ChangedFile,
  EditedFile,
  EditOp,
  EditPlan,
  FileStat,
  PatchAuthor,
  RawFile,
  ReadQuery,
  ReadResult,
  SandboxFiles,
  SearchQuery,
  SearchResult,
  TreeQuery,
  TreeResult,
} from './sandbox-files'
import {
  decodePodError,
  encodeEditOps,
  INCOMING,
  INCOMING_REF,
  SandboxPodHeader,
  SandboxPodRequest,
} from './sandbox-pod'
import {
  SandboxAttachment,
  SandboxFetch,
  SandboxKey,
  SandboxState,
  SandboxStorage,
  StoredSandbox,
} from './sandbox-storage'
import { SandboxError, SandboxLimits } from './sandboxes'
import { KubernetesBackend, ServerConfig } from './server-config'

// where the pod of a sandbox mounts its claim; the sandbox is the directory of its id
// below it (files, git), next to what the server fetched for it (incoming)
const CLAIM_PATH = '/claim'
const MANAGED = { 'hammerkit.dev/managed': 'true' }
// the pods of sandboxes' files: no network at all
const FILES_LABEL = 'hammerkit.dev/sandbox-files'
const FILES_POLICY = 'hammerkit-sandbox-files'
const QUOTA_NAME = 'hammerkit-sandboxes'
const ID_ANNOTATION = 'hammerkit.dev/sandbox-id'
const ISS_ANNOTATION = 'hammerkit.dev/owner-iss'
const SUB_ANNOTATION = 'hammerkit.dev/owner-sub'
// a pod that is left behind (the server stopped) ends on its own
const POD_DEADLINE_SECONDS = 6 * 60 * 60
// how long a pod may take to start, its image pull included
const POD_START_MS = 5 * 60 * 1000
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000
const FETCH_TIMEOUT_MS = 10 * 60 * 1000
// an answer is read into memory up to this; a diff is up to 64 MiB, as JSON a bit more
const MAX_ANSWER_BYTES = 160 * 1024 * 1024
const MAX_STDERR = 16 * 1024

// The names of a sandbox on the cluster: its id has letters of both cases and `_`, which
// names and labels can not all take, so they carry a hash of it.
export function getSandboxNames(id: string): { claim: string; pod: string; label: string } {
  const label = createHash('sha256').update(id).digest('hex').slice(0, 20)
  return { claim: `hammerkit-sandbox-${label}`, pod: `hammerkit-sandbox-${label}-files`, label }
}

interface FilesPod {
  namespace: string
  name: string
  ready: Promise<void>
  // requests under way; the pod goes when none is and it was idle long enough
  busy: number
  idle?: NodeJS.Timeout
}

/**
 * Sandboxes on a cluster: a PersistentVolumeClaim per sandbox in its caller's namespace,
 * mounted only while a task of a run on it or a short pod for its files runs. An idle
 * sandbox costs its storage only.
 *
 * - The server fetches the commit (it holds the read credential of `sources`, as for a
 *   ref run) and hands the repository to the pod of the sandbox, which takes it into
 *   the claim. Nothing of the credential is in the caller's namespace.
 * - Reading, searching and editing the files, the state and the usage run in that pod,
 *   with the code of a host (`hammerkit server-sandbox`, see sandbox-pod.ts), so the
 *   rules on paths, links and the deny list are the same. The pod has no network and no
 *   token, and stays while requests come, `backend.sandboxes.idle` after the last.
 * - A run on the sandbox gets a copy of the files to plan with, and its tasks mount the
 *   claim itself (WorkKubernetesWorkspace). While a run holds the sandbox, no pod of its
 *   files runs: one file is not read then either.
 * - With `backend.sandboxes.storageClass`, a ResourceQuota on that class in the
 *   caller's namespace holds `sandboxes.limits` on the cluster as well.
 */
export class KubernetesSandboxStorage implements SandboxStorage {
  readonly readsWhileHeld = false

  private readonly instance: KubernetesInstance
  private readonly namespaces: CallerNamespaces
  private readonly backend: KubernetesBackend
  private readonly pods = new Map<string, FilesPod>()
  // the namespaces whose policy and quota for sandboxes this process has applied
  private readonly prepared = new Map<string, Promise<void>>()

  constructor(
    config: ServerConfig & { backend: KubernetesBackend },
    private readonly limits: SandboxLimits,
    // the environment of git when the server fetches a repository: the variables runs see
    private readonly env: { [key: string]: string | undefined },
    // where the server fetches a commit before it goes into a claim
    private readonly staging: string,
    instance?: KubernetesInstance
  ) {
    this.backend = config.backend
    const access = getClusterAccess(config.backend, env)
    this.instance =
      instance ??
      createKubernetesInstances({
        type: 'kubernetes',
        namespace: 'default',
        kubeConfig: access.kubeConfig,
        context: access.context,
        httpRoutes: [],
      })
    this.namespaces = new CallerNamespaces(this.instance, config.backend)
  }

  async create(key: SandboxKey, fetch: SandboxFetch): Promise<string> {
    const namespace = this.namespaces.name(key.owner)
    await this.namespaces.prepare(namespace)
    await this.prepare(namespace)
    const names = getSandboxNames(key.id)
    const sandboxes = this.backend.sandboxes
    const claim: V1PersistentVolumeClaim & KubernetesObjectHeader = {
      apiVersion: 'v1',
      kind: 'PersistentVolumeClaim',
      metadata: {
        name: names.claim,
        namespace,
        labels: { ...MANAGED, [SANDBOX_LABEL]: names.label },
        annotations: {
          'hammerkit.dev/version': getVersion(),
          [ID_ANNOTATION]: key.id,
          [ISS_ANNOTATION]: key.owner.iss,
          [SUB_ANNOTATION]: key.owner.sub,
        },
      },
      spec: {
        accessModes: ['ReadWriteOnce'],
        storageClassName: sandboxes.storageClass ?? this.backend.storageClass,
        resources: { requests: { storage: String(parseSize(sandboxes.size)) } },
      },
    }
    try {
      await this.instance.objectApi.create(claim)
    } catch (e) {
      // over the ResourceQuota of the caller's sandboxes
      if (statusCodeOf(e) === 403 && /exceeded quota/.test(getErrorMessage(e))) {
        throw new SandboxError(
          413,
          `your sandboxes are at your limit of ${this.limits.count} or ${formatSize(this.limits.bytes)}: delete one`
        )
      }
      throw e
    }
    try {
      return await this.receive(key, fetch, 'create')
    } catch (e) {
      await this.remove(key).catch(() => undefined)
      throw e
    }
  }

  async fetch(key: SandboxKey, fetch: SandboxFetch): Promise<string> {
    return this.receive(key, fetch, 'fetch')
  }

  async state(key: SandboxKey, signal?: AbortSignal): Promise<SandboxState> {
    return (await this.request<SandboxState>(key, { op: 'state', id: key.id }, signal)).result
  }

  async usage(key: SandboxKey): Promise<number> {
    return (await this.request<number>(key, { op: 'usage', id: key.id })).result
  }

  files(key: SandboxKey): SandboxFiles {
    return new KubernetesSandboxFiles(
      (request, signal) => this.request(key, { ...request, id: key.id } as SandboxPodRequest, signal),
      (path) => this.raw(key, path)
    )
  }

  /**
   * Copies the files into `into` for the process of the run, which reads the sources of
   * tasks to know what changed, and takes the pod of the files down, so the pods of the
   * run go wherever their pool is.
   */
  async attach(key: SandboxKey, into: string): Promise<SandboxAttachment> {
    const names = getSandboxNames(key.id)
    const namespace = this.namespaces.name(key.owner)
    await mkdir(into, { recursive: true })
    let bytes = 0
    const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS)
    const extract = extractTar({
      cwd: into,
      // what the run plans with: files, directories and links, nothing outside of it
      filter: (_path, entry) =>
        'type' in entry && ['File', 'OldFile', 'ContiguousFile', 'Directory', 'SymbolicLink'].includes(entry.type),
    })
    const counted = new PassThrough()
    counted.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > this.limits.bytes) {
        counted.destroy(new Error(`the sandbox ${key.id} takes more than ${formatSize(this.limits.bytes)}`))
      }
    })
    const extracted = new Promise<void>((resolve, reject) => {
      extract.on('finish', resolve)
      extract.on('error', reject)
      counted.on('error', reject)
    })
    extracted.catch(() => undefined)
    counted.pipe(extract)
    await this.withPod(key, (pod) =>
      this.exec(pod, ['tar', 'cf', '-', '-C', `${CLAIM_PATH}/${key.id}/files`, '.'], null, counted, signal)
    )
    counted.end()
    await extracted
    await this.stopPod(key)
    return {
      directory: into,
      claim: { name: names.claim, namespace, subPath: `${key.id}/files`, label: names.label },
    }
  }

  async remove(key: SandboxKey): Promise<void> {
    await this.removeIn(this.namespaces.name(key.owner), key.id)
  }

  private async removeIn(namespace: string, id: string): Promise<void> {
    const names = getSandboxNames(id)
    await this.stopPod({ id, owner: { iss: '', sub: '' } }, namespace)
    try {
      await this.instance.coreApi.deleteNamespacedPersistentVolumeClaim({ name: names.claim, namespace })
    } catch (e) {
      if (statusCodeOf(e) !== 404) {
        throw e
      }
    }
  }

  // The claims of sandboxes of this server: in a namespace of one of its callers, the one
  // the owner in their annotations has.
  async list(): Promise<StoredSandbox[]> {
    const claims = await this.instance.coreApi.listPersistentVolumeClaimForAllNamespaces({
      labelSelector: `hammerkit.dev/managed=true,${SANDBOX_LABEL}`,
    })
    const stored: StoredSandbox[] = []
    for (const claim of claims.items) {
      const annotations = claim.metadata?.annotations ?? {}
      const id = annotations[ID_ANNOTATION]
      const namespace = claim.metadata?.namespace
      if (!id || !namespace || claim.metadata?.deletionTimestamp) {
        continue
      }
      const owner = { iss: annotations[ISS_ANNOTATION] ?? '', sub: annotations[SUB_ANNOTATION] ?? '' }
      if (this.namespaces.name(owner) !== namespace || getSandboxNames(id).claim !== claim.metadata?.name) {
        continue
      }
      stored.push({ id, remove: () => this.removeIn(namespace, id) })
    }
    return stored
  }

  // The commit, fetched by the server and taken into the claim by the pod.
  private async receive(key: SandboxKey, fetch: SandboxFetch, op: 'create' | 'fetch'): Promise<string> {
    if (!isValidRef(fetch.ref)) {
      throw new Error(`${JSON.stringify(fetch.ref.slice(0, 80))} is not a branch, tag or commit`)
    }
    const repository = join(this.staging, `${key.id}-${randomBytes(6).toString('hex')}.git`)
    try {
      const what = `sandbox ${key.id}`
      await mkdir(this.staging, { recursive: true, mode: 0o700 })
      await git(['init', '--quiet', '--bare', repository], fetch.env, fetch.signal, what, op)
      await git(
        [`--git-dir=${repository}`, 'fetch', '--quiet', '--depth', '1', '--', fetch.url, fetch.ref],
        fetch.env,
        fetch.signal,
        what
      )
      await git(
        [`--git-dir=${repository}`, 'update-ref', `refs/heads/${INCOMING_REF}`, 'FETCH_HEAD'],
        fetch.env,
        fetch.signal,
        what,
        op
      )
      const incoming = `${CLAIM_PATH}/${INCOMING}`
      await this.withPod(key, (pod) =>
        this.exec(
          pod,
          ['sh', '-c', 'rm -rf "$1" && mkdir -p "$1" && tar xf - -C "$1"', 'sh', incoming],
          Readable.from(createTar({ cwd: repository, portable: true }, ['.'])),
          null,
          fetch.signal
        )
      )
      return (await this.request<string>(key, { op, id: key.id }, fetch.signal)).result
    } finally {
      await rm(repository, { recursive: true, force: true })
    }
  }

  private async raw(key: SandboxKey, path: string): Promise<RawFile> {
    const answer = await this.call(key, { op: 'raw', id: key.id, path }, AbortSignal.timeout(REQUEST_TIMEOUT_MS), true)
    const result = answer.result as Pick<RawFile, 'stat' | 'sha256'>
    return 'stream' in answer ? { stat: result.stat, stream: answer.stream } : { ...result, content: answer.body }
  }

  private async request<T>(
    key: SandboxKey,
    request: SandboxPodRequest,
    signal: AbortSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  ): Promise<{ result: T }> {
    const answer = await this.call(key, request, signal, false)
    return { result: answer.result as T }
  }

  // One request to `hammerkit server-sandbox` in the pod: the first line of its answer
  // says how it went, a raw read sends the bytes after it.
  private async call(
    key: SandboxKey,
    request: SandboxPodRequest,
    signal: AbortSignal,
    body: boolean
  ): Promise<{ result: unknown; body: Buffer } | { result: unknown; stream: Readable }> {
    const encoded = request.op === 'edit' ? { ...request, ops: encodeEditOps(request.ops) } : request
    const reader = new AnswerReader(body)
    const done = this.withPod(key, (pod) =>
      this.exec(
        pod,
        ['hammerkit', 'server-sandbox', CLAIM_PATH],
        Readable.from([Buffer.from(JSON.stringify(encoded))]),
        reader,
        signal
      )
    )
    done.then(
      () => reader.complete(),
      (e) => reader.fail(e)
    )
    const answer = await reader.answer
    if (!answer.header.ok) {
      throw decodePodError(answer.header.error)
    }
    return 'stream' in answer
      ? { result: answer.header.result, stream: answer.stream }
      : { ...answer, result: answer.header.result }
  }

  /**
   * Runs `fn` with the pod of the sandbox's files, made when there is none. It stays for
   * the requests that follow and goes `idle` after the last one.
   */
  private async withPod<T>(key: SandboxKey, fn: (pod: FilesPod) => Promise<T>): Promise<T> {
    let pod = this.pods.get(key.id)
    if (!pod) {
      const namespace = this.namespaces.name(key.owner)
      const created: FilesPod = { namespace, name: getSandboxNames(key.id).pod, busy: 0, ready: Promise.resolve() }
      created.ready = this.startPod(key, namespace)
      created.ready.catch(() => {
        if (this.pods.get(key.id) === created) {
          this.pods.delete(key.id)
        }
      })
      this.pods.set(key.id, created)
      pod = created
    }
    clearTimeout(pod.idle)
    pod.busy++
    try {
      await pod.ready
      return await fn(pod)
    } finally {
      pod.busy--
      if (pod.busy === 0 && this.pods.get(key.id) === pod) {
        const current = pod
        current.idle = setTimeout(() => {
          if (current.busy === 0 && this.pods.get(key.id) === current) {
            this.stopPod(key).catch(() => undefined)
          }
        }, parseDuration(this.backend.sandboxes.idle))
        current.idle.unref()
      }
    }
  }

  // Takes the pod of the sandbox's files down, once the requests under way are answered.
  private async stopPod(key: SandboxKey, namespace = this.namespaces.name(key.owner)): Promise<void> {
    const pod = this.pods.get(key.id)
    if (pod) {
      this.pods.delete(key.id)
      clearTimeout(pod.idle)
      for (let i = 0; pod.busy > 0 && i < REQUEST_TIMEOUT_MS / 100; i++) {
        await sleep(100)
      }
    }
    await this.deletePod(namespace, getSandboxNames(key.id).pod)
  }

  private async deletePod(namespace: string, name: string): Promise<void> {
    try {
      await this.instance.coreApi.deleteNamespacedPod({ name, namespace, gracePeriodSeconds: 0 })
    } catch (e) {
      if (statusCodeOf(e) === 404) {
        return
      }
      throw e
    }
    for (let attempt = 0; attempt < 120; attempt++) {
      try {
        await this.instance.coreApi.readNamespacedPod({ name, namespace })
      } catch (e) {
        if (statusCodeOf(e) === 404) {
          return
        }
        throw e
      }
      await sleep(500)
    }
  }

  private async startPod(key: SandboxKey, namespace: string): Promise<void> {
    const names = getSandboxNames(key.id)
    await this.prepare(namespace)
    // one left by a server that stopped is used while it runs
    const existing = await this.instance.coreApi
      .readNamespacedPod({ name: names.pod, namespace })
      .catch((e) => (statusCodeOf(e) === 404 ? undefined : Promise.reject(e)))
    if (existing?.status?.phase === 'Running' && !existing.metadata?.deletionTimestamp) {
      return
    }
    if (existing) {
      await this.deletePod(namespace, names.pod)
    }
    const tolerations = this.backend.pools.flatMap((pool) => pool.tolerations)
    const pod: V1Pod & KubernetesObjectHeader = {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: {
        name: names.pod,
        namespace,
        labels: { ...MANAGED, [SANDBOX_LABEL]: names.label, [FILES_LABEL]: 'true' },
        annotations: { 'hammerkit.dev/version': getVersion() },
      },
      spec: {
        automountServiceAccountToken: false,
        enableServiceLinks: false,
        restartPolicy: 'Never',
        activeDeadlineSeconds: POD_DEADLINE_SECONDS,
        terminationGracePeriodSeconds: 0,
        // wherever a pod of the run that mounts the claim is, on any pool
        nodeSelector: { 'kubernetes.io/os': 'linux' },
        ...(tolerations.length > 0 ? { tolerations } : {}),
        affinity: getSandboxAffinity(names.label),
        containers: [
          {
            name: 'files',
            image: this.backend.sandboxes.image,
            command: ['sleep', String(POD_DEADLINE_SECONDS)],
            workingDir: CLAIM_PATH,
            volumeMounts: [{ name: 'sandbox', mountPath: CLAIM_PATH }],
          },
        ],
        volumes: [{ name: 'sandbox', persistentVolumeClaim: { claimName: names.claim } }],
      },
    }
    await this.instance.objectApi.create(pod)
    const deadline = Date.now() + POD_START_MS
    for (;;) {
      const current = await this.instance.coreApi.readNamespacedPod({ name: names.pod, namespace })
      const phase = current.status?.phase
      if (phase === 'Running') {
        return
      }
      const waiting = current.status?.containerStatuses?.[0]?.state?.waiting
      if (phase === 'Failed' || phase === 'Succeeded' || Date.now() > deadline) {
        await this.deletePod(namespace, names.pod).catch(() => undefined)
        throw new Error(
          `the pod of the sandbox ${key.id} did not start${
            waiting?.reason ? `: ${waiting.reason}${waiting.message ? ` ${waiting.message}` : ''}` : ` (${phase})`
          }`
        )
      }
      await sleep(500)
    }
  }

  // What the caller's namespace has for sandboxes: no network for the pods of their files,
  // and the quota on the storage class of sandboxes when they have one of their own.
  private prepare(namespace: string): Promise<void> {
    let prepared = this.prepared.get(namespace)
    if (!prepared) {
      prepared = this.applyPolicy(namespace)
      prepared.catch(() => this.prepared.delete(namespace))
      this.prepared.set(namespace, prepared)
    }
    return prepared
  }

  private async applyPolicy(namespace: string): Promise<void> {
    const metadata = {
      namespace,
      labels: MANAGED,
      annotations: { 'hammerkit.dev/version': getVersion() },
    }
    const policy: V1NetworkPolicy & KubernetesObjectHeader = {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: { ...metadata, name: FILES_POLICY },
      spec: { podSelector: { matchLabels: { [FILES_LABEL]: 'true' } }, policyTypes: ['Ingress', 'Egress'] },
    }
    await apply(this.instance, policy)
    const storageClass = this.backend.sandboxes.storageClass
    if (storageClass) {
      const scope = `${storageClass}.storageclass.storage.k8s.io`
      const quota: V1ResourceQuota & KubernetesObjectHeader = {
        apiVersion: 'v1',
        kind: 'ResourceQuota',
        metadata: { ...metadata, name: QUOTA_NAME },
        spec: {
          hard: {
            [`${scope}/requests.storage`]: String(this.limits.bytes),
            [`${scope}/persistentvolumeclaims`]: String(this.limits.count),
          },
        },
      }
      await apply(this.instance, quota)
    }
  }

  // A command in the pod. It fails when the command does, with the last of its error output.
  private async exec(
    pod: FilesPod,
    command: string[],
    stdin: Readable | null,
    stdout: Writable | null,
    signal: AbortSignal
  ): Promise<void> {
    let stderr = ''
    const errors = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        stderr = (stderr + chunk.toString('utf8')).slice(-MAX_STDERR)
        callback()
      },
    })
    let status: V1Status | undefined
    const socket = await this.instance.exec.exec(
      pod.namespace,
      pod.name,
      'files',
      command,
      stdout ?? new Writable({ write: (_chunk, _encoding, callback) => callback() }),
      errors,
      stdin,
      false,
      (received) => {
        status = received
      }
    )
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        socket.close()
        reject(new Error(`${command[0]} in the pod of the sandbox was cancelled`))
      }
      if (signal.aborted) {
        abort()
        return
      }
      signal.addEventListener('abort', abort, { once: true })
      socket.on('error', (e) => {
        signal.removeEventListener('abort', abort)
        reject(e)
      })
      socket.on('close', () => {
        signal.removeEventListener('abort', abort)
        if (status?.status === 'Success') {
          resolve()
          return
        }
        const reason = stderr.trim().split('\n').pop() || status?.message || 'the connection to the pod closed'
        reject(new Error(`${command[0]} in the pod of the sandbox failed: ${reason}`))
      })
    })
  }
}

/**
 * The answer of the pod: its first line, then what follows. Whatever follows is kept in
 * memory, unless the first line says it is a stream: then it is passed on as it comes.
 */
class AnswerReader extends Writable {
  readonly answer: Promise<
    { header: SandboxPodHeader; body: Buffer } | { header: SandboxPodHeader & { ok: true }; stream: Readable }
  >
  private resolveAnswer!: (
    value: { header: SandboxPodHeader; body: Buffer } | { header: SandboxPodHeader & { ok: true }; stream: Readable }
  ) => void
  private rejectAnswer!: (e: Error) => void
  private chunks: Buffer[] = []
  private size = 0
  private header: SandboxPodHeader | undefined
  private stream: PassThrough | undefined

  constructor(private readonly body: boolean) {
    super()
    this.answer = new Promise((resolve, reject) => {
      this.resolveAnswer = resolve
      this.rejectAnswer = reject
    })
    this.answer.catch(() => undefined)
  }

  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (this.stream) {
      this.stream.write(chunk, callback)
      return
    }
    this.size += chunk.length
    if (this.size > MAX_ANSWER_BYTES) {
      callback(new Error('the answer of the pod of the sandbox is too large'))
      return
    }
    this.chunks.push(chunk)
    if (!this.header) {
      const all = Buffer.concat(this.chunks)
      const newline = all.indexOf(10)
      if (newline < 0) {
        callback()
        return
      }
      try {
        this.header = JSON.parse(all.subarray(0, newline).toString('utf8')) as SandboxPodHeader
      } catch {
        callback(new Error('the pod of the sandbox did not answer'))
        return
      }
      this.chunks = [all.subarray(newline + 1)]
      if (this.header.ok && this.header.stream && this.body) {
        this.stream = new PassThrough()
        this.resolveAnswer({ header: this.header, stream: this.stream })
        this.stream.write(this.chunks[0], callback)
        this.chunks = []
        return
      }
    }
    callback()
  }

  // the command ended well: everything it wrote is here once the stream finished
  async complete(): Promise<void> {
    this.end()
    try {
      await finished(this)
    } catch (e) {
      this.fail(e)
      return
    }
    if (this.stream) {
      this.stream.end()
    } else if (this.header) {
      this.resolveAnswer({ header: this.header, body: Buffer.concat(this.chunks) })
    } else {
      this.rejectAnswer(new Error('the pod of the sandbox did not answer'))
    }
  }

  fail(e: unknown): void {
    const error = e instanceof Error ? e : new Error(String(e))
    if (this.stream) {
      this.stream.destroy(error)
    }
    this.rejectAnswer(error)
  }
}

// The files of a sandbox on a cluster: each call is a request to the pod of its files.
class KubernetesSandboxFiles implements SandboxFiles {
  constructor(
    private readonly request: <T>(
      request: DistributiveOmit<SandboxPodRequest, 'id'>,
      signal?: AbortSignal
    ) => Promise<{ result: T }>,
    private readonly rawFile: (path: string) => Promise<RawFile>
  ) {}

  private async ask<T>(request: DistributiveOmit<SandboxPodRequest, 'id'>): Promise<T> {
    return (await this.request<T>(request)).result
  }

  async stat(path: string): Promise<FileStat | undefined> {
    return (await this.ask<FileStat | null>({ op: 'stat', path })) ?? undefined
  }

  tree(query: TreeQuery): Promise<TreeResult> {
    return this.ask({ op: 'tree', query })
  }

  read(path: string, query: ReadQuery): Promise<ReadResult> {
    return this.ask({ op: 'read', path, query })
  }

  raw(path: string): Promise<RawFile> {
    return this.rawFile(path)
  }

  search(query: SearchQuery): Promise<SearchResult> {
    return this.ask({ op: 'search', query })
  }

  changes(): Promise<ChangedFile[]> {
    return this.ask({ op: 'changes' })
  }

  diff(format: 'diff' | 'patch', author: PatchAuthor): Promise<string> {
    return this.ask({ op: 'diff', format, author })
  }

  // Planned in the pod and planned again when written: the sandbox does not change in
  // between, the registry holds it.
  async plan(ops: EditOp[]): Promise<EditPlan> {
    const planned = await this.ask<{ files: EditedFile[]; bytes: number }>({ op: 'edit', ops, commit: false })
    return {
      ...planned,
      commit: async () => {
        await this.ask({ op: 'edit', ops, commit: true })
      },
    }
  }
}

type DistributiveOmit<T, K extends keyof any> = T extends any ? Omit<T, K> : never
