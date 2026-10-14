import { execFileSync } from 'child_process'
import { EventEmitter } from 'events'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs'
import { rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { Readable, Writable } from 'stream'
import { create as createTar, extract as extractTar } from 'tar'
import { KubernetesInstance } from '../kubernetes/kubernetes-instance'
import { getKubernetesPersistence, getWorkspacePodSpec } from '../kubernetes/volumes'
import { getCallerNamespace } from './kubernetes-backend'
import { getSandboxNames, KubernetesSandboxStorage } from './kubernetes-sandbox-storage'
import { SandboxFileError } from './sandbox-files'
import { sandboxPodMain } from './sandbox-pod'
import { SandboxError, SandboxRegistry } from './sandboxes'
import { KubernetesBackend, ServerConfig, serverConfigSchema } from './server-config'

const alice = { iss: 'https://idp.corp', sub: 'alice' }
const bob = { iss: 'https://idp.corp', sub: 'bob' }
const REPO = 'git.test/corp/payments'

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8' }
  ).trim()
}

function notFound(): Error {
  return Object.assign(new Error('not found'), { code: 404 })
}

/**
 * A cluster in memory: claims and pods are objects, a claim is a directory, and a command
 * in a pod runs here, on the directory of the claim the pod mounts at /claim, as the pod
 * would run it (`hammerkit server-sandbox`, tar, sh). A claim the pod mounts below /claim
 * is a link there to the claim's directory.
 */
