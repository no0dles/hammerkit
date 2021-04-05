import { getProgram } from '../src/program'
import { join } from 'path'

describe('program', () => {
  it('should get help with description', () => {
    const fileName = join(__dirname, '../examples/local/build.yaml')
    const program = getProgram(fileName)
    const help = program.helpInformation({ error: false })
    expect(help).toContain('example [options]  local shell example')
  })
})
