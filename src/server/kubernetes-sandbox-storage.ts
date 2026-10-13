import { createHash, randomBytes } from 'crypto'
import { mkdir, rm } from 'fs/promises'
import { join } from 'path'
import { PassThrough, Readable, Writable } from 'stream'
import { finished } from 'stream/promises'
import { V1NetworkPolicy, V1PersistentVolumeClaim, V1Pod, V1ResourceQuota, V1Status } from '@kubernetes/client-node'
import type { WebSocket } from 'ws'
import { create as createTar, extract as extractTar } from 'tar'
import { KubernetesObjectHeader, replace, statusCodeOf } from '../kubernetes/apply'
import { createKubernetesInstances, KubernetesInstance } from '../kubernetes/kubernetes-instance'
import { NETWORK_LABEL } from '../kubernetes/network-policy'
import { getSandboxAffinity, SANDBOX_LABEL } from '../kubernetes/volumes'
import { getErrorMessage } from '../log'
import { sleep } from '../utils/sleep'
import { formatSize, parseDuration, parseSize } from '../utils/units'
import { getVersion } from '../version'
import { git, isValidRef } from './git-checkout'
import { CallerNamespaces, getClusterAccess } from './kubernetes-backend'
import {
  ChangedFile,
  deniedPath,
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
  SandboxPush,
  SandboxPushConflict,
  SandboxPushFailed,
  SandboxState,
  SandboxStorage,
  StoredSandbox,
} from './sandbox-storage'
import { SandboxError, SandboxLimits } from './sandboxes'
import { KubernetesBackend, ServerConfig } from './server-config'

// A sandbox has two claims. One holds its files (in `files/`), which the tasks of runs
// mount; the other holds its git data, which only the pod of its files mounts, so nothing a
// task does reaches the configuration or the hooks of git: a link a task makes in the files
// leads at most to the root of the claim of the files.
//
// The pod mounts the claim of the git data where a host keeps its sandboxes, and the files
// at `<id>/files` below it, so the code of a host (`hammerkit server-sandbox`) works on it
// unchanged; what the server fetched for it goes to `incoming` there.
const CLAIM_PATH = '/claim'
const FILES_DIRECTORY = 'files'
const MANAGED = { 'hammerkit.dev/managed': 'true' }
// the claims of the sandboxes of one server (its prefix of caller namespaces and its own
// namespace): another server on the cluster leaves them alone
const SERVER_LABEL = 'hammerkit.dev/sandbox-server'
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
// what is sent into a pod and not taken by the cluster yet, before the server waits
const MAX_STDIN_BUFFERED = 4 * 1024 * 1024

// The names of a sandbox on the cluster: its id has letters of both cases and `_`, which
// names and labels can not all take, so they carry a hash of it.
export function getSandboxNames(id: string): { claim: string; git: string; pod: string; label: string } {
  const label = createHash('sha256').update(id).digest('hex').slice(0, 20)
  return {
    claim: `hammerkit-sandbox-${label}`,
    git: `hammerkit-sandbox-${label}-git`,
    pod: `hammerkit-sandbox-${label}-files`,
    label,
  }
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
 * Sandboxes on a cluster: PersistentVolumeClaims per sandbox in its caller's namespace (its
 * files, and its git data), mounted only while a task of a run on it or a short pod for its
 * files runs. An idle sandbox costs its storage only.
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
 * - A push is made by the server: the pod commits the changes, the server copies the
 *   objects of the sandbox's git data, checks the commit and pushes it with the write
 *   credential, which never enters the caller's namespace either.
 * - With `backend.sandboxes.storageClass`, a ResourceQuota on that class in the
 *   caller's namespace holds `sandboxes.limits` on the cluster as well.
 */
export class KubernetesSandboxStorage implements SandboxStorage {
  readonly readsWhileHeld = false