function fakeCluster(root: string) {
  const objects = new Map<string, any>()
  const keyOf = (kind: string, namespace: string, name: string) => `${kind}/${namespace}/${name}`
  const claimDirectory = (namespace: string, claim: string) => join(root, 'claims', namespace, claim)
  const commands: string[][] = []
  let quotaFull = false
  // namespaces the server can not read: those of another server
  const forbidden = new Set<string>()
  // when the claims made next were made
  let created = Date.now() - 2 * 60 * 60 * 1000
  const read = (kind: string, namespace: string, name: string) => {
    const object = objects.get(keyOf(kind, namespace, name))
    if (!object) {
      throw notFound()
    }
    return object
  }
  const instance = {
    objectApi: {
      async create(spec: any) {
        if (spec.kind === 'PersistentVolumeClaim') {
          if (quotaFull) {
            throw Object.assign(new Error('persistentvolumeclaims "x" is forbidden: exceeded quota'), { code: 403 })
          }
          mkdirSync(claimDirectory(spec.metadata.namespace, spec.metadata.name), { recursive: true })
        }
        const object =
          spec.kind === 'Pod'
            ? { ...spec, status: { phase: 'Running' } }
            : spec.kind === 'PersistentVolumeClaim'
              ? { ...spec, metadata: { ...spec.metadata, creationTimestamp: new Date(created) } }
              : spec
        objects.set(keyOf(spec.kind, spec.metadata.namespace, spec.metadata.name), object)
        return object
      },
      async read(spec: any) {
        return read(spec.kind, spec.metadata.namespace, spec.metadata.name)
      },
      async replace(spec: any) {
        read(spec.kind, spec.metadata.namespace, spec.metadata.name)
        objects.set(keyOf(spec.kind, spec.metadata.namespace, spec.metadata.name), spec)
        return spec
      },
      async delete(spec: any) {
        read(spec.kind, spec.metadata.namespace, spec.metadata.name)
        objects.delete(keyOf(spec.kind, spec.metadata.namespace, spec.metadata.name))
      },
    },
    authApi: {
      async createSelfSubjectReview() {
        return { status: { userInfo: { username: 'system:serviceaccount:hammerkit:hammerkit' } } }
      },
    },
    coreApi: {
      async readNamespace({ name }: any) {
        return read('Namespace', '', name)
      },
      async createNamespace({ body }: any) {
        objects.set(keyOf('Namespace', '', body.metadata.name), { kind: 'Namespace', ...body })
      },
      async listNamespace({ labelSelector }: any) {
        const [key, value] = labelSelector.split('=')
        return {
          items: [...objects.values()].filter(
            (object) => object.kind === 'Namespace' && object.metadata.labels?.[key] === value
          ),
        }
      },
      async readNamespacedPod({ name, namespace }: any) {
        return read('Pod', namespace, name)
      },
      async deleteNamespacedPod({ name, namespace }: any) {
        read('Pod', namespace, name)
        objects.delete(keyOf('Pod', namespace, name))
      },
      async deleteNamespacedPersistentVolumeClaim({ name, namespace }: any) {
        read('PersistentVolumeClaim', namespace, name)
        objects.delete(keyOf('PersistentVolumeClaim', namespace, name))
        await rm(claimDirectory(namespace, name), { recursive: true, force: true })
      },
      async listNamespacedPersistentVolumeClaim({ namespace }: any) {
        if (forbidden.has(namespace)) {
          throw Object.assign(new Error('forbidden'), { code: 403 })
        }
        return {
          items: [...objects.values()].filter(
            (object) => object.kind === 'PersistentVolumeClaim' && object.metadata.namespace === namespace
          ),
        }
      },
    },
    exec: {
      async exec(
        namespace: string,
        podName: string,
        _container: string,
        command: string[],
        stdout: Writable,
        stderr: Writable,
        stdin: Readable | null,
        _tty: boolean,
        status: (status: any) => void
      ) {
        commands.push(command)
        const pod = read('Pod', namespace, podName)
        const claimOf = (volume: string) =>
          claimDirectory(
            namespace,
            pod.spec.volumes.find((v: any) => v.name === volume).persistentVolumeClaim.claimName
          )
        const [root, ...below] = pod.spec.containers[0].volumeMounts.filter((m: any) =>
          m.mountPath.startsWith('/claim')
        )
        const directory = claimOf(root.name)
        const local = (path: string) => join(directory, path.replace(/^\/claim\/?/, ''))
        for (const mount of below) {
          const target = join(claimOf(mount.name), mount.subPath ?? '')
          mkdirSync(target, { recursive: true })
          const at = local(mount.mountPath)
          if (!existsSync(at)) {
            mkdirSync(join(at, '..'), { recursive: true })
            symlinkSync(target, at)
          }
        }
        // the pod limits the time of a request with timeout
        if (command[0] === 'timeout') {
          command = command.slice(2)
        }
        const socket = new EventEmitter() as EventEmitter & { close(): void }
        socket.close = () => undefined
        const run = async () => {
          if (command[0] === 'hammerkit') {
            await sandboxPodMain(directory, stdin as Readable, stdout)
          } else if (command[0] === 'tar') {
            await new Promise<void>((resolve, reject) =>
              Readable.from(createTar({ cwd: realpathSync(local(command[4])), portable: true }, ['.']))
                .on('error', reject)
                .on('end', resolve)
                .pipe(stdout, { end: false })
            )
          } else {
            const target = local(command[4])
            await rm(target, { recursive: true, force: true })
            mkdirSync(target, { recursive: true })
            await new Promise<void>((resolve, reject) =>
              (stdin as Readable)
                .pipe(extractTar({ cwd: target }))
                .on('finish', resolve)
                .on('error', reject)
            )
          }
        }
        run().then(
          () => {
            status({ status: 'Success' })
            stdout?.end()
            stderr.end()
            socket.emit('close')
          },
          (e) => {
            stderr.write(String(e))
            status({ status: 'Failure', message: String(e) })
            socket.emit('close')
          }
        )
        return socket
      },
    },
  }
  return {
    instance: instance as unknown as KubernetesInstance,
    objects,
    commands,
    claimDirectory,
    fullQuota: () => (quotaFull = true),
    forbid: (namespace: string) => forbidden.add(namespace),
    makeClaimsAt: (time: number) => (created = time),
  }
}

