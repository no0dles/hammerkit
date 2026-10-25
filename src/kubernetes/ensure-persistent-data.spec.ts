import { linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { EventEmitter } from 'events'
import { Readable } from 'stream'
import { Parser } from 'tar'
import { ensurePersistentData, packSource } from './ensure-persistent-data'
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
    expect(entries.slice(1).sort()).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^src-0123456789ab\/(index|linked)\.ts -> src-0123456789ab\/(index|linked)\.ts$/),
      ])
    )
    expect(entries.slice(1).every((entry) => entry.startsWith('src-0123456789ab/'))).toBe(true)
    expect(entries).toHaveLength(3)
  })

  it('packs a directory with several hard links as links', async () => {
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
    ).toHaveLength(5)
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
})