  private readonly instance: KubernetesInstance
  private readonly namespaces: CallerNamespaces
  private readonly backend: KubernetesBackend
  private readonly pods = new Map<string, FilesPod>()
  private readonly server: string
  // the namespaces whose policy and quota for sandboxes this process has applied
  private readonly prepared = new Map<string, Promise<void>>()
  // one request at a time per sandbox, as a host has it: the objects `state` writes are
  // pruned again in the pod, which must not meet another request that still needs them
  private readonly queues = new Map<string, Promise<unknown>>()

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
    this.server = createHash('sha256')
      .update(`${config.backend.namespacePrefix}\n${config.backend.namespace ?? ''}`)
      .digest('hex')
      .slice(0, 20)
  }

  async create(key: SandboxKey, fetch: SandboxFetch): Promise<string> {
    const namespace = this.namespaces.name(key.owner)
    await this.namespaces.prepare(namespace)
    await this.prepare(namespace)
    const names = getSandboxNames(key.id)
    try {
      await this.createClaim(key, namespace, names.git)
      await this.createClaim(key, namespace, names.claim)
      return await this.receive(key, fetch, 'create')
    } catch (e) {
      await this.remove(key).catch(() => undefined)
      throw e
    }
  }

  private async createClaim(key: SandboxKey, namespace: string, name: string): Promise<void> {
    const sandboxes = this.backend.sandboxes
    const claim: V1PersistentVolumeClaim & KubernetesObjectHeader = {
      apiVersion: 'v1',
      kind: 'PersistentVolumeClaim',
      metadata: {
        name,
        namespace,
        labels: { ...MANAGED, [SANDBOX_LABEL]: getSandboxNames(key.id).label, [SERVER_LABEL]: this.server },
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

  /**
   * The pod commits the changes; the server takes the objects of the sandbox's git data
   * (not its configuration), checks that the commit is one on top of the sandbox's that
   * leaves out the deny list, and pushes it. The pod of the files can not make the server
   * push something else, and the write credential stays with the server.
   */
  async push(key: SandboxKey, push: SandboxPush): Promise<string | undefined> {
    // the commit is copied out and pushed before a `state` may prune it again
    return this.exclusive(key.id, () => this.commitAndPush(key, push))
  }

  private async commitAndPush(key: SandboxKey, push: SandboxPush): Promise<string | undefined> {
    const commit = (
      await this.requestNow<string | null>(key, { op: 'commit', id: key.id, author: push.author }, push.signal)
    ).result
    if (commit === null) {
      return undefined
    }
    if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(commit)) {
      throw new Error(`the pod of the sandbox ${key.id} did not answer a commit`)
    }
    const repository = join(this.staging, `${key.id}-push-${randomBytes(6).toString('hex')}.git`)
    const what = `sandbox ${key.id}`
    const env = defined(this.env)
    const run = (args: string[], action: string, runEnv: { [key: string]: string } = env) =>
      git(
        [`--git-dir=${repository}`, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args],
        runEnv,
        push.signal,
        what,
        action
      )
    try {
      await mkdir(this.staging, { recursive: true, mode: 0o700 })
      await git(['init', '--quiet', '--bare', repository], env, push.signal, what, 'push')
      // objects and where the shallow history ends, nothing that configures git or points
      // it at other repositories (objects/info)
      await this.copyOut(
        key,
        ['tar', 'cf', '-', '-C', `${CLAIM_PATH}/${key.id}/git`, '.'],
        repository,
        (path, type) =>
          (type === 'File' &&
            /^(\.\/)?(shallow|objects\/[0-9a-f]{2}\/[0-9a-f]+|objects\/pack\/pack-[0-9a-f]+\.(pack|idx))$/.test(
              path
            )) ||
          (type === 'Directory' && /^(\.\/)?(objects(\/([0-9a-f]{2}|pack))?\/?)?$/.test(path)),
        push.signal
      )
      const [found, ...parents] = (await run(['rev-list', '--parents', '-n', '1', commit], 'read')).trim().split(' ')
      if (found !== commit || parents.length !== 1) {
        throw new Error(`${commit} of the sandbox ${key.id} is not one commit on top of the sandbox's`)
      }
      const changed = (
        await run(
          ['diff-tree', '-r', '-z', '--no-commit-id', '--name-only', '--no-renames', parents[0], commit],
          'read'
        )
      )
        .split('\0')
        .filter((path) => path.length > 0)
      const denied = changed.find((path) => deniedPath(path))
      if (denied) {
        throw new Error(`the commit of the sandbox ${key.id} has ${denied}, which never leaves the server`)
      }
      // a branch this sandbox pushed before only moves forward
      if (push.expect) {
        const ancestor = await run(['merge-base', '--is-ancestor', push.expect, commit], 'read').then(
          () => true,
          () => false
        )
        if (!ancestor) {
          throw new SandboxPushConflict(
            `${push.branch} is at ${push.expect}, which the sandbox is no longer on: push to a new branch`
          )
        }
      }
      try {
        await run(
          [
            'push',
            '--quiet',
            '--no-verify',
            `--force-with-lease=refs/heads/${push.branch}:${push.expect ?? ''}`,
            '--',
            push.url,
            `${commit}:refs/heads/${push.branch}`,
          ],
          'push',
          // the write credential is in the environment of this one git process
          push.env
        )
      } catch (e) {
        throw new SandboxPushFailed(commit, e)
      }
      return commit
    } finally {
      await rm(repository, { recursive: true, force: true })
    }
  }

  async moveTo(key: SandboxKey, commit: string): Promise<void> {
    await this.request(key, { op: 'move', id: key.id, commit }, AbortSignal.timeout(FETCH_TIMEOUT_MS))
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
    await this.copyOut(
      key,
      ['tar', 'cf', '-', '-C', `${CLAIM_PATH}/${key.id}/files`, '.'],
      into,
      // what the run plans with: files, directories and links, nothing outside of it
      (_path, type) => ['File', 'OldFile', 'ContiguousFile', 'Directory', 'SymbolicLink'].includes(type),
      AbortSignal.timeout(FETCH_TIMEOUT_MS)
    )
    await this.stopPod(key)
    return {
      directory: into,
      claim: { name: names.claim, namespace, subPath: FILES_DIRECTORY, label: names.label },
    }
  }

  // What a tar in the pod writes, extracted into `into`: the entries `keep` takes, up to
  // the bytes a sandbox may take.
  private async copyOut(
    key: SandboxKey,
    command: string[],
    into: string,
    keep: (path: string, type: string) => boolean,
    signal: AbortSignal
  ): Promise<void> {
    let bytes = 0
    const extract = extractTar({
      cwd: into,
      filter: (path, entry) => 'type' in entry && keep(path, entry.type),
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
    await this.withPod(key, (pod) => this.exec(pod, command, null, counted, signal))
    counted.end()
    await extracted
  }

  async remove(key: SandboxKey): Promise<void> {
    await this.removeIn(this.namespaces.name(key.owner), key.id)
  }

  private async removeIn(namespace: string, id: string): Promise<void> {
    const names = getSandboxNames(id)
    await this.stopPod({ id, owner: { iss: '', sub: '' } }, namespace)
    for (const name of [names.claim, names.git]) {
      try {
        await this.instance.coreApi.deleteNamespacedPersistentVolumeClaim({ name, namespace })
      } catch (e) {
        if (statusCodeOf(e) !== 404) {
          throw e
        }
      }
    }
  }

  // The claims of sandboxes on the cluster. Those of this server, in the namespace their
  // owner has, are removed when they have no record; the others are kept, and their records
  // too (a server that changed its prefix still has them).
  async list(): Promise<StoredSandbox[]> {
    // the server has rights in the namespaces it made only (runRole, bound there): it looks
    // for claims in those, and passes over one it can not read, another server's
    const namespaces = await this.instance.coreApi.listNamespace({ labelSelector: 'hammerkit.dev/managed=true' })
    const claims: V1PersistentVolumeClaim[] = []
    for (const namespace of namespaces.items) {
      const name = namespace.metadata?.name
      if (!name || namespace.metadata?.deletionTimestamp) {
        continue
      }
      try {
        const listed = await this.instance.coreApi.listNamespacedPersistentVolumeClaim({
          namespace: name,
          labelSelector: `hammerkit.dev/managed=true,${SANDBOX_LABEL}`,
        })
        claims.push(...listed.items)
      } catch (e) {
        if (statusCodeOf(e) !== 403) {
          throw e
        }
      }
    }
    const found = new Map<string, StoredSandbox>()
    for (const claim of claims) {
      const annotations = claim.metadata?.annotations ?? {}
      const id = annotations[ID_ANNOTATION]
      const namespace = claim.metadata?.namespace
      if (!id || !namespace || claim.metadata?.deletionTimestamp) {
        continue
      }
      const names = getSandboxNames(id)
      if (claim.metadata?.name !== names.claim && claim.metadata?.name !== names.git) {
        continue
      }
      const owner = { iss: annotations[ISS_ANNOTATION] ?? '', sub: annotations[SUB_ANNOTATION] ?? '' }
      const ours = claim.metadata?.labels?.[SERVER_LABEL] === this.server && this.namespaces.name(owner) === namespace
      const created = claim.metadata?.creationTimestamp ? new Date(claim.metadata.creationTimestamp) : new Date()
      const seen = found.get(id)
      found.set(id, {
        id,
        ...((seen ? seen.remove : true) && ours ? { remove: () => this.removeIn(namespace, id) } : {}),
        createdAt: seen?.createdAt && seen.createdAt > created ? seen.createdAt : created,
      })
    }
    return [...found.values()]
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

  private request<T>(
    key: SandboxKey,
    request: SandboxPodRequest,
    signal: AbortSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  ): Promise<{ result: T }> {
    return this.exclusive(key.id, () => this.requestNow<T>(key, request, signal))
  }

  private async requestNow<T>(
    key: SandboxKey,
    request: SandboxPodRequest,
    signal: AbortSignal
  ): Promise<{ result: T }> {
    const answer = await this.call(key, request, signal, false)
    return { result: answer.result as T }
  }

  private exclusive<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(id) ?? Promise.resolve()
    const next = previous.then(fn, fn)
    const settled = next.catch(() => undefined)
    this.queues.set(id, settled)
    void settled.then(() => {
      if (this.queues.get(id) === settled) {
        this.queues.delete(id)
      }
    })
    return next
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
    // the process ends when the server stops waiting for it: closing the connection does
    // not end a command in a pod
    const seconds = Math.ceil(
      (['create', 'fetch', 'move'].includes(request.op) ? FETCH_TIMEOUT_MS : REQUEST_TIMEOUT_MS) / 1000
    )
    const done = this.withPod(key, (pod) =>
      this.exec(
        pod,
        ['timeout', String(seconds), 'hammerkit', 'server-sandbox', CLAIM_PATH],
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
    // where the pods of runs go: the first pool, which container tasks run on, so that a
    // claim a zonal class provisions for this pod is where the tasks can mount it
    const pool = this.backend.pools[0]
    const resources = this.backend.sandboxes.resources
    const pod: V1Pod & KubernetesObjectHeader = {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: {
        name: names.pod,
        namespace,
        // the NetworkPolicy of the caller's namespace for pods with an open network leaves
        // it out: its own policy, no network at all, is all it gets
        labels: { ...MANAGED, [SANDBOX_LABEL]: names.label, [FILES_LABEL]: 'true', [NETWORK_LABEL]: 'none' },
        annotations: { 'hammerkit.dev/version': getVersion() },
      },
      spec: {
        automountServiceAccountToken: false,
        enableServiceLinks: false,
        restartPolicy: 'Never',
        activeDeadlineSeconds: POD_DEADLINE_SECONDS,
        terminationGracePeriodSeconds: 0,
        nodeSelector: {
          'kubernetes.io/os': pool.platform.os,
          'kubernetes.io/arch': pool.platform.arch,
          ...pool.nodeSelector,
        },
        ...(pool.tolerations.length > 0 ? { tolerations: pool.tolerations } : {}),
        affinity: getSandboxAffinity(names.label),
        securityContext: { seccompProfile: { type: 'RuntimeDefault' } },
        containers: [
          {
            name: 'files',
            image: this.backend.sandboxes.image,
            command: ['sleep', String(POD_DEADLINE_SECONDS)],
            workingDir: CLAIM_PATH,
            env: [{ name: 'HOME', value: '/tmp' }],
            ...(resources.requests || resources.limits ? { resources } : {}),
            // root, as tasks may run as root and write files only root may change, but
            // with no more than the capabilities to own and change any file of the claims
            securityContext: {
              allowPrivilegeEscalation: false,
              readOnlyRootFilesystem: true,
              capabilities: { drop: ['ALL'], add: ['CHOWN', 'DAC_OVERRIDE', 'FOWNER'] },
            },
            volumeMounts: [
              { name: 'git', mountPath: CLAIM_PATH },
              { name: 'files', mountPath: `${CLAIM_PATH}/${key.id}/files`, subPath: FILES_DIRECTORY },
              { name: 'tmp', mountPath: '/tmp' },
            ],
          },
        ],
        volumes: [
          { name: 'git', persistentVolumeClaim: { claimName: names.git } },
          { name: 'files', persistentVolumeClaim: { claimName: names.claim } },
          { name: 'tmp', emptyDir: {} },
        ],
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
    await replace(this.instance, policy)
    const storageClass = this.backend.sandboxes.storageClass
    if (!storageClass) {
      // one an earlier config had
      await this.instance.objectApi
        .delete({ apiVersion: 'v1', kind: 'ResourceQuota', metadata: { ...metadata, name: QUOTA_NAME } })
        .catch((e) => (statusCodeOf(e) === 404 ? undefined : Promise.reject(e)))
    } else {
      const scope = `${storageClass}.storageclass.storage.k8s.io`
      const quota: V1ResourceQuota & KubernetesObjectHeader = {
        apiVersion: 'v1',
        kind: 'ResourceQuota',
        metadata: { ...metadata, name: QUOTA_NAME },
        spec: {
          hard: {
            // two claims of a sandbox, both of `size`
            [`${scope}/requests.storage`]: String(2 * this.limits.bytes),
            [`${scope}/persistentvolumeclaims`]: String(2 * this.limits.count),
          },
        },
      }
      await replace(this.instance, quota)
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
    // the stdin of the command waits on the connection, which is there once it started
    const connection: { socket?: WebSocket } = {}
    const socket = await this.instance.exec.exec(
      pod.namespace,
      pod.name,
      'files',
      command,
      stdout ?? new Writable({ write: (_chunk, _encoding, callback) => callback() }),
      errors,
      stdin && throttle(stdin, () => connection.socket),
      false,
      (received) => {
        status = received
      }
    )
    connection.socket = socket
    if (stdout) {
      holdBack(socket, stdout)
    }
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

function defined(env: { [key: string]: string | undefined }): { [key: string]: string } {
  const result: { [key: string]: string } = {}
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      result[key] = value
    }
  }
  return result
}

// The client of the cluster sends what stdin has as fast as it comes: this waits while the
// connection has more than MAX_STDIN_BUFFERED not sent yet.
function throttle(stdin: Readable, connection: () => WebSocket | undefined): Readable {
  return Readable.from(
    (async function* () {
      for await (const chunk of stdin) {
        while ((connection()?.bufferedAmount ?? 0) > MAX_STDIN_BUFFERED) {
          await sleep(10)
        }
        yield chunk
      }
    })()
  )
}

// The client of the cluster writes what the pod sends to stdout without waiting for it to
// be taken: this stops reading from the connection while stdout is full, so a slow reader
// of a file or of the files of a run holds the pod back instead of the server's memory.
function holdBack(socket: WebSocket, stdout: Writable): void {
  const tcp = (socket as unknown as { _socket?: { pause(): void; resume(): void } })._socket
  if (!tcp) {
    return
  }
  let paused = false
  socket.on('message', () => {
    if (paused || !stdout.writableNeedDrain) {
      return
    }
    paused = true
    tcp.pause()
    const resume = () => {
      paused = false
      stdout.off('close', resume)
      stdout.off('drain', resume)
      tcp.resume()
    }
    stdout.once('drain', resume)
    stdout.once('close', resume)
  })
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
      // what came before has no newline: only this chunk is searched
      const found = chunk.indexOf(10)
      if (found < 0) {
        callback()
        return
      }
      const all = Buffer.concat(this.chunks)
      const newline = this.size - chunk.length + found
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

  async commit(author: PatchAuthor): Promise<string | undefined> {
    return (await this.ask<string | null>({ op: 'commit', author })) ?? undefined
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