describe('sandboxes on a cluster', () => {
  let root: string
  let repository: string
  let commit: string
  let cluster: ReturnType<typeof fakeCluster>
  let config: ServerConfig & { backend: KubernetesBackend }
  let holder: string | undefined
  const limits = { count: 5, bytes: 100 * 1024 * 1024, total: 1024 * 1024 * 1024 }
  const namespace = getCallerNamespace('hammerkit-', alice)

  const storageWith = () =>
    new KubernetesSandboxStorage(config, limits, process.env, join(root, 'staging'), cluster.instance)

  const registryWith = (storage = storageWith()) => {
    const registry = new SandboxRegistry({
      storage,
      records: join(root, 'records'),
      limits,
      repos: {
        url: () => repository,
        credentials: async () => ({ env: { ...(process.env as { [key: string]: string }) }, values: [] }),
        pushCredentials: async () => ({ env: { ...(process.env as { [key: string]: string }) }, values: [] }),
        source: () =>
          ({
            match: 'git.test/corp/*',
            secret: { from: 'echo:scm-token', account: 'scm', username: 'x-access-token' },
          }) as any,
        resolve: async (_repo, ref) => git(repository, 'rev-parse', ref),
        scrub: (e) => (e instanceof Error ? e : new Error(String(e))),
      },
    })
    registry.useRuns({ holder: () => holder, stop: async () => undefined })
    return registry
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hammerkit-kubernetes-sandboxes-'))
    repository = join(root, 'repository')
    holder = undefined
    mkdirSync(join(repository, 'src'), { recursive: true })
    git(repository, 'init', '--quiet', '--initial-branch=main')
    git(repository, 'config', 'core.autocrlf', 'false')
    writeFileSync(join(repository, 'src', 'app.ts'), 'export const answer = 41\n')
    writeFileSync(join(repository, '.gitignore'), 'node_modules\n')
    git(repository, 'add', '--all')
    git(repository, 'commit', '--quiet', '-m', 'one')
    commit = git(repository, 'rev-parse', 'HEAD')
    cluster = fakeCluster(root)
    config = serverConfigSchema.parse({
      issuers: [{ issuer: 'https://idp.corp', audience: 'hammerkit' }],
      backend: { type: 'kubernetes', namespace: 'hammerkit', sandboxes: { storageClass: 'sandboxes' } },
    }) as ServerConfig & { backend: KubernetesBackend }
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('keeps a sandbox as a claim in the caller’s namespace, which its pod fetches into', async () => {
    const registry = registryWith()
    const sandbox = await registry.create(alice, REPO, 'main')
    expect(sandbox.commit).toBe(commit)
    const names = getSandboxNames(sandbox.id)
    for (const name of [names.claim, names.git]) {
      const claim = cluster.objects.get(`PersistentVolumeClaim/${namespace}/${name}`)
      expect(claim.spec).toMatchObject({
        accessModes: ['ReadWriteOnce'],
        storageClassName: 'sandboxes',
        resources: { requests: { storage: String(4 * 1024 * 1024 * 1024) } },
      })
      expect(claim.metadata.annotations).toMatchObject({ 'hammerkit.dev/sandbox-id': sandbox.id })
    }
    // the files are alone in their claim, which tasks mount; the git data is in the other,
    // and the fetched repository is gone
    const files = cluster.claimDirectory(namespace, names.claim)
    const data = cluster.claimDirectory(namespace, names.git)
    expect(readFileSync(join(files, 'files', 'src', 'app.ts'), 'utf8')).toContain('41')
    expect(existsSync(join(files, 'files', '.git'))).toBe(false)
    expect(existsSync(join(data, sandbox.id, 'git', 'HEAD'))).toBe(true)
    expect(existsSync(join(data, 'incoming'))).toBe(false)
    // the pod of the files: no network, no token, no more rights than it needs, both claims,
    // on the pool of the tasks and near the pods of runs
    const pod = cluster.objects.get(`Pod/${namespace}/${names.pod}`)
    // left out by the namespace's policy for pods with an open network
    expect(pod.metadata.labels).toMatchObject({ 'hammerkit.dev/network': 'limited' })
    expect(pod.spec).toMatchObject({
      automountServiceAccountToken: false,
      nodeSelector: { 'kubernetes.io/os': 'linux', 'kubernetes.io/arch': 'amd64' },
      securityContext: { seccompProfile: { type: 'RuntimeDefault' } },
      containers: [
        {
          image: config.backend.sandboxes.image,
          resources: { requests: { cpu: '100m', memory: '256Mi' }, limits: { memory: '2Gi' } },
          securityContext: {
            allowPrivilegeEscalation: false,
            readOnlyRootFilesystem: true,
            capabilities: { drop: ['ALL'] },
          },
          volumeMounts: [
            { name: 'git', mountPath: '/claim' },
            { name: 'files', mountPath: `/claim/${sandbox.id}/files`, subPath: 'files' },
            { name: 'tmp', mountPath: '/tmp' },
          ],
        },
      ],
      volumes: [
        { name: 'git', persistentVolumeClaim: { claimName: names.git } },
        { name: 'files', persistentVolumeClaim: { claimName: names.claim } },
        { name: 'tmp', emptyDir: {} },
      ],
    })
    expect(pod.spec.affinity.podAffinity.requiredDuringSchedulingIgnoredDuringExecution[0]).toMatchObject({
      labelSelector: { matchLabels: { 'hammerkit.dev/sandbox': names.label } },
      topologyKey: 'kubernetes.io/hostname',
    })
    const policy = cluster.objects.get(`NetworkPolicy/${namespace}/hammerkit-sandbox-files`)
    expect(policy.spec).toEqual({
      podSelector: { matchLabels: { 'hammerkit.dev/sandbox-files': 'true' } },
      policyTypes: ['Ingress', 'Egress'],
    })
    const quota = cluster.objects.get(`ResourceQuota/${namespace}/hammerkit-sandboxes`)
    expect(quota.spec.hard).toEqual({
      'sandboxes.storageclass.storage.k8s.io/requests.storage': String(2 * limits.bytes),
      'sandboxes.storageclass.storage.k8s.io/persistentvolumeclaims': '10',
    })
    // the read credential stayed with the server: the pod only ran tar and hammerkit
    expect(cluster.commands.map((command) => command.slice(0, 3))).toEqual([
      ['sh', '-c', 'rm -rf "$1" && mkdir -p "$1" && tar xf - -C "$1"'],
      ['timeout', '600', 'hammerkit'],
      ['timeout', '300', 'hammerkit'],
    ])
  })

  it('reads, edits and diffs the files in the pod with the rules of a host', async () => {
    const registry = registryWith()
    const sandbox = await registry.create(alice, REPO, 'main')
    const edited = await registry.edit(alice, sandbox.id, [
      { op: 'replace', path: 'src/app.ts', old_string: '41', new_string: '42' },
      { op: 'write', path: 'data.bin', content: Buffer.from([0, 1, 2, 255]) },
    ])
    expect(edited.map((file) => [file.path, file.change])).toEqual([
      ['data.bin', 'added'],
      ['src/app.ts', 'modified'],
    ])
    const files = registry.files(alice, sandbox.id)
    expect((await files.read('src/app.ts', {})).content).toContain('export const answer = 42')
    const raw = await files.raw('data.bin')
    expect(raw.content).toEqual(Buffer.from([0, 1, 2, 255]))
    expect(raw.stat).toMatchObject({ path: 'data.bin', type: 'file', size: 4 })
    expect(await files.stat('missing.txt')).toBeUndefined()
    const error = await files.read('.env', {}).catch((e) => e)
    expect(error).toBeInstanceOf(SandboxFileError)
    expect(error.status).toBe(403)
    const changes = await registry.read(alice, sandbox.id, (sandboxFiles) => sandboxFiles.changes())
    expect(changes.map((change) => [change.path, change.status])).toEqual([
      ['data.bin', 'added'],
      ['src/app.ts', 'modified'],
    ])
    expect((await registry.state(sandbox.id)).clean).toBe(false)
    // a stale edit is refused as on a host
    const stale = await registry
      .edit(alice, sandbox.id, [{ op: 'replace', path: 'src/app.ts', old_string: '41', new_string: '43' }])
      .catch((e) => e)
    expect(stale).toBeInstanceOf(SandboxFileError)
    expect(stale.status).toBe(422)
  })

  it('reads nothing while a run holds the sandbox: its pods have the claim', async () => {
    const registry = registryWith()
    const sandbox = await registry.create(alice, REPO, 'main')
    holder = 'run_1'
    expect(() => registry.files(alice, sandbox.id)).toThrow(SandboxError)
  })

  it('keeps the sandboxes of callers apart, each in its own namespace', async () => {
    const registry = registryWith()
    const sandbox = await registry.create(alice, REPO, 'main')
    const notMine = async (call: () => unknown) => {
      const error: any = await Promise.resolve()
        .then(call)
        .catch((e) => e)
      expect(error).toBeInstanceOf(SandboxError)
      expect(error.status).toBe(404)
    }
    await notMine(() => registry.files(bob, sandbox.id))
    await notMine(() => registry.read(bob, sandbox.id, (files) => files.changes()))
    await notMine(() => registry.edit(bob, sandbox.id, [{ op: 'write', path: 'x.txt', content: 'x' }]))
    await notMine(() => registry.fetch(bob, sandbox.id, 'main'))
    await notMine(() =>
      registry.push(bob, sandbox.id, 'agent/one', { name: 'bob', email: 'b@corp', message: 'm' }, ['agent/**'])
    )
    expect(await registry.remove(bob, sandbox.id)).toBe(false)
    expect(registry.get(bob, sandbox.id)).toBeUndefined()
    expect(registry.get(alice, sandbox.id)).toBeDefined()

    const other = await registry.create(bob, REPO, 'main')
    const theirs = getCallerNamespace('hammerkit-', bob)
    expect(theirs).not.toBe(namespace)
    for (const id of [sandbox.id, other.id]) {
      const names = getSandboxNames(id)
      const at = id === sandbox.id ? namespace : theirs
      const elsewhere = id === sandbox.id ? theirs : namespace
      expect(cluster.objects.has(`PersistentVolumeClaim/${at}/${names.claim}`)).toBe(true)
      expect(cluster.objects.has(`PersistentVolumeClaim/${elsewhere}/${names.claim}`)).toBe(false)
    }
    expect(existsSync(join(cluster.claimDirectory(namespace, getSandboxNames(sandbox.id).claim), 'files'))).toBe(true)
  })

  it('does not follow a link a task made in the files, in the pod either', async () => {
    const registry = registryWith()
    const sandbox = await registry.create(alice, REPO, 'main')
    const outside = join(root, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'secret.txt'), 'outside-secret\n')
    const files = join(cluster.claimDirectory(namespace, getSandboxNames(sandbox.id).claim), 'files')
    try {
      // as a task can: one link out of the claim, one to where the pod has the git data
      symlinkSync(join(outside, 'secret.txt'), join(files, 'secret.txt'))
      symlinkSync('../git/config', join(files, 'config'))
    } catch {
      // no links to make on this system, so no task makes them either
      return
    }
    const api = registry.files(alice, sandbox.id)
    for (const path of ['secret.txt', 'config']) {
      expect(await api.stat(path)).toMatchObject({ type: 'symlink' })
      expect((await api.read(path, {}).catch((e) => e)).message).toMatch(/is a symbolic link/)
      expect((await api.raw(path).catch((e) => e)).status).toBe(400)
      const replaced = await registry
        .edit(alice, sandbox.id, [{ op: 'replace', path, old_string: 'o', new_string: 'x' }])
        .catch((e) => e)
      expect(replaced).toBeInstanceOf(SandboxFileError)
    }
    expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('outside-secret\n')
  })

  it('copies the files for the run and hands its tasks the claim, without the pod of the files', async () => {
    const registry = registryWith()
    const sandbox = await registry.create(alice, REPO, 'main')
    const names = getSandboxNames(sandbox.id)
    const attached = await registry.attach(sandbox.id, join(root, 'run', 'sandbox'))
    expect(attached).toEqual({
      directory: join(root, 'run', 'sandbox'),
      claim: { name: names.claim, namespace, subPath: 'files', label: names.label },
    })
    expect(readFileSync(join(attached.directory, 'src', 'app.ts'), 'utf8')).toContain('41')
    expect(cluster.objects.has(`Pod/${namespace}/${names.pod}`)).toBe(false)

    // a task of the run mounts its sources from the claim, read and write, and goes
    // where the other pods of the sandbox are
    const kubernetes = {
      server: {
        run: 'run_1',
        namespace: 'hammerkit',
        pools: [],
        providers: {},
        accounts: {},
        workspace: { root: attached.directory, claim: names.claim, subPath: 'files', label: names.label },
      },
    }
    const task = {
      id: () => 'task-1',
      data: {
        type: 'container-task',
        mounts: [],
        src: [
          { absolutePath: join(attached.directory, 'src'), isFile: false, inherited: false },
          { absolutePath: join(attached.directory, 'missing'), isFile: false, inherited: false },
          { absolutePath: join(root, 'elsewhere'), isFile: false, inherited: false },
        ],
        generates: [],
      },
    } as any
    const persistence = await getKubernetesPersistence(task, kubernetes)
    expect(persistence.workspace).toEqual([
      { name: 'hammerkit-sandbox', persistentVolumeClaim: { claimName: names.claim } },
    ])
    expect(persistence.mounts.filter((m) => m.workspace).map((m) => m.mount)).toEqual([
      {
        name: 'hammerkit-sandbox',
        mountPath: join(attached.directory, 'src'),
        subPath: 'files/src',
        readOnly: false,
      },
    ])
    // a source outside of the sandbox is uploaded into the task's own claim, as before
    expect(persistence.sources.map((source) => source.localPath)).toEqual([join(root, 'elsewhere')])
    expect(getWorkspacePodSpec(kubernetes, persistence).labels).toEqual({ 'hammerkit.dev/sandbox': names.label })
  })

  it('removes the claims with the sandbox, and its own claims without a record when it starts', async () => {
    const registry = registryWith()
    const kept = await registry.create(alice, REPO, 'main')
    const removed = await registry.create(alice, REPO, 'main')
    await registry.remove(alice, removed.id)
    const claimsOf = (id: string, at = namespace) =>
      [getSandboxNames(id).claim, getSandboxNames(id).git].filter((name) =>
        cluster.objects.has(`PersistentVolumeClaim/${at}/${name}`)
      )
    expect(claimsOf(removed.id)).toEqual([])

    // claims whose record is gone: one made a while ago, and one that is being made
    const orphan = await registry.create(alice, REPO, 'main')
    rmSync(join(root, 'records', `${orphan.id}.json`))
    cluster.makeClaimsAt(Date.now())
    const fresh = await registry.create(alice, REPO, 'main')
    rmSync(join(root, 'records', `${fresh.id}.json`))
    // and claims of another server, and of another prefix of this one
    const copyClaim = (id: string, at: string, labels: { [key: string]: string } = {}) => {
      for (const name of [getSandboxNames(id).claim, getSandboxNames(id).git]) {
        const claim = { ...cluster.objects.get(`PersistentVolumeClaim/${namespace}/${getSandboxNames(kept.id).claim}`) }
        claim.metadata = {
          ...claim.metadata,
          namespace: at,
          name,
          labels: { ...claim.metadata.labels, ...labels },
          annotations: { ...claim.metadata.annotations, 'hammerkit.dev/sandbox-id': id },
        }
        cluster.objects.set(`PersistentVolumeClaim/${at}/${name}`, claim)
      }
    }
    copyClaim('sbx_otherServer1', namespace, { 'hammerkit.dev/sandbox-server': 'another' })
    copyClaim('sbx_otherPrefix1', 'other-ns')
    // a namespace of this server under another prefix, and one of another server, which
    // this one has no rights in
    const managed = { 'hammerkit.dev/managed': 'true' }
    cluster.objects.set('Namespace//other-ns', { kind: 'Namespace', metadata: { name: 'other-ns', labels: managed } })
    cluster.objects.set('Namespace//foreign-ns', {
      kind: 'Namespace',
      metadata: { name: 'foreign-ns', labels: managed },
    })
    cluster.forbid('foreign-ns')

    const logged: string[] = []
    const restarted = new SandboxRegistry({ ...(registry as any).options, log: (line: string) => logged.push(line) })
    await restarted.load()
    expect(restarted.list(alice).map((sandbox) => sandbox.id)).toEqual([kept.id])
    expect(claimsOf(kept.id)).toHaveLength(2)
    expect(claimsOf(orphan.id)).toEqual([])
    expect(logged).toEqual([`remove the storage of sandbox ${orphan.id}: it has no record`])
    expect(claimsOf(fresh.id)).toHaveLength(2)
    expect(claimsOf('sbx_otherServer1')).toHaveLength(2)
    expect(claimsOf('sbx_otherPrefix1', 'other-ns')).toHaveLength(2)
  })

  it('says the quota of the caller’s sandboxes is reached as a limit', async () => {
    const registry = registryWith()
    cluster.fullQuota()
    const error = await registry.create(alice, REPO, 'main').catch((e) => e)
    expect(error).toBeInstanceOf(SandboxError)
    expect(error.status).toBe(413)
  })

  describe('push', () => {
    const author = { name: 'Alice Agent', email: 'alice@corp.test', message: 'Agent work' }

    it('commits in the pod, and pushes from the server what it checked', async () => {
      const registry = registryWith()
      const sandbox = await registry.create(alice, REPO, 'main')
      await registry.edit(alice, sandbox.id, [
        { op: 'replace', path: 'src/app.ts', old_string: '41', new_string: '42' },
        { op: 'write', path: 'new.txt', content: 'new' },
      ])
      const before = cluster.commands.length
      const pushed = await registry.push(alice, sandbox.id, 'agent/one', author, ['agent/**'])
      const branch = git(repository, 'rev-parse', 'agent/one')
      expect(pushed).toMatchObject({ commit: branch, ref: 'agent/one', pushed: { 'agent/one': branch } })
      expect(git(repository, 'rev-parse', 'agent/one^')).toBe(commit)
      expect(git(repository, 'show', 'agent/one:src/app.ts')).toContain('42')
      expect(git(repository, 'log', '-1', '--format=%an <%ae>|%s', 'agent/one')).toBe(
        'Alice Agent <alice@corp.test>|Agent work'
      )
      // the pod committed, the server copied its git data, the pod moved to the commit:
      // git never ran in the pod with the write credential
      expect(cluster.commands.slice(before).map((command) => command[command[0] === 'timeout' ? 2 : 0])).toEqual([
        'hammerkit',
        'hammerkit',
        'tar',
        'hammerkit',
        'hammerkit',
      ])
      expect(await registry.state(sandbox.id)).toMatchObject({ commit: branch, clean: true })

      // the next push adds to the branch
      await registry.edit(alice, sandbox.id, [{ op: 'write', path: 'new.txt', content: 'newer' }])
      const again = await registry.push(alice, sandbox.id, 'agent/one', { ...author, message: 'More' }, ['agent/**'])
      expect(git(repository, 'rev-parse', 'agent/one')).toBe(again.commit)
      expect(git(repository, 'rev-parse', 'agent/one^')).toBe(branch)
    })

    it('refuses a commit of the pod that is not one on top of the sandbox’s, or has what never leaves', async () => {
      const storage = storageWith()
      const registry = registryWith(storage)
      const sandbox = await registry.create(alice, REPO, 'main')
      const key = { id: sandbox.id, owner: alice }
      const data = join(cluster.claimDirectory(namespace, getSandboxNames(sandbox.id).git), sandbox.id, 'git')
      const pod = (commitOf: () => string) => {
        const request = (storage as any).requestNow.bind(storage)
        ;(storage as any).requestNow = async (k: any, r: any, signal: AbortSignal) =>
          r.op === 'commit' ? { result: commitOf() } : request(k, r, signal)
      }
      // a pod that answers a commit with a file of the deny list in it
      pod(() => {
        const work = join(root, 'forged')
        rmSync(work, { recursive: true, force: true })
        execFileSync('git', ['--git-dir', data, 'worktree', 'add', '--quiet', '--detach', work, 'HEAD'])
        writeFileSync(join(work, '.env'), 'TOKEN=s3cret')
        git(work, 'add', '--force', '.env')
        git(work, 'commit', '--quiet', '-m', 'forged')
        return git(work, 'rev-parse', 'HEAD')
      })
      const request = {
        url: repository,
        branch: 'agent/forged',
        expect: null,
        author,
        env: { ...(process.env as { [key: string]: string }) },
        signal: AbortSignal.timeout(60_000),
      }
      await expect(storage.push(key, request)).rejects.toThrow(/has \.env, which never leaves the server/)
      // or with the run state hammerkit writes next to a task
      pod(() => {
        const work = join(root, 'forged-state')
        execFileSync('git', ['--git-dir', data, 'worktree', 'add', '--quiet', '--detach', work, 'HEAD'])
        mkdirSync(join(work, 'src', '.hammerkit'), { recursive: true })
        writeFileSync(join(work, 'src', '.hammerkit', 'cache.json'), '{}')
        git(work, 'add', '--force', 'src/.hammerkit/cache.json')
        git(work, 'commit', '--quiet', '-m', 'forged')
        return git(work, 'rev-parse', 'HEAD')
      })
      await expect(storage.push(key, request)).rejects.toThrow(
        /has src\/\.hammerkit\/cache\.json, which never leaves the server/
      )
      // a pod that answers a commit of somewhere else
      pod(() => 'f'.repeat(40))
      await expect(storage.push(key, request)).rejects.toThrow()
      expect(git(repository, 'branch', '--list', 'agent/*')).toBe('')
      // its git data was a link out of the claim: nothing of it is copied
      expect(lstatSync(data).isDirectory()).toBe(true)
    })
  })
})
