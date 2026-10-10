import { join } from 'path'
import { readFileSync } from 'fs'
import { createTestCase } from '../testing/test-case'
import { memoryStream } from '../testing/test-streams'
import { runProgram } from '../run-program'
import { Environment } from '../executer/environment'

const HK = 'hammerkit'

// The commands work on the machine's config file, so they need no build file;
// HAMMERKIT_CONFIG keeps the tests away from the real one.
async function withConfig(
  name: string,
  fn: (run: (...args: string[]) => Promise<string>, configFile: string, environment: Environment) => Promise<void>
) {
  await createTestCase(name, {}).setup(async (cwd, environment) => {
    const configFile = join(cwd, 'config.yaml')
    environment.processEnvs = { ...environment.processEnvs, HAMMERKIT_CONFIG: configFile }
    const run = async (...args: string[]) => {
      const out = memoryStream()
      environment.stdout = out.stream
      await runProgram(environment, [HK, ...args], true)
      return out.read()
    }
    await fn(run, configFile, environment)
  })
}

describe('remote commands', () => {
  it('registers, lists, sets the default and removes a server', async () => {
    await withConfig('remote-commands-lifecycle', async (run, configFile) => {
      expect(await run('remote', 'list')).toContain('no servers registered')

      expect(await run('remote', 'add', 'mac-mini', 'https://mac-mini.corp', '--issuer', 'https://idp.corp')).toContain(
        'added mac-mini: https://mac-mini.corp (issuer https://idp.corp)'
      )
      await run('remote', 'add', 'corp-k8s', 'https://hammerkit.corp', '--issuer', 'https://idp.corp')
      expect(readFileSync(configFile, 'utf8')).toContain('url: https://mac-mini.corp')

      expect(await run('remote', 'use', 'corp-k8s')).toContain('default location: corp-k8s')
      const listing = await run('remote', 'list')
      expect(listing).toContain('mac-mini')
      expect(listing).toMatch(/corp-k8s.*\(default\).*https:\/\/hammerkit\.corp/)

      expect(await run('remote', 'use', 'auto')).toContain('default location: auto')
      expect(await run('remote', 'list')).toContain('default location: auto')

      await run('remote', 'use', 'corp-k8s')
      const removed = await run('remote', 'remove', 'corp-k8s')
      expect(removed).toContain('removed corp-k8s')
      expect(removed).toContain('runs are local again')
      expect(await run('remote', 'remove', 'mac-mini')).not.toContain('local again')
      expect(await run('remote', 'list')).toContain('no servers registered')
    })
  })

  it.each([
    [['remote', 'add', 'a', 'http://a.corp', '--issuer', 'https://idp.corp'], 'must use https'],
    [['remote', 'add', 'local', 'https://a.corp', '--issuer', 'https://idp.corp'], 'reserved'],
    [['remote', 'add', 'a', 'https://a.corp', '--issuer', 'idp.corp'], 'invalid issuer'],
    [['remote', 'use', 'nowhere'], 'hammerkit remote add nowhere'],
    [['remote', 'remove', 'nowhere'], 'not registered'],
  ])('fails with a clear message for %j', async (args, message) => {
    await withConfig('remote-commands-errors', async (run) => {
      await expect(run(...args)).rejects.toThrow(message)
    })
  })

  it('refuses to repoint a name unless forced', async () => {
    await withConfig('remote-commands-force', async (run) => {
      await run('remote', 'add', 'a', 'https://a.corp', '--issuer', 'https://idp.corp')
      await expect(run('remote', 'add', 'a', 'https://evil.example', '--issuer', 'https://idp.corp')).rejects.toThrow(
        'use --force'
      )
      expect(await run('remote', 'add', 'a', 'https://b.corp', '--issuer', 'https://idp.corp', '--force')).toContain(
        'added a: https://b.corp'
      )
    })
  })

  it('works next to a build file, which it does not read', async () => {
    await createTestCase('remote-commands-build-file', { '.hammerkit.yaml': 'tasks: {}\n' }).setup(
      async (cwd, environment) => {
        environment.processEnvs = { ...environment.processEnvs, HAMMERKIT_CONFIG: join(cwd, 'config.yaml') }
        const out = memoryStream()
        environment.stdout = out.stream
        await runProgram(environment, [HK, 'remote', 'list'], true)
        expect(out.read()).toContain('no servers registered')
      }
    )
  })
})
