import { getTestSuite } from '../get-test-suite'
import { join } from 'path'

describe('export', () => {
  const suite = getTestSuite('export', ['.hammerkit.yaml'])

  afterAll(() => suite.close())

  it('should export created file', async () => {
    const { cli, environment } = await suite.setup({ taskName: 'example_file' })
    const result = await cli.runExec()
    expect(result.success).toBeTruthy()
    expect(await environment.file.read(join(environment.cwd, 'test.txt'))).toEqual('hello\n')
  })

  it('should export created directory', async () => {
    const { cli, environment } = await suite.setup({ taskName: 'example_dir' })
    const result = await cli.runExec()
    expect(result.success).toBeTruthy()
    expect(await environment.file.read(join(environment.cwd, 'dist/test.txt'))).toEqual('hello\n')
  })
})
