import { AbortError } from '../executer/abort'
import {
  linkSync,
  rmdirSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'fs'
import { execFileSync } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'
import { EventEmitter } from 'events'
import { Readable } from 'stream'
import { Parser } from 'tar'
import {
  applyWithinQuota,
  clearStateFiles,
  ensurePersistentData,
  getPodForPersistence,
  packSource,
  REMOVE_OTHER_STATES,
  SYNC_FILES,
} from './ensure-persistent-data'
import { getRunLabelValue } from './job-placement'
import { getClaimMountLabel, getStateFilesDir, getVolumeName, LIVE_FILES_DIR } from './volumes'
import { WorkKubernetesEnvironment } from '../planner/work-environment'

// the paths of the entries of an archive
async function listEntries(archive: NodeJS.ReadableStream): Promise<string[]> {
  const paths: string[] = []
  const parser = new Parser({
    onReadEntry: (entry) => {
      paths.push(entry.type === 'Link' ? `${entry.path} -> ${entry.linkpath}` : entry.path)
      entry.resume()
    },
  })
  await new Promise<void>((resolve, reject) => {
    parser.on('end', resolve)
    parser.on('error', reject)
    archive.pipe(parser)
  })
  return paths
}

// whether a file's id is exact, so packArchive packs its other links as links (on Windows
// it is not always)
function hasExactId(path: string): boolean {
  return Number.isSafeInteger(statSync(path).ino)
}

describe('packSource', () => {
  let root: string

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'hammerkit-pack-source-'))
    mkdirSync(join(root, 'api', 'src'), { recursive: true })
    writeFileSync(join(root, 'api', 'package.json'), '{}')
    writeFileSync(join(root, 'api', 'src', 'index.ts'), '')
    linkSync(join(root, 'api', 'src', 'index.ts'), join(root, 'api', 'src', 'linked.ts'))
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('puts a file where its mount reads it in the claim', async () => {
    const archive = packSource({
      localPath: join(root, 'api', 'package.json'),
      subPath: 'package.json-0123456789ab',
      matcher: () => true,
    })
    expect(await listEntries(archive)).toEqual(['package.json-0123456789ab'])
  })

  it('puts a directory and what is in it where its mount reads it in the claim', async () => {
    const archive = packSource({
      localPath: join(root, 'api', 'src'),
      subPath: 'src-0123456789ab',
      matcher: () => true,
    })
    const entries = await listEntries(archive)
    expect(entries[0]).toBe('src-0123456789ab/')
    // one of two hard-linked files links to the other at its place in the claim
    if (hasExactId(join(root, 'api', 'src', 'index.ts'))) {
      expect(entries.slice(1).sort()).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^src-0123456789ab\/(index|linked)\.ts -> src-0123456789ab\/(index|linked)\.ts$/),
        ])
      )
    }
    expect(entries.slice(1).every((entry) => entry.startsWith('src-0123456789ab/'))).toBe(true)
    expect(entries).toHaveLength(3)
  })

  it('packs a directory with several hard links, as links where their id is exact', async () => {
    mkdirSync(join(root, 'linked', 'node_modules'), { recursive: true })
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(root, 'linked', 'node_modules', `file-${i}.js`), `${i}`)
      linkSync(
        join(root, 'linked', 'node_modules', `file-${i}.js`),
        join(root, 'linked', 'node_modules', `link-${i}.js`)
      )
    }
    const archive = packSource({
      localPath: join(root, 'linked', 'node_modules'),
      subPath: 'node_modules-0123456789ab',
      matcher: () => true,
    })
    const entries = await listEntries(archive)
    expect(entries).toHaveLength(11)
    expect(
      entries.filter((entry) =>
        /^node_modules-0123456789ab\/(file|link)-(\d)\.js -> node_modules-0123456789ab\/(file|link)-\2\.js$/.test(entry)
      )
    ).toHaveLength(
      [0, 1, 2, 3, 4].filter((i) => hasExactId(join(root, 'linked', 'node_modules', `file-${i}.js`))).length
    )
  })
})

