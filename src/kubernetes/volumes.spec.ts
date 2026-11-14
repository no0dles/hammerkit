import {
  appendVolume,
  getClaimMountLabel,
  getMountedSources,
  getStateFilesDir,
  getKubernetesPersistence,
  getVolumeName,
  getWorkspacePodSpec,
  isLiveService,
  KubernetesPersistence,
  LIVE_FILES_DIR,
} from './volumes'
import { getRestoreTarget } from './restore-kubernetes-data'
import { ENSURE_OUTPUT_FILES, packSource } from './ensure-persistent-data'
import { extract } from 'tar'
import { pipeline } from 'stream/promises'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { execFileSync } from 'child_process'
import { tmpdir } from 'os'
import { extname, join } from 'path'
import { WorkItem } from '../planner/work-item'
import { ContainerWorkService, WorkService } from '../planner/work-service'
import { ContainerWorkTask, WorkTask } from '../planner/work-task'

function makeWorkItem<T extends WorkTask | WorkService>(id: string, data: T): WorkItem<T> {
  return { id: () => id, data } as any
}

describe('getVolumeName', () => {
  it('prefixes the item id with hammerkit-', () => {
    const item = makeWorkItem('w1', { type: 'container-task' } as unknown as WorkTask)
    expect(getVolumeName(item, {})).toBe('hammerkit-w1')
  })
})

