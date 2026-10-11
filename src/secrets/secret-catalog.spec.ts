import { environmentMock } from '../executer/environment-mock'
import { ParseScope } from '../schema/parse-context'
import { BuildFileSchema } from '../schema/build-file-schema'
import { ReferencedContext } from '../schema/reference-parser'
import { collectSecretCatalog } from './secret-catalog'

const context = { envFiles: {} } as unknown as ReferencedContext
const sha = '3f9c2e1a8b7d4c5e6f0a1b2c3d4e5f60718293a4'

function file(fileName: string, schema: BuildFileSchema, remote?: { git: string; ref: string | null }): ParseScope {
  return { fileName, schema, remote, cwd: '/p', namePrefix: '', references: {} } as unknown as ParseScope
}

const collect = (...files: ParseScope[]) => collectSecretCatalog(files, environmentMock('/p'), context)

describe('secret catalog', () => {
  it('collects providers and accounts of every file, with the file envs applied to commands', () => {
    const catalog = collect(
      file('a.yaml', {
        envs: { PROJECT: 'prj', NESTED: '$HOME/x' },
        secretProviders: {
          gsm: {
            command: ['gcloud', '--project=${PROJECT}', '--other=${HOST_ONLY}', '--nested=${NESTED}', '{{ref}}'],
            env: { A: 'b' },
            timeout: '2m',
          },
        },
      }),
      file('b.yaml', {
        secretAccounts: { test: { default: true, providers: { gsm: { env: { X: '${Y}' } } } } },
      })
    )
    expect(catalog.providers.gsm).toEqual({
      name: 'gsm',
      type: 'command',
      command: ['gcloud', '--project=prj', '--other=${HOST_ONLY}', '--nested=${NESTED}', '{{ref}}'],
      env: { A: 'b' },
      timeoutMs: 120000,
      declaredIn: 'a.yaml',
    })
    expect(catalog.accounts.test).toEqual({
      name: 'test',
      default: true,
      providers: { gsm: { env: { X: '${Y}' } } },
      declaredIn: 'b.yaml',
    })
  })

  it('times a provider out after 30 seconds unless told otherwise', () => {
    expect(collect(file('a.yaml', { secretProviders: { p: { command: ['x'] } } })).providers.p.timeoutMs).toBe(30000)
  })

  it('rejects a name declared twice, naming both files', () => {
    const provider = { secretProviders: { p: { command: ['x'] } } }
    expect(() => collect(file('a.yaml', provider), file('b.yaml', provider))).toThrow(
      'secret provider p is declared in a.yaml and in b.yaml'
    )
    const account = { secretProviders: { p: { command: ['x'] } }, secretAccounts: { t: { providers: {} } } }
    expect(() => collect(file('a.yaml', account), file('b.yaml', { secretAccounts: account.secretAccounts }))).toThrow(
      'secret account t is declared in a.yaml and in b.yaml'
    )
  })

  describe('git sources', () => {
    const declares: BuildFileSchema = { secretProviders: { p: { command: ['x'] } } }

    it.each([
      ['a branch', 'main'],
      ['a tag', 'v1'],
      ['no ref', null],
      ['a short SHA', sha.substring(0, 12)],
      ['a SHA with a prefix', `v${sha}`],
      ['a SHA with a suffix', `${sha}0`],
      ['a SHA with a line behind it', `${sha}\nmain`],
    ])('refuses %s for a file that declares providers', (_name, ref) => {
      expect(() => collect(file('a.yaml', declares, { git: 'g', ref }))).toThrow(
        'a.yaml declares secret providers or accounts, so its git include g needs ref to be a full commit SHA'
      )
    })

    it('accepts a full commit SHA, in either case', () => {
      expect(Object.keys(collect(file('a.yaml', declares, { git: 'g', ref: sha })).providers)).toEqual(['p'])
      expect(Object.keys(collect(file('a.yaml', declares, { git: 'g', ref: sha.toUpperCase() })).providers)).toEqual([
        'p',
      ])
    })

    it('leaves a git file that declares none alone, whatever its ref', () => {
      expect(collect(file('a.yaml', { tasks: {} }, { git: 'g', ref: 'main' }))).toEqual({ providers: {}, accounts: {} })
    })
  })
})
