import { randomBytes } from 'crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { environmentMock } from '../executer/environment-mock'
import { Environment } from '../executer/environment'
import { ArchiveWritten } from '../runtime/runtime'
import { WorkTree } from '../planner/work-tree'
import { getLocalWorkRuntime } from '../planner/work-runtime-local'
import { keepArtifacts, MAX_OUTPUT_ENTRIES } from './keep-artifacts'
import { ARTIFACTS_MANIFEST, ArtifactsManifest } from './run-artifacts'

interface Generate {
  path: string
  export?: boolean
  exportAlways?: boolean
}

// A task of the work tree, with its outputs under `root`, and the runtime of a local task
// (getLocalWorkRuntime) unless the test gives another one
function task(
  root: string,
  name: string,
  generates: Generate[],
  state: Record<string, unknown> = { type: 'completed', cached: false, skipped: false },
  runtime?: unknown
) {
  const data = {
    type: 'local-task',
    cwd: root,
    generates: generates.map((generate) => ({
      inherited: false,
      export: false,
      exportAlways: false,
      isFile: false,
      ...generate,
      path: join(root, generate.path),
    })),
  }
  const item = { name, id: () => name, data, state: { current: state }, runtime: runtime as any }
  item.runtime ??= getLocalWorkRuntime(item as any)
  return item
}

const tree = (...tasks: ReturnType<typeof task>[]): WorkTree =>
  ({ tasks: Object.fromEntries(tasks.map((item) => [item.name, item])), services: {} }) as unknown as WorkTree

