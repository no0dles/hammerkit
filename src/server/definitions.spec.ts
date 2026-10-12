import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, relative } from 'path'
import { environmentMock } from '../executer/environment-mock'
import { Bundle, hashBundle } from '../remote/bundle'
import { DefinitionError, DefinitionStore, inspectBundle } from './definitions'

const alice = { iss: 'https://idp.corp', sub: 'alice' }

const tasks = `
tasks:
  build:
    cmds: [echo build]
  test:
    deps: [build]
    cmds: [echo test]
`

const bundle = (files: Record<string, string> = { '.hammerkit.yaml': tasks }): Bundle => ({
  entry: '.hammerkit.yaml',
  files,
})

describe('inspectBundle', () => {
  const environment = environmentMock(tmpdir())

  it('lists the tasks and services a run can ask for', async () => {
    const inspected = await inspectBundle(
      bundle({
        '.hammerkit.yaml': `${tasks}\nincludes:\n  more: ./more.yaml\n`,
        'more.yaml': 'tasks:\n  lint:\n    cmds: [echo lint]\n',
      }),
      environment
    )
    expect(inspected.tasks).toEqual(['build', 'more:lint', 'test'])
    expect(inspected.services).toEqual([])
  })

  it('says what each task works on, relative to the root of the bundle', async () => {
    const inspected = await inspectBundle(
      bundle({
        '.hammerkit.yaml': [
          'references:',
          '  lib: ./lib',
          'services:',
          '  db:',
          '    image: postgres:16',
          'tasks:',
          '  build:',
          '    src: [package.json, "src/**/*.ts", "!src/**/*.spec.ts", ../outside/*.ts]',
          '    cmds: [echo build]',
          '  test:',
          '    image: node:20',
          '    deps: [build, lib:lint]',
          '    needs: [db]',
          '    mounts: [./.npm:/.npm, /var/run/docker.sock:/var/run/docker.sock]',
          '    cmds: [echo test]',
        ].join('\n'),
        'lib/.hammerkit.yaml': 'tasks:\n  lint:\n    src: ["*.ts"]\n    cmds: [echo lint]\n',
      }),
      environment
    )
    expect(inspected.inputs).toEqual({
      build: { src: ['package.json', 'src/**/*.ts', '!src/**/*.spec.ts'], mounts: [], deps: [], needs: [] },
      'lib:lint': { src: ['lib/*.ts'], mounts: [], deps: [], needs: [] },
      test: { src: [], mounts: ['.npm'], deps: ['build', 'lib:lint'], needs: ['db'] },
    })
  })

  it('refuses a build file that does not load, without telling where the server keeps it', async () => {
    await expect(inspectBundle(bundle({ '.hammerkit.yaml': 'tasks: [' }), environment)).rejects.toThrow(DefinitionError)
    const error = await inspectBundle(bundle({ '.hammerkit.yaml': 'tasks:\n  a:\n    nope: 1\n' }), environment).catch(
      (e) => e
    )
    expect(error).toBeInstanceOf(DefinitionError)
    expect(error.message).not.toContain(tmpdir())
  })

  it('refuses a file that is not in the bundle, even when it exists on the server', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'hammerkit-outside-'))
    try {
      writeFileSync(join(outside, '.hammerkit.yaml'), 'tasks:\n  leaked:\n    cmds: [echo leaked]\n')
      for (const path of [
        join(outside, 'secret.yaml'),
        relative(tmpdir(), join(outside, 'secret.yaml')),
        'missing.yaml',
      ]) {
        const error = await inspectBundle(
          bundle({ '.hammerkit.yaml': `includes:\n  x: ${path}\n` }),
          environment
        ).catch((e) => e)
        expect(error).toBeInstanceOf(DefinitionError)
        expect(error.message).toMatch(/unable to read|outside of the bundle/)
        expect(error.message).not.toContain('leaked')
      }
      // and what it reads of the bundle is the bundle's own
      const inside = await inspectBundle(
        bundle({
          '.hammerkit.yaml': 'includes:\n  x: ./secret.yaml\n',
          'secret.yaml': 'tasks:\n  own:\n    cmds: [echo]\n',
        }),
        environment
      )
      expect(inside.tasks).toEqual(['x:own'])
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('wants git includes pinned to a commit and not a path on the server', async () => {
    const commit = 'a'.repeat(40)
    const include = (git: string, ref?: string) =>
      bundle({ '.hammerkit.yaml': `includes:\n  lib:\n    git: ${git}${ref ? `\n    ref: ${ref}` : ''}\n` })
    await expect(inspectBundle(include('https://git.corp/lib.git', 'main'), environment)).rejects.toThrow(
      'pin ref to a commit'
    )
    await expect(inspectBundle(include('https://git.corp/lib.git'), environment)).rejects.toThrow('pin ref to a commit')
    await expect(inspectBundle(include('/srv/repos/lib', commit), environment)).rejects.toThrow('https:// or ssh://')
    await expect(inspectBundle(include('file:///srv/repos/lib', commit), environment)).rejects.toThrow(
      'https:// or ssh://'
    )
  })
})

