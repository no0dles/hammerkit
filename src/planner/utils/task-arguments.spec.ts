import { execFileSync } from 'child_process'
import { platform } from 'os'
import { join } from 'path'
import { appendArguments, getShellQuoting, quoteArgument } from './task-arguments'
import { createTestCase } from '../../testing/test-case'
import { createCli } from '../../program'
import { WorkScope } from '../../executer/work-scope'
import { getServiceCommand, WorkService } from '../work-service'

const HOSTILE = [
  'a b',
  '-t',
  'a; echo pwned',
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

    it('keeps every argument one word of text in a real sh', () => {
      if (platform() === 'win32') {
        // no sh on the windows runner; the PowerShell side is covered by the local task test below
        expect(getShellQuoting('powershell.exe')).toBe('powershell')
        return
      }
      const command = appendArguments(
        { cwd: '/', cmd: `printf '%s\\0'`, parsed: { command: 'printf', args: ['%s\\0'] } },
        HOSTILE,
        'posix'
      )
      const output = execFileSync('sh', ['-c', command.cmd]).toString()
      expect(output.split('\0').slice(0, -1)).toEqual(HOSTILE)
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
      },
      services: {
        api: { image: 'node', cmd: 'node server.js', labels: { svc: 'api' } },
        shelled: { image: 'node', shell: 'bash', cmd: 'node server.js', labels: { svc: 'shelled' } },
        plain: { image: 'nginx', labels: { svc: 'plain' } },
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

    it('makes the arguments part of the cache key, and never of the dependencies', async () => {
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
