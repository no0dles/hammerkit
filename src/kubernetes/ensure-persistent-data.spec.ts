import { linkSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs'
import { execFileSync } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'
import { EventEmitter } from 'events'
import { Readable } from 'stream'
import { Parser } from 'tar'
import { ensurePersistentData, getPodForPersistence, packSource, REMOVE_OTHER_STATES } from './ensure-persistent-data'
import { getRunLabelValue } from './job-placement'
import { getClaimMountLabel, getStateFilesDir, getVolumeName } from './volumes'
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
        create: async (spec: any) => (spec.kind === 'Pod' ? { ...spec, status: { phase: 'Running' } } : spec),
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
    const environment = { hosted: false, file: { exists: async () => true } } as any

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
    await getPodForPersistence(instance, env, api, persistence, 'write', async () => undefined)
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

  async function upload(dir: string, inUse: string[], uploaded: boolean) {
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
    const persistence = {
      volumes: [{ name: 'hammerkit-api', persistentVolumeClaim: { claimName: 'hammerkit-api' } }],
      sizes: { 'hammerkit-api': null },
      kept: [],
      workspace: [],
      mounts: [
        {
          mount: { name: 'hammerkit-api', mountPath: '/app/package.json', subPath: `${dir}/package.json` },
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
    const environment = { hosted: false, file: { exists: async () => true } } as any
    await ensurePersistentData(instance, env, environment, api, persistence, { files: { dir } })
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

  it('are not uploaded again into the folder the pod mounts, once they are there', async () => {
    const dir = getStateFilesDir('new-state')
    const { commands, writes } = await upload(dir, [dir], true)
    expect(commands).toEqual([
      ['sh', '-c', REMOVE_OTHER_STATES, 'sh', '/dev/hammerkit/api', dir, dir],
      ['test', '-e', `/dev/hammerkit/api/${dir}/.uploaded`],
    ])
    expect(writes).toContain('info the files of api are there already')
  })

  it('are uploaded again when the upload of the state did not go through', async () => {
    const dir = getStateFilesDir('new-state')
    const { archives } = await upload(dir, [dir], false)
    expect(archives).toEqual([[`${dir}/package.json`]])
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