describe('DefinitionStore', () => {
  let directory: string
  let clock: number
  const environment = environmentMock(tmpdir())

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'hammerkit-store-'))
    clock = Date.parse('2026-10-11T08:00:00Z')
  })
  afterEach(() => rmSync(directory, { recursive: true, force: true }))

  const store = () => new DefinitionStore(directory, environment, { now: () => clock })

  it('keeps what is published under the hash of its files', async () => {
    const s = store()
    const { version, created } = await s.publish(bundle(), alice)
    expect(created).toBe(true)
    expect(version).toMatchObject({
      hash: hashBundle(bundle()),
      entry: '.hammerkit.yaml',
      publishedBy: alice,
      tasks: ['build', 'test'],
      services: [],
    })
    expect(version).not.toHaveProperty('name')
    expect(s.find(version.hash)).toEqual(version)
    expect(await s.files(version)).toEqual(bundle())
    expect(readdirSync(directory)).toEqual([`${version.hash.slice('sha256:'.length)}.json`])
  })

  it('does nothing when the same files are published again, by anybody', async () => {
    const s = store()
    const first = await s.publish(bundle(), alice)
    clock += 60_000
    const again = await s.publish(bundle(), { iss: alice.iss, sub: 'bob' })
    expect(again.created).toBe(false)
    expect(again.version).toEqual(first.version)
    expect(s.list()).toHaveLength(1)
  })

  it('lists every version, newest first', async () => {
    const s = store()
    const one = await s.publish(bundle(), alice)
    clock += 60_000
    const two = await s.publish(bundle({ '.hammerkit.yaml': `${tasks}  deploy:\n    cmds: [echo deploy]\n` }), alice)
    expect(two.version.hash).not.toBe(one.version.hash)
    expect(s.list().map((v) => v.hash)).toEqual([two.version.hash, one.version.hash])
    expect(s.find(one.version.hash)?.tasks).toEqual(['build', 'test'])
    expect(s.find('sha256:' + '0'.repeat(64))).toBeUndefined()
    expect(s.find('latest')).toBeUndefined()
    expect(s.find('constructor')).toBeUndefined()
  })

  it('remembers what was published after a restart', async () => {
    const first = store()
    const { version } = await first.publish(bundle(), alice)
    const restarted = store()
    await restarted.load()
    expect(restarted.find(version.hash)).toEqual(version)
    expect(await restarted.files(version)).toEqual(bundle())
    await store().load() // an empty directory is fine too
  })

  it('reads the versions an older server kept under a name, once each and yanked if any copy is', async () => {
    const hash = hashBundle(bundle())
    const file = `${hash.slice('sha256:'.length)}.json`
    const version = (sub: string, publishedAt: string, yanked?: object) => ({
      version: {
        name: sub,
        hash,
        entry: '.hammerkit.yaml',
        publishedAt,
        publishedBy: { iss: alice.iss, sub },
        tasks: ['build', 'test'],
        services: [],
        plan: {},
        ...(yanked ? { yanked } : {}),
      },
      bundle: bundle(),
    })
    for (const [name, stored] of [
      ['payments', version('alice', '2026-10-11T08:00:00Z')],
      ['web', version('bob', '2026-10-11T09:00:00Z', { at: '2026-10-11T10:00:00Z', by: alice, reason: 'broken' })],
    ] as const) {
      mkdirSync(join(directory, name))
      writeFileSync(join(directory, name, file), JSON.stringify(stored))
    }
    const s = store()
    await s.load()
    expect(s.list()).toHaveLength(1)
    const found = s.find(hash)
    expect(found).not.toHaveProperty('name')
    expect(found?.yanked?.reason).toBe('broken')
    expect(await s.files(found!)).toEqual(bundle())

    // letting it go on rewrites the copy it was read from
    await s.yank(hash, alice, { undo: true })
    const restarted = store()
    await restarted.load()
    expect(restarted.find(hash)?.yanked).toBeUndefined()
    expect(restarted.find(hash)?.publishedBy.sub).toBe('alice')
  })

  it('does not publish a build file that does not load', async () => {
    const s = store()
    await expect(s.publish(bundle({ '.hammerkit.yaml': 'tasks: [' }), alice)).rejects.toThrow(DefinitionError)
    expect(s.list()).toEqual([])
    expect(readdirSync(directory)).toEqual([])
  })
})

describe('DefinitionStore yank', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hammerkit-yank-'))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  const other = bundle({ '.hammerkit.yaml': 'tasks:\n  other:\n    cmds: [echo other]\n' })

  it('pulls a version back, keeps it, and gives it back', async () => {
    const store = new DefinitionStore(root, environmentMock(root))
    const first = (await store.publish(bundle(), alice)).version
    const second = (await store.publish(other, alice)).version

    const yanked = await store.yank(second.hash, alice, { reason: 'broken' })
    expect(yanked?.yanked).toMatchObject({ by: alice, reason: 'broken' })
    expect(store.find(second.hash)?.yanked?.reason).toBe('broken')
    expect(store.find(first.hash)?.yanked).toBeUndefined()
    expect(await store.files(second)).toEqual(other)

    // a second yank changes nothing, the first one stands
    const again = await store.yank(second.hash, { iss: 'x', sub: 'y' }, { reason: 'later' })
    expect(again?.yanked).toMatchObject({ by: alice, reason: 'broken' })

    await store.yank(second.hash, alice, { undo: true })
    expect(store.find(second.hash)?.yanked).toBeUndefined()
    expect(await store.yank('sha256:' + '0'.repeat(64), alice)).toBeUndefined()
  })

  it('keeps a yank over a restart', async () => {
    const store = new DefinitionStore(root, environmentMock(root))
    const { version } = await store.publish(bundle(), alice)
    await store.yank(version.hash, alice, { reason: 'broken' })

    const restarted = new DefinitionStore(root, environmentMock(root))
    await restarted.load()
    expect(restarted.find(version.hash)?.yanked?.reason).toBe('broken')
  })
})
