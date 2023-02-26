import { getTestSuite } from '../get-test-suite'
import { join } from 'path'

describe('watch', () => {
  const suite = getTestSuite('watch', ['.hammerkit.yaml', 'src', 'package.json', 'package-lock.json', 'tsconfig.json'])

  afterAll(() => suite.close())

  it('should run watch task and cancel', async () => {
    const { cli, environment } = await suite.setup({ filterLabels: { task: ['dev'] } })
    const exec = await cli.up({ watch: true })
    exec.state.on('test-status', (evt) => {
      if (evt.services['api'].state.current.type === 'running') {
        environment.abortCtrl.abort()
      }
    })
    const result = await exec.start()
    expect(result.success).toBeFalsy()
    expect(result.state.services['api'].state.current.type).toEqual('canceled')
  })

  it('should restart task if dependency updates', async () => {
    const { cli, environment } = await suite.setup({ filterLabels: { task: ['dev'] } })
    const exec = await cli.up({ watch: true })

    let appendedFile = false
    let restarted = false

    exec.state.on('test-status', (evt) => {
      if (evt.services['api'].state.current.type === 'running') {
        if (!appendedFile) {
          appendedFile = true
          environment.file.appendFile(join(environment.cwd, 'package.json'), '\n')
        } else {
          restarted = true
          environment.abortCtrl.abort()
        }
      }
    })

    const result = await exec.start()
    expect(appendedFile).toBeTruthy()
    expect(restarted).toBeTruthy()
    expect(result.success).toBeFalsy()
    expect(result.state.services['api'].state.current.type).toEqual('canceled')
  })
})
