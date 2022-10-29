import { getTestSuite } from '../get-test-suite'
import { join } from 'path'

describe('watch', () => {
  const suite = getTestSuite('watch', ['build.yaml', 'src', 'package.json', 'package-lock.json', 'tsconfig.json'])

  afterAll(() => suite.close())

  it('should run watch task and cancel', async () => {
    const { cli, environment } = await suite.setup({ taskName: 'api' })
    const apiNode = cli.node('api')
    const exec = cli.execWatch({ watch: true })
    exec.state.on((state) => {
      if (state.node[apiNode.id].type === 'running') {
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
    const exec = cli.execWatch({ watch: true })

    let appendedFile = false
    let restarted = false

    exec.state.on((state) => {
      if (state.node[apiNode.id].type === 'running') {
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
    expect(result.success).toBeFalsy()
    expect(result.state.node[apiNode.id].type).toEqual('canceled')
  })
})
