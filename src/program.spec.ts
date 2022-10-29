import { join } from 'path'
import { getProgram } from './program'
import { Command } from 'commander'
import { environmentMock } from './executer/environment-mock'

describe('program', () => {
  async function testCommand(commandArgs: string[]): Promise<Command> {
    const fileName = join(__dirname, '../examples/program')
    const context = environmentMock(fileName)
    const { program, args } = await getProgram(context, [process.argv[0], fileName, ...commandArgs])
    return program.exitOverride().parseAsync(args)
  }

  it('should run when cache is up to date and --no-cache arg is passed', async () => {
    await testCommand(['example', '--cache', 'none'])
  }, 120000)

  it('should warn about invalid task name', async () => {
    await expect(testCommand(['example2'])).rejects.toThrow()
  })
})
