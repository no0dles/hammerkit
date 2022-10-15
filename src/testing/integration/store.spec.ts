import { join } from 'path'
import { getTestSuite } from '../get-test-suite'
import { existsSync } from 'fs'
import { emptyWorkLabelScope } from '../../executer/work-scope'

describe('store/restore', () => {
  const suite = getTestSuite('store-restore', ['build.yaml', 'package.json'])

  afterAll(() => suite.close())

  // TODO restore volume/include local generated files
  // it('should clean created outputs locally', async () => {
  //   const testCase = await suite.setup()
  //
  //   const outputPath = join(testCase.buildFile.path, 'test-output')
  //   const generatedPath = join(testCase.buildFile.path, 'node_modules')
  //
  //   const result = await testCase.exec('example', {
  //     cacheMethod: 'none',
  //     noContainer: true,
  //   })
  //   await expectSuccessfulResult(result)
  //
  //   expect(existsSync(generatedPath)).toBeTruthy()
  //   expect(existsSync(outputPath)).toBeFalsy()
  //
  //   await testCase.store(outputPath)
  //   await testCase.clean()
  //
  //   expect(existsSync(outputPath)).toBeTruthy()
  //   expect(existsSync(generatedPath)).toBeFalsy()
  //
  //   await testCase.restore(outputPath)
  //   expect(existsSync(outputPath)).toBeTruthy()
  //   expect(existsSync(generatedPath)).toBeTruthy()
  // })

  it('should not store anything if nothing got generated', async () => {
    const { cli } = await suite.setup(emptyWorkLabelScope())
    const outputPath = join(suite.path, 'test-output')
    const generatedPath = join(suite.path, 'node_modules')

    expect(existsSync(generatedPath)).toBeFalsy()
    expect(existsSync(outputPath)).toBeFalsy()

    await cli.store(outputPath)
    await cli.restore(outputPath)

    expect(existsSync(generatedPath)).toBeFalsy()
    expect(existsSync(outputPath)).toBeFalsy()
  })
})
