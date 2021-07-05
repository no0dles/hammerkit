import { getProgram } from '../src/program'
import { join } from 'path'
import {getTestContext} from './run-arg';

describe('program', () => {
  async function testCommand(args: string[]): Promise<void> {
    const fileName = join(__dirname, '../examples/program')
    const context = getTestContext(fileName)
    const program = await getProgram(context)
    return new Promise<void>((resolve, reject) => {
      program
        .exitOverride((err) => {
          reject(err)
        })
        .parseAsync([process.argv[0], fileName, ...args])
        .catch(reject)
        .then(() => resolve())
    })
  }

  it('should get help with description', async () => {
    const fileName = join(__dirname, '../examples/program')
    const context = getTestContext(fileName)
    const program = await getProgram(context)
    const help = program.exitOverride().helpInformation({ error: false })
    expect(help).toContain('example [options]  install npm packages')
  })

  it('should run when cache is up to date and --no-cache arg is passed', async () => {
    await testCommand(['example', '--cache', 'none'])
  })
})
