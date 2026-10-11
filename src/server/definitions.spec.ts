import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs'
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

  const store = () => new DefinitionStore(directory, environment, () => clock)

  it('keeps what is published under the hash of its files', async () => {
    const s = store()
    const { version, created } = await s.publish('payments', bundle(), alice)
    expect(created).toBe(true)
    expect(version).toMatchObject({
      name: 'payments',
      hash: hashBundle(bundle()),
      entry: '.hammerkit.yaml',
      publishedBy: alice,
      tasks: ['build', 'test'],
      services: [],
    })
    expect(s.find('payments', version.hash)).toEqual(version)
    expect(await s.files(version)).toEqual(bundle())
    expect(s.names()).toEqual(['payments'])
  })

  it('does nothing when the same files are published again', async () => {
    const s = store()
    const first = await s.publish('payments', bundle(), alice)
    clock += 60_000
    const again = await s.publish('payments', bundle(), { iss: alice.iss, sub: 'bob' })
    expect(again.created).toBe(false)
    expect(again.version).toEqual(first.version)
    expect(s.list('payments')).toHaveLength(1)
  })

  it('knows the latest version and keeps the older ones', async () => {
    const s = store()
    const one = await s.publish('payments', bundle(), alice)
    clock += 60_000
    const two = await s.publish(
      'payments',
      bundle({ '.hammerkit.yaml': `${tasks}  deploy:\n    cmds: [echo deploy]\n` }),
      alice
    )
    expect(two.version.hash).not.toBe(one.version.hash)
    expect(s.find('payments', 'latest')?.hash).toBe(two.version.hash)
    expect(s.list('payments').map((v) => v.hash)).toEqual([two.version.hash, one.version.hash])
    expect(s.find('payments', one.version.hash)?.tasks).toEqual(['build', 'test'])
    expect(s.find('payments', 'sha256:' + '0'.repeat(64))).toBeUndefined()
    expect(s.find('nothing', 'latest')).toBeUndefined()
    expect(s.list('constructor')).toEqual([])
  })

  it('names are separate: the same files under another name are another build file', async () => {
    const s = store()
    await s.publish('payments', bundle(), alice)
    const other = await s.publish('web', bundle(), alice)
    expect(other.created).toBe(true)
    expect(s.names()).toEqual(['payments', 'web'])
  })

  it('remembers what was published after a restart', async () => {
    const first = store()
    const { version } = await first.publish('payments', bundle(), alice)
    const restarted = store()
    await restarted.load()
    expect(restarted.find('payments', 'latest')).toEqual(version)
    expect(await restarted.files(version)).toEqual(bundle())
    await store().load() // an empty directory is fine too
  })

  it('does not publish a build file that does not load', async () => {
    const s = store()
    await expect(s.publish('broken', bundle({ '.hammerkit.yaml': 'tasks: [' }), alice)).rejects.toThrow(DefinitionError)
    expect(s.names()).toEqual([])
    expect(() => readdirSync(join(directory, 'broken'))).toThrow()
  })
})