describe('getKubernetesPersistence for a container task', () => {
  it('creates one volume per distinct source work item and mounts for generates', async () => {
    const generator = makeWorkItem('gen-1', {} as WorkTask)
    const work = makeWorkItem<ContainerWorkTask>('task-1', {
      type: 'container-task',
      name: 'task-1',
      mounts: [{ localPath: '/local/mount', containerPath: '/data/mount', isFile: false, mount: 'm1' }],
      src: [{ absolutePath: '/repo/src', inherited: null, isFile: false, source: '', matcher: () => true }],
      generates: [
        {
          path: '/data/out.txt',
          volumeName: '',
          inherited: generator,
          resetOnChange: false,
          export: true,
          isFile: true,
        },
        {
          path: '/other/out.txt',
          volumeName: '',
          inherited: null,
          resetOnChange: false,
          export: false,
          isFile: false,
        },
      ],
    } as unknown as ContainerWorkTask)

    const persistence = await getKubernetesPersistence(work, {})

    // each claim is of the size its own work states, the generator's for what it made
    expect(persistence.sizes).toEqual({ 'hammerkit-task-1': null, 'hammerkit-gen-1': null })
    ;(generator.data as ContainerWorkTask).volumeSize = '5Gi'
    expect((await getKubernetesPersistence(work, {})).sizes).toEqual({
      'hammerkit-task-1': null,
      'hammerkit-gen-1': '5Gi',
    })

    // on a server that keeps them, the claims of tasks are named by the run's scope and stay
    expect(persistence.kept).toEqual([])
    ;(generator.data as any).type = 'container-task'
    const server = { server: { volumeScope: 'ref-1' } } as any
    const kept = await getKubernetesPersistence(work, server)
    const names = [getVolumeName(work, server), getVolumeName(generator, server)]
    expect(names.every((name, i) => name.startsWith(i === 0 ? 'hammerkit-task-1-' : 'hammerkit-gen-1-'))).toBe(true)
    expect(kept.volumes.map((v) => v.persistentVolumeClaim?.claimName)).toEqual(names)
    expect(kept.kept).toEqual(names)

    expect(persistence.volumes).toEqual([
      {
        name: 'hammerkit-task-1',
        persistentVolumeClaim: { claimName: 'hammerkit-task-1' },
      },
      {
        name: 'hammerkit-gen-1',
        persistentVolumeClaim: { claimName: 'hammerkit-gen-1' },
      },
    ])

    expect(persistence.mounts).toEqual([
      {
        mount: {
          readOnly: true,
          mountPath: '/data/mount',
          name: 'hammerkit-task-1',
          subPath: 'mount',
        },
        uploadPath: '/dev/hammerkit/task-1',
        cwd: '/data/mount',
      },
      {
        mount: {
          readOnly: true,
          mountPath: '/repo/src',
          name: 'hammerkit-task-1',
          subPath: 'src',
        },
        uploadPath: '/dev/hammerkit/task-1',
        cwd: '/repo/src',
      },
      {
        mount: {
          readOnly: true,
          mountPath: '/data/out.txt',
          name: 'hammerkit-gen-1',
          subPath: 'out.txt',
        },
        uploadPath: '/dev/hammerkit/gen-1',
        cwd: '/data',
      },
      {
        mount: {
          readOnly: false,
          mountPath: '/other/out.txt',
          name: 'hammerkit-task-1',
          subPath: 'out.txt',
        },
        uploadPath: '/dev/hammerkit/task-1',
        cwd: '/other/out.txt',
      },
    ])

    expect(persistence.sources).toEqual([
      {
        localPath: '/local/mount',
        matcher: expect.any(Function),
        containerPath: '/data/mount',
        subPath: 'mount',
        stateKey: '',
      },
      {
        localPath: '/repo/src',
        matcher: expect.any(Function),
        containerPath: '/repo/src',
        subPath: 'src',
        stateKey: '',
      },
    ])
  })

  // run_Kv-5lFVjvxEtgEjQ: test:coverage of iwentsourcing generates lcov.info, a file. A subPath
  // that isn't in the claim is made a directory, so the file is made first (see
  // ensurePersistentData), on a service run in the folder of the state
  it('makes the outputs of the task that are files before it runs, and only its own', async () => {
    const generator = makeWorkItem('gen-1', { type: 'container-task' } as WorkTask)
    const generate = (path: string, isFile: boolean, inherited: WorkItem<WorkTask> | null = null) => ({
      path,
      volumeName: '',
      inherited,
      resetOnChange: false,
      export: false,
      exportAlways: false,
      isFile,
    })
    const work = makeWorkItem<ContainerWorkTask>('task-1', {
      type: 'container-task',
      name: 'task-1',
      projectRoot: '/repo',
      mounts: [],
      src: [],
      generates: [
        generate('/repo/lcov.info', true),
        generate('/repo/report/lcov.info', true),
        generate('/repo/coverage', false),
        generate('/repo/dist/core.js', true, generator),
      ],
    } as unknown as ContainerWorkTask)

    const persistence = await getKubernetesPersistence(work, {})
    expect(persistence.files).toEqual(['lcov.info', expect.stringMatching(/^lcov\.info-[0-9a-f]{12}$/)])
    expect(persistence.mounts.map((mount) => [mount.mount.mountPath, mount.mount.subPath, mount.cwd])).toEqual([
      ['/repo/lcov.info', 'lcov.info', '/repo'],
      ['/repo/report/lcov.info', persistence.files[1], '/repo/report'],
      ['/repo/coverage', 'coverage', '/repo/coverage'],
      ['/repo/dist/core.js', 'core.js', '/repo/dist'],
    ])

    const run = await getKubernetesPersistence(work, { server: { run: 'run_1', serviceRun: true } } as any, 'state-1')
    const dir = getStateFilesDir('state-1')
    expect(run.files).toEqual([`${dir}/lcov.info`, `${dir}/${persistence.files[1]}`])
    expect(run.mounts[0].mount.subPath).toBe(run.files[0])
  })

  // a src folder is mounted read only: the container runtime can't make the place of a path
  // mounted inside it, and the pod of the task failed to start with exit code 128
  it('makes the places of its outputs inside a folder of its src in that folder', async () => {
    const generate = (path: string, isFile: boolean) => ({
      path,
      volumeName: '',
      inherited: null,
      resetOnChange: false,
      export: false,
      exportAlways: false,
      isFile,
    })
    const work = makeWorkItem<ContainerWorkTask>('task-1', {
      type: 'container-task',
      name: 'task-1',
      projectRoot: '/repo',
      mounts: [],
      src: [
        { absolutePath: '/repo/pkg', inherited: null, isFile: false, source: '', matcher: () => true },
        { absolutePath: '/repo/pkg/web', inherited: null, isFile: false, source: '', matcher: () => true },
        { absolutePath: '/repo/package.json', inherited: null, isFile: true, source: '', matcher: () => true },
      ],
      generates: [
        generate('/repo/pkg/coverage/lcov.info', true),
        generate('/repo/pkg/web/dist', false),
        generate('/repo/out', false),
      ],
    } as unknown as ContainerWorkTask)

    const persistence = await getKubernetesPersistence(work, {})
    // the src pkg/web is not mounted apart (see getMountedSources): its output is in pkg
    expect(persistence.files).toEqual(['lcov.info', 'pkg/coverage/lcov.info', 'pkg/web/dist/'])
  })

  // run_0GOSZtIx: tsc -b client of build:client read core/tsconfig.json, a src of build:core
  it('uploads the src of its deps into its own claim, as docker mounts them', async () => {
    const parent = makeWorkItem('parent-1', {} as WorkTask)
    const work = makeWorkItem<ContainerWorkTask>('task-1', {
      type: 'container-task',
      name: 'task-1',
      projectRoot: '/repo',
      mounts: [],
      src: [
        { absolutePath: '/repo/mine', inherited: null, isFile: false, source: '', matcher: () => true },
        { absolutePath: '/repo/inherited', inherited: parent, isFile: false, source: '', matcher: () => true },
      ],
      generates: [],
    } as unknown as ContainerWorkTask)

    const persistence = await getKubernetesPersistence(work, {})

    expect(persistence.mounts.map((m) => [m.mount.mountPath, m.mount.name])).toEqual([
      ['/repo/mine', persistence.volumes[0].name],
      ['/repo/inherited', persistence.volumes[0].name],
    ])
    expect(persistence.volumes).toHaveLength(1)
    expect(persistence.sources.map((s) => s.localPath)).toEqual(['/repo/mine', '/repo/inherited'])
  })

  // run_IXT2DuUb: package.json and core/package.json of npm ci, srcs of a dep of a dep,
  // went into one folder, and the last upload won: core/package.json lost its exports
  it('keeps the srcs of its deps that end alike apart, and apart from its own', async () => {
    const install = makeWorkItem('install-1', {} as WorkTask)
    const src = (absolutePath: string, inherited: WorkItem<WorkTask> | null, isFile = true) => ({
      absolutePath,
      inherited,
      isFile,
      source: '',
      matcher: () => true,
    })
    const work = makeWorkItem<ContainerWorkTask>('task-1', {
      type: 'container-task',
      name: 'task-1',
      projectRoot: '/repo',
      mounts: [],
      src: [
        src('/repo/client/package.json', null),
        src('/repo/package.json', install),
        src('/repo/core/package.json', install),
      ],
      generates: [],
    } as unknown as ContainerWorkTask)

    const persistence = await getKubernetesPersistence(work, {})
    const subPaths = persistence.mounts.map((m) => m.mount.subPath)

    // its own keeps the name it had, the task's id does not look at the srcs of its deps
    expect(subPaths[0]).toBe('package.json')
    expect(subPaths[1]).toMatch(/^package\.json-[0-9a-f]{12}$/)
    expect(subPaths[2]).toMatch(/^package\.json-[0-9a-f]{12}$/)
    expect(new Set(subPaths).size).toBe(3)
    expect(persistence.sources.map((s) => s.subPath)).toEqual(subPaths)
  })

  it('reuses the same volume when two generates share a source work item', async () => {
    const generator = makeWorkItem('gen-1', {} as WorkTask)
    const work = makeWorkItem<ContainerWorkTask>('task-1', {
      type: 'container-task',
      name: 'task-1',
      mounts: [],
      src: [],
      generates: [
        {
          path: '/data/a.txt',
          volumeName: '',
          inherited: generator,
          resetOnChange: false,
          export: true,
          isFile: false,
        },
        {
          path: '/data/b.txt',
          volumeName: '',
          inherited: generator,
          resetOnChange: false,
          export: true,
          isFile: false,
        },
      ],
    } as unknown as ContainerWorkTask)

    const persistence = await getKubernetesPersistence(work, {})

    expect(persistence.volumes).toHaveLength(1)
    expect(persistence.mounts.map((m) => m.mount.name)).toEqual(['hammerkit-gen-1', 'hammerkit-gen-1'])
  })

  it('gives each path of a claim its own folder when two share their last segment', async () => {
    const generate = (path: string, inherited: WorkItem<WorkTask> | null = null) => ({
      path,
      volumeName: '',
      inherited,
      resetOnChange: false,
      export: false,
      isFile: false,
    })
    // a checkout of the project at `root`, which differs between the runs of a server
    const installAt = (root: string, reverse = false) => {
      const order = <T>(items: T[]) => (reverse ? [...items].reverse() : items)
      return makeWorkItem<ContainerWorkTask>('install', {
        type: 'container-task',
        name: 'install',
        projectRoot: root,
        mounts: [],
        src: order([
          { absolutePath: `${root}/api/package.json`, inherited: null, isFile: true, source: '', matcher: () => true },
          { absolutePath: `${root}/package.json`, inherited: null, isFile: true, source: '', matcher: () => true },
        ]),
        generates: order([
          generate(`${root}/api/node_modules`),
          generate(`${root}/node_modules`),
          generate(`${root}/cli/node_modules`),
        ]),
      } as unknown as ContainerWorkTask)
    }
    const install = installAt('/repo')
    const subPaths = (persistence: KubernetesPersistence) =>
      Object.fromEntries(persistence.mounts.map((m) => [m.mount.mountPath, m.mount.subPath]))

    const own = subPaths(await getKubernetesPersistence(install, {}))
    // the least deep keeps the name it had, the others are named apart
    expect(own['/repo/package.json']).toBe('package.json')
    expect(own['/repo/node_modules']).toBe('node_modules')
    expect(own['/repo/api/package.json']).toMatch(/^package\.json-[0-9a-f]{12}$/)
    expect(own['/repo/api/node_modules']).toMatch(/^node_modules-[0-9a-f]{12}$/)
    expect(own['/repo/cli/node_modules']).toMatch(/^node_modules-[0-9a-f]{12}$/)
    expect(new Set(Object.values(own)).size).toBe(5)

    // the same folders for the same project in another directory, with its paths in another order
    const moved = subPaths(await getKubernetesPersistence(installAt('/srv/run-2/source', true), {}))
    expect(moved).toEqual(
      Object.fromEntries(Object.entries(own).map(([path, sub]) => [`/srv/run-2/source${path.slice(5)}`, sub]))
    )

    // a task that needs them mounts the same folders of the claim of install
    const build = makeWorkItem<ContainerWorkTask>('build', {
      type: 'container-task',
      name: 'build',
      mounts: [],
      src: [],
      generates: [
        generate('/repo/api/node_modules', install),
        generate('/repo/cli/node_modules', install),
        generate('/repo/node_modules', install),
      ],
    } as unknown as ContainerWorkTask)
    const consumer = await getKubernetesPersistence(build, {})
    expect(consumer.mounts.every((m) => m.mount.name === 'hammerkit-install')).toBe(true)
    expect(subPaths(consumer)).toEqual({
      '/repo/api/node_modules': own['/repo/api/node_modules'],
      '/repo/cli/node_modules': own['/repo/cli/node_modules'],
      '/repo/node_modules': own['/repo/node_modules'],
    })

    // a source goes where its mount reads it
    const sources = (await getKubernetesPersistence(install, {})).sources
    expect(sources.map((source) => source.subPath)).toEqual([own['/repo/api/package.json'], own['/repo/package.json']])
    // and an output is restored there
    expect(getRestoreTarget(install, '/repo/api/node_modules')).toBe(
      `/dev/hammerkit/install/${own['/repo/api/node_modules']}`
    )
    expect(getRestoreTarget(install, '/repo/node_modules')).toBe('/dev/hammerkit/install/node_modules')
  })
})

