import { isBuildFileContainerSchema, isBuildFileKubernetesServiceSchema } from './build-file-service-schema'
import { isBuildFileContainerTaskSchema, isBuildFileLocalTaskSchema } from './build-file-task-schema'

describe('service/task type guards', () => {
  it('isBuildFileContainerSchema discriminates by `image` presence', () => {
    expect(isBuildFileContainerSchema({ image: 'node' } as any)).toBe(true)
    expect(isBuildFileContainerSchema({ selector: { name: 'n', type: 't' } } as any)).toBe(false)
  })

  it('isBuildFileKubernetesServiceSchema discriminates by `selector` presence', () => {
    expect(isBuildFileKubernetesServiceSchema({ selector: { name: 'n', type: 't' } } as any)).toBe(true)
    expect(isBuildFileKubernetesServiceSchema({ image: 'node' } as any)).toBe(false)
  })

  it('isBuildFileContainerTaskSchema returns true iff the task has an image', () => {
    expect(isBuildFileContainerTaskSchema({ image: 'node' } as any)).toBe(true)
    expect(isBuildFileContainerTaskSchema({ cmds: ['x'] } as any)).toBe(false)
  })

  it('isBuildFileLocalTaskSchema returns true iff the task has no image', () => {
    expect(isBuildFileLocalTaskSchema({ cmds: ['x'] } as any)).toBe(true)
    expect(isBuildFileLocalTaskSchema({ image: 'node' } as any)).toBe(false)
  })
})