describe('the pod that copies files into a claim', () => {
  const notFound = () => Object.assign(new Error('not found'), { code: 404 })
  const quotaExceeded = () =>
    Object.assign(
      new Error(
        'HTTP-Code: 403\nBody: pods "x-upload" is forbidden: exceeded quota: hammerkit, requested: limits.memory=4Gi'
      ),
      { code: 403 }
    )
  const pod = { kind: 'Pod', apiVersion: 'v1', metadata: { namespace: 'ns', name: 'x-upload' } } as any

  function withCreate(create: () => Promise<any>) {
    return { objectApi: { read: async () => Promise.reject(notFound()), create } } as any
  }

  it('is created again once the quota of its namespace has room, as a Job would wait', async () => {
    const writes: string[] = []
    let calls = 0
    const created = await applyWithinQuota(
      withCreate(async () => {
        calls++
        if (calls < 3) {
          throw quotaExceeded()
        }
        return { ...pod, status: { phase: 'Pending' } }
      }),
      pod,
      { status: { write: (level: string, message: string) => writes.push(`${level} ${message}`) } } as any,
      1000,
      1
    )
    expect(created.status?.phase).toBe('Pending')
    expect(calls).toBe(3)
    expect(writes).toEqual(['info wait for room under the quota of ns'])
  })

  it('fails with what the cluster said once the quota had no room for its timeout', async () => {
    await expect(
      applyWithinQuota(
        withCreate(async () => Promise.reject(quotaExceeded())),
        pod,
        { status: { write: () => undefined } } as any,
        20,
        1
      )
    ).rejects.toThrow('exceeded quota')
  })

  it('stops waiting once its run is stopped', async () => {
    const abort = new AbortController()
    let calls = 0
    await expect(
      applyWithinQuota(
        withCreate(async () => {
          if (++calls === 2) {
            abort.abort()
          }
          throw quotaExceeded()
        }),
        pod,
        { status: { write: () => undefined } } as any,
        60_000,
        1,
        abort.signal
      )
    ).rejects.toBeInstanceOf(AbortError)
    expect(calls).toBe(2)
  })

  it('fails at once for any other refusal', async () => {
    let calls = 0
    await expect(
      applyWithinQuota(
        withCreate(async () => {
          calls++
          throw Object.assign(new Error('pods "x-upload" is forbidden: User cannot create pods'), { code: 403 })
        }),
        pod,
        { status: { write: () => undefined } } as any,
        1000,
        1
      )
    ).rejects.toThrow('cannot create pods')
    expect(calls).toBe(1)
  })
})