describe('getKubernetesPersistence for a container service', () => {
  it('creates volumes and mounts from the volumes field', async () => {
    const owner = makeWorkItem('vol-owner', {} as WorkService)
    const work = makeWorkItem<ContainerWorkService>('svc-1', {
      type: 'container-service',
      name: 'svc-1',
      mounts: [],
      src: [],
      volumes: [
        {
          name: 'data',
          containerPath: '/var/data',
          resetOnChange: false,
          inherited: null,
          export: true,
          readOnly: false,
        },
        {
          name: 'logs',
          containerPath: '/var/log/app.log',
          resetOnChange: false,
          inherited: owner,
          export: false,
          readOnly: false,
        },
      ],
    } as unknown as ContainerWorkService)

    const persistence = await getKubernetesPersistence(work, {})

    expect(persistence.volumes).toEqual([
      {
        name: 'hammerkit-svc-1',
        persistentVolumeClaim: { claimName: 'hammerkit-svc-1' },
      },
      {
        name: 'hammerkit-vol-owner',
        persistentVolumeClaim: { claimName: 'hammerkit-vol-owner' },
      },
    ])

    expect(persistence.mounts).toEqual([
      {
        mount: {
          readOnly: false,
          mountPath: '/var/data',
          name: 'hammerkit-svc-1',
          subPath: 'data',
        },
        uploadPath: '/dev/hammerkit/svc-1',
        cwd: '/var/data',
      },
      {
        mount: {
          readOnly: true,
          mountPath: '/var/log/app.log',
          name: 'hammerkit-vol-owner',
          subPath: 'app.log',
        },
        uploadPath: '/dev/hammerkit/vol-owner',
        cwd: '/var/log/app.log',
      },
    ])

    expect(persistence.sources).toEqual([])
  })

  it('uses the service id as source work for its own volumes', async () => {
    const work = makeWorkItem<ContainerWorkService>('svc-2', {
      type: 'container-service',
      name: 'svc-2',
      mounts: [],
      src: [{ absolutePath: '/repo/src', inherited: null, isFile: true, source: '', matcher: () => true }],
      volumes: [],
    } as unknown as ContainerWorkService)

    const persistence = await getKubernetesPersistence(work, {})

    expect(persistence.mounts).toEqual([
      {
        mount: {
          readOnly: true,
          mountPath: '/repo/src',
          name: 'hammerkit-svc-2',
          subPath: 'src',
        },
        uploadPath: '/dev/hammerkit/svc-2',
        cwd: '/repo',
      },
    ])
  })
})

