import { join } from 'path'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, linkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { environmentMock } from '../executer/environment-mock'
import { Environment } from '../executer/environment'
import { AbortError } from '../executer/abort'
import { createCommandSecretProvider, ownInvocation } from './command-secret-provider'

const fake = join(__dirname, '..', 'testing', 'fake-secret-cli.cjs')

describe('command secret provider', () => {
  let scratch: string
  let environment: Environment

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'hammerkit-provider-'))
    environment = environmentMock(scratch)
    environment.processEnvs = { PATH: process.env.PATH, UNRELATED: 'visible?', SA_TOKEN: 'sa-one' }
  })
  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true })
  })

  function provider(
    mode: string,
    options: {
      command?: string[]
      env?: { [key: string]: string }
      accountEnv?: { [key: string]: string }
      timeoutMs?: number
    } = {}
  ) {
    return createCommandSecretProvider({
      definition: {
        name: 'fake',
        type: 'command',
        command: options.command ?? [process.execPath, fake, mode, '{{ref}}'],
        env: options.env ?? {},
        timeoutMs: options.timeoutMs ?? 10000,
        declaredIn: 'test',
      },
      account: { name: 'test', env: options.accountEnv ?? { FAKE_TOKEN: '${SA_TOKEN}' } },
    })
  }

  it('returns stdout verbatim, as the account', async () => {
    expect(await provider('value').resolve('db', environment)).toEqual('value-of-db-as-sa-one\n')
  })

  it('passes the reference as one argument, never to a shell', async () => {
    const ref = 'a b; touch pwned'
    expect(await provider('value').resolve(ref, environment)).toEqual(`value-of-${ref}-as-sa-one\n`)
  })

  it('runs the command with PATH, the provider env and the account env only', async () => {
    const calls = join(scratch, 'calls')
    const names = JSON.parse(
      await provider('env', { env: { FAKE_CALLS: calls, STATIC: 'x' } }).resolve('x', environment)
    )
    expect(names).toEqual(expect.arrayContaining(['FAKE_CALLS', 'FAKE_TOKEN', 'STATIC']))
    expect(names).not.toContain('UNRELATED')
    expect(names).not.toContain('SA_TOKEN')
    expect(names).not.toContain('HOME')
  })

  it('expands host variables in the command, the provider env and the account env', async () => {
    environment.processEnvs = { ...environment.processEnvs, PROJECT: 'prj' }
    const value = await provider('value', {
      command: [process.execPath, fake, 'value', '{{ref}}-${PROJECT}'],
    }).resolve('db', environment)
    expect(value).toEqual('value-of-db-prj-as-sa-one\n')
  })

  it('fails without running the command when an account variable is not set', async () => {
    const calls = join(scratch, 'calls')
    environment.processEnvs = { PATH: process.env.PATH }
    await expect(provider('value', { env: { FAKE_CALLS: calls } }).resolve('db', environment)).rejects.toThrow(
      'account test, provider fake: SA_TOKEN is not set'
    )
    expect(() => readFileSync(calls)).toThrow()
  })

  it('reports a failing command with its masked stderr', async () => {
    environment.secrets.register('sa-one')
    await expect(provider('fail').resolve('db', environment)).rejects.toThrow(/exited with code 3: denied: db \*\*\*/)
  })

  it('reports a missing binary', async () => {
    await expect(
      provider('value', { command: ['no-such-secret-cli-binary', '{{ref}}'] }).resolve('x', environment)
    ).rejects.toThrow('no-such-secret-cli-binary was not found on PATH')
  })

  it('stops a command that outlives its timeout', async () => {
    await expect(provider('hang', { timeoutMs: 200 }).resolve('x', environment)).rejects.toThrow(
      'did not finish within 200ms'
    )
  })

  it('stops a command when the run is aborted', async () => {
    const pending = provider('hang').resolve('x', environment)
    setTimeout(() => environment.abortCtrl.abort(), 100)
    await expect(pending).rejects.toBeInstanceOf(AbortError)
  })
})

describe('a provider that is the release binary itself', () => {
  let scratch: string
  let binary: string
  let bin: string

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'hammerkit-own-'))
    bin = join(scratch, 'bin')
    mkdirSync(bin)
    binary = join(scratch, 'hammerkit-release')
    writeFileSync(binary, 'binary')
    writeFileSync(join(bin, 'other'), 'another binary')
  })
  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true })
  })

  const self = () => ({ execPath: binary, entry: '/snapshot/hammerkit/dist/index.js' })

  it('starts the binary with its entry script when the command is found on PATH', () => {
    linkSync(binary, join(bin, 'hammerkit'))
    expect(ownInvocation('hammerkit', ['github-app-token', 'a/b'], bin, self())).toEqual({
      command: binary,
      args: ['/snapshot/hammerkit/dist/index.js', 'github-app-token', 'a/b'],
    })
  })

  it('starts the binary with its entry script when the command is its path', () => {
    expect(ownInvocation(binary, ['--version'], '', self())).toEqual({
      command: binary,
      args: ['/snapshot/hammerkit/dist/index.js', '--version'],
    })
  })

  it('leaves any other command as it is', () => {
    expect(ownInvocation('other', ['x'], bin, self())).toEqual({ command: 'other', args: ['x'] })
    expect(ownInvocation('missing', ['x'], bin, self())).toEqual({ command: 'missing', args: ['x'] })
  })

  it('leaves the command as it is when hammerkit is not a release binary', () => {
    linkSync(binary, join(bin, 'hammerkit'))
    expect(ownInvocation('hammerkit', ['x'], bin, { execPath: null, entry: 'unused' })).toEqual({
      command: 'hammerkit',
      args: ['x'],
    })
  })
})
