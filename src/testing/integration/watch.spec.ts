import { getTestSuite } from '../get-test-suite'

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

  // it('should restart task if dependency updates', async () => {
  //   const { buildFile, context, executionContext } = await suite.setup()
  //   const workTree = planWorkTree(buildFile, 'api')
  //
  //   let restarted = false
  //
  //   executionContext.watch = true
  //   executionContext.events.on(({ nodeId, newState }) => {
  //     if (nodeId === workTree.rootNode.id && newState.type === 'running') {
  //       if (restarted) {
  //         context.cancelDefer.resolve()
  //       } else {
  //         context.file.appendFile(join(buildFile.path, 'package.json'), '\n')
  //         restarted = true
  //       }
  //     }
  //   })
  //   const result = await execute(workTree, executionContext)
  //
  //   expect(result.success).toBeFalsy()
  //   expect(result.nodes[workTree.rootNode.id].state.type).toEqual('aborted')
  // }, 120000)
})