describe('setting up the claim of a task', () => {
  let root: string

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'hammerkit-persistent-data-'))
    writeFileSync(join(root, 'package.json'), '{}')
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  // the console of a work item is what its task printed: what a run log and a sandbox's
  // exec return, so what hammerkit does to set it up goes to its own log only
  it('writes nothing to the output of the task', async () => {
    const pods: any[] = []
    const consoles: string[] = []
    const writes: string[] = []
    const install = {
      id: () => 'install',
      name: 'install',
      data: {},
      status: {
        console: (level: string, message: string) => consoles.push(`${level} ${message}`),
        write: (level: string, message: string) => writes.push(`${level} ${message}`),
      },
    } as any
    const notFound = () => Object.assign(new Error('not found'), { code: 404 })
    const instance = {
      objectApi: {
        read: async () => Promise.reject(notFound()),
        create: async (spec: any) => {
          if (spec.kind !== 'Pod') {
            return spec
          }
          pods.push(spec)
          return { ...spec, status: { phase: 'Running' } }
        },
      },
      coreApi: {
        deleteNamespacedPod: async () => ({}),
        readNamespacedPod: async () => Promise.reject(notFound()),
      },
      exec: {
        exec: async (
          _ns: string,
          _pod: string,
          _container: string,
          _cmd: string[],
          _out: any,
          _err: any,
          data: any
        ) => {
          const res = new EventEmitter()
          // the upload ends with its archive, the clear at once
          if (data instanceof Readable) {
            data.on('end', () => res.emit('close')).resume()
          } else {
            setImmediate(() => res.emit('close'))
          }
          return res
        },
      },
    } as any
    const env = { type: 'kubernetes', namespace: 'ns', httpRoutes: [], networkPolicyEnforced: false } as any
    const persistence = {
      volumes: [{ name: 'hammerkit-install', persistentVolumeClaim: { claimName: 'hammerkit-install' } }],
      sizes: { 'hammerkit-install': null },
      kept: [],
      workspace: [],
      mounts: [
        {
          mount: { name: 'hammerkit-install', mountPath: '/app/package.json', subPath: 'package.json' },
          cwd: '/app',
          uploadPath: '/dev/hammerkit/install',
        },
      ],
      sources: [
        {
          localPath: join(root, 'package.json'),
          containerPath: '/app/package.json',
          subPath: 'package.json',
          stateKey: 'package.json',
          matcher: () => true,
        },
      ],
      initCommands: [],
    }
    const environment = { hosted: false, file: { exists: async () => true }, abortCtrl: new AbortController() } as any

    await ensurePersistentData(instance, env as WorkKubernetesEnvironment, environment, install, persistence, {
      reset: true,
    })

    expect(consoles).toEqual([])
    expect(writes).toEqual(
      expect.arrayContaining([
        'debug ensure volume hammerkit-install',
        'debug start upload container',
        'debug create pod install-install-upload',
        'info clear what an earlier run left in /dev/hammerkit/install',
        `info upload ${join(root, 'package.json')}`,
        'debug delete pod install-install-upload',
      ])
    )
    // not the default limit of the namespace, which is sized for tasks: in run_V3McNvsJmu
    // four tasks and two of these at 4Gi each filled a quota of 26Gi
    expect(pods.map((pod) => pod.spec.containers[0].resources)).toEqual([
      { requests: { cpu: '50m', memory: '64Mi' }, limits: { memory: '512Mi' } },
    ])
  })

  // a service of a service run takes the upload of a move while it serves
  it('keeps the upload pod of a service of a service run out of its Service, beside the pods of its claims', async () => {
    const created: any[] = []
    const api = {
      id: () => 'api',
      name: 'api',
      data: { type: 'container-service' },
      status: { write: () => undefined },
    } as any
    const instance = {
      objectApi: {
        read: async () => Promise.reject(Object.assign(new Error('not found'), { code: 404 })),
        create: async (spec: any) => {
          created.push(spec)
          return spec.kind === 'Pod' ? { ...spec, status: { phase: 'Running' } } : spec
        },
      },
      coreApi: {
        deleteNamespacedPod: async () => ({}),
        readNamespacedPod: async () => Promise.reject(Object.assign(new Error('not found'), { code: 404 })),
      },
    } as any
    const env = {
      type: 'kubernetes',
      namespace: 'hk-run',
      httpRoutes: [],
      networkPolicyEnforced: false,
      server: {
        run: 'run_1',
        serviceRun: true,
        pools: [{ name: 'default', platform: { os: 'linux', arch: 'amd64' } }],
      },
    } as unknown as WorkKubernetesEnvironment
    const persistence = {
      volumes: [{ name: 'hammerkit-api', persistentVolumeClaim: { claimName: 'hammerkit-api' } }],
      sizes: { 'hammerkit-api': null },
      kept: [],
      workspace: [],
      mounts: [
        { mount: { name: 'hammerkit-api', mountPath: '/app/src', subPath: 'src' }, uploadPath: '/dev/hammerkit/api' },
      ],
      sources: [],
      initCommands: [],
    } as any
    await getPodForPersistence(instance, env, api, persistence, 'write', undefined, async () => undefined)
    const pod = created.find((spec) => spec.kind === 'Pod')
    const run = getRunLabelValue('run_1')
    const claim = getClaimMountLabel('hammerkit-api')
    expect(pod.metadata.labels).toEqual({ 'hammerkit.dev/run': run, [claim]: 'mounted' })
    expect(pod.spec.affinity.podAffinity.requiredDuringSchedulingIgnoredDuringExecution[0]).toEqual({
      labelSelector: { matchLabels: { [claim]: 'mounted' } },
      topologyKey: 'kubernetes.io/hostname',
    })
  })
})