describe('appendVolume', () => {
  it('dedupes the volume but pushes one mount per call', () => {
    const sourceWork = makeWorkItem('w1', {} as WorkTask)
    const persistence = {
      volumes: [],
      sizes: {},
      kept: [],
      workspace: [],
      sources: [],
      mounts: [],
      initCommands: [],
      files: [],
    }

    appendVolume(sourceWork, persistence, '/data/cache', '/local/cache', false, false, {})
    appendVolume(sourceWork, persistence, '/data/cache', '/local/cache', false, false, {})

    expect(persistence.volumes).toHaveLength(1)
    expect(persistence.volumes[0]).toEqual({
      name: 'hammerkit-w1',
      persistentVolumeClaim: { claimName: 'hammerkit-w1' },
    })
    expect(persistence.mounts).toHaveLength(2)
    expect(persistence.sources).toHaveLength(2)
  })
})

describe('the pods of a service run', () => {
  const env = { server: { run: 'run_1', serviceRun: true } } as any
  const claim = (claimName: string) => ({ name: claimName, persistentVolumeClaim: { claimName } })

  it('go where a pod runs that mounts all of their claims, as one of a move has to', () => {
    const spec = getWorkspacePodSpec(env, {
      workspace: [],
      volumes: [claim('hammerkit-api'), claim('hammerkit-build'), claim('hammerkit-api'), { name: 'secrets' }],
    })
    const keys = [getClaimMountLabel('hammerkit-api'), getClaimMountLabel('hammerkit-build')].sort()
    expect(spec.labels).toEqual({ [keys[0]]: 'mounted', [keys[1]]: 'mounted' })
    // one term: a pod that mounts all of them, or anywhere while none runs
    expect(spec.affinity?.podAffinity).toEqual({
      requiredDuringSchedulingIgnoredDuringExecution: [
        {
          labelSelector: { matchLabels: { [keys[0]]: 'mounted', [keys[1]]: 'mounted' } },
          topologyKey: 'kubernetes.io/hostname',
        },
      ],
    })
  })

  it('go anywhere without a claim, and outside of a service run as before', () => {
    expect(getWorkspacePodSpec(env, { workspace: [], volumes: [] })).toEqual({ labels: {} })
    expect(getWorkspacePodSpec({ server: { run: 'run_1' } } as any, { workspace: [], volumes: [claim('a')] })).toEqual({
      labels: {},
    })
  })
})

