import { execFileSync } from 'child_process'
import { EventEmitter } from 'events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
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
 * in a pod runs here, on the directory of the claim the pod mounts, as the pod would run
 * it (`hammerkit server-sandbox`, tar, sh).
 */
function fakeCluster(root: string) {
  const objects = new Map<string, any>()
  const keyOf = (kind: string, namespace: string, name: string) => `${kind}/${namespace}/${name}`
  const claimDirectory = (namespace: string, claim: string) => join(root, 'claims', namespace, claim)
  const commands: string[][] = []
  let quotaFull = false
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
        const object = spec.kind === 'Pod' ? { ...spec, status: { phase: 'Running' } } : spec
        objects.set(keyOf(spec.kind, spec.metadata.namespace, spec.metadata.name), object)
        return object
      },
      async read(spec: any) {
        return read(spec.kind, spec.metadata.namespace, spec.metadata.name)
      },
      async patch(spec: any) {
        objects.set(keyOf(spec.kind, spec.metadata.namespace, spec.metadata.name), spec)
        return spec
      },
    },
    coreApi: {
      async readNamespace() {
        return {}
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
      async listPersistentVolumeClaimForAllNamespaces() {
        return { items: [...objects.values()].filter((object) => object.kind === 'PersistentVolumeClaim') }
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
        const directory = claimDirectory(namespace, pod.spec.volumes[0].persistentVolumeClaim.claimName)
        const local = (path: string) => join(directory, path.replace(/^\/claim\/?/, ''))
        const socket = new EventEmitter() as EventEmitter & { close(): void }
        socket.close = () => undefined
        const run = async () => {
          if (command[0] === 'hammerkit') {
            await sandboxPodMain(directory, stdin as Readable, stdout)
          } else if (command[0] === 'tar') {
            await new Promise<void>((resolve, reject) =>
              Readable.from(createTar({ cwd: local(command[4]), portable: true }, ['.']))
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
    const claim = cluster.objects.get(`PersistentVolumeClaim/${namespace}/${names.claim}`)
    expect(claim.spec).toMatchObject({
      accessModes: ['ReadWriteOnce'],
      storageClassName: 'sandboxes',
      resources: { requests: { storage: String(4 * 1024 * 1024 * 1024) } },
    })
    expect(claim.metadata.annotations).toMatchObject({ 'hammerkit.dev/sandbox-id': sandbox.id })
    // the files and the git data are next to each other in the claim, the fetched
    // repository is gone
    const directory = cluster.claimDirectory(namespace, names.claim)
    expect(readFileSync(join(directory, sandbox.id, 'files', 'src', 'app.ts'), 'utf8')).toContain('41')
    expect(existsSync(join(directory, sandbox.id, 'git', 'HEAD'))).toBe(true)
    expect(existsSync(join(directory, 'incoming'))).toBe(false)
    // the pod of the files: no network, no token, the claim, near the pods of runs
    const pod = cluster.objects.get(`Pod/${namespace}/${names.pod}`)
    expect(pod.spec).toMatchObject({
      automountServiceAccountToken: false,
      containers: [{ image: config.backend.sandboxes.image, volumeMounts: [{ mountPath: '/claim' }] }],
      volumes: [{ persistentVolumeClaim: { claimName: names.claim } }],
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
      'sandboxes.storageclass.storage.k8s.io/requests.storage': String(limits.bytes),
      'sandboxes.storageclass.storage.k8s.io/persistentvolumeclaims': '5',
    })
    // the read credential stayed with the server: the pod only ran hammerkit and tar
    expect(cluster.commands.map((command) => command[0])).toEqual(['sh', 'hammerkit', 'hammerkit'])
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

  it('copies the files for the run and hands its tasks the claim, without the pod of the files', async () => {
    const registry = registryWith()
    const sandbox = await registry.create(alice, REPO, 'main')
    const names = getSandboxNames(sandbox.id)
    const attached = await registry.attach(sandbox.id, join(root, 'run', 'sandbox'))
    expect(attached).toEqual({
      directory: join(root, 'run', 'sandbox'),
      claim: { name: names.claim, namespace, subPath: `${sandbox.id}/files`, label: names.label },
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
        workspace: { root: attached.directory, claim: names.claim, subPath: `${sandbox.id}/files`, label: names.label },
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
        subPath: `${sandbox.id}/files/src`,
        readOnly: false,
      },
    ])
    // a source outside of the sandbox is uploaded into the task's own claim, as before
    expect(persistence.sources.map((source) => source.localPath)).toEqual([join(root, 'elsewhere')])
    expect(getWorkspacePodSpec(kubernetes, persistence).labels).toEqual({ 'hammerkit.dev/sandbox': names.label })
  })

  it('removes the claim with the sandbox, and claims without a record when it starts', async () => {
    const registry = registryWith()
    const kept = await registry.create(alice, REPO, 'main')
    const removed = await registry.create(alice, REPO, 'main')
    await registry.remove(alice, removed.id)
    expect(cluster.objects.has(`PersistentVolumeClaim/${namespace}/${getSandboxNames(removed.id).claim}`)).toBe(false)

    // a claim whose record is gone, and one of another server's prefix
    const orphan = await registry.create(alice, REPO, 'main')
    rmSync(join(root, 'records', `${orphan.id}.json`))
    const foreign = { ...cluster.objects.get(`PersistentVolumeClaim/${namespace}/${getSandboxNames(kept.id).claim}`) }
    foreign.metadata = { ...foreign.metadata, namespace: 'other-ns', name: getSandboxNames('sbx_foreign').claim }
    foreign.metadata.annotations = { ...foreign.metadata.annotations, 'hammerkit.dev/sandbox-id': 'sbx_foreign' }
    cluster.objects.set(`PersistentVolumeClaim/other-ns/${foreign.metadata.name}`, foreign)

    const restarted = registryWith()
    await restarted.load()
    expect(restarted.list(alice).map((sandbox) => sandbox.id)).toEqual([kept.id])
    expect(cluster.objects.has(`PersistentVolumeClaim/${namespace}/${getSandboxNames(orphan.id).claim}`)).toBe(false)
    expect(cluster.objects.has(`PersistentVolumeClaim/other-ns/${foreign.metadata.name}`)).toBe(true)
  })

  it('says the quota of the caller’s sandboxes is reached as a limit', async () => {
    const registry = registryWith()
    cluster.fullQuota()
    const error = await registry.create(alice, REPO, 'main').catch((e) => e)
    expect(error).toBeInstanceOf(SandboxError)
    expect(error.status).toBe(413)
  })
})
