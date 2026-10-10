import { appendVolume, getKubernetesPersistence, getVolumeName } from './volumes'
import { WorkItem } from '../planner/work-item'
import { ContainerWorkService, WorkService } from '../planner/work-service'
import { ContainerWorkTask, WorkTask } from '../planner/work-task'

function makeWorkItem<T extends WorkTask | WorkService>(id: string, data: T): WorkItem<T> {
  return { id: () => id, data } as any
}

describe('getVolumeName', () => {
  it('prefixes the item id with hammerkit-', () => {
    const item = makeWorkItem('w1', { type: 'container-task' } as unknown as WorkTask)
    expect(getVolumeName(item)).toBe('hammerkit-w1')
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

    const persistence = await getKubernetesPersistence(work)

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
        cwd: '/data/out.txt',
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
      { localPath: '/local/mount', matcher: expect.any(Function), containerPath: '/data/mount', stateKey: '' },
      { localPath: '/repo/src', matcher: expect.any(Function), containerPath: '/repo/src', stateKey: '' },
    ])
  })

  it('skips inherited src entries', async () => {
    const parent = makeWorkItem('parent-1', {} as WorkTask)
    const work = makeWorkItem<ContainerWorkTask>('task-1', {
      type: 'container-task',
      name: 'task-1',
      mounts: [],
      src: [
        { absolutePath: '/repo/mine', inherited: null, isFile: false, source: '', matcher: () => true },
        { absolutePath: '/repo/inherited', inherited: parent, isFile: false, source: '', matcher: () => true },
      ],
      generates: [],
    } as unknown as ContainerWorkTask)

    const persistence = await getKubernetesPersistence(work)

    expect(persistence.mounts.map((m) => m.mount.mountPath)).toEqual(['/repo/mine'])
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

    const persistence = await getKubernetesPersistence(work)

    expect(persistence.volumes).toHaveLength(1)
    expect(persistence.mounts.map((m) => m.mount.name)).toEqual(['hammerkit-gen-1', 'hammerkit-gen-1'])
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

    const persistence = await getKubernetesPersistence(work)

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

    const persistence = await getKubernetesPersistence(work)

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
    const persistence = { volumes: [], sources: [], mounts: [], initCommands: [] }

    appendVolume(sourceWork, persistence, '/data/cache', '/local/cache', false, false)
    appendVolume(sourceWork, persistence, '/data/cache', '/local/cache', false, false)

    expect(persistence.volumes).toHaveLength(1)
    expect(persistence.volumes[0]).toEqual({
      name: 'hammerkit-w1',
      persistentVolumeClaim: { claimName: 'hammerkit-w1' },
    })
    expect(persistence.mounts).toHaveLength(2)
    expect(persistence.sources).toHaveLength(2)
  })
})