// a service run that moves to another commit: what each state uploads and builds goes into a
// folder of its own, so the pods of the commit before keep what they started with
describe('the files and outputs of a service run', () => {
  const env = { server: { run: 'run_1', serviceRun: true } } as any
  const completedAt = <T extends WorkTask | WorkService>(item: WorkItem<T>, stateKey: string) =>
    Object.assign(item, { state: { current: { type: 'completed', stateKey } } })

  const build = completedAt(
    makeWorkItem<ContainerWorkTask>('build', {
      type: 'container-task',
      name: 'build',
      mounts: [],
      src: [{ absolutePath: '/repo/src', inherited: null, isFile: false, source: '', matcher: () => true }],
      generates: [
        { path: '/repo/dist', volumeName: '', inherited: null, resetOnChange: false, export: false, isFile: false },
      ],
    } as unknown as ContainerWorkTask),
    'build-2'
  )
  const api = makeWorkItem<ContainerWorkService>('api', {
    type: 'container-service',
    name: 'api',
    mounts: [],
    src: [{ absolutePath: '/repo/.github', inherited: null, isFile: false, source: '', matcher: () => true }],
    volumes: [
      {
        name: 'dist',
        containerPath: '/repo/dist',
        inherited: build,
        resetOnChange: false,
        export: false,
        readOnly: false,
      },
      {
        name: 'data',
        containerPath: '/var/data',
        inherited: null,
        resetOnChange: false,
        export: true,
        readOnly: false,
      },
    ],
  } as unknown as ContainerWorkService)
  const subPaths = (persistence: KubernetesPersistence) =>
    Object.fromEntries(persistence.mounts.map((m) => [m.mount.mountPath, m.mount.subPath]))

  it("put a service's files by its state and its deps' outputs by theirs, and leave its data where it is", async () => {
    const persistence = await getKubernetesPersistence(api, env, 'api-2')
    expect(subPaths(persistence)).toEqual({
      '/repo/.github': `${getStateFilesDir('api-2')}/.github`,
      '/repo/dist': `${getStateFilesDir('build-2')}/dist`,
      '/var/data': 'data',
    })
    expect(persistence.sources.map((source) => source.subPath)).toEqual([`${getStateFilesDir('api-2')}/.github`])
  })

  it('mount the files of a service that watches them from the folder they are synced into', async () => {
    const watching = makeWorkItem<ContainerWorkService>('api', { ...api.data, continuous: true })
    const persistence = await getKubernetesPersistence(watching, env, 'api-2')
    // the same folder at every state, so its pod stays: its deps' outputs are by their state
    expect(subPaths(persistence)).toEqual({
      '/repo/.github': `${LIVE_FILES_DIR}/.github`,
      '/repo/dist': `${getStateFilesDir('build-2')}/dist`,
      '/var/data': 'data',
    })
    // uploaded by its state, and synced from there
    expect(persistence.sources.map((source) => source.subPath)).toEqual([`${getStateFilesDir('api-2')}/.github`])
    expect(isLiveService(watching, env)).toBe(true)
    expect(isLiveService(api, env)).toBe(false)
    // only on a service run, and not on a sandbox, whose files are mounted as they are
    expect(isLiveService(watching, { server: { run: 'run_1' } } as any)).toBe(false)
    expect(isLiveService(watching, { server: { ...env.server, workspace: {} } } as any)).toBe(false)
  })

  it("put a task's src and outputs by the state it runs at, and restore them there", async () => {
    const persistence = await getKubernetesPersistence(build, env, 'build-3')
    expect(subPaths(persistence)).toEqual({
      '/repo/src': `${getStateFilesDir('build-3')}/src`,
      '/repo/dist': `${getStateFilesDir('build-3')}/dist`,
    })
    // its archive reads the outputs of the state it ran at, which its runtime is told: the
    // work item a runtime has is the one without a state
    expect(subPaths(await getKubernetesPersistence(build, env, 'build-3'))['/repo/dist']).toBe(
      `${getStateFilesDir('build-3')}/dist`
    )
    expect(getRestoreTarget(build, '/repo/dist', getStateFilesDir('build-3'))).toBe(
      `/dev/hammerkit/build/${getStateFilesDir('build-3')}/dist`
    )
  })

  it('stay where they were outside of a service run', async () => {
    expect(subPaths(await getKubernetesPersistence(api, { server: { run: 'run_1' } } as any, 'api-2'))).toEqual({
      '/repo/.github': '.github',
      '/repo/dist': 'dist',
      '/var/data': 'data',
    })
  })
})

