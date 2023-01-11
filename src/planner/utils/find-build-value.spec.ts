import { findBuildService } from './find-build-value'
import { getBuildFile } from '../../parser/get-build-file'
import { join } from 'path'
import { environmentMock } from '../../executer/environment-mock'

describe('find-build-value', () => {
  const environment = environmentMock('/home/user/proj')

  it('should find service', async () => {
    const buildFile = await getBuildFile(join(__dirname, '../../../examples/include/.hammerkit.yaml'), environment)
    const svc = findBuildService(
      {
        build: buildFile,
        cwd: '/home/user/proj',
        nodes: {},
        services: {},
        workTree: { nodes: {}, services: {} },
        namePrefix: [],
      },
      { name: 'foo:bardb' }
    )
    expect(svc).toBeDefined()
    expect(svc.result).toBeDefined()
  })
})