// a service run that moves to another commit: the pod of the commit before keeps its files
// until the new one is up, and a put back Deployment finds them again
describe('the files of a service of a service run', () => {
  let root: string

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'hammerkit-state-files-'))
    writeFileSync(join(root, 'package.json'), '{}')
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  async function upload(
    dir: string,
    inUse: string[],
    uploaded: boolean,
    own = true,
    files: { keep?: string[]; live?: boolean } = {}
  ) {
    const commands: string[][] = []
    const archives: string[][] = []
    const writes: string[] = []
    const api = {
      id: () => 'api',
      name: 'api',
      data: { type: 'container-service' },
      status: { write: (level: string, message: string) => writes.push(`${level} ${message}`) },
    } as any
    const notFound = () => Object.assign(new Error('not found'), { code: 404 })
    const instance = {
      objectApi: {
        read: async () => Promise.reject(notFound()),
        create: async (spec: any) => (spec.kind === 'Pod' ? { ...spec, status: { phase: 'Running' } } : spec),
      },
      coreApi: {
        // the pods of the run: one of a Deployment mounts each folder of `inUse`, a Job's does not count
        listNamespacedPod: async () => ({
          items: [
            ...inUse.map((used) => ({
              metadata: { ownerReferences: [{ kind: 'ReplicaSet' }] },
              status: { phase: 'Running' },
              spec: {
                volumes: [{ name: 'claim', persistentVolumeClaim: { claimName: getVolumeName(api, env) } }],
                containers: [{ volumeMounts: [{ name: 'claim', subPath: `${used}/package.json` }] }],
              },
            })),
            {
              metadata: { ownerReferences: [{ kind: 'Job' }] },
              status: { phase: 'Running' },
              spec: {
                volumes: [{ name: 'claim', persistentVolumeClaim: { claimName: getVolumeName(api, env) } }],
                containers: [{ volumeMounts: [{ name: 'claim', subPath: '.hammerkit-files-job/dist' }] }],
              },
            },
          ],
        }),
        deleteNamespacedPod: async () => ({}),
        readNamespacedPod: async () => Promise.reject(notFound()),
      },
      exec: {
        exec: async (
          _ns: string,
          _pod: string,
          _container: string,
          cmd: string[],
          _out: any,
          _err: any,
          data: any,
          _tty: boolean,
          status: (status: any) => void
        ) => {
          const res = new EventEmitter()
          if (data instanceof Readable) {
            commands.push(cmd)
            listEntries(data).then((entries) => {
              archives.push(entries)
              res.emit('close')
            })
          } else {
            commands.push(cmd)
            const failed = cmd[0] === 'test' && !uploaded
            setImmediate(() => {
              status(
                failed
                  ? { status: 'Failure', message: 'command terminated with non-zero exit code' }
                  : { status: 'Success' }
              )
              res.emit('close')
            })
          }
          return res
        },
      },
    } as any
    const env = {
      type: 'kubernetes',
      namespace: 'hk-run',
      httpRoutes: [],
      networkPolicyEnforced: false,
      server: {
        run: 'run_1',
        serviceRun: true,
        pools: [{ name: 'default', platform: { os: 'linux', arch: 'amd64' } }],
      },
    } as unknown as WorkKubernetesEnvironment
    // the claim of the service, or only the one of a dep whose outputs it mounts
    const claim = own ? getVolumeName(api, env) : 'hammerkit-build'
    const persistence = {
      volumes: [{ name: 'hammerkit-api', persistentVolumeClaim: { claimName: claim } }],
      sizes: { 'hammerkit-api': null },
      kept: [],
      workspace: [],
      mounts: [
        {
          mount: {
            name: 'hammerkit-api',
            mountPath: '/app/package.json',
            subPath: `${files.live ? LIVE_FILES_DIR : dir}/package.json`,
          },
          cwd: '/app',
          uploadPath: '/dev/hammerkit/api',
        },
        {
          mount: { name: 'hammerkit-api', mountPath: '/var/lib/data', subPath: 'data' },
          cwd: '/var/lib/data',
          uploadPath: '/dev/hammerkit/api',
        },
      ],
      sources: [
        {
          localPath: join(root, 'package.json'),
          containerPath: '/app/package.json',
          subPath: `${dir}/package.json`,
          stateKey: '',
          matcher: () => true,
        },
      ],
      initCommands: [],
    }
    const environment = { hosted: false, file: { exists: async () => true }, abortCtrl: new AbortController() } as any
    await ensurePersistentData(instance, env, environment, api, persistence, { files: { dir, ...files } })
    return { commands, archives, writes }
  }

  it('go into a folder of their own, and the folders of other commits go apart from the one the pod mounts', async () => {
    const dir = getStateFilesDir('new-state')
    const keep = getStateFilesDir('old-state')
    const { commands, archives } = await upload(dir, [keep], false)
    expect(commands).toEqual([
      ['sh', '-c', REMOVE_OTHER_STATES, 'sh', '/dev/hammerkit/api', dir, keep],
      // what a failed upload left
      ['rm', '-rf', `/dev/hammerkit/api/${dir}`],
      ['tar', 'xf', '-', '-C', '/dev/hammerkit/api'],
      ['sh', '-c', 'mkdir -p "$1" && touch "$1/$2"', 'sh', `/dev/hammerkit/api/${dir}`, '.uploaded'],
    ])
    // not where the pod of the commit before reads its files
    expect(archives).toEqual([[`${dir}/package.json`]])
  })

  it('a restore of a task makes room the same way: other folders go but the mounted ones, its own is emptied', async () => {
    const commands: string[][] = []
    const instance = {
      exec: {
        exec: async (...args: any[]) => {
          commands.push(args[3])
          const res = new EventEmitter()
          setImmediate(() => {
            args[8]({ status: 'Success' })
            res.emit('close')
          })
          return res
        },
      },
    } as any
    const dir = getStateFilesDir('new-state')
    const mounted = [getStateFilesDir('b-state'), getStateFilesDir('a-state')]
    const build = { id: () => 'build', name: 'build', status: { write: () => undefined } } as any
    await clearStateFiles(instance, { namespace: 'hk-run' } as any, build, 'build-upload', dir, new Set(mounted))
    expect(commands).toEqual([
      ['sh', '-c', REMOVE_OTHER_STATES, 'sh', '/dev/hammerkit/build', dir, ...mounted.sort()],
      ['rm', '-rf', `/dev/hammerkit/build/${dir}`],
    ])
  })

  it('are not uploaded again into the folder the pod mounts, once they are there', async () => {
    const dir = getStateFilesDir('new-state')
    const { commands, writes } = await upload(dir, [dir], true)
    expect(commands).toEqual([
      ['sh', '-c', REMOVE_OTHER_STATES, 'sh', '/dev/hammerkit/api', dir, dir],
      ['test', '-e', `/dev/hammerkit/api/${dir}/.uploaded`],
    ])
    expect(writes).toContain('info the files of api are there already')
  })

  it('need no upload pod for a service that only mounts what its deps made', async () => {
    const dir = getStateFilesDir('new-state')
    const { commands } = await upload(dir, [], false, false)
    // its sources are uploaded as before, without a folder of its own to prepare
    expect(commands.map((command) => command[0])).toEqual(['tar'])
  })

  it('of a service that watches them are synced into the folder its pod mounts, from the folder of their state', async () => {
    const dir = getStateFilesDir('new-state')
    const before = getStateFilesDir('old-state')
    const { commands } = await upload(dir, [LIVE_FILES_DIR], false, true, { keep: [before], live: true })
    expect(commands).toEqual([
      // the folder of the state it runs at stays, to put back when the move does not get up
      ['sh', '-c', REMOVE_OTHER_STATES, 'sh', '/dev/hammerkit/api', dir, ...[LIVE_FILES_DIR, before].sort()],
      ['rm', '-rf', `/dev/hammerkit/api/${dir}`],
      ['tar', 'xf', '-', '-C', '/dev/hammerkit/api'],
      ['sh', '-c', 'mkdir -p "$1" && touch "$1/$2"', 'sh', `/dev/hammerkit/api/${dir}`, '.uploaded'],
      [
        'sh',
        '-c',
        SYNC_FILES,
        'sh',
        `/dev/hammerkit/api/${dir}`,
        `/dev/hammerkit/api/${LIVE_FILES_DIR}`,
        'package.json',
      ],
    ])
    // and from there also when they were uploaded already (a move back to the state before)
    const again = await upload(before, [LIVE_FILES_DIR], true, true, { keep: [before], live: true })
    expect(again.commands.slice(-1)).toEqual([
      [
        'sh',
        '-c',
        SYNC_FILES,
        'sh',
        `/dev/hammerkit/api/${before}`,
        `/dev/hammerkit/api/${LIVE_FILES_DIR}`,
        'package.json',
      ],
    ])
  })

  it('are uploaded again when the upload of the state did not go through', async () => {
    const dir = getStateFilesDir('new-state')
    const { archives } = await upload(dir, [dir], false)
    expect(archives).toEqual([[`${dir}/package.json`]])
  })

  it('are synced into the folder a service that watches them mounts, changing only what changed', () => {
    const claim = mkdtempSync(join(tmpdir(), 'hammerkit-live-claim-'))
    try {
      const from = join(claim, '.hammerkit-files-b')
      const live = join(claim, '.hammerkit-files-live')
      for (const dir of [from, live]) {
        mkdirSync(join(dir, 'src', 'app'), { recursive: true })
        writeFileSync(join(dir, 'src', 'app', 'same.ts'), 'same')
        writeFileSync(join(dir, 'angular.json'), dir === from ? '{"new":1}' : '{}')
      }
      writeFileSync(join(from, '.uploaded'), '')
      writeFileSync(join(from, 'src', 'app', 'added.ts'), 'added')
      mkdirSync(join(from, 'src', 'was-file'))
      writeFileSync(join(from, 'src', 'was-file', 'inside.ts'), 'inside')
      // a link needs a privilege on Windows
      const links = process.platform !== 'win32'
      if (links) {
        symlinkSync('app/same.ts', join(from, 'src', 'link.ts'))
      }
      writeFileSync(join(live, 'src', 'app', 'removed.ts'), 'removed')
      mkdirSync(join(live, 'src', 'gone', 'deep'), { recursive: true })
      writeFileSync(join(live, 'src', 'gone', 'deep', 'file.ts'), '')
      writeFileSync(join(live, 'src', 'was-file'), 'a file before')
      // a folder the pod mounts that the commit does not have: it is emptied, not removed
      mkdirSync(join(live, '.github', 'workflows'), { recursive: true })
      writeFileSync(join(live, '.github', 'workflows', 'ci.yaml'), '')
      const github = statSync(join(live, '.github'))
      const same = statSync(join(live, 'src', 'app', 'same.ts'))
      const config = statSync(join(live, 'angular.json'))

      execFileSync('sh', ['-c', SYNC_FILES, 'sh', from, live, '.github', 'angular.json'])

      expect(readdirSync(join(live, '.github'))).toEqual([])
      expect(statSync(join(live, '.github')).ino).toEqual(github.ino)
      rmdirSync(join(live, '.github'))
      const tree = (dir: string): string[] =>
        readdirSync(dir, { recursive: true, encoding: 'utf8' })
          .map((path) => path.split('\\').join('/'))
          .sort()
      expect(tree(live)).toEqual(tree(from).filter((path) => path !== '.uploaded'))
      expect(readFileSync(join(live, 'angular.json'), 'utf8')).toEqual('{"new":1}')
      expect(readFileSync(join(live, 'src', 'was-file', 'inside.ts'), 'utf8')).toEqual('inside')
      if (links) {
        expect(readlinkSync(join(live, 'src', 'link.ts'))).toEqual('app/same.ts')
      }
      // a file that did not change is not written, a changed one is written in place: a pod
      // that mounts it alone keeps seeing it
      expect(statSync(join(live, 'src', 'app', 'same.ts')).mtimeMs).toEqual(same.mtimeMs)
      expect(statSync(join(live, 'angular.json')).ino).toEqual(config.ino)
      // and once more changes nothing
      const before = statSync(join(live, 'angular.json')).mtimeMs
      execFileSync('sh', ['-c', SYNC_FILES, 'sh', from, live])
      expect(statSync(join(live, 'angular.json')).mtimeMs).toEqual(before)
    } finally {
      rmSync(claim, { recursive: true, force: true })
    }
  })

  it('are not synced from a folder that is not there', () => {
    const claim = mkdtempSync(join(tmpdir(), 'hammerkit-live-claim-'))
    try {
      expect(() =>
        execFileSync('sh', ['-c', SYNC_FILES, 'sh', join(claim, 'missing'), join(claim, 'live')], { stdio: 'pipe' })
      ).toThrow(/no files at/)
    } finally {
      rmSync(claim, { recursive: true, force: true })
    }
  })

  it('of other states are removed by the folder they are in only', () => {
    const claim = mkdtempSync(join(tmpdir(), 'hammerkit-state-claim-'))
    try {
      const states = ['a', 'b', 'c', 'd'].map((state) => `.hammerkit-files-${state}`)
      for (const name of [...states, 'data', 'package.json']) {
        mkdirSync(join(claim, name))
      }
      // the state of the work, and two that pods mount
      execFileSync('sh', ['-c', REMOVE_OTHER_STATES, 'sh', claim, states[0], states[2], states[3]])
      expect(readdirSync(claim).sort()).toEqual([states[0], states[2], states[3], 'data', 'package.json'])
      execFileSync('sh', ['-c', REMOVE_OTHER_STATES, 'sh', claim, states[0]])
      expect(readdirSync(claim).sort()).toEqual([states[0], 'data', 'package.json'])
    } finally {
      rmSync(claim, { recursive: true, force: true })
    }
  })
})
