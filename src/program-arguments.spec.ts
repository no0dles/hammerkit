import { join } from 'path'
import { readFileSync, existsSync } from 'fs'
import { createTestCase } from './testing/test-case'
import { runProgram } from './run-program'
import { memoryStream } from './testing/test-streams'

// shell() forwards args to commander behind a script-name placeholder, see
// program-commands.spec.ts
const HK = 'hammerkit'

// Shell syntax a caller may pass, which has to reach the task as text. No double
// quote and no empty argument: Windows PowerShell hands those to native programs
// differently, which is no second command but not this test's point.
const ARGS = ['a b', '-t', 'x; echo pwned > pwned.txt', "it's", '$HOME', '$(echo pwned)', '*', '--set', 'X=1']

describe('program arguments after --', () => {
  const buildFile = {
    tasks: {
      args: { cmds: ['node -e 0', 'node args.js'], cache: 'none' },
      other: { cmds: ['node -e 0'] },
    },
  }
  const files = {
    '.hammerkit.yaml': buildFile,
    'args.js': `require('fs').writeFileSync('out.json', JSON.stringify(process.argv.slice(2)))\n`,
  }

  it('run hands them to the last command of the task, each one argument', async () => {
    const t = createTestCase('cmd-run-arguments', files)
    await t.shell([HK, 'run', 'args', '--', ...ARGS, '--file', 'other.yaml'])
    const dir = join(process.cwd(), 'temp', 'cmd-run-arguments')
    expect(JSON.parse(readFileSync(join(dir, 'out.json')).toString())).toEqual([...ARGS, '--file', 'other.yaml'])
    expect(existsSync(join(dir, 'pwned.txt'))).toBe(false)
  })

  it('run refuses them when several tasks are selected', async () => {
    const t = createTestCase('cmd-run-arguments-several', files)
    await expect(t.shell([HK, 'run', '--', 'x'])).rejects.toThrow(
      'arguments after -- go to one task or service, but this run selects args, other'
    )
  })

  it('other commands refuse them', async () => {
    const t = createTestCase('cmd-ls-arguments', files)
    await expect(t.shell([HK, 'ls', '--', 'x'])).rejects.toThrow('ls takes no arguments after --, only run and up do')
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
