import { spawnSync } from 'child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { platform, tmpdir } from 'os'
import { join } from 'path'
import {
  appendArguments,
  getKubernetesCommandArgs,
  getKubernetesCommandText,
  getShellQuoting,
  isRefusedByWindowsPowerShell,
  quoteArgument,
} from './task-arguments'
import { createTestCase } from '../../testing/test-case'
import { createCli } from '../../program'
import { WorkScope } from '../../executer/work-scope'
import { ContainerWorkService, getServiceCommand, WorkService } from '../work-service'
import { getServiceDefinitionHash } from '../service-definition'
import { WorkItem } from '../work-item'
import { getDeclaredWorkTaskId } from '../work-cache-id'

const HOSTILE = [
  'a b',
  '-t',
  'a; echo pwned > pwned.txt',
  "it's",
  '$HOME',
  '$(echo pwned)',
  '`echo pwned`',
  '*',
  'two\nlines',
  '',
  '\\',
  '"double"',
]

// Windows PowerShell can take half a minute to start on the hosted runner
const SHELL_TIMEOUT = Number(process.env.HAMMERKIT_TEST_TIMEOUT) || 120000

describe('task arguments', () => {
  describe('quoting', () => {
    it('knows sh and its relatives, and PowerShell, by program name', () => {
      expect(getShellQuoting('/bin/sh')).toBe('posix')
      expect(getShellQuoting('bash')).toBe('posix')
      expect(getShellQuoting('/usr/bin/zsh')).toBe('posix')
      expect(getShellQuoting('pwsh')).toBe('powershell')
      expect(getShellQuoting('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')).toBe('powershell')
      expect(getShellQuoting('fish')).toBeNull()
      expect(getShellQuoting('cmd.exe')).toBeNull()
    })

    it('single-quotes for sh, closing and reopening around a quote', () => {
      expect(quoteArgument('login flow', 'posix')).toBe(`'login flow'`)
      expect(quoteArgument("it's", 'posix')).toBe(`'it'\\''s'`)
    })

    it('doubles single quotes for PowerShell, the typographic ones too', () => {
      expect(quoteArgument("it's", 'powershell')).toBe(`'it''s'`)
      expect(quoteArgument('it\u2019s', 'powershell')).toBe(`'it\u2019\u2019s'`)
    })

    it(
      'keeps every argument one word of text in the shell of local tasks',
      () => {
        // the shell executeCommand runs a local command in, with this process' env
        const windows = platform() === 'win32'
        // what a local task on Windows takes at all, see isRefusedByWindowsPowerShell
        const args = windows ? HOSTILE.filter((arg) => !isRefusedByWindowsPowerShell(arg)) : HOSTILE
        const dir = mkdtempSync(join(tmpdir(), 'hammerkit-arguments-'))
        try {
          writeFileSync(join(dir, 'args.js'), 'process.stdout.write(JSON.stringify(process.argv.slice(2)))')
          const command = appendArguments(
            { cwd: dir, cmd: 'node args.js', parsed: { command: 'node', args: ['args.js'] } },
            args,
            windows ? 'powershell' : 'posix'
          )
          const result = spawnSync(command.cmd, { cwd: dir, shell: windows ? 'powershell.exe' : true })
          expect(result.stderr.toString()).toBe('')
          expect(JSON.parse(result.stdout.toString())).toEqual(args)
          expect(existsSync(join(dir, 'pwned.txt'))).toBe(false)
        } finally {
          rmSync(dir, { recursive: true, force: true })
        }
      },
      SHELL_TIMEOUT
    )

    it('refuses on Windows PowerShell what it would split or run', () => {
      for (const arg of ['', 'say "hi"', 'a&calc', 'a|b', '<in', '>out', '^', '%PATH%', '!x!', 'two\nlines']) {
        expect(isRefusedByWindowsPowerShell(arg)).toBe(true)
      }
      for (const arg of ['a b', '-t', "it's", '$HOME', '*', 'src\\login.spec.ts']) {
        expect(isRefusedByWindowsPowerShell(arg)).toBe(false)
      }
    })

    it('doubles $ in the arguments for Kubernetes, and only there', () => {
      const command = appendArguments(
        { cwd: '/', cmd: 'echo $HOME', parsed: { command: 'echo', args: ['$HOME'] } },
        ['costs $(HOME) $$'],
        'posix'
      )
      expect(getKubernetesCommandText(command)).toBe(`echo $HOME 'costs $$(HOME) $$$$'`)
      expect(getKubernetesCommandArgs(command)).toEqual(['$HOME', 'costs $$(HOME) $$$$'])
      const declared = { cwd: '/', cmd: 'echo $$', parsed: { command: 'echo', args: ['$$'] } }
      expect(getKubernetesCommandText(declared)).toBe('echo $$')
      expect(getKubernetesCommandArgs(declared)).toEqual(['$$'])
    })

    it('appends the raw arguments to the parsed exec form', () => {
      const command = appendArguments(
        { cwd: '/', cmd: 'node server.js', parsed: { command: 'node', args: ['server.js'] } },
        ['--inspect', 'a b'],
        'exec'
      )
      expect(command.parsed).toEqual({ command: 'node', args: ['server.js', '--inspect', 'a b'] })
      expect(command.cmd).toBe(`node server.js '--inspect' 'a b'`)
    })
  })

  describe('planning', () => {
    const buildFile = {
      tasks: {
        build: { image: 'alpine', cmds: ['echo build'] },
        test: { image: 'alpine', deps: ['build'], cmds: ['echo setup', 'npx vitest run'], labels: { app: 'web' } },
        lint: { image: 'alpine', cmds: ['eslint .'], labels: { app: 'web' } },
        fish: { image: 'alpine', shell: 'fish', cmds: ['echo hi'] },
        empty: { image: 'alpine', deps: ['build'] },
        local: { cmds: ['node args.js'] },
        migrate: { image: 'alpine', cmds: ['migrate up'] },
      },
      services: {
        api: { image: 'node', cmd: 'node server.js', labels: { svc: 'api' } },
        shelled: { image: 'node', shell: 'bash', cmd: 'node server.js', labels: { svc: 'shelled' } },
        plain: { image: 'nginx', labels: { svc: 'plain' } },
        db: { image: 'postgres', cmd: 'postgres', init: 'migrate', healthcheck: { cmd: 'pg_isready' } },
      },
    }

    async function plan(scope: WorkScope, fn: (cli: Awaited<ReturnType<typeof createCli>>) => void) {
      await createTestCase(`task-arguments-plan`, { '.hammerkit.yaml': buildFile }).setup(async (cwd, environment) => {
        fn(await createCli(join(cwd, '.hammerkit.yaml'), environment, scope))
      })
    }

    const task = (values: string[]): WorkScope => ({ taskName: 'test', args: { values, services: false } })

    it('appends the arguments to the last command only', async () => {
      await plan(task(['src/login.spec.ts', '-t', 'login flow']), (cli) => {
        expect(cli.task('test').data.cmds.map((c) => c.cmd)).toEqual([
          'echo setup',
          `npx vitest run 'src/login.spec.ts' '-t' 'login flow'`,
        ])
      })
    })

    it('skips the cache of the task, not of its dependencies, unless asked to keep it', async () => {
      await plan({ taskName: 'test' }, (cli) => {
        expect(cli.task('test').data.caching).toMatchObject({ method: 'checksum', implicit: true })
      })
      await plan(task(['-t', 'a']), (cli) => {
        expect(cli.task('test').data.caching).toMatchObject({ name: 'default', method: 'none', implicit: false })
        expect(cli.task('build').data.caching).toMatchObject({ method: 'checksum', implicit: true })
      })
      await plan({ taskName: 'test', args: { values: ['-t', 'a'], services: false, cache: true } }, (cli) => {
        expect(cli.task('test').data.caching).toMatchObject({ method: 'checksum', implicit: true })
      })
    })

    it('keeps the id the build file declares apart from the arguments', async () => {
      let declared = ''
      await plan({ taskName: 'test' }, (cli) => {
        declared = cli.task('test').id()
        expect(getDeclaredWorkTaskId(cli.task('test'))).toBe(declared)
      })
      await plan(task(['-t', 'a']), (cli) => {
        expect(getDeclaredWorkTaskId(cli.task('test'))).toBe(declared)
      })
    })

    it('refuses on Windows the local task arguments PowerShell would split or run', async () => {
      const local = { taskName: 'local', args: { values: ['a&calc'], services: false } }
      if (platform() === 'win32') {
        await expect(plan(local, () => undefined)).rejects.toThrow('runs in Windows PowerShell')
      } else {
        await plan(local, (cli) => {
          expect(cli.task('local').data.cmds.map((c) => c.cmd)).toEqual([`node args.js 'a&calc'`])
        })
      }
    })

    it('makes the arguments part of the task id, and never of the dependencies', async () => {
      let without = { test: '', build: '' }
      await plan({ taskName: 'test' }, (cli) => {
        without = { test: cli.task('test').id(), build: cli.task('build').id() }
      })
      await plan(task([]), (cli) => {
        expect(cli.task('test').id()).toBe(without.test)
      })
      let withA = ''
      await plan(task(['-t', 'a']), (cli) => {
        withA = cli.task('test').id()
        expect(withA).not.toBe(without.test)
        expect(cli.task('build').id()).toBe(without.build)
        expect(cli.task('build').data.cmds.map((c) => c.cmd)).toEqual(['echo build'])
      })
      await plan(task(['-t', 'b']), (cli) => {
        expect(cli.task('test').id()).not.toBe(withA)
      })
      await plan(task(['-t', 'a']), (cli) => {
        expect(cli.task('test').id()).toBe(withA)
      })
    })

    it('refuses arguments for several selected tasks, naming them', async () => {
      await expect(
        plan({ filterLabels: { app: ['web'] }, args: { values: ['-x'], services: false } }, () => undefined)
      ).rejects.toThrow('arguments after -- go to one task or service, but this run selects test, lint')
    })

    it('takes an empty list as no arguments, whatever is selected', async () => {
      await plan({ filterLabels: { app: ['web'] }, args: { values: [], services: false } }, (cli) => {
        expect(cli.task('lint').data.cmds.map((c) => c.cmd)).toEqual(['eslint .'])
      })
    })

    it('refuses a task without commands, and a shell it cannot quote for', async () => {
      await expect(
        plan({ taskName: 'empty', args: { values: ['x'], services: false } }, () => undefined)
      ).rejects.toThrow('task empty has no command for the arguments after --')
      await expect(
        plan({ taskName: 'fish', args: { values: ['x'], services: false } }, () => undefined)
      ).rejects.toThrow("task fish runs in fish, whose quoting hammerkit doesn't know")
    })

    const service = (svc: string, values: string[]): WorkScope => ({
      filterLabels: { svc: [svc] },
      args: { values, services: true },
    })
    const command = (item: WorkService) => (item.type === 'container-service' ? getServiceCommand(item) : null)

    it('appends the arguments to the cmd of the selected service', async () => {
      await plan(service('api', ['--inspect', 'a b']), (cli) => {
        expect(command(cli.service('api').data)).toEqual({
          entrypoint: null,
          cmd: ['node', 'server.js', '--inspect', 'a b'],
        })
      })
      await plan(service('shelled', ['--inspect', 'a b']), (cli) => {
        expect(command(cli.service('shelled').data)).toEqual({
          entrypoint: ['bash', '-c'],
          cmd: [`node server.js '--inspect' 'a b'`],
        })
      })
    })

    it('leaves a service as it is when its init task runs with arguments', async () => {
      let definition = ''
      await plan({ taskName: 'migrate' }, (cli) => {
        definition = getServiceDefinitionHash(cli.service('db') as WorkItem<ContainerWorkService>)
      })
      await plan({ taskName: 'migrate', args: { values: ['--dry-run'], services: false } }, (cli) => {
        expect(cli.task('migrate').data.cmds.map((c) => c.cmd)).toEqual([`migrate up '--dry-run'`])
        expect(getServiceDefinitionHash(cli.service('db') as WorkItem<ContainerWorkService>)).toBe(definition)
      })
    })

    it('refuses a service without cmd', async () => {
      await expect(plan(service('plain', ['x']), () => undefined)).rejects.toThrow(
        'service plain has no cmd for the arguments after --'
      )
    })

    it('leaves services out of a run, which only runs tasks', async () => {
      await plan({ filterLabels: { svc: ['api'] }, args: { values: ['x'], services: false } }, (cli) => {
        expect(command(cli.service('api').data)?.cmd).toEqual(['node', 'server.js'])
      })
    })
  })
})
