import { getTestSuite } from '../get-test-suite'
import { join } from 'path'

describe('watch', () => {
  const suite = getTestSuite('watch', ['.hammerkit.yaml', 'src', 'package.json', 'package-lock.json', 'tsconfig.json'])

  afterAll(() => suite.close())

  it('should run watch task and cancel', async () => {
    const { cli, environment } = await suite.setup({ taskName: 'api' })
    const apiNode = cli.node('api')
    const exec = await cli.exec({ watch: true })
    exec.processManager.on((evt) => {
      if (evt.context.id === apiNode.id && evt.type === 'started') {
        environment.abortCtrl.abort()
      }
    })
    const result = await exec.start()
    expect(result.success).toBeFalsy()
    expect(result.state.node[apiNode.id].type).toEqual('canceled')
  })

  it('should restart task if dependency updates', async () => {
    const { cli, environment } = await suite.setup({ taskName: 'api' })
    const apiNode = cli.node('api')
    const exec = await cli.exec({ watch: true })

    let appendedFile = false
    let restarted = false

    exec.processManager.on((evt) => {
      if (evt.type === 'started' && evt.context.id === apiNode.id) {
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
    expect(result.state.node[apiNode.id].type).toEqual('canceled')
  })
})