// iwentsourcing image-docs: `src: [docs, docs/Dockerfile]` failed on a server with "unable to
// make the output files docs/Dockerfile/", and worked on docker
describe('overlapping srcs', () => {
  let root: string
  const src = (absolutePath: string, inherited: WorkItem<WorkTask> | null = null, isFile?: boolean) => ({
    absolutePath,
    inherited,
    isFile: isFile ?? extname(absolutePath).length > 1,
    source: '',
    matcher: () => true,
  })
  const taskWith = (sources: ReturnType<typeof src>[], mounts: unknown[] = []) =>
    makeWorkItem<ContainerWorkTask>('task-1', {
      type: 'container-task',
      name: 'task-1',
      projectRoot: root,
      mounts,
      src: sources,
      generates: [],
    } as unknown as ContainerWorkTask)
  const mountPaths = (persistence: KubernetesPersistence) => persistence.mounts.map((m) => m.mount.mountPath)

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hammerkit-overlapping-src-'))
    mkdirSync(join(root, 'docs', 'api'), { recursive: true })
    writeFileSync(join(root, 'docs', 'Dockerfile'), 'FROM nginx')
    writeFileSync(join(root, 'docs', 'api', 'index.md'), '# api')
    mkdirSync(join(root, 'conf.d'))
    writeFileSync(join(root, 'conf.d', 'site.conf'), '')
    writeFileSync(join(root, 'LICENSE'), 'MIT')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('mounts and uploads a file inside a folder of its src with that folder, as docker does', async () => {
    const work = taskWith([src(join(root, 'docs')), src(join(root, 'docs', 'Dockerfile'))])

    const persistence = await getKubernetesPersistence(work, {})

    expect(mountPaths(persistence)).toEqual([join(root, 'docs')])
    expect(persistence.sources.map((s) => s.localPath)).toEqual([join(root, 'docs')])
    expect(persistence.files).toEqual([])
  })

  it('makes the claim the pod starts with, the Dockerfile in docs among it', async () => {
    const work = taskWith([src(join(root, 'docs', 'Dockerfile')), src(join(root, 'docs'))])
    const persistence = await getKubernetesPersistence(work, {})
    const claim = mkdtempSync(join(tmpdir(), 'hammerkit-overlapping-claim-'))
    try {
      // what the uploads put into the claim
      for (const source of persistence.sources) {
        await pipeline(packSource(source), extract({ cwd: claim }))
      }
      execFileSync('sh', ['-c', ENSURE_OUTPUT_FILES, 'sh', claim, ...persistence.files])

      for (const mount of persistence.mounts) {
        expect(readdirSync(join(claim, mount.mount.subPath!))).toContain('Dockerfile')
      }
    } finally {
      rmSync(claim, { recursive: true, force: true })
    }
  })

  it('mounts a folder inside a folder of its src with that folder', async () => {
    const work = taskWith([src(join(root, 'docs', 'api')), src(join(root, 'docs')), src(join(root, 'docs', 'api'))])

    const persistence = await getKubernetesPersistence(work, {})

    expect(mountPaths(persistence)).toEqual([join(root, 'docs')])
    expect(persistence.files).toEqual([])
  })

  it('goes by what a path is on disk, not by its name', async () => {
    // conf.d looks like a file by its name, and is a folder
    const work = taskWith([src(join(root, 'conf.d')), src(join(root, 'conf.d', 'site.conf'))])

    const persistence = await getKubernetesPersistence(work, {})

    expect(mountPaths(persistence)).toEqual([join(root, 'conf.d')])
  })

  // the folder's name has a dot: by its name it is a file, which isn't a folder mounted read
  // only, and its output got no place in it (the pod fails to start with exit code 128)
  it('makes the place of an output inside a folder of its src with a dot in its name', async () => {
    const work = makeWorkItem<ContainerWorkTask>('task-1', {
      type: 'container-task',
      name: 'task-1',
      projectRoot: root,
      mounts: [],
      src: [src(join(root, 'conf.d'))],
      generates: [
        {
          path: join(root, 'conf.d', 'out'),
          volumeName: '',
          inherited: null,
          resetOnChange: false,
          export: false,
          isFile: false,
        },
      ],
    } as unknown as ContainerWorkTask)

    const persistence = await getKubernetesPersistence(work, {})

    expect(persistence.files).toEqual(['conf.d/out/'])
  })

  it('mounts a src file without an extension as a file', async () => {
    const work = taskWith([src(join(root, 'docs', 'Dockerfile'))])

    const persistence = await getKubernetesPersistence(work, {})

    expect(persistence.mounts.map((m) => m.cwd)).toEqual([join(root, 'docs')])
  })

  it('makes the place of a file without an extension mounted into a folder of its src a file', async () => {
    const work = taskWith(
      [src(join(root, 'docs'))],
      [
        {
          localPath: join(root, 'LICENSE'),
          containerPath: join(root, 'docs', 'LICENSE'),
          isFile: false,
          mount: '',
          readOnly: true,
        },
      ]
    )

    const persistence = await getKubernetesPersistence(work, {})

    expect(persistence.files).toEqual(['docs/LICENSE'])
  })

  it('mounts a path that is the src of the task and of a dep once, as the one of the task', async () => {
    const dep = makeWorkItem('dep-1', {} as WorkTask)
    const work = taskWith([src(join(root, 'docs'), dep), src(join(root, 'docs')), src(join(root, 'LICENSE'), dep)])

    const persistence = await getKubernetesPersistence(work, {})

    expect(mountPaths(persistence)).toEqual([join(root, 'docs'), join(root, 'LICENSE')])
    // the task's own src keeps its place in the claim, a dep's has the hash of its path
    expect(persistence.mounts[0].mount.subPath).toEqual('docs')
    expect(persistence.mounts[1].mount.subPath).toMatch(/^LICENSE-[0-9a-f]{12}$/)
  })

  it('keeps paths that only start alike, and a path outside of the folder, apart', async () => {
    mkdirSync(join(root, 'docs-site'))
    const work = taskWith([src(join(root, 'docs')), src(join(root, 'docs-site')), src(join(root, 'LICENSE'))])

    const persistence = await getKubernetesPersistence(work, {})

    expect(mountPaths(persistence)).toEqual([join(root, 'docs'), join(root, 'docs-site'), join(root, 'LICENSE')])
  })

  it('mounts what is inside the prefix of a glob of its src with it, as its folder is uploaded whole', () => {
    const glob = { ...src(join(root, 'docs'), null, false), source: 'docs/**/*.md' }
    expect(getMountedSources([glob, src(join(root, 'docs', 'Dockerfile'))])).toEqual([glob])
  })
})
