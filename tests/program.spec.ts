import { getProgram } from '../src/program'
import { join } from 'path'

describe('program', () => {
  async function testCommand(args: string[]) {
    const fileName = join(__dirname, '../examples/program/build.yaml')
    const program = getProgram(fileName)
    await new Promise<void>(async (resolve, reject) => {
      try {
        await program
          .exitOverride((err) => {
            reject(err)
          })
          .parseAsync([process.argv[0], fileName, ...args])
        resolve()
      } catch (e) {
        reject(e)
      }
    })
  }

  it('should get help with description', () => {
    const fileName = join(__dirname, '../examples/program/build.yaml')
    const program = getProgram(fileName)
    const help = program.exitOverride().helpInformation({ error: false })
    expect(help).toContain('example [options]  install npm packages')
  })

  it('should run when cache is up to date and --no-cache arg is passed', async () => {
    await testCommand(['example', '--no-cache'])
  })
})
