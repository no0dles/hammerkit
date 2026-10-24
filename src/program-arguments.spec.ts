import { join } from 'path'
import { readFileSync, existsSync } from 'fs'
import { createTestCase } from './testing/test-case'
import { runProgram } from './run-program'
import { memoryStream } from './testing/test-streams'
import { statusConsole } from './planner/work-item-status'
import { consoleContext } from './log'

// shell() forwards args to commander behind a script-name placeholder, see
// program-commands.spec.ts
const HK = 'hammerkit'

// Shell syntax a caller may pass, which has to reach the task as text, and
// hammerkit's own options, which are arguments after --.
const ARGS = ['a b', '-t', 'x; echo pwned > pwned.txt', "it's", '$HOME', '$(echo pwned)', '*', '--set', 'X=1']

// Local task execution is not reliable on the Windows hosted runner (see
// execute.spec.ts), so the real run is gated off win32; task-arguments.spec.ts
// runs the PowerShell quoting there.
const itExceptWindows = process.platform === 'win32' ? it.skip : it

describe('program arguments after --', () => {
  const buildFile = {
    tasks: {
      args: { cmds: ['node args.js'], cache: 'none' },
      other: { cmds: ['node -e 0'] },
    },
  }
  const files = {
    '.hammerkit.yaml': buildFile,
    'args.js': `require('fs').writeFileSync('out.json', JSON.stringify(process.argv.slice(2)))\n`,
  }

  itExceptWindows('run hands them to the last command of the task, each one argument', async () => {
    const t = createTestCase('cmd-run-arguments', files)
    const status = memoryStream()
    await t.setup(async (cwd, environment) => {
      await runProgram(
        { ...environment, status: statusConsole(status.stream, environment.secrets) },
        [HK, 'run', 'args', '--', ...ARGS, '--file', 'other.yaml'],
        true
      )
    })
    const dir = join(process.cwd(), 'temp', 'cmd-run-arguments')
    // the task's log tells why when it wrote nothing
    expect(existsSync(join(dir, 'out.json')) || status.read()).toBe(true)
    expect(JSON.parse(readFileSync(join(dir, 'out.json')).toString())).toEqual([...ARGS, '--file', 'other.yaml'])
    expect(existsSync(join(dir, 'pwned.txt'))).toBe(false)
  })

  itExceptWindows('run with them skips the cache and leaves no stale hit for a run without them', async () => {
    const t = createTestCase('cmd-run-arguments-cache', {
      '.hammerkit.yaml': { tasks: { build: { cmds: ['node build.js'], src: ['build.js'], generates: ['out.json'] } } },
      'build.js':
        `require('fs').writeFileSync('out.json', JSON.stringify(process.argv.slice(2)))\n` +
        `require('fs').appendFileSync('runs.txt', 'x')\n`,
    })
    const dir = join(process.cwd(), 'temp', 'cmd-run-arguments-cache')
    const output = () => JSON.parse(readFileSync(join(dir, 'out.json')).toString())
    const runs = () => (existsSync(join(dir, 'runs.txt')) ? readFileSync(join(dir, 'runs.txt')).length : 0)
    await t.setup(async (cwd, environment) => {
      const run = (...args: string[]) => runProgram(environment, [HK, 'run', 'build', ...args], true)

      await run()
      expect(output()).toEqual([])
      await run('--', '--prod')
      expect(output()).toEqual(['--prod'])
      const before = runs()
      await run('--', '--prod')
      expect(runs()).toBe(before + 1)
      // the outputs are the --prod ones now, so the record of the plain run is gone
      await run()
      expect(output()).toEqual([])

      // an explicit --cache keeps the cache for a run with arguments
      await run('--cache', 'checksum', '--', '--prod')
      expect(output()).toEqual(['--prod'])
      const cached = runs()
      await run('--cache', 'checksum', '--', '--prod')
      expect(runs()).toBe(cached)
      expect(output()).toEqual(['--prod'])
      await run()
      expect(output()).toEqual([])
    })
  })

  it('run refuses them when several tasks are selected', async () => {
    const t = createTestCase('cmd-run-arguments-several', files)
    await expect(t.shell([HK, 'run', '--', 'x'])).rejects.toThrow(
      'arguments after -- go to one task or service, but this run selects args, other'
    )
  })

  itExceptWindows('run counts the tasks it selects, not the services', async () => {
    const t = createTestCase('cmd-run-arguments-services', {
      ...files,
      '.hammerkit.yaml': {
        tasks: { args: { cmds: ['node args.js'], labels: { app: 'x' } } },
        services: { api: { image: 'node', cmd: 'node server.js', labels: { app: 'x' } } },
      },
    })
    await t.setup(async (cwd, environment) => {
      await runProgram(environment, [HK, 'run', '--filter', 'app=x', '--', 'x'], true)
    })
    const dir = join(process.cwd(), 'temp', 'cmd-run-arguments-services')
    expect(JSON.parse(readFileSync(join(dir, 'out.json')).toString())).toEqual(['x'])
  })

  it('up hands them to the selected service, before anything starts', async () => {
    const t = createTestCase('cmd-up-arguments', {
      '.hammerkit.yaml': {
        services: {
          api: { image: 'node', cmd: 'node server.js', labels: { svc: 'api' } },
          web: { image: 'nginx', labels: { svc: 'web' } },
        },
      },
    })
    // the refusals name the service, so the arguments reached it
    const up = async (...args: string[]) => {
      const errors = memoryStream()
      await t.setup(async (cwd, environment) => {
        await expect(
          runProgram({ ...environment, console: consoleContext(errors.stream) }, [HK, 'up', ...args], true)
        ).rejects.toThrow('Up was not successful')
      })
      return errors.read()
    }
    expect(await up('--filter', 'svc=web', '--', '--inspect')).toContain(
      'service web has no cmd for the arguments after --'
    )
    expect(await up('--', '--inspect')).toContain(
      'arguments after -- go to one task or service, but this run selects api, web'
    )
  })

  it('other commands refuse them', async () => {
    const t = createTestCase('cmd-ls-arguments', files)
    await expect(t.shell([HK, 'ls', '--', 'x'])).rejects.toThrow('ls takes no arguments after --, only run, up and remote run do')
  })

  it('ls --json shows the command the arguments are appended to', async () => {
    const t = createTestCase('cmd-ls-json', {
      '.hammerkit.yaml': {
        ...buildFile,
        services: { api: { image: 'node', cmd: 'node server.js', ports: ['3000'] }, web: { image: 'nginx' } },
      },
    })
    const stdout = memoryStream()
    await t.setup(async (cwd, environment) => {
      await runProgram({ ...environment, stdout: stdout.stream }, [HK, 'ls', '--json'], true)
    })
    const listed = JSON.parse(stdout.read())
    expect(listed.tasks.map((task: any) => [task.name, task.command])).toEqual([
      ['args', 'node args.js'],
      ['other', 'node -e 0'],
    ])
    expect(listed.services.map((service: any) => [service.name, service.command])).toEqual([
      ['api', 'node server.js'],
      ['web', null],
    ])
    expect(listed.services[0]).toMatchObject({ type: 'container-service', image: 'node', ports: [{ container: 3000 }] })
  })
})
