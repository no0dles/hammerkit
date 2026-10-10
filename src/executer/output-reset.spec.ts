import { join } from 'path'
import { createTestCase } from '../testing/test-case'
import { createCli } from '../program'
import { Cli } from '../cli'
import { Environment } from './environment'

// When a task runs, its outputs start empty: what an earlier run left behind
// is an input nobody declared (a deleted source's stale output, files a failed
// run wrote), and it would travel into the cache with the next result.

// Local task execution is not reliable on the Windows hosted runner (see
// execute.spec.ts), so gate these real runs off win32.
const itExceptWindows = process.platform === 'win32' ? it.skip : it

// A failed run aborts its environment; every hammerkit command starts with a fresh one.
function run(cli: Cli, environment: Environment) {
  environment.abortCtrl = new AbortController()
  return cli.runExec()
}

function project(name: string, task: { [key: string]: unknown }, files: { [key: string]: string } = {}) {
  return createTestCase(name, {
    '.git/HEAD': 'ref: refs/heads/main\n',
    '.hammerkit.yaml': { tasks: { build: task } },
    'input.txt': 'a\n',
    ...files,
  })
}

// writes out/<content of input.txt>, so a second input leaves a second file
const writesOneFile = ['mkdir -p out', 'touch "out/$(cat input.txt)"']

describe('task outputs on a run', () => {
  itExceptWindows('start empty', async () => {
    await project('outputs-start-empty', { src: ['input.txt'], generates: ['out'], cmds: writesOneFile }).setup(
      async (cwd, environment) => {
        const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, { taskName: 'build' })
        await cli.clean({ cache: true })
        expect((await run(cli, environment)).success).toBe(true)
        await environment.file.writeFile(join(cwd, 'input.txt'), 'b\n')
        expect((await run(cli, environment)).success).toBe(true)
        expect(await environment.file.listFiles(join(cwd, 'out'))).toEqual(['b'])
      }
    )
  })

  itExceptWindows('keep their content with resetOnChange: false', async () => {
    await project('outputs-kept', {
      src: ['input.txt'],
      generates: [{ path: 'out', resetOnChange: false }],
      cmds: writesOneFile,
    }).setup(async (cwd, environment) => {
      const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, { taskName: 'build' })
      await cli.clean({ cache: true })
      expect((await run(cli, environment)).success).toBe(true)
      await environment.file.writeFile(join(cwd, 'input.txt'), 'b\n')
      expect((await run(cli, environment)).success).toBe(true)
      expect((await environment.file.listFiles(join(cwd, 'out'))).sort()).toEqual(['a', 'b'])
    })
  })

  // `npm install` declares package-lock.json both ways: emptying it would throw
  // away the source. Neither an output that is a source nor one containing a
  // source is emptied.
  itExceptWindows('are not emptied where they are sources too', async () => {
    await project(
      'outputs-overlapping-sources',
      {
        src: ['input.txt', 'lock.txt', 'data/in.txt'],
        generates: ['lock.txt', 'data'],
        cmds: ['cat lock.txt data/in.txt', 'touch "data/$(cat input.txt)"'],
      },
      { 'lock.txt': 'locked\n', 'data/in.txt': 'in\n' }
    ).setup(async (cwd, environment) => {
      const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, { taskName: 'build' })
      // clean deletes a local task's declared outputs, these included
      await cli.clean({ cache: true })
      await environment.file.writeFile(join(cwd, 'lock.txt'), 'locked\n')
      await environment.file.createDirectory(join(cwd, 'data'))
      await environment.file.writeFile(join(cwd, 'data', 'in.txt'), 'in\n')
      expect((await run(cli, environment)).success).toBe(true)
      await environment.file.writeFile(join(cwd, 'input.txt'), 'b\n')
      expect((await run(cli, environment)).success).toBe(true)
      expect(await environment.file.read(join(cwd, 'lock.txt'))).toBe('locked\n')
      expect((await environment.file.listFiles(join(cwd, 'data'))).sort()).toEqual(['a', 'b', 'in.txt'])
    })
  })
})