describe('keepArtifacts', () => {
  let root: string
  let artifacts: string
  const redact = (text: string) => text

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hammerkit-keep-project-'))
    artifacts = mkdtempSync(join(tmpdir(), 'hammerkit-keep-artifacts-'))
    mkdirSync(join(root, 'app', 'screenshots', 'tour'), { recursive: true })
    writeFileSync(join(root, 'app', 'screenshots', 'tour', 'home.png'), 'shot')
    mkdirSync(join(root, 'app', 'videos'), { recursive: true })
    writeFileSync(join(root, 'app', 'videos', 'tour.mp4'), 'film')
    mkdirSync(join(root, 'app', 'tmp'), { recursive: true })
    writeFileSync(join(root, 'app', 'tmp', 'scratch'), 'scratch')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(artifacts, { recursive: true, force: true })
  })

  const keep = (workTree: WorkTree, patch: Partial<Parameters<typeof keepArtifacts>[2]> = {}) =>
    keepArtifacts(workTree, environmentMock(root), {
      directory: artifacts,
      maxBytes: 1024 * 1024,
      root,
      cancelled: () => false,
      redact,
      ...patch,
    })

  const readManifest = (): ArtifactsManifest => JSON.parse(readFileSync(join(artifacts, ARTIFACTS_MANIFEST), 'utf8'))

  it('keeps the outputs a task exports, by their paths in the project, and writes the manifest', async () => {
    const manifest = await keep(
      tree(
        task(root, 'e2e', [
          { path: 'app/screenshots', export: true },
          { path: 'app/tmp' },
          { path: 'app/videos', export: true },
        ])
      )
    )
    expect(manifest.outputs.map((output) => [output.task, output.path])).toEqual([
      ['e2e', 'app/screenshots'],
      ['e2e', 'app/videos'],
    ])
    expect(manifest.left).toEqual([])
    expect(readManifest()).toEqual(manifest)
    expect(readdirSync(artifacts).sort()).toEqual(['0.tgz', '1.tgz', ARTIFACTS_MANIFEST])
    // staging is gone, as the run ends
    expect(readdirSync(artifacts)).not.toContain('.staging')
  })

  it('keeps of a failed task what it exports always, and not what it only exports', async () => {
    const manifest = await keep(
      tree(
        task(
          root,
          'e2e',
          [
            { path: 'app/screenshots', exportAlways: true },
            { path: 'app/videos', export: true },
          ],
          {
            type: 'error',
          }
        )
      )
    )
    expect(manifest.outputs.map((output) => output.path)).toEqual(['app/screenshots'])
  })

  it('keeps nothing of a dependency that was skipped, as nothing needed it', async () => {
    const manifest = await keep(
      tree(task(root, 'build', [{ path: 'app/screenshots', export: true }], { type: 'completed', skipped: true }))
    )
    expect(manifest).toEqual({ outputs: [], left: [] })
  })

  it('keeps nothing of a task that came from the cache, and says why', async () => {
    const manifest = await keep(
      tree(task(root, 'e2e', [{ path: 'app/screenshots', export: true }], { type: 'completed', cached: true }))
    )
    expect(manifest.outputs).toEqual([])
    expect(manifest.left).toEqual([
      {
        task: 'e2e',
        path: 'app/screenshots',
        reason: expect.stringMatching(/^it came from the cache: the cache is shared by the runs of this server/),
      },
    ])
    expect(readdirSync(artifacts).sort()).toEqual([ARTIFACTS_MANIFEST])
  })

  it('lists the outputs of a cancelled run as left, and keeps none of them', async () => {
    const manifest = await keep(tree(task(root, 'e2e', [{ path: 'app/screenshots', export: true }])), {
      cancelled: () => true,
    })
    expect(manifest).toEqual({
      outputs: [],
      left: [{ task: 'e2e', path: 'app/screenshots', reason: 'the run was cancelled' }],
    })
  })

  it('says why a task left an output, redacted and cut to 500 characters', async () => {
    const failing = task(root, 'e2e', [{ path: 'app/screenshots', export: true }], undefined, {
      archive: async () => {
        throw new Error(`the token tok-123 is ${'x'.repeat(600)}`)
      },
    })
    const manifest = await keep(tree(failing), { redact: (text) => text.replace(/tok-\d+/g, '***') })
    expect(manifest.left).toEqual([
      {
        task: 'e2e',
        path: 'app/screenshots',
        reason: `the token *** is ${'x'.repeat(500 - 'the token *** is '.length)}`,
      },
    ])
  })

  it('refuses an output whose archive passes the run budget as it is written, and removes it', async () => {
    // random bytes do not pack, so the archive is bigger than the 50 bytes left
    const big = join(root, 'app', 'screenshots', 'noise.bin')
    writeFileSync(big, randomBytes(4096))
    const manifest = await keep(tree(task(root, 'e2e', [{ path: 'app/screenshots', export: true }])), {
      maxBytes: 50,
    })
    expect(manifest.outputs).toEqual([])
    expect(manifest.left).toEqual([
      {
        task: 'e2e',
        path: 'app/screenshots',
        reason: 'more than the 50B a run keeps (runs.artifacts.maxBytes)',
      },
    ])
    expect(readdirSync(artifacts).sort()).toEqual([ARTIFACTS_MANIFEST])
  })

  it('refuses an output that writes past the budget through a stream of its own', async () => {
    const writing = task(root, 'e2e', [{ path: 'app/screenshots', export: true }], undefined, {
      archive: async (environment: Environment, path: string): Promise<ArchiveWritten[]> => {
        const filename = join(path, 'raw.tgz')
        const file = environment.file.createWriteStream(filename)
        file.write(Buffer.alloc(60))
        file.write(Buffer.alloc(60))
        await new Promise<void>((resolve) => file.once('close', () => resolve()))
        return [{ filename, root: root }]
      },
    })
    const manifest = await keep(tree(writing), { maxBytes: 100 })
    expect(manifest.left).toEqual([
      { task: 'e2e', path: 'app/screenshots', reason: 'more than the 100B a run keeps (runs.artifacts.maxBytes)' },
    ])
  })

  it('refuses an output that unpacks to more than the budget, though it packs small', async () => {
    // zeros pack to almost nothing, so the archive is small and the content is not
    writeFileSync(join(root, 'app', 'screenshots', 'zeros.bin'), Buffer.alloc(1024 * 1024))
    const manifest = await keep(tree(task(root, 'e2e', [{ path: 'app/screenshots', export: true }])), {
      maxBytes: 64 * 1024,
    })
    expect(manifest.outputs).toEqual([])
    expect(manifest.left[0].reason).toMatch(
      /^more than the 64Ki a run keeps \(runs\.artifacts\.maxBytes\), \S+ unpacked$/
    )
  })

  it('refuses an output of more files than the server keeps', async () => {
    const many = join(root, 'app', 'many')
    mkdirSync(many)
    for (let i = 0; i <= MAX_OUTPUT_ENTRIES; i++) {
      writeFileSync(join(many, `${i}.txt`), '')
    }
    const manifest = await keep(tree(task(root, 'e2e', [{ path: 'app/many', export: true }])))
    expect(manifest.outputs).toEqual([])
    expect(manifest.left).toEqual([
      { task: 'e2e', path: 'app/many', reason: `more than ${MAX_OUTPUT_ENTRIES} files in it` },
    ])
  }, 60_000)

  it('leaves out an output the run has no budget left for, and keeps the ones before it', async () => {
    // random bytes do not pack: the videos take far more than what the screenshots leave
    writeFileSync(join(root, 'app', 'videos', 'tour.mp4'), randomBytes(4096))
    const workTree = () =>
      tree(
        task(root, 'e2e', [
          { path: 'app/screenshots', export: true },
          { path: 'app/videos', export: true },
        ])
      )
    const [screenshots] = (await keep(workTree())).outputs
    const manifest = await keep(workTree(), { maxBytes: screenshots.bytes + 1024 })
    expect(manifest.outputs.map((output) => output.path)).toEqual(['app/screenshots'])
    expect(manifest.left).toEqual([
      {
        task: 'e2e',
        path: 'app/videos',
        reason: expect.stringMatching(/^more than the \S+ a run keeps \(runs\.artifacts\.maxBytes\)$/),
      },
    ])
  })
})
